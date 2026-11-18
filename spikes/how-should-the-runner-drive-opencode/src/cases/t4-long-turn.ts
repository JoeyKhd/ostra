// T4 Long turn: a turn that runs >= 20 min ends with end_turn; no transport
// error; no lost events (contiguous seq); the connection is reused for the
// next turn. Pass-bar bullet 2's "a 20-minute turn ends cleanly". Three forms
// run side by side, each on its own task:
//   - a tool step: a 1,200 s shell sleep (the model calls are short);
//   - a model call whose stream sends only SSE keepalives for 20 min, then
//     answers: the key proxy and OpenCode's HTTP client hold one long stream;
//   - the same with no keepalives at all, a silent upstream (recorded only:
//     no provider stays silent that long, but the result shows who times out).
// Runs only with SPIKE_LONG=1; otherwise 30 s short forms run and are
// recorded, and the criteria stay SKIPPED.

import { textPrompt } from "../lib/acp-driver.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { errorMessage, marker, newSession, withTask, withTimeout, type CaseContext } from "../harness/fixture.ts";
import { check, fail, skip, type Check, type Criterion } from "../harness/report.ts";

const LONG_MS = 20 * 60_000;

type Form = "tool" | "model-keepalive" | "model-silent";

export type LongTurn = { readonly ok: boolean; readonly note: string };

const promptFor = (ctx: CaseContext, form: Form, ms: number): string => {
  switch (form) {
    case "tool":
      return `${stubMarker("sleep", `${String(ms)} ${marker(ctx, "t4")}`)} a long step`;
    case "model-keepalive":
      return `${stubMarker("slow-model", `${String(ms)} keepalive`)} a long model call`;
    case "model-silent":
      return `${stubMarker("slow-model", `${String(ms)} silent`)} a long silent model call`;
    default:
      return form satisfies never;
  }
};

const longTurn = async (ctx: CaseContext, form: Form, ms: number): Promise<LongTurn> =>
  withTask(ctx, { name: `t4-${form}-${String(Math.round(ms / 1000))}s`, upstream: { kind: "stub", format: "openai" } }, async (task) => {
    const sessionId = await newSession(task);
    const started = Date.now();
    let stopReason: string;
    try {
      stopReason = (await withTimeout(task.driver.prompt(sessionId, textPrompt(promptFor(ctx, form, ms))), ms + 180_000, "the long turn")).stopReason;
    } catch (error) {
      stopReason = `error: ${errorMessage(error).slice(0, 160)}`;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    const contiguous = task.driver.events.every((e, i) => e.seq === i + 1);
    const updates = task.driver.events.filter((e) => e.kind === "session_update").length;
    const wire = task.driver.wire().inboundSessionUpdates;
    // The long model call, as the key proxy saw it.
    const longCall = task.proxy.calls.find((c) => c.hasTools && c.endedAt - c.startedAt >= ms - 1000);
    const proxyOk = form === "tool" || (longCall?.status === 200 && !longCall.clientAborted);
    const next = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("hello")} still there?`)), 60_000, "the next turn").catch((error: unknown) => ({ stopReason: `error: ${errorMessage(error).slice(0, 80)}` }));
    const ok = stopReason === "end_turn" && seconds * 1000 >= ms && contiguous && updates === wire && next.stopReason === "end_turn" && proxyOk;
    const proxyNote =
      form === "tool"
        ? ""
        : `; key proxy: ${longCall === undefined ? "no call lasted the whole wait" : `one call of ${String(Math.round((longCall.endedAt - longCall.startedAt) / 1000))} s, status ${String(longCall.status)}, client aborted ${String(longCall.clientAborted)}`}`;
    return {
      ok,
      note: `stopReason=${stopReason} after ${String(seconds)} s; seq contiguous=${String(contiguous)}; ${String(wire)} updates on the wire, ${String(updates)} logged; next turn on the same connection: ${next.stopReason}${proxyNote}`,
    };
  });

const NAMES: Readonly<Record<Form, string>> = {
  tool: "a turn that runs >= 20 min (a 1,200 s tool step) ends with end_turn, no transport error, no lost events, connection reused",
  "model-keepalive": "a turn whose model call streams for >= 20 min (keepalives only, through the key proxy) ends with end_turn, no lost events, connection reused",
  "model-silent": "a turn whose model call is silent for 20 min (no keepalives)",
};

export const t4LongTurn = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string> = {};
  const forms: readonly Form[] = ["tool", "model-keepalive", "model-silent"];
  const ms = ctx.inputs.long ? LONG_MS : 30_000;
  const outcomes = await Promise.all(
    forms.map(async (form) => {
      try {
        return { form, result: await longTurn(ctx, form, ms) };
      } catch (error) {
        return { form, result: { ok: false, note: `the case failed: ${errorMessage(error)}` } };
      }
    }),
  );
  for (const { form, result } of outcomes) {
    if (form === "model-silent") {
      recorded[`${NAMES[form]}${ctx.inputs.long ? "" : " (30 s short form)"}`] = `${result.ok ? "ended cleanly" : "did NOT end cleanly"}: ${result.note}`;
    } else if (ctx.inputs.long) {
      checks.push(check(NAMES[form], result.ok, result.note));
    } else {
      recorded[`short form (30 s), not the criterion: ${form}`] = `${result.ok ? "ok" : "FAILED"}: ${result.note}`;
      checks.push(skip(NAMES[form], "SPIKE_LONG=1 (about 21 minutes; the three forms run in parallel)"));
    }
  }
  if (checks.length === 0) checks.push(fail("the long turn", "no form produced a result"));
  return [{ id: "T4", title: "Long turn: >= 20 min ends with end_turn, contiguous seq, connection reused (a tool step and a model call).", checks, recorded }];
};
