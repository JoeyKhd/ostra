import { setTimeout as delay } from "node:timers/promises";

/**
 * Time as the spike sees it. `now()` is monotonic milliseconds with an arbitrary origin,
 * so only differences mean anything. `sleep` takes milliseconds on this clock.
 *
 * A scaled clock runs `scale` times faster than the wall clock, so a 35-minute silent turn
 * can run in seconds while the HTTP calls around it stay real.
 */
export type Clock = {
  readonly scale: number;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export const createClock = (scale: number): Clock => {
  if (!Number.isFinite(scale) || scale < 1) {
    throw new RangeError("clock scale must be a finite number >= 1");
  }
  const startedAt = performance.now();
  return {
    scale,
    now: () => (performance.now() - startedAt) * scale,
    sleep: async (ms, signal) => {
      const real = Math.max(0, ms / scale);
      await (signal === undefined ? delay(real) : delay(real, undefined, { signal }));
    },
  };
};

export const realClock: Clock = createClock(1);

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";
