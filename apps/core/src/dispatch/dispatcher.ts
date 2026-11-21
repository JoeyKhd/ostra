import type { Logger } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { acceptOffer, admitQueued, dispatchTask, dispatchWaitColumns, endAppLeaseInTx, goesToPersonalRunner, projectPoolsInTx, queueTask } from "@ostra/domain";
import type { AgentEffortLevels, ChangeNotices, Clock, CommandOutbox, JobPayload, ReopenDispatchSettings } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { onCurrentTask } from "@ostra/jobs";
import { leaseEpochSchema, organizationIdSchema, projectIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, PoolId, ProjectId, TaskId } from "@ostra/protocol";

import type { AckedCommand, RunnerRef } from "../gateway/context.ts";
import { killPoint } from "../kill-points.ts";

// The dispatcher (ticket 26, ADR 0034): the `task.dispatch` and `task.offer-timeout` workers, the
// runner's answers to offers, and a requeue sweep that sends a fresh dispatch for every queued task
// without an offer out, so a task that found no runner tries again when one is free. Each job is
// keyed by the epoch it grants, so the sweep sending one twice is one job (ADR 0037, rule 2).

export type DispatcherDeps = {
  readonly db: Db;
  readonly jobs: Jobs;
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Milestone 2 (ticket 18): what a reopen's dispatch needs to pick its step. */
  readonly reopen?: ReopenDispatchSettings;
  /** Milestone 4 (F-137): the levels each agent can send for a model, from core's agent registry. */
  readonly effortLevels?: AgentEffortLevels;
  /** Milestone 5: `OSTRA_PERSONAL_RUNNER_CAPACITY` (2 without it). */
  readonly personalSlots?: number;
};

export const dispatchHandler =
  (deps: DispatcherDeps): JobHandler<"task.dispatch"> =>
  async (context) => {
    // Milestone 5 (F-067, ADR 0059): a task for the pools waits in their queues, and their
    // admission grants it in its turn. A task for its member's personal runner goes now, against
    // that runner's slots.
    const queued = await deps.db.$transaction((tx) =>
      queueTask({ tx, jobs: deps.jobs, clock: deps.clock }, { organizationId: context.payload.organizationId, taskId: context.payload.taskId, keepPlace: true }),
    );
    if (queued.ok && queued.poolIds.length > 0) {
      context.logger.info("task.dispatch-queued", { taskId: context.payload.taskId, pools: queued.poolIds.length });
      return;
    }
    const result = await deps.db.$transaction(
      (tx) =>
        dispatchTask(
          {
            tx,
            jobs: deps.jobs,
            outbox: deps.outbox,
            notices: deps.notices,
            clock: deps.clock,
            logger: context.logger,
            ...(deps.reopen === undefined ? {} : { reopen: deps.reopen }),
            ...(deps.effortLevels === undefined ? {} : { effortLevels: deps.effortLevels }),
            ...(deps.personalSlots === undefined ? {} : { personalSlots: deps.personalSlots }),
          },
          context.payload,
        ),
      { timeout: 30_000 },
    );
    if (result.ok) {
      killPoint("dispatch.offered");
    }
    context.logger.info("task.dispatch-done", { taskId: context.payload.taskId, outcome: result.ok ? "offered" : result.error });
  };

/** `queue.admit` (F-067, ticket 13): one pass of a pool's admission. */
export const admitHandler =
  (deps: DispatcherDeps): JobHandler<"queue.admit"> =>
  async (context) => {
    const result = await admitQueued(
      {
        db: deps.db,
        jobs: deps.jobs,
        outbox: deps.outbox,
        notices: deps.notices,
        clock: deps.clock,
        logger: context.logger,
        ...(deps.reopen === undefined ? {} : { reopen: deps.reopen }),
        ...(deps.effortLevels === undefined ? {} : { effortLevels: deps.effortLevels }),
        ...(deps.personalSlots === undefined ? {} : { personalSlots: deps.personalSlots }),
      },
      context.payload,
    );
    if (result.admitted.length > 0) {
      killPoint("dispatch.offered");
    }
  };

const activeSessionOf = (tx: Tx, taskId: TaskId) =>
  tx.session.findFirst({ where: { taskId, state: "starting" }, orderBy: { startedAt: "desc" }, select: { id: true } });

/** An offer not accepted in time goes back to the queue (ADR 0034). */
export const offerTimeoutHandler = (deps: DispatcherDeps): JobHandler<"task.offer-timeout"> =>
  onCurrentTask(deps.db, {
    // Milestone 8 (Q300): an `app` lease's task isn't queued; its offer times out all the same.
    isCurrent: (task, payload) => task.leaseEpoch === payload.leaseEpoch,
    act: async (tx, task, context) => {
      const lease = await tx.lease.findFirst({ where: { taskId: task.id, epoch: context.payload.leaseEpoch, state: "active", acceptedAt: null } });
      if (lease === null) {
        return;
      }
      if (lease.purpose === "app") {
        // No requeue: the member starts the app again.
        await endAppLeaseInTx(deps, tx, lease, "offer-timeout");
        context.logger.info("app.offer-timed-out", { taskId: task.id, leaseEpoch: context.payload.leaseEpoch });
        return;
      }
      if (task.state !== "queued") {
        return;
      }
      await tx.lease.update({ where: { id: lease.id }, data: { state: "ended", endedAt: new Date(deps.clock.now()), endReason: "offer-timeout" } });
      await tx.box.updateMany({ where: { id: lease.boxId, state: "creating" }, data: { state: "failed", failedReason: "the runner didn't answer the offer" } });
      await tx.task.update({ where: { id: task.id }, data: dispatchWaitColumns({ code: "offer-timed-out" }) });
      const session = await activeSessionOf(tx, context.payload.taskId);
      if (session !== null) {
        await deps.jobs.enqueueInTx(tx, "task.dispatch", {
          organizationId: context.payload.organizationId,
          taskId: context.payload.taskId,
          sessionId: sessionIdSchema.parse(session.id),
          leaseEpoch: leaseEpochSchema.parse(context.payload.leaseEpoch + 1),
        });
      }
      await deps.notices.emitInTx(tx, {
        organizationId: context.payload.organizationId,
        projectId: projectIdSchema.parse(task.projectId),
        entity: "task",
        entityId: context.payload.taskId,
      });
      context.logger.info("task.offer-timed-out", { taskId: task.id, leaseEpoch: context.payload.leaseEpoch });
    },
  });

/** The runner's answers to dispatch offers, in the transaction that records them. */
export const applyOfferResultsInTx = async (
  deps: Pick<DispatcherDeps, "jobs" | "notices" | "clock" | "logger">,
  tx: Tx,
  runner: RunnerRef,
  results: readonly AckedCommand[],
): Promise<void> => {
  for (const result of results) {
    if (result.kind !== "dispatch" || (result.result !== "accepted" && result.result !== "rejected")) {
      continue;
    }
    const outcome = await acceptOffer(
      { tx, jobs: deps.jobs, notices: deps.notices, clock: deps.clock, logger: deps.logger },
      { runnerId: runner.runnerId, commandId: result.commandId, seq: result.seq, result: result.result },
    );
    deps.logger.info("task.offer-answered", {
      runnerId: runner.runnerId,
      commandId: result.commandId,
      outcome: outcome.ok ? outcome.outcome : outcome.error,
    });
  }
};

/**
 * The queue's sweep (F-067, every `OSTRA_QUEUE_SWEEP_SECONDS`): `queue.admit` for every pool whose
 * queue holds a task with no offer out, and a fresh dispatch for every such task that goes to its
 * member's personal runner. It catches every change of room that sent nothing: a slot freed, a
 * runner came online, a provider's hold ended. Each job is keyed, so a sweep never sends one twice.
 */
export const requeueQueuedTasks = async (deps: Pick<DispatcherDeps, "db" | "jobs">, limit = 200): Promise<number> => {
  const waiting = await deps.db.task.findMany({
    where: { state: "queued", leases: { none: { state: "active" } } },
    select: {
      id: true,
      organizationId: true,
      projectId: true,
      creatorMemberId: true,
      runnerId: true,
      poolOnly: true,
      leaseEpoch: true,
      sessions: { where: { state: "starting" }, select: { id: true }, take: 1 },
    },
    orderBy: [{ queuePriority: "asc" }, { queuedAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
    take: limit,
  });
  let sent = 0;
  const projects = new Map<string, { readonly organizationId: OrganizationId; readonly projectId: ProjectId }>();
  for (const task of waiting) {
    const [session] = task.sessions;
    if (session === undefined) {
      continue;
    }
    if (!goesToPersonalRunner(task)) {
      projects.set(task.projectId, { organizationId: organizationIdSchema.parse(task.organizationId), projectId: projectIdSchema.parse(task.projectId) });
      continue;
    }
    const payload: JobPayload<"task.dispatch"> = {
      organizationId: organizationIdSchema.parse(task.organizationId),
      taskId: taskIdSchema.parse(task.id),
      sessionId: sessionIdSchema.parse(session.id),
      leaseEpoch: leaseEpochSchema.parse(task.leaseEpoch + 1),
    };
    await deps.db.$transaction(async (tx) => {
      const result = await deps.jobs.sendInTx(tx, "task.dispatch", payload);
      if (result.kind === "enqueued") {
        sent += 1;
      }
    });
  }
  const pools = new Map<PoolId, OrganizationId>();
  for (const { organizationId, projectId } of projects.values()) {
    for (const entry of await projectPoolsInTx(deps.db, organizationId, projectId)) {
      pools.set(entry.poolId, organizationId);
    }
  }
  for (const [poolId, organizationId] of pools) {
    await deps.db.$transaction(async (tx) => {
      const result = await deps.jobs.sendInTx(tx, "queue.admit", { organizationId, poolId });
      if (result.kind === "enqueued") {
        sent += 1;
      }
    });
  }
  return sent;
};
