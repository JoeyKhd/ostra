import type { JobName } from "@ostra/domain";

// Each job's queue on pg-boss (ADR 0037). One queue per job name, so a queue's policy and retries
// fit what its job does. Ported from spikes/durable-queue-choice/src/job-defs.ts.
//
// - Every queue is `exclusive`: one job per key while it's queued, waiting to retry or running.
//   That's what makes "sending a job twice returns the existing one" true (spike 8, C1 F and G).
//   Every job has a key (`jobKey` in @ostra/domain), so none collide on the empty key.
// - Heartbeats on every queue: a killed replica's jobs are freed after about `heartbeatSeconds`
//   plus one supervise pass. 10 s is pg-boss's minimum.
// - Retries back off exponentially, and a job out of retries lands in the dead-letter queue.

/** Where a job goes when it has used its retries. */
export const DEAD_LETTER_QUEUE = "ostra.dead-letter";

export type QueueSettings = {
  readonly retryLimit: number;
  /** Seconds before the first retry; doubled each time, with jitter, up to `retryDelayMax`. */
  readonly retryDelay: number;
  readonly retryDelayMax: number;
  /** A running job that misses its heartbeat this long is freed for another worker. */
  readonly heartbeatSeconds: number;
  /** A running job is failed after this long. */
  readonly expireInSeconds: number;
};

const base: QueueSettings = {
  retryLimit: 5,
  retryDelay: 2,
  retryDelayMax: 300,
  heartbeatSeconds: 10,
  expireInSeconds: 300,
};

/** Each job's queue settings. Calls to GitHub get more retries; timers fewer, since they re-check state. */
export const queueSettings: Readonly<Record<JobName, QueueSettings>> = {
  "task.dispatch": base,
  "task.offer-timeout": { ...base, retryLimit: 3 },
  "task.grace": { ...base, retryLimit: 3 },
  "task.session-ended": base,
  "task.open-pull-requests": { ...base, retryLimit: 8, expireInSeconds: 600 },
  "provider.refresh-models": { ...base, retryLimit: 3 },
  "catalog.refresh": { ...base, retryLimit: 3, expireInSeconds: 600 },
};

/** The pg-boss queue a job runs on: its own name. */
export const queueName = (job: JobName): string => job;
