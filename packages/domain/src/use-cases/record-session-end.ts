import type { Logger } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { organizationIdSchema, projectIdSchema, runnerIdSchema, taskEventSchema } from "@ostra/protocol";
import type { SessionId, TaskId, TaskKind } from "@ostra/protocol";
import { boxIdSchema } from "@ostra/protocol";

import type { JobPayload } from "../jobs.ts";
import { boxOutlivesItsSession } from "../lifecycles/box.ts";
import { taskRepoFromColumns, taskRepoToColumns } from "../lifecycles/mapping.ts";
import { transitionTaskRepo } from "../lifecycles/task-repo.ts";
import type { Ports } from "../ports.ts";
import { enqueueRunnerAdmissionInTx } from "./admission.ts";
import type { UseCaseResult } from "./common.ts";
import { moveSessionInTx, moveTaskInTx } from "./moves.ts";
import { createNeedsYouItemInTx } from "./needs-you-items.ts";
import { cancelBoxIdleTimerInTx, endSessionTimersInTx, startBoxIdleTimerInTx } from "./sessions-m2.ts";
import type { SessionTimers } from "./sessions-m2.ts";

// F-030, F-065: the `task.session-ended` job, reacting to a stored `session.ended`. The session ends
// with or without changes, its box is released, and its lease ends. With changes: each task repo
// that is ahead records its branch, and a `task.open-pull-requests` job follows; the task moves to
// in review once its PRs are open. Without: the task goes to needs you with the agent's last message
// as the summary, and no PR is opened. Written by ticket 27.
//
// A task a member stopped ends its session too (the runner pushes what's there, then sends
// `session.ended`): its branch and hidden ref stay on GitHub, and no PR and no needs-you item follow.
//
// Protocol minor 1 (milestone 2, ticket 17): a session spans turns, and each turn's work left the box
// with its `session.saved`, whose reaction opened the PRs or raised needs you. Its `session.ended`
// only says the idle timer stopped the box: the session ends, the lease ends and the box stops, and
// nothing else. A `host` worktree is kept until its release; a `docker` or `kubernetes` box goes with
// its session (Q343). A session with no `session.saved` (a minor-0 runner's, or
// one that never finished a turn) keeps milestone 1's meaning.

export type RecordSessionEndInput = JobPayload<"task.session-ended">;

export type RecordSessionEndResult = UseCaseResult<
  { readonly outcome: "with-changes" | "without-changes" },
  /** The event isn't the session's end, or the task moved on. */
  "stale" | "not-found"
>;

export type RecordSessionEndDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly logger?: Logger;
  /** Milestone 2: the session's and the box's timers (tickets 19, 20). */
  readonly timers?: SessionTimers;
};

export type RecordSessionEnd = (deps: RecordSessionEndDeps, input: RecordSessionEndInput) => Promise<RecordSessionEndResult>;

/** The review rounds before a reviewer: both off until milestone 6 (spec section 4). */
const M1_ROUNDS = { ci: false, aiReview: false } as const;

/**
 * Whether a kind's session leaves work in its repos (milestone 6, Q221): a code task's branch, yes;
 * a refine or a review task's box is read-only, so its session never ends with changes and has no
 * PR outcome, whatever its repos say (milestone 10, F-151, the targets' content fix 5).
 */
export const savesWork = (kind: TaskKind): boolean => {
  switch (kind) {
    case "code":
      return true;
    case "refine":
    case "review":
      return false;
    default:
      return kind satisfies never;
  }
};

/** The agent's last complete message of the session: the needs-you item's summary, and a PR body's fallback. */
export const lastAgentMessageInTx = async (tx: Tx, taskId: TaskId, sessionId: SessionId): Promise<string | null> => {
  // Milestone 3 (F-063): a plan turn's last message is the plan as proposed, never what the work did,
  // so it never stands in for the PR's description.
  const planTurns = await tx.event.findMany({ where: { taskId, sessionId, kind: "turn.started", payload: { path: ["mode"], equals: "plan" } }, select: { payload: true } });
  const planTurnIds = planTurns.flatMap((started) => {
    const parsed = taskEventSchema.safeParse(started.payload);
    return parsed.success && parsed.data.kind === "turn.started" ? [parsed.data.turnId] : [];
  });
  const rows = await tx.event.findMany({ where: { taskId, sessionId, kind: "agent.message" }, orderBy: { seq: "desc" }, take: 200, select: { payload: true } });
  for (const row of rows) {
    const parsed = taskEventSchema.safeParse(row.payload);
    // F-138: a subagent's answer is its own, never the agent's last word.
    if (parsed.success && parsed.data.kind === "agent.message" && parsed.data.subagentId === undefined && !planTurnIds.includes(parsed.data.turnId)) {
      return parsed.data.text;
    }
  }
  return null;
};

/**
 * Ends the task's active lease and stops its box: the session is over (milestone 1: one turn). A
 * `docker` or `kubernetes` box goes with its session (its sidecar exits, and its runner removes it),
 * so it's recorded released at once, with no `release` to send; a `host` worktree stays, stopped,
 * until its release (ADR 0039, amended 2026-11-22, Q343).
 */
export const releaseLeaseInTx = async (tx: Tx, taskId: TaskId, at: Date, reason: "released", ports?: Pick<Ports, "jobs">): Promise<void> => {
  const lease = await tx.lease.findFirst({ where: { taskId, state: "active" } });
  if (lease === null) {
    return;
  }
  await tx.lease.update({ where: { id: lease.id }, data: { state: "ended", endedAt: at, endReason: reason } });
  const box = await tx.box.findUnique({ where: { id: lease.boxId }, select: { executor: true } });
  const gone = box !== null && !boxOutlivesItsSession(box.executor);
  await tx.box.updateMany({
    where: { id: lease.boxId, state: { in: ["ready", "idle"] } },
    data: gone ? { state: "released", releaseReason: "session_ended", stoppedAt: at, releasedAt: at, idleSince: null } : { state: "stopped", stoppedAt: at, idleSince: null },
  });
  await tx.box.updateMany({ where: { id: lease.boxId, state: { in: ["creating", "preparing"] } }, data: { state: "failed", failedReason: "the session ended before the box was ready" } });
  // Milestone 5 (F-067): the box's slot is free, so its runner's pool admits the next task.
  if (ports !== undefined) {
    await enqueueRunnerAdmissionInTx(ports, tx, organizationIdSchema.parse(lease.organizationId), runnerIdSchema.parse(lease.runnerId));
  }
};

export const recordSessionEnd: RecordSessionEnd = async (deps, input) => {
  const { tx } = deps;
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT 1 FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${input.organizationId} FOR UPDATE`;
  if (locked.length === 0) {
    return { ok: false, error: "not-found", message: "no such task" };
  }
  const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.taskId } }));
  const stored = await tx.event.findUnique({ where: { taskId_seq: { taskId: task.id, seq: input.eventSeq } } });
  const event = stored === null ? null : taskEventSchema.safeParse(stored.payload);
  if (stored?.sessionId !== input.sessionId || event?.success !== true || event.data.kind !== "session.ended") {
    return { ok: false, error: "stale", message: "the event isn't this session's end" };
  }
  const ended = event.data;
  const session = await tx.session.findUniqueOrThrow({ where: { id: input.sessionId } });
  const moveDeps = { tx, notices: deps.notices, jobs: deps.jobs, ...(deps.logger === undefined ? {} : { logger: deps.logger }) };
  const readOnly = !savesWork(task.kind);
  const withChanges = !readOnly && ended.repos.some((repo) => repo.ahead);

  // The session: a running one ends its turn first, then the box stops with or without changes.
  if (session.state === "ended" || session.state === "crashed") {
    return { ok: false, error: "stale", message: "the session already ended" };
  }
  if (session.state === "running" || session.state === "waiting") {
    await moveSessionInTx(moveDeps, session, { type: "turn_ended" });
  }
  const current = await tx.session.findUniqueOrThrow({ where: { id: session.id } });
  if (current.state === "idle") {
    await moveSessionInTx(moveDeps, current, { type: "box_stopped", withChanges });
  } else if (current.state !== "stopped") {
    await moveSessionInTx(moveDeps, current, { type: "stop" });
  }
  const at = new Date(deps.clock.now());
  const lease = await tx.lease.findFirst({ where: { taskId: task.id, state: "active" }, select: { boxId: true } });
  await releaseLeaseInTx(tx, task.id, at, "released", deps);
  const sessionRef = { organizationId: input.organizationId, taskId: task.id, sessionId: input.sessionId };
  await endSessionTimersInTx(deps, tx, sessionRef);

  // Minor 1: the turns' work was already saved and acted on. The box stopped: a kept one (`host`)
  // waits for its release, after the idle days unless a PR's merge or close comes first; one that
  // went with its session (`docker`, `kubernetes`) has no idle days left to wait for.
  const saved = await tx.event.findFirst({ where: { taskId: task.id, sessionId: input.sessionId, kind: "session.saved" }, select: { seq: true } });
  if (saved !== null) {
    const boxId = lease?.boxId ?? session.boxId;
    const box = boxId === null ? null : await tx.box.findUnique({ where: { id: boxId }, select: { id: true, state: true } });
    if (box !== null) {
      const boxRef = { organizationId: input.organizationId, taskId: task.id, boxId: boxIdSchema.parse(box.id) };
      if (box.state === "stopped" && lease !== null) {
        await startBoxIdleTimerInTx(deps, tx, boxRef);
      } else if (box.state === "released") {
        await cancelBoxIdleTimerInTx(deps, tx, boxRef);
      }
    }
    await deps.notices.emitInTx(tx, {
      organizationId: organizationIdSchema.parse(task.organizationId),
      projectId: projectIdSchema.parse(task.projectId),
      entity: "task",
      entityId: task.id,
    });
    return { ok: true, outcome: withChanges ? "with-changes" : "without-changes" };
  }

  // Each repo's branch: ahead means pushed, ready for its PR. A read-only kind's are never pushed.
  for (const repo of readOnly ? [] : ended.repos) {
    const row = await tx.taskRepo.findFirst({ where: { taskId: task.id, repoId: repo.repoId } });
    if (row === null) {
      continue;
    }
    const state = taskRepoFromColumns(row);
    const pushed = repo.ahead && state.ok ? transitionTaskRepo(state.value, { type: "pushed" }) : null;
    await tx.taskRepo.update({
      where: { id: row.id },
      data: { ahead: repo.ahead, ...(pushed?.ok === true ? { state: taskRepoToColumns(pushed.state).state } : {}) },
    });
  }

  const organizationId = organizationIdSchema.parse(task.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  if (task.state === "stopped" || readOnly) {
    // Stopped by a member or the grace: the work stays on the branch and the hidden ref. A refine or
    // review task's session end opens no PR and raises no "ended without changes" item: its draft or
    // its review is what it hands in.
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
    return { ok: true, outcome: withChanges ? "with-changes" : "without-changes" };
  }
  if (withChanges) {
    await deps.jobs.enqueueInTx(tx, "task.open-pull-requests", {
      organizationId,
      taskId: task.id,
      sessionId: input.sessionId,
      eventSeq: input.eventSeq,
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
    return { ok: true, outcome: "with-changes" };
  }
  // Q133: files left outside every repo are why the task needs you, and their item is open already.
  const outside = await tx.needsYouItem.findFirst({ where: { taskId: task.id, reason: "files_outside_repos", state: "open" }, select: { id: true } });
  if (outside !== null) {
    await moveTaskInTx(moveDeps, task, { type: "session_ended", withChanges: false, rounds: M1_ROUNDS, filesOutsideRepos: true });
    return { ok: true, outcome: "without-changes" };
  }
  // F-065: no changes, no PR. The driver hears it, with what the agent said.
  const moved = await moveTaskInTx(moveDeps, task, { type: "session_ended", withChanges: false, rounds: M1_ROUNDS });
  if (moved) {
    await createNeedsYouItemInTx(deps, tx, {
      organizationId,
      projectId,
      taskId: task.id,
      reason: "no_changes",
      audience: "driver",
      summary: await lastAgentMessageInTx(tx, task.id, input.sessionId),
    });
  }
  return { ok: true, outcome: "without-changes" };
};
