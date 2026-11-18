// D3. C3 on DBOS Transact: a limit of 2 per key across three replicas, 1,000 jobs on 20 keys, and the
// pass with 2 to 4 s jobs. Same passes, same three measures, same judging as C3 (runGroupLimit); only
// the library differs:
//
//   - the limit is a partitioned queue (`partitionConcurrency: 2`, `workerConcurrency: 16` per process,
//     the counterpart of pg-boss's 16 local workers), and each job is a workflow enqueued with its key
//     as the partition key;
//   - "running" is a workflow in status PENDING, which is what partitionConcurrency counts; the
//     committed-state sampler counts PENDING workflows per partition;
//   - the table's own interval is started_at_epoch_ms (the claim) to completed_at.
//
// How DBOS claims (system_database.js, claimStartableWorkflows): a claim on a queue with a shared
// budget opens a transaction, takes pg_try_advisory_xact_lock on the (queue, partition) scope, counts
// the PENDING workflows of the partition and claims at most the room left, then commits, which
// releases the lock. Claims of one partition are therefore serialized, and the next claimer's count
// sees the previous claim. A claimer that misses the lock claims nothing and retries on its next poll.

import { z } from "zod";
import type { CriterionResult, RunContext } from "../kit.ts";
import { GROUP_LIMIT } from "../job-defs.ts";
import { runGroupLimit } from "../scenarios/c3-group-limit.ts";
import type { GroupBackend } from "../scenarios/c3-group-limit.ts";
import { GROUP_QUEUE, createDbosProducer, migrateDbos } from "./jobs.ts";

export const id = "D3";
export const criterion =
  "C3 on DBOS: a limit of 2 per key holds across three replicas for 1,000 jobs on 20 keys. Any brief overshoot is recorded.";

const ENQUEUE_CONCURRENCY = 20;

const dbosJobRowSchema = z.object({
  group_id: z.string().nullable(),
  status: z.string(),
  recovery_attempts: z.coerce.number(),
  start_us: z.coerce.number().nullable(),
  end_us: z.coerce.number().nullable(),
});

const dbosBackend: GroupBackend = {
  library: "DBOS",
  boot: async (scenario, replicas) => {
    // DBOS's schema first, once (see migrateDbos): concurrent launches on a cold database deadlock.
    await migrateDbos(scenario.db.url);
    const started = Array.from({ length: replicas }, (_, index) => `replica-${String(index + 1)}`).map((replicaId) =>
      scenario.spawnDbosReplica(replicaId, {
        executorId: replicaId,
        workers: ["group"],
        partitionConcurrency: GROUP_LIMIT,
        workerConcurrency: 16,
        // pg-boss's workers polled every 0.5 s.
        pollingIntervalMs: 500,
      }),
    );
    for (const replica of started) {
      const message = await replica.child.waitForMessage((m) => m.type === "ready" || m.type === "fatal", 120_000, "ready");
      if (message.type === "fatal") {
        throw new Error(`${replica.id} failed to start: ${message.error}`);
      }
    }
    // The panel's role: a client over the system database that never launches DBOS.
    const producer = await createDbosProducer(scenario.db.url);
    return async (jobs) => {
      try {
        for (let offset = 0; offset < jobs.length; offset += ENQUEUE_CONCURRENCY) {
          await Promise.all(jobs.slice(offset, offset + ENQUEUE_CONCURRENCY).map((job) => producer.enqueueGroupWork(job)));
        }
      } finally {
        await producer.destroy();
      }
    };
  },
  activeSql:
    "SELECT queue_partition_key AS group_id, count(*)::int AS n FROM dbos.workflow_status WHERE queue_name = $1 AND status = 'PENDING' AND queue_partition_key IS NOT NULL GROUP BY queue_partition_key",
  activeParams: [GROUP_QUEUE],
  completedCount: async (db) => {
    const rows = await db.query(
      "SELECT count(*)::int AS n FROM dbos.workflow_status WHERE queue_name = $1 AND status = 'SUCCESS'",
      [GROUP_QUEUE],
      z.object({ n: z.number() }),
    );
    return rows[0]?.n ?? 0;
  },
  jobRows: async (db) => {
    const rows = await db.query(
      `SELECT queue_partition_key AS group_id, status, recovery_attempts,
              (started_at_epoch_ms * 1000)::text AS start_us,
              (COALESCE(completed_at, updated_at) * 1000)::text AS end_us
         FROM dbos.workflow_status WHERE queue_name = $1`,
      [GROUP_QUEUE],
      dbosJobRowSchema,
    );
    return rows.map((row) => ({
      groupId: row.group_id,
      finished: row.status === "SUCCESS",
      // DBOS counts the first start as an attempt: more than one means it was started again.
      retried: row.recovery_attempts > 1,
      startUs: row.start_us,
      endUs: row.end_us,
    }));
  },
  overshootExplanation:
    "DBOS serializes the claims of one partition behind a transaction-scoped advisory lock and counts PENDING workflows inside it, so a table overshoot would mean that guard failed",
};

export const run = (ctx: RunContext): Promise<CriterionResult> =>
  runGroupLimit(ctx, { id, criterion, databasePrefix: "d3", backend: dbosBackend });
