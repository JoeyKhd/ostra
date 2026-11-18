import { adapterError, parseRetryAfter } from "@ostra/adapter-sdk";
import type { AdapterError, Err, RetryDecision } from "@ostra/adapter-sdk";
import { z } from "zod";

// Octokit throws a `RequestError` with a numeric `status` and the response's headers. It is read
// by shape, so no transitive package is imported. Ported from
// spikes/github-app-and-git-proxy/src/github/errors.ts.
//
// An error here never holds the vendor's message, a header, a token or a key: the messages are
// ostra's own words, with the operation and the status.

const requestErrorSchema = z.looseObject({
  status: z.number().int(),
  response: z
    .looseObject({ headers: z.record(z.string(), z.unknown()).optional() })
    .nullish(),
});

const headerValue = (headers: Readonly<Record<string, unknown>> | undefined, name: string): string | undefined => {
  const value = headers?.[name];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
};

export type HttpFailure = { readonly status: number; readonly retryAfterMs: number | undefined; readonly rateLimited: boolean };

/** What an Octokit error says about the HTTP exchange, or `undefined` when it wasn't one. */
export const readHttpFailure = (error: unknown, now: number): HttpFailure | undefined => {
  const parsed = requestErrorSchema.safeParse(error);
  if (!parsed.success) {
    return undefined;
  }
  const headers = parsed.data.response?.headers;
  const status = parsed.data.status;
  const remaining = headerValue(headers, "x-ratelimit-remaining");
  const reset = Number(headerValue(headers, "x-ratelimit-reset"));
  const retryAfter = parseRetryAfter(headerValue(headers, "retry-after"), now);
  const limited = status === 429 || (status === 403 && (remaining === "0" || retryAfter !== undefined));
  const resetMs = Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now) : undefined;
  return { status, retryAfterMs: retryAfter ?? (limited ? resetMs : undefined), rateLimited: limited };
};

const keyProblem = /private key|PEM|PKCS|asn1|decoder|secretOrPrivateKey|DECODER/i;

/** Maps whatever a call threw to an adapter error, in ostra's own words. */
export const toAdapterError = (operation: string, error: unknown, now: number): Err<AdapterError> => {
  const failure = readHttpFailure(error, now);
  if (failure === undefined) {
    if (error instanceof Error && error.name === "AbortError") {
      return adapterError("aborted", `${operation} was cancelled`);
    }
    if (error instanceof Error && keyProblem.test(error.message)) {
      return adapterError("invalid-input", `${operation} failed: the App's private key could not be read`);
    }
    if (error instanceof TypeError) {
      return adapterError("unavailable", `${operation} failed: GitHub could not be reached`);
    }
    return adapterError("unavailable", `${operation} failed unexpectedly`);
  }
  const where = `${operation} failed (HTTP ${String(failure.status)})`;
  if (failure.rateLimited) {
    return adapterError("rate-limited", where, failure.retryAfterMs);
  }
  switch (failure.status) {
    case 401:
      return adapterError("unauthorized", `${where}: GitHub refused the App's credentials`);
    case 403:
      return adapterError("forbidden", `${where}: the App lacks a permission`);
    case 404:
      return adapterError("not-found", `${where}: not found, or not visible to the App`);
    case 409:
    case 422:
      return adapterError("conflict", where);
    default:
      return failure.status >= 500
        ? adapterError("unavailable", `${where}: GitHub is failing`)
        : adapterError("invalid-input", where);
  }
};

/** Retry GitHub's rate limits and failures, and a dropped connection. Never a client error. */
export const retryDecision = (error: unknown, now: number): RetryDecision => {
  const failure = readHttpFailure(error, now);
  if (failure === undefined) {
    return error instanceof TypeError ? { retry: true } : { retry: false };
  }
  if (failure.rateLimited) {
    // A wait longer than a minute is the caller's to schedule, not ours to sleep through.
    return failure.retryAfterMs !== undefined && failure.retryAfterMs > 60_000
      ? { retry: false }
      : { retry: true, ...(failure.retryAfterMs === undefined ? {} : { afterMs: failure.retryAfterMs }) };
  }
  return failure.status >= 500 ? { retry: true } : { retry: false };
};
