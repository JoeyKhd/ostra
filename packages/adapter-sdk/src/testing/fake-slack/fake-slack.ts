import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

// The fake Slack Web API (F-057, spec section 4.2; ADR 0074): a local stand-in for the handful of
// Slack methods ostra uses, the way `fake-jira/` stands in for Jira and `fake-email.ts` for Resend.
// One in-process HTTP server on loopback that answers Slack's own paths and JSON shapes, built from
// docs.slack.dev: `auth.test`, `users.lookupByEmail`, `chat.postMessage`, `chat.update` and
// `oauth.v2.access`, plus the `GET /oauth/v2/authorize` page the browser spec and the scripted run
// press. Method errors are Slack's: HTTP 200 with `{ ok: false, error }`, except a 429, which
// carries `Retry-After`.
//
// What it has: a bot token and its workspace, users by address (a known one resolves, a deactivated
// one is `account_inactive`, an unknown one `users_not_found`), DMs opened by a user ID and reused
// by both that ID and their `D…` one, messages whose ID is `<channel>:<ts>` with the text, flags
// and a digest of the token, edits in place, OAuth code exchange and rotating refresh tokens, an
// authorize page that checks the client ID and carries the state, and every request recorded.
//
// Where the docs and the ticket disagree, the ticket wins, and says so:
// - A deactivated user answers `users_not_found` in Slack's docs but `account_inactive` here, as
//   ticket 02 says (the adapter maps both to a refusal).
// - Slack truncates text past 40,000 characters and adds a `message_truncated` warning; the fake
//   answers `msg_too_long` with that warning, which is the error ticket 02 names.
// - A legacy custom bot user's "cannot use this method" has no documented error code; the control
//   answers `not_allowed_token_type` and puts Slack's words in `warning`.
// - A refresh token is single-use: the fake refuses a reused one as `invalid_refresh_token`.
//
// No dependency, no network beyond loopback, and test-only.

export type FakeSlackUser = {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly teamId: string;
  readonly isBot: boolean;
  active: boolean;
};

export type FakeSlackUserInput = {
  readonly email: string;
  readonly name?: string;
  readonly id?: string;
  readonly isBot?: boolean;
};

/** One message posted through `chat.postMessage`, as the fake kept it. */
export type FakeSlackMessage = {
  /** `<channel>:<ts>`, the ID ticket 02 describes. */
  readonly id: string;
  /** The conversation's `D…` ID. */
  readonly channel: string;
  readonly ts: string;
  readonly text: string;
  readonly mrkdwn: boolean;
  readonly unfurlLinks: boolean;
  readonly unfurlMedia: boolean;
  /** SHA-256 of the token that posted it, never the token. */
  readonly tokenDigest: string;
  readonly botId: string;
  readonly postedAt: number;
};

/** One successful `chat.update`, as the fake kept it. */
export type FakeSlackEdit = {
  readonly id: string;
  readonly channel: string;
  readonly ts: string;
  readonly text: string;
  readonly tokenDigest: string;
  readonly editedAt: number;
};

/** One request, as the fake saw it. */
export type FakeSlackCall = {
  readonly method: string;
  readonly route: string;
  readonly tokenDigest: string | null;
  readonly status: number;
  readonly ok: boolean;
  readonly error: string | null;
  readonly channel: string | null;
  readonly ts: string | null;
};

export type FakeSlackOptions = {
  readonly teamId?: string;
  readonly teamName?: string;
  readonly botUserId?: string;
  readonly botId?: string;
  readonly botName?: string;
  readonly appId?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  /** Where the authorize page sends the browser: `<public>/api/slack/callback`, by default. */
  readonly redirectUrl?: string;
  /** The scopes the install holds. Default `chat:write` and `users:read.email`. */
  readonly scopes?: readonly string[];
  /** The bot token. Default `xoxb-fake-<random>`. */
  readonly token?: string;
  readonly users?: readonly FakeSlackUserInput[];
};

export type FakeSlack = {
  /** The server's origin, such as `http://127.0.0.1:51234`. */
  readonly url: string;
  /** Slack's Web API root, `${url}/api`: what `OSTRA_SLACK_API_URL` points at. */
  readonly apiUrl: string;
  readonly authorizeUrl: string;
  readonly token: string;
  readonly team: { readonly id: string; readonly name: string };
  readonly bot: { readonly id: string; readonly userId: string; readonly name: string };
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUrl: string;
  /** The install's granted scopes; edit it to make one missing. */
  readonly scopes: Set<string>;
  /** Every known address and its Slack user ID. `addUser`, `deactivateUser` and `removeUser` keep it. */
  readonly knownUsers: Map<string, string>;
  readonly addUser: (input: FakeSlackUserInput) => FakeSlackUser;
  /** Slack answers `account_inactive` for this address from now on, while still knowing it. */
  readonly deactivateUser: (email: string) => void;
  readonly removeUser: (email: string) => void;
  /** The bot is a legacy custom integration: `users.lookupByEmail` refuses. */
  readonly setCustomBotUser: (enabled: boolean) => void;
  /** Every token issued so far answers `token_expired`; a refresh still works. */
  readonly expireToken: () => void;
  /** Turns token rotation on (default) or off for the next code exchange. */
  readonly rotate: (on?: boolean) => void;
  /** The next Web API call answers 429 with this `Retry-After`, once. */
  readonly rateLimitNext: (seconds: number) => void;
  /** The next Web API call answers `{ ok: false, error }`, once. */
  readonly failNext: (error: string) => void;
  /** The workspace's token answers `account_inactive` (the default), or works again. */
  readonly deactivateWorkspace: (active?: boolean) => void;
  /** An authorization code without the page, for the OAuth tests. */
  readonly issueCode: (input?: { readonly redirectUri?: string }) => string;
  /** The next authorize visit answers `error=access_denied`, once. */
  readonly denyNextAuthorize: () => void;
  /** A message another bot posted in a conversation, for `cant_update_message`. */
  readonly seedOtherBotMessage: (input: { readonly channel: string; readonly text: string }) => { readonly channel: string; readonly ts: string };
  /** Everything posted, newest last. */
  readonly messages: () => readonly FakeSlackMessage[];
  /** Every successful edit, newest last. */
  readonly edits: () => readonly FakeSlackEdit[];
  /** Every request, newest last. */
  readonly calls: () => readonly FakeSlackCall[];
  readonly close: () => Promise<void>;
};

type CodeRecord = { readonly redirectUri: string; used: boolean };

const portOf = (server: { readonly address: () => unknown }): number => {
  const address = server.address();
  const port: unknown = typeof address === "object" && address !== null ? Reflect.get(address, "port") : undefined;
  if (typeof port !== "number") {
    throw new Error("the fake server isn't listening");
  }
  return port;
};

const readBody = (request: IncomingMessage): Promise<Buffer> => {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    resolve(Buffer.concat(chunks));
  });
  request.on("error", reject);
  return promise;
};

const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void => {
  response.writeHead(status, { "content-type": "application/json;charset=UTF-8", ...headers });
  response.end(JSON.stringify(body));
};

/** A request's fields, from a form body or a JSON one. Every value is a string on the wire. */
const fieldsOf = (body: Buffer, contentType: string): Readonly<Record<string, string>> => {
  const text = body.toString("utf8");
  if (text === "") return {};
  if (contentType.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {};
    }
    if (typeof parsed !== "object" || parsed === null) return {};
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      fields[key] = typeof value === "string" ? value : typeof value === "boolean" || typeof value === "number" ? String(value) : "";
    }
    return fields;
  }
  return Object.fromEntries(new URLSearchParams(text));
};

const boolField = (fields: Readonly<Record<string, string>>, name: string, fallback: boolean): boolean => {
  const value = fields[name];
  return value === undefined ? fallback : value !== "false" && value !== "0";
};

const stringField = (fields: Readonly<Record<string, string>>, name: string): string | null => {
  const value = fields[name];
  return value === undefined || value === "" ? null : value;
};

const tokenOf = (request: IncomingMessage, fields: Readonly<Record<string, string>>, query: URLSearchParams): string | null => {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }
  return stringField(fields, "token") ?? query.get("token");
};

const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");

const random = (prefix: string): string => `${prefix}${randomBytes(12).toString("hex")}`;

/** Starts the fake Slack Web API on loopback. */
export const startFakeSlack = async (options: FakeSlackOptions = {}): Promise<FakeSlack> => {
  const team = { id: options.teamId ?? "T0FAKEOSTRA", name: options.teamName ?? "Acme Test" };
  const bot = {
    id: options.botId ?? "B0FAKEOSTRA",
    userId: options.botUserId ?? "U0FAKEBOT",
    name: options.botName ?? "ostra",
  };
  const appId = options.appId ?? "A0FAKEOSTRA";
  const clientId = options.clientId ?? "fake-client-id";
  const clientSecret = options.clientSecret ?? "fake-client-secret";
  const redirectUrl = options.redirectUrl ?? "http://localhost:3000/api/slack/callback";
  const token = options.token ?? random("xoxb-fake-");
  const scopes = new Set(options.scopes ?? ["chat:write", "users:read.email"]);

  const knownUsers = new Map<string, string>();
  const usersById = new Map<string, FakeSlackUser>();
  const inactiveEmails = new Set<string>();
  let customBotUser = false;
  let workspaceActive = true;
  let rotating = false;

  const validTokens = new Set<string>([token]);
  const expiredTokens = new Set<string>();

  const addUser = (input: FakeSlackUserInput): FakeSlackUser => {
    const id = input.id ?? random("U0FAKE");
    const user: FakeSlackUser = {
      id,
      email: input.email,
      name: input.name ?? input.email.split("@")[0] ?? input.email,
      teamId: team.id,
      isBot: input.isBot ?? false,
      active: true,
    };
    knownUsers.set(input.email.toLowerCase(), id);
    usersById.set(id, user);
    inactiveEmails.delete(input.email.toLowerCase());
    return user;
  };
  for (const user of options.users ?? []) {
    addUser(user);
  }

  const userByEmail = (email: string): FakeSlackUser | null => {
    const normalized = email.toLowerCase();
    const id = knownUsers.get(normalized);
    if (id === undefined) return null;
    const stored = usersById.get(id);
    if (stored !== undefined) return stored;
    const user: FakeSlackUser = { id, email: normalized, name: normalized.split("@")[0] ?? normalized, teamId: team.id, isBot: false, active: !inactiveEmails.has(normalized) };
    usersById.set(id, user);
    return user;
  };

  const deactivateUser = (email: string): void => {
    const normalized = email.toLowerCase();
    inactiveEmails.add(normalized);
    const user = userByEmail(normalized);
    if (user !== null) user.active = false;
  };

  const removeUser = (email: string): void => {
    const normalized = email.toLowerCase();
    const id = knownUsers.get(normalized);
    knownUsers.delete(normalized);
    inactiveEmails.delete(normalized);
    if (id !== undefined) usersById.delete(id);
  };

  const dmChannels = new Map<string, string>();
  const dmOpen = (userId: string): string => {
    const existing = dmChannels.get(userId);
    if (existing !== undefined) return existing;
    const opened = random("D0FAKE");
    dmChannels.set(userId, opened);
    return opened;
  };

  const messages: FakeSlackMessage[] = [];
  const edits: FakeSlackEdit[] = [];
  const calls: FakeSlackCall[] = [];
  let messageSeq = 0;
  const nextTs = (): string => {
    messageSeq += 1;
    return `${String(Math.floor(Date.now() / 1000))}.${String(messageSeq).padStart(6, "0")}`;
  };

  const codes = new Map<string, CodeRecord>();
  const issueCode = (input: { readonly redirectUri?: string } = {}): string => {
    const code = random("code-");
    codes.set(code, { redirectUri: input.redirectUri ?? redirectUrl, used: false });
    return code;
  };

  type RefreshRecord = { used: boolean };
  const refreshTokens = new Map<string, RefreshRecord>();

  let rateLimit: number | null = null;
  let failNextError: string | null = null;
  let denyNext = false;

  type Answer = { readonly status: number; readonly body: Record<string, unknown>; readonly headers?: Readonly<Record<string, string>>; readonly channel?: string; readonly ts?: string };
  const ok = (body: Record<string, unknown>, channel?: string, ts?: string): Answer => ({ status: 200, body: { ok: true, ...body }, ...(channel === undefined ? {} : { channel }), ...(ts === undefined ? {} : { ts }) });
  const error = (name: string, extra: Record<string, unknown> = {}, status = 200, headers: Readonly<Record<string, string>> = {}): Answer => ({ status, body: { ok: false, error: name, ...extra }, headers });

  const authenticate = (candidate: string | null): Answer | null => {
    if (candidate === null) return error("not_authed");
    if (!validTokens.has(candidate)) return error("invalid_auth");
    if (expiredTokens.has(candidate)) return error("token_expired");
    if (!workspaceActive) return error("account_inactive");
    return null;
  };

  const requireScope = (scope: string): Answer | null => (scopes.has(scope) ? null : error("missing_scope", { needed: scope, provided: [...scopes].join(",") }));

  const lookupByEmail = (email: string | null, queryToken: string | null): Answer => {
    if (email === null) return error("missing_argument", { arg: "email" });
    const auth = authenticate(queryToken);
    if (auth !== null) return auth;
    const scope = requireScope("users:read.email");
    if (scope !== null) return scope;
    if (customBotUser) return error("not_allowed_token_type", { warning: "custom bot users cannot use this method" });
    const user = userByEmail(email);
    if (user === null) return error("users_not_found");
    if (!user.active || inactiveEmails.has(email.toLowerCase())) return error("account_inactive");
    return ok({
      user: {
        id: user.id,
        team_id: user.teamId,
        name: user.name,
        deleted: false,
        is_bot: user.isBot,
        profile: { email: user.email, display_name: user.name, real_name: user.name },
      },
    });
  };

  const postMessage = (fields: Readonly<Record<string, string>>, headerToken: string | null): Answer => {
    const auth = authenticate(headerToken ?? stringField(fields, "token"));
    if (auth !== null) return auth;
    const scope = requireScope("chat:write");
    if (scope !== null) return scope;
    const channel = stringField(fields, "channel");
    const text = fields["text"] ?? "";
    if (channel === null) return error("channel_not_found");
    if (text.length > 40_000) return error("msg_too_long", { warning: "message_truncated" });
    let conversation: string | null = null;
    if (channel.startsWith("U")) {
      const user = usersById.get(channel);
      if (user?.active === true) {
        conversation = dmOpen(user.id);
      }
    } else if (channel.startsWith("D")) {
      conversation = [...dmChannels.values()].includes(channel) ? channel : null;
    }
    if (conversation === null) return error("channel_not_found");
    const ts = nextTs();
    const credentials = headerToken ?? stringField(fields, "token") ?? "";
    const message: FakeSlackMessage = {
      id: `${conversation}:${ts}`,
      channel: conversation,
      ts,
      text,
      mrkdwn: boolField(fields, "mrkdwn", true),
      unfurlLinks: boolField(fields, "unfurl_links", false),
      unfurlMedia: boolField(fields, "unfurl_media", true),
      tokenDigest: digestOf(credentials),
      botId: bot.id,
      postedAt: Date.now(),
    };
    messages.push(message);
    return ok({ channel: conversation, ts, message: { type: "message", user: bot.userId, bot_id: bot.id, text, ts, channel: conversation } }, conversation, ts);
  };

  const updateMessage = (fields: Readonly<Record<string, string>>, headerToken: string | null): Answer => {
    const auth = authenticate(headerToken ?? stringField(fields, "token"));
    if (auth !== null) return auth;
    const scope = requireScope("chat:write");
    if (scope !== null) return scope;
    const channel = stringField(fields, "channel");
    const ts = stringField(fields, "ts");
    const text = fields["text"] ?? "";
    if (channel === null) return error("channel_not_found");
    if (channel.startsWith("U")) return error("channel_not_found");
    if (![...dmChannels.values()].includes(channel)) return error("channel_not_found");
    if (ts === null) return error("message_not_found");
    const message = messages.find((one) => one.channel === channel && one.ts === ts);
    if (message === undefined) return error("message_not_found");
    if (message.botId !== bot.id) return error("cant_update_message");
    const credentials = headerToken ?? stringField(fields, "token") ?? "";
    const edited: FakeSlackMessage = { ...message, text };
    const index = messages.indexOf(message);
    messages[index] = edited;
    edits.push({ id: message.id, channel, ts, text, tokenDigest: digestOf(credentials), editedAt: Date.now() });
    return ok({ channel, ts, text }, channel, ts);
  };

  const exchange = (request: IncomingMessage, fields: Readonly<Record<string, string>>): Answer => {
    let basicClientId: string | null = null;
    let basicClientSecret: string | null = null;
    const header = request.headers.authorization;
    if (typeof header === "string" && header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
      const [id, secret] = decoded.split(":");
      basicClientId = id ?? null;
      basicClientSecret = secret ?? null;
    }
    const suppliedId = stringField(fields, "client_id") ?? basicClientId;
    const suppliedSecret = stringField(fields, "client_secret") ?? basicClientSecret;
    if (suppliedId !== clientId || suppliedSecret !== clientSecret) return error("bad_client_secret");
    const scope = [...scopes].join(",");
    const grant = stringField(fields, "grant_type") ?? "";
    const refreshToken = stringField(fields, "refresh_token");
    if (grant === "refresh_token" || refreshToken !== null) {
      if (refreshToken === null) return error("invalid_refresh_token");
      const record = refreshTokens.get(refreshToken);
      if (record === undefined || record.used) return error("invalid_refresh_token");
      record.used = true;
      const accessToken = random("xoxb-fake-");
      const nextRefresh = random("xoxe-1-fake-");
      validTokens.add(accessToken);
      refreshTokens.set(nextRefresh, { used: false });
      return ok({
        access_token: accessToken,
        token_type: "bot",
        scope,
        bot_user_id: bot.userId,
        app_id: appId,
        expires_in: 43_200,
        refresh_token: nextRefresh,
        team: { name: team.name, id: team.id },
      });
    }
    const code = stringField(fields, "code");
    if (code === null) return error("invalid_code");
    const record = codes.get(code);
    if (record === undefined || record.used) return error("invalid_code");
    const redirectUri = stringField(fields, "redirect_uri");
    if (redirectUri !== null && redirectUri !== record.redirectUri) return error("bad_redirect_uri");
    record.used = true;
    const refresh = rotating ? random("xoxe-1-fake-") : null;
    if (refresh !== null) refreshTokens.set(refresh, { used: false });
    return ok({
      access_token: token,
      token_type: "bot",
      scope,
      bot_user_id: bot.userId,
      app_id: appId,
      ...(refresh === null ? {} : { expires_in: 43_200, refresh_token: refresh }),
      team: { name: team.name, id: team.id },
    });
  };

  const authorize = (requestUrl: string): Answer => {
    const url = new URL(requestUrl, "http://127.0.0.1");
    if (url.searchParams.get("client_id") !== clientId) {
      return { status: 400, body: { ok: false, error: "invalid_client_id" } };
    }
    const state = url.searchParams.get("state");
    const target = new URL(redirectUrl);
    if (denyNext) {
      denyNext = false;
      target.searchParams.set("error", "access_denied");
    } else {
      target.searchParams.set("code", issueCode({ redirectUri: url.searchParams.get("redirect_uri") ?? redirectUrl }));
    }
    if (state !== null) target.searchParams.set("state", state);
    return { status: 302, body: {}, headers: { location: target.toString() } };
  };

  const handleApi = (request: IncomingMessage, fields: Readonly<Record<string, string>>, query: URLSearchParams, method: string): Answer => {
    const headerToken = typeof request.headers.authorization === "string" && request.headers.authorization.startsWith("Bearer ") ? request.headers.authorization.slice("Bearer ".length) : null;
    if (rateLimit !== null) {
      const retryAfter = rateLimit;
      rateLimit = null;
      return error("ratelimited", {}, 429, { "retry-after": String(retryAfter) });
    }
    if (failNextError !== null) {
      const failure = failNextError;
      failNextError = null;
      return error(failure);
    }
    switch (method) {
      case "auth.test": {
        const auth = authenticate(headerToken ?? stringField(fields, "token"));
        if (auth !== null) return auth;
        return ok({ team: team.name, team_id: team.id, user: bot.name, user_id: bot.userId, bot_id: bot.id, is_enterprise_install: false });
      }
      case "users.lookupByEmail":
        return lookupByEmail(query.get("email"), headerToken ?? query.get("token"));
      case "chat.postMessage":
        return postMessage(fields, headerToken);
      case "chat.update":
        return updateMessage(fields, headerToken);
      case "oauth.v2.access":
        return exchange(request, fields);
      default:
        return error("unknown_method", {}, 404);
    }
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const route = url.pathname;
      const body = await readBody(request);
      const fields = fieldsOf(body, request.headers["content-type"] ?? "");
      if (route === "/oauth/v2/authorize" && request.method === "GET") {
        const answer = authorize(request.url ?? "/");
        const tokenDigest = null;
        calls.push({ method: "oauth.v2.authorize", route, tokenDigest, status: answer.status, ok: answer.status < 400, error: answer.status < 400 ? null : "invalid_client_id", channel: null, ts: null });
        if (answer.headers?.["location"] !== undefined) {
          response.writeHead(answer.status, { location: answer.headers["location"] });
          response.end();
          return;
        }
        sendJson(response, answer.status, answer.body);
        return;
      }
      if (!route.startsWith("/api/") || request.method !== (route === "/api/users.lookupByEmail" ? "GET" : "POST")) {
        sendJson(response, 404, { ok: false, error: "not_found" });
        return;
      }
      const method = route.slice("/api/".length);
      const answer = handleApi(request, fields, url.searchParams, method);
      const token = tokenOf(request, fields, url.searchParams);
      const errorName = typeof answer.body["error"] === "string" ? answer.body["error"] : null;
      calls.push({
        method,
        route,
        tokenDigest: token === null ? null : digestOf(token),
        status: answer.status,
        ok: answer.body["ok"] === true,
        error: errorName,
        channel: answer.channel ?? null,
        ts: answer.ts ?? null,
      });
      sendJson(response, answer.status, answer.body, answer.headers ?? {});
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = portOf(server);
  const url = `http://127.0.0.1:${String(port)}`;

  return {
    url,
    apiUrl: `${url}/api`,
    authorizeUrl: `${url}/oauth/v2/authorize`,
    token,
    team,
    bot,
    appId,
    clientId,
    clientSecret,
    redirectUrl,
    scopes,
    knownUsers,
    addUser,
    deactivateUser,
    removeUser,
    setCustomBotUser: (enabled) => {
      customBotUser = enabled;
    },
    expireToken: () => {
      for (const issued of validTokens) expiredTokens.add(issued);
    },
    rotate: (on = true) => {
      rotating = on;
    },
    rateLimitNext: (seconds) => {
      rateLimit = seconds;
    },
    failNext: (name) => {
      failNextError = name;
    },
    deactivateWorkspace: (active = false) => {
      workspaceActive = active;
    },
    issueCode,
    denyNextAuthorize: () => {
      denyNext = true;
    },
    seedOtherBotMessage: (input) => {
      const ts = nextTs();
      const credentials = token;
      messages.push({
        id: `${input.channel}:${ts}`,
        channel: input.channel,
        ts,
        text: input.text,
        mrkdwn: true,
        unfurlLinks: false,
        unfurlMedia: true,
        tokenDigest: digestOf(credentials),
        botId: random("B0OTHER"),
        postedAt: Date.now(),
      });
      return { channel: input.channel, ts };
    },
    messages: () => [...messages],
    edits: () => [...edits],
    calls: () => [...calls],
    close: () => {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      server.close(() => {
        resolve(undefined);
      });
      server.closeAllConnections();
      return promise;
    },
  };
};
