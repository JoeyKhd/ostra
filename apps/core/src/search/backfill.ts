import type { Logger } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { backfillTaskSearchEntries } from "@ostra/domain";
import type { JobPayload } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";
import { organizationIdSchema, taskIdSchema } from "@ostra/protocol";

// `search.backfill` (F-080, ADR 0054; milestone 4, ticket 11): the search entries of a task that
// existed before milestone 4, or that missed its own. One job per task, keyed by the task; its
// events in batches of 500, each batch in its own transaction, idempotent by
// `(taskId, eventSeq, kind)`, so a retry or a second run writes nothing twice. Its progress is the
// job's log line after each batch: the task, the last sequence read and the count, never text.

export type SearchBackfillDeps = { readonly db: Db };

export const searchBackfillHandler =
  (deps: SearchBackfillDeps): JobHandler<"search.backfill"> =>
  async (context) => {
    const { organizationId, taskId } = context.payload;
    const done = await backfillTaskSearchEntries(deps.db, { organizationId, taskId }, (progress) => {
      context.logger.info("search.backfill-progress", { taskId, upToSeq: progress.upToSeq, written: progress.written });
    });
    context.logger.info("search.backfill-done", { taskId, found: done !== null, written: done?.written ?? 0 });
  };

/** How many tasks one boot's pass enqueues per transaction. */
const ENQUEUE_BATCH = 500;

/**
 * At core's boot (the migration's first boot, and any later one): one `search.backfill` per task
 * that has no search entry yet. A task backfilled once has its title's entry, so a later boot
 * enqueues nothing for it: the pass runs once per task. Answers how many it enqueued.
 */
export type SearchBackfillQueue = { readonly enqueueInTx: (tx: Tx, job: "search.backfill", payload: JobPayload<"search.backfill">) => Promise<unknown> };

export const enqueueSearchBackfill = async (deps: { readonly db: Db; readonly jobs: SearchBackfillQueue; readonly logger: Logger }): Promise<number> => {
  let enqueued = 0;
  let after = "";
  for (;;) {
    const tasks = await deps.db.task.findMany({
      where: { id: { gt: after }, searchEntries: { none: {} } },
      orderBy: { id: "asc" },
      take: ENQUEUE_BATCH,
      select: { id: true, organizationId: true },
    });
    if (tasks.length === 0) {
      break;
    }
    await deps.db.$transaction(async (tx) => {
      for (const task of tasks) {
        await deps.jobs.enqueueInTx(tx, "search.backfill", { organizationId: organizationIdSchema.parse(task.organizationId), taskId: taskIdSchema.parse(task.id) });
      }
    });
    enqueued += tasks.length;
    after = tasks[tasks.length - 1]?.id ?? after;
    if (tasks.length < ENQUEUE_BATCH) {
      break;
    }
  }
  if (enqueued > 0) {
    deps.logger.info("search.backfill-enqueued", { tasks: enqueued });
  }
  return enqueued;
};
