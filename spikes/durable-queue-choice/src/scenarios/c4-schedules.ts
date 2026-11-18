// C4. 200 schedules created at runtime each fire once per tick while replicas restart.
//
// The panel creates 200 schedules at runtime (cron "* * * * *", one per board; every second one
// also carries a singleton key and a 60 s slot on the jobs it creates, the guarded variant). Three
// replicas run the schedule pass and a worker that records each fired job.
//
// How pg-boss fires a schedule matters for the kill: every 30 s one replica's pass inserts each due
// occurrence into an internal queue, `__pgboss__send-it`, and every replica polls that queue (every
// 5 s, 50 jobs at a time) and creates the real job for each occurrence it fetched. That queue has no
// heartbeat, so a replica killed while it holds a batch leaves those occurrences `active` until the
// 15-minute expiry. A kill timed at "tick + 0.3 s" does not reach that window, which lasts tens of
// milliseconds a minute, so this scenario hunts it:
//
//   - a dedicated connection polls the forwarding queue back to back while occurrences wait or are
//     being forwarded, and the moment a batch is `active` it kills every replica but one. pg-boss
//     does not say which replica holds a batch, so the survivor rotates, and the holder is among the
//     killed with probability 2/3 when three replicas are up;
//   - it re-reads the batch 3 s later: still `active` means the holder was among the killed and the
//     batch is stranded; completed means a survivor held it. Batches already stranded are never
//     mistaken for a new one, and strikes are at least 25 s apart so each meets a different burst;
//   - it repeats on later batches until SPIKE_SCHEDULE_HUNT_KILLS (3) strikes stranded a batch, or
//     three times that many were tried. Fewer stranded than that is reported on the summary line as
//     an under-exercised window.
//
// One graceful stop and restart (a rolling deploy) runs at the first tick as well. After the last
// tick the schedules are removed, and if a batch was stranded the scenario waits for pg-boss to
// free it (SPIKE_STRAND_WAIT_MINUTES, 17) and counts what the replay does: occurrences delivered
// late, and occurrences fired a second time.
//
// Judged (schedule-judge.ts, shared with D4 on DBOS): every one of the 200 schedules fired exactly
// once in every tick; before the first tick a schedule fired no more often than it had occurrences
// (a new schedule fires once for an occurrence up to 60 s old, the warm-up fire); and a replayed
// batch made no second fire.
//
// The fix under test (both knobs; neither changes what is judged):
//   SPIKE_SEND_IT_HEARTBEAT_SECONDS=10  every replica puts a heartbeat on the forwarding queue, so a
//                                       killed holder's batch is retried within seconds, not 15 minutes;
//   SPIKE_SCHEDULE_GUARD=all            every schedule carries a singleton key and a 60 s slot, so the
//                                       retried batch cannot create a second job in the same minute.

import pg from "pg";
import { z } from "zod";
import { dbNowMs, openScenario } from "../kit.ts";
import type { CriterionResult, Replica, RunContext, Scenario } from "../kit.ts";
import { sleep } from "../proc.ts";
import { MINUTE, judgeFires, percentile } from "./schedule-judge.ts";

export const id = "C4";
export const criterion = "200 schedules created at runtime each fire once per tick while replicas restart.";

const FORWARDING_QUEUE = "__pgboss__send-it";
/** How long after a kill the batch is read again to tell a stranded batch from one a survivor finished. */
const STRAND_CHECK_MS = 3_000;
/** The least time between two strikes, so that each one meets a different forwarding burst (the pass runs every 30 s). */
const STRIKE_GAP_MS = 25_000;

const fireSchema = z.object({
  schedule_key: z.string(),
  variant: z.string(),
  job_id: z.string(),
  replica_id: z.string(),
  created_ms: z.number(),
});

const pollSchema = z.object({ queued: z.number(), active_ids: z.array(z.string()) });

const forwardedSchema = z.object({
  id: z.string(),
  state: z.string(),
  retry_count: z.number(),
  key: z.string().nullable(),
  slot: z.string().nullable(),
});

/** One kill issued while a forwarding batch was active. */
type Strike = {
  readonly label: string;
  /** The database clock at the kill. */
  readonly killedAt: number;
  readonly victims: readonly string[];
  readonly survivor: string;
  /** Forwarding jobs in state `active` when the poll saw them. */
  readonly activeAtKill: number;
  /** Of those, how many were still `active` right after the kill, and 3 s later. */
  readonly activeAfterKill: number;
  readonly activeAfter3s: number;
  /** The ids still active 3 s later: the stranded batch. */
  readonly strandedIds: readonly string[];
};

export const run = async (ctx: RunContext): Promise<CriterionResult> => {
  const scheduleCount = ctx.settings.SPIKE_SCHEDULE_COUNT;
  const ticks = ctx.settings.SPIKE_SCHEDULE_TICKS;
  const huntTarget = ctx.settings.SPIKE_SCHEDULE_HUNT_KILLS;
  const strandWaitMs = ctx.settings.SPIKE_STRAND_WAIT_MINUTES * MINUTE;
  const scenario: Scenario = await openScenario(ctx, "c4_schedules");
  const { db } = scenario;
  const actions: string[] = [];
  const hunter = new pg.Client({ connectionString: db.url });
  hunter.on("error", () => {
    // The scenario ends by closing this connection, or the cluster went away. Nothing to do.
  });
  try {
    await hunter.connect();

    // The experiment knob: a shorter expiry on pg-boss's forwarding queue, on every replica. Absent: pg-boss's default.
    const forwardingExpireSeconds = ctx.settings.SPIKE_SEND_IT_EXPIRE_SECONDS;
    const forwardingHeartbeatSeconds = ctx.settings.SPIKE_SEND_IT_HEARTBEAT_SECONDS;
    const guard = ctx.settings.SPIKE_SCHEDULE_GUARD;
    const replicaOverrides = {
      ...(forwardingExpireSeconds === undefined ? {} : { forwardingExpireSeconds }),
      ...(forwardingHeartbeatSeconds === undefined ? {} : { forwardingHeartbeatSeconds }),
    };
    const slots: (Replica | undefined)[] = [undefined, undefined, undefined];
    const generation = [0, 0, 0];
    const startSlot = async (slot: number): Promise<void> => {
      generation[slot] = (generation[slot] ?? 0) + 1;
      slots[slot] = await scenario.startReplica(`replica-${String(slot + 1)}-g${String(generation[slot])}`, ["scheduleFire"], replicaOverrides);
    };
    const aliveSlots = (): number[] => [0, 1, 2].filter((slot) => slots[slot]?.isAlive() === true);

    // Cold database, three replicas booting at once.
    const booting = [0, 1, 2].map((slot) => {
      generation[slot] = 1;
      return scenario.spawnReplica(`replica-${String(slot + 1)}-g1`, ["scheduleFire"], replicaOverrides);
    });
    for (const [slot, replica] of booting.entries()) {
      const message = await replica.child.waitForMessage((m) => m.type === "ready" || m.type === "fatal", 90_000, "ready");
      if (message.type === "fatal") {
        throw new Error(`${replica.id} failed to start: ${message.error}`);
      }
      slots[slot] = replica;
    }
    const panel = await scenario.startPanel("panel-1");

    const createdAt = Date.now();
    const beforeCreate = await dbNowMs(db);
    await panel.call({ type: "create-schedules", count: scheduleCount, cron: "* * * * *", guard }, { timeoutMs: 180_000 });
    ctx.note(`${String(scheduleCount)} schedules created at runtime in ${((Date.now() - createdAt) / 1000).toFixed(1)} s`);

    const now = await dbNowMs(db);
    const clockOffset = now - Date.now();
    const dbClock = (): number => Date.now() + clockOffset;
    // A new schedule fires once for an occurrence up to 60 s old, on the first pass after it is
    // created, and the forwarded jobs take a few poll intervals to drain. The first tick is judged
    // only after that warm-up is over.
    const t0 = Math.ceil((now + 90_000) / MINUTE) * MINUTE;
    const tickTime = (tick: number): number => t0 + tick * MINUTE;
    const lastTick = tickTime(ticks - 1);
    const runEnd = t0 + ticks * MINUTE;
    ctx.note(`first tick in ${((t0 - now) / 1000).toFixed(0)} s, then ${String(ticks - 1)} more; about ${(((lastTick - now) + 80_000) / 60_000).toFixed(1)} minutes in all`);
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

    // What the forwarding queue holds: jobs waiting, and the ids of those being worked.
    const poll = async (): Promise<{ readonly queued: number; readonly activeIds: readonly string[] }> => {
      const result = await hunter.query(
        `SELECT (count(*) FILTER (WHERE state IN ('created', 'retry')))::int AS queued,
                COALESCE(array_agg(id::text) FILTER (WHERE state = 'active'), '{}') AS active_ids
           FROM pgboss.job
          WHERE name = $1 AND state IN ('created', 'retry', 'active')`,
        [FORWARDING_QUEUE],
      );
      const rows: unknown = result.rows;
      const row = z.array(pollSchema).parse(rows)[0];
      return { queued: row?.queued ?? 0, activeIds: row?.active_ids ?? [] };
    };
    const forwardedJobs = (ids: readonly string[]) =>
      db.query(
        "SELECT id::text AS id, state, retry_count, data->>'key' AS key, data->>'slot' AS slot FROM pgboss.job WHERE name = $1 AND id = ANY($2::uuid[])",
        [FORWARDING_QUEUE, ids],
        forwardedSchema,
      );

    const stopGracefully = async (slot: number, label: string): Promise<void> => {
      const replica = slots[slot];
      if (replica === undefined || !replica.isAlive() || aliveSlots().length <= 1) {
        return;
      }
      actions.push(`${label}: graceful stop ${replica.id}`);
      await replica.stop();
    };

    const strikes: Strike[] = [];
    /** Jobs a strike stranded. They stay `active` for 15 minutes, so a poll must never take them for a new batch. */
    const knownStranded = new Set<string>();
    let lastStrikeEnd = 0;

    /** A forwarding batch is active: kill every replica but one, then see whether the batch is stranded. */
    const strike = async (activeIds: readonly string[]): Promise<void> => {
      const alive = aliveSlots();
      // pg-boss does not say which replica holds a batch, so the survivor rotates.
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
      const killedAt = dbClock();
      await Promise.all(victimReplicas.map((replica) => replica.kill9()));
      const afterKill = await forwardedJobs(activeIds);
      await sleep(STRAND_CHECK_MS);
      const later = await forwardedJobs(activeIds);
      const stranded = later.filter((row) => row.state === "active").map((row) => row.id);
      const record: Strike = {
        label: `strike ${String(strikes.length + 1)} at ${rel(killedAt)}`,
        killedAt,
        victims: victimReplicas.map((replica) => replica.id),
        survivor: survivor.id,
        activeAtKill: activeIds.length,
        activeAfterKill: afterKill.filter((row) => row.state === "active").length,
        activeAfter3s: stranded.length,
        strandedIds: stranded,
      };
      strikes.push(record);
      for (const strandedId of stranded) {
        knownStranded.add(strandedId);
      }
      actions.push(
        `${record.label}: SIGKILL ${record.victims.join(" and ")} (kept ${record.survivor}) with ${String(record.activeAtKill)} forwarding jobs active; ${String(record.activeAfterKill)} still active right after, ${String(record.activeAfter3s)} 3 s later`,
      );
      ctx.note(actions[actions.length - 1] ?? record.label);
      // Bring the killed replicas back, together.
      await Promise.all(victims.map((slot) => startSlot(slot)));
      lastStrikeEnd = dbClock();
    };

    // The hunt runs from now to 35 s after the last tick. A graceful stop and restart is part of it.
    const huntEnd = lastTick + 35_000;
    let gracefulDone = false;
    for (;;) {
      const at = dbClock();
      if (at >= huntEnd) {
        break;
      }
      if (!gracefulDone && at >= tickTime(0) + 8_000) {
        await stopGracefully(0, "tick 0");
        if (slots[0]?.isAlive() !== true) {
          await startSlot(0);
        }
        gracefulDone = true;
        continue;
      }
      const strandingStrikes = strikes.filter((record) => record.activeAfter3s > 0).length;
      if (strandingStrikes < huntTarget && strikes.length < huntTarget * 3 && aliveSlots().length >= 2 && at - lastStrikeEnd >= STRIKE_GAP_MS) {
        const seen = await poll();
        const fresh = seen.activeIds.filter((activeId) => !knownStranded.has(activeId));
        if (fresh.length > 0) {
          await strike(fresh);
          continue;
        }
        // Tight while occurrences wait to be forwarded; relaxed otherwise.
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

    // Let the last tick's occurrences come through with every replica up, then stop the schedules so
    // that a fire after this point can only be a late or a replayed one.
    await until(lastTick + 50_000);
    await panel.call({ type: "remove-schedules", count: scheduleCount }, { timeoutMs: 180_000 });
    await until(runEnd + 5_000);

    // A stranded batch: wait for pg-boss to free it (it expires after 15 minutes), then for the replay.
    const strandedIds = [...knownStranded];
    let strandRecoveredAfterMs: number | undefined;
    let strandWaited = false;
    if (strandedIds.length > 0 && strandWaitMs > 0) {
      strandWaited = true;
      ctx.note(`${String(strandedIds.length)} forwarding jobs are stranded; waiting up to ${String(ctx.settings.SPIKE_STRAND_WAIT_MINUTES)} min for pg-boss to free them`);
      const waitStarted = Date.now();
      while (Date.now() - waitStarted < strandWaitMs) {
        const open = (await forwardedJobs(strandedIds)).filter((row) => row.state === "active" || row.state === "created" || row.state === "retry");
        if (open.length === 0) {
          strandRecoveredAfterMs = Date.now() - waitStarted;
          break;
        }
        await sleep(5_000);
      }
      // The replay forwards its occurrences, and the workers fire them.
      await sleep(20_000);
    }

    const handlerRuns = await db.query(
      "SELECT schedule_key, variant, job_id, replica_id, (extract(epoch from job_created) * 1000)::float8 AS created_ms FROM schedule_fire ORDER BY id",
      [],
      fireSchema,
    );
    const judged = judgeFires({
      handlerRuns: handlerRuns.map((run) => ({ scheduleKey: run.schedule_key, jobId: run.job_id, replicaId: run.replica_id, createdMs: run.created_ms })),
      t0,
      ticks,
      scheduleCount,
      beforeCreate,
      variantOf: (index) => (guard === "all" || index % 2 === 1 ? "guarded" : "plain"),
    });
    const { fires, redelivered, counts, preFires, warmUp, lateFires, latencies, stats, occurrencesBeforeT0, warmUpOverFires, missed, doubled, problems } = judged;

    // What the replay of a stranded batch did.
    const strandedRows = strandedIds.length === 0 ? [] : await forwardedJobs(strandedIds);
    let replayedDuplicates = 0;
    let deliveredLate = 0;
    let neverDelivered = 0;
    const delaysAfterTickS: number[] = [];
    const strandedByTick = new Map<string, number>();
    for (const row of strandedRows) {
      if (row.key === null || row.slot === null) {
        continue;
      }
      const slotMs = Date.parse(`${row.slot.replace(" ", "T")}Z`);
      const tick = Math.round((slotMs - t0) / MINUTE);
      const firedInRun = tick >= 0 && tick < ticks ? (counts.get(`${row.key}|${String(tick)}`) ?? 0) : (preFires.get(row.key) ?? 0);
      strandedByTick.set(tick < 0 ? "warm-up" : `tick ${String(tick)}`, (strandedByTick.get(tick < 0 ? "warm-up" : `tick ${String(tick)}`) ?? 0) + 1);
      const late = lateFires.filter((fire) => fire.key === row.key);
      if (firedInRun > 0 && late.length > 0) {
        replayedDuplicates += 1;
      } else if (firedInRun === 0 && late.length > 0) {
        deliveredLate += 1;
        delaysAfterTickS.push((Math.max(...late.map((fire) => fire.at)) - slotMs) / 1000);
      } else if (firedInRun === 0) {
        neverDelivered += 1;
      }
    }

    const sendIt = await db.query(
      "SELECT count(*)::int AS total, count(*) FILTER (WHERE retry_count > 0)::int AS retried, count(*) FILTER (WHERE state <> 'completed')::int AS open FROM pgboss.job WHERE name = $1",
      [FORWARDING_QUEUE],
      z.object({ total: z.number(), retried: z.number(), open: z.number() }),
    );
    // How long each stranded batch stayed out of play: from its strike to the replay's completion.
    const completions = strandedIds.length === 0
      ? []
      : await db.query(
          "SELECT id::text AS id, (extract(epoch from completed_on) * 1000)::float8 AS completed_ms FROM pgboss.job WHERE name = $1 AND id = ANY($2::uuid[])",
          [FORWARDING_QUEUE, strandedIds],
          z.object({ id: z.string(), completed_ms: z.number().nullable() }),
        );
    const completedAt = new Map(completions.map((row) => [row.id, row.completed_ms]));
    const strandDurations = strikes
      .filter((record) => record.strandedIds.length > 0)
      .map((record) => {
        const done = record.strandedIds.flatMap((strandedId) => {
          const value = completedAt.get(strandedId);
          return value === undefined || value === null ? [] : [value];
        });
        const latest = done.length === record.strandedIds.length ? Math.max(...done) : null;
        return `${record.label}: ${String(record.strandedIds.length)} stranded, ${latest === null ? "not all completed" : `all replayed and completed ${((latest - record.killedAt) / 1000).toFixed(1)} s after the kill`}`;
      });

    const plainCount = guard === "all" ? 0 : Math.ceil(scheduleCount / 2);
    const configLabel = [
      forwardingHeartbeatSeconds === undefined ? "pg-boss defaults on the forwarding queue" : `forwarding heartbeat ${String(forwardingHeartbeatSeconds)} s`,
      ...(forwardingExpireSeconds === undefined ? [] : [`forwarding expiry ${String(forwardingExpireSeconds)} s`]),
      guard === "all" ? "every schedule guarded" : "half the schedules guarded",
    ].join(", ");
    const attempts = strikes.length;
    const stranded = strikes.filter((record) => record.activeAfter3s > 0);
    const failures: string[] = [];
    delaysAfterTickS.sort((a, b) => a - b);
    if (missed > 0) {
      failures.push(
        `${String(missed)} (schedule, tick) pairs did not fire in their tick${deliveredLate > 0 ? ` (${String(deliveredLate)} of them fired late, ${((delaysAfterTickS[0] ?? 0) / 60).toFixed(1)} to ${((delaysAfterTickS[delaysAfterTickS.length - 1] ?? 0) / 60).toFixed(1)} minutes after it)` : ""}`,
      );
    }
    if (doubled > 0) {
      failures.push(`${String(doubled)} (schedule, tick) pairs fired more than once`);
    }
    if (warmUpOverFires > 0) {
      failures.push(`${String(warmUpOverFires)} schedules fired more often than they had occurrences before the first tick`);
    }
    if (replayedDuplicates > 0) {
      failures.push(`${String(replayedDuplicates)} occurrences fired a second time when pg-boss replayed a stranded forwarding batch`);
    }

    const underExercised = stranded.length < huntTarget;
    const hit = `${String(attempts)} kills issued while a forwarding batch was active (the hunt wants ${String(huntTarget)} that strand one and tries at most ${String(huntTarget * 3)}); ${String(stranded.length)} of them stranded the batch (the replica holding it was among the killed: it was still active 3 s later), ${String(attempts - stranded.length)} found it finished by a survivor`;

    const evidence = [
      `${String(scheduleCount)} schedules x ${String(ticks)} ticks = ${String(scheduleCount * ticks)} expected fires; ${String(stats.plain.exact + stats.guarded.exact)} fired exactly once, ${String(missed)} missed, ${String(doubled)} fired twice or more`,
      `configuration: forwarding queue heartbeat ${forwardingHeartbeatSeconds === undefined ? "none (pg-boss's default)" : `${String(forwardingHeartbeatSeconds)} s (SPIKE_SEND_IT_HEARTBEAT_SECONDS)`}, expiry ${forwardingExpireSeconds === undefined ? "900 s (pg-boss's default)" : `${String(forwardingExpireSeconds)} s (SPIKE_SEND_IT_EXPIRE_SECONDS)`}; guarded schedules: ${guard === "all" ? "all 200 (SPIKE_SCHEDULE_GUARD=all)" : "every second one (the default)"}`,
      `plain schedules (default options): ${String(stats.plain.exact)} of ${String(plainCount * ticks)} exact, ${String(stats.plain.missed)} missed, ${String(stats.plain.doubled)} doubled; guarded (singleton key + 60 s slot): ${String(stats.guarded.exact)} of ${String((scheduleCount - plainCount) * ticks)} exact, ${String(stats.guarded.missed)} missed, ${String(stats.guarded.doubled)} doubled`,
      `kill window: ${hit}`,
      ...strandDurations,
      ...strikes.map(
        (record) =>
          `${record.label}: killed ${record.victims.join(" and ")}, kept ${record.survivor}; ${String(record.activeAtKill)} forwarding jobs active at the kill, ${String(record.activeAfterKill)} right after, ${String(record.activeAfter3s)} 3 s later`,
      ),
      `fire latency after the tick: p50 ${(percentile(latencies, 50) / 1000).toFixed(1)} s, p95 ${(percentile(latencies, 95) / 1000).toFixed(1)} s, max ${(percentile(latencies, 100) / 1000).toFixed(1)} s`,
      `pg-boss's internal forwarding queue: ${String(sendIt[0]?.total ?? 0)} jobs, ${String(sendIt[0]?.retried ?? 0)} retried, ${String(sendIt[0]?.open ?? 0)} not completed`,
      `replica restarts while the schedules ran: ${actions.join("; ")}`,
      `${String(fires.length)} fires (jobs created) in all, from ${String(handlerRuns.length)} handler runs: ${String(redelivered)} runs repeated a job after a kill (at-least-once delivery, the C2 case, not a second fire); ${String(warmUp)} fires before the first tick (a new schedule fires for an occurrence up to 60 s old on the pass after it is created; no schedule exceeded its ${String(occurrencesBeforeT0)} occurrences) and ${String(lateFires.length)} after the run`,
    ];
    if (strandedIds.length > 0) {
      evidence.push(
        strandWaited
          ? `stranded forwarding batch (${String(strandedIds.length)} jobs): ${strandRecoveredAfterMs === undefined ? `still not freed after ${String(ctx.settings.SPIKE_STRAND_WAIT_MINUTES)} min` : `freed ${(strandRecoveredAfterMs / 1000).toFixed(0)} s after the run's end (an active job of this queue expires after ${forwardingExpireSeconds === undefined ? "15 minutes, pg-boss's default" : `${String(forwardingExpireSeconds)} s, set by the experiment knob`})`}; the stranded occurrences by tick: ${[...strandedByTick.entries()].map(([label, count]) => `${label} ${String(count)}`).join(", ")}; after the replay: ${String(deliveredLate)} occurrences delivered late (${((delaysAfterTickS[0] ?? 0) / 60).toFixed(1)} to ${((delaysAfterTickS[delaysAfterTickS.length - 1] ?? 0) / 60).toFixed(1)} minutes after their tick), ${String(replayedDuplicates)} fired a second time, ${String(neverDelivered)} not delivered; ${String(lateFires.length)} late fires in all; final states ${strandedRows.map((row) => `${row.state}/retry ${String(row.retry_count)}`).slice(0, 4).join(", ")}`
          : `stranded forwarding batch (${String(strandedIds.length)} jobs) was not waited for (SPIKE_STRAND_WAIT_MINUTES is 0), so its recovery is not measured`,
      );
    }
    if (forwardingExpireSeconds !== undefined) {
      evidence.push(`EXPERIMENT: the expiry of pg-boss's forwarding queue was set to ${String(forwardingExpireSeconds)} s on every replica (SPIKE_SEND_IT_EXPIRE_SECONDS); this is not pg-boss's default`);
    }
    evidence.push(...problems.map((problem) => `example: ${problem}`));

    const qualifier = underExercised
      ? `kill window under-exercised: ${String(stranded.length)} of ${String(huntTarget)} target kills stranded a forwarding batch (${String(attempts)} tried)`
      : undefined;

    return {
      id,
      criterion,
      verdict: failures.length === 0 ? "PASS" : "FAIL",
      ...(failures.length === 0 && qualifier !== undefined ? { qualifier } : {}),
      summary:
        failures.length === 0
          ? `Every one of ${String(scheduleCount)} runtime schedules fired exactly once in each of ${String(ticks)} ticks across a graceful restart and ${String(attempts)} SIGKILLs timed to land in an active forwarding batch (${configLabel}).`
          : `${failures.join("; ")} (${configLabel})`,
      evidence,
    };
  } finally {
    await hunter.end().catch(() => undefined);
    await scenario.dispose();
  }
};
