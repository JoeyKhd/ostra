import type { Db, Task, Tx } from "@ostra/db";
import type { JobName, JobPayload } from "@ostra/domain";
import type { OrganizationId, TaskId } from "@ostra/protocol";

import type { JobContext, JobHandler } from "./jobs.ts";

// ADR 0037, rule 1: ostra's tables are the source of truth. A job carries out one transition and
// checks the task's state again before it acts; a job whose task has moved on does nothing. This
// helper makes that the default shape of every task job's handler:
//
//   jobs.work("task.offer-timeout", onCurrentTask(db, {
//     isCurrent: (task, payload) => task.leaseEpoch === payload.leaseEpoch && task.state === "preparing",
//     act: async (tx, task, payload) => { ... },
//   }));
//
// The task row is locked `FOR UPDATE` for the transaction, so the job and an ingest batch (which
// takes a share lock on the same row) never interleave.

/** The jobs whose payload names a task. */
export type TaskJobName = {
  [N in JobName]: JobPayload<N> extends { readonly organizationId: OrganizationId; readonly taskId: TaskId } ? N : never;
}[JobName];

export type TaskJobOutcome = "acted" | "skipped" | "missing";

export type OnCurrentTaskOptions<N extends TaskJobName> = {
  /** Whether the job still applies to the task as it is now. `false`: the task moved on; do nothing. */
  readonly isCurrent: (task: Task, payload: JobPayload<N>) => boolean;
  /** The transition, in the transaction that holds the task's row lock. */
  readonly act: (tx: Tx, task: Task, context: JobContext<N>) => Promise<void>;
  /** Called after the transaction ends, with what happened. For tests and metrics. */
  readonly onOutcome?: (outcome: TaskJobOutcome, context: JobContext<N>) => void;
};

/** Locks the task row `FOR UPDATE` and reads it, scoped by its organization. `null`: no such task. */
export const lockTask = async (tx: Tx, organizationId: OrganizationId, taskId: TaskId): Promise<Task | null> => {
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT 1 FROM "task" WHERE "id" = ${taskId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (locked.length === 0) {
    return null;
  }
  return tx.task.findFirst({ where: { id: taskId, organizationId } });
};

/** A handler that acts only while its task is still where the job expects it (ADR 0037, rule 1). */
export const onCurrentTask =
  <N extends TaskJobName>(db: Db, options: OnCurrentTaskOptions<N>): JobHandler<N> =>
  async (context) => {
    const { organizationId, taskId } = context.payload;
    const outcome = await db.$transaction(async (tx): Promise<TaskJobOutcome> => {
      const task = await lockTask(tx, organizationId, taskId);
      if (task === null) {
        return "missing";
      }
      if (!options.isCurrent(task, context.payload)) {
        return "skipped";
      }
      await options.act(tx, task, context);
      return "acted";
    });
    if (outcome !== "acted") {
      context.logger.info("job.skipped", { taskId, outcome });
    }
    options.onOutcome?.(outcome, context);
  };
