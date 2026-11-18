// How C4 (pg-boss) and D4 (DBOS) judge the fires of 200 runtime schedules: one module, so the two
// libraries are held to the same rules.
//
//   - A fire is one job (pg-boss) or one workflow (DBOS) the library created for a schedule. A handler
//     that ran twice for the same job or workflow, after its replica was killed, is at-least-once
//     delivery, C2's case, and not a second fire: runs are counted per job id.
//   - Each fire is bucketed by when the library created it: before the first tick (warm-up), into one
//     of the ticks, or after the run (late or replayed).
//   - Every schedule must fire exactly once in every tick, and before the first tick no more often than
//     it had occurrences (a new pg-boss schedule fires once for an occurrence up to 60 s old).

export const MINUTE = 60_000;

export type HandlerRun = {
  readonly scheduleKey: string;
  readonly jobId: string;
  readonly replicaId: string;
  /** When the library created the job or workflow, by the database clock (ms since the epoch). */
  readonly createdMs: number;
};

export type Variant = "plain" | "guarded";

export type VariantStats = { missed: number; doubled: number; exact: number };

export type FireJudgement = {
  readonly fires: readonly HandlerRun[];
  /** Handler runs that repeated a job already counted (at-least-once delivery). */
  readonly redelivered: number;
  /** Fires per `<schedule>|<tick>`. */
  readonly counts: ReadonlyMap<string, number>;
  /** Fires before the first tick, per schedule. */
  readonly preFires: ReadonlyMap<string, number>;
  readonly warmUp: number;
  /** Fires created after the run, which can only be late or replayed. */
  readonly lateFires: readonly { readonly key: string; readonly at: number }[];
  /** Milliseconds from each in-run fire's tick to its creation, sorted. */
  readonly latencies: readonly number[];
  readonly stats: Readonly<Record<Variant, VariantStats>>;
  readonly occurrencesBeforeT0: number;
  readonly warmUpOverFires: number;
  readonly missed: number;
  readonly doubled: number;
  /** The first few problems, for the evidence. */
  readonly problems: readonly string[];
};

export const boardKey = (index: number): string => `board-${String(index).padStart(3, "0")}`;

export const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
};

export const judgeFires = (input: {
  readonly handlerRuns: readonly HandlerRun[];
  readonly t0: number;
  readonly ticks: number;
  readonly scheduleCount: number;
  /** The database clock just before the schedules were created. */
  readonly beforeCreate: number;
  readonly variantOf: (index: number) => Variant;
}): FireJudgement => {
  const { handlerRuns, t0, ticks, scheduleCount, beforeCreate, variantOf } = input;
  const tickTime = (tick: number): number => t0 + tick * MINUTE;
  const runEnd = t0 + ticks * MINUTE;

  const seenJobs = new Set<string>();
  const fires = handlerRuns.filter((run) => {
    if (seenJobs.has(run.jobId)) {
      return false;
    }
    seenJobs.add(run.jobId);
    return true;
  });

  const counts = new Map<string, number>();
  const preFires = new Map<string, number>();
  const latencies: number[] = [];
  const lateFires: { readonly key: string; readonly at: number }[] = [];
  const firesBy = new Map<string, { readonly afterTickMs: number; readonly replica: string }[]>();
  let warmUp = 0;
  for (const fire of fires) {
    if (fire.createdMs < t0) {
      warmUp += 1;
      preFires.set(fire.scheduleKey, (preFires.get(fire.scheduleKey) ?? 0) + 1);
      continue;
    }
    if (fire.createdMs >= runEnd) {
      lateFires.push({ key: fire.scheduleKey, at: fire.createdMs });
      continue;
    }
    const tick = Math.floor((fire.createdMs - t0) / MINUTE);
    const key = `${fire.scheduleKey}|${String(tick)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    latencies.push(fire.createdMs - tickTime(tick));
    const list = firesBy.get(key) ?? [];
    list.push({ afterTickMs: fire.createdMs - tickTime(tick), replica: fire.replicaId });
    firesBy.set(key, list);
  }
  latencies.sort((a, b) => a - b);

  const describeFires = (board: string, tick: number): string =>
    (firesBy.get(`${board}|${String(tick)}`) ?? [])
      .map((entry) => `+${(entry.afterTickMs / 1000).toFixed(1)} s on ${entry.replica}`)
      .join(", ");

  const stats: Record<Variant, VariantStats> = { plain: { missed: 0, doubled: 0, exact: 0 }, guarded: { missed: 0, doubled: 0, exact: 0 } };
  const problems: string[] = [];
  // Before the first tick a schedule may fire once for each occurrence that came due: the warm-up
  // occurrence (up to 60 s old when it was created) and every whole minute until the first tick.
  const occurrencesBeforeT0 = Math.max(0, Math.ceil(t0 / MINUTE) - Math.floor((beforeCreate - MINUTE) / MINUTE) - 1);
  let warmUpOverFires = 0;
  for (let index = 0; index < scheduleCount; index += 1) {
    const board = boardKey(index);
    const variant = variantOf(index);
    const bucket = stats[variant];
    for (let tick = 0; tick < ticks; tick += 1) {
      const count = counts.get(`${board}|${String(tick)}`) ?? 0;
      if (count === 1) {
        bucket.exact += 1;
      } else if (count === 0) {
        bucket.missed += 1;
        if (problems.length < 6) {
          problems.push(`${board} (${variant}) missed tick ${String(tick)}`);
        }
      } else {
        bucket.doubled += 1;
        if (problems.length < 6) {
          problems.push(`${board} (${variant}) fired ${String(count)} times in tick ${String(tick)}: ${describeFires(board, tick)}`);
        }
      }
    }
    const pre = preFires.get(board) ?? 0;
    if (pre > occurrencesBeforeT0) {
      warmUpOverFires += 1;
      if (problems.length < 6) {
        problems.push(`${board} (${variant}) fired ${String(pre)} times before the first tick, which had only ${String(occurrencesBeforeT0)} occurrences`);
      }
    }
  }

  return {
    fires,
    redelivered: handlerRuns.length - fires.length,
    counts,
    preFires,
    warmUp,
    lateFires,
    latencies,
    stats,
    occurrencesBeforeT0,
    warmUpOverFires,
    missed: stats.plain.missed + stats.guarded.missed,
    doubled: stats.plain.doubled + stats.guarded.doubled,
    problems,
  };
};
