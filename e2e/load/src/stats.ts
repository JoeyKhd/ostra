// Small numbers for the load test's results (ticket 34): percentiles and the steer timer.

export type Summary = { readonly count: number; readonly p50: number | null; readonly p99: number | null; readonly max: number | null };

/** The nearest-rank percentile of `sorted` (ascending), `null` when empty. */
export const percentile = (sorted: readonly number[], p: number): number | null => {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
};

export const summarize = (values: readonly number[]): Summary => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 50), p99: percentile(sorted, 99), max: sorted.at(-1) ?? null };
};

/** Bucketed times (core's `ingest.timing` lines): the percentile is the bucket's upper bound, `null` past the last. */
export const bucketPercentile = (bounds: readonly number[], counts: readonly number[], p: number): number | null => {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * total));
  let seen = 0;
  for (const [index, count] of counts.entries()) {
    seen += count;
    if (seen >= rank) return bounds[index] ?? null;
  }
  return null;
};

export type SteerResult = {
  readonly sent: number;
  readonly received: number;
  /** Steers the runner never got: a lost command. */
  readonly lost: readonly string[];
  /** From `packages/api`'s call to the runner's receipt, in ms. */
  readonly latencyMs: Summary;
};

/**
 * Times each steer from the moment `packages/api`'s call starts to the moment its runner receives
 * it, matched by the message's client ID. Every timestamp comes from the same machine's clock.
 */
export type SteerTimer = {
  readonly sent: (clientMessageId: string, at: number) => void;
  readonly received: (clientMessageId: string, at: number) => void;
  readonly result: () => SteerResult;
};

export const createSteerTimer = (): SteerTimer => {
  const sentAt = new Map<string, number>();
  const receivedAt = new Map<string, number>();
  return {
    sent: (id, at) => {
      sentAt.set(id, at);
    },
    // A command applied once by its ID is received once; a resend's later receipt doesn't move the first.
    received: (id, at) => {
      if (!receivedAt.has(id)) receivedAt.set(id, at);
    },
    result: () => {
      const latencies: number[] = [];
      const lost: string[] = [];
      for (const [id, at] of sentAt) {
        const got = receivedAt.get(id);
        if (got === undefined) lost.push(id);
        else latencies.push(Math.max(0, got - at));
      }
      return { sent: sentAt.size, received: sentAt.size - lost.length, lost, latencyMs: summarize(latencies) };
    },
  };
};
