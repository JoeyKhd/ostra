import { silentLogger } from "@ostra/adapter-sdk";
import type { Logger } from "@ostra/adapter-sdk";
import type { JobQueue } from "@ostra/domain";

import type { Jobs } from "./jobs.ts";

// The panel's side of the queue (ADR 0016, ADR 0037, Q157). The panel only enqueues, and core
// installs pg-boss's schema: on a fresh install the panel can come up first, against a database
// with no schema yet. So its start is retried in the background with backoff, the panel reports
// itself as starting until it connects, and its pages never wait on it. An enqueue before then
// tries once more at once, and refuses if the queue still isn't there: the caller's transaction
// rolls back, so nothing is half-written.

export type ProducerState = "starting" | "ready" | "stopped";

export type Producer = JobQueue & {
  readonly state: () => ProducerState;
  /** Resolves once the queue is connected; rejects if the producer is stopped first. */
  readonly ready: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

export type ProducerOptions = {
  readonly logger?: Logger;
  /** The first retry's wait, doubled each time up to `maxDelayMs`. Defaults 500 ms and 30 s. */
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
};

export const createProducer = (jobs: Jobs, options: ProducerOptions = {}): Producer => {
  const logger = (options.logger ?? silentLogger).child({ component: "jobs-producer" });
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  let state: ProducerState = "starting";
  let attempt: Promise<boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = initialDelayMs;
  const waiters: { readonly resolve: () => void; readonly reject: (error: Error) => void }[] = [];

  const tryStart = (): Promise<boolean> => {
    attempt ??= jobs
      .start()
      .then(() => {
        state = "ready";
        logger.info("jobs.producer_ready");
        for (const waiter of waiters.splice(0)) waiter.resolve();
        return true;
      })
      .catch((error: unknown) => {
        logger.warn("jobs.producer_starting", { name: error instanceof Error ? error.name : "unknown", retryInMs: delay });
        return false;
      })
      .finally(() => {
        attempt = undefined;
      });
    return attempt;
  };

  const schedule = (): void => {
    if (state !== "starting") return;
    timer = setTimeout(() => {
      void tryStart().then((started) => {
        if (!started) {
          delay = Math.min(maxDelayMs, delay * 2);
          schedule();
        }
      });
    }, delay);
    timer.unref();
  };

  void tryStart().then((started) => {
    if (!started) schedule();
  });

  return {
    state: () => state,
    ready: () =>
      state === "ready"
        ? Promise.resolve()
        : state === "stopped"
          ? Promise.reject(new Error("jobs: the producer is stopped"))
          : new Promise((resolve, reject) => {
              waiters.push({ resolve, reject });
            }),
    enqueueInTx: async (tx, job, payload, enqueueOptions) => {
      if (state !== "ready" && !(await tryStart())) {
        throw new Error("jobs: the queue isn't installed yet (core hasn't started); try again shortly");
      }
      await jobs.enqueueInTx(tx, job, payload, enqueueOptions);
    },
    stop: async () => {
      const wasReady = state === "ready";
      state = "stopped";
      if (timer !== undefined) clearTimeout(timer);
      for (const waiter of waiters.splice(0)) waiter.reject(new Error("jobs: the producer is stopped"));
      if (wasReady) await jobs.stop({ graceful: true, timeoutMs: 5_000 });
    },
  };
};
