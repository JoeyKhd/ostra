import { randomBytes } from "node:crypto";

import { say } from "@ostra/e2e-m1/setup";
import { createIssue } from "@ostra/e2e-m2/linear";
import { taskIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import { z } from "zod";

import { clientMessageId } from "./api.ts";
import type { SuiteRunner, World } from "./world.ts";

// The cases' common moves (ticket 38): a real ticket in OST whose description carries the stub
// model's script, the task started from it as the Inbox starts one, a reopen as the composer sends
// it, and the waits on the database every check reads. Nothing here sleeps for a fixed time unless a
// case says why: every wait polls a condition with a deadline.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const waitUntil = async <T,>(what: string, timeoutMs: number, read: () => Promise<T | null>, everyMs = 1000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
};

export type TicketTask = {
  readonly taskId: TaskId;
  readonly ticketId: string;
  /** Linear's issue ID. */
  readonly issueId: string;
  readonly identifier: string;
  readonly branch: string;
  readonly runner: SuiteRunner;
  /** When the ticket reached the cache, in seconds after it was made. */
  readonly cachedSeconds: number;
};

const startedSchema = z.object({ taskId: taskIdSchema, branchName: z.string() });

/** A ticket in OST that asks for `marker`'s script, started as a task on `runner`. */
export const newTicketTask = async (world: World, input: { readonly caseName: string; readonly marker: string; readonly runner: SuiteRunner }): Promise<TicketTask> => {
  const title = `Failure suite: ${input.caseName} ${randomBytes(3).toString("hex")}`;
  const made = Date.now();
  const issue = await createIssue(world.tool, {
    teamId: world.m2.linearTeamId,
    title,
    description: `${input.marker}\n\nThe failure suite's ticket for "${input.caseName}" (ticket 38). The stub model plays the script above.`,
    labelIds: [],
  });
  world.made.tickets.push({ id: issue.id, identifier: issue.identifier });
  const ticket = await waitUntil(`${issue.identifier} in the ticket cache`, 120_000, () =>
    world.db.ticket.findFirst({ where: { externalId: issue.id, boardId: world.boardId }, select: { id: true } }),
  );
  const cachedSeconds = Math.round((Date.now() - made) / 100) / 10;
  const started = startedSchema.parse(await world.api.mutate("tasks.startFromTicket", { projectId: world.projectId, ticketId: ticket.id, runnerId: input.runner.runnerId }));
  world.made.taskIds.push(started.taskId);
  say(`${input.caseName}: ${issue.identifier} (cached after ${String(cachedSeconds)} s) is task ${started.taskId} on ${input.runner.name}`);
  return { taskId: started.taskId, ticketId: ticket.id, issueId: issue.id, identifier: issue.identifier, branch: started.branchName, runner: input.runner, cachedSeconds };
};

/** The composer's reopen: a member's message, or the one-click reopen when `text` is null. */
export const reopen = async (world: World, taskId: TaskId, text: string | null): Promise<string> => {
  const id = clientMessageId();
  await world.api.mutate("tasks.reopen", { taskId, clientMessageId: id, ...(text === null ? {} : { text }) });
  return id;
};

export const taskRow = (world: World, taskId: TaskId) =>
  world.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { state: true, stoppedReason: true, spentMicroUsd: true } });

/** Waits until the task is in one of `states`. */
export const waitForState = async (world: World, taskId: TaskId, states: readonly string[], timeoutMs: number): Promise<string> =>
  waitUntil(`task ${taskId} in ${states.join(" or ")}`, timeoutMs, async () => {
    const row = await taskRow(world, taskId);
    return states.includes(row.state) ? row.state : null;
  });

/** The task's PR, once core opened it. */
export const waitForPr = async (world: World, taskId: TaskId, timeoutMs = 180_000): Promise<{ readonly number: number; readonly url: string }> =>
  waitUntil(`the PR of ${taskId}`, timeoutMs, async () => {
    const repo = await world.db.taskRepo.findFirst({ where: { taskId, prNumber: { not: null } }, select: { prNumber: true, prUrl: true } });
    return repo?.prNumber === null || repo === null ? null : { number: repo.prNumber, url: repo.prUrl ?? "" };
  });

export const sessionsOf = (world: World, taskId: TaskId) =>
  world.db.session.findMany({ where: { taskId }, orderBy: [{ startedAt: "asc" }, { id: "asc" }], select: { id: true, state: true, origin: true, boxId: true, archiveBlobId: true, limitReached: true, startedAt: true, endedAt: true } });

/** Waits until the task's newest session is in one of `states`. */
export const waitForSession = async (world: World, taskId: TaskId, states: readonly string[], timeoutMs: number, minSessions = 1) =>
  waitUntil(`a session of ${taskId} in ${states.join(" or ")}`, timeoutMs, async () => {
    const sessions = await sessionsOf(world, taskId);
    const last = sessions.at(-1);
    return sessions.length >= minSessions && last !== undefined && states.includes(last.state) ? last : null;
  });

/** Waits until the task's newest session has stored a `kind` event (`count` of them). */
export const waitForEvent = async (world: World, taskId: TaskId, kind: string, timeoutMs: number, count = 1): Promise<void> => {
  await waitUntil(`${String(count)} ${kind} of ${taskId}`, timeoutMs, async () => ((await world.db.event.count({ where: { taskId, kind } })) >= count ? true : null));
};

/** Whether `file` is on the task's branch on GitHub: the agent's commit was pushed. */
export const fileOnBranch = async (world: World, branch: string, file: string): Promise<boolean> =>
  world.github.octokit.rest.repos.getContent({ owner: world.github.owner, repo: world.github.repo, path: file, ref: branch }).then(
    () => true,
    () => false,
  );

export const waitForFileOnBranch = async (world: World, branch: string, file: string, timeoutMs: number): Promise<void> => {
  await waitUntil(`${file} on ${branch}`, timeoutMs, async () => ((await fileOnBranch(world, branch, file)) ? true : null), 3000);
};

/** The hidden ref's commit, or `null`. */
export const hiddenRef = async (world: World, taskId: TaskId): Promise<string | null> =>
  world.github.octokit.rest.git.getRef({ owner: world.github.owner, repo: world.github.repo, ref: `ostra/wip/${taskId}` }).then(
    (response) => response.data.object.sha,
    () => null,
  );

export const branchExists = async (world: World, branch: string): Promise<boolean> =>
  world.github.octokit.rest.git.getRef({ owner: world.github.owner, repo: world.github.repo, ref: `heads/${branch}` }).then(
    () => true,
    () => false,
  );

/** A file name of the case's own, so nothing an earlier run merged can be there already. */
export const caseFile = (caseName: string, turn: number): string => `failure-suite/${caseName}-${randomBytes(2).toString("hex")}-${String(turn)}.md`;
