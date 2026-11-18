// Retry with exponential backoff and full jitter (ADR 0025): the wait before attempt n is a random
// time between 0 and min(maxMs, baseMs * 2^n). A `Retry-After` the caller gives wins over the
// backoff. Cancellable by an `AbortSignal`.

export type RetryDecision =
  | { readonly retry: false }
  | { readonly retry: true; /** The vendor's `Retry-After`, in ms, when it sent one. */ readonly afterMs?: number };

export type RetryOptions<T> = {
  /** The most attempts in all, the first included. */
  readonly attempts: number;
  readonly baseMs: number;
  readonly maxMs: number;
  /** Whether a result is worth another attempt. Default: never retry a result. */
  readonly retryResult?: (result: T) => RetryDecision;
  /** Whether a thrown error is worth another attempt. Default: never. */
  readonly retryError?: (error: unknown) => RetryDecision;
  readonly signal?: AbortSignal;
  /** A random number in [0, 1). Default `Math.random`. */
  readonly random?: () => number;
  /** Waits `ms`, or rejects when `signal` aborts. Default: a timer. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** The full-jitter wait before retry number `attempt` (0 for the first retry). */
export const backoffDelay = (attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number =>
  Math.floor(random() * Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30)));

const abortReason = (signal: AbortSignal | undefined): Error => {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error("aborted");
};

export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Runs `call` until it returns a result `retryResult` doesn't want retried, throws an error
 * `retryError` doesn't want retried, or runs out of attempts. The last result is returned and the
 * last error rethrown. An abort rejects with the signal's reason.
 */
export const retry = async <T>(call: (attempt: number) => Promise<T>, options: RetryOptions<T>): Promise<T> => {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  for (let attempt = 0; ; attempt += 1) {
    options.signal?.throwIfAborted();
    const last = attempt + 1 >= options.attempts;
    let decision: RetryDecision;
    try {
      const result = await call(attempt);
      decision = options.retryResult?.(result) ?? { retry: false };
      if (!decision.retry || last) {
        return result;
      }
    } catch (error) {
      decision = options.retryError?.(error) ?? { retry: false };
      if (!decision.retry || last) {
        throw error;
      }
    }
    const wait = decision.afterMs ?? backoffDelay(attempt, options.baseMs, options.maxMs, random);
    await sleep(wait, options.signal);
  }
};

/** A `Retry-After` header as ms: seconds, or an HTTP date. `undefined` when absent or unreadable. */
export const parseRetryAfter = (value: string | null | undefined, now: number): number | undefined => {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};
