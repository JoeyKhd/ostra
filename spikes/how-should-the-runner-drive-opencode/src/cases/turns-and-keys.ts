// Pass-bar bullets 3 and 4: a turn on each API format and on the real
// endpoint; the agent's environment holds only the fake key; the proxy's
// token count matches what the endpoint reports.
//
// The endpoint count compares like with like: per turn, the proxy's sum over
// that turn's own model calls (the requests that offered tools, so not
// OpenCode's title call) against the usage OpenCode reports for the turn
// (ACP PromptResponse.usage). OpenCode parses that from the same response
// bytes, with its own parser: it checks the proxy's metering, not the
// provider's billing. Only the provider's dashboard is fully independent.

import { readFile } from "node:fs/promises";
import { agentText, textPrompt } from "../lib/acp-driver.ts";
import { descendantsOf, listProcesses } from "../lib/process-tree.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import type { StubFormat } from "../lib/stub-models/types.ts";
import { addUsage, totalTokens, zeroUsage, type TokenUsage } from "../lib/usage.ts";
import type { ProxyCallRecord } from "../lib/key-proxy.ts";
import { detectApiFormat, MODEL_INPUT_HINT } from "../harness/inputs.ts";
import { KEY_ENV, errorMessage, newSession, stubCallsFor, withTask, withTimeout, type CaseContext } from "../harness/fixture.ts";
import { check, fail, skip, type Check, type Criterion } from "../harness/report.ts";
import { rateOf } from "./t5-events.ts";

const TOLERANCE = 0.02;

const within = (counted: number, reported: number): boolean => reported > 0 && Math.abs(counted - reported) / reported <= TOLERANCE;

type TurnCount = { readonly label: string; readonly calls: readonly ProxyCallRecord[]; readonly reported: number | undefined };

const sumUsage = (calls: readonly ProxyCallRecord[]): TokenUsage => calls.reduce((sum, c) => addUsage(sum, c.usage ?? zeroUsage), zeroUsage);

/** B4 against the endpoint: per turn, the turn's own calls against OpenCode's turn usage; no 200 without usage. */
const endpointCount = (all: readonly ProxyCallRecord[], turns: readonly TurnCount[]): Check => {
  const missing = all.filter((c) => c.status === 200 && c.usage === undefined).length;
  const perTurn = turns.map((t) => {
    const own = t.calls.filter((c) => c.hasTools);
    const counted = totalTokens(sumUsage(own));
    return { ...t, own: own.length, other: t.calls.length - own.length, counted, ok: t.reported !== undefined && within(counted, t.reported) };
  });
  const allTotal = totalTokens(sumUsage(all));
  const auxiliaryTotal = totalTokens(sumUsage(all.filter((c) => !c.hasTools)));
  return check(
    "the proxy's token count is within 2% of what the model.env endpoint reports",
    perTurn.length > 0 && perTurn.every((t) => t.ok) && missing === 0,
    `${perTurn.map((t) => `${t.label}: proxy ${String(t.counted)} over its ${String(t.own)} model calls vs ${t.reported === undefined ? "no usage" : String(t.reported)} in OpenCode's turn usage${t.reported === undefined || t.reported === 0 ? "" : ` (${((Math.abs(t.counted - t.reported) / t.reported) * 100).toFixed(1)}% off)`}`).join("; ")}; ${String(missing)} calls answered 200 without usage; all calls together ${String(allTotal)}, of which ${String(auxiliaryTotal)} in calls without tools (titles), which no turn usage covers`,
  );
};

type StubTurn = { readonly turn: Check; readonly count: Check; readonly shellEnv: Check | undefined };

const stubTurn = async (ctx: CaseContext, format: StubFormat): Promise<StubTurn> =>
  withTask(ctx, { name: `turn-${format}`, upstream: { kind: "stub", format } }, async (task) => {
    const sessionId = await newSession(task);
    const response = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("hello")} say hello`)), 120_000, "turn");
    const text = agentText(task.driver.events, sessionId);
    const turn = check(
      `a turn completes against the local ${format} stub`,
      response.stopReason === "end_turn" && text.includes("hello from the stub"),
      `stopReason=${response.stopReason}, text ${text.includes("hello from the stub") ? "received" : "missing"}, ${String(task.proxy.calls.length)} model calls through the proxy`,
    );

    // The shell the agent's tools run in prints its own environment to the stub.
    const envResponse = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("env-dump")} print the environment`)), 120_000, "env turn");
    const calls = stubCallsFor(ctx, task, format);
    const dump = calls.flatMap((c) => c.messages.filter((m) => m.role === "tool")).find((m) => m.text.includes(KEY_ENV));
    const shellEnv =
      dump === undefined
        ? fail("the agent's shell environment holds only the fake key", `no environment dump reached the stub (stopReason=${envResponse.stopReason})`)
        : check(
            "the agent's shell environment holds only the fake key",
            dump.text.includes(task.proxy.fakeKey) && !dump.text.includes(task.realKey),
            `fake key ${dump.text.includes(task.proxy.fakeKey) ? "present" : "absent"}, real key ${dump.text.includes(task.realKey) ? "PRESENT" : "absent"} in the ${format} shell's environment`,
          );

    // Ground truth: what the stub billed and wrote into its responses.
    const reported = calls.filter((c) => c.usageReported && c.billed !== undefined);
    const stubTotal = reported.reduce((sum, c) => sum + (c.billed === undefined ? 0 : c.billed.inputTokens + c.billed.outputTokens + c.billed.cacheReadTokens), 0);
    const counted = task.proxy.calls.reduce((sum, c) => addUsage(sum, c.usage ?? zeroUsage), zeroUsage);
    const missing = task.proxy.calls.filter((c) => c.status === 200 && c.usage === undefined).length;
    const count = check(
      `the proxy's token count is within 2% of what the ${format} stub reports`,
      within(totalTokens(counted), stubTotal) && missing === 0,
      `proxy ${String(totalTokens(counted))} vs stub ${String(stubTotal)} tokens over ${String(reported.length)} calls; ${String(missing)} calls without usage`,
    );
    return { turn, count, shellEnv };
  });

export const linuxProcEnviron = async (rootPid: number, secrets: readonly string[]): Promise<Check> => {
  const tree = [rootPid, ...descendantsOf(rootPid, await listProcesses()).map((p) => p.pid)];
  let leaks = 0;
  for (const pid of tree) {
    const environ = await readFile(`/proc/${String(pid)}/environ`, "utf8").catch(() => "");
    if (secrets.some((secret) => environ.includes(secret))) leaks += 1;
  }
  return check("/proc/<pid>/environ of OpenCode and its children holds no real key", leaks === 0, `${String(tree.length)} processes read, ${String(leaks)} with a real key`);
};

export const turnsAndKeys = async (ctx: CaseContext): Promise<Criterion[]> => {
  const turns: Check[] = [];
  const keys: Check[] = [];
  const counts: Check[] = [];

  for (const format of ["openai", "anthropic"] as const) {
    try {
      const result = await stubTurn(ctx, format);
      turns.push(result.turn);
      counts.push(result.count);
      if (result.shellEnv !== undefined) keys.push(result.shellEnv);
    } catch (error) {
      turns.push(fail(`a turn completes against the local ${format} stub`, errorMessage(error)));
    }
  }

  // The spawn environment itself, and on Linux the live /proc view.
  await withTask(ctx, { name: "env-check", upstream: { kind: "stub", format: "openai" } }, async (task) => {
    const values = Object.values(task.env);
    const runnerOnly = Object.keys(process.env).filter((name) => name.startsWith("OSTRA_DEV_") || name.startsWith("GITHUB_") || name.startsWith("LINEAR_"));
    keys.push(
      check(
        "the agent's spawn environment is an allowlist holding only the fake key",
        task.env[KEY_ENV] === task.proxy.fakeKey &&
          !values.some((v) => v === ctx.modelSide.stubKeys.openai || v === ctx.modelSide.stubKeys.anthropic || v === ctx.inputs.model?.apiKey) &&
          runnerOnly.every((name) => !(name in task.env)),
        `${String(Object.keys(task.env).length)} variables, all named by the allowlist; ${KEY_ENV} is the fake key; no real key among the values`,
      ),
    );
    if (process.platform === "linux") {
      const secrets = [ctx.modelSide.stubKeys.openai, ctx.modelSide.stubKeys.anthropic, ...(ctx.inputs.model ? [ctx.inputs.model.apiKey] : [])];
      keys.push(await linuxProcEnviron(task.driver.pid, secrets));
    } else {
      keys.push(skip("/proc/<pid>/environ of OpenCode and its children holds no real key", "a Linux machine (no /proc here); the shell-dump checks above cover this machine"));
    }
  });

  // The endpoint in model.env.
  const endpoint = ctx.inputs.model;
  const recorded: Record<string, string | number> = {};
  if (endpoint === undefined) {
    turns.push(skip("a turn completes against the endpoint in model.env", MODEL_INPUT_HINT));
    counts.push(skip("the proxy's token count is within 2% of what the model.env endpoint reports", MODEL_INPUT_HINT));
  } else {
    try {
      const format = await detectApiFormat(endpoint);
      recorded["endpoint format"] = format;
      await withTask(ctx, { name: "turn-endpoint", upstream: { kind: "endpoint", endpoint, format } }, async (task) => {
        const sessionId = await newSession(task);
        const turnCounts: TurnCount[] = [];
        const runTurn = async (label: string, prompt: string, ms: number): Promise<{ stopReason: string }> => {
          const from = Date.now();
          const response = await withTimeout(task.driver.prompt(sessionId, textPrompt(prompt)), ms, label);
          // Calls of this turn: started after the prompt went out, ended before it returned.
          const mine = task.proxy.calls.filter((c) => c.startedAt >= from && c.endedAt <= Date.now());
          turnCounts.push({ label, calls: mine, reported: response.usage?.totalTokens });
          return response;
        };
        const response = await runTurn("the one-word turn", "Reply with exactly one word: ready", 300_000);
        const text = agentText(task.driver.events, sessionId);
        turns.push(check("a turn completes against the endpoint in model.env", response.stopReason === "end_turn" && text.trim() !== "", `stopReason=${response.stopReason}, ${String(text.length)} chars of text, ${String(task.proxy.calls.length)} calls`));
        // A small real edit: several model calls in one turn, and the event rate of a real model.
        const since = task.driver.events.at(-1)?.seq ?? 0;
        await runTurn("the edit turn", "Read README.md, then add a second line to it that says: edited by the ostra spike. Then stop.", 600_000);
        counts.push(endpointCount(task.proxy.calls, turnCounts));
        const rate = rateOf(task.driver.events.filter((e) => e.seq > since), task.driver.wire().inboundBytes);
        recorded["events per minute (model.env endpoint)"] = rate.eventsPerMinute;
        recorded["bytes per minute (model.env endpoint, whole session)"] = rate.bytesPerMinute;
      });
    } catch (error) {
      turns.push(fail("a turn completes against the endpoint in model.env", errorMessage(error)));
    }
  }

  return [
    {
      id: "B3",
      title: "A turn completes against the endpoint in model.env, and against a local stub in each of the two API formats.",
      checks: turns,
      recorded,
    },
    {
      id: "B4",
      title: "The agent's environment holds only the fake key, and the proxy's token count is within 2% of what the endpoint reports.",
      checks: [...keys, ...counts],
    },
  ];
};
