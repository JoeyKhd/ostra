import type { Logger } from "@ostra/adapter-sdk";
import { mapTask, sessionLimitToDb } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { boxIdSchema, leaseEpochSchema, organizationIdSchema, projectIdSchema, runnerIdSchema, runnerLimits } from "@ostra/protocol";
import type { BoxId, OrganizationId, SessionId, SessionLimit, TaskEventOf, TaskId, TaskSeq } from "@ostra/protocol";

import type { JobName, JobPayload } from "../jobs.ts";
import { transitionBox } from "../lifecycles/box.ts";
import type { BoxInput, BoxLifecycle } from "../lifecycles/box.ts";
import { boxFromColumns, boxToColumns, taskRepoFromColumns, taskRepoToColumns } from "../lifecycles/mapping.ts";
import { transitionTaskRepo } from "../lifecycles/task-repo.ts";
import { limitReason } from "../lifecycles/task.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import { moveSessionInTx, moveTaskInTx } from "./moves.ts";
import { lastAgentMessageInTx } from "./record-session-end.ts";
import { appendCoreEvent } from "./server-events.ts";

// A session that lives across turns (F-096, F-068; spec section 4, "After every turn" and "The idle
// timer"). Both run in the ingest transaction of the event that caused them.

// ---------- the timers a session and its box carry (tickets 17, 19, 20) ----------

/**
 * The delayed jobs a session and its box carry (ADR 0037's timer shape): one per subject, keyed by
 * it, sent in the transaction that starts it and cancelled in the one that ends it. Each job also
 * re-reads its subject when it wakes and does nothing if it moved on, so a missed cancel is
 * harmless. Optional where it's taken: without it no timer is sent (a caller from milestone 1).
 */
export type SessionTimers = {
  /** `OSTRA_SESSION_MAX_MINUTES`, in ms (F-068). */
  readonly sessionMaxMs: number;
  /** `OSTRA_BOX_RELEASE_IDLE_DAYS`, in ms (F-079). */
  readonly boxReleaseIdleMs: number;
  /** The queue's cancel of the job under this payload's key. */
  readonly cancelInTx: <N extends JobName>(tx: Tx, job: N, payload: JobPayload<N>) => Promise<boolean>;
};

type TimerDeps = Pick<Ports, "jobs"> & { readonly timers?: SessionTimers | undefined };
type CancelDeps = { readonly timers?: SessionTimers | undefined };

/** A session, by the IDs its timer's key and payload take. */
export type SessionRef = { readonly organizationId: OrganizationId; readonly taskId: TaskId; readonly sessionId: SessionId };

/** A session started: its maximum duration starts counting (F-068, ticket 19). */
export const startSessionTimersInTx = async (deps: TimerDeps, tx: Tx, session: SessionRef): Promise<void> => {
  if (deps.timers === undefined) {
    return;
  }
  await deps.jobs.enqueueInTx(tx, "session.max-duration", session, { startAfterMs: deps.timers.sessionMaxMs });
};

/** A session ended, stopped or crashed: its timer goes. */
export const endSessionTimersInTx = async (deps: CancelDeps, tx: Tx, session: SessionRef): Promise<void> => {
  await deps.timers?.cancelInTx(tx, "session.max-duration", session);
};

/** A box, by the IDs its timer's key and payload take. */
export type BoxRef = { readonly organizationId: OrganizationId; readonly taskId: TaskId; readonly boxId: BoxId };

/** A box went idle or stopped: it's released after the idle days unless a turn starts in it (F-079, ticket 20). */
export const startBoxIdleTimerInTx = async (deps: TimerDeps, tx: Tx, box: BoxRef): Promise<void> => {
  if (deps.timers === undefined) {
    return;
  }
  await deps.jobs.enqueueInTx(tx, "box.release-after-idle", box, { startAfterMs: deps.timers.boxReleaseIdleMs });
};

/** A turn started in the box: its idle timer goes. */
export const cancelBoxIdleTimerInTx = async (deps: CancelDeps, tx: Tx, box: BoxRef): Promise<void> => {
  await deps.timers?.cancelInTx(tx, "box.release-after-idle", box);
};

// ---------- the box's states (F-096) ----------

/**
 * Moves a box by its lifecycle, one input after another; an input the box can't take is skipped.
 * `readyAt`, `idleSince`, `stoppedAt` and `releasedAt` follow the state. Returns where it ends, or
 * `null` when there's no such box.
 */
export const moveBoxInTx = async (tx: Tx, boxId: string, inputs: readonly BoxInput[], at: Date): Promise<BoxLifecycle["state"] | null> => {
  const row = await tx.box.findUnique({ where: { id: boxId }, select: { state: true, failedReason: true, releaseReason: true } });
  if (row === null) {
    return null;
  }
  const decoded = boxFromColumns(row);
  if (!decoded.ok) {
    return row.state;
  }
  let box = decoded.value;
  for (const input of inputs) {
    const moved = transitionBox(box, input);
    if (moved.ok) {
      box = moved.state;
    }
  }
  if (box.state === row.state) {
    return row.state;
  }
  await tx.box.update({
    where: { id: boxId },
    data: {
      ...boxToColumns(box),
      ...(box.state === "ready" ? { readyAt: at, idleSince: null } : {}),
      ...(box.state === "idle" ? { idleSince: at } : {}),
      ...(box.state === "stopped" ? { stoppedAt: at } : {}),
      ...(box.state === "released" ? { releasedAt: at } : {}),
    },
  });
  return box.state;
};

/** A turn started in the box: a new box is ready, an idle or a kept stopped one is in use again. */
export const markBoxBusyInTx = (tx: Tx, boxId: string, at: Date): Promise<BoxLifecycle["state"] | null> =>
  moveBoxInTx(tx, boxId, [{ type: "created" }, { type: "prepared" }, { type: "turn_started" }], at);

// ---------- after every turn (ticket 17) ----------

export type RecordWorkSavedInput = {
  readonly organizationId: OrganizationId;
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  /** The stored `session.saved` and its task seq, which keys the PR job. */
  readonly event: TaskEventOf<"session.saved">;
  readonly eventSeq: TaskSeq;
};

export type RecordWorkSavedResult = UseCaseResult<
  {
    /** What the task did: to review (the first PR, or the same ones updated), needs you, or nothing new. */
    readonly outcome: "in-review" | "needs-you" | "unchanged";
  },
  "not-found" | "stale"
>;

export type RecordWorkSavedDeps = Pick<Ports, "jobs" | "notices" | "clock"> & {
  readonly tx: Tx;
  readonly timers?: SessionTimers | undefined;
  readonly logger?: Logger | undefined;
};

/**
 * Saves each repo's head and hidden ref, and the session's archive; moves the task by `work_saved`;
 * enqueues `task.open-pull-requests` (idempotent per task repo) when a branch is ahead, or raises
 * F-065's needs-you item when nothing changed and no PR is open. The session goes idle.
 */
export type RecordWorkSaved = (deps: RecordWorkSavedDeps, input: RecordWorkSavedInput) => Promise<RecordWorkSavedResult>;

/** The review rounds before a reviewer: both off until milestone 6 (spec section 4). */
const M2_ROUNDS = { ci: false, aiReview: false } as const;

export const recordWorkSaved: RecordWorkSaved = async (deps, input) => {
  const { tx } = deps;
  const row = await tx.task.findFirst({ where: { id: input.taskId, organizationId: input.organizationId } });
  if (row === null) {
    return { ok: false, error: "not-found", message: "no such task" };
  }
  const task = mapTask(row);
  const session = await tx.session.findFirst({ where: { id: input.sessionId, taskId: task.id } });
  if (session === null) {
    return { ok: false, error: "not-found", message: "no such session of the task" };
  }
  const moveDeps = { tx, notices: deps.notices, ...(deps.logger === undefined ? {} : { logger: deps.logger }) };
  const at = new Date(deps.clock.now());

  // Each repo: its head, whether it's ahead, and the hidden ref with the head it was saved on.
  for (const saved of input.event.repos) {
    const taskRepo = await tx.taskRepo.findFirst({ where: { taskId: task.id, repoId: saved.repoId } });
    if (taskRepo === null) {
      continue;
    }
    const state = taskRepoFromColumns(taskRepo);
    const pushed = saved.ahead && saved.headSha !== null && state.ok ? transitionTaskRepo(state.value, { type: "pushed" }) : null;
    // The base is the branch's head the hidden ref sits on; with no head there's nothing to restore it onto.
    const base = saved.headSha ?? taskRepo.headSha;
    await tx.taskRepo.update({
      where: { id: taskRepo.id },
      data: {
        ahead: saved.ahead,
        ...(saved.headSha === null ? {} : { headSha: saved.headSha }),
        ...(saved.hiddenRefSha === null || base === null ? {} : { hiddenRefSha: saved.hiddenRefSha, hiddenRefBaseSha: base }),
        ...(pushed?.ok === true ? { state: taskRepoToColumns(pushed.state).state } : {}),
      },
    });
    // F-072: a head newer than the one a comment was written on is compared, so the comments whose
    // line changed show as outdated (ticket 22). No comments, no call: the diff is fetched when read.
    if (saved.headSha !== null) {
      const older = await tx.diffComment.findFirst({
        where: { taskRepoId: taskRepo.id, state: { in: ["draft", "sent"] }, outdatedAt: null, headSha: { not: saved.headSha } },
        select: { id: true },
      });
      if (older !== null) {
        await deps.jobs.enqueueInTx(tx, "diff.fetch", { organizationId: input.organizationId, taskId: task.id, repoId: saved.repoId, baseSha: null, headSha: saved.headSha });
      }
    }
  }
  // The archive: a failed export or upload (`null`) keeps the last good one (ADR 0039).
  if (input.event.archive !== null) {
    await tx.session.update({
      where: { id: session.id },
      data: { archiveBlobId: input.event.archive.blobId, archiveTurnOrdinal: input.event.turnOrdinal },
    });
  }
  // The turn is over: the session is idle, and its box stays warm.
  if (session.state === "running" || session.state === "waiting") {
    await moveSessionInTx(moveDeps, session, { type: "turn_ended" });
  }
  if (session.boxId !== null) {
    const boxState = await moveBoxInTx(tx, session.boxId, [{ type: "turn_ended" }], at);
    if (boxState === "idle") {
      await startBoxIdleTimerInTx(deps, tx, { organizationId: input.organizationId, taskId: task.id, boxId: boxIdSchema.parse(session.boxId) });
    }
  }

  const repos = await tx.taskRepo.findMany({ where: { taskId: task.id } });
  const withChanges = repos.some((repo) => repo.ahead === true);
  const prOpen = repos.some((repo) => repo.state === "pr_open");
  const needsPullRequest = repos.some((repo) => repo.ahead === true && repo.state === "branch_pushed");
  const organizationId = organizationIdSchema.parse(task.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);

  if (needsPullRequest) {
    // A branch ahead with no PR: the opener, idempotent per task repo, moves the task to review.
    await deps.jobs.enqueueInTx(tx, "task.open-pull-requests", {
      organizationId,
      taskId: task.id,
      sessionId: input.sessionId,
      eventSeq: input.eventSeq,
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
    return { ok: true, outcome: "in-review" };
  }
  if (withChanges || prOpen) {
    // The push already updated the open PRs: the task is (still) in review.
    const moved = await moveTaskInTx(moveDeps, task, { type: "work_saved", withChanges, prOpen, rounds: M2_ROUNDS });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
    return { ok: true, outcome: moved || task.state === "in_review" ? "in-review" : "unchanged" };
  }
  // F-065: nothing changed and no PR. The driver hears it, with what the agent said.
  const moved = await moveTaskInTx(moveDeps, task, { type: "work_saved", withChanges: false, prOpen: false, rounds: M2_ROUNDS });
  if (!moved) {
    return { ok: true, outcome: "unchanged" };
  }
  await tx.needsYouItem.create({
    data: {
      organizationId,
      projectId,
      taskId: task.id,
      reason: "no_changes",
      audience: "driver",
      summary: await lastAgentMessageInTx(tx, task.id, input.sessionId),
    },
  });
  return { ok: true, outcome: "needs-you" };
};

// ---------- runaway protection (ticket 19) ----------

export type RecordLimitReachedInput = {
  readonly organizationId: OrganizationId;
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly limit: SessionLimit;
  /** Minutes, micro-USD or tokens. */
  readonly observed: number;
  /** The runner sent it (the spend cap) or core times it (the maximum duration, the stall). */
  readonly by: "runner" | "core";
};

export type RecordLimitReachedResult = UseCaseResult<
  { readonly stopped: boolean },
  "not-found" | "not-running"
>;

export type RecordLimitReachedDeps = Pick<Ports, "outbox" | "jobs" | "notices" | "clock"> & {
  readonly tx: Tx;
  readonly timers?: SessionTimers | undefined;
  readonly logger?: Logger | undefined;
};

/** The needs-you item's words for a limit: the limit and the number, never content. */
export const limitSummary = (limit: SessionLimit, observed: number): string => {
  switch (limit) {
    case "max-duration":
      return `The session ran for ${String(Math.round(observed))} minutes, the longest a session may run, so ostra stopped it.`;
    case "stall":
      return `The agent sent nothing for ${String(Math.round(observed))} minutes, so ostra stopped the session.`;
    case "spend-cap":
      return "The task reached its spend cap, so ostra stopped the session. A reopen waits until the cap is raised.";
    default:
      return limit satisfies never;
  }
};

const ACTIVE_SESSION_STATES: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

/**
 * Stops the session (`limitReached` on its row; a core-timed limit also records its own
 * `session.limit_reached` event and sends `stop` with the reason), moves the task by
 * `limit_reached`, and raises its needs-you item for the driver (`stalled` or `spend_cap`).
 */
export type RecordLimitReached = (deps: RecordLimitReachedDeps, input: RecordLimitReachedInput) => Promise<RecordLimitReachedResult>;

export const recordLimitReached: RecordLimitReached = async (deps, input) => {
  const { tx } = deps;
  // The same lock strength as ingest's, which may hold it already in this transaction (no upgrade).
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT 1 FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${input.organizationId} FOR NO KEY UPDATE`;
  if (locked.length === 0) {
    return { ok: false, error: "not-found", message: "no such task" };
  }
  const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.taskId } }));
  const session = await tx.session.findFirst({ where: { id: input.sessionId, taskId: task.id } });
  if (session === null) {
    return { ok: false, error: "not-found", message: "no such session of the task" };
  }
  if (!ACTIVE_SESSION_STATES.has(session.state)) {
    return { ok: false, error: "not-running", message: "the session already ended" };
  }
  const now = deps.clock.now();
  const organizationId = organizationIdSchema.parse(task.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  const moveDeps = { tx, notices: deps.notices, ...(deps.logger === undefined ? {} : { logger: deps.logger }) };

  // A limit core times is its own event: the runner never saw it (ADR 0037).
  if (input.by === "core") {
    await appendCoreEvent(tx, {
      organizationId,
      projectId,
      taskId: task.id,
      sessionId: input.sessionId,
      event: { kind: "session.limit_reached", limit: input.limit, observed: input.observed },
      at: now,
    });
  }
  await tx.session.update({ where: { id: session.id }, data: { limitReached: sessionLimitToDb[input.limit] } });
  await moveSessionInTx(moveDeps, session, { type: "limit_reached" });
  await endSessionTimersInTx(deps, tx, { organizationId, taskId: task.id, sessionId: input.sessionId });

  // The runner ends the agent, and pushes the branch and the hidden ref (ADR 0039).
  const lease = await tx.lease.findFirst({ where: { taskId: task.id, state: "active" }, select: { runnerId: true, epoch: true } });
  if (lease !== null) {
    await deps.outbox.enqueueInTx(tx, organizationId, runnerIdSchema.parse(lease.runnerId), {
      kind: "stop",
      body: {
        taskId: task.id,
        sessionId: input.sessionId,
        leaseEpoch: leaseEpochSchema.parse(lease.epoch),
        reason: input.limit === "spend-cap" ? "spend-cap" : "runaway",
      },
      notAfter: now + runnerLimits.graceMs,
      task: { taskId: task.id, projectId },
    });
  }

  // The task needs its driver: stalled (the stall, the maximum duration) or the spend cap.
  const moved = await moveTaskInTx(moveDeps, task, { type: "limit_reached", limit: input.limit });
  if (moved) {
    await tx.needsYouItem.create({
      data: {
        organizationId,
        projectId,
        taskId: task.id,
        reason: limitReason(input.limit),
        audience: "driver",
        summary: limitSummary(input.limit, input.observed),
      },
    });
  }
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
  deps.logger?.info("session.limit-reached", { taskId: task.id, sessionId: input.sessionId, limit: input.limit, by: input.by, taskMoved: moved });
  return { ok: true, stopped: true };
};
