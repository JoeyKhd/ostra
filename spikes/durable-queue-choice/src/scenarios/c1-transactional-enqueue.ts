// C1. A job enqueued inside a Prisma 7 transaction exists only if the transaction commits.
//
// Cases A to D, E (a control) and F to H, all through the panel process (a pg-boss producer that
// never works):
//   A. the transaction throws after the enqueue: no job, no task row
//   B. the transaction commits: task row and job together, and a replica runs the job
//   C. a transaction held open: the job is invisible to other connections and to the worker's
//      polling until commit, then runs
//   D. the panel is killed with `kill -9` while its transaction is open: no job, no task row
//   E. control: sent on pg-boss's own pool, a rolled-back task leaves its job behind
//   F. ADR 0037, rule 2: a job under a fixed key (`task:<TaskId>:<transition>:<seq>`) sent twice is one job
//   G. control: the same key on a standard queue makes two jobs, so the queue policy does the work
//   H. the same key again after the first job completed makes a new job; rule 1 (the handler
//      checks the task's state again) is what keeps that harmless

import { z } from "zod";
import { countRows, openScenario, type CriterionResult, type RunContext } from "../kit.ts";
import { sleep, waitUntil } from "../proc.ts";

export const id = "C1";
export const criterion = "A job enqueued inside a Prisma 7 transaction exists only if the transaction commits.";

const jobExists = (jobId: string) =>
  ["SELECT count(*)::int AS n FROM pgboss.job WHERE id = $1::uuid", [jobId]] as const;

export const run = async (ctx: RunContext): Promise<CriterionResult> => {
  const scenario = await openScenario(ctx, "c1_tx_enqueue");
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
    await scenario.startReplica("replica-1", ["transition"]);
    const panel = await scenario.startPanel("panel-1");

    const runsFor = (jobId: string): Promise<number> =>
      countRows(db, "SELECT count(*)::int AS n FROM job_run WHERE job_id = $1", [jobId]);
    const tasksFor = (taskId: string): Promise<number> =>
      countRows(db, "SELECT count(*)::int AS n FROM task WHERE id = $1", [taskId]);

    // A. Rolled back.
    const rolledBack = await panel.call({ type: "enqueue-task", taskId: "task-rollback", commit: false, viaTransaction: true });
    const rolledBackJob = rolledBack.jobIds[0] ?? "";
    check(rolledBackJob.length > 0, "A: send() inside the transaction returned a job id before the rollback", "A: send() returned no job id");
    await sleep(2_000);
    const aJobs = await countRows(db, ...jobExists(rolledBackJob));
    const aTasks = await tasksFor("task-rollback");
    const aRuns = await runsFor(rolledBackJob);
    check(
      aJobs === 0 && aTasks === 0 && aRuns === 0,
      "A: after the rollback there is no job row, no task row and no run (2 s of worker polling at 0.5 s)",
      `A: after the rollback found ${String(aJobs)} job rows, ${String(aTasks)} task rows, ${String(aRuns)} runs`,
    );

    // B. Committed.
    const committed = await panel.call({ type: "enqueue-task", taskId: "task-commit", commit: true, viaTransaction: true });
    const committedJob = committed.jobIds[0] ?? "";
    await waitUntil(async () => (await runsFor(committedJob)) > 0, { timeoutMs: 30_000, intervalMs: 250, what: "the committed job to run" });
    const bJobs = await countRows(db, ...jobExists(committedJob));
    const bState = await db.query("SELECT state FROM task WHERE id = $1", ["task-commit"], z.object({ state: z.string() }));
    check(
      bJobs === 1 && bState[0]?.state === "prepared",
      "B: after the commit the job exists, a replica ran it, and the task moved queued -> prepared",
      `B: expected 1 job and task state prepared, found ${String(bJobs)} and ${bState[0]?.state ?? "none"}`,
    );

    // C. Held open, then committed.
    const held = await panel.call({ type: "open-tx", taskId: "task-held" }, { requestId: "open-1" });
    const heldJob = held.jobIds[0] ?? "";
    await sleep(3_000);
    const cBefore = await countRows(db, ...jobExists(heldJob));
    const cTaskBefore = await tasksFor("task-held");
    const cRunsBefore = await runsFor(heldJob);
    check(
      cBefore === 0 && cTaskBefore === 0 && cRunsBefore === 0,
      "C: while the transaction is open, another connection sees no job and no task row, and the worker (polling every 0.5 s for 3 s) ran nothing",
      `C: before commit found ${String(cBefore)} job rows, ${String(cTaskBefore)} task rows, ${String(cRunsBefore)} runs`,
    );
    await panel.call({ type: "settle-open-tx", openRequestId: "open-1", decision: "commit" });
    await waitUntil(async () => (await runsFor(heldJob)) > 0, { timeoutMs: 30_000, intervalMs: 250, what: "the held job to run after commit" });
    const cAfter = await countRows(db, ...jobExists(heldJob));
    check(cAfter === 1, "C: after the commit the job is visible and ran", `C: after commit expected 1 job row, found ${String(cAfter)}`);

    // D. The process dies with the transaction open.
    const doomed = await scenario.startPanel("panel-2");
    const crashing = await doomed.call({ type: "open-tx", taskId: "task-crash" }, { requestId: "open-crash" });
    const crashingJob = crashing.jobIds[0] ?? "";
    await doomed.kill9();
    await sleep(3_000);
    const dJobs = await countRows(db, ...jobExists(crashingJob));
    const dTasks = await tasksFor("task-crash");
    const dRuns = await runsFor(crashingJob);
    check(
      dJobs === 0 && dTasks === 0 && dRuns === 0,
      "D: after `kill -9` on the panel with its transaction open there is no job, no task row and no run",
      `D: after the kill found ${String(dJobs)} job rows, ${String(dTasks)} task rows, ${String(dRuns)} runs`,
    );

    // E. The control: the same code, but the job is sent on pg-boss's own pool, not through the
    // transaction. The task row rolls back and the job stays. It shows what fromPrisma(tx) buys.
    const control = await panel.call({ type: "enqueue-task", taskId: "task-control", commit: false, viaTransaction: false });
    const controlJob = control.jobIds[0] ?? "";
    const eJobs = await countRows(db, ...jobExists(controlJob));
    const eTasks = await tasksFor("task-control");
    check(
      eJobs === 1 && eTasks === 0,
      "E (control): without the transaction handle, a rolled-back task leaves its job behind (1 job row, 0 task rows), so the result above is not an accident of timing",
      `E (control): expected the job to survive without the transaction handle, found ${String(eJobs)} job rows and ${String(eTasks)} task rows`,
    );

    // F. A fixed job key: sending the job twice makes one job (an exclusive queue).
    const twice = await panel.call({ type: "send-twice", taskId: "task-twice", target: "transition" });
    const fKey = String(twice.details["key"]);
    const fJobs = await countRows(db, "SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'task-transition' AND singleton_key = $1", [fKey]);
    check(
      twice.details["first"] === "enqueued" && twice.details["second"] === "deduplicated" && fJobs === 1,
      `F: the keyed transition job sent twice in one transaction: first ${String(twice.details["first"])}, second ${String(twice.details["second"])}, ${String(fJobs)} job row for key ${fKey} (ADR 0037, rule 2)`,
      `F: expected enqueued then deduplicated and one job row, got ${String(twice.details["first"])}, ${String(twice.details["second"])} and ${String(fJobs)} rows`,
    );

    // G. The control: the same two sends on a standard queue.
    const standard = await panel.call({ type: "send-twice", taskId: "task-twice-standard", target: "timeout" });
    const gKey = String(standard.details["key"]);
    const gJobs = await countRows(db, "SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'task-timeout' AND singleton_key = $1", [gKey]);
    check(
      standard.details["first"] === "enqueued" && standard.details["second"] === "enqueued" && gJobs === 2,
      "G (control): on a standard queue the same singletonKey, sent twice, made two jobs, so a singletonKey alone does not deduplicate: the transition queue's exclusive policy does",
      `G (control): expected two jobs on a standard queue, got ${String(standard.details["first"])}, ${String(standard.details["second"])} and ${String(gJobs)} rows`,
    );

    // H. After completion the key is free again; the handler's own state check keeps that harmless.
    const twiceJob = twice.jobIds[0] ?? "";
    await waitUntil(async () => (await runsFor(twiceJob)) > 0, { timeoutMs: 30_000, intervalMs: 250, what: "the keyed job to run" });
    const again = await panel.call({ type: "resend-transition", taskId: "task-twice" });
    const againJob = again.jobIds[0] ?? "";
    await waitUntil(async () => (await runsFor(againJob)) > 0, { timeoutMs: 30_000, intervalMs: 250, what: "the resent job to run" });
    const againRun = await db.query("SELECT detail FROM job_run WHERE job_id = $1", [againJob], z.object({ detail: z.string() }));
    check(
      again.details["kind"] === "enqueued" && againRun[0]?.detail === "state-moved-on",
      "H: once the first job had completed, the same key made a new job (exclusive covers a queued or running job only); the handler found the task already prepared and did nothing (ADR 0037, rule 1)",
      `H: expected a new job that found the task moved on, got ${String(again.details["kind"])} and ${againRun[0]?.detail ?? "no run"}`,
    );

    return {
      id,
      criterion,
      verdict: failures.length === 0 ? "PASS" : "FAIL",
      summary:
        failures.length === 0
          ? "A job written through fromPrisma(tx) is committed, or rolled back, with the task row beside it, and a fixed job key makes a second send a no-op."
          : failures.join("; "),
      evidence,
    };
  } finally {
    await scenario.dispose();
  }
};
