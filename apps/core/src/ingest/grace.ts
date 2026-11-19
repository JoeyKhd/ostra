import type { Logger } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import type { Db, Task, Tx } from "@ostra/db";
import { appendServerEvent, endSessionTimersInTx, moveSessionInTx, moveTaskInTx } from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock, CommandOutbox, JobPayload, SessionTimers } from "@ostra/domain";
import type { JobContext, Jobs } from "@ostra/jobs";
import { onCurrentTask } from "@ostra/jobs";
import { leaseEpochSchema, organizationIdSchema, projectIdSchema, runnerIdSchema, runnerLimits, sessionIdSchema, taskIdSchema } from "@ostra/protocol";

import type { RunnerRef, SidecarLease } from "../gateway/context.ts";

// The task grace (ADR 0034, F-045): when a runner's connection goes, each task it holds a lease of
// gets a delayed `task.grace` job at 10 minutes. A reconnect before then cancels it. When it fires
// and the runner is still gone, the lease ends, the epoch goes up (so the runner's late writes are
// refused), and the task stops cleanly: stopped, ready to reopen in milestone 2. The runner learns
// it from a `stop` command when it comes back. Ported from spikes/runner-transport's `graceSweep`,
// moved onto the queue (ADR 0037).
//
// A `docker` or `kubernetes` box's task is its sidecar's (Q129, ticket 41): its grace starts when
// the sidecar's connection goes, and a reconnect of the sidecar cancels it. The runner's own
// connection doesn't touch it, so a pool runner that stops or upgrades doesn't interrupt its boxes.
//
// Milestone 2 (ticket 17): a task in review whose idle box's runner went away keeps its state. Its
// work already left the box after its last turn (the branch, the hidden ref, the archive), so only
// the lease, the session and the box go; a reopen carries on from what was saved, on a fresh box
// if the old one doesn't come back. A task that was working stops with `runner_lost` as before.

export type GraceDeps = {
  readonly jobs: Jobs;
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly graceMs?: number;
  /** Milestone 2: the session's timers, cancelled when the grace ends it (ticket 19). */
  readonly timers?: SessionTimers;
};

/** The runner's active leases on `host`: the ones whose grace its own connection holds. */
const activeLeases = (tx: Tx, runner: RunnerRef) =>
  tx.lease.findMany({
    where: { runnerId: runner.runnerId, organizationId: runner.organizationId, state: "active", box: { executor: "host" } },
    select: { taskId: true, epoch: true, organizationId: true, projectId: true },
  });

/** A sidecar's lease, while it's still active: the one task whose grace its connection holds. */
const sidecarLease = (tx: Tx, lease: SidecarLease) =>
  tx.lease.findMany({
    where: {
      taskId: lease.taskId,
      organizationId: lease.organizationId,
      epoch: lease.leaseEpoch,
      boxId: lease.boxId,
      runnerId: lease.runnerId,
      state: "active",
    },
    select: { taskId: true, epoch: true, organizationId: true, projectId: true },
  });

type GraceLease = Awaited<ReturnType<typeof activeLeases>>[number];

const activeSession = (tx: Tx, taskId: string) =>
  tx.session.findFirst({ where: { taskId, state: { in: ["starting", "running", "waiting", "idle"] } }, orderBy: { startedAt: "desc" } });

/** Starts the grace of every task the runner holds on `host`, and says so on each task's page. */
export const startGraceInTx = async (deps: GraceDeps, tx: Tx, runner: RunnerRef): Promise<void> => {
  await startGraceOf(deps, tx, runner, await activeLeases(tx, runner));
};

/** Starts the grace of a box's task when its sidecar's connection goes (F-045). */
export const startSidecarGraceInTx = async (deps: GraceDeps, tx: Tx, lease: SidecarLease): Promise<void> => {
  await startGraceOf(deps, tx, { runnerId: lease.runnerId, organizationId: lease.organizationId }, await sidecarLease(tx, lease));
};

/** Cancels the grace of a box's task when its sidecar comes back. */
export const cancelSidecarGraceInTx = async (deps: GraceDeps, tx: Tx, lease: SidecarLease): Promise<void> => {
  await cancelGraceOf(deps, tx, { runnerId: lease.runnerId, organizationId: lease.organizationId }, await sidecarLease(tx, lease));
};

const startGraceOf = async (deps: GraceDeps, tx: Tx, runner: RunnerRef, leases: readonly GraceLease[]): Promise<void> => {
  for (const lease of leases) {
    const payload: JobPayload<"task.grace"> = {
      organizationId: organizationIdSchema.parse(lease.organizationId),
      taskId: taskIdSchema.parse(lease.taskId),
      leaseEpoch: leaseEpochSchema.parse(lease.epoch),
    };
    await deps.jobs.enqueueInTx(tx, "task.grace", payload, { startAfterMs: deps.graceMs ?? runnerLimits.graceMs });
    const session = await activeSession(tx, lease.taskId);
    if (session !== null) {
      await appendServerEvent(tx, {
        organizationId: payload.organizationId,
        projectId: projectIdSchema.parse(lease.projectId),
        taskId: payload.taskId,
        sessionId: sessionIdSchema.parse(session.id),
        event: { kind: "runner.lost", runnerId: runner.runnerId },
        at: deps.clock.now(),
      });
    }
  }
};

/** Cancels the grace of every task the runner holds on `host`; a task whose grace was running hears it's back. */
export const cancelGraceInTx = async (deps: GraceDeps, tx: Tx, runner: RunnerRef): Promise<void> => {
  await cancelGraceOf(deps, tx, runner, await activeLeases(tx, runner));
};

const cancelGraceOf = async (deps: GraceDeps, tx: Tx, runner: RunnerRef, leases: readonly GraceLease[]): Promise<void> => {
  for (const lease of leases) {
    const payload: JobPayload<"task.grace"> = {
      organizationId: organizationIdSchema.parse(lease.organizationId),
      taskId: taskIdSchema.parse(lease.taskId),
      leaseEpoch: leaseEpochSchema.parse(lease.epoch),
    };
    if (!(await deps.jobs.cancelInTx(tx, "task.grace", payload))) {
      continue;
    }
    const session = await activeSession(tx, lease.taskId);
    if (session !== null) {
      await appendServerEvent(tx, {
        organizationId: payload.organizationId,
        projectId: projectIdSchema.parse(lease.projectId),
        taskId: payload.taskId,
        sessionId: sessionIdSchema.parse(session.id),
        event: { kind: "runner.connected", runnerId: runner.runnerId },
        at: deps.clock.now(),
      });
    }
  }
};

export type GraceOutcome = "stopped" | "runner-back" | "lease-ended";

/**
 * The grace's end, for a task whose row the caller holds `FOR UPDATE`: if the runner is still
 * gone, end the lease, raise the epoch, stop the task and send the `stop` command.
 */
export const endGraceInTx = async (
  deps: GraceDeps,
  tx: Tx,
  task: Task,
  payload: JobPayload<"task.grace">,
): Promise<GraceOutcome> => {
  const lease = await tx.lease.findFirst({ where: { taskId: task.id, epoch: payload.leaseEpoch, state: "active" } });
  if (lease === null) {
    return "lease-ended";
  }
  const box = await tx.box.findUnique({ where: { id: lease.boxId }, select: { executor: true, sidecarConnectionEpoch: true, sidecarDisconnectedAt: true } });
  if (box !== null && box.executor !== "host") {
    // A box's task is its sidecar's: it came back and the cancel was missed.
    if (box.sidecarConnectionEpoch > 0 && box.sidecarDisconnectedAt === null) {
      return "runner-back";
    }
  } else {
    const presence = await tx.runnerPresence.findUnique({ where: { runnerId: lease.runnerId } });
    if (presence !== null && presence.disconnectedAt === null) {
      // It came back and the cancel was missed: nothing to do.
      return "runner-back";
    }
  }
  const at = new Date(deps.clock.now());
  await tx.lease.update({ where: { id: lease.id }, data: { state: "ended", endedAt: at, endReason: "grace-expired" } });
  // The fence: from here on, a write carrying the old epoch is refused (F-045).
  await tx.task.update({ where: { id: task.id }, data: { leaseEpoch: { increment: 1 } } });
  const moveDeps = { tx, notices: deps.notices, logger: deps.logger };
  // A task whose work already left its box (in review, merged, done) isn't stopped by losing it.
  const keepsState = task.state === "in_review" || task.state === "merged" || task.state === "done";
  if (!keepsState) {
    await moveTaskInTx(moveDeps, mapTask(task), { type: "stop", reason: "runner_lost" });
  }
  const session = await activeSession(tx, task.id);
  if (session !== null) {
    await moveSessionInTx(moveDeps, session, { type: "stop" });
    await endSessionTimersInTx(deps, tx, {
      organizationId: organizationIdSchema.parse(task.organizationId),
      taskId: payload.taskId,
      sessionId: sessionIdSchema.parse(session.id),
    });
  }
  await tx.box.updateMany({ where: { id: lease.boxId, state: { in: ["ready", "idle"] } }, data: { state: "stopped", stoppedAt: at, idleSince: null } });
  await tx.box.updateMany({
    where: { id: lease.boxId, state: { in: ["creating", "preparing"] } },
    data: { state: "failed", failedReason: "the runner was gone for the whole grace" },
  });
  const organizationId = organizationIdSchema.parse(task.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  if (session !== null) {
    // The runner learns it when it comes back, and ends what it still runs.
    await deps.outbox.enqueueInTx(tx, organizationId, runnerIdSchema.parse(lease.runnerId), {
      kind: "stop",
      body: { taskId: payload.taskId, sessionId: sessionIdSchema.parse(session.id), leaseEpoch: payload.leaseEpoch, reason: "grace-expired" },
      notAfter: deps.clock.now() + 7 * 24 * 3_600_000,
      task: { taskId: payload.taskId, projectId },
    });
  }
  if (keepsState) {
    return "stopped";
  }
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId,
    actor: { kind: "system", id: null },
    action: "task.stopped",
    entity: "task",
    entityId: payload.taskId,
    data: { reason: "runner_lost", leaseEpoch: payload.leaseEpoch },
  });
  return "stopped";
};

/** The `task.grace` worker (ADR 0037, rule 1: it re-reads the task first). */
export const graceHandler = (db: Db, deps: GraceDeps, onOutcome?: (outcome: GraceOutcome, context: JobContext<"task.grace">) => void) =>
  onCurrentTask<"task.grace">(db, {
    isCurrent: (task, payload) => task.leaseEpoch === payload.leaseEpoch,
    act: async (tx, task, context) => {
      const outcome = await endGraceInTx(deps, tx, task, context.payload);
      context.logger.info("task.grace-ended", { taskId: task.id, outcome });
      onOutcome?.(outcome, context);
    },
  });
