import { createRateBudget } from "../plumbing/rate-budget.ts";
import type { RateBudgetGuard } from "../plumbing/rate-budget.ts";
import { withIdempotency } from "../plumbing/idempotency.ts";
import type { IdempotentOutcome } from "../plumbing/idempotency.ts";
import { retry } from "../plumbing/retry.ts";
import type { RetryOptions } from "../plumbing/retry.ts";
import { silentLogger } from "../plumbing/logger.ts";
import type { Logger } from "../plumbing/logger.ts";
import { systemClock } from "../plumbing/stores.ts";
import type { Clock, IdempotencyStore, RateBudgetStore } from "../plumbing/stores.ts";

// What every adapter is constructed with: its logger and clock, and the stores its plumbing keeps
// state in (ADR 0025). The server builds one from Postgres; a test from the in-memory stores.

export type AdapterContext = {
  readonly logger: Logger;
  readonly clock: Clock;
  /** Absent: no budget is kept, and calls go when the vendor allows them. */
  readonly rateBudgets?: RateBudgetStore;
  /** Absent: idempotent calls run every time. */
  readonly idempotency?: IdempotencyStore;
};

export const defaultAdapterContext: AdapterContext = { logger: silentLogger, clock: systemClock };

/** The shared plumbing, written once and composed into every base class (ADR 0025). */
export type Plumbing = {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly rateBudget: RateBudgetGuard | undefined;
  readonly retry: <T>(call: (attempt: number) => Promise<T>, options: RetryOptions<T>) => Promise<T>;
  /** Runs `call` once per `key` when the context has an idempotency store; every time otherwise. */
  readonly once: <T>(key: string, call: () => Promise<T>) => Promise<IdempotentOutcome<T>>;
};

export const createPlumbing = (context: AdapterContext, fields: { readonly kind: string; readonly name: string }): Plumbing => {
  const logger = context.logger.child({ adapterKind: fields.kind, adapter: fields.name });
  const { idempotency } = context;
  return {
    logger,
    clock: context.clock,
    rateBudget:
      context.rateBudgets === undefined ? undefined : createRateBudget({ store: context.rateBudgets, clock: context.clock }),
    retry,
    once: async (key, call) =>
      idempotency === undefined
        ? { kind: "ran", result: await call() }
        : withIdempotency(idempotency, context.clock, key, call),
  };
};
