import type { Clock, RateBudget, RateBudgetStore } from "./stores.ts";

// A rate budget per credential (ADR 0025, Q20), fed by the vendor's response headers. Before a
// call, the caller asks whether to wait; the budget says "go", or "wait until the reset", instead
// of spending the last calls and getting refused.

export type RateHeaders = {
  /** `x-ratelimit-remaining` */
  readonly remaining?: string | null;
  /** `x-ratelimit-limit` */
  readonly limit?: string | null;
  /** `x-ratelimit-reset`, in seconds since the epoch (GitHub's form). */
  readonly reset?: string | null;
};

export type RateDecision = { readonly go: true } | { readonly go: false; readonly waitMs: number };

export type RateBudgetGuard = {
  /** Whether a call on `key` may go now. */
  readonly check: (key: string) => Promise<RateDecision>;
  /** Records what the vendor said after a call on `key`. Headers it can't read are ignored. */
  readonly record: (key: string, headers: RateHeaders) => Promise<void>;
};

export type RateBudgetOptions = {
  readonly store: RateBudgetStore;
  readonly clock: Clock;
  /** Calls kept in reserve: below this many, wait for the reset. Default 1. */
  readonly reserve?: number;
};

const toNumber = (value: string | null | undefined): number | undefined => {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

export const createRateBudget = (options: RateBudgetOptions): RateBudgetGuard => {
  const reserve = options.reserve ?? 1;
  return {
    check: async (key) => {
      const budget = await options.store.get(key);
      const now = options.clock.now();
      if (budget === undefined || budget.resetAt <= now || budget.remaining >= reserve) {
        return { go: true };
      }
      return { go: false, waitMs: budget.resetAt - now };
    },
    record: async (key, headers) => {
      const remaining = toNumber(headers.remaining);
      const reset = toNumber(headers.reset);
      if (remaining === undefined || reset === undefined) {
        return;
      }
      const budget: RateBudget = { remaining, limit: toNumber(headers.limit) ?? null, resetAt: reset * 1000 };
      await options.store.set(key, budget);
    },
  };
};
