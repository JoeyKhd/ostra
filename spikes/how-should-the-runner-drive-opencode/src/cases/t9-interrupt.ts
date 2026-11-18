// T9 Steering and interrupt: a second session/prompt mid-turn gets a clear
// error (no hang); session/cancel gives stopReason "cancelled" within 5 s;
// cancel then a new prompt continues with prior context; no process is left.
// Also pass-bar bullet 2's "a cancel returns within 5 s and leaves no process
// behind": the process check runs the moment the driver's cancel returns, not
// after the task stops. The cancel includes the driver's reap of anything the
// turn started; what OpenCode left for it to reap is recorded.

import { agentText, textPrompt } from "../lib/acp-driver.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { errorMessage, isToolCall, marker, newSession, processesWithMarker, waitForEvent, withTask, withTimeout, type CaseContext } from "../harness/fixture.ts";
import { check, fail, type Check, type Criterion } from "../harness/report.ts";

export const t9Interrupt = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string | number> = {};
  const mark = marker(ctx, "t9");
  try {
    await withTask(ctx, { name: "t9", upstream: { kind: "stub", format: "openai" } }, async (task) => {
      const sessionId = await newSession(task);
      const first = task.driver.prompt(sessionId, textPrompt(`${stubMarker("sleep", `60000 ${mark}`)} The secret word is lighthouse. Wait a minute.`));
      first.catch(() => undefined);
      await waitForEvent(task.driver, isToolCall, 60_000, "the sleep tool call");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // A second prompt while the first runs.
      const secondStarted = Date.now();
      let secondOutcome: string;
      let secondOk: boolean;
      try {
        const second = await withTimeout(task.driver.prompt(sessionId, textPrompt("a second prompt mid-turn")), 15_000, "second prompt");
        secondOutcome = `accepted, stopReason=${second.stopReason} after ${String(Date.now() - secondStarted)} ms`;
        secondOk = false;
      } catch (error) {
        const message = errorMessage(error);
        secondOk = !message.includes("did not finish within");
        secondOutcome = secondOk ? `rejected after ${String(Date.now() - secondStarted)} ms: ${message.slice(0, 160)}` : "no answer within 15 s (hang)";
      }
      recorded["second prompt rejected after (ms)"] = secondOk ? Date.now() - secondStarted : -1;
      checks.push(check("a second session/prompt mid-turn gets a clear error (no hang)", secondOk, secondOutcome));

      const markedBefore = await processesWithMarker(mark);
      const cancelAt = Date.now();
      await task.driver.cancel(sessionId);
      let stopReason = "none";
      let cancelMs: number | undefined;
      try {
        const response = await withTimeout(first, 5_000, "cancel");
        stopReason = response.stopReason;
        cancelMs = Date.now() - cancelAt;
      } catch (error) {
        stopReason = errorMessage(error);
      }
      // The moment the cancel returned: is anything of the turn still alive?
      const markedAfter = await processesWithMarker(mark);
      const reaped = task.driver.events.flatMap((e) => (e.kind === "cancel_reaped" && e.sessionId === sessionId ? e.pids : []));
      const reapedMarked = markedBefore.filter((pid) => reaped.includes(pid));
      recorded["cancel to stopReason, reap included (ms)"] = cancelMs ?? -1;
      recorded["marked tool processes before the cancel / when it returned"] = `${String(markedBefore.length)} / ${String(markedAfter.length)}`;
      recorded["of those, killed by the driver's reap (OpenCode left them)"] = reapedMarked.length;
      const reapedNames = [...new Set(task.driver.events.flatMap((e) => (e.kind === "cancel_reaped" && e.sessionId === sessionId ? e.names : [])))];
      recorded["processes the driver reaped after the cancel (all)"] = `${String(reaped.length)}${reapedNames.length === 0 ? "" : ` (${reapedNames.join(", ")})`}`;
      checks.push(
        check("session/cancel gives stopReason cancelled within 5 s", stopReason === "cancelled" && cancelMs !== undefined && cancelMs <= 5000, `stopReason=${stopReason}${cancelMs === undefined ? "" : ` after ${String(cancelMs)} ms, the driver's reap included`}`),
      );
      checks.push(
        check(
          "when the cancel returns, no process of the cancelled turn is left",
          markedBefore.length > 0 && markedAfter.length === 0,
          markedBefore.length === 0
            ? "the tool process was not found before the cancel, so nothing was tested"
            : `${String(markedBefore.length)} marked tool processes before the cancel, ${String(markedAfter.length)} when it returned; ${reapedMarked.length === 0 ? "OpenCode ended them itself" : `${String(reapedMarked.length)} killed by the driver's reap`}`,
        ),
      );

      const sinceSeq = task.driver.events.at(-1)?.seq ?? 0;
      const next = await withTimeout(task.driver.prompt(sessionId, textPrompt(`${stubMarker("recall")} What was the secret word?`)), 60_000, "prompt after cancel");
      const text = agentText(task.driver.events, sessionId, sinceSeq);
      checks.push(check("cancel then a new prompt continues with prior context", next.stopReason === "end_turn" && text.includes("lighthouse"), `stopReason=${next.stopReason}; agent said "${text.slice(0, 80)}"`));
    });
    const leftAfterStop = (await processesWithMarker(mark)).length;
    checks.push(check("no processes are left over after the task stops", leftAfterStop === 0, `${String(leftAfterStop)} marked processes alive after the driver stopped`));
  } catch (error) {
    checks.push(fail("the interrupt case", errorMessage(error)));
  }
  return [{ id: "T9", title: "Steering and interrupt: second prompt errors, cancel within 5 s, context kept, no processes left.", checks, recorded }];
};
