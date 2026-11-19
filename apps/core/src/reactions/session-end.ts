import type { Logger } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { endSessionTimersInTx, moveSessionInTx, openPullRequests, recordSessionEnd, releaseLeaseInTx } from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock, JobQueue, ServerAdapters, SessionTimers } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";
import { organizationIdSchema, projectIdSchema, stopBodySchema } from "@ostra/protocol";

import type { AckedCommand, RunnerRef } from "../gateway/context.ts";
import { killPoint } from "../kill-points.ts";

// The reactions to a session's end (ticket 27): the `task.session-ended` and
// `task.open-pull-requests` workers, and what a runner's answer to a `stop` does. Each re-reads the
// task first and does nothing if it moved on (ADR 0037, rule 1); the PR job is idempotent per task
// repo, so a retry after a failed call to the code host opens each PR once.

export type ReactionDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly adapters: ServerAdapters;
  /** The panel's address: each PR links its task there. */
  readonly publicUrl: string;
  readonly logger: Logger;
  /** Milestone 2: the session's and the box's timers (tickets 19, 20). */
  readonly timers?: SessionTimers;
};

export const sessionEndedHandler =
  (deps: ReactionDeps): JobHandler<"task.session-ended"> =>
  async (context) => {
    const result = await deps.db.$transaction((tx) =>
      recordSessionEnd(
        {
          tx,
          jobs: deps.jobs,
          notices: deps.notices,
          audit: deps.audit,
          clock: deps.clock,
          logger: context.logger,
          ...(deps.timers === undefined ? {} : { timers: deps.timers }),
        },
        context.payload,
      ),
    );
    context.logger.info("task.session-ended", { taskId: context.payload.taskId, outcome: result.ok ? result.outcome : result.error });
  };

/** Thrown so the queue retries: the code host failed, and nothing was half done. */
export const CODE_HOST_FAILED = "the code host failed; the job retries";

export const openPullRequestsHandler =
  (deps: ReactionDeps): JobHandler<"task.open-pull-requests"> =>
  async (context) => {
    const result = await openPullRequests(
      {
        db: deps.db,
        notices: deps.notices,
        audit: deps.audit,
        clock: deps.clock,
        adapters: deps.adapters,
        publicUrl: deps.publicUrl,
        logger: context.logger,
        jobs: deps.jobs,
        afterHostWrite: () => {
          killPoint("open-pull-requests.answered");
        },
      },
      context.payload,
    );
    if (!result.ok) {
      context.logger.info("task.pull-requests-not-opened", { taskId: context.payload.taskId, error: result.error });
      if (result.error === "code-host-failed") {
        throw new Error(CODE_HOST_FAILED);
      }
      return;
    }
    context.logger.info("task.pull-requests-opened", {
      taskId: context.payload.taskId,
      opened: result.opened.length,
      reused: result.opened.filter((pr) => pr.reused).length,
    });
  };

/**
 * A runner's answer to a `stop` (F-025): `done` (the agent ended, the branch and the hidden ref are
 * pushed) or `rejected` (it had nothing running). Either way the session is over, and the lease and
 * the box go, so the runner's slot is free. The task was already stopped by whoever asked.
 */
export const applyStopResultsInTx = async (
  deps: Pick<ReactionDeps, "notices" | "clock" | "logger"> & Partial<Pick<ReactionDeps, "timers">>,
  tx: Tx,
  runner: RunnerRef,
  results: readonly AckedCommand[],
): Promise<void> => {
  for (const result of results) {
    if (result.kind !== "stop" || (result.result !== "done" && result.result !== "rejected")) {
      continue;
    }
    const body = stopBodySchema.safeParse(result.body);
    if (!body.success) {
      continue;
    }
    const task = await tx.task.findFirst({ where: { id: body.data.taskId, organizationId: runner.organizationId } });
    if (task === null) {
      continue;
    }
    const session = await tx.session.findFirst({ where: { id: body.data.sessionId, taskId: task.id } });
    if (session !== null && ["starting", "running", "waiting", "idle"].includes(session.state)) {
      await moveSessionInTx({ tx, notices: deps.notices, logger: deps.logger }, session, { type: "stop" });
    }
    await endSessionTimersInTx(deps, tx, { organizationId: runner.organizationId, taskId: body.data.taskId, sessionId: body.data.sessionId });
    const lease = await tx.lease.findFirst({ where: { taskId: task.id, epoch: body.data.leaseEpoch, runnerId: runner.runnerId, state: "active" } });
    if (lease !== null) {
      await releaseLeaseInTx(tx, body.data.taskId, new Date(deps.clock.now()), "released");
    }
    await deps.notices.emitInTx(tx, {
      organizationId: organizationIdSchema.parse(task.organizationId),
      projectId: projectIdSchema.parse(task.projectId),
      entity: "task",
      entityId: body.data.taskId,
    });
    deps.logger.info("task.stop-answered", { taskId: task.id, runnerId: runner.runnerId, result: result.result });
  }
};
