import { adapterError, backoffDelay } from "@ostra/adapter-sdk";
import type { AdapterError, AdapterResult } from "@ostra/adapter-sdk";

// One tracker write's attempts within one `ticket.sync` run (ticket 15). Ported from
// spikes/linear-agent-mode/src/retry.ts: a failed attempt is retried after a backoff; a slow one is
// hedged, not cancelled, so a request that may still land isn't thrown away. Every attempt of one
// write is the same write: the same row, the same idempotency key and the same marker (the task's
// URL) that a later attempt looks for, which is the client-made ID ostra controls. A write that
// creates something (a comment, a ticket) is never hedged: the tracker can't tell two creates
// apart, so a second one in flight could make a second comment. Moves, edits and links by URL are.

export type HedgedOptions = {
  /** No attempt starts after this many ms from the first. */
  readonly deadlineMs: number;
  /** A slow attempt gets a second one beside it after this long; `null`: never hedged. */
  readonly hedgeAfterMs: number | null;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Whether an error is worth another attempt. */
  readonly retryable: (error: AdapterError) => boolean;
  readonly random?: () => number;
};

type Settled<T> = { readonly id: number; readonly result: AdapterResult<T> };

const wait = (ms: number): { readonly promise: Promise<null>; readonly cancel: () => void } => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, Math.max(0, ms));
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
    },
  };
};

/** Runs `call` until an attempt succeeds, one fails for good, or the deadline passes. */
export const hedgedCall = async <T>(call: () => Promise<AdapterResult<T>>, options: HedgedOptions): Promise<{ readonly result: AdapterResult<T>; readonly attempts: number }> => {
  const deadline = Date.now() + options.deadlineMs;
  const inFlight = new Map<number, Promise<Settled<T>>>();
  let attempts = 0;
  let failures = 0;
  let last: AdapterResult<T> | undefined;
  let nextAttemptAt = Date.now();
  let hedgeAt = Number.POSITIVE_INFINITY;

  const launch = (): void => {
    attempts += 1;
    const id = attempts;
    hedgeAt = options.hedgeAfterMs === null ? Number.POSITIVE_INFINITY : Date.now() + options.hedgeAfterMs;
    inFlight.set(
      id,
      call().then(
        (result) => ({ id, result }),
        (error: unknown) => ({
          id,
          result: adapterError("unavailable", error instanceof Error ? error.name : "the call threw"),
        }),
      ),
    );
  };

  for (;;) {
    if (inFlight.size === 0) {
      if (last !== undefined && nextAttemptAt >= deadline) {
        return { result: last, attempts };
      }
      const pause = wait(nextAttemptAt - Date.now());
      await pause.promise;
      launch();
    }
    // Hedge a slow attempt while there's time; past the deadline, wait for those already out.
    const hedgeIn = hedgeAt < deadline ? hedgeAt - Date.now() : null;
    const timer = hedgeIn === null ? null : wait(hedgeIn);
    const settled = await Promise.race(timer === null ? [...inFlight.values()] : [timer.promise, ...inFlight.values()]);
    timer?.cancel();
    if (settled === null) {
      launch();
      continue;
    }
    inFlight.delete(settled.id);
    if (settled.result.ok) {
      return { result: settled.result, attempts };
    }
    last = settled.result;
    if (!options.retryable(settled.result.error)) {
      return { result: settled.result, attempts };
    }
    failures += 1;
    if (inFlight.size === 0) {
      const delay = settled.result.error.retryAfterMs ?? backoffDelay(failures - 1, options.baseDelayMs, options.maxDelayMs, options.random);
      nextAttemptAt = Date.now() + delay;
    }
  }
};
