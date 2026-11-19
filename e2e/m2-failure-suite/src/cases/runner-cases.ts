import { rm } from "node:fs/promises";
import path from "node:path";

import type { TaskId } from "@ostra/protocol";

import { checkEventsOnce, checkNoDoubles } from "../live/checks.ts";
import { marker } from "../live/stub-model.ts";
import {
  branchExists,
  caseFile,
  hiddenRef,
  newTicketTask,
  reopen,
  sessionsOf,
  taskRow,
  waitForFileOnBranch,
  waitForPr,
  waitForSession,
  waitUntil,
} from "../live/tasks.ts";
import type { SuiteRunner, World } from "../live/world.ts";
import { restartRunner } from "../live/world.ts";
import { descendantsOf, killTree, processTable } from "../tools/procs.ts";
import { runCase, seconds } from "./case.ts";
import type { CaseResult } from "./case.ts";

// The runner's rows of spec section 3's table (ticket 38): `kill -9` of the runner, a killed agent,
// a lost box, and a batch the server can't store. Each runs on the suite's main runner, with real
// OpenCode on the stub model, against OST and test1.

/** Waits until the task's newest session has stored `count` tool calls: the turn is under way. */
const waitForTools = async (world: World, taskId: TaskId, count: number, timeoutMs = 180_000): Promise<void> => {
  await waitUntil(`${String(count)} tool calls of ${taskId}`, timeoutMs, async () => {
    const last = (await sessionsOf(world, taskId)).at(-1);
    if (last === undefined) return null;
    return (await world.db.event.count({ where: { sessionId: last.id, kind: "tool.called" } })) >= count ? true : null;
  }, 500);
};

const taskFolder = (runner: SuiteRunner, taskId: TaskId): string => path.join(runner.dataDir, "tasks", taskId);

/** A finished first turn: the ticket's task writes `file`, the PR opens, and the session idles. */
const firstTurn = async (world: World, caseName: string, runner: SuiteRunner, file: string) => {
  const task = await newTicketTask(world, { caseName, marker: marker("write", file), runner });
  const pr = await waitForPr(world, task.taskId);
  await waitForSession(world, task.taskId, ["idle"], 120_000);
  return { task, pr };
};

export const killRunnerCase = (world: World, runner: SuiteRunner): Promise<CaseResult> =>
  runCase("kill-runner", "Kill the runner mid-turn: kill -9, restart it from its data folder", async (c) => {
    const file = caseFile("kill-runner", 1);
    const task = await newTicketTask(world, { caseName: "kill-runner", marker: marker("slow", `${file} 8 2500`), runner });
    await waitForTools(world, task.taskId, 2);
    const killedAt = Date.now();
    await runner.process.stop();
    c.say("the runner's process tree is killed mid-turn");
    await restartRunner(world, runner);
    c.time("restartSeconds", seconds(killedAt));
    // On `host` the agent was in the runner's tree, so it died with it: the session is crashed.
    const crashed = await waitForSession(world, task.taskId, ["crashed"], 120_000);
    c.check("the restarted runner reports the session it lost", crashed.state === "crashed", `the session is ${crashed.state} ${String(seconds(killedAt))} s after the kill`);
    c.add(await checkEventsOnce(world, task.taskId));
    // One action carries on: the reopen, on the same box when it's kept, or a fresh one.
    await reopen(world, task.taskId, null);
    const pr = await waitForPr(world, task.taskId, 240_000);
    await waitForFileOnBranch(world, task.branch, file, 120_000);
    c.time("killToPrSeconds", seconds(killedAt));
    const sessions = await sessionsOf(world, task.taskId);
    c.check("the task finishes after the one-click reopen", true, `PR #${String(pr.number)} with ${file}, ${String(sessions.length)} sessions (${sessions.map((one) => `${one.origin}/${one.state}`).join(", ")})`);
    c.add(await checkEventsOnce(world, task.taskId));
    c.add(await checkNoDoubles(world, task));
  });

/** OpenCode's processes under the runner: the agent, and whatever it started. */
const agentProcesses = async (runner: SuiteRunner) => {
  const pid = runner.process.pid;
  if (pid === null) throw new Error(`${runner.name} has no process`);
  const table = await processTable();
  return descendantsOf(table, pid).filter((row) => /opencode/i.test(row.name));
};

export const killAgentCase = (world: World, runner: SuiteRunner): Promise<CaseResult> =>
  runCase("kill-agent", "Kill the agent mid-turn: kill OpenCode's process tree", async (c) => {
    const first = caseFile("kill-agent", 1);
    const second = caseFile("kill-agent", 2);
    const { task, pr } = await firstTurn(world, "kill-agent", runner, first);
    await reopen(world, task.taskId, `${marker("slow", `${second} 8 2500`)} Then add the second file.`);
    await waitForTools(world, task.taskId, 2);
    const agents = await agentProcesses(runner);
    if (agents.length === 0) throw new Error("no OpenCode process under the runner");
    const killedAt = Date.now();
    for (const agent of agents) await killTree(agent.pid);
    c.say(`killed ${String(agents.length)} OpenCode processes mid-turn`);
    const crashed = await waitForSession(world, task.taskId, ["crashed"], 120_000, 2);
    c.time("crashSeenSeconds", seconds(killedAt));
    const row = await taskRow(world, task.taskId);
    const ref = await hiddenRef(world, task.taskId);
    const branch = await branchExists(world, task.branch);
    c.check("the session is crashed", crashed.state === "crashed", `session ${crashed.id} is crashed ${String(seconds(killedAt))} s after the kill; the task is ${row.state}`);
    c.check("the branch and the hidden ref stay", branch && ref !== null, `branch ${branch ? "there" : "gone"}, refs/ostra/wip/${task.taskId} ${ref === null ? "gone" : ref.slice(0, 7)}`);
    await reopen(world, task.taskId, null);
    await waitForFileOnBranch(world, task.branch, second, 240_000);
    c.time("killToCommitSeconds", seconds(killedAt));
    const sessions = await sessionsOf(world, task.taskId);
    c.check("\"Reopen\" carries on", true, `${second} is on the same branch and PR #${String(pr.number)}; sessions ${sessions.map((one) => `${one.origin}/${one.state}`).join(", ")}`);
    c.add(await checkEventsOnce(world, task.taskId));
    c.add(await checkNoDoubles(world, task));
  });

export const loseBoxCase = (world: World, runner: SuiteRunner): Promise<CaseResult> =>
  runCase("lose-box", "Lose the box: delete the worktree while the runner is stopped", async (c) => {
    const first = caseFile("lose-box", 1);
    const second = caseFile("lose-box", 2);
    const { task, pr } = await firstTurn(world, "lose-box", runner, first);
    const archived = (await sessionsOf(world, task.taskId)).at(-1)?.archiveBlobId ?? null;
    c.check("the first turn left an archive", archived !== null, `archive blob ${archived ?? "none"}`);
    const message = await reopen(world, task.taskId, `${marker("slow", `${second} 8 2500`)} Then add the second file.`);
    await waitForTools(world, task.taskId, 2);
    // The runner stops mid-turn, and its box goes while it's down: the message is still unanswered.
    await runner.process.stop();
    await rm(taskFolder(runner, task.taskId), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    const lostAt = Date.now();
    c.say("the runner is stopped and the task's worktree deleted");
    await restartRunner(world, runner);
    await waitForSession(world, task.taskId, ["crashed"], 120_000, 2);
    await reopen(world, task.taskId, null);
    await waitForFileOnBranch(world, task.branch, second, 300_000);
    c.time("lossToCommitSeconds", seconds(lostAt));
    const sessions = await sessionsOf(world, task.taskId);
    const last = sessions.at(-1);
    c.check("it reopens on a fresh worktree from the last archive", last?.origin === "restored", `the new session is ${last?.origin ?? "missing"}; ${second} is on PR #${String(pr.number)}'s branch`);
    const replayed = await world.db.event.findMany({ where: { taskId: task.taskId, kind: "user.message", sessionId: last?.id ?? "" }, select: { payload: true } });
    const again = replayed.filter((row) => JSON.stringify(row.payload).includes(message) && JSON.stringify(row.payload).includes("\"replayed\":true")).length;
    c.check("the unanswered message is replayed", again === 1, `${String(again)} replayed copy of the message in the new session`);
    c.add(await checkEventsOnce(world, task.taskId));
    c.add(await checkNoDoubles(world, task));
  });

export const unstorableCase = (world: World, runner: SuiteRunner): Promise<CaseResult> =>
  runCase("unstorable", "A batch the server can't store: the agent emits an event the server refuses", async (c) => {
    const file = caseFile("unstorable", 1);
    const task = await newTicketTask(world, { caseName: "unstorable", marker: marker("unstorable", file), runner });
    const item = await waitUntil("the unstorable_event item", 180_000, () =>
      world.db.needsYouItem.findFirst({ where: { taskId: task.taskId, reason: "unstorable_event" }, select: { id: true, state: true } }),
    );
    await waitForPr(world, task.taskId);
    await waitForSession(world, task.taskId, ["idle"], 120_000);
    const placeholders = async (): Promise<number> =>
      (await world.db.event.findMany({ where: { taskId: task.taskId, kind: "agent.unknown" }, select: { payload: true } })).filter((row) => JSON.stringify(row.payload).includes("event-refused")).length;
    const before = await placeholders();
    const stored = await world.db.event.count({ where: { taskId: task.taskId } });
    // Past a reconnect's worth of time: a runner still resending would have been refused again.
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    const after = await placeholders();
    const storedAfter = await world.db.event.count({ where: { taskId: task.taskId } });
    const items = await world.db.needsYouItem.count({ where: { taskId: task.taskId, reason: "unstorable_event" } });
    c.check("it's refused once, with a needs-you item", before === 1 && items === 1, `${String(before)} placeholder event, ${String(items)} unstorable_event item (${item.state})`);
    c.check("the runner stops resending it", after === before && storedAfter === stored, `${String(after)} placeholder and ${String(storedAfter)} events 20 s later (were ${String(stored)})`);
    const row = await taskRow(world, task.taskId);
    c.check("the task carries on past it", row.state === "in_review" || row.state === "needs_you", `the task is ${row.state}, its PR open`);
    c.add(await checkEventsOnce(world, task.taskId));
    c.add(await checkNoDoubles(world, task));
  });
