// D4. C4 on DBOS Transact: 200 schedules created at runtime each fire once per tick while replicas
// restart. Same database, same three replicas, same kill pattern, same judging (schedule-judge.ts).
//
// How DBOS fires a schedule (scheduler/scheduler.js, workflow_management.js): one replica at a time
// holds DBOS's background lock (a transaction-scoped advisory lock, retaken every 60 s, released by
// Postgres the moment its holder's connection dies) and is the one that fires. At each tick it inserts
// one ENQUEUED workflow per schedule, in one transaction of up to 1,000, under a workflow ID made of
// the schedule's name and the tick (`sched-<name>-<tick ISO>`), skipping IDs that exist, and stamps
// each schedule's last_fired_at in the same transaction. A standby keeps every tick until a poll shows
// it fired, so whoever takes the lock next fires what a dead leader missed, and a second firing of the
// same tick finds the ID taken. Every replica then claims those workflows from DBOS's internal queue
// (status PENDING, with its executor ID) and runs them.
//
// The window that matters is therefore the same as pg-boss's: fires claimed by a replica that dies
// before it finishes them. The hunt is C4's: a dedicated connection polls back to back while fires
// are ENQUEUED or PENDING, and the moment some are PENDING it kills every replica but one (the
// survivor rotates), re-reads them 3 s later (still PENDING: stranded), and restarts the killed ones.
// DBOS has no heartbeat on a claim. Without Conductor, a replica's PENDING workflows are recovered when
// a process starts under the same executor ID (DBOS.launch recovers its own ID's work), so:
//
//   SPIKE_DBOS_EXECUTOR_ID=slot     (default) a restarted replica keeps its slot's executor ID, as
//                                   DBOS's self-hosting guide requires;
//   SPIKE_DBOS_EXECUTOR_ID=process  each process gets a new one, as a pod with a generated name
//                                   would: nothing recovers the dead ID's work.
//
// One extra strike, not in C4, aims at the leader instead: at the tick-2 boundary it kills every
// replica but one while the leader enqueues the tick (the leader is among the killed with probability
// 2/3; DBOS does not say who holds the lock). One graceful stop and restart runs at the first tick,
// as in C4.

import pg from "pg";
import { z } from "zod";
import { dbNowMs, openScenario } from "../kit.ts";
import type { CriterionResult, Replica, RunContext, Scenario } from "../kit.ts";
import { sleep } from "../proc.ts";
import { MINUTE, boardKey, judgeFires, percentile } from "../scenarios/schedule-judge.ts";
import { SCHEDULE_FIRE_WORKFLOW, createDbosProducer, migrateDbos } from "./jobs.ts";

export const id = "D4";
export const criterion = "C4 on DBOS: 200 schedules created at runtime each fire once per tick while replicas restart.";

const STRAND_CHECK_MS = 3_000;
const STRIKE_GAP_MS = 25_000;
/** DBOS has no expiry on a claim: with per-process executor IDs this is how long the run waits for a stranded fire. */
const ORPHAN_WAIT_MS = 60_000;

const fireSchema = z.object({
  schedule_key: z.string(),
  job_id: z.string(),
  replica_id: z.string(),
  created_ms: z.coerce.number(),
});

const pollSchema = z.object({ queued: z.number(), active_ids: z.array(z.string()) });

const workflowRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  executor_id: z.string().nullable(),
  recovery_attempts: z.coerce.number(),
});

type Strike = {
  readonly label: string;
  readonly kind: "hunt" | "tick-edge";
  readonly killedAt: number;
  readonly victims: readonly string[];
  readonly victimExecutors: readonly string[];
  readonly survivor: string;
  readonly activeAtKill: number;
  readonly activeAfterKill: number;
  readonly activeAfter3s: number;
  readonly strandedIds: readonly string[];
};

export const run = async (ctx: RunContext): Promise<CriterionResult> => {
  const scheduleCount = ctx.settings.SPIKE_SCHEDULE_COUNT;
  const ticks = ctx.settings.SPIKE_SCHEDULE_TICKS;
  const huntTarget = ctx.settings.SPIKE_SCHEDULE_HUNT_KILLS;
  const executorMode = ctx.settings.SPIKE_DBOS_EXECUTOR_ID;
  const scenario: Scenario = await openScenario(ctx, "d4_schedules");
  const { db } = scenario;
  const actions: string[] = [];
  const hunter = new pg.Client({ connectionString: db.url });
  hunter.on("error", () => {
    // The scenario ends by closing this connection, or the cluster went away. Nothing to do.
  });
  try {
    await hunter.connect();

    const slots: (Replica | undefined)[] = [undefined, undefined, undefined];
    const executors: string[] = ["", "", ""];
    const generation = [0, 0, 0];
    const spawnSlot = (slot: number): Replica => {
      generation[slot] = (generation[slot] ?? 0) + 1;
      const replicaId = `replica-${String(slot + 1)}-g${String(generation[slot])}`;
      const executorId = executorMode === "slot" ? `replica-${String(slot + 1)}` : replicaId;
      executors[slot] = executorId;
      return scenario.spawnDbosReplica(replicaId, {
        executorId,
        workers: ["scheduleFire"],
        partitionConcurrency: 2,
        workerConcurrency: 16,
        pollingIntervalMs: 500,
      });
    };
    const waitReady = async (replica: Replica): Promise<Replica> => {
      const message = await replica.child.waitForMessage((m) => m.type === "ready" || m.type === "fatal", 120_000, "ready");
      if (message.type === "fatal") {
        throw new Error(`${replica.id} failed to start: ${message.error}`);
      }
      return replica;
    };
    const startSlot = async (slot: number): Promise<void> => {
      slots[slot] = await waitReady(spawnSlot(slot));
    };
    const aliveSlots = (): number[] => [0, 1, 2].filter((slot) => slots[slot]?.isAlive() === true);

    // DBOS's schema first, once (see migrateDbos): concurrent launches on a cold database deadlock.
    await migrateDbos(db.url);
    const booting = [0, 1, 2].map((slot) => spawnSlot(slot));
    for (const [slot, replica] of booting.entries()) {
      slots[slot] = await waitReady(replica);
    }
    // The panel's role: a client that creates schedules at runtime and never launches DBOS.
    const producer = await createDbosProducer(db.url);

    const createdAt = Date.now();
    const beforeCreate = await dbNowMs(db);
    for (let index = 0; index < scheduleCount; index += 1) {
      const board = boardKey(index);
      await producer.createSchedule(board, "* * * * *", { board, variant: "plain" });
    }
    ctx.note(`${String(scheduleCount)} DBOS schedules created at runtime in ${((Date.now() - createdAt) / 1000).toFixed(1)} s`);

    const now = await dbNowMs(db);
    const clockOffset = now - Date.now();
    const dbClock = (): number => Date.now() + clockOffset;
    const t0 = Math.ceil((now + 90_000) / MINUTE) * MINUTE;
    const tickTime = (tick: number): number => t0 + tick * MINUTE;
    const lastTick = tickTime(ticks - 1);
    const runEnd = t0 + ticks * MINUTE;
    ctx.note(`first tick in ${((t0 - now) / 1000).toFixed(0)} s, then ${String(ticks - 1)} more`);
    const rel = (absoluteMs: number): string => {
      const sinceT0 = (absoluteMs - t0) / 1000;
      return `${sinceT0 >= 0 ? "+" : ""}${sinceT0.toFixed(1)} s from the first tick`;
    };
    const until = async (absoluteMs: number): Promise<void> => {
      const wait = absoluteMs - dbClock();
      if (wait > 0) {
        await sleep(wait);
      }
    };

    const poll = async (): Promise<{ readonly queued: number; readonly activeIds: readonly string[] }> => {
      const result = await hunter.query(
        `SELECT (count(*) FILTER (WHERE status = 'ENQUEUED'))::int AS queued,
                COALESCE(array_agg(workflow_uuid) FILTER (WHERE status = 'PENDING'), '{}') AS active_ids
           FROM dbos.workflow_status
          WHERE name = $1 AND status IN ('ENQUEUED', 'PENDING')`,
        [SCHEDULE_FIRE_WORKFLOW],
      );
      const rows: unknown = result.rows;
      const row = z.array(pollSchema).parse(rows)[0];
      return { queued: row?.queued ?? 0, activeIds: row?.active_ids ?? [] };
    };
    const workflows = (ids: readonly string[]) =>
      db.query(
        "SELECT workflow_uuid AS id, status, executor_id, recovery_attempts FROM dbos.workflow_status WHERE workflow_uuid = ANY($1::text[])",
        [ids],
        workflowRowSchema,
      );

    const strikes: Strike[] = [];
    const knownStranded = new Set<string>();
    let lastStrikeEnd = 0;

    const strike = async (activeIds: readonly string[], kind: Strike["kind"]): Promise<void> => {
      const alive = aliveSlots();
      const keep = alive[strikes.length % alive.length];
      const victims = alive.filter((slot) => slot !== keep);
      const victimReplicas = victims.flatMap((slot) => {
        const replica = slots[slot];
        return replica === undefined ? [] : [replica];
      });
      const survivor = keep === undefined ? undefined : slots[keep];
      if (victimReplicas.length === 0 || survivor === undefined) {
        return;
      }
      const victimExecutors = victims.map((slot) => executors[slot] ?? "");
      const killedAt = dbClock();
      await Promise.all(victimReplicas.map((replica) => replica.kill9()));
      const afterKill = activeIds.length === 0 ? [] : await workflows(activeIds);
      await sleep(STRAND_CHECK_MS);
      const later = activeIds.length === 0 ? [] : await workflows(activeIds);
      const stranded = later.filter((row) => row.status === "PENDING").map((row) => row.id);
      const record: Strike = {
        label: `${kind === "hunt" ? "strike" : "tick-edge strike"} ${String(strikes.length + 1)} at ${rel(killedAt)}`,
        kind,
        killedAt,
        victims: victimReplicas.map((replica) => replica.id),
        victimExecutors,
        survivor: survivor.id,
        activeAtKill: activeIds.length,
        activeAfterKill: afterKill.filter((row) => row.status === "PENDING").length,
        activeAfter3s: stranded.length,
        strandedIds: stranded,
      };
      strikes.push(record);
      for (const strandedId of stranded) {
        knownStranded.add(strandedId);
      }
      const owners = new Set(later.filter((row) => row.status === "PENDING").map((row) => row.executor_id ?? "none"));
      actions.push(
        `${record.label}: SIGKILL ${record.victims.join(" and ")} (kept ${record.survivor}) with ${String(record.activeAtKill)} fires PENDING; ${String(record.activeAfterKill)} still PENDING right after, ${String(record.activeAfter3s)} 3 s later${stranded.length > 0 ? ` (held by ${[...owners].join(", ")})` : ""}`,
      );
      ctx.note(actions[actions.length - 1] ?? record.label);
      await Promise.all(victims.map((slot) => startSlot(slot)));
      lastStrikeEnd = dbClock();
    };

    const huntEnd = lastTick + 35_000;
    const edgeTick = ticks >= 3 ? 2 : ticks - 1;
    let gracefulDone = false;
    let edgeDone = false;
    for (;;) {
      const at = dbClock();
      if (at >= huntEnd) {
        break;
      }
      if (!gracefulDone && at >= tickTime(0) + 8_000) {
        const replica = slots[0];
        if (replica !== undefined && replica.isAlive() && aliveSlots().length > 1) {
          actions.push(`tick 0: graceful stop ${replica.id}`);
          await replica.stop();
        }
        if (slots[0]?.isAlive() !== true) {
          await startSlot(0);
        }
        gracefulDone = true;
        continue;
      }
      if (!edgeDone && at >= tickTime(edgeTick) - 1_500 && aliveSlots().length >= 2) {
        // Aim at the leader's enqueue: 5 ms after the tick, while it writes the tick's 200 rows.
        await until(tickTime(edgeTick) + 5);
        await strike([], "tick-edge");
        edgeDone = true;
        continue;
      }
      const huntStrikes = strikes.filter((record) => record.kind === "hunt");
      const strandingStrikes = huntStrikes.filter((record) => record.activeAfter3s > 0).length;
      if (strandingStrikes < huntTarget && huntStrikes.length < huntTarget * 3 && aliveSlots().length >= 2 && at - lastStrikeEnd >= STRIKE_GAP_MS) {
        const seen = await poll();
        const fresh = seen.activeIds.filter((activeId) => !knownStranded.has(activeId));
        if (fresh.length > 0) {
          await strike(fresh, "hunt");
          continue;
        }
        await sleep(seen.queued > 0 ? 3 : 60);
      } else {
        await sleep(250);
      }
    }
    for (const slot of [0, 1, 2]) {
      if (slots[slot]?.isAlive() !== true) {
        await startSlot(slot);
      }
    }

    await until(lastTick + 50_000);
    for (let index = 0; index < scheduleCount; index += 1) {
      await producer.deleteSchedule(boardKey(index));
    }
    await producer.destroy();
    await until(runEnd + 5_000);

    // Stranded fires: recovered at once when their executor ID came back; otherwise wait a while.
    const strandedIds = [...knownStranded];
    let openStranded = strandedIds.length === 0 ? [] : (await workflows(strandedIds)).filter((row) => row.status !== "SUCCESS");
    if (openStranded.length > 0) {
      ctx.note(`${String(openStranded.length)} stranded fires still not finished; waiting up to ${String(ORPHAN_WAIT_MS / 1000)} s`);
      const waitStarted = Date.now();
      while (openStranded.length > 0 && Date.now() - waitStarted < ORPHAN_WAIT_MS) {
        await sleep(5_000);
        openStranded = (await workflows(strandedIds)).filter((row) => row.status !== "SUCCESS");
      }
    }

    const handlerRuns = await db.query(
      `SELECT f.schedule_key, f.job_id, f.replica_id, w.created_at::float8 AS created_ms
         FROM schedule_fire f JOIN dbos.workflow_status w ON w.workflow_uuid = f.job_id
        ORDER BY f.id`,
      [],
      fireSchema,
    );
    const judged = judgeFires({
      handlerRuns: handlerRuns.map((row) => ({ scheduleKey: row.schedule_key, jobId: row.job_id, replicaId: row.replica_id, createdMs: row.created_ms })),
      t0,
      ticks,
      scheduleCount,
      beforeCreate,
      variantOf: () => "plain",
    });
    const { fires, redelivered, warmUp, lateFires, latencies, stats, occurrencesBeforeT0, warmUpOverFires, missed, doubled, problems } = judged;

    const created = await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'SUCCESS')::int AS succeeded,
              count(*) FILTER (WHERE recovery_attempts > 1)::int AS restarted,
              count(DISTINCT schedule_name)::int AS schedules
         FROM dbos.workflow_status WHERE name = $1`,
      [SCHEDULE_FIRE_WORKFLOW],
      z.object({ total: z.number(), succeeded: z.number(), restarted: z.number(), schedules: z.number() }),
    );
    const strandedFinal = strandedIds.length === 0 ? [] : await workflows(strandedIds);

    const huntStrikes = strikes.filter((record) => record.kind === "hunt");
    const stranded = huntStrikes.filter((record) => record.activeAfter3s > 0);
    const failures: string[] = [];
    if (missed > 0) {
      failures.push(`${String(missed)} (schedule, tick) pairs did not fire in their tick`);
    }
    if (doubled > 0) {
      failures.push(`${String(doubled)} (schedule, tick) pairs fired more than once`);
    }
    if (warmUpOverFires > 0) {
      failures.push(`${String(warmUpOverFires)} schedules fired more often than they had occurrences before the first tick`);
    }
    // A fire created after the run is late or repeated, unless it is the tick that came due after the schedules
    // were deleted: DBOS's scheduler rereads the schedule table every schedulerPollingIntervalMs (30 s by default),
    // so a deleted schedule can still fire one tick. Its workflow ID names its tick (`sched-<name>-<tick ISO>`).
    const firedTick = (jobId: string): number => {
      const match = /(\d{4}-\d\d-\d\dT[\d:.]+Z)$/.exec(jobId);
      return match?.[1] === undefined ? Number.NaN : Date.parse(match[1]);
    };
    const afterRun = fires.filter((fire) => fire.createdMs >= runEnd);
    const afterDeletion = afterRun.filter((fire) => firedTick(fire.jobId) >= runEnd);
    const lateOrRepeated = afterRun.length - afterDeletion.length;
    if (lateOrRepeated > 0) {
      failures.push(`${String(lateOrRepeated)} fires of in-run ticks were created after the run, late or repeated`);
    }

    const configLabel = `DBOS ${executorMode === "slot" ? "with a stable executor ID per replica slot" : "with a new executor ID per process"}`;
    const evidence = [
      `${String(scheduleCount)} schedules x ${String(ticks)} ticks = ${String(scheduleCount * ticks)} expected fires; ${String(stats.plain.exact)} fired exactly once, ${String(missed)} missed, ${String(doubled)} fired twice or more`,
      `configuration: ${configLabel} (SPIKE_DBOS_EXECUTOR_ID=${executorMode}); applicationVersion pinned; no Conductor, no Enterprise package; every schedule has DBOS's default options (no per-schedule option to vary: the tick's workflow ID is what dedupes)`,
      `kill window: ${String(huntStrikes.length)} hunt kills issued while fires were PENDING (the hunt wants ${String(huntTarget)} that strand some and tries at most ${String(huntTarget * 3)}); ${String(stranded.length)} stranded fires (still PENDING 3 s later, held by a killed executor)`,
      ...strikes.map(
        (record) =>
          `${record.label}: killed ${record.victims.join(" and ")} (executors ${record.victimExecutors.join(", ")}), kept ${record.survivor}; ${String(record.activeAtKill)} fires PENDING at the kill, ${String(record.activeAfterKill)} right after, ${String(record.activeAfter3s)} 3 s later`,
      ),
      `stranded fires: ${String(strandedIds.length)}; at the end ${String(strandedFinal.filter((row) => row.status === "SUCCESS").length)} had succeeded (recovered by a process under the same executor ID), ${String(strandedFinal.filter((row) => row.status !== "SUCCESS").length)} had not (statuses ${[...new Set(strandedFinal.map((row) => `${row.status}/${row.executor_id ?? "none"}`))].slice(0, 4).join(", ") || "none"})`,
      `fire latency after the tick (workflow created_at): p50 ${(percentile(latencies, 50) / 1000).toFixed(2)} s, p95 ${(percentile(latencies, 95) / 1000).toFixed(2)} s, max ${(percentile(latencies, 100) / 1000).toFixed(2)} s`,
      `DBOS's scheduled workflows: ${String(created[0]?.total ?? 0)} created for ${String(created[0]?.schedules ?? 0)} schedules, ${String(created[0]?.succeeded ?? 0)} succeeded, ${String(created[0]?.restarted ?? 0)} started more than once (recovered after a kill)`,
      `replica restarts while the schedules ran: ${actions.join("; ")}`,
      `${String(fires.length)} fires (workflows created and run) in all, from ${String(handlerRuns.length)} handler runs: ${String(redelivered)} runs repeated a workflow after a kill (at-least-once execution, not a second fire); ${String(warmUp)} fires before the first tick (the limit is ${String(occurrencesBeforeT0)} per schedule) and ${String(lateFires.length)} after the run: ${String(lateOrRepeated)} of them for a tick inside the run (late or repeated), ${String(afterDeletion.length)} for the tick after the run, which fired ${afterDeletion.length === 0 ? "" : `${(Math.min(...afterDeletion.map((fire) => fire.createdMs - firedTick(fire.jobId))) / 1000).toFixed(2)} s after it `}although every schedule had been deleted ${String((runEnd - (lastTick + 50_000)) / 1000)} s before it (DBOS's scheduler rereads its schedules every 30 s)`,
    ];
    evidence.push(...problems.map((problem) => `example: ${problem}`));

    const qualifier =
      stranded.length < huntTarget
        ? `kill window under-exercised: ${String(stranded.length)} of ${String(huntTarget)} target kills stranded fires (${String(huntStrikes.length)} tried)`
        : undefined;
    return {
      id,
      criterion,
      verdict: failures.length === 0 ? "PASS" : "FAIL",
      ...(failures.length === 0 && qualifier !== undefined ? { qualifier } : {}),
      summary:
        failures.length === 0
          ? `Every one of ${String(scheduleCount)} runtime DBOS schedules fired exactly once in each of ${String(ticks)} ticks across a graceful restart, ${String(huntStrikes.length)} SIGKILLs timed to land while fires were claimed, and one at a tick's boundary (${configLabel}).`
          : `${failures.join("; ")} (${configLabel})`,
      evidence,
    };
  } finally {
    await hunter.end().catch(() => undefined);
    await scenario.dispose();
  }
};
