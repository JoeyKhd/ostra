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
  /**
   * Running jobs per group, across replicas (ADR 0037): a throttle, never a budget. A worker
   * option pg-boss doesn't store, so every replica passes this same value. Absent: no group limit.
   */
  readonly groupConcurrency?: number;
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
  // Milestone 2 (ticket 06's names; ticket 01 adds the schedule and group options).
  "webhook.process": { ...base, retryLimit: 8 },
  // Throttled per connection (`jobSending`): two at once per tracker or code host credential.
  "tracker.poll-board": { ...base, retryLimit: 2, expireInSeconds: 120, groupConcurrency: 2 },
  "github.reconcile-prs": { ...base, retryLimit: 2, expireInSeconds: 240, groupConcurrency: 2 },
  "linear.refresh-token": { ...base, retryLimit: 8 },
  "ticket.fetch-context": { ...base, retryLimit: 5, expireInSeconds: 600 },
  "ticket.sync": { ...base, retryLimit: 10, retryDelayMax: 900, groupConcurrency: 2 },
  "session.max-duration": { ...base, retryLimit: 3 },
  "session.stall-sweep": { ...base, retryLimit: 1, expireInSeconds: 50 },
  "box.release": { ...base, retryLimit: 8 },
  "box.release-after-idle": { ...base, retryLimit: 3 },
  "retention.sweep": { ...base, retryLimit: 2, expireInSeconds: 1800 },
  "blob.gc": { ...base, retryLimit: 2, expireInSeconds: 1800 },
  // Milestone 3 (its ticket 07's names; tickets 20 to 26 and 39 build them).
  "notify.fanout": { ...base, retryLimit: 5 },
  // A failing channel retries on its own with backoff, never holding the others (ADR 0050).
  "notify.deliver": { ...base, retryLimit: 8, retryDelayMax: 900 },
  "diff.fetch": { ...base, retryLimit: 5, groupConcurrency: 2 },
  "task.reconcile-behind": { ...base, retryLimit: 2, expireInSeconds: 600 },
  "github.comment": { ...base, retryLimit: 8 },
  "snapshot.schedule": { ...base, retryLimit: 3, expireInSeconds: 600 },
  "snapshot.nightly": { ...base, retryLimit: 2, expireInSeconds: 600 },
  "cli-session.expire": { ...base, retryLimit: 2 },
  // Milestone 4 (its ticket 06's names; tickets 11 to 19 and 22 build them).
  "account-mail.send": { ...base, retryLimit: 8, retryDelayMax: 900 },
  "invitation.expire": { ...base, retryLimit: 2 },
  "budget.check": { ...base, retryLimit: 5 },
  "budget.release": { ...base, retryLimit: 5 },
  "budget.new-month": { ...base, retryLimit: 3 },
  "insights.compute": { ...base, retryLimit: 2, expireInSeconds: 600 },
  "search.backfill": { ...base, retryLimit: 3, expireInSeconds: 600 },
  "pr.link-related": { ...base, retryLimit: 8, groupConcurrency: 2 },
  "review.evaluate": { ...base, retryLimit: 8, groupConcurrency: 2 },
  "providers.release-boxes": { ...base, retryLimit: 5 },
};

/**
 * pg-boss's internal queue its cron pass forwards each due occurrence through (spike 8). It's made
 * with no heartbeat and a 15-minute expiry, so a replica killed while holding a batch strands it,
 * and the replay sends again what was already sent. `start()` sets this heartbeat on it, and the
 * boot check reads it back: an upgrade that renames or resets the queue stops the workers.
 */
export const FORWARDING_QUEUE = "__pgboss__send-it";
export const FORWARDING_HEARTBEAT_SECONDS = 10;

/**
 * The slot a schedule's tick fills (`singletonSeconds`), so a replayed forwarding batch's second
 * send of a tick is dropped: the cron's period, for the forms ostra uses. Other forms get a minute.
 */
export const cronPeriodSeconds = (cron: string): number => {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return 60;
  const [minute, hour, day, month, weekday] = fields;
  const every = /^\*\/(\d+)$/;
  if (hour === "*" && day === "*" && month === "*" && weekday === "*") {
    if (minute === "*") return 60;
    const step = every.exec(minute ?? "");
    if (step !== null) return Number(step[1]) * 60;
    return 3600;
  }
  if (day === "*" && month === "*" && weekday === "*" && /^\d+$/.test(minute ?? "")) {
    const step = every.exec(hour ?? "");
    if (step !== null) return Number(step[1]) * 3600;
    if (/^\d+$/.test(hour ?? "")) return 86_400;
  }
  return 60;
};

/** The pg-boss queue a job runs on: its own name. */
export const queueName = (job: JobName): string => job;
