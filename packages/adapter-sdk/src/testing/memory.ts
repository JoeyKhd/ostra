import type { LogRecord, Logger } from "../plumbing/logger.ts";
import { createLogger } from "../plumbing/logger.ts";
import type {
  Clock,
  IdempotencyRecord,
  IdempotencyStore,
  RateBudget,
  RateBudgetStore,
  SecretRow,
  SecretRowStore,
} from "../plumbing/stores.ts";
import type { AdapterContext } from "../common/context.ts";

// In-memory stores and a controllable clock, for tests. The server's are Postgres-backed.

export type ManualClock = Clock & {
  readonly set: (ms: number) => void;
  readonly advance: (ms: number) => void;
};

export const manualClock = (start = 1_700_000_000_000): ManualClock => {
  let now = start;
  return {
    now: () => now,
    set: (ms) => {
      now = ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
};

export const memoryRateBudgetStore = (): RateBudgetStore => {
  const budgets = new Map<string, RateBudget>();
  return {
    get: (key) => Promise.resolve(budgets.get(key)),
    set: (key, budget) => {
      budgets.set(key, budget);
      return Promise.resolve();
    },
  };
};

export const memoryIdempotencyStore = (): IdempotencyStore & { readonly records: ReadonlyMap<string, IdempotencyRecord> } => {
  const records = new Map<string, IdempotencyRecord>();
  return {
    records,
    claim: (key, now) => {
      const existing = records.get(key);
      if (existing !== undefined) {
        return Promise.resolve({ claimed: false, existing });
      }
      records.set(key, { state: "pending", claimedAt: now });
      return Promise.resolve({ claimed: true });
    },
    complete: (key, result, now) => {
      records.set(key, { state: "done", result, doneAt: now });
      return Promise.resolve();
    },
    release: (key) => {
      records.delete(key);
      return Promise.resolve();
    },
  };
};

export const memorySecretRowStore = (): SecretRowStore & { readonly rows: ReadonlyMap<string, SecretRow> } => {
  const rows = new Map<string, SecretRow>();
  return {
    rows,
    insert: (row) => {
      if (rows.has(row.id)) {
        return Promise.reject(new Error(`a secret row ${row.id} exists`));
      }
      rows.set(row.id, row);
      return Promise.resolve();
    },
    get: (id) => Promise.resolve(rows.get(id)),
    delete: (id) => Promise.resolve(rows.delete(id)),
  };
};

/** A logger that keeps every record, to assert on what was logged. */
export const recordingLogger = (): Logger & { readonly records: readonly LogRecord[] } => {
  const records: LogRecord[] = [];
  const logger = createLogger((record) => {
    records.push(record);
  });
  return { ...logger, records };
};

/** A context with in-memory stores and a manual clock. */
export const memoryAdapterContext = (): AdapterContext & {
  readonly clock: ManualClock;
  readonly logger: ReturnType<typeof recordingLogger>;
} => ({
  logger: recordingLogger(),
  clock: manualClock(),
  rateBudgets: memoryRateBudgetStore(),
  idempotency: memoryIdempotencyStore(),
});
