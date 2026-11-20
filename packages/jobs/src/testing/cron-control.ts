import path from "node:path";
import { fileURLToPath } from "node:url";

import { PgBoss } from "pg-boss";
import { z } from "zod";

import { FORWARDING_QUEUE } from "../definitions.ts";
import { replicaSet } from "./replicas.ts";
import type { ReplicaSet } from "./replicas.ts";

// The schedule hunt's control (milestone 6's ticket 37): spike 8's C4 hunt, ported
// (`spikes/durable-queue-choice/src/scenarios/c4-schedules.ts` and `schedule-judge.ts`), run on
// pg-boss's own cron with its defaults, doing the hunt's work: one start per (schedule, minute).
// Three replicas (`cron-control-replica.ts`) work `control.fire` and record each fire they get.
//
// pg-boss's cron pass puts each due occurrence on an internal queue, `__pgboss__send-it`, which a
// replica works 50 at a time. That queue has no heartbeat by default, so a replica killed while it
// holds a batch strands it for the queue's 15-minute expiry, and the replay sends again what was
// already sent. The batch is `active` for tens of milliseconds a minute, so the hunt polls that
// queue back to back and, the moment a batch is active, kills every replica but one (the survivor
// rotates, since pg-boss doesn't say which replica holds it). 3 s later a batch still `active` was
// stranded. After the last tick the schedules are removed, the hunt waits for pg-boss to free what
// it stranded, and counts each (schedule, minute)'s fires: a fire late or twice is the failure
// spike 8 found, which is what the control has to show.

const here = path.dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000;
const CONTROL_QUEUE = "control.fire";
const STRAND_CHECK_MS = 3_000;
const STRIKE_GAP_MS = 25_000;
const REPLICAS = ["control-1", "control-2", "control-3"] as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const boardKey = (index: number): string => `board-${String(index).padStart(3, "0")}`;

export type CronControlInput = {
  /** A database of its own, migrated or empty: the control's pg-boss schema and its `control_fire` table go there. Holds credentials: never logged. */
  readonly databaseUrl: string;
  readonly scheduleCount: number;
  readonly ticks: number;
  /** Strikes that strand a batch before the hunt stops; it tries at most three times that many. */
  readonly strandTarget: number;
  /** How long to wait for pg-boss to free a stranded batch: its expiry is 15 minutes. */
  readonly strandWaitMinutes: number;
  readonly logDir: string;
  readonly note: (line: string) => void;
};

export type CronControlStrike = {
  readonly label: string;
  readonly victims: readonly string[];
  readonly survivor: string;
  readonly activeAtKill: number;
  readonly activeAfter3s: number;
};

export type CronControlResult = {
  readonly expectedPairs: number;
  readonly exact: number;
  /** (schedule, tick) pairs with no fire in their tick: late or never. */
  readonly missed: number;
  /** (schedule, tick) pairs fired twice or more in their tick. */
  readonly doubled: number;
  /** Stranded occurrences fired again when pg-boss replayed their batch. */
  readonly replayedDuplicates: number;
  /** Schedules that fired more often than they had occurrences before the first tick. */
  readonly warmUpOverFires: number;
  readonly lateFires: number;
  readonly strikes: readonly CronControlStrike[];
  readonly stranded: number;
  /** The duplicate starts spike 8 found: a pair or an occurrence that started twice. */
  readonly duplicates: number;
  /** Whether the control failed, as pg-boss's own cron did in spike 8: something missed or doubled. */
  readonly failed: boolean;
  readonly evidence: readonly string[];
};

type Fire = { readonly key: string; readonly jobId: string; readonly createdMs: number };

/** Spike 8's judge (`schedule-judge.ts`), for one variant: each fire bucketed by when pg-boss created it. */
export const judgeControlFires = (input: {
  readonly runs: readonly Fire[];
  readonly t0: number;
  readonly ticks: number;
  readonly scheduleCount: number;
  readonly beforeCreate: number;
}) => {
  const { t0, ticks, scheduleCount, beforeCreate } = input;
  const runEnd = t0 + ticks * MINUTE;
  const seen = new Set<string>();
  // A handler that ran twice for one job after a kill is at-least-once delivery, not a second fire.
  const fires = input.runs.filter((run) => {
    if (seen.has(run.jobId)) {
      return false;
    }
    seen.add(run.jobId);
    return true;
  });
  const counts = new Map<string, number>();
  const preFires = new Map<string, number>();
  const lateFires: { readonly key: string; readonly at: number }[] = [];
  for (const fire of fires) {
    if (fire.createdMs < t0) {
      preFires.set(fire.key, (preFires.get(fire.key) ?? 0) + 1);
    } else if (fire.createdMs >= runEnd) {
      lateFires.push({ key: fire.key, at: fire.createdMs });
    } else {
      const pair = `${fire.key}|${String(Math.floor((fire.createdMs - t0) / MINUTE))}`;
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
  }
  const occurrencesBeforeT0 = Math.max(0, Math.ceil(t0 / MINUTE) - Math.floor((beforeCreate - MINUTE) / MINUTE) - 1);
  let exact = 0;
  let missed = 0;
  let doubled = 0;
  let warmUpOverFires = 0;
  const problems: string[] = [];
  for (let index = 0; index < scheduleCount; index += 1) {
    const board = boardKey(index);
    for (let tick = 0; tick < ticks; tick += 1) {
      const count = counts.get(`${board}|${String(tick)}`) ?? 0;
      if (count === 1) {
        exact += 1;
      } else if (count === 0) {
        missed += 1;
        if (problems.length < 6) problems.push(`${board} missed tick ${String(tick)}`);
      } else {
        doubled += 1;
        if (problems.length < 6) problems.push(`${board} fired ${String(count)} times in tick ${String(tick)}`);
      }
    }
    if ((preFires.get(board) ?? 0) > occurrencesBeforeT0) {
      warmUpOverFires += 1;
      if (problems.length < 6) problems.push(`${board} fired ${String(preFires.get(board) ?? 0)} times before the first tick, which had ${String(occurrencesBeforeT0)} occurrences`);
    }
  }
  return { fires, counts, preFires, lateFires, exact, missed, doubled, warmUpOverFires, occurrencesBeforeT0, problems };
};

const pollSchema = z.object({ queued: z.number(), active_ids: z.array(z.string()) });
const forwardedSchema = z.object({ id: z.string(), state: z.string(), key: z.string().nullable(), slot: z.string().nullable() });
const fireSchema = z.object({ schedule_key: z.string(), job_id: z.string(), created_ms: z.number() });

/** Runs the control and judges it. It ends every process it started. */
export const runCronControl = async (input: CronControlInput): Promise<CronControlResult> => {
  const { scheduleCount, ticks } = input;
  const replicas: ReplicaSet = replicaSet((name) => ({
    command: process.execPath,
    args: [path.join(here, "cron-control-replica.ts")],
    env: { ...process.env, CONTROL_DATABASE_URL: input.databaseUrl, CONTROL_REPLICA: name },
    ready: (line) => Reflect.get(Object(line), "ready") === name,
    logFile: path.join(input.logDir, `${name}.log`),
  }));
  let boss: PgBoss | null = null;
  try {
    // The first replica migrates pg-boss's schema and makes the queue; then the others.
    await replicas.start(REPLICAS[0]);
    boss = new PgBoss({ connectionString: input.databaseUrl, max: 4, migrate: false, supervise: false, schedule: false });
    boss.on("error", () => undefined);
    await boss.start();
    const db = boss.getDb();
    const rows = async <T>(sql: string, values: unknown[], schema: z.ZodType<T>): Promise<T[]> => {
      const result = await db.executeSql(sql, values);
      const raw: unknown = result.rows;
      return z.array(schema).parse(raw);
    };
    const dbNow = async (): Promise<number> => (await rows("SELECT (extract(epoch from now()) * 1000)::float8 AS ms", [], z.object({ ms: z.number() })))[0]?.ms ?? Date.now();
    await db.executeSql("CREATE TABLE IF NOT EXISTS control_fire (id bigserial PRIMARY KEY, schedule_key text NOT NULL, job_id uuid NOT NULL, replica text NOT NULL, job_created timestamptz NOT NULL)", []);
    await Promise.all(REPLICAS.slice(1).map((name) => replicas.start(name)));

    const beforeCreate = await dbNow();
    for (let index = 0; index < scheduleCount; index += 1) {
      await boss.schedule(CONTROL_QUEUE, "* * * * *", { board: boardKey(index) }, { key: boardKey(index) });
    }
    const now = await dbNow();
    const offset = now - Date.now();
    const dbClock = (): number => Date.now() + offset;
    const t0 = Math.ceil((now + 90_000) / MINUTE) * MINUTE;
    const lastTick = t0 + (ticks - 1) * MINUTE;
    const runEnd = t0 + ticks * MINUTE;
    input.note(`control: ${String(scheduleCount)} pg-boss schedules created at runtime; the first tick in ${String(Math.round((t0 - now) / 1000))} s, ${String(ticks)} ticks`);
    const rel = (at: number): string => `${at - t0 >= 0 ? "+" : ""}${((at - t0) / 1000).toFixed(1)} s from the first tick`;
    const until = async (at: number): Promise<void> => {
      const wait = at - dbClock();
      if (wait > 0) await sleep(wait);
    };
    const poll = async () => {
      const [row] = await rows(
        `SELECT (count(*) FILTER (WHERE state IN ('created', 'retry')))::int AS queued,
                COALESCE(array_agg(id::text) FILTER (WHERE state = 'active'), '{}') AS active_ids
           FROM pgboss.job WHERE name = $1 AND state IN ('created', 'retry', 'active')`,
        [FORWARDING_QUEUE],
        pollSchema,
      );
      return { queued: row?.queued ?? 0, activeIds: row?.active_ids ?? [] };
    };
    const forwarded = (ids: readonly string[]) =>
      rows("SELECT id::text AS id, state, data->>'key' AS key, data->>'slot' AS slot FROM pgboss.job WHERE name = $1 AND id = ANY($2::uuid[])", [FORWARDING_QUEUE, ids], forwardedSchema);

    const strikes: CronControlStrike[] = [];
    const knownStranded = new Set<string>();
    let lastStrikeEnd = 0;
    const huntEnd = lastTick + 35_000;
    while (dbClock() < huntEnd) {
      const strandedSoFar = strikes.filter((one) => one.activeAfter3s > 0).length;
      const alive = replicas.alive();
      if (strandedSoFar >= input.strandTarget || strikes.length >= input.strandTarget * 3 || alive.length < 2 || dbClock() - lastStrikeEnd < STRIKE_GAP_MS) {
        await sleep(250);
        continue;
      }
      const seen = await poll();
      const fresh = seen.activeIds.filter((id) => !knownStranded.has(id));
      if (fresh.length === 0) {
        await sleep(seen.queued > 0 ? 3 : 60);
        continue;
      }
      // A batch is being forwarded: every replica but one, the survivor rotating.
      const survivor = alive[strikes.length % alive.length] ?? REPLICAS[0];
      const victims = alive.filter((name) => name !== survivor);
      const killedAt = dbClock();
      await replicas.kill(victims);
      await sleep(STRAND_CHECK_MS);
      const stranded = (await forwarded(fresh)).filter((row) => row.state === "active").map((row) => row.id);
      for (const id of stranded) knownStranded.add(id);
      const strike: CronControlStrike = { label: `strike ${String(strikes.length + 1)} at ${rel(killedAt)}`, victims, survivor, activeAtKill: fresh.length, activeAfter3s: stranded.length };
      strikes.push(strike);
      input.note(`control: ${strike.label}: SIGKILL ${victims.join(" and ")} (kept ${survivor}) with ${String(strike.activeAtKill)} forwarding jobs active; ${String(strike.activeAfter3s)} still active 3 s later`);
      await Promise.all(victims.map((name) => replicas.start(name)));
      lastStrikeEnd = dbClock();
    }
    for (const name of REPLICAS) {
      if (replicas.get(name)?.alive() !== true) await replicas.start(name);
    }
    // The last tick with every replica up, then no schedules: a fire after this is late or replayed.
    await until(lastTick + 50_000);
    for (let index = 0; index < scheduleCount; index += 1) {
      await boss.unschedule(CONTROL_QUEUE, boardKey(index));
    }
    await until(runEnd + 5_000);
    const strandedIds = [...knownStranded];
    let freedAfterS: number | null = null;
    if (strandedIds.length > 0) {
      input.note(`control: ${String(strandedIds.length)} forwarding jobs stranded; waiting up to ${String(input.strandWaitMinutes)} min for pg-boss to free them`);
      const started = Date.now();
      while (Date.now() - started < input.strandWaitMinutes * MINUTE) {
        const open = (await forwarded(strandedIds)).filter((row) => ["active", "created", "retry"].includes(row.state));
        if (open.length === 0) {
          freedAfterS = Math.round((Date.now() - started) / 1000);
          break;
        }
        await sleep(5_000);
      }
      // The replay forwards its occurrences, and the workers fire them.
      await sleep(20_000);
    }

    const fires = await rows("SELECT schedule_key, job_id::text AS job_id, (extract(epoch from job_created) * 1000)::float8 AS created_ms FROM control_fire ORDER BY id", [], fireSchema);
    const judged = judgeControlFires({ runs: fires.map((row) => ({ key: row.schedule_key, jobId: row.job_id, createdMs: row.created_ms })), t0, ticks, scheduleCount, beforeCreate });
    // What the replay of each stranded occurrence did: a second fire, a late first fire, or nothing.
    let replayedDuplicates = 0;
    let deliveredLate = 0;
    for (const row of strandedIds.length === 0 ? [] : await forwarded(strandedIds)) {
      if (row.key === null || row.slot === null) continue;
      const tick = Math.round((Date.parse(`${row.slot.replace(" ", "T")}Z`) - t0) / MINUTE);
      const firedInRun = tick >= 0 && tick < ticks ? (judged.counts.get(`${row.key}|${String(tick)}`) ?? 0) : (judged.preFires.get(row.key) ?? 0);
      const late = judged.lateFires.filter((fire) => fire.key === row.key).length;
      if (firedInRun > 0 && late > 0) replayedDuplicates += 1;
      else if (firedInRun === 0 && late > 0) deliveredLate += 1;
    }
    const strandedStrikes = strikes.filter((one) => one.activeAfter3s > 0).length;
    const duplicates = judged.doubled + replayedDuplicates + judged.warmUpOverFires;
    const failed = judged.missed > 0 || duplicates > 0;
    const evidence = [
      `${String(scheduleCount)} pg-boss schedules x ${String(ticks)} ticks = ${String(scheduleCount * ticks)} pairs: ${String(judged.exact)} fired exactly once, ${String(judged.missed)} missed their tick, ${String(judged.doubled)} fired twice or more`,
      `${String(strikes.length)} kills while a forwarding batch was active, ${String(strandedStrikes)} of them stranded it (${String(strandedIds.length)} forwarding jobs); ${freedAfterS === null ? (strandedIds.length === 0 ? "nothing to free" : `not freed in ${String(input.strandWaitMinutes)} min`) : `freed ${String(freedAfterS)} s after the run's end`}`,
      `after the replay: ${String(replayedDuplicates)} occurrences fired a second time, ${String(deliveredLate)} fired late only; ${String(judged.lateFires.length)} late fires in all; ${String(judged.warmUpOverFires)} schedules over-fired before the first tick (${String(judged.occurrencesBeforeT0)} occurrences each)`,
      ...strikes.map((one) => `${one.label}: killed ${one.victims.join(" and ")}, kept ${one.survivor}; ${String(one.activeAtKill)} active at the kill, ${String(one.activeAfter3s)} 3 s later`),
      ...judged.problems.map((problem) => `example: ${problem}`),
    ];
    return {
      expectedPairs: scheduleCount * ticks,
      exact: judged.exact,
      missed: judged.missed,
      doubled: judged.doubled,
      replayedDuplicates,
      warmUpOverFires: judged.warmUpOverFires,
      lateFires: judged.lateFires.length,
      strikes,
      stranded: strandedIds.length,
      duplicates,
      failed,
      evidence,
    };
  } finally {
    await boss?.stop({ graceful: false, timeout: 2_000 }).catch(() => undefined);
    await replicas.killAll();
  }
};
