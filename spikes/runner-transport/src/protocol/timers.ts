import { z } from "zod";

// ADR 0034's working values. Every one of them is a working value, to tune.
export const workingValues = {
  /** Server ping: stays under nginx's 60 s idle close. */
  pingMs: 20_000,
  /** No frame for this long: either side closes, and the peer reconnects. */
  deadMs: 45_000,
  /** One presence write per replica. */
  presenceMs: 10_000,
  /** The panel shows a runner offline after this long without presence. */
  offlineMs: 45_000,
  /** Task grace: this long without the peer, and a timer stops the task cleanly. */
  graceMs: 600_000,
  /** Self-fence: this long without the server, and the peer stops its agents. */
  selfFenceMs: 570_000,
  /** The sweep that catches a missed notification. */
  sweepMs: 2_000,
  /** In HTTP mode, the runner tries WebSocket again this often. */
  wsRetryMs: 600_000,
  /** The long poll holds for this long. */
  longPollMs: 25_000,
  /** Reconnects use full jitter from this... */
  backoffMinMs: 1_000,
  /** ...to this. */
  backoffMaxMs: 60_000,
  /** A socket that dies this soon after opening, three times in a row, means HTTP. */
  quickDeathMs: 10_000,
  /** A refused runner retries this often. */
  versionRetryMs: 300_000,
  /** The WebSocket upgrade and `hello` must finish in this time. */
  handshakeTimeoutMs: 10_000,
  /** A connection older than this is asked to reconnect. */
  maxConnectionAgeMs: 3_600_000,
  /** How often a replica looks for tasks past their grace. */
  graceSweepMs: 2_000,
} as const;

export type Timers = { readonly [K in keyof typeof workingValues]: number };

/**
 * Divide the clock-like values by `scale`, for quick development runs only.
 * The steer and sweep values are never scaled: their bars are absolute.
 */
export const scaledTimers = (scale: number): Timers => {
  if (scale === 1) return workingValues;
  const s = (ms: number): number => Math.max(50, Math.round(ms / scale));
  return {
    ...workingValues,
    pingMs: s(workingValues.pingMs),
    deadMs: s(workingValues.deadMs),
    presenceMs: s(workingValues.presenceMs),
    offlineMs: s(workingValues.offlineMs),
    graceMs: s(workingValues.graceMs),
    selfFenceMs: s(workingValues.selfFenceMs),
    wsRetryMs: s(workingValues.wsRetryMs),
    longPollMs: s(workingValues.longPollMs),
    backoffMaxMs: s(workingValues.backoffMaxMs),
    quickDeathMs: s(workingValues.quickDeathMs),
    versionRetryMs: s(workingValues.versionRetryMs),
    handshakeTimeoutMs: s(workingValues.handshakeTimeoutMs),
    graceSweepMs: s(workingValues.graceSweepMs),
  };
};

export const TimeScale = z.coerce.number().positive().max(1000);

/** Full jitter: a random wait between 0 and min(max, base * 2^attempt). */
export const fullJitter = (attempt: number, t: Timers): number => {
  const cap = Math.min(t.backoffMaxMs, t.backoffMinMs * 2 ** Math.min(attempt, 16));
  return Math.max(t.backoffMinMs / 2, Math.random() * cap);
};
