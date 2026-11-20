import type { Logger } from "@ostra/adapter-sdk";

import type { GatewayHooks } from "../gateway/context.ts";

// How long event ingest takes (milestone 5, ticket 34: F-117's load test reads it). Each `events`
// frame's ingest (its transaction and the acks it answers with) is timed, and every `intervalMs`
// one `ingest.timing` line says how many there were and how they fell into fixed buckets, so a
// reader can merge the lines of every replica and every interval. Counts and milliseconds only:
// no ID, no content. Nothing is logged for an interval with no frame.

/** Upper bounds, in milliseconds, of every bucket but the last, which takes the rest. */
export const ingestTimingBucketsMs = [5, 10, 25, 50, 100, 250, 500, 1000, 2500] as const;

export type IngestTimingLine = {
  readonly frames: number;
  readonly events: number;
  readonly totalMs: number;
  readonly maxMs: number;
  /** One count per bucket of `ingestTimingBucketsMs`, then one for longer. */
  readonly buckets: readonly number[];
};

export type TimedIngest = {
  readonly ingest: GatewayHooks["ingest"];
  /** Logs what's left and stops the timer. */
  readonly stop: () => void;
};

const bucketOf = (ms: number): number => {
  const index = ingestTimingBucketsMs.findIndex((bound) => ms < bound);
  return index === -1 ? ingestTimingBucketsMs.length : index;
};

export const timedIngest = (
  ingest: GatewayHooks["ingest"],
  logger: Logger,
  options: { readonly intervalMs?: number; readonly now?: () => number } = {},
): TimedIngest => {
  const now = options.now ?? (() => performance.now());
  let frames = 0;
  let events = 0;
  let totalMs = 0;
  let maxMs = 0;
  let buckets: number[] = Array.from({ length: ingestTimingBucketsMs.length + 1 }, () => 0);

  const flush = (): void => {
    if (frames === 0) return;
    const line: IngestTimingLine = { frames, events, totalMs: Math.round(totalMs), maxMs: Math.round(maxMs), buckets };
    logger.info("ingest.timing", line);
    frames = 0;
    events = 0;
    totalMs = 0;
    maxMs = 0;
    buckets = Array.from({ length: ingestTimingBucketsMs.length + 1 }, () => 0);
  };
  const timer = setInterval(flush, options.intervalMs ?? 10_000);
  timer.unref();

  return {
    ingest: async (runner, frame, refused) => {
      const started = now();
      try {
        return await ingest(runner, frame, refused);
      } finally {
        const ms = now() - started;
        frames += 1;
        events += frame.events.length;
        totalMs += ms;
        maxMs = Math.max(maxMs, ms);
        const index = bucketOf(ms);
        buckets[index] = (buckets[index] ?? 0) + 1;
      }
    },
    stop: () => {
      clearInterval(timer);
      flush();
    },
  };
};
