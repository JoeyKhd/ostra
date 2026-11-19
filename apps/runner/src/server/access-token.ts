import { PROTOCOL_MINOR, runnerHeaders, runnerLimits, runnerPaths, tokenResponseSchema } from "@ostra/protocol";
import type { RunnerId, TokenAssertion } from "@ostra/protocol";
import { signTokenAssertion } from "../identity/key-pair.ts";
import type { RunnerKeyPair } from "../identity/key-pair.ts";
import { callJson, describeFailure, joinUrl } from "./http.ts";
import type { CallFailure } from "./http.ts";

// The runner's access token (ADR 0034): traded for a fresh signed assertion at
// `POST /runner/v1/token`, valid 10 minutes, held in memory only and sent at the WebSocket upgrade.
// It's renewed a minute before it expires, and whenever the server says it expired.
//
// A refusal names why (protocol minor 2), and only two are for good: a revoked runner, and a key the
// server doesn't know. The others are retried: the clocks disagree, the nonce was used before (once
// more at once, with a fresh assertion), or a server before minor 2 gave no reason.

/** How long before its expiry a token is renewed. */
const RENEW_BEFORE_MS = 60_000;

/** The refusals that are for good: the runner stops, and signs in again with a new identity. */
export type TerminalRefusal = "revoked" | "unknown-key";

export type AccessTokenResult =
  | { readonly ok: true; readonly token: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: TerminalRefusal; readonly message: string }
  /**
   * The server's clock and this machine's are further apart than the server allows. `offsetMs` is
   * the server's clock minus this machine's, when the server said what its clock read.
   */
  | { readonly ok: false; readonly reason: "clock-skew"; readonly offsetMs: number | null; readonly message: string }
  /**
   * `replayed`: the server said the nonce was used before, twice in a row. `token-refused`: a 401
   * with no reason, from a server before minor 2.
   */
  | { readonly ok: false; readonly reason: "replayed" | "token-refused"; readonly message: string }
  | { readonly ok: false; readonly reason: "unreachable" | "invalid-response"; readonly message: string };

export type AccessTokenFailure = Extract<AccessTokenResult, { readonly ok: false }>;

/** Whether a failure is for good: the server will refuse this identity however often it's asked. */
export const isTerminalRefusal = (result: AccessTokenResult): result is AccessTokenFailure & { readonly reason: TerminalRefusal } =>
  !result.ok && (result.reason === "revoked" || result.reason === "unknown-key");

export type AccessTokens = {
  /** A token valid for at least a minute more, or why there isn't one. */
  readonly get: () => Promise<AccessTokenResult>;
  /** Drops the held token, so the next `get` asks for a new one (close code 4401). */
  readonly invalidate: () => void;
};

export type AccessTokensInput = {
  readonly serverUrl: string;
  readonly runnerId: RunnerId;
  readonly keyPair: RunnerKeyPair;
  readonly now?: () => number;
};

export const REVOKED_MESSAGE = "The server refused this runner's key: it was revoked in the panel.";

export const UNKNOWN_KEY_MESSAGE =
  "The server doesn't know this runner's key: it has no runner of this ID, or not with this key " +
  "(its database was reset, or this data folder belongs to another install).";

const RETRY_SENTENCE = "Retrying until the clocks agree; check this machine's time.";

/** The clock-skew sentence: how far, and which way, this machine's clock is from the server's. */
export const clockSkewMessage = (offsetMs: number | null): string => {
  if (offsetMs === null) {
    return `The server refused the access token: it says this machine's clock is too far from its own. ${RETRY_SENTENCE}`;
  }
  const seconds = Math.round(Math.abs(offsetMs) / 1000);
  const way = offsetMs >= 0 ? "behind" : "ahead of";
  return (
    `The server refused the access token: this machine's clock is ${String(seconds)} s ${way} the server's, ` +
    `more than the ${String(runnerLimits.assertionSkewMs / 1000)} s it allows. ${RETRY_SENTENCE}`
  );
};

/** A refused token request as the runner's result: by the server's reason, or by status from a server before minor 2. */
const refusalOf = (failure: CallFailure, assertion: TokenAssertion): AccessTokenFailure => {
  // A 401 or 403 that isn't ostra's error body came from something in between, such as a proxy's
  // page: a network failure, never a verdict on this runner (ADR 0034, "Networks").
  if (failure.kind !== "refused" || failure.error === null || (failure.status !== 401 && failure.status !== 403)) {
    return {
      ok: false,
      reason: failure.kind === "invalid-response" ? "invalid-response" : "unreachable",
      message: describeFailure(failure),
    };
  }
  const reason = failure.error.reason;
  switch (reason) {
    case "revoked":
      return { ok: false, reason: "revoked", message: REVOKED_MESSAGE };
    case "unknown-key":
      return { ok: false, reason: "unknown-key", message: UNKNOWN_KEY_MESSAGE };
    case "clock-skew": {
      const serverTime = failure.error.serverTime;
      const offsetMs = serverTime === undefined ? null : serverTime - assertion.issuedAt;
      return { ok: false, reason: "clock-skew", offsetMs, message: clockSkewMessage(offsetMs) };
    }
    case "replayed":
      return {
        ok: false,
        reason: "replayed",
        message: "The server refused the access token: it says this runner's signed assertion was used before, twice in a row. Retrying.",
      };
    case undefined:
      // A server before minor 2. Its only 403 was a revoked runner; its 401 could be the clocks, a
      // used nonce or a key it doesn't know, and only the last is for good, so it's retried.
      return failure.status === 403
        ? { ok: false, reason: "revoked", message: REVOKED_MESSAGE }
        : {
            ok: false,
            reason: "token-refused",
            message: `The server refused the access token (${String(failure.status)}) without a reason. Retrying.`,
          };
    default:
      return reason satisfies never;
  }
};

export const createAccessTokens = (input: AccessTokensInput): AccessTokens => {
  const now = input.now ?? Date.now;
  let held: { readonly token: string; readonly expiresAt: number } | undefined;

  const request = async (): Promise<AccessTokenResult> => {
    const assertion = await signTokenAssertion(input.keyPair, input.runnerId, now());
    const result = await callJson({
      url: joinUrl(input.serverUrl, runnerPaths.token),
      method: "POST",
      schema: tokenResponseSchema,
      body: assertion,
      // This build's minor, so a server of minor 2 or later says why it refuses.
      headers: { [runnerHeaders.minor]: String(PROTOCOL_MINOR) },
    });
    if (result.ok) {
      // A server that hands out a longer token is held to ADR 0034's lifetime anyway.
      const expiresAt = Math.min(result.value.expiresAt, now() + runnerLimits.accessTokenTtlMs);
      held = { token: result.value.accessToken, expiresAt };
      return { ok: true, ...held };
    }
    return refusalOf(result.failure, assertion);
  };

  return {
    get: async () => {
      if (held !== undefined && held.expiresAt - now() > RENEW_BEFORE_MS) {
        return { ok: true, ...held };
      }
      held = undefined;
      const first = await request();
      // A nonce the server saw before (a proxy that resent the request, say): a fresh assertion, at once.
      return !first.ok && first.reason === "replayed" ? request() : first;
    },
    invalidate: () => {
      held = undefined;
    },
  };
};
