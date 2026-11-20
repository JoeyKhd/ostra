import { readFile } from "node:fs/promises";
import path from "node:path";

import { startRunner } from "@ostra/e2e-m1/runner";
import type { TaskId } from "@ostra/protocol";
import { z } from "zod";

import { checkEventsOnce, checkNoDoubles } from "../live/checks.ts";
import { marker, rememberWords } from "../live/stub-model.ts";
import { caseFile, newTicketTask, reopen, sessionsOf, taskRow, waitForFileOnBranch, waitForPr, waitForSession, waitUntil } from "../live/tasks.ts";
import type { SuiteRunner, World } from "../live/world.ts";
import { addRunner } from "../live/world.ts";
import { processTable } from "../tools/procs.ts";
import { runCase, seconds } from "./case.ts";
import type { CaseResult } from "./case.ts";

// Ticket 41's case (F-013, F-091, F-092, F-045): a runner revoked mid-turn, and the task reopened
// on a second runner with its context. A third personal runner of the admin's, `fs-revoke`, takes a
// ticket task and finishes its first turn (a PR and a session archive). A reopen's turn starts on it
// and, mid-turn, the admin revokes it through the panel's API (`runners.revoke`), as the Revoke
// action does. Then:
// - in the revoke's one transaction the task stopped as `runner_lost`, its session stopped, and its
//   lease ended (`runner-revoked`): it reads so as soon as the call returns;
// - core evicted the runner and closed its socket with 4403 (`gateway.evicted`, reason `revoked`),
//   and the runner was refused for good and exited;
// - nothing the revoked runner still had is stored: no event of the session after the revoke, also
//   once the runner is started again from its folder, whose token request is refused;
// - the one-click reopen goes to the suite's main runner, the admin's other personal runner (F-033):
//   a session restored from the archive, which replays the unanswered message, and whose agent
//   answers from the first turn's context (the stub's `recall` script).

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The runner's own words when the server refuses it as revoked: its log line when its connection
 * is evicted or closed with 4403 (`apps/runner/src/connection/peer.ts`, `error the server refused
 * this runner for good … reason=revoked`), and what it says when its token request is refused at a
 * start (`REVOKED_MESSAGE`, `apps/runner/src/server/access-token.ts`).
 */
const refusalsIn = async (logFile: string): Promise<{ readonly evicted: number; readonly tokenRefused: number }> => {
  const lines = (await readFile(logFile, "utf8").catch(() => "")).split(/\r?\n/);
  return {
    evicted: lines.filter((line) => line.includes("the server refused this runner for good") && line.includes("reason=revoked")).length,
    tokenRefused: lines.filter((line) => line.startsWith("The server refused this runner's key: it was revoked in the panel.")).length,
  };
};

/** Whether a process with `pid` is still running. */
const running = async (pid: number | null): Promise<boolean> => pid !== null && (await processTable()).some((row) => row.pid === pid);

const waitForTools = async (world: World, taskId: TaskId, count: number): Promise<void> => {
  await waitUntil(`${String(count)} tool calls of ${taskId}`, 180_000, async () => {
    const last = (await sessionsOf(world, taskId)).at(-1);
    return last !== undefined && (await world.db.event.count({ where: { sessionId: last.id, kind: "tool.called" } })) >= count ? true : null;
  }, 500);
};

const revokedSchema = z.looseObject({ runnerId: z.string(), alreadyRevoked: z.boolean(), stoppedTasks: z.number() });
const messageSchema = z.looseObject({ text: z.string() });

export const revokeRunnerCase = (world: World, second: SuiteRunner, input: { readonly dataDir: string; readonly logDir: string }): Promise<CaseResult> =>
  runCase("revoke-runner", "Revoke a runner mid-turn, and reopen the task on a second runner with its context (ticket 41)", async (c) => {
    const doomed = await addRunner(world, { name: "fs-revoke", dataDir: input.dataDir, cut: null, logDir: input.logDir });
    c.say(`${doomed.name} (${doomed.runnerId}) is online beside ${second.name}`);
    const first = caseFile("revoke-runner", 1);
    const next = caseFile("revoke-runner", 2);
    const task = await newTicketTask(world, { caseName: "revoke-runner", marker: marker("write", first), runner: doomed });
    const pr = await waitForPr(world, task.taskId);
    await waitForSession(world, task.taskId, ["idle"], 120_000);
    const archived = (await sessionsOf(world, task.taskId)).at(-1)?.archiveBlobId ?? null;
    c.check("the first turn left an archive", archived !== null, `PR #${String(pr.number)}; archive blob ${archived ?? "none"}`);

    // A reopen's turn starts on the doomed runner: it reads for a while, then writes `next` and says
    // whether it remembers `first`.
    const message = await reopen(world, task.taskId, `${marker("recall", `${next} ${first} 8 2500`)} Then add the second file.`);
    await waitForTools(world, task.taskId, 2);
    const turnSession = (await sessionsOf(world, task.taskId)).at(-1);
    if (turnSession === undefined) throw new Error("no session for the reopen's turn");
    const lease = await world.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, state: "active" }, select: { id: true, epoch: true, runnerId: true } });
    if (lease.runnerId !== doomed.runnerId) throw new Error(`the reopen's turn runs on ${lease.runnerId}, not on ${doomed.name}`);
    const refusalsBefore = await refusalsIn(doomed.logFile);
    const evicted = world.stack
      .core()
      .waitForLine((line) => line.includes("\"gateway.evicted\"") && line.includes(doomed.runnerId) && line.includes("\"reason\":\"revoked\""), 30_000)
      .then(() => Date.now(), () => null);

    // The admin revokes it, as the panel's Revoke does.
    const revokedAt = Date.now();
    const answer = revokedSchema.parse(await world.api.mutate("runners.revoke", { runnerId: doomed.runnerId }));
    const answeredSeconds = seconds(revokedAt);
    const row = await taskRow(world, task.taskId);
    const session = await world.db.session.findUniqueOrThrow({ where: { id: turnSession.id }, select: { state: true } });
    const ended = await world.db.lease.findUniqueOrThrow({ where: { id: lease.id }, select: { state: true, endReason: true } });
    const runnerRow = await world.db.runner.findUniqueOrThrow({ where: { id: doomed.runnerId }, select: { state: true, revokedAt: true } });
    c.time("revokeAnsweredSeconds", answeredSeconds);
    c.check(
      "its task stopped as runner_lost at once",
      !answer.alreadyRevoked && answer.stoppedTasks >= 1 && row.state === "stopped" && row.stoppedReason === "runner_lost" && session.state === "stopped" && ended.state !== "active" && ended.endReason === "runner-revoked" && runnerRow.state === "revoked",
      `runners.revoke answered in ${String(answeredSeconds)} s (${String(answer.stoppedTasks)} task stopped); then the task read ${row.state} (${row.stoppedReason ?? "no reason"}), its session ${session.state}, lease epoch ${String(lease.epoch)} ${ended.state} (${ended.endReason ?? "no reason"}), the runner ${runnerRow.state}`,
    );
    const evictedAt = await evicted;
    await waitUntil("the revoked runner's refusal", 30_000, async () => ((await refusalsIn(doomed.logFile)).evicted > refusalsBefore.evicted ? true : null)).catch(() => undefined);
    const refused = (await refusalsIn(doomed.logFile)).evicted > refusalsBefore.evicted;
    await waitUntil("the revoked runner's exit", 30_000, async () => ((await running(doomed.process.pid)) ? null : true), 2000).catch(() => undefined);
    const exited = !(await running(doomed.process.pid));
    c.time("evictedSeconds", evictedAt === null ? -1 : Math.round((evictedAt - revokedAt) / 100) / 10);
    c.check(
      "its socket closed with 4403, and the runner was refused for good",
      evictedAt !== null && refused && exited,
      `${evictedAt === null ? "core never logged the eviction" : `core evicted it and closed its socket with 4403 ${String(Math.round((evictedAt - revokedAt) / 100) / 10)} s after the revoke`}; the runner ${refused ? "logged its refusal as revoked" : "never logged a refusal"} and ${exited ? "exited" : "is still running"}`,
    );

    // Whatever it still had (the agent's last events in its spool) never lands, and its next start is refused.
    await sleep(10_000);
    const revokedSince = runnerRow.revokedAt ?? new Date(revokedAt);
    const lateBeforeRestart = await world.db.event.count({ where: { sessionId: turnSession.id, sessionSeq: { not: null }, createdAt: { gt: revokedSince } } });
    await doomed.process.stop();
    const restarted = await startRunner({ ...world.m2, runnerName: doomed.name, runnerDataDir: doomed.dataDir, coreUrl: doomed.serverUrl }, doomed.logFile);
    doomed.process = restarted;
    await waitUntil("the restarted runner's refusal", 60_000, async () => ((await refusalsIn(doomed.logFile)).tokenRefused > refusalsBefore.tokenRefused ? true : null)).catch(() => undefined);
    const refusedAgain = (await refusalsIn(doomed.logFile)).tokenRefused > refusalsBefore.tokenRefused;
    await sleep(5_000);
    await restarted.stop();
    const late = await world.db.event.count({ where: { sessionId: turnSession.id, sessionSeq: { not: null }, createdAt: { gt: revokedSince } } });
    const stillRevoked = await world.db.runner.findUniqueOrThrow({ where: { id: doomed.runnerId }, select: { state: true } });
    c.check(
      "its late events are refused",
      late === 0 && refusedAgain && stillRevoked.state === "revoked",
      `${String(lateBeforeRestart)} of the session's events stored after the revoke, ${String(late)} after the runner was started again from its folder; that start was ${refusedAgain ? "refused for good (its token request)" : "not refused"}; the runner is ${stillRevoked.state}`,
    );

    // The one-click reopen: the admin's other personal runner restores the session from the archive.
    const reopenedAt = Date.now();
    await reopen(world, task.taskId, null);
    await waitForFileOnBranch(world, task.branch, next, 300_000);
    c.time("reopenToCommitSeconds", seconds(reopenedAt));
    const sessions = await sessionsOf(world, task.taskId);
    const last = sessions.at(-1);
    const newest = await world.db.lease.findFirst({ where: { taskId: task.taskId }, orderBy: { epoch: "desc" }, select: { epoch: true, runner: { select: { name: true } } } });
    c.check(
      "the reopen is dispatched to the second runner",
      newest?.runner.name === second.name && newest.epoch > lease.epoch,
      `lease epoch ${String(newest?.epoch ?? 0)} on ${newest?.runner.name ?? "no runner"} (the revoked one held epoch ${String(lease.epoch)}); sessions ${sessions.map((one) => `${one.origin}/${one.state}`).join(", ")}`,
    );
    const replayed = await world.db.event.findMany({ where: { taskId: task.taskId, kind: "user.message", sessionId: last?.id ?? "" }, select: { payload: true } });
    const again = replayed.filter((one) => JSON.stringify(one.payload).includes(message) && JSON.stringify(one.payload).includes("\"replayed\":true")).length;
    const said = await waitUntil("the restored agent's answer", 120_000, async () => {
      const rows = await world.db.event.findMany({ where: { taskId: task.taskId, kind: "agent.message", sessionId: last?.id ?? "" }, select: { payload: true } });
      const texts = rows.flatMap((one) => {
        const parsed = messageSchema.safeParse(one.payload);
        return parsed.success ? [parsed.data.text] : [];
      });
      return texts.some((text) => text.includes(next)) ? texts.join(" ") : null;
    }).catch(() => "");
    const remembers = said.includes(rememberWords(first));
    c.check(
      "it restores the session with its context",
      last?.origin === "restored" && again === 1 && remembers,
      `the new session is ${last?.origin ?? "missing"}, with ${String(again)} replayed copy of the unanswered message; the agent ${remembers ? `said "${rememberWords(first)}"` : said === "" ? "said nothing" : "said it doesn't remember the first turn"}; ${path.basename(next)} on PR #${String(pr.number)}'s branch ${String(seconds(reopenedAt))} s after the reopen`,
    );
    await waitForSession(world, task.taskId, ["idle"], 180_000, sessions.length);
    c.add(await checkEventsOnce(world, task.taskId));
    c.add(await checkNoDoubles(world, task));
  });
