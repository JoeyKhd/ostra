import type { Clock, IdempotencyRecord, IdempotencyStore } from "./stores.ts";

// Idempotency keys (ADR 0011, ADR 0025): a call that must happen once, such as opening a PR, is
// recorded before it's made. A retry finds the record: the finished result is returned without a
// second call, and a pending one is reported, so the caller checks the vendor before acting again.

export type IdempotentOutcome<T> =
  /** The call ran now. */
  | { readonly kind: "ran"; readonly result: T }
  /** It had already finished: here is the result it recorded. */
  | { readonly kind: "replayed"; readonly result: unknown }
  /**
   * Another attempt claimed the key and never finished (it crashed, or is still running). The
   * caller must look at the vendor (for example, find the PR) instead of calling again.
   */
  | { readonly kind: "in-doubt"; readonly claimedAt: number };

export const withIdempotency = async <T>(
  store: IdempotencyStore,
  clock: Clock,
  key: string,
  call: () => Promise<T>,
): Promise<IdempotentOutcome<T>> => {
  const claim = await store.claim(key, clock.now());
  if (!claim.claimed) {
    return describe(claim.existing);
  }
  let result: T;
  try {
    result = await call();
  } catch (error) {
    await store.release(key);
    throw error;
  }
  await store.complete(key, result, clock.now());
  return { kind: "ran", result };
};

const describe = <T>(record: IdempotencyRecord): IdempotentOutcome<T> =>
  record.state === "done"
    ? { kind: "replayed", result: record.result }
    : { kind: "in-doubt", claimedAt: record.claimedAt };

/** A key in the form ADR 0037 uses: parts joined by `:`, each free of `:`. */
export const idempotencyKey = (...parts: readonly (string | number)[]): string =>
  parts.map((part) => String(part).replaceAll(":", "_")).join(":");
