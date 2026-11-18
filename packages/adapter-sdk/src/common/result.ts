// Expected failures are values, not exceptions (ADR 0025): every adapter operation returns a
// result. Throw only for bugs.

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

/**
 * Why an adapter operation failed, in words every kind shares. `message` is for a person and
 * never holds content, tokens or vendor payloads.
 */
export type AdapterErrorCode =
  /** The credential was refused. */
  | "unauthorized"
  /** The credential is fine but lacks a permission. */
  | "forbidden"
  | "not-found"
  /** The vendor's rate limit; `retryAfterMs` says when to try again. */
  | "rate-limited"
  /** The vendor is down or unreachable; try again later. */
  | "unavailable"
  /** The vendor answered something its schema refuses. */
  | "invalid-response"
  /** The input was refused before any call was made. */
  | "invalid-input"
  /** The thing exists already, or changed under us. */
  | "conflict"
  /** The adapter doesn't have this capability (adapter parity, AGENTS.md). */
  | "unsupported"
  /** The operation was cancelled through its `AbortSignal`. */
  | "aborted";

export type AdapterError = {
  readonly code: AdapterErrorCode;
  readonly message: string;
  readonly retryAfterMs?: number;
};

export type AdapterResult<T> = Result<T, AdapterError>;

export const adapterError = (code: AdapterErrorCode, message: string, retryAfterMs?: number): Err<AdapterError> =>
  err(retryAfterMs === undefined ? { code, message } : { code, message, retryAfterMs });

/** What `health()` reports. */
export type HealthReport =
  | { readonly status: "ok" }
  | { readonly status: "degraded" | "down"; readonly reason: string };
