import type { SessionMetrics } from "../agent-sessions.ts";
import type { AgentSessionId } from "../ids.ts";
import { formatMs, formatSummary, summarize } from "../util.ts";
import type { Recorder } from "./common.ts";

// The pass-bar arithmetic, in one place. The fake-Linear scenarios and `pnpm spike:real` both feed it, so a
// real run is judged by exactly the code that judged the fake one.

export const ACK_LIMIT_MS = 5_000;
export const FIRST_ACTIVITY_LIMIT_MS = 10_000;
export const STALE_LIMIT_MS = 30 * 60 * 1000;

export type LatencySamples = {
  /** Round trip of each `created` webhook, as the sender saw it. */
  readonly ackMs: readonly number[];
  /** Webhook sent to first activity landed, per delegation. Null when no activity ever landed. */
  readonly firstActivityMs: readonly (number | null)[];
};

export const evaluateLatency = (r: Recorder, label: string, expected: number, samples: LatencySamples): void => {
  const landed = samples.firstActivityMs.filter((ms): ms is number => ms !== null);
  r.check(`${label}: ${String(expected)} delegations were all delivered and answered`, samples.ackMs.length === expected, `${String(samples.ackMs.length)} acks`);
  const ack = summarize(samples.ackMs);
  r.check(
    `${label}: every webhook answered in under ${formatMs(ACK_LIMIT_MS)}`,
    samples.ackMs.length > 0 && ack.max < ACK_LIMIT_MS,
    formatSummary(ack),
  );
  const first = summarize(landed);
  r.check(
    `${label}: every first activity landed in under ${formatMs(FIRST_ACTIVITY_LIMIT_MS)}`,
    landed.length === expected && first.max < FIRST_ACTIVITY_LIMIT_MS,
    landed.length === expected
      ? formatSummary(first)
      : `${String(expected - landed.length)} never landed${landed.length > 0 ? `; ${formatSummary(first)}` : ""}`,
  );
};

/**
 * The pass bar's first-activity samples, from the session service's own metrics: Linear's send time (or the receipt
 * time, when `addTransit` gives 0) to the first posted *thought* landing. An accepted external-link update is not a
 * first activity here, even though Linear counts it against its "unresponsive" rule. Null when no thought ever landed.
 */
export const firstActivitySamples = (
  metrics: readonly SessionMetrics[],
  addTransit: (sessionId: AgentSessionId) => number,
): readonly (number | null)[] =>
  metrics.map((m) => (m.firstThoughtAt === null ? null : m.firstThoughtAt - m.receivedAt + addTransit(m.sessionId)));

export type KeepAliveSamples = {
  readonly staleEpisodes: number;
  /** Longest silence between two touches, on the scenario clock. */
  readonly maxGapMs: number;
  readonly elapsedMs: number;
  readonly finalStatus: string;
};

export const evaluateKeepAlive = (r: Recorder, label: string, minimumElapsedMs: number, samples: KeepAliveSamples): void => {
  r.check(`${label}: the turn ran for at least ${String(Math.round(minimumElapsedMs / 60_000))} minutes`, samples.elapsedMs >= minimumElapsedMs, `${(samples.elapsedMs / 60_000).toFixed(1)} min`);
  r.check(`${label}: the session was never stale`, samples.staleEpisodes === 0, `${String(samples.staleEpisodes)} stale episodes`);
  r.check(
    `${label}: no silence reached ${String(STALE_LIMIT_MS / 60_000)} minutes`,
    samples.maxGapMs < STALE_LIMIT_MS,
    `longest silence ${(samples.maxGapMs / 60_000).toFixed(1)} min`,
  );
  r.check(`${label}: the session ended complete`, samples.finalStatus === "complete", samples.finalStatus);
};
