// T10 Model and mode mid-session: set_config_option model between turns, and
// once during a turn, applies to the next model call (proxy log);
// session/set_mode plan and then build work: in plan mode an edit does not
// land, in build mode it does.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { textPrompt, type PermissionDecider } from "../lib/acp-driver.ts";
import { allowOnce, rejectOnce } from "../lib/deciders.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { STUB_MODEL, STUB_MODEL_ALT, errorMessage, isToolCall, marker, newSession, stubCallsFor, waitForEvent, withTask, withTimeout, type CaseContext } from "../harness/fixture.ts";
import { check, fail, type Check, type Criterion } from "../harness/report.ts";

export const t10ModelMode = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string> = {};
  try {
    // Edits are approved in build mode and rejected in plan mode, as a member would.
    const state: { mode: "plan" | "build" } = { mode: "build" };
    const decide: PermissionDecider = (request, signal) => (state.mode === "plan" ? rejectOnce(request, signal) : allowOnce(request, signal));
    await withTask(ctx, { name: "t10", upstream: { kind: "stub", format: "openai" }, decidePermission: decide }, async (task) => {
      const sessionId = await newSession(task);
      const toolCalls = (): ReturnType<typeof stubCallsFor> => stubCallsFor(ctx, task, "openai").filter((c) => c.toolNames.length > 0);
      const proxyModels = (from: number): string[] => task.proxy.calls.filter((c) => c.startedAt >= from).map((c) => c.requestedModel ?? "?");

      await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("hello")} one`)), 60_000, "turn 1");
      const before = toolCalls().at(-1)?.model;

      const switched = await task.driver.setConfigOption(sessionId, "model", `ostra-openai/${STUB_MODEL_ALT}`);
      const current = switched.configOptions.find((o) => o.id === "model");
      const t2 = Date.now();
      await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("hello")} two`)), 60_000, "turn 2");
      const after = toolCalls().at(-1)?.model;
      checks.push(
        check(
          "set_config_option model between turns applies to the next model call (proxy log)",
          before === STUB_MODEL && after === STUB_MODEL_ALT && current?.type === "select" && current.currentValue === `ostra-openai/${STUB_MODEL_ALT}`,
          `before ${before ?? "?"}, after ${after ?? "?"}; proxy saw ${proxyModels(t2).join(", ")}`,
        ),
      );

      // During a turn: switch while the tool step runs; the turn's second model call must use the new model.
      const mark = marker(ctx, "t10");
      const turn = task.driver.prompt(sessionId, textPrompt(`${stubMarker("two-calls", `6000 ${mark}`)} three`));
      turn.catch(() => undefined);
      const since = task.driver.events.at(-1)?.seq ?? 0;
      await waitForEvent(task.driver, (e) => e.seq > since && isToolCall(e), 60_000, "the tool step");
      const switchAt = Date.now();
      let midTurnError = "";
      try {
        await task.driver.setConfigOption(sessionId, "model", `ostra-openai/${STUB_MODEL}`);
      } catch (error) {
        midTurnError = errorMessage(error);
      }
      await withTimeout(turn, 60_000, "turn 3");
      const nextCall = toolCalls().find((c) => c.at > switchAt);
      checks.push(
        check(
          "set_config_option model during a turn applies to the next model call",
          midTurnError === "" && nextCall?.model === STUB_MODEL,
          midTurnError !== "" ? `rejected mid-turn: ${midTurnError}` : `next call after the switch used ${nextCall?.model ?? "none"}`,
        ),
      );

      // Modes: what each mode does to the same edit. In plan mode an edit must
      // not land: OpenCode either asks (and this task's decider rejects edits
      // while in plan mode) or refuses the tool. In build mode it lands.
      const readme = async (): Promise<string> => readFile(path.join(task.dirs.workspace, "README.md"), "utf8");
      const modeOf = (): string | undefined => {
        const last = task.driver.events.findLast(
          (e) => e.kind === "session_update" && (e.update.sessionUpdate === "current_mode_update" || e.update.sessionUpdate === "config_option_update"),
        );
        if (last?.kind !== "session_update") return undefined;
        if (last.update.sessionUpdate === "current_mode_update") return last.update.currentModeId;
        if (last.update.sessionUpdate === "config_option_update") {
          const option = last.update.configOptions.find((o) => o.id === "mode");
          return option?.type === "select" ? option.currentValue : undefined;
        }
        return undefined;
      };
      const runInMode = async (mode: "plan" | "build"): Promise<{ error: string; reported: string | undefined; asked: number; stop: string; before: string; after: string; system: string }> => {
        let error = "";
        try {
          await task.driver.setMode(sessionId, mode);
        } catch (e) {
          error = errorMessage(e);
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        const reported = modeOf();
        const before = await readme();
        const from = Date.now();
        const seqFrom = task.driver.events.at(-1)?.seq ?? 0;
        state.mode = mode;
        const response = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("edit-file", "README.md")} edit in ${mode} mode`)), 60_000, `${mode} turn`);
        const asked = task.driver.events.filter((e) => e.seq > seqFrom && e.kind === "permission_requested").length;
        const system = toolCalls()
          .filter((c) => c.at >= from)
          .flatMap((c) => c.messages.filter((m) => m.role === "system" || m.role === "user"))
          .map((m) => m.text)
          .join("\n");
        return { error, reported, asked, stop: response.stopReason, before, after: await readme(), system };
      };
      const plan = await runInMode("plan");
      const build = await runInMode("build");
      const planBlocked = plan.after === plan.before;
      const buildApplied = build.after !== build.before && build.after.includes("edited by the agent");
      const promptDiffers = plan.system !== build.system;
      recorded["mode reported after set_mode (plan / build)"] = `${plan.reported ?? "no mode update"} / ${build.reported ?? "no mode update"}`;
      recorded["plan mode: permission requests / stopReason"] = `${String(plan.asked)} / ${plan.stop}`;
      recorded["build mode: permission requests / stopReason"] = `${String(build.asked)} / ${build.stop}`;
      recorded["the model's instructions differ between plan and build"] = String(promptDiffers);
      checks.push(
        check(
          "session/set_mode plan and then build work",
          plan.error === "" && build.error === "" && planBlocked && buildApplied,
          `set_mode plan ${plan.error === "" ? "accepted" : `rejected: ${plan.error}`}, build ${build.error === "" ? "accepted" : `rejected: ${build.error}`}; in plan mode the edit ${planBlocked ? "did not land" : "LANDED"} (${String(plan.asked)} permission requests, stopReason ${plan.stop}); in build mode it ${buildApplied ? "landed" : "did NOT land"} (${String(build.asked)} requests); mode update events: ${plan.reported === undefined && build.reported === undefined ? "none" : "yes"}`,
        ),
      );
    });
  } catch (error) {
    checks.push(fail("model and mode", errorMessage(error)));
  }
  return [{ id: "T10", title: "Model and mode mid-session: set_config_option model between and during turns; set_mode plan then build.", checks, recorded }];
};
