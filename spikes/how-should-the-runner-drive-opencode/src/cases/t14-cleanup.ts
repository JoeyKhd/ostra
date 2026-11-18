// T14 Process-tree cleanup: after 10 turns with cancels, no stray PIDs: test
// servers and shells started by tools are gone, killed by process group (or,
// on Windows, from the tree snapshots). Each turn starts a background server
// and a foreground sleep, then is cancelled; the count of marked processes is
// taken the moment each cancel returns, and again after the task stops.

import { textPrompt } from "../lib/acp-driver.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { errorMessage, marker, newSession, processesWithMarker, waitForEvent, withTask, withTimeout, type CaseContext } from "../harness/fixture.ts";
import { check, fail, type Check, type Criterion } from "../harness/report.ts";

export const t14Cleanup = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string | number> = {};
  const mark = marker(ctx, "t14");
  try {
    await withTask(ctx, { name: "t14", upstream: { kind: "stub", format: "openai" } }, async (task) => {
      const sessionId = await newSession(task);
      const stopReasons: string[] = [];
      const runningPerTurn: number[] = [];
      const leftPerTurn: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        const since = task.driver.events.at(-1)?.seq ?? 0;
        const turn = task.driver.prompt(sessionId, textPrompt(`${stubMarker("bg-and-sleep", mark)} turn ${String(i + 1)}`));
        turn.catch(() => undefined);
        // Both tool calls running.
        await waitForEvent(
          task.driver,
          (e) =>
            e.seq > since &&
            e.kind === "session_update" &&
            e.update.sessionUpdate === "tool_call_update" &&
            e.update.status === "in_progress" &&
            JSON.stringify(e.update.rawInput ?? {}).includes("setTimeout"),
          60_000,
          "the sleep step",
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));
        runningPerTurn.push((await processesWithMarker(mark)).length);
        await task.driver.cancel(sessionId);
        const response = await withTimeout(turn, 10_000, `cancel of turn ${String(i + 1)}`);
        stopReasons.push(response.stopReason);
        leftPerTurn.push((await processesWithMarker(mark)).length);
      }
      const reaped = task.driver.events.flatMap((e) => (e.kind === "cancel_reaped" ? e.pids : [])).length;
      recorded["stopReasons"] = [...new Set(stopReasons)].join(",");
      recorded["marked processes running before each cancel"] = runningPerTurn.join(",");
      recorded["marked processes alive when each cancel returned"] = leftPerTurn.join(",");
      recorded["processes the driver reaped after the cancels"] = reaped;
      checks.push(check("10 turns with cancels all end cancelled", stopReasons.every((r) => r === "cancelled"), `stopReasons: ${stopReasons.join(",")}`));
      checks.push(
        check(
          "no marked process survives any cancel",
          runningPerTurn.every((n) => n > 0) && leftPerTurn.every((n) => n === 0),
          `running before each cancel: ${runningPerTurn.join(",")}; alive when each cancel returned: ${leftPerTurn.join(",")}; the driver reaped ${String(reaped)} processes in all`,
        ),
      );
    });
    // withTask stopped the driver: everything it started must be gone.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const stray = await processesWithMarker(mark);
    checks.push(check("after the task stops, no stray PIDs: test servers and shells started by tools are gone", stray.length === 0, `${String(stray.length)} marked processes alive`));
  } catch (error) {
    checks.push(fail("the cleanup case", errorMessage(error)));
  }
  return [{ id: "T14", title: "Process-tree cleanup: after 10 turns with cancels, no stray PIDs.", checks, recorded }];
};
