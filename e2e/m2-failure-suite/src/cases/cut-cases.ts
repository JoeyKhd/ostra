import type { CutMode } from "../tools/cut-proxy.ts";
import { checkEventsOnce, checkNoDoubles } from "../live/checks.ts";
import { marker } from "../live/stub-model.ts";
import { caseFile, fileOnBranch, newTicketTask, reopen, sessionsOf, taskRow, waitForFileOnBranch, waitForPr, waitForSession, waitUntil } from "../live/tasks.ts";
import type { SuiteRunner, World } from "../live/world.ts";
import { runCase, seconds } from "./case.ts";
import type { CaseResult } from "./case.ts";

// The network's rows of spec section 3's table (ticket 38): the loopback cut proxy from spike 6
// between the runner and core, in both modes, one cut after another on the suite's one runner:
// 1. The cut starts mid-turn and lasts `cutMs`: the turn carries on on the runner, its events wait
//    in the spool, and after the cut they arrive, every one once, and the PR opens.
// 2. A second cut while the session idles; a reopen message is sent during it, and arrives after.
// `--long` adds a cut past the grace (10 min): the task stops cleanly as `runner_lost`, the runner's
// stale writes are refused, and the task reopens with its context. The grace leaves the box
// `stopped`, which a reopen resumes in place while its runner is back (ADR 0039's first step, the
// domain model's `resumed`), and the runner is back here once the cut ends; a fresh box (`restored`
// or `rebuilt`) is the path when it isn't. Either way the first turn's file must be on the branch.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const cutOf = (runner: SuiteRunner) => {
  if (runner.cut === null) throw new Error(`${runner.name} has no cut proxy`);
  return runner.cut;
};

const waitForTool = async (world: World, taskId: Parameters<typeof sessionsOf>[1]): Promise<void> => {
  await waitUntil("the turn's first tool call", 180_000, async () => {
    const last = (await sessionsOf(world, taskId)).at(-1);
    return last !== undefined && (await world.db.event.count({ where: { sessionId: last.id, kind: "tool.called" } })) >= 1 ? true : null;
  }, 500);
};

export const cutCase = (world: World, runner: SuiteRunner, mode: CutMode, cutMs: number): Promise<CaseResult> => {
  const label = cutMs >= 60_000 ? `${String(cutMs / 60_000)} min` : `${String(cutMs / 1000)} s`;
  const name = `cut-${mode}-${cutMs >= 60_000 ? `${String(cutMs / 60_000)}m` : `${String(cutMs / 1000)}s`}`;
  return runCase(name, `Cut the network for ${label}, in ${mode} mode`, async (c) => {
    const proxy = cutOf(runner);
    const first = caseFile(name, 1);
    const second = caseFile(name, 2);
    const task = await newTicketTask(world, { caseName: name, marker: marker("slow", `${first} 6 2500`), runner });
    await waitForTool(world, task.taskId);

    // 1. Mid-turn.
    const storedAtCut = await world.db.event.count({ where: { taskId: task.taskId } });
    proxy.cut(mode);
    c.say(`cut (${mode}) mid-turn, for ${label}`);
    await sleep(cutMs);
    proxy.restore();
    const restoredAt = Date.now();
    const pr = await waitForPr(world, task.taskId, 300_000);
    await waitForFileOnBranch(world, task.branch, first, 120_000);
    await waitForSession(world, task.taskId, ["idle"], 180_000);
    c.time("restoreToPrSeconds", seconds(restoredAt));
    const row = await taskRow(world, task.taskId);
    const storedAfter = await world.db.event.count({ where: { taskId: task.taskId } });
    c.check("the task carries on through a cut mid-turn", row.state === "in_review", `PR #${String(pr.number)} ${String(seconds(restoredAt))} s after the cut ended; ${String(storedAfter - storedAtCut)} events arrived after it; the task is ${row.state}`);
    c.add(await checkEventsOnce(world, task.taskId));

    // 2. While idle, with a reopen message sent during the cut.
    proxy.cut(mode);
    c.say(`cut (${mode}) while idle, for ${label}; a reopen message is sent during it`);
    await sleep(Math.min(5_000, cutMs / 3));
    await reopen(world, task.taskId, `${marker("write", second)} Add the second file too.`);
    await sleep(cutMs - Math.min(5_000, cutMs / 3));
    proxy.restore();
    const secondRestoredAt = Date.now();
    await waitForFileOnBranch(world, task.branch, second, 300_000);
    c.time("restoreToSecondCommitSeconds", seconds(secondRestoredAt));
    const sessions = await sessionsOf(world, task.taskId);
    // While the box's runner is cut off, the reopen may go to another of the member's runners (F-033).
    const lease = await world.db.lease.findFirst({ where: { taskId: task.taskId }, orderBy: { epoch: "desc" }, select: { runner: { select: { name: true } } } });
    c.check(
      "a reopen message sent during the cut arrives",
      true,
      `${second} is on the branch ${String(seconds(secondRestoredAt))} s after the cut ended, by ${lease?.runner.name ?? "no runner"}; sessions ${sessions.map((one) => `${one.origin}/${one.state}`).join(", ")}`,
    );
    await waitForSession(world, task.taskId, ["idle"], 180_000, 2);
    c.add(await checkEventsOnce(world, task.taskId));
    c.add(await checkNoDoubles(world, task));
  });
};

/** `--long`: a cut past the grace. */
export const longCutCase = (world: World, runner: SuiteRunner, cutMs: number): Promise<CaseResult> =>
  runCase("cut-hold-11m", "Cut for longer than the grace: 11 min", async (c) => {
    const proxy = cutOf(runner);
    const first = caseFile("cut-long", 1);
    const second = caseFile("cut-long", 2);
    const task = await newTicketTask(world, { caseName: "cut-long", marker: marker("slow", `${first} 6 2500`), runner });
    await waitForTool(world, task.taskId);
    const cutAt = Date.now();
    proxy.cut("hold");
    c.say(`cut (hold) mid-turn, for ${String(cutMs / 60_000)} min`);
    const stopped = await waitUntil("the task stopped by the grace", cutMs, async () => {
      const row = await taskRow(world, task.taskId);
      return row.state === "stopped" ? row : null;
    }, 5000);
    c.time("cutToStoppedSeconds", seconds(cutAt));
    c.check("the task stops cleanly as runner_lost", stopped.stoppedReason === "runner_lost", `stopped (${stopped.stoppedReason ?? "no reason"}) ${String(seconds(cutAt))} s into the cut`);
    const storedBefore = await world.db.event.count({ where: { taskId: task.taskId } });
    const lastSession = (await sessionsOf(world, task.taskId)).at(-1);
    await sleep(Math.max(0, cutMs - (Date.now() - cutAt)));
    proxy.restore();
    const restoredAt = Date.now();
    // The runner comes back with its old session: whatever it still sends under the old lease is refused.
    await sleep(30_000);
    const late = await world.db.event.count({ where: { taskId: task.taskId, sessionId: lastSession?.id ?? "", sessionSeq: { not: null }, createdAt: { gt: new Date(restoredAt) } } });
    const storedAfter = await world.db.event.count({ where: { taskId: task.taskId } });
    c.check("stale writes are refused", late === 0, `${String(late)} of the old session's events stored after the cut; ${String(storedAfter - storedBefore)} events in all after the stop (core's own included)`);
    await reopen(world, task.taskId, `${marker("write", second)} Carry on, and add the second file.`);
    await waitForFileOnBranch(world, task.branch, second, 300_000);
    const sessions = await sessionsOf(world, task.taskId);
    const last = sessions.at(-1);
    // `resumed` only on the stopped session's own box; `restored` and `rebuilt` only on a fresh one.
    const sameBox = last !== undefined && lastSession !== undefined && last.boxId !== null && last.boxId === lastSession.boxId;
    const rightBox = last !== undefined && (last.origin === "resumed" ? sameBox : last.origin !== "new" && !sameBox);
    const firstKept = await fileOnBranch(world, task.branch, first);
    c.check(
      "it reopens with its context",
      rightBox && firstKept,
      `the new session is ${last?.origin ?? "missing"} on ${sameBox ? "the stopped box, its runner back" : "a fresh box"}; ${first} ${firstKept ? "is" : "is not"} on the branch, and ${second} is, ${String(seconds(restoredAt))} s after the cut ended`,
    );
    c.add(await checkEventsOnce(world, task.taskId));
    c.add(await checkNoDoubles(world, task));
  });
