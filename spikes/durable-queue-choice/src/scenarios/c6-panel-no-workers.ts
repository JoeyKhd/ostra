// C6. The panel process enqueues without running workers.
//
// The panel is a pg-boss producer: it never migrates, supervises, runs the schedule pass or calls
// work(). The scenario shows it from the outside:
//   0. a panel starts against a database where no core has run, so pg-boss's schema does not exist
//      (ADR 0016: the panel may boot before the core). The exact start() failure is recorded, and
//      the panel must not have created the schema.
//   1. a core replica boots once, so the schema and queues exist, then stops. No worker is alive.
//   2. the panel starts and enqueues a job inside a Prisma transaction. Nothing runs it.
//   3. a core replica starts and runs it. The run is recorded under the replica's id, not the panel's.
//   4. the panel's own registry row says no supervise, no schedule, no migrate, no workers, and
//      the process leaves by itself shortly after stop(), so no worker loop or timer holds it open.

import { z } from "zod";
import { countRows, openScenario } from "../kit.ts";
import type { CriterionResult, RunContext } from "../kit.ts";
import { sleep, waitUntil } from "../proc.ts";

export const id = "C6";
export const criterion = "The panel process enqueues without running workers.";

export const run = async (ctx: RunContext): Promise<CriterionResult> => {
  const scenario = await openScenario(ctx, "c6_panel_no_workers");
  const { db } = scenario;
  const evidence: string[] = [];
  const failures: string[] = [];
  const check = (condition: boolean, passed: string, failed: string): void => {
    if (condition) {
      evidence.push(passed);
    } else {
      failures.push(failed);
      evidence.push(`FAILED: ${failed}`);
    }
  };

  try {
    // 0. A panel before any core: no pgboss schema in this database yet.
    let bootedWithoutSchema = false;
    let startFailure = "";
    try {
      const early = await scenario.startPanel("panel-0");
      bootedWithoutSchema = true;
      await early.stop();
    } catch (error) {
      startFailure = error instanceof Error ? error.message : "unknown";
    }
    const schemasAfterEarlyPanel = await countRows(
      db,
      "SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'pgboss'",
      [],
    );
    evidence.push(
      bootedWithoutSchema
        ? "step 0: a panel started against a database with no pgboss schema without error (it then stopped)"
        : `step 0: a panel started against a database with no pgboss schema, and start() failed: ${startFailure}`,
    );
    check(
      schemasAfterEarlyPanel === 0,
      "step 0: the panel created no pgboss schema (it never migrates), so the schema is the core service's alone",
      `step 0: the panel left ${String(schemasAfterEarlyPanel)} pgboss schema(s) behind`,
    );

    // 1. The core boots once (migrates, creates the queues) and stops.
    const bootReplica = await scenario.startReplica("core-boot", ["transition"]);
    await bootReplica.stop();

    // 2. The panel enqueues with no worker alive anywhere.
    const panel = await scenario.startPanel("panel-1");
    const enqueued = await panel.call({ type: "enqueue-task", taskId: "task-panel", commit: true, viaTransaction: true });
    const jobId = enqueued.jobIds[0] ?? "";
    await sleep(6_000);
    const waiting = await db.query(
      "SELECT state FROM pgboss.job WHERE id = $1::uuid",
      [jobId],
      z.object({ state: z.string() }),
    );
    const runsBefore = await countRows(db, "SELECT count(*)::int AS n FROM job_run WHERE job_id = $1", [jobId]);
    check(
      waiting[0]?.state === "created" && runsBefore === 0,
      "with no replica alive, the panel's job sat in state created for 6 s (12 poll intervals) and nothing ran it",
      `expected the job to wait in created with no runs, found ${waiting[0]?.state ?? "no row"} and ${String(runsBefore)} runs`,
    );

    const report = await panel.call({ type: "report" });
    const d = report.details;
    check(
      d["workerRegistrations"] === 0 &&
        d["registered"] === true &&
        d["registrySupervise"] === false &&
        d["registrySchedule"] === false &&
        d["registryMigrate"] === false &&
        d["registryWorkers"] === 0,
      "the panel's own pg-boss registry row: supervise false, schedule false, migrate false, 0 worker registrations (in memory: 0)",
      `panel registry: ${JSON.stringify(d)}`,
    );

    // 3. A core replica starts and runs the job.
    const replica = await scenario.startReplica("replica-1", ["transition"]);
    await waitUntil(
      async () => (await countRows(db, "SELECT count(*)::int AS n FROM job_run WHERE job_id = $1", [jobId])) > 0,
      { timeoutMs: 30_000, intervalMs: 250, what: "the replica to run the panel's job" },
    );
    const ran = await db.query(
      "SELECT replica_id FROM job_run WHERE job_id = $1 AND phase = 'done'",
      [jobId],
      z.object({ replica_id: z.string() }),
    );
    const finalState = await db.query("SELECT state FROM pgboss.job WHERE id = $1::uuid", [jobId], z.object({ state: z.string() }));
    check(
      ran.length === 1 && ran[0]?.replica_id === replica.id && finalState[0]?.state === "completed",
      `once ${replica.id} started it ran the job (recorded under its own id), and the job completed`,
      `expected one run by ${replica.id}, found ${JSON.stringify(ran)}`,
    );

    // 4. The panel leaves by itself: nothing of its own keeps the event loop alive.
    const stoppedAt = Date.now();
    const exit = await panel.stop();
    const leftAfterMs = Date.now() - stoppedAt;
    check(
      exit.code === 0 && leftAfterMs < 4_500,
      `after stop() the panel process exited with code 0 by itself in ${String(leftAfterMs)} ms, before its 5 s safety timer (no worker loop or timer held it)`,
      `panel exit: code ${String(exit.code)} after ${String(leftAfterMs)} ms`,
    );

    return {
      id,
      criterion,
      verdict: failures.length === 0 ? "PASS" : "FAIL",
      summary:
        failures.length === 0
          ? "The panel enqueued inside a transaction with no worker alive, never ran the job, and holds no worker, supervisor or schedule state."
          : failures.join("; "),
      evidence,
    };
  } finally {
    await scenario.dispose();
  }
};
