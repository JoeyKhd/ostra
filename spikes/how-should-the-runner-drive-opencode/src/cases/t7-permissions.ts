// T7 Permissions: with `ask` rules, the request carries title, kind, rawInput
// and a diff preview; `once` runs the tool, `reject` fails it and the agent
// continues; a long-held request still works, or ostra's cancel-after-wait
// path does; a runner restart during a request is detected and the turn
// re-prompted; the agent can't answer its own request or read another task.
//
// The last check runs its probe from the agent's own shell: while one of its
// sessions holds a pending request, a second session of the same OpenCode
// process runs `node -e` in its shell. That script calls every listening port
// of its own OpenCode and of a second, concurrent task's OpenCode, with no
// credentials: list sessions, list permission requests, read the event
// stream, and answer the pending request. The status codes come back in the
// tool result the stub records.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import path from "node:path";
import { agentText, textPrompt, type PermissionDecider } from "../lib/acp-driver.ts";
import { descendantsOf, listProcesses, listeningPorts, type Listener } from "../lib/process-tree.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import type { PermissionRule } from "../lib/opencode.ts";
import { errorMessage, newSession, startTask, stubCallsFor, waitForEvent, withTask, withTimeout, type CaseContext, type Task } from "../harness/fixture.ts";
import { check, fail, skip, type Check, type Criterion } from "../harness/report.ts";

const ASK_EDITS: readonly PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "ask" },
];

type Decision = "once" | "reject";

const pick = (request: Parameters<PermissionDecider>[0], decision: Decision): Awaited<ReturnType<PermissionDecider>> => {
  const option = request.options.find((o) => o.kind === (decision === "once" ? "allow_once" : "reject_once"));
  return option === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: option.optionId } };
};

const scripted =
  (decisions: Decision[]): PermissionDecider =>
  (request) =>
    Promise.resolve(pick(request, decisions.shift() ?? "reject"));

/** A decider that never answers until released: a member who hasn't looked yet. */
const held = (): { readonly decide: PermissionDecider; readonly release: (decision: Decision) => void } => {
  let resolveIt: ((d: Decision) => void) | undefined;
  return {
    decide: async (request, signal) => {
      const decision = await new Promise<Decision | "cancelled">((resolve) => {
        resolveIt = resolve;
        signal.addEventListener("abort", () => {
          resolve("cancelled");
        });
      });
      return decision === "cancelled" ? { outcome: { outcome: "cancelled" } } : pick(request, decision);
    },
    release: (decision) => {
      resolveIt?.(decision);
    },
  };
};

const isPermission = (e: { kind: string }): boolean => e.kind === "permission_requested";

const probeLine = z.array(z.tuple([z.string(), z.string(), z.string(), z.union([z.number(), z.literal("ERR")])]));
type ProbeRow = z.infer<typeof probeLine>[number];

/** The `PROBE [...]` line the shell script printed, from the tool results the stub received. */
const probeRows = (ctx: CaseContext, task: Task, from: number): ProbeRow[] | undefined => {
  for (const call of stubCallsFor(ctx, task, "openai").filter((c) => c.at >= from)) {
    for (const message of call.messages.filter((m) => m.role === "tool")) {
      const json = /PROBE (\[.*\])/.exec(message.text)?.[1];
      if (json === undefined) continue;
      try {
        const raw: unknown = JSON.parse(json);
        const parsed = probeLine.safeParse(raw);
        if (parsed.success) return parsed.data;
      } catch {
        // Not the probe's line.
      }
    }
  }
  return undefined;
};

const portsOf = async (task: Task): Promise<Listener[]> => {
  const tree = [task.driver.pid, ...descendantsOf(task.driver.pid, await listProcesses()).map((p) => p.pid)];
  return listeningPorts(tree);
};

const SELF_CHECK = "from the agent's own shell, it can't answer its own request or read another task's stream";

/** The shell probe and the shell-environment check, while one session of `task` holds a pending request. */
const selfApprovalCase = async (ctx: CaseContext, recorded: Record<string, string | number>): Promise<Check> => {
  const hold = held();
  const other = await startTask(ctx, { name: "t7-other", upstream: { kind: "stub", format: "openai" }, permissions: ASK_EDITS });
  try {
    const otherSession = await newSession(other);
    return await withTask(ctx, { name: "t7-self", upstream: { kind: "stub", format: "openai" }, permissions: ASK_EDITS, decidePermission: hold.decide }, async (task) => {
      const sessionId = await newSession(task);
      const turn = task.driver.prompt(sessionId, textPrompt(`${stubMarker("permission-one")} edit README`));
      turn.catch(() => undefined);
      const pending = await waitForEvent(task.driver, isPermission, 60_000, "the permission request");
      // OpenCode's own ID for the pending request, if ACP carries it; a well-formed stand-in otherwise.
      const requestId = /per_[A-Za-z0-9]+/.exec(JSON.stringify(pending))?.[0] ?? "per_unknown";
      recorded["pending request's OpenCode ID visible over ACP"] = requestId === "per_unknown" ? "no (probe used a stand-in ID)" : "yes";

      let ownPorts: Listener[];
      let otherPorts: Listener[];
      try {
        ownPorts = await portsOf(task);
        otherPorts = await portsOf(other);
      } catch (error) {
        hold.release("reject");
        return skip(SELF_CHECK, `a way to list listening ports here (${errorMessage(error).slice(0, 120)})`);
      }
      recorded["listening ports in this task's OpenCode tree"] = ownPorts.length === 0 ? "none" : ownPorts.map((p) => `${p.address}:${String(p.port)}`).join(", ");
      recorded["listening ports in the other task's OpenCode tree"] = otherPorts.length === 0 ? "none" : otherPorts.map((p) => `${p.address}:${String(p.port)}`).join(", ");
      const targets = [
        ...new Set([...ownPorts.map((p) => `${sessionId}.${requestId}.${String(p.port)}`), ...otherPorts.map((p) => `${otherSession}.per_none.${String(p.port)}`)]),
      ];

      // The probe, from a second session of the same OpenCode process, in the agent's own shell.
      let rows: ProbeRow[] | undefined;
      if (targets.length > 0) {
        const probeSession = await newSession(task);
        const from = Date.now();
        const probeTurn = await withTimeout(task.driver.prompt(probeSession, textPrompt(`${stubMarker("shell-probe", targets.join(" "))} probe`)), 120_000, "the shell probe");
        rows = probeRows(ctx, task, from);
        recorded["shell probe turn"] = probeTurn.stopReason;
        await ctx.save("t7-shell-probe.json", rows ?? "no PROBE line");
        recorded["shell probes (port method path: status)"] = (rows ?? []).map(([port, method, p, status]) => `${port} ${method} ${p.replace(/ses_[A-Za-z0-9]+/, "<session>").replace(/per_[A-Za-z0-9]+/, "<request>")}: ${String(status)}`).join("; ") || "none";
      }
      const stillPending = !task.driver.events.some((e) => e.kind === "permission_resolved");
      hold.release("reject");
      await task.driver.cancel(sessionId);
      await withTimeout(turn, 10_000, "cancel").catch(() => undefined);

      // Does the agent's own shell get the server's credential or address?
      const dumpFrom = Date.now();
      const dumpTurn = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("env-dump")} print the environment`)), 120_000, "env dump");
      const dump = stubCallsFor(ctx, task, "openai")
        .filter((c) => c.at >= dumpFrom)
        .flatMap((c) => c.messages.filter((m) => m.role === "tool"))
        .find((m) => m.text.includes("OSTRA_MODEL_API_KEY"));
      const shellEnv = (() => {
        try {
          const raw: unknown = JSON.parse(dump?.text.trim() ?? "");
          const parsed = z.record(z.string(), z.string()).safeParse(raw);
          return parsed.success ? parsed.data : {};
        } catch {
          return {};
        }
      })();
      const allPorts = [...ownPorts, ...otherPorts];
      const added = Object.keys(shellEnv).filter((name) => !(name in task.env));
      const credentialVars = Object.entries(shellEnv).flatMap(([name, value]) =>
        /PASSWORD|TOKEN|SECRET|AUTH/i.test(name) || allPorts.some((p) => value.includes(`:${String(p.port)}`)) ? [name] : [],
      );
      recorded["variables OpenCode adds to its shell"] = added.length === 0 ? "none" : [...new Set(added)].join(", ");

      const refused = (status: number | "ERR"): boolean => status === "ERR" || status === 401 || status === 403;
      const answered = (rows ?? []).filter(([, method, , status]) => method === "POST" && typeof status === "number" && status >= 200 && status < 300);
      const portsReached = new Set((rows ?? []).filter(([, , , status]) => status !== "ERR").map(([port]) => port));
      const probeOk =
        targets.length === 0 ||
        (rows?.length === targets.length * 5 && rows.every(([, , , status]) => refused(status)) && allPorts.every((p) => portsReached.has(String(p.port))));
      const probeNote =
        targets.length === 0
          ? `no listening port in either OpenCode tree: approvals travel only on the runner's stdio pipe`
          : rows === undefined
            ? "the probe's output never reached the model"
            : `${String(rows.length)} unauthenticated calls from the agent's shell to ${String(ownPorts.length)} own and ${String(otherPorts.length)} other-task ports: ${String(rows.filter(([, , , s]) => refused(s)).length)} refused (401/403 or no connection), ${String(rows.length - rows.filter(([, , , s]) => refused(s)).length)} answered${answered.length > 0 ? "; the pending request was ANSWERED from the shell" : ""}; the request was still pending during the probe: ${String(stillPending)}`;
      return check(
        SELF_CHECK,
        probeOk && stillPending && dump !== undefined && credentialVars.length === 0 && dumpTurn.stopReason === "end_turn",
        `${probeNote}; the agent's shell ${dump === undefined ? "dump did not arrive" : credentialVars.length === 0 ? "holds no server credential or address" : `holds ${credentialVars.join(", ")}`}. The password itself lives in OpenCode's memory: on Linux a same-user process could still read it, which spike 3's container boundary answers`,
      );
    });
  } finally {
    await other.close();
  }
};

export const t7Permissions = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string | number> = {};

  // once, then reject.
  try {
    await withTask(ctx, { name: "t7", upstream: { kind: "stub", format: "openai" }, permissions: ASK_EDITS, decidePermission: scripted(["once", "reject"]) }, async (task) => {
      const sessionId = await newSession(task);
      const response = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("permission-pair")} edit two files`)), 120_000, "permission turn");
      const requests = task.driver.events.flatMap((e) => (e.kind === "permission_requested" ? [e.request] : []));
      await ctx.save("t7-requests.json", requests);
      const first = requests[0];
      const diff = (first?.toolCall.content ?? []).some((c) => c.type === "diff");
      checks.push(
        check(
          "the request carries title, kind, rawInput and a diff preview",
          first !== undefined && (first.toolCall.title ?? "") !== "" && first.toolCall.kind !== undefined && first.toolCall.rawInput !== undefined && diff,
          first === undefined
            ? "no permission request arrived"
            : `title "${first.toolCall.title ?? ""}", kind ${String(first.toolCall.kind)}, rawInput ${first.toolCall.rawInput === undefined ? "missing" : "present"}, diff ${diff ? "present" : "missing"}; options ${first.options.map((o) => o.kind).join("/")}`,
        ),
      );
      const readme = await readFile(path.join(task.dirs.workspace, "README.md"), "utf8");
      const notes = await readFile(path.join(task.dirs.workspace, "notes.txt"), "utf8");
      checks.push(check("once runs the tool", readme.includes("approved"), readme.includes("approved") ? "README.md was edited" : "README.md unchanged"));
      const text = agentText(task.driver.events, sessionId);
      checks.push(
        check(
          "reject fails it and the agent continues",
          !notes.includes("rejected") && requests.length >= 2 && response.stopReason === "end_turn" && text.includes("continued after reject"),
          `notes.txt ${notes.includes("rejected") ? "EDITED" : "unchanged"}; ${String(requests.length)} requests; stopReason=${response.stopReason}; agent said "${text.slice(-60)}"`,
        ),
      );
    });
  } catch (error) {
    checks.push(fail("once and reject", errorMessage(error)));
  }

  // Recorded: does OpenCode's deprecated `experimental.continue_loop_on_deny` make a reject continue the turn?
  try {
    await withTask(
      ctx,
      {
        name: "t7-deny-loop",
        upstream: { kind: "stub", format: "openai" },
        permissions: ASK_EDITS,
        decidePermission: scripted(["once", "reject"]),
        experimental: { continue_loop_on_deny: true },
      },
      async (task) => {
        const sessionId = await newSession(task);
        const response = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("permission-pair")} edit two files`)), 120_000, "permission turn");
        const text = agentText(task.driver.events, sessionId);
        recorded["reject with experimental.continue_loop_on_deny"] = `stopReason=${response.stopReason}; continued: ${String(text.includes("continued after reject"))}`;
      },
    );
  } catch (error) {
    recorded["reject with experimental.continue_loop_on_deny"] = `error: ${errorMessage(error)}`;
  }

  // Security: while a request is pending, can the agent's own shell reach OpenCode and answer it, or read another task?
  try {
    checks.push(await selfApprovalCase(ctx, recorded));
  } catch (error) {
    checks.push(fail(SELF_CHECK, errorMessage(error)));
  }

  // A held request: ostra's cancel-after-wait path, then re-prompt with the decision.
  const waitMs = ctx.inputs.long ? 10 * 60_000 : 5_000;
  try {
    const hold = held();
    let firstDecision = true;
    const decide: PermissionDecider = async (request, signal) => {
      if (firstDecision) {
        firstDecision = false;
        return hold.decide(request, signal);
      }
      return scripted(["once"])(request, signal);
    };
    await withTask(ctx, { name: "t7-hold", upstream: { kind: "stub", format: "openai" }, permissions: ASK_EDITS, decidePermission: decide }, async (task) => {
      const sessionId = await newSession(task);
      const turn = task.driver.prompt(sessionId, textPrompt(`${stubMarker("permission-one")} edit README`));
      turn.catch(() => undefined);
      await waitForEvent(task.driver, isPermission, 60_000, "the permission request");
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const stillPending = task.driver.isRunning() && !task.driver.events.some((e) => e.kind === "prompt_finished" || e.kind === "prompt_failed");
      await task.driver.cancel(sessionId);
      const cancelled = await withTimeout(turn, 10_000, "cancel of the held turn");
      const again = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("permission-one")} The member approved the edit: go ahead.`)), 120_000, "re-prompt");
      const readme = await readFile(path.join(task.dirs.workspace, "README.md"), "utf8");
      const ok = stillPending && cancelled.stopReason === "cancelled" && again.stopReason === "end_turn" && readme.includes("after wait");
      const note = `held ${String(waitMs / 1000)} s and still pending: ${String(stillPending)}; cancel stopReason=${cancelled.stopReason}; re-prompt stopReason=${again.stopReason}; edit ${readme.includes("after wait") ? "applied" : "missing"}`;
      if (ctx.inputs.long) checks.push(check("ostra's cancel-after-10-min path works end to end", ok, note));
      else {
        checks.push(check("ostra's cancel-after-wait path works end to end (wait shortened to 5 s)", ok, note));
        checks.push(skip("ostra's cancel-after-10-min path with the real 10-minute wait", "SPIKE_LONG=1"));
      }
    });
  } catch (error) {
    checks.push(fail("ostra's cancel-after-wait path works end to end", errorMessage(error)));
  }

  // The runner restarts while a request is pending.
  try {
    const hold = held();
    let n = 0;
    const decide: PermissionDecider = async (request, signal) => {
      n += 1;
      return n === 1 ? hold.decide(request, signal) : scripted(["once"])(request, signal);
    };
    await withTask(ctx, { name: "t7-restart", upstream: { kind: "stub", format: "openai" }, permissions: ASK_EDITS, decidePermission: decide }, async (task) => {
      const sessionId = await newSession(task);
      const turn = task.driver.prompt(sessionId, textPrompt(`${stubMarker("permission-one")} edit README`));
      turn.catch(() => undefined);
      await waitForEvent(task.driver, isPermission, 60_000, "the permission request");
      const old = task.driver;
      // The runner goes away with the request open.
      await old.stop(500);
      const lost = await turn.then(
        () => false,
        () => true,
      );
      // Open at exit: never answered by a member (the SDK cancels the handler when the connection closes).
      const pendingAtExit =
        old.events.some((e) => e.kind === "permission_requested") &&
        !old.events.some((e) => e.kind === "permission_resolved" && e.response.outcome.outcome === "selected");
      const fresh = await task.restart();
      await fresh.loadSession({ sessionId, cwd: task.dirs.workspace, mcpServers: [] });
      const again = await withTimeout(fresh.prompt(sessionId, textPrompt(`${stubMarker("permission-one")} The runner restarted: retry the edit.`)), 120_000, "re-prompt after restart");
      const readme = await readFile(path.join(task.dirs.workspace, "README.md"), "utf8");
      checks.push(
        check(
          "restarting the runner during a request is detected, and the turn is cancelled and re-prompted",
          lost && pendingAtExit && again.stopReason === "end_turn" && readme.includes("after wait"),
          `old turn ended with an error: ${String(lost)}; a request was open at exit: ${String(pendingAtExit)}; after session/load the re-prompt ended ${again.stopReason}; edit ${readme.includes("after wait") ? "applied" : "missing"}`,
        ),
      );
    });
  } catch (error) {
    checks.push(fail("restarting the runner during a request", errorMessage(error)));
  }

  recorded["2-hour hold"] = "not run: the criterion accepts the cancel-after-10-min path instead";
  return [{ id: "T7", title: "Permissions: request fields, once, reject, long waits, runner restart, no self-approval.", checks, recorded }];
};
