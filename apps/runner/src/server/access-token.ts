import { runnerLimits, runnerPaths, tokenResponseSchema } from "@ostra/protocol";
import type { RunnerId } from "@ostra/protocol";
import { signTokenAssertion } from "../identity/key-pair.ts";
import type { RunnerKeyPair } from "../identity/key-pair.ts";
import { callJson, describeFailure, joinUrl } from "./http.ts";

// The runner's access token (ADR 0034): traded for a fresh signed assertion at
// `POST /runner/v1/token`, valid 10 minutes, held in memory only and sent at the WebSocket upgrade.
// It's renewed a minute before it expires, and whenever the server says it expired.

/** How long before its expiry a token is renewed. */
const RENEW_BEFORE_MS = 60_000;

export type AccessTokenResult =
  | { readonly ok: true; readonly token: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: "revoked"; readonly message: string }
  | { readonly ok: false; readonly reason: "unreachable" | "invalid-response"; readonly message: string };

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

export const REVOKED_MESSAGE =
  "The server refused this runner's key: it was revoked in the panel, or the server no longer knows it.";

export const createAccessTokens = (input: AccessTokensInput): AccessTokens => {
  const now = input.now ?? Date.now;
  let held: { readonly token: string; readonly expiresAt: number } | undefined;
  return {
    get: async () => {
      if (held !== undefined && held.expiresAt - now() > RENEW_BEFORE_MS) {
        return { ok: true, ...held };
      }
      held = undefined;
      const assertion = await signTokenAssertion(input.keyPair, input.runnerId, now());
      const result = await callJson({
        url: joinUrl(input.serverUrl, runnerPaths.token),
        method: "POST",
        schema: tokenResponseSchema,
        body: assertion,
      });
      if (result.ok) {
        // A server that hands out a longer token is held to ADR 0034's lifetime anyway.
        const expiresAt = Math.min(result.value.expiresAt, now() + runnerLimits.accessTokenTtlMs);
        held = { token: result.value.accessToken, expiresAt };
        return { ok: true, ...held };
      }
      const failure = result.failure;
      if (failure.kind === "refused" && (failure.status === 401 || failure.status === 403)) {
        return { ok: false, reason: "revoked", message: REVOKED_MESSAGE };
      }
      return {
        ok: false,
        reason: failure.kind === "invalid-response" ? "invalid-response" : "unreachable",
        message: describeFailure(failure),
      };
    },
    invalidate: () => {
      held = undefined;
    },
  };
};
