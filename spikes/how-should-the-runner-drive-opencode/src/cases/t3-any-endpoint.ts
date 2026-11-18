// T3 Any base URL and model: (a) a custom OpenAI-compatible provider with a
// custom model ID; (b) a catalog provider through settings.baseURL; (c) a
// models.dev ID. The proxy log shows the fake key swapped and the requested
// model ID; the model is set through session/set_config_option and accepted.
// (b) and (c) run once per API format: the catalog provider is the first one
// whose SDK package speaks that format. On Linux, /proc/<pid>/environ of
// OpenCode and its children is read for real keys.
// (T3b, Claude Code, is milestone 7 and not part of this spike.)

import path from "node:path";
import { textPrompt } from "../lib/acp-driver.ts";
import type { SessionId } from "../lib/ids.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import type { StubFormat } from "../lib/stub-models/types.ts";
import { loadCatalog } from "../harness/catalog.ts";
import { KEY_ENV, STUB_MODEL, STUB_MODEL_ALT, errorMessage, newSession, stubCallsFor, withTask, withTimeout, type CaseContext, type Task } from "../harness/fixture.ts";
import { check, fail, skip, type Check, type Criterion } from "../harness/report.ts";
import { linuxProcEnviron } from "./turns-and-keys.ts";

/** One turn; returns the model the proxy saw on the turn's main call, and whether the stub got the real key. */
const turnModel = async (ctx: CaseContext, task: Task, sessionId: SessionId, format: StubFormat): Promise<{ stop: string; model: string | undefined; swapped: boolean }> => {
  const from = Date.now();
  const response = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("hello")} hi`)), 90_000, "turn");
  const main = stubCallsFor(ctx, task, format).filter((c) => c.at >= from && c.toolNames.length > 0).at(-1);
  const proxyCall = task.proxy.calls.filter((c) => c.startedAt >= from && c.hasTools && c.requestedModel === main?.model).at(-1);
  return { stop: response.stopReason, model: proxyCall?.requestedModel, swapped: proxyCall?.keySwapped === true && main?.authOk === true };
};

const catalogCase = async (ctx: CaseContext, format: StubFormat, checks: Check[], recorded: Record<string, string>): Promise<void> => {
  const catalog = await loadCatalog(path.dirname(ctx.runRoot), format);
  if ("error" in catalog) {
    checks.push(skip(`(b) a catalog provider through settings.baseURL, ${format} format`, catalog.error));
    checks.push(skip(`(c) a models.dev ID, ${format} format`, catalog.error));
    return;
  }
  const [newest, other] = catalog.models;
  recorded[`catalog provider, ${format} format (chosen by SDK package)`] = `${catalog.providerId} (${catalog.npm})`;
  try {
    await withTask(
      ctx,
      {
        name: `t3bc-${format}`,
        upstream: { kind: "stub", format },
        extraEnv: { OPENCODE_MODELS_PATH: catalog.file },
        provider: (proxy) => ({
          spec: { kind: "catalog", id: catalog.providerId, baseUrl: proxy.agentBaseUrl, keyEnv: KEY_ENV },
          model: `${catalog.providerId}/${newest ?? ""}`,
        }),
      },
      async (task) => {
        const session = await task.driver.newSession({ cwd: task.dirs.workspace, mcpServers: [] });
        const offered = session.configOptions?.find((o) => o.id === "model");
        recorded[`models offered for the ${format} catalog provider`] = offered?.type === "select" ? String(offered.options.length) : "none";
        const b = await turnModel(ctx, task, session.sessionId, format);
        checks.push(
          check(
            `(b) a catalog provider through settings.baseURL completes a turn; fake key swapped; model ID logged (${format} format)`,
            b.stop === "end_turn" && b.swapped && b.model === newest,
            `provider ${catalog.providerId}, stopReason=${b.stop}, key swapped=${String(b.swapped)}, requested ${b.model ?? "none"} (configured ${newest ?? "?"})`,
          ),
        );
        let setError = "";
        try {
          await task.driver.setConfigOption(session.sessionId, "model", `${catalog.providerId}/${other ?? ""}`);
        } catch (error) {
          setError = errorMessage(error);
        }
        const c = await turnModel(ctx, task, session.sessionId, format);
        checks.push(
          check(
            `(c) a models.dev ID set through session/set_config_option passes through as it is (${format} format)`,
            setError === "" && c.stop === "end_turn" && c.model === other,
            setError === "" ? `requested ${c.model ?? "none"} after setting ${catalog.providerId}/${other ?? "?"}` : `set_config_option rejected: ${setError}`,
          ),
        );
      },
    );
  } catch (error) {
    checks.push(fail(`(b) and (c) catalog provider, ${format} format`, errorMessage(error)));
  }
};

export const t3AnyEndpoint = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string> = {};

  // (a) A custom OpenAI-compatible provider with a custom model ID.
  try {
    await withTask(ctx, { name: "t3a", upstream: { kind: "stub", format: "openai" } }, async (task) => {
      const sessionId = await newSession(task);
      const first = await turnModel(ctx, task, sessionId, "openai");
      const set = await task.driver.setConfigOption(sessionId, "model", `ostra-openai/${STUB_MODEL_ALT}`);
      const accepted = set.configOptions.some((o) => o.id === "model" && o.type === "select" && o.currentValue === `ostra-openai/${STUB_MODEL_ALT}`);
      const second = await turnModel(ctx, task, sessionId, "openai");
      checks.push(
        check(
          "(a) a custom OpenAI-compatible provider with a custom model ID completes a turn; the proxy log shows the fake key swapped and the model ID",
          first.stop === "end_turn" && first.swapped && first.model === STUB_MODEL,
          `stopReason=${first.stop}, key swapped=${String(first.swapped)}, requested model=${first.model ?? "none"}`,
        ),
      );
      checks.push(
        check(
          "(a) the model is set through session/set_config_option and accepted",
          accepted && second.model === STUB_MODEL_ALT && second.stop === "end_turn",
          `accepted=${String(accepted)}; next turn requested ${second.model ?? "none"}`,
        ),
      );
      // The live view of the agent's environment, where the OS offers one.
      if (process.platform === "linux") {
        const secrets = [ctx.modelSide.stubKeys.openai, ctx.modelSide.stubKeys.anthropic, ...(ctx.inputs.model === undefined ? [] : [ctx.inputs.model.apiKey])];
        checks.push(await linuxProcEnviron(task.driver.pid, secrets));
      } else {
        checks.push(skip("/proc/<pid>/environ of OpenCode and its children holds no real key", "a Linux machine (`container/run.sh`); B4 checks the agent's shell environment here"));
      }
    });
  } catch (error) {
    checks.push(fail("(a) a custom OpenAI-compatible provider", errorMessage(error)));
  }

  // (b) and (c): a catalog provider through settings.baseURL, and models.dev IDs, in each API format.
  for (const format of ["anthropic", "openai"] as const) await catalogCase(ctx, format, checks, recorded);

  // Control: OpenCode 1.19.6 on (a), recorded only.
  try {
    await withTask(ctx, { name: "t3a-v1", upstream: { kind: "stub", format: "openai" }, line: "v1" }, async (task) => {
      const sessionId = await newSession(task);
      const response = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("hello")} hi`)), 120_000, "v1 turn");
      recorded["control 1.19.6 (a)"] = `stopReason=${response.stopReason}; ${String(task.proxy.calls.length)} calls through the proxy; models ${[...new Set(task.proxy.calls.map((c) => c.requestedModel ?? "?"))].join(",")}`;
    });
  } catch (error) {
    recorded["control 1.19.6 (a)"] = `error: ${errorMessage(error)}`;
  }
  return [{ id: "T3", title: "Any base URL and model: custom provider, catalog provider via baseURL, models.dev ID; key swapped; set_config_option.", checks, recorded }];
};
