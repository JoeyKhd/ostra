import { Buffer } from "node:buffer";

import { adapterError, ok, parseRetryAfter, parseVendor } from "@ostra/adapter-sdk";
import type { AdapterError, AdapterResult } from "@ostra/adapter-sdk";
import { z } from "zod";

// Slack's Web API, hand-written on `fetch` (F-057, spec section 4.3; ADR 0074). The five calls
// ostra makes are `auth.test`, `users.lookupByEmail`, `chat.postMessage`, `chat.update` and
// `oauth.v2.access`; no Slack SDK is a dependency (spec section 9). Every answer is a
// `z.looseObject` that tolerates the fields Slack adds, checked for `ok` before it is narrowed.
//
// Errors are in words and carry Slack's `error` code alone: never the response's body and never a
// token, a client secret, an authorization code or a state. The token reaches this module from the
// secret store through core; tests point `apiUrl` at `fake-slack/`.

export const DEFAULT_SLACK_API_URL = "https://slack.com/api";

/** The two bot scopes ostra's app asks for: post a DM, and match a member's address. */
export const SLACK_SCOPES = ["chat:write", "users:read.email"] as const;

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = "ostra-slack-adapter";
/** What a 429 waits when Slack sends no usable `Retry-After`. */
const DEFAULT_RETRY_MS = 1000;

export type SlackApiOptions = {
  /** Slack's Web API root. Default `https://slack.com/api`; tests point it at the fake. */
  readonly apiUrl?: string;
  /** The bot token, from the secret store. Never logged, never in an error. */
  readonly token: string;
  /** How long one call may take, in ms. Default 15,000. */
  readonly timeoutMs?: number;
};

export type SlackOAuthOptions = {
  readonly apiUrl?: string;
  /** The app's client ID, from the installation's non-secret field. */
  readonly clientId: string;
  /** The app's client secret, from the secret store. Never logged, never in an error. */
  readonly clientSecret: string;
  readonly timeoutMs?: number;
};

/** What `auth.test` says about the bot and its workspace. */
export type SlackAuth = {
  readonly team: string;
  readonly teamId: string;
  readonly user: string;
  readonly userId: string;
  readonly botId: string | null;
  readonly isEnterpriseInstall: boolean;
};

/** What `users.lookupByEmail` says about one workspace user. */
export type SlackUser = {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  readonly email: string | null;
  readonly isBot: boolean;
  readonly deleted: boolean;
};

/** One OAuth exchange: an authorization code, or a rotating refresh token. */
export type SlackOAuthInstall = {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number | null;
  readonly scope: readonly string[];
  readonly botUserId: string | null;
  readonly appId: string | null;
  readonly team: { readonly id: string; readonly name: string } | null;
  readonly tokenType: string | null;
};

/** Slack's own refusal, before it is mapped: the `error` code and the adapter error it becomes. */
export type SlackFailure = {
  /** Slack's `error` field, or `null` when the answer couldn't be read. */
  readonly slackError: string | null;
  readonly error: AdapterError;
};

export type SlackAnswer =
  | { readonly ok: true; readonly data: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly failure: SlackFailure };

const envelopeSchema = z.looseObject({ ok: z.boolean(), error: z.string().optional() });

const authSchema = z.looseObject({
  team: z.string(),
  team_id: z.string(),
  user: z.string(),
  user_id: z.string(),
  bot_id: z.string().optional(),
  is_enterprise_install: z.boolean().optional(),
});

const userSchema = z.looseObject({
  user: z.looseObject({
    id: z.string().min(1),
    team_id: z.string().optional(),
    name: z.string().optional(),
    deleted: z.boolean().optional(),
    is_bot: z.boolean().optional(),
    profile: z.looseObject({ email: z.string().optional() }).optional(),
  }),
});

const oauthSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  bot_user_id: z.string().optional(),
  app_id: z.string().optional(),
  team: z.looseObject({ id: z.string(), name: z.string() }).optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

/** The codes Slack answers with, by the adapter error they mean (spec section 4.3). */
const errorClasses: Readonly<Record<string, AdapterError["code"]>> = {
  invalid_auth: "unauthorized",
  token_revoked: "unauthorized",
  account_inactive: "unauthorized",
  not_authed: "unauthorized",
  token_expired: "unauthorized",
  missing_scope: "forbidden",
  no_permission: "forbidden",
  ekm_access_denied: "forbidden",
  is_restricted: "forbidden",
  internal_error: "unavailable",
  fatal_error: "unavailable",
  service_unavailable: "unavailable",
  request_timeout: "unavailable",
  team_added_to_org: "unavailable",
  channel_not_found: "not-found",
  users_not_found: "not-found",
  message_not_found: "not-found",
  cant_update_message: "unsupported",
  not_allowed_token_type: "unsupported",
};

const errorMessage = (code: string, kind: AdapterError["code"]): string => {
  switch (kind) {
    case "unauthorized":
      return `Slack refused the token (${code})`;
    case "forbidden":
      return `Slack refused the request (${code})`;
    case "unavailable":
      return `Slack couldn't be reached or failed (${code})`;
    case "not-found":
      return `Slack has no such member or message (${code})`;
    case "unsupported":
      return `Slack won't let this token do that (${code})`;
    case "rate-limited":
    case "invalid-input":
    case "invalid-response":
    case "conflict":
    case "aborted":
      return `Slack answered ${code}`;
  }
};

/** Slack's refusal, in words and with Slack's code: never its body, never a token. */
export const slackErrorOf = (code: string | null, status: number, retryAfterMs?: number): AdapterError => {
  if (status === 429 || code === "ratelimited") {
    return adapterError("rate-limited", "Slack's rate limit is reached", retryAfterMs ?? DEFAULT_RETRY_MS).error;
  }
  if (code !== null) {
    const kind = errorClasses[code];
    if (kind !== undefined) {
      return adapterError(kind, errorMessage(code, kind)).error;
    }
  }
  if (status === 401) {
    return adapterError("unauthorized", "Slack refused the token").error;
  }
  if (status === 403) {
    return adapterError("forbidden", "Slack refused the request").error;
  }
  if (status >= 500) {
    return adapterError("unavailable", `Slack answered ${String(status)}`).error;
  }
  return adapterError("invalid-response", code === null ? `Slack answered ${String(status)} to a call ostra can't read` : `Slack answered ${code}`).error;
};

/** Slack's Web API root without a trailing slash. */
const normalizeApiUrl = (apiUrl: string | undefined): string => (apiUrl ?? DEFAULT_SLACK_API_URL).replace(/\/+$/, "");

type RequestOptions = {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly timeoutMs: number;
};

const request = async (options: RequestOptions): Promise<SlackAnswer> => {
  let response: Response;
  try {
    response = await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    return { ok: false, failure: { slackError: null, error: adapterError("unavailable", "Slack couldn't be reached").error } };
  }
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), Date.now());
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const envelope = envelopeSchema.safeParse(payload);
  if (!envelope.success) {
    return { ok: false, failure: { slackError: null, error: slackErrorOf(null, response.status, retryAfterMs) } };
  }
  if (!envelope.data.ok) {
    const code = envelope.data.error ?? null;
    return { ok: false, failure: { slackError: code, error: slackErrorOf(code, response.status, retryAfterMs) } };
  }
  if (!response.ok) {
    return { ok: false, failure: { slackError: null, error: slackErrorOf(null, response.status, retryAfterMs) } };
  }
  return { ok: true, data: envelope.data };
};

const narrow = <S extends z.ZodType>(answer: SlackAnswer, schema: S, what: string): AdapterResult<z.infer<S>> => {
  if (!answer.ok) {
    return { ok: false, error: answer.failure.error };
  }
  return parseVendor(schema, answer.data, what);
};

const webCall = async (
  options: SlackApiOptions,
  method: "GET" | "POST",
  apiMethod: string,
  fields: Readonly<Record<string, string | boolean>>,
): Promise<SlackAnswer> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token}`,
    "user-agent": USER_AGENT,
  };
  const base = `${normalizeApiUrl(options.apiUrl)}/${apiMethod}`;
  if (method === "GET") {
    const url = new URL(base);
    for (const [name, value] of Object.entries(fields)) {
      url.searchParams.set(name, String(value));
    }
    return request({ url: url.toString(), method, headers, body: null, timeoutMs });
  }
  headers["content-type"] = "application/json";
  return request({ url: base, method, headers, body: JSON.stringify(fields), timeoutMs });
};

const oauthCall = async (options: SlackOAuthOptions, fields: Readonly<Record<string, string>>): Promise<SlackAnswer> =>
  request({
    url: `${normalizeApiUrl(options.apiUrl)}/oauth.v2.access`,
    method: "POST",
    headers: {
      // Slack's documented form for a code exchange and for token rotation: the app's credentials
      // in Basic auth. The bot token is not involved in an OAuth exchange.
      authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: new URLSearchParams(fields).toString(),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

const toInstall = (value: z.infer<typeof oauthSchema>): SlackOAuthInstall => ({
  accessToken: value.access_token,
  refreshToken: value.refresh_token ?? null,
  expiresInSeconds: value.expires_in ?? null,
  scope: (value.scope ?? "").split(",").filter((scope) => scope.trim() !== ""),
  botUserId: value.bot_user_id ?? null,
  appId: value.app_id ?? null,
  team: value.team ?? null,
  tokenType: value.token_type ?? null,
});

/** `auth.test`: the bot and workspace behind a token, or the reason Slack refused it. */
export const slackCheck = async (options: SlackApiOptions): Promise<AdapterResult<SlackAuth>> => {
  const narrowed = narrow(await webCall(options, "POST", "auth.test", {}), authSchema, "Slack's auth.test answer");
  if (!narrowed.ok) {
    return narrowed;
  }
  return ok({
    team: narrowed.value.team,
    teamId: narrowed.value.team_id,
    user: narrowed.value.user,
    userId: narrowed.value.user_id,
    botId: narrowed.value.bot_id ?? null,
    isEnterpriseInstall: narrowed.value.is_enterprise_install ?? false,
  });
};

/**
 * `chat.postMessage`: a DM to the user ID, with Slack's markup and unfurls off, so the words reach
 * the member exactly as core rendered them.
 */
export const slackPostMessage = async (
  options: SlackApiOptions,
  message: { readonly channel: string; readonly text: string },
): Promise<SlackAnswer> =>
  webCall(options, "POST", "chat.postMessage", {
    channel: message.channel,
    text: message.text,
    mrkdwn: false,
    unfurl_links: false,
    unfurl_media: false,
  });

/** `chat.update`: an edit in place, by the DM's `D…` channel and the message's `ts`. */
export const slackUpdateMessage = async (
  options: SlackApiOptions,
  message: { readonly channel: string; readonly ts: string; readonly text: string },
): Promise<SlackAnswer> => webCall(options, "POST", "chat.update", { channel: message.channel, ts: message.ts, text: message.text });

/** `users.lookupByEmail`: the workspace user whose address matches, for core's identity matching. */
export const slackLookupByEmail = async (options: SlackApiOptions & { readonly email: string }): Promise<AdapterResult<SlackUser>> => {
  const narrowed = narrow(await webCall(options, "GET", "users.lookupByEmail", { email: options.email }), userSchema, "Slack's users.lookupByEmail answer");
  if (!narrowed.ok) {
    return narrowed;
  }
  const user = narrowed.value.user;
  return ok({
    id: user.id,
    teamId: user.team_id ?? "",
    name: user.name ?? "",
    email: user.profile?.email ?? null,
    isBot: user.is_bot ?? false,
    deleted: user.deleted ?? false,
  });
};

/** `oauth.v2.access` with an authorization code: the install's bot token, refresh token and workspace. */
export const slackExchangeCode = async (
  options: SlackOAuthOptions & { readonly code: string; readonly redirectUri?: string },
): Promise<AdapterResult<SlackOAuthInstall>> => {
  const fields: Record<string, string> = { code: options.code };
  if (options.redirectUri !== undefined) {
    fields["redirect_uri"] = options.redirectUri;
  }
  const narrowed = narrow(await oauthCall(options, fields), oauthSchema, "Slack's oauth.v2.access answer");
  return narrowed.ok ? ok(toInstall(narrowed.value)) : narrowed;
};

/** `oauth.v2.access` with `grant_type=refresh_token`: a new access token and a new (single-use) refresh token. */
export const slackRefresh = async (
  options: SlackOAuthOptions & { readonly refreshToken: string },
): Promise<AdapterResult<SlackOAuthInstall>> => {
  const narrowed = narrow(
    await oauthCall(options, { grant_type: "refresh_token", refresh_token: options.refreshToken }),
    oauthSchema,
    "Slack's oauth.v2.access answer",
  );
  return narrowed.ok ? ok(toInstall(narrowed.value)) : narrowed;
};

/** Slack's consent page for an install: `https://slack.com/oauth/v2/authorize` for the configured API root. */
export const slackAuthorizeUrl = (options: {
  readonly clientId: string;
  readonly scopes?: readonly string[];
  readonly redirectUri?: string;
  readonly state?: string;
  readonly apiUrl?: string;
}): string => {
  const root = normalizeApiUrl(options.apiUrl);
  const origin = root.endsWith("/api") ? root.slice(0, -"/api".length) : root;
  const url = new URL(`${origin}/oauth/v2/authorize`);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("scope", (options.scopes ?? SLACK_SCOPES).join(","));
  if (options.redirectUri !== undefined) {
    url.searchParams.set("redirect_uri", options.redirectUri);
  }
  if (options.state !== undefined) {
    url.searchParams.set("state", options.state);
  }
  return url.toString();
};
