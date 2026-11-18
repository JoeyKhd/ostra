import { isAbortError } from "./clock.ts";
import type { Clock } from "./clock.ts";

export type FailureKind = "rate-limited" | "transient" | "permanent";
export type Failure = { readonly kind: FailureKind; readonly retryAfterMs: number | null };

export type RetryOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: number }
  | { readonly ok: false; readonly reason: "deadline" | "permanent" | "aborted"; readonly attempts: number };

export type RetryOptions = {
  /** The clock the deadline and the backoff are measured on. */
  readonly clock: Clock;
  /** Absolute deadline on `clock`. No attempt starts after it. */
  readonly deadline: number;
  /**
   * An attempt that has not answered after this long (in real milliseconds: a request on the network does not run on a
   * scaled clock) is not abandoned. A second attempt starts beside it, and whichever lands first wins. Retrying
   * must not throw away a request that may still arrive, which is why every attempt of one activity carries the same ID.
   */
  readonly hedgeAfterMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly signal?: AbortSignal;
  readonly classify: (error: unknown) => Failure;
};

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure };

/**
 * Runs `operation` until one attempt succeeds, every attempt has failed for good, or the deadline passes.
 * A failed attempt is retried after an exponential backoff. A slow one is hedged, not cancelled. The first-activity
 * deadline of Linear's agent mode is the reason this exists: one slow or failed call must not cost the session its
 * 10 seconds.
 */
export const retryUntil = async <T>(operation: () => Promise<T>, options: RetryOptions): Promise<RetryOutcome<T>> => {
  const hedgeAfter = options.hedgeAfterMs * options.clock.scale;
  const inFlight = new Map<number, Promise<{ readonly id: number; readonly result: Result<T> }>>();
  let attempts = 0;
  let failures = 0;
  let nextAttemptAt = options.clock.now();
  let hedgeAt = Number.POSITIVE_INFINITY;

  const launch = (): void => {
    attempts += 1;
    const id = attempts;
    hedgeAt = options.clock.now() + hedgeAfter;
    inFlight.set(
      id,
      operation()
        .then(
          (value): Result<T> => ({ ok: true, value }),
          (error: unknown): Result<T> => ({ ok: false, failure: options.classify(error) }),
        )
        .then((result) => ({ id, result })),
    );
  };

  for (;;) {
    if (options.signal?.aborted === true) return { ok: false, reason: "aborted", attempts };
    const now = options.clock.now();
    if (now >= options.deadline) return { ok: false, reason: "deadline", attempts };
    if (inFlight.size === 0 && now >= nextAttemptAt) launch();
    else if (inFlight.size > 0 && now >= hedgeAt) launch();

    const wakeAt = Math.min(options.deadline, inFlight.size === 0 ? nextAttemptAt : hedgeAt);
    const stopWaiting = new AbortController();
    const signal = options.signal === undefined ? stopWaiting.signal : AbortSignal.any([options.signal, stopWaiting.signal]);
    const timer = options.clock.sleep(Math.max(0, wakeAt - now), signal).then(
      () => null,
      (error: unknown) => {
        if (isAbortError(error)) return null;
        throw error;
      },
    );
    const settled = await Promise.race([timer, ...inFlight.values()]);
    stopWaiting.abort();
    if (settled === null) continue;

    inFlight.delete(settled.id);
    if (settled.result.ok) return { ok: true, value: settled.result.value, attempts };
    const failure = settled.result.failure;
    if (failure.kind === "permanent") {
      if (inFlight.size === 0) return { ok: false, reason: "permanent", attempts };
      continue;
    }
    failures += 1;
    const backoff = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (failures - 1));
    nextAttemptAt = Math.max(nextAttemptAt, options.clock.now() + Math.max(backoff, failure.retryAfterMs ?? 0));
  }
};
