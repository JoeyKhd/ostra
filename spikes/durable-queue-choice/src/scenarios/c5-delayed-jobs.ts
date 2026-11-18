// C5. Delayed jobs survive a restart and can be cancelled.
//
// Seven delayed jobs are enqueued inside Prisma transactions, each with its task row (the timer
// pattern of ADR 0037: wake, check the task's state, do nothing if it moved on):
//   A  due in 45 s; every replica is killed with SIGKILL before it is due, new ones start
//   B  due in 45 s; the new replicas are then stopped gracefully and replaced again
//   F  due in 12 s; every replica is down when it falls due, and runs after the restart
//   E  due in 45 s; its task moves on before the wake, so the handler must do nothing
//   C  cancelled while the replicas are up
//   D  cancelled while every replica is dead
//   G  cancelled after the restart, before it is due
// Nothing may run early or twice. A cancelled job must never run.

import { z } from "zod";
import { dbNowMs, openScenario } from "../kit.ts";
import type { CriterionResult, RunContext } from "../kit.ts";
import { sleep, waitUntil } from "../proc.ts";

export const id = "C5";
export const criterion = "Delayed jobs survive a restart and can be cancelled.";

type Label = "A" | "B" | "F" | "E" | "C" | "D" | "G";

const rowSchema = z.object({
  job_id: z.string(),
  replica_id: z.string(),
  phase: z.string(),
  detail: z.string(),
  at_us: z.coerce.number(),
});

const jobSchema = z.object({
  id: z.string(),
  state: z.string(),
  start_after_us: z.coerce.number(),
});

export const run = async (ctx: RunContext): Promise<CriterionResult> => {
  const scenario = await openScenario(ctx, "c5_delayed");
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
    const first = [
      await scenario.startReplica("replica-1", ["timeout"]),
      await scenario.startReplica("replica-2", ["timeout"]),
    ];
    const panel = await scenario.startPanel("panel-1");

    const jobIds = new Map<Label, string>();
    const taskIds = new Map<Label, string>();
    const plan: readonly { readonly label: Label; readonly seconds: number }[] = [
      { label: "A", seconds: 45 },
      { label: "B", seconds: 45 },
      { label: "F", seconds: 12 },
      { label: "E", seconds: 45 },
      { label: "C", seconds: 45 },
      { label: "D", seconds: 45 },
      { label: "G", seconds: 45 },
    ];

    const t0 = await dbNowMs(db);
    const atSeconds = async (seconds: number): Promise<void> => {
      const wait = t0 + seconds * 1000 - (await dbNowMs(db));
      if (wait > 0) {
        await sleep(wait);
      }
    };

    for (const { label, seconds } of plan) {
      const taskId = `task-${label}`;
      taskIds.set(label, taskId);
      const reply = await panel.call({
        type: "send-timeout",
        taskId,
        taskState: "queued",
        expectState: "queued",
        startAfterSeconds: seconds,
      });
      jobIds.set(label, reply.jobIds[0] ?? "");
    }
    const idOf = (label: Label): string => jobIds.get(label) ?? "";
    const taskOf = (label: Label): string => taskIds.get(label) ?? "";
    ctx.note("seven delayed jobs enqueued");

    await atSeconds(2);
    const cancelC = await panel.call({ type: "cancel-timeout", jobId: idOf("C") });
    await panel.call({ type: "move-task-on", taskId: taskOf("E"), newState: "done" });
    check(cancelC.details["cancelled"] === true, "C: cancelled while the replicas were up", "C: cancel() affected no job");

    await atSeconds(4);
    await Promise.all(first.map((replica) => replica.kill9()));
    ctx.note("both replicas killed with SIGKILL");

    await atSeconds(6);
    const cancelD = await panel.call({ type: "cancel-timeout", jobId: idOf("D") });
    check(cancelD.details["cancelled"] === true, "D: cancelled while every replica was dead", "D: cancel() affected no job");

    // F falls due at t0 + 12 s, inside the outage. The new replicas start at about t0 + 18 s.
    await atSeconds(18);
    const restartBeganAt = await dbNowMs(db);
    const second = [
      await scenario.startReplica("replica-3", ["timeout"]),
      await scenario.startReplica("replica-4", ["timeout"]),
    ];
    ctx.note("new replicas started after the outage");

    await atSeconds(24);
    const cancelG = await panel.call({ type: "cancel-timeout", jobId: idOf("G") });
    check(cancelG.details["cancelled"] === true, "G: cancelled after the restart, before it was due", "G: cancel() affected no job");

    await atSeconds(28);
    await Promise.all(second.map((replica) => replica.stop()));
    ctx.note("replicas stopped gracefully");
    await scenario.startReplica("replica-5", ["timeout"]);
    await scenario.startReplica("replica-6", ["timeout"]);
    ctx.note("graceful restart done; waiting for A, B, E and F");

    const mustRun: readonly Label[] = ["A", "B", "F", "E"];
    await waitUntil(
      async () => {
        const rows = await db.query(
          "SELECT job_id FROM job_run WHERE phase = 'done'",
          [],
          z.object({ job_id: z.string() }),
        );
        const done = new Set(rows.map((row) => row.job_id));
        return mustRun.every((label) => done.has(idOf(label)));
      },
      { timeoutMs: 120_000, intervalMs: 500, what: "A, B, E and F to run" },
    );
    // Give a duplicate or a cancelled job time to show up.
    await sleep(8_000);

    const runs = await db.query(
      "SELECT job_id, replica_id, phase, detail, (extract(epoch from at) * 1000000)::bigint::text AS at_us FROM job_run ORDER BY id",
      [],
      rowSchema,
    );
    const jobRows = await db.query(
      "SELECT id, state, (extract(epoch from start_after) * 1000000)::bigint::text AS start_after_us FROM pgboss.job WHERE name = 'task-timeout'",
      [],
      jobSchema,
    );
    const taskState = async (label: Label): Promise<string> => {
      const rows = await db.query("SELECT state FROM task WHERE id = $1", [taskOf(label)], z.object({ state: z.string() }));
      return rows[0]?.state ?? "missing";
    };

    for (const label of ["A", "B", "F"] as const) {
      const job = jobRows.find((row) => row.id === idOf(label));
      const done = runs.filter((row) => row.job_id === idOf(label) && row.phase === "done");
      const lagMs = done[0] !== undefined && job !== undefined ? (done[0].at_us - job.start_after_us) / 1000 : Number.NaN;
      const early = done.some((row) => job !== undefined && row.at_us < job.start_after_us);
      check(
        done.length === 1 && !early && job?.state === "completed" && (await taskState(label)) === "timed-out",
        `${label}: ran exactly once, ${(lagMs / 1000).toFixed(1)} s after it fell due, never early; its task moved to timed-out (run by ${done[0]?.replica_id ?? "nobody"})`,
        `${label}: ${String(done.length)} runs, early ${String(early)}, state ${job?.state ?? "missing"}, task ${await taskState(label)}`,
      );
    }
    const overdue = runs.find((row) => row.job_id === idOf("F") && row.phase === "done");
    check(
      overdue !== undefined && overdue.at_us / 1000 >= restartBeganAt,
      `F: fell due at t0 + 12 s with no replica alive, and ran only after the new replicas started, ${overdue === undefined ? "n/a" : ((overdue.at_us / 1000 - restartBeganAt) / 1000).toFixed(1)} s after the restart began`,
      "F: did not wait for the restart",
    );

    const moved = runs.filter((row) => row.job_id === idOf("E") && row.phase === "done");
    check(
      moved.length === 1 && moved[0]?.detail === "noop-task-moved-on" && (await taskState("E")) === "done",
      "E: woke after its task had moved on, found the state changed and did nothing (the task stayed done)",
      `E: runs ${JSON.stringify(moved.map((row) => row.detail))}, task ${await taskState("E")}`,
    );

    for (const label of ["C", "D", "G"] as const) {
      const job = jobRows.find((row) => row.id === idOf(label));
      const ran = runs.filter((row) => row.job_id === idOf(label));
      check(
        job?.state === "cancelled" && ran.length === 0 && (await taskState(label)) === "queued",
        `${label}: state cancelled, never ran, its task untouched`,
        `${label}: state ${job?.state ?? "missing"}, ${String(ran.length)} runs, task ${await taskState(label)}`,
      );
    }

    return {
      id,
      criterion,
      verdict: failures.length === 0 ? "PASS" : "FAIL",
      summary:
        failures.length === 0
          ? "Delayed jobs ran once, on time, across a SIGKILL of every replica and a graceful restart; cancelled jobs never ran."
          : failures.join("; "),
      evidence,
    };
  } finally {
    await scenario.dispose();
  }
};
