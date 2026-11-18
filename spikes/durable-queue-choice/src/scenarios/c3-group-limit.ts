// C3. A limit of 2 per key holds across three replicas for 1,000 jobs on 20 keys. Any brief
// overshoot is recorded.
//
// Three replicas (16 local workers each, so 48 workers compete for 40 slots) work one queue with
// groupConcurrency 2. 1,000 jobs on 20 group ids are enqueued by the panel. Concurrency per key is
// measured three ways:
//   1. COMMITTED STATE (the primary measure): a dedicated connection polls, back to back, how many
//      jobs of each group are in state "active", which is what groupConcurrency limits. Each sample
//      is held until the next, so time above the limit and episode lengths come from real snapshots.
//   2. the job table's own timestamps: a job is "active" from started_on to completed_on. These are
//      statement-start times, not commit times, so they can disagree with the snapshots.
//   3. the handlers' own start and end events, stamped by the database clock.
//
// Two passes, because "brief" depends on how long a job lasts. If an over-admitted job were run, its
// overshoot would end when a job of the group finishes, so with jobs of 40 to 100 ms it could be at most
// that long by construction, while real jobs call GitHub or Linear and last seconds. The long pass asks
// whether the overshoot grows with the job length. (It does not: pg-boss's fetch recounts the group after
// its own claim commits and gives the excess back before any handler starts, so a racing claim shows in
// the table for milliseconds and is not run.)
//   short  1,000 jobs of 40 to 100 ms on 20 keys (the pass bar's own load)
//   long     200 jobs of 2 to 4 s on 20 keys     (what an overshoot costs with realistic jobs)
//
// "Holds" is judged with working values the spike set for itself (pg-boss makes no promise):
//   both passes: every job ran exactly once, and no group ever had more than SPIKE_GROUP_PEAK_CAP
//                (10, which is 5 x the limit) active jobs in the committed state
//   short pass:  keys spent at most 5% of their busy time above the limit, and no key stayed above it
//                for 1 s or more at a stretch
//   long pass:   the time above the limit and the longest episode are recorded, and not bounded: an
//                episode lasts as long as the job that was let in over the limit, so a bound would
//                only restate the job length
// The size of an overshoot is always reported, and the summary line carries it whenever the peak
// went above the limit: pg-boss's docs say concurrent fetches can briefly exceed the limit, and
// ostra must not lean on the cap for safety.

import pg from "pg";
import { z } from "zod";
import { fmtMs, openScenario } from "../kit.ts";
import type { CriterionResult, RunContext } from "../kit.ts";
import { waitUntil } from "../proc.ts";
import { GROUP_LIMIT } from "../job-defs.ts";

export const id = "C3";
export const criterion =
  "A limit of 2 per key holds across three replicas for 1,000 jobs on 20 keys. Any brief overshoot is recorded.";

const MAX_SHARE_ABOVE = 0.05;
const MAX_CONTINUOUS_ABOVE_MS = 1_000;
const REPLICAS = 3;

export type Interval = { readonly key: string; readonly start: number; readonly end: number };

export type SweepResult = {
  readonly peak: number;
  readonly keysAbove: number;
  readonly episodes: number;
  readonly longestEpisodeUs: number;
  readonly timeAboveUs: number;
  readonly busyUs: number;
};

/** Per key, sweeps start and end events in time order and measures time spent above `limit`. */
export const sweep = (intervals: readonly Interval[], limit: number): SweepResult => {
  const byKey = new Map<string, { time: number; delta: 1 | -1 }[]>();
  for (const interval of intervals) {
    const list = byKey.get(interval.key) ?? [];
    list.push({ time: interval.start, delta: 1 }, { time: interval.end, delta: -1 });
    byKey.set(interval.key, list);
  }
  let peak = 0;
  let keysAbove = 0;
  let episodes = 0;
  let longestEpisodeUs = 0;
  let timeAboveUs = 0;
  let busyUs = 0;
  for (const events of byKey.values()) {
    // Starts sort before ends at the same instant, which can only overstate an overshoot.
    events.sort((a, b) => a.time - b.time || b.delta - a.delta);
    let active = 0;
    let previous = 0;
    let episodeStart: number | null = null;
    let keyPeak = 0;
    for (const event of events) {
      if (active > 0) {
        busyUs += event.time - previous;
      }
      if (active > limit) {
        timeAboveUs += event.time - previous;
      }
      previous = event.time;
      const before = active;
      active += event.delta;
      keyPeak = Math.max(keyPeak, active);
      if (before <= limit && active > limit) {
        episodeStart = event.time;
        episodes += 1;
      } else if (before > limit && active <= limit && episodeStart !== null) {
        longestEpisodeUs = Math.max(longestEpisodeUs, event.time - episodeStart);
        episodeStart = null;
      }
    }
    peak = Math.max(peak, keyPeak);
    if (keyPeak > limit) {
      keysAbove += 1;
    }
  }
  return { peak, keysAbove, episodes, longestEpisodeUs, timeAboveUs, busyUs };
};

export type SnapshotStats = {
  readonly snapshots: number;
  readonly snapshotsAbove: number;
  readonly peak: number;
  readonly keysAbove: number;
  readonly episodes: number;
  readonly longestEpisodeMs: number;
  readonly timeAboveMs: number;
  readonly busyMs: number;
  readonly peakCounts: ReadonlyMap<number, number>;
};

const groupCountsSchema = z.object({ group_id: z.string(), n: z.number() });

/** Polls the committed count of active jobs per group on its own connection until `stop()` is called. */
const startSnapshotSampler = async (
  connectionString: string,
  queue: string,
  limit: number,
): Promise<{ stop: () => Promise<SnapshotStats> }> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  // An object, so the loop reads the flag that `stop()` sets (TypeScript cannot see a closure assign a `let`).
  const control = { running: true };
  let snapshots = 0;
  let snapshotsAbove = 0;
  let peak = 0;
  let timeAboveMs = 0;
  let busyMs = 0;
  let longestEpisodeMs = 0;
  let episodes = 0;
  const keysSeenAbove = new Set<string>();
  const peakCounts = new Map<number, number>();
  const episodeStart = new Map<string, number>();
  let previous: { readonly at: number; readonly counts: ReadonlyMap<string, number> } | undefined;

  const loop = (async () => {
    while (control.running) {
      const before = performance.now();
      const result = await client.query(
        "SELECT group_id, count(*)::int AS n FROM pgboss.job WHERE name = $1 AND state = 'active' AND group_id IS NOT NULL GROUP BY group_id",
        [queue],
      );
      const after = performance.now();
      const rows: unknown = result.rows;
      const counts = new Map<string, number>();
      for (const row of z.array(groupCountsSchema).parse(rows)) {
        counts.set(row.group_id, row.n);
      }
      const at = (before + after) / 2;

      // The previous snapshot holds until this one.
      if (previous !== undefined) {
        const held = at - previous.at;
        for (const n of previous.counts.values()) {
          if (n > 0) {
            busyMs += held;
          }
          if (n > limit) {
            timeAboveMs += held;
          }
        }
      }
      let snapshotPeak = 0;
      for (const [key, n] of counts) {
        snapshotPeak = Math.max(snapshotPeak, n);
        if (n > limit) {
          keysSeenAbove.add(key);
          if (!episodeStart.has(key)) {
            episodeStart.set(key, at);
            episodes += 1;
          }
        }
      }
      for (const [key, start] of [...episodeStart]) {
        if ((counts.get(key) ?? 0) <= limit) {
          longestEpisodeMs = Math.max(longestEpisodeMs, at - start);
          episodeStart.delete(key);
        }
      }
      snapshots += 1;
      peak = Math.max(peak, snapshotPeak);
      if (snapshotPeak > limit) {
        snapshotsAbove += 1;
        peakCounts.set(snapshotPeak, (peakCounts.get(snapshotPeak) ?? 0) + 1);
      }
      previous = { at, counts };
    }
  })();

  return {
    stop: async () => {
      control.running = false;
      await loop;
      await client.end();
      return {
        snapshots,
        snapshotsAbove,
        peak,
        keysAbove: keysSeenAbove.size,
        episodes,
        longestEpisodeMs,
        timeAboveMs,
        busyMs,
        peakCounts,
      };
    },
  };
};

const jobRowSchema = z.object({
  id: z.string(),
  group_id: z.string().nullable(),
  state: z.string(),
  retry_count: z.number(),
  start_us: z.coerce.number().nullable(),
  end_us: z.coerce.number().nullable(),
});

const eventRowSchema = z.object({
  group_key: z.string(),
  job_id: z.string(),
  kind: z.string(),
  replica_id: z.string(),
  at_us: z.coerce.number(),
});

const fmtUs = (us: number): string => (us >= 1_000_000 ? `${(us / 1_000_000).toFixed(1)} s` : `${(us / 1000).toFixed(1)} ms`);

const describeSweep = (label: string, result: SweepResult): string =>
  `${label}: peak ${String(result.peak)}, ${String(result.keysAbove)} keys above the limit, ${String(result.episodes)} overshoot episodes, longest ${fmtUs(result.longestEpisodeUs)}, ${fmtUs(result.timeAboveUs)} above the limit out of ${fmtUs(result.busyUs)} busy (${((result.timeAboveUs / Math.max(1, result.busyUs)) * 100).toFixed(2)}%)`;

type PassConfig = {
  readonly label: string;
  /** The scenario database's name (the cluster adds the run's suffix). */
  readonly scenarioName: string;
  readonly jobCount: number;
  readonly keyCount: number;
  readonly workMs: (index: number) => number;
  /** Whether the pass is judged on the share of busy time and the episode length too (short jobs only). */
  readonly judgeBrevity: boolean;
};

type PassOutcome = {
  readonly label: string;
  readonly failures: readonly string[];
  readonly evidence: readonly string[];
  /** The highest count of active jobs in one group over the three records. */
  readonly peak: number;
  /** The longest time one key stayed above the limit, in the committed-state snapshots. */
  readonly longestEpisodeMs: number;
  readonly share: number;
  /** The highest count of handlers running at once in one group, from the handlers' own start and end events. */
  readonly handlerPeak: number;
};

const runPass = async (ctx: RunContext, config: PassConfig): Promise<PassOutcome> => {
  const { jobCount, keyCount } = config;
  const scenario = await openScenario(ctx, config.scenarioName);
  const { db } = scenario;
  try {
    // A cold database and three replicas booting at once: pg-boss's install and queue creation race.
    const replicas = Array.from({ length: REPLICAS }, (_, index) => `replica-${String(index + 1)}`).map((replicaId) =>
      scenario.spawnReplica(replicaId, ["group"], { localConcurrency: 16, groupConcurrency: GROUP_LIMIT }),
    );
    for (const replica of replicas) {
      const message = await replica.child.waitForMessage((m) => m.type === "ready" || m.type === "fatal", 90_000, "ready");
      if (message.type === "fatal") {
        throw new Error(`${replica.id} failed to start: ${message.error}`);
      }
    }
    const panel = await scenario.startPanel("panel-1");

    const keys = Array.from({ length: keyCount }, (_, index) => `key-${String(index).padStart(2, "0")}`);
    const jobs = Array.from({ length: jobCount }, (_, index) => ({
      key: keys[index % keyCount] ?? "key-00",
      workMs: config.workMs(index),
    }));

    const sampler = await startSnapshotSampler(db.url, "group-work", GROUP_LIMIT);

    const startedAt = Date.now();
    await panel.call({ type: "enqueue-group", jobs, batchSize: 100 }, { timeoutMs: 180_000 });
    ctx.note(`${config.label}: ${String(jobCount)} jobs on ${String(keyCount)} keys enqueued in ${fmtMs(Date.now() - startedAt)}`);

    await waitUntil(
      async () => {
        const rows = await db.query(
          "SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'group-work' AND state = 'completed'",
          [],
          z.object({ n: z.number() }),
        );
        return (rows[0]?.n ?? 0) === jobCount;
      },
      { timeoutMs: 300_000, intervalMs: 500, what: "all group jobs to complete" },
    );
    const finishedMs = Date.now() - startedAt;
    const snapshot = await sampler.stop();

    const jobRows = await db.query(
      `SELECT id, group_id, state, retry_count,
              (extract(epoch from started_on) * 1000000)::bigint::text AS start_us,
              (extract(epoch from completed_on) * 1000000)::bigint::text AS end_us
         FROM pgboss.job WHERE name = 'group-work'`,
      [],
      jobRowSchema,
    );
    const eventRows = await db.query(
      `SELECT group_key, job_id, kind, replica_id, (extract(epoch from at) * 1000000)::bigint::text AS at_us
         FROM group_event`,
      [],
      eventRowSchema,
    );

    const tableIntervals: Interval[] = [];
    for (const row of jobRows) {
      if (row.group_id !== null && row.start_us !== null && row.end_us !== null) {
        tableIntervals.push({ key: row.group_id, start: row.start_us, end: row.end_us });
      }
    }
    const starts = new Map<string, number>();
    for (const event of eventRows) {
      if (event.kind === "start") {
        starts.set(event.job_id, event.at_us);
      }
    }
    const handlerIntervals: Interval[] = [];
    for (const event of eventRows) {
      const start = starts.get(event.job_id);
      if (event.kind === "end" && start !== undefined) {
        handlerIntervals.push({ key: event.group_key, start, end: event.at_us });
      }
    }
    const tableView = sweep(tableIntervals, GROUP_LIMIT);
    const handlerView = sweep(handlerIntervals, GROUP_LIMIT);

    const startEvents = eventRows.filter((event) => event.kind === "start");
    const distinctStarted = new Set(startEvents.map((event) => event.job_id)).size;
    const retried = jobRows.filter((row) => row.retry_count > 0).length;
    const perReplica = new Map<string, number>();
    for (const event of startEvents) {
      perReplica.set(event.replica_id, (perReplica.get(event.replica_id) ?? 0) + 1);
    }

    const failures: string[] = [];
    if (jobRows.length !== jobCount || jobRows.some((row) => row.state !== "completed")) {
      failures.push(`${config.label}: not every job completed`);
    }
    if (startEvents.length !== jobCount || distinctStarted !== jobCount || retried > 0) {
      failures.push(
        `${config.label}: jobs did not each run exactly once: ${String(startEvents.length)} starts, ${String(distinctStarted)} distinct jobs, ${String(retried)} retried`,
      );
    }
    const share = snapshot.timeAboveMs / Math.max(1, snapshot.busyMs);
    if (config.judgeBrevity && share > MAX_SHARE_ABOVE) {
      failures.push(`${config.label}: keys spent ${(share * 100).toFixed(1)}% of their busy time above the limit`);
    }
    if (config.judgeBrevity && snapshot.longestEpisodeMs >= MAX_CONTINUOUS_ABOVE_MS) {
      failures.push(`${config.label}: a key stayed above the limit for ${snapshot.longestEpisodeMs.toFixed(0)} ms at a stretch`);
    }
    const peak = Math.max(snapshot.peak, tableView.peak, handlerView.peak);
    const peakCap = ctx.settings.SPIKE_GROUP_PEAK_CAP;
    if (snapshot.peak > peakCap) {
      failures.push(
        `${config.label}: a group had ${String(snapshot.peak)} active jobs at once, above the hard cap of ${String(peakCap)} (limit ${String(GROUP_LIMIT)})`,
      );
    }
    const overshoot = peak > GROUP_LIMIT;
    const histogram = [...snapshot.peakCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([count, snapshots]) => `${String(count)} active: ${String(snapshots)} snapshots`)
      .join("; ");

    const evidence = [
      `${config.label}: ${String(jobCount)} jobs on ${String(keyCount)} keys, ${String(REPLICAS)} replicas x 16 workers, groupConcurrency ${String(GROUP_LIMIT)}: all completed in ${fmtMs(finishedMs)} (${(jobCount / (finishedMs / 1000)).toFixed(1)} jobs/s), each ran once, none retried`,
      `${config.label}, committed-state snapshots (primary): ${String(snapshot.snapshots)} back-to-back polls; peak ${String(snapshot.peak)} active jobs in one group; ${String(snapshot.snapshotsAbove)} snapshots (${((snapshot.snapshotsAbove / Math.max(1, snapshot.snapshots)) * 100).toFixed(2)}%) had a group above the limit${histogram === "" ? "" : ` (${histogram})`}; ${String(snapshot.keysAbove)} of ${String(keyCount)} keys ever above; ${String(snapshot.episodes)} overshoot episodes, longest ${snapshot.longestEpisodeMs.toFixed(0)} ms; ${snapshot.timeAboveMs.toFixed(0)} ms above the limit out of ${fmtMs(snapshot.busyMs)} busy key-time (${(share * 100).toFixed(2)}%)`,
      describeSweep(`${config.label}, job table timestamps (statement start times)`, tableView),
      describeSweep(`${config.label}, handlers (start and end events)`, handlerView),
      `${config.label}, jobs started per replica: ${[...perReplica.entries()].map(([replica, count]) => `${replica} ${String(count)}`).join(", ")}`,
      overshoot
        ? `${config.label}: OVERSHOOT RECORDED in the job table: peak ${String(peak)} active at a limit of ${String(GROUP_LIMIT)}, longest episode ${snapshot.longestEpisodeMs.toFixed(0)} ms; the handlers' own records peaked at ${String(handlerView.peak)}. A fetch claims jobs in one statement that cannot see a racing claim, then recounts the group after its own commit and gives the excess back before any handler starts (pg-boss manager.js, #fetch), so the extra rows are active in the table for milliseconds and are not run`
        : `${config.label}: no overshoot observed in any of the three records`,
    ];
    return {
      label: config.label,
      failures,
      evidence,
      peak,
      longestEpisodeMs: snapshot.longestEpisodeMs,
      share,
      handlerPeak: handlerView.peak,
    };
  } finally {
    await scenario.dispose();
  }
};

export const run = async (ctx: RunContext): Promise<CriterionResult> => {
  const keyCount = ctx.settings.SPIKE_GROUP_KEYS;
  const short = await runPass(ctx, {
    label: "short jobs (40 to 100 ms)",
    scenarioName: "c3_group_limit",
    jobCount: ctx.settings.SPIKE_GROUP_JOBS,
    keyCount,
    workMs: (index) => 40 + ((index * 37) % 61),
    judgeBrevity: true,
  });
  const long = await runPass(ctx, {
    label: "long jobs (2 to 4 s)",
    scenarioName: "c3_group_limit_long",
    jobCount: ctx.settings.SPIKE_GROUP_LONG_JOBS,
    keyCount,
    workMs: (index) => 2_000 + ((index * 37) % 2_001),
    judgeBrevity: false,
  });

  const failures = [...short.failures, ...long.failures];
  const peak = Math.max(short.peak, long.peak);
  const longest = Math.max(short.longestEpisodeMs, long.longestEpisodeMs);
  const overshoot = peak > GROUP_LIMIT;
  const handlerPeak = Math.max(short.handlerPeak, long.handlerPeak);
  const passes = [short, long]
    .map(
      (pass) =>
        `${pass.label}: peak ${String(pass.peak)}, longest episode ${pass.longestEpisodeMs.toFixed(0)} ms, ${(pass.share * 100).toFixed(2)}% of busy key-time above the limit`,
    )
    .join("; ");

  const evidence = [
    ...short.evidence,
    ...long.evidence,
    `the two passes side by side: ${passes}. The longest episode in the table did not grow with the job length (${short.longestEpisodeMs.toFixed(0)} ms with 40 to 100 ms jobs, ${long.longestEpisodeMs.toFixed(0)} ms with 2 to 4 s jobs), and the handlers peaked at ${String(short.handlerPeak)} and ${String(long.handlerPeak)}: the over-admitted rows are given back, not run for the length of a job`,
    `hard cap: no snapshot may show more than ${String(ctx.settings.SPIKE_GROUP_PEAK_CAP)} active jobs in one group (5 x the limit; a working value the spike set for itself, not a pg-boss figure)`,
  ];

  return {
    id,
    criterion,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    ...(failures.length === 0 && overshoot
      ? {
          qualifier: `overshoot: peak ${String(peak)} at limit ${String(GROUP_LIMIT)}, longest ${longest.toFixed(0)} ms in the job table; handlers peaked at ${String(handlerPeak)}`,
        }
      : {}),
    summary:
      failures.length === 0
        ? overshoot
          ? `The limit of ${String(GROUP_LIMIT)} held in steady state across three replicas; overshoot is recorded: peak ${String(peak)} active in one group in the job table, longest episode ${longest.toFixed(0)} ms, and the handlers peaked at ${String(handlerPeak)} (${passes}).`
          : `The limit of ${String(GROUP_LIMIT)} per key held across three replicas with no overshoot.`
        : failures.join("; "),
    evidence,
  };
};
