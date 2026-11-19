import type { Logger } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { acceptOffer, dispatchTask } from "@ostra/domain";
import type { ChangeNotices, Clock, CommandOutbox, JobPayload } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { onCurrentTask } from "@ostra/jobs";
import { leaseEpochSchema, organizationIdSchema, projectIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProviderId, TaskId } from "@ostra/protocol";

import type { AckedCommand, RunnerRef } from "../gateway/context.ts";

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
};

export const dispatchHandler =
  (deps: DispatcherDeps): JobHandler<"task.dispatch"> =>
  async (context) => {
    const result = await deps.db.$transaction(
      (tx) =>
        dispatchTask({ tx, jobs: deps.jobs, outbox: deps.outbox, notices: deps.notices, clock: deps.clock, logger: context.logger }, context.payload),
      { timeout: 30_000 },
    );
    context.logger.info("task.dispatch-done", { taskId: context.payload.taskId, outcome: result.ok ? "offered" : result.error });
  };

const activeSessionOf = (tx: Tx, taskId: TaskId) =>
  tx.session.findFirst({ where: { taskId, state: "starting" }, orderBy: { startedAt: "desc" }, select: { id: true } });

/** An offer not accepted in time goes back to the queue (ADR 0034). */
export const offerTimeoutHandler = (deps: DispatcherDeps): JobHandler<"task.offer-timeout"> =>
  onCurrentTask(deps.db, {
    isCurrent: (task, payload) => task.leaseEpoch === payload.leaseEpoch && task.state === "queued",
    act: async (tx, task, context) => {
      const lease = await tx.lease.findFirst({ where: { taskId: task.id, epoch: context.payload.leaseEpoch, state: "active", acceptedAt: null } });
      if (lease === null) {
        return;
      }
      await tx.lease.update({ where: { id: lease.id }, data: { state: "ended", endedAt: new Date(deps.clock.now()), endReason: "offer-timeout" } });
      await tx.box.updateMany({ where: { id: lease.boxId, state: "creating" }, data: { state: "failed", failedReason: "the runner didn't answer the offer" } });
      await tx.task.update({ where: { id: task.id }, data: { dispatchNote: "The runner didn't answer the offer in time; looking for another." } });
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
        entityId: task.id,
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
 * Sends a dispatch for every queued task with no offer out: the retry for a task that found no
 * runner, after a runner comes online, a slot frees or a provider's hold ends. One query a sweep.
 */
export const requeueQueuedTasks = async (deps: Pick<DispatcherDeps, "db" | "jobs">, limit = 200): Promise<number> => {
  const waiting = await deps.db.task.findMany({
    where: { state: "queued", leases: { none: { state: "active" } } },
    select: { id: true, organizationId: true, leaseEpoch: true, sessions: { where: { state: "starting" }, select: { id: true }, take: 1 } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let sent = 0;
  for (const task of waiting) {
    const [session] = task.sessions;
    if (session === undefined) {
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
  return sent;
};

/**
 * Holds new dispatches on a provider until `until` (it answered with a rate limit, F-088). A later
 * hold only extends an earlier one.
 */
export const holdProviderInTx = async (tx: Tx, organizationId: OrganizationId, providerId: ProviderId, until: Date): Promise<void> => {
  await tx.modelProvider.updateMany({
    where: { id: providerId, organizationId, OR: [{ dispatchHeldUntil: null }, { dispatchHeldUntil: { lt: until } }] },
    data: { dispatchHeldUntil: until },
  });
};
