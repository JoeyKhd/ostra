import type { OrganizationId } from "@ostra/protocol";

// The plumbing's state, as small interfaces (ADR 0025, ADR 0045). The server implements them with
// Postgres; tests use the in-memory ones in `@ostra/adapter-sdk/testing`. This package never
// imports the database package, so the Apache-2.0 side stays clear of the restricted one.

/** A clock, so time can be controlled in tests. */
export type Clock = { readonly now: () => number };

export const systemClock: Clock = { now: () => Date.now() };

/** What a vendor said about one credential's rate limit. */
export type RateBudget = {
  /** Calls left in the current window. */
  readonly remaining: number;
  /** The window's size, when the vendor says. */
  readonly limit: number | null;
  /** When the window resets, in ms since the epoch. */
  readonly resetAt: number;
};

/** Rate budgets per credential key (Q20). The key names a credential, never holds it. */
export type RateBudgetStore = {
  readonly get: (key: string) => Promise<RateBudget | undefined>;
  readonly set: (key: string, budget: RateBudget) => Promise<void>;
};

/** A recorded outcome of an idempotent call: JSON, IDs and results only. */
export type IdempotencyRecord =
  | { readonly state: "pending"; readonly claimedAt: number }
  | { readonly state: "done"; readonly result: unknown; readonly doneAt: number };

/** Idempotency keys (ADR 0011): a call is recorded before it's made, and its result after. */
export type IdempotencyStore = {
  /** Records `key` as pending if it's new; returns what was there if it isn't. */
  readonly claim: (key: string, now: number) => Promise<{ readonly claimed: true } | { readonly claimed: false; readonly existing: IdempotencyRecord }>;
  readonly complete: (key: string, result: unknown, now: number) => Promise<void>;
  /** Drops a pending claim whose call failed, so a retry can claim it again. */
  readonly release: (key: string) => Promise<void>;
};

/** An encrypted value of the built-in secret store (ticket 14). */
export type SecretRow = {
  readonly id: string;
  readonly organizationId: OrganizationId;
  /** What it's for, such as `model-provider.token`: words and IDs, never the value. */
  readonly purpose: string;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly keyVersion: number;
};

/**
 * A fixed value sealed with the secrets key, one per key version (Q136): the server opens it at
 * every start to know that its key is the one the database's secrets were written with.
 */
export type SecretsKeyCheck = {
  readonly keyVersion: number;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
};

/** The built-in secret store's rows (the `Secret` table on the server). */
export type SecretRowStore = {
  readonly insert: (row: SecretRow) => Promise<void>;
  readonly get: (id: string) => Promise<SecretRow | undefined>;
  readonly delete: (id: string) => Promise<boolean>;
};
