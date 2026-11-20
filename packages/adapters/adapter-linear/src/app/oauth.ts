import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { err, ok } from "@ostra/adapter-sdk";
import type { Clock, Result } from "@ostra/adapter-sdk";
import { z } from "zod";

// Ported from spikes/linear-agent-mode/src/oauth.ts and token-store.ts (the app-user check).
//
// Linear's OAuth (linear.app/developers/oauth-2-0-authentication, oauth-actor-authorization):
// authorize with `actor=app` and S256 PKCE, so the token is the app's own workspace user's, not the
// admin's who clicked; exchange the code; refresh before the 24-hour access token runs out, taking
// the rotated refresh token each time. Pure functions and small calls: core and api hold the flow
// and its state (tickets 27 and 15).
//
// The client secret and every token go in one form field or one header and nowhere else: never in
// a log line, an error message or a URL. Errors name Linear's error code, never its description.

export const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
export const LINEAR_API_URL = "https://api.linear.app/graphql";

/** The scopes milestone 2 asks for (spec section 11, item 3). Agent mode's come with F-012. */
export const LINEAR_APP_SCOPES = ["read", "write", "issues:create", "comments:create"] as const;

/**
 * Milestone 6 (F-012, ADR 0013): the scopes agent mode adds. `app:assignable` lets the app be
 * delegated issues, `app:mentionable` lets it be mentioned (linear.app/developers/agents).
 */
export const LINEAR_AGENT_SCOPES = ["app:assignable", "app:mentionable"] as const;

/** The full set "Turn on agent mode" asks for: Linear replaces an install's scopes with the set it's given. */
export const LINEAR_AGENT_MODE_SCOPES: readonly string[] = [...LINEAR_APP_SCOPES, ...LINEAR_AGENT_SCOPES];

/**
 * The agent scopes a token lacks, from the scopes its token answer granted (`LinearTokenSet.scopes`).
 * Linear's API has no field that reads a token's scopes back (spike 5: "The scopes are those in
 * the token response, not read back"), so the granted set is the one the consent or the last
 * refresh answered with.
 */
export const missingAgentScopes = (granted: readonly string[]): readonly string[] =>
  LINEAR_AGENT_SCOPES.filter((scope) => !granted.includes(scope));

/** How long Linear keeps answering a rotated refresh token with the same new pair. */
export const REFRESH_RETRY_WINDOW_MS = 30 * 60_000;

export type LinearOAuthErrorCode =
  /** The code, verifier or refresh token was refused: the consent must run again. */
  | "invalid-grant"
  /** The client ID or secret was refused. */
  | "invalid-client"
  /** The app doesn't allow this grant (Linear's `unauthorized_client`): client credentials are off. */
  | "grant-disabled"
  /** The token is fine, but isn't the app's own user (no `actor=app`), or not the one expected. */
  | "not-an-app-user"
  | "different-app-user"
  /** Linear refused the access token. */
  | "unauthorized"
  /** Linear couldn't be reached, or failed: try again. */
  | "unavailable"
  /** Linear answered something its schema refuses. */
  | "invalid-response";

export type LinearOAuthError = { readonly code: LinearOAuthErrorCode; readonly message: string };
export type LinearOAuthResult<T> = Result<T, LinearOAuthError>;

const oauthError = (code: LinearOAuthErrorCode, message: string): LinearOAuthResult<never> => err({ code, message });

// ---------- PKCE and state ----------

export type Pkce = { readonly verifier: string; readonly challenge: string };

/** A verifier of 43 base64url characters and its S256 challenge (RFC 7636). */
export const createPkce = (): Pkce => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** A state value for the authorize round trip: 32 random bytes, base64url. */
export const randomOAuthState = (): string => randomBytes(32).toString("base64url");

// ---------- authorize ----------

export type AuthorizeUrlInput = {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state: string;
  readonly codeChallenge: string;
  /** Default Linear's. */
  readonly authorizeUrl?: string;
  /**
   * Milestone 6 ("Turn on agent mode"): scopes asked for beside `scopes`, such as
   * `LINEAR_AGENT_SCOPES`. Each is asked for once.
   */
  readonly extraScopes?: readonly string[];
  /**
   * Milestone 6: re-authorizes the existing install with the full set
   * (`update_scopes_on_existing_token=true`), so its token gains the new scopes. Without it, a
   * second consent keeps the install's scopes (linear.app/developers/oauth-2-0-authentication).
   */
  readonly updateExistingToken?: boolean;
};

/** Where the admin's browser goes to consent: `actor=app`, S256 PKCE, the scopes comma-separated. */
export const authorizeUrl = (input: AuthorizeUrlInput): string => {
  const url = new URL(input.authorizeUrl ?? LINEAR_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", [...new Set([...input.scopes, ...(input.extraScopes ?? [])])].join(","));
  if (input.updateExistingToken === true) {
    url.searchParams.set("update_scopes_on_existing_token", "true");
  }
  url.searchParams.set("actor", "app");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
};

// ---------- the token endpoint ----------

/** A token pair from the consent or a refresh. */
export type LinearTokenSet = {
  readonly accessToken: string;
  /** In ms since the epoch: Linear's access tokens last 24 hours. */
  readonly expiresAt: number;
  /** The rotated refresh token: keep it, the old one stops working after 30 minutes. */
  readonly refreshToken: string;
  readonly scopes: readonly string[];
};

/** A client-credentials token: 30 days, and no refresh token (fetch a new one on a 401). */
export type LinearClientToken = {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
};

// Linear owns this format: unknown fields are tolerated.
const tokenAnswerSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.union([z.string(), z.array(z.string())]).optional(),
});
type TokenAnswer = z.infer<typeof tokenAnswerSchema>;

const errorAnswerSchema = z.looseObject({ error: z.string() });

const scopesOf = (answer: TokenAnswer): readonly string[] => {
  if (answer.scope === undefined) return [];
  return Array.isArray(answer.scope) ? answer.scope : answer.scope.split(/[\s,]+/).filter((scope) => scope !== "");
};

export type TokenEndpointOptions = {
  /** Default Linear's. */
  readonly tokenUrl?: string;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
};

type TokenCall = { readonly kind: "answer"; readonly answer: TokenAnswer } | { readonly kind: "error"; readonly error: LinearOAuthError; readonly lost: boolean };

/** One `POST /oauth/token`. `lost`: no answer came back, so the request may have been applied. */
const callTokenEndpoint = async (form: URLSearchParams, options: TokenEndpointOptions, what: string): Promise<TokenCall> => {
  let response: Response;
  try {
    response = await fetch(options.tokenUrl ?? LINEAR_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "ostra-linear-adapter" },
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch {
    return { kind: "error", error: { code: "unavailable", message: `${what} failed: Linear could not be reached` }, lost: true };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // The answer broke off, or wasn't JSON: for a 2xx, it may have been applied.
    return {
      kind: "error",
      error: { code: response.ok ? "invalid-response" : "unavailable", message: `${what} failed (HTTP ${String(response.status)}): Linear's answer was unreadable` },
      lost: true,
    };
  }
  const where = `${what} failed (HTTP ${String(response.status)})`;
  if (response.ok) {
    const parsed = tokenAnswerSchema.safeParse(body);
    return parsed.success
      ? { kind: "answer", answer: parsed.data }
      : { kind: "error", error: { code: "invalid-response", message: `${where}: Linear's answer was not a token` }, lost: false };
  }
  if (response.status >= 500) {
    return { kind: "error", error: { code: "unavailable", message: `${where}: Linear is failing` }, lost: true };
  }
  const known = errorAnswerSchema.safeParse(body);
  const code = known.success ? known.data.error : "";
  switch (code) {
    case "invalid_grant":
      return { kind: "error", error: { code: "invalid-grant", message: `${where}: Linear refused the grant (invalid_grant)` }, lost: false };
    case "invalid_client":
      return { kind: "error", error: { code: "invalid-client", message: `${where}: Linear refused the client ID or secret (invalid_client)` }, lost: false };
    case "unauthorized_client":
      return {
        kind: "error",
        error: { code: "grant-disabled", message: `${where}: the app doesn't allow this grant (unauthorized_client)` },
        lost: false,
      };
    default:
      return { kind: "error", error: { code: "invalid-grant", message: `${where}: Linear refused the request` }, lost: false };
  }
};

const now = (options: TokenEndpointOptions): number => (options.clock ?? { now: () => Date.now() }).now();

const toTokenSet = (answer: TokenAnswer, at: number, fallbackRefresh: string | null, what: string): LinearOAuthResult<LinearTokenSet> => {
  const refreshToken = answer.refresh_token ?? fallbackRefresh;
  if (refreshToken === null) {
    return oauthError("invalid-response", `${what} failed: Linear's answer had no refresh token`);
  }
  return ok({
    accessToken: answer.access_token,
    // Linear's access tokens last 24 hours when the answer doesn't say.
    expiresAt: at + (answer.expires_in ?? 86_400) * 1000,
    refreshToken,
    scopes: scopesOf(answer),
  });
};

export type ExchangeCodeInput = TokenEndpointOptions & {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly codeVerifier: string;
};

/** Trades the consent's code for the app's token pair. A code works once, so this never retries. */
export const exchangeCode = async (input: ExchangeCodeInput): Promise<LinearOAuthResult<LinearTokenSet>> => {
  const at = now(input);
  const call = await callTokenEndpoint(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code_verifier: input.codeVerifier,
    }),
    input,
    "exchanging Linear's code",
  );
  return call.kind === "answer" ? toTokenSet(call.answer, at, null, "exchanging Linear's code") : err(call.error);
};

export type RefreshTokenInput = TokenEndpointOptions & {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  /**
   * Waits before each retry of a lost answer, in ms. Default 0.5 s and 2 s. Linear answers a
   * rotated refresh token with the same new pair for 30 minutes, so a retry is safe.
   */
  readonly retryDelaysMs?: readonly number[];
};

/**
 * Refreshes the access token and takes the rotated refresh token. When the answer is lost (the
 * network, a timeout, a 5xx), it asks again with the old refresh token: Linear gives the same new
 * pair within 30 minutes. A caller whose process died mid-refresh does the same with the refresh
 * token it still holds, within that window.
 */
export const refreshToken = async (input: RefreshTokenInput): Promise<LinearOAuthResult<LinearTokenSet>> => {
  const delays = input.retryDelaysMs ?? [500, 2000];
  let last: LinearOAuthError = { code: "unavailable", message: "refreshing Linear's token failed" };
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const wait = attempt === 0 ? 0 : (delays[attempt - 1] ?? 0);
    if (wait > 0) {
      await delay(wait);
    }
    const at = now(input);
    const call = await callTokenEndpoint(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: input.refreshToken, client_id: input.clientId, client_secret: input.clientSecret }),
      input,
      "refreshing Linear's token",
    );
    if (call.kind === "answer") {
      return toTokenSet(call.answer, at, input.refreshToken, "refreshing Linear's token");
    }
    last = call.error;
    if (!call.lost) {
      return err(call.error);
    }
  }
  return err(last);
};

export type ClientCredentialsInput = TokenEndpointOptions & {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
};

/**
 * A development helper (ticket 08, decided 2026-11-19): a 30-day app token with no consent and no
 * refresh token, once the app's "Client credentials" setting is on. Nothing in the product calls
 * it: a client-credentials token replaces the consented installation. Today the `ostra-test` app
 * answers `unauthorized_client`, which is `grant-disabled`.
 */
export const clientCredentialsToken = async (input: ClientCredentialsInput): Promise<LinearOAuthResult<LinearClientToken>> => {
  const at = now(input);
  const call = await callTokenEndpoint(
    new URLSearchParams({ grant_type: "client_credentials", scope: input.scopes.join(","), client_id: input.clientId, client_secret: input.clientSecret }),
    input,
    "asking Linear for a client-credentials token",
  );
  if (call.kind === "error") {
    return err(call.error);
  }
  return ok({ accessToken: call.answer.access_token, expiresAt: at + (call.answer.expires_in ?? 30 * 86_400) * 1000, scopes: scopesOf(call.answer) });
};

export type RevokeTokenInput = { readonly token: string; readonly revokeUrl?: string; readonly timeoutMs?: number };

/** Revokes an access or refresh token: what disconnecting the workspace does (ticket 27). */
export const revokeToken = async (input: RevokeTokenInput): Promise<LinearOAuthResult<void>> => {
  let response: Response;
  try {
    response = await fetch(input.revokeUrl ?? LINEAR_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "ostra-linear-adapter" },
      body: new URLSearchParams({ token: input.token }),
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
  } catch {
    return oauthError("unavailable", "revoking Linear's token failed: Linear could not be reached");
  }
  await response.body?.cancel();
  if (response.ok) return ok(undefined);
  return oauthError(response.status >= 500 ? "unavailable" : "invalid-grant", `revoking Linear's token failed (HTTP ${String(response.status)})`);
};

// ---------- the app-user check ----------

export type LinearAppIdentity = {
  /** The app's own user in the workspace: its comments and moves carry this ID (the echo check). */
  readonly appUserId: string;
  readonly appUserName: string;
  readonly workspaceId: string;
  /** The workspace's URL key, such as `ostra-test`. */
  readonly workspaceKey: string;
  readonly workspaceName: string;
};

export type CheckAppTokenInput = {
  readonly accessToken: string;
  /** When set, the token must be this app user's in this workspace: a saved token is checked against its row. */
  readonly expected?: { readonly appUserId: string; readonly workspaceId: string };
  /** Default Linear's. */
  readonly apiUrl?: string;
  readonly timeoutMs?: number;
};

const viewerAnswerSchema = z.looseObject({
  data: z
    .looseObject({
      viewer: z.looseObject({ id: z.string().min(1), name: z.string(), app: z.boolean().nullish() }),
      organization: z.looseObject({ id: z.string().min(1), name: z.string(), urlKey: z.string() }),
    })
    .nullish(),
  errors: z.array(z.unknown()).nullish(),
});

/** Confirms the token is the app's own user (an `actor=app` consent), and reads who and where it is. */
export const checkAppToken = async (input: CheckAppTokenInput): Promise<LinearOAuthResult<LinearAppIdentity>> => {
  let response: Response;
  try {
    response = await fetch(input.apiUrl ?? LINEAR_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "ostra-linear-adapter", authorization: `Bearer ${input.accessToken}` },
      body: JSON.stringify({ query: "query OstraAppUser { viewer { id name app } organization { id name urlKey } }" }),
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
  } catch {
    return oauthError("unavailable", "checking Linear's token failed: Linear could not be reached");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const where = `checking Linear's token failed (HTTP ${String(response.status)})`;
  const parsed = viewerAnswerSchema.safeParse(body);
  if (response.status === 401 || response.status === 403 || (parsed.success && (parsed.data.errors?.length ?? 0) > 0 && response.status < 500)) {
    return oauthError("unauthorized", `${where}: Linear refused the token`);
  }
  if (!response.ok) {
    return oauthError(response.status >= 500 ? "unavailable" : "unauthorized", where);
  }
  if (!parsed.success || parsed.data.data === null || parsed.data.data === undefined) {
    return oauthError("invalid-response", `${where}: Linear's answer was not what was expected`);
  }
  const { viewer, organization } = parsed.data.data;
  if (viewer.app !== true) {
    return oauthError("not-an-app-user", "the token is a person's, not the app's own user: the consent must ask for actor=app");
  }
  if (input.expected !== undefined && (input.expected.appUserId !== viewer.id || input.expected.workspaceId !== organization.id)) {
    return oauthError("different-app-user", "the token is another app user's, or another workspace's, than the connection's");
  }
  return ok({ appUserId: viewer.id, appUserName: viewer.name, workspaceId: organization.id, workspaceKey: organization.urlKey, workspaceName: organization.name });
};
