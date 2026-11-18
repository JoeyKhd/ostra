// T13 Agent crash: kill -9 on OpenCode mid-turn is detected within 2 s, the
// session is marked crashed (ADR 0011 #5), and the workspace and branch are
// intact. The turn first starts a detached helper (a grandchild that leaves
// its shell, and on POSIX the agent's process group), so the runner's reap of
// a crashed agent's leftovers has something to do; if the crash leaves nothing
// behind, that check is SKIPPED rather than passed.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { isAgentExitedError, textPrompt } from "../lib/acp-driver.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { errorMessage, gitHead, isToolCall, marker, newSession, processesWithMarker, waitForEvent, withTask, withTimeout, type CaseContext } from "../harness/fixture.ts";
import { check, fail, skip, type Check, type Criterion } from "../harness/report.ts";

/** The task's session lifecycle, as the runner tracks it. */
type SessionState =
  | { readonly kind: "running"; readonly since: number }
  | { readonly kind: "idle"; readonly since: number }
  | { readonly kind: "crashed"; readonly since: number; readonly exitCode: number | null; readonly signal: string | null };

export const t13Crash = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string | number> = {};
  const mark = marker(ctx, "t13");
  try {
    await withTask(ctx, { name: "t13", upstream: { kind: "stub", format: "openai" } }, async (task) => {
      const sessionId = await newSession(task);
      let state: SessionState = { kind: "idle", since: Date.now() };
      void task.driver.exited.then((exit) => {
        state = { kind: "crashed", since: exit.at, exitCode: exit.code, signal: exit.signal };
      });
      state = { kind: "running", since: Date.now() };
      // Read through a function: the exit handler changes it asynchronously.
      const current = (): SessionState => state;
      const turn = task.driver.prompt(sessionId, textPrompt(`${stubMarker("detached-then-sleep", mark)} a long step`));
      // The second tool call is the long sleep; crash while it runs.
      await waitForEvent(task.driver, (e) => isToolCall(e) && e.kind === "session_update" && e.update.sessionUpdate === "tool_call" && task.driver.events.filter(isToolCall).length >= 2, 60_000, "the sleep step");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const beforeCrash = await processesWithMarker(mark);
      recorded["marked processes before the crash (detached helper and sleep)"] = beforeCrash.length;
      const crashAt = Date.now();
      task.driver.crash();
      let detectedAt = 0;
      let reason = "";
      try {
        await withTimeout(turn, 5_000, "the crashed turn");
        reason = "the turn returned normally";
      } catch (error) {
        detectedAt = Date.now();
        reason = isAgentExitedError(error) ? "agent exit detected" : errorMessage(error);
      }
      const detectMs = detectedAt === 0 ? -1 : detectedAt - crashAt;
      recorded["kill -9 to detection (ms)"] = detectMs;
      const final = current();
      checks.push(
        check(
          "kill -9 on OpenCode mid-turn is detected within 2 s, and the session is marked crashed",
          detectMs >= 0 && detectMs <= 2000 && final.kind === "crashed",
          `${reason} after ${String(detectMs)} ms; session state ${final.kind}`,
        ),
      );
      const orphans = await processesWithMarker(mark);
      recorded["tool processes left running by the crash, before the runner reaps"] = orphans.length;
      const reaped = await task.driver.reap();
      const after = await processesWithMarker(mark);
      recorded["reaped from the tree snapshot"] = reaped;
      checks.push(
        orphans.length === 0
          ? skip("the crashed agent's tool processes are reaped by the runner", `reap path not exercised: the crash left no tool processes (${String(beforeCrash.length)} marked before it; the OS ended them with the agent)`)
          : check("the crashed agent's tool processes are reaped by the runner", after.length === 0 && reaped > 0, `${String(orphans.length)} left by the crash, ${String(reaped)} reaped from the tree snapshots, ${String(after.length)} alive after`),
      );
      const head = await gitHead(task.dirs);
      const readme = await readFile(path.join(task.dirs.workspace, "README.md"), "utf8");
      checks.push(check("the workspace and branch are intact", head.branch === task.branch && readme === "hello\n", `branch ${head.branch}, git status ${head.clean ? "clean" : "dirty"}, README intact: ${String(readme === "hello\n")}`));
    });
  } catch (error) {
    checks.push(fail("the crash case", errorMessage(error)));
  }
  return [{ id: "T13", title: "Agent crash: kill -9 mid-turn detected within 2 s, session marked crashed, workspace and branch intact.", checks, recorded }];
};
