import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Clock } from "../clock.ts";
import { AgentSessionId, AppUserId, IssueId, LinearUserId, OrganizationId, TicketKey } from "../ids.ts";
import type { Logger } from "../log.ts";
import { parseManifestLink } from "../manifest.ts";
import type { OAuthAppManifest } from "../manifest.ts";
import { silentLogger } from "../log.ts";
import { sha256Base64Url } from "../util.ts";
import { buildCreatedPayload, buildPromptedPayload, makeWebhookRequest } from "./payloads.ts";
import type { FakeIssue, FakePerson } from "./payloads.ts";
import { deriveStatus, goesStale, baseStatus, LINEAR_RULES } from "./rules.ts";
import type { FakeRules, FakeStatus, Touch, TouchType } from "./rules.ts";

// A local stand-in for Linear: the OAuth endpoints, the two GraphQL mutations and one query that agent mode
// uses, and a webhook sender that signs like Linear does. It is built from Linear's docs and from the SDK's own
// types. Every pass it gives is a pass against these assumptions (see rules.ts), never against real Linear.

export type DeliveryAttempt = {
  readonly sentAt: number;
  readonly ackMs: number | null;
  readonly status: number | null;
  readonly outcome: "ok" | "http-error" | "timeout" | "network-error";
};

export type DeliveryRecord = {
  readonly deliveryId: string;
  readonly sessionId: AgentSessionId;
  readonly action: "created" | "prompted";
  readonly attempts: readonly DeliveryAttempt[];
  /** Round trip of the attempt that got a 2xx, or null if none did. */
  readonly ackMs: number | null;
  readonly delivered: boolean;
};

type MutableDelivery = {
  readonly deliveryId: string;
  readonly sessionId: AgentSessionId;
  readonly action: "created" | "prompted";
  readonly attempts: DeliveryAttempt[];
  ackMs: number | null;
  delivered: boolean;
};

export type FakeActivityView = {
  readonly id: string;
  readonly type: TouchType;
  readonly signal: string | null;
  readonly ephemeral: boolean;
  /** The text of the activity, so a scenario can check what was (and was not) said. Null for an action. */
  readonly body: string | null;
  /** On the scenario clock. */
  readonly at: number;
  /** `performance.now()`. */
  readonly perfAt: number;
};

export type FakeSessionView = {
  readonly id: AgentSessionId;
  readonly issue: FakeIssue;
  readonly status: FakeStatus;
  /** No activity or link inside the first-activity deadline. Linear shows the agent as unresponsive. */
  readonly unresponsive: boolean;
  /** Round trip of the `created` webhook. */
  readonly ackMs: number | null;
  /** From the first `created` attempt being sent to the first agent activity arriving. */
  readonly firstActivityMs: number | null;
  /** The same, for the first external-URL update. */
  readonly firstLinkMs: number | null;
  readonly activities: readonly FakeActivityView[];
  readonly externalUrls: readonly { readonly label: string; readonly url: string }[];
  /** Times a touch arrived after more than `staleAfterMs` of silence while the session was expected to be working. */
  readonly staleEpisodes: number;
  /** The longest silence between two touches while the session was expected to be working, on the scenario clock. */
  readonly maxGapMs: number;
  /** Things Linear's docs forbid an agent to do, such as posting after a stop other than the final response. */
  readonly violations: readonly string[];
  readonly deliveries: readonly DeliveryRecord[];
  /** Requests that repeated an activity ID already used in this session. The fake answers them as the first one. */
  readonly repeatedActivityIds: number;
};

/** `rejected` is a permanent refusal (a 400 the client must not retry), unlike `http500` and `ratelimited`. */
export type ActivityFault = "http500" | "ratelimited" | "rejected";

export type CreateAppResult =
  | {
      readonly ok: true;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly webhookSecret: string;
      readonly manifest: OAuthAppManifest;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

export type AuthorizationRecord = {
  readonly actor: string | null;
  readonly scopes: readonly string[];
  readonly pkce: boolean;
};

export type FakeLinearOptions = {
  readonly clock: Clock;
  readonly rules?: Partial<FakeRules>;
  /** Waits between delivery attempts after a failure, in real ms. Linear's are 1 min, 1 h and 6 h. */
  readonly retryDelaysMs?: readonly number[];
  /** Linear's clock minus this machine's, in ms, as stamped into webhooks. Positive puts every timestamp in the future. */
  readonly clockSkewMs?: number;
  readonly log?: Logger;
};

export type FakeLinear = {
  readonly apiUrl: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly organizationId: OrganizationId;
  readonly admin: FakePerson;
  /**
   * The admin's personal API key. Linear takes it as the raw Authorization header (no "Bearer"). It can read and comment,
   * but an agent activity posted with it is refused, as in real Linear (403, "unexpected authentication method (apiKey)").
   */
  readonly adminApiKey: string;
  readonly rules: FakeRules;
  createAppFromLink: (link: string, deliveryUrl: string) => CreateAppResult;
  setDeliveryUrl: (deliveryUrl: string) => void;
  /** Whether `actor=app` is honoured. Turn it off to model a Linear that hands out a person's token. */
  setHonorActorApp: (honor: boolean) => void;
  authorizations: () => readonly AuthorizationRecord[];
  /** An OAuth access token for the app user, or for the admin as a person, without going through the install. For tests of a saved token. */
  mintToken: (kind: "app" | "person") => string;
  appUser: () => { readonly id: AppUserId; readonly name: string } | undefined;
  /** Creates an issue and a session on it, and sends the `created` webhook. Resolves when delivery ends. */
  delegate: (options?: { readonly title?: string; readonly description?: string }) => Promise<{ readonly sessionId: AgentSessionId; readonly delivery: DeliveryRecord }>;
  /** Creates the session and returns the payload without sending it, for a signed replay from outside. */
  seedSession: (options?: { readonly title?: string; readonly description?: string }) => { readonly sessionId: AgentSessionId; readonly createdPayload: () => Record<string, unknown> };
  /** A person posts in the session: a follow-up, or Send stop request. Resolves when delivery ends. */
  prompt: (sessionId: AgentSessionId, body: string, options?: { readonly stop?: boolean }) => Promise<DeliveryRecord>;
  session: (sessionId: AgentSessionId) => FakeSessionView | undefined;
  sessions: () => readonly FakeSessionView[];
  /** The next activity mutations fail in this order, one fault per call. */
  injectActivityFaults: (faults: readonly ActivityFault[]) => void;
  /** Every GraphQL call waits this long (real ms) before it is answered. */
  setApiLatencyMs: (ms: number) => void;
  apiCalls: () => Readonly<Record<string, number>>;
  close: () => Promise<void>;
};

const graphqlRequestSchema = z.object({ query: z.string(), variables: z.record(z.string(), z.unknown()).optional() });

const body250k = z.string().min(1).max(250_000);
const contentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thought"), body: body250k }),
  z.object({ type: z.literal("response"), body: body250k }),
  z.object({ type: z.literal("error"), body: body250k }),
  z.object({ type: z.literal("elicitation"), body: body250k }),
  z.object({
    type: z.literal("action"),
    action: z.string().min(1),
    parameter: z.string(),
    result: z.string().max(250_000).optional(),
  }),
]);

const activityInputSchema = z.object({
  id: z.uuid().optional(),
  agentSessionId: z.string().min(1),
  content: z.unknown(),
  ephemeral: z.boolean().nullish(),
  signal: z.string().nullish(),
});

const updateInputSchema = z.object({
  externalUrls: z.array(z.object({ label: z.string().min(1), url: z.url() })).nullish(),
  summary: z.string().min(1).max(255).nullish(),
});

type ActivityRec = FakeActivityView;

type SessionRec = {
  readonly id: AgentSessionId;
  readonly issue: FakeIssue;
  readonly creator: FakePerson;
  readonly appUserId: AppUserId;
  readonly createdAtClock: number;
  /** The comment this session hangs from: a reply to it in the thread is a follow-up (a `prompted` event). */
  readonly commentId: string;
  createdAtPerf: number;
  readonly activities: ActivityRec[];
  externalUrls: { label: string; url: string }[];
  lastTouch: Touch | undefined;
  lastTouchAt: number;
  firstActivityMs: number | null;
  firstLinkMs: number | null;
  staleEpisodes: number;
  maxGapMs: number;
  stop: "none" | "awaiting-final" | "closed";
  violations: string[];
  readonly deliveries: MutableDelivery[];
  readonly activityIds: Set<string>;
  repeatedActivityIds: number;
};

type App = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly webhookSecret: string;
  readonly manifest: OAuthAppManifest;
  deliveryUrl: string;
};

type Principal = { readonly appUserId: AppUserId | null; readonly name: string; readonly via: "oauth" | "apiKey" };

const readText = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const graphqlError = (
  res: ServerResponse,
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {},
): void => {
  json(res, status, { errors: [{ message, extensions: { type, userError: status < 500 } }] }, headers);
};

export const createFakeLinear = async (options: FakeLinearOptions): Promise<FakeLinear> => {
  const { clock } = options;
  const log = options.log ?? silentLogger;
  const rules: FakeRules = { ...LINEAR_RULES, ...options.rules };
  const retryDelaysMs = options.retryDelaysMs ?? [];
  const clockSkewMs = options.clockSkewMs ?? 0;
  const lifetime = new AbortController();

  const organizationId = OrganizationId.parse(`org-${randomUUID()}`);
  const admin: FakePerson = { id: LinearUserId.parse(`user-${randomUUID()}`), name: "Test Admin", email: "admin@example.test" };
  const adminApiKey = `lin_api_${randomBytes(24).toString("hex")}`;

  let app: App | undefined;
  let appUser: { readonly id: AppUserId; readonly name: string } | undefined;
  let honorActorApp = true;
  let apiLatencyMs = 0;
  let lastSyncId = 1000;
  let issueCounter = 0;
  const faults: ActivityFault[] = [];
  const codes = new Map<string, { readonly redirectUri: string; readonly challenge: string; readonly actor: string | null; readonly scopes: readonly string[] }>();
  const tokens = new Map<string, Principal>();
  const sessions = new Map<AgentSessionId, SessionRec>();
  const authorizations: AuthorizationRecord[] = [];
  const calls = new Map<string, number>();
  const countCall = (name: string): void => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
  };

  // --- sessions -------------------------------------------------------------------------------

  const touch = (session: SessionRec, type: TouchType, signal: string | null, ephemeral: boolean, body: string | null): void => {
    const now = clock.now();
    const before = baseStatus(session.lastTouch);
    if (goesStale(before)) {
      const gap = now - session.lastTouchAt;
      session.maxGapMs = Math.max(session.maxGapMs, gap);
      if (gap > rules.staleAfterMs) session.staleEpisodes += 1;
    }
    // After a stop prompt Linear expects one final response or error and nothing else.
    if (type === "prompt") {
      session.stop = signal === "stop" ? "awaiting-final" : "none";
    } else if (type !== "update") {
      const isFinal = (type === "response" && signal !== "continue") || type === "error";
      if (session.stop === "awaiting-final") {
        if (isFinal) session.stop = "closed";
        else session.violations.push(`activity ${type} posted after a stop request, before the final response`);
      } else if (session.stop === "closed") {
        session.violations.push(`activity ${type} posted after the final response to a stop request`);
      }
    }
    session.lastTouch = { type, signal };
    session.lastTouchAt = now;
    session.activities.push({ id: randomUUID(), type, signal, ephemeral, body, at: now, perfAt: performance.now() });
  };

  const view = (session: SessionRec): FakeSessionView => {
    const now = clock.now();
    const sinceCreated = performance.now() - session.createdAtPerf;
    const firstResponse = Math.min(session.firstActivityMs ?? Infinity, session.firstLinkMs ?? Infinity);
    const unresponsive = Number.isFinite(firstResponse)
      ? firstResponse > rules.firstActivityDeadlineMs
      : sinceCreated > rules.firstActivityDeadlineMs;
    const created = session.deliveries.find((d) => d.action === "created");
    return {
      id: session.id,
      issue: session.issue,
      status: deriveStatus(session.lastTouch, session.lastTouchAt, now, rules),
      unresponsive,
      ackMs: created?.ackMs ?? null,
      firstActivityMs: session.firstActivityMs,
      firstLinkMs: session.firstLinkMs,
      activities: [...session.activities],
      externalUrls: [...session.externalUrls],
      staleEpisodes: session.staleEpisodes,
      maxGapMs: session.maxGapMs,
      violations: [...session.violations],
      deliveries: session.deliveries.map((d) => ({ ...d, attempts: [...d.attempts] })),
      repeatedActivityIds: session.repeatedActivityIds,
    };
  };

  const makeSession = (title: string, description: string): SessionRec => {
    if (appUser === undefined) throw new Error("fake Linear: no app is installed yet");
    issueCounter += 1;
    const issue: FakeIssue = {
      id: IssueId.parse(`issue-${randomUUID()}`),
      identifier: TicketKey.parse(`OST-${String(issueCounter)}`),
      title,
      description,
      url: `https://linear.app/fake/issue/OST-${String(issueCounter)}`,
    };
    const session: SessionRec = {
      id: AgentSessionId.parse(`session-${randomUUID()}`),
      issue,
      creator: admin,
      appUserId: appUser.id,
      createdAtClock: clock.now(),
      commentId: randomUUID(),
      createdAtPerf: performance.now(),
      activities: [],
      externalUrls: [],
      lastTouch: undefined,
      lastTouchAt: clock.now(),
      firstActivityMs: null,
      firstLinkMs: null,
      staleEpisodes: 0,
      maxGapMs: 0,
      stop: "none",
      violations: [],
      deliveries: [],
      activityIds: new Set(),
      repeatedActivityIds: 0,
    };
    sessions.set(session.id, session);
    return session;
  };

  const common = (session: SessionRec, now: number) => {
    if (app === undefined || appUser === undefined) throw new Error("fake Linear: no app is installed yet");
    return {
      organizationId,
      appUserId: appUser.id,
      oauthClientId: app.clientId,
      sessionId: session.id,
      issue: session.issue,
      creator: session.creator,
      now,
    };
  };

  // --- webhook delivery -----------------------------------------------------------------------

  const deliver = async (
    session: SessionRec,
    action: "created" | "prompted",
    payloadAt: (now: number) => Record<string, unknown>,
  ): Promise<DeliveryRecord> => {
    if (app === undefined) throw new Error("fake Linear: no app is installed yet");
    const deliveryId = randomUUID();
    const record: MutableDelivery = {
      deliveryId,
      sessionId: session.id,
      action,
      attempts: [],
      ackMs: null,
      delivered: false,
    };
    session.deliveries.push(record);
    const waits = [0, ...retryDelaysMs];
    for (const wait of waits) {
      if (wait > 0) {
        try {
          await delay(wait, undefined, { signal: lifetime.signal });
        } catch {
          break;
        }
      }
      // A retry is stamped afresh, or the SDK's 60 s freshness check would refuse it. (Assumed: unverified.)
      const request = makeWebhookRequest({ secret: app.webhookSecret, payload: payloadAt(Date.now() + clockSkewMs), deliveryId });
      const sentAt = performance.now();
      if (action === "created" && record.attempts.length === 0) session.createdAtPerf = sentAt;
      try {
        const response = await fetch(app.deliveryUrl, {
          method: "POST",
          headers: request.headers,
          body: request.rawBody,
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(rules.ackDeadlineMs)]),
        });
        await response.text();
        const ackMs = performance.now() - sentAt;
        record.attempts.push({ sentAt, ackMs, status: response.status, outcome: response.ok ? "ok" : "http-error" });
        if (response.ok) {
          record.ackMs = ackMs;
          record.delivered = true;
          break;
        }
      } catch (error: unknown) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        record.attempts.push({ sentAt, ackMs: null, status: null, outcome: timedOut ? "timeout" : "network-error" });
        if (lifetime.signal.aborted) break;
      }
    }
    log.info("fake_delivery", { session: session.id, action, attempts: record.attempts.length, delivered: record.delivered });
    return { ...record, attempts: [...record.attempts] };
  };

  // --- HTTP: GraphQL --------------------------------------------------------------------------

  const handleActivityCreate = (res: ServerResponse, principal: Principal, variables: Record<string, unknown>): void => {
    countCall("agentActivityCreate");
    const fault = faults.shift();
    if (fault === "http500") {
      graphqlError(res, 500, "internal error", "Internal server error");
      return;
    }
    if (fault === "ratelimited") {
      graphqlError(res, 400, "ratelimited", "Rate limit exceeded", { "retry-after": "1" });
      return;
    }
    if (fault === "rejected") {
      graphqlError(res, 400, "invalid input", "Activity rejected");
      return;
    }
    const input = activityInputSchema.safeParse(variables["input"]);
    if (!input.success) {
      graphqlError(res, 400, "invalid input", "Invalid AgentActivityCreateInput");
      return;
    }
    const session = sessions.get(AgentSessionId.parse(input.data.agentSessionId));
    if (session === undefined) {
      graphqlError(res, 400, "invalid input", "Entity not found: AgentSession");
      return;
    }
    if (principal.via === "apiKey") {
      graphqlError(res, 403, "forbidden", "Using an unexpected authentication method (apiKey) for an operation");
      return;
    }
    if (principal.appUserId === null || session.appUserId !== principal.appUserId) {
      graphqlError(res, 403, "forbidden", "An app cannot publish activities to another agent's session");
      return;
    }
    const content = contentSchema.safeParse(input.data.content);
    if (!content.success) {
      graphqlError(res, 400, "invalid input", "Invalid activity content");
      return;
    }
    const type = content.data.type;
    const signal = input.data.signal ?? null;
    const ephemeral = input.data.ephemeral === true;
    if (signal === "stop") {
      graphqlError(res, 400, "invalid input", "stop is reserved for user prompts");
      return;
    }
    if (signal === "continue" && type !== "response") {
      graphqlError(res, 400, "invalid input", "continue is only valid with a response");
      return;
    }
    if ((signal === "select" || signal === "auth") && type !== "elicitation") {
      graphqlError(res, 400, "invalid input", `${signal} is only valid with an elicitation`);
      return;
    }
    if (ephemeral && type !== "thought" && type !== "action") {
      graphqlError(res, 400, "invalid input", "only thoughts and actions can be ephemeral");
      return;
    }
    // Assumption, unverified: Linear treats a repeated client-made ID as the same activity, not a new one.
    const repeated = input.data.id !== undefined && session.activityIds.has(input.data.id);
    if (input.data.id !== undefined) session.activityIds.add(input.data.id);
    if (repeated) {
      session.repeatedActivityIds += 1;
    } else {
      touch(session, type, signal, ephemeral, "body" in content.data ? content.data.body : null);
      session.firstActivityMs ??= performance.now() - session.createdAtPerf;
    }
    lastSyncId += 1;
    json(res, 200, {
      data: {
        agentActivityCreate: {
          __typename: "AgentActivityPayload",
          lastSyncId,
          agentActivity: { id: randomUUID() },
          success: true,
        },
      },
    });
  };

  const handleSessionUpdate = (res: ServerResponse, principal: Principal, variables: Record<string, unknown>): void => {
    countCall("agentSessionUpdate");
    const id = z.string().min(1).safeParse(variables["id"]);
    const input = updateInputSchema.safeParse(variables["input"]);
    const session = id.success ? sessions.get(AgentSessionId.parse(id.data)) : undefined;
    if (!input.success || session === undefined) {
      graphqlError(res, 400, "invalid input", "Invalid AgentSessionUpdateInput");
      return;
    }
    if (principal.appUserId === null || session.appUserId !== principal.appUserId) {
      graphqlError(res, 403, "forbidden", "Only the owning app can update a session");
      return;
    }
    const externalUrls = input.data.externalUrls ?? undefined;
    if (externalUrls !== undefined) {
      session.externalUrls = externalUrls.map(({ label, url }) => ({ label, url }));
      // Setting a link keeps a session from being marked unresponsive, and wakes a pending one (docs).
      session.firstLinkMs ??= performance.now() - session.createdAtPerf;
    }
    touch(session, "update", null, false, null);
    lastSyncId += 1;
    json(res, 200, {
      data: {
        agentSessionUpdate: {
          __typename: "AgentSessionPayload",
          lastSyncId,
          agentSession: { id: session.id },
          success: true,
        },
      },
    });
  };

  const commentInputSchema = z.object({ issueId: z.string().min(1), body: z.string().min(1), parentId: z.string().min(1).nullish() });

  // A reply to the comment a session hangs from is a follow-up: Linear sends the app a `prompted` event. The webhook goes
  // out after the mutation is answered, as Linear sends it, so a caller cannot rely on it having arrived by then.
  const handleCommentCreate = (res: ServerResponse, principal: Principal, variables: Record<string, unknown>): void => {
    countCall("commentCreate");
    const input = commentInputSchema.safeParse(variables["input"]);
    if (!input.success) {
      graphqlError(res, 400, "invalid input", "Invalid CommentCreateInput");
      return;
    }
    const parent = input.data.parentId ?? undefined;
    const session = parent === undefined ? undefined : [...sessions.values()].find((candidate) => candidate.commentId === parent);
    if (parent !== undefined && session === undefined) {
      graphqlError(res, 400, "invalid input", "Entity not found: Comment");
      return;
    }
    if (session !== undefined) {
      if (session.issue.id !== input.data.issueId) {
        graphqlError(res, 400, "invalid input", "The parent comment is on another issue");
        return;
      }
      if (principal.appUserId === null) {
        const body = input.data.body;
        touch(session, "prompt", null, false, body);
        deliver(session, "prompted", (now) => ({ ...buildPromptedPayload({ ...common(session, now), activityId: randomUUID(), body, stop: false }) })).catch(() => undefined);
      }
    }
    lastSyncId += 1;
    json(res, 200, { data: { commentCreate: { __typename: "CommentPayload", lastSyncId, comment: { id: randomUUID() }, success: true } } });
  };

  const handleGraphql = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const text = await readText(req);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      graphqlError(res, 400, "invalid input", "Body is not JSON");
      return;
    }
    const request = graphqlRequestSchema.safeParse(parsedJson);
    if (!request.success) {
      graphqlError(res, 400, "invalid input", "Not a GraphQL request");
      return;
    }
    const authorization = req.headers.authorization ?? "";
    // An OAuth token comes as "Bearer <token>". A personal API key comes bare, as Linear takes it.
    const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    const principal: Principal | undefined =
      token !== undefined
        ? tokens.get(token)
        : authorization === adminApiKey
          ? { appUserId: null, name: admin.name, via: "apiKey" }
          : undefined;
    if (principal === undefined) {
      graphqlError(res, 401, "authentication error", "Authentication required, not authenticated");
      return;
    }
    if (apiLatencyMs > 0) await delay(apiLatencyMs, undefined, { signal: lifetime.signal });
    const { query } = request.data;
    const variables = request.data.variables ?? {};
    if (/\bagentActivityCreate\s*\(/.test(query)) {
      handleActivityCreate(res, principal, variables);
    } else if (/\bagentSessionUpdate\s*\(/.test(query)) {
      handleSessionUpdate(res, principal, variables);
    } else if (/\bagentSession\s*\(/.test(query)) {
      countCall("agentSession");
      const id = z.string().min(1).safeParse(variables["id"]);
      const found = id.success ? sessions.get(AgentSessionId.parse(id.data)) : undefined;
      if (found === undefined) {
        graphqlError(res, 400, "invalid input", "Entity not found: AgentSession");
      } else {
        json(res, 200, {
          data: { agentSession: { id: found.id, status: view(found).status, comment: { id: found.commentId }, issue: { id: found.issue.id, identifier: found.issue.identifier } } },
        });
      }
    } else if (/\bcommentCreate\s*\(/.test(query)) {
      handleCommentCreate(res, principal, variables);
    } else if (/\bviewer\b/.test(query)) {
      countCall("viewer");
      json(res, 200, {
        data: {
          viewer: {
            id: principal.appUserId ?? admin.id,
            name: principal.name,
            app: principal.appUserId !== null,
          },
          organization: { id: organizationId },
        },
      });
    } else {
      graphqlError(res, 400, "graphql error", "The fake Linear does not implement this operation");
    }
  };

  // --- HTTP: OAuth ----------------------------------------------------------------------------

  const handleAuthorize = (url: URL, res: ServerResponse): void => {
    countCall("oauth/authorize");
    const p = url.searchParams;
    const redirectUri = p.get("redirect_uri");
    const state = p.get("state");
    if (app?.clientId !== p.get("client_id")) {
      json(res, 400, { error: "invalid_client" });
      return;
    }
    if (redirectUri === null || !app.manifest.oauth.redirect_uris.includes(redirectUri)) {
      json(res, 400, { error: "invalid_redirect_uri" });
      return;
    }
    const challenge = p.get("code_challenge");
    if (p.get("response_type") !== "code" || state === null || challenge === null || p.get("code_challenge_method") !== "S256") {
      json(res, 400, { error: "invalid_request", detail: "code flow with state and an S256 challenge is required" });
      return;
    }
    const scopes = (p.get("scope") ?? "").split(/[\s,]+/).filter((s) => s.length > 0);
    authorizations.push({ actor: p.get("actor"), scopes, pkce: true });
    // The admin clicks Authorize, instantly.
    const code = randomBytes(16).toString("hex");
    codes.set(code, { redirectUri, challenge, actor: p.get("actor"), scopes });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", state);
    res.writeHead(302, { location: target.toString() });
    res.end();
  };

  const handleToken = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    countCall("oauth/token");
    const form = new URLSearchParams(await readText(req));
    const code = codes.get(form.get("code") ?? "");
    if (
      app === undefined ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("client_id") !== app.clientId ||
      form.get("client_secret") !== app.clientSecret ||
      code?.redirectUri !== form.get("redirect_uri") ||
      sha256Base64Url(form.get("code_verifier") ?? "") !== code.challenge
    ) {
      json(res, 400, { error: "invalid_grant" });
      return;
    }
    codes.delete(form.get("code") ?? "");
    const asApp = code.actor === "app" && honorActorApp;
    if (asApp && appUser === undefined) {
      appUser = { id: AppUserId.parse(`app-user-${randomUUID()}`), name: app.manifest.oauth.client_name };
    }
    const accessToken = `lin_oauth_${randomBytes(24).toString("hex")}`;
    tokens.set(
      accessToken,
      asApp && appUser !== undefined
        ? { appUserId: appUser.id, name: appUser.name, via: "oauth" }
        : { appUserId: null, name: admin.name, via: "oauth" },
    );
    json(res, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 86399,
      scope: code.scopes,
      refresh_token: `lin_refresh_${randomBytes(24).toString("hex")}`,
    });
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake-linear.invalid");
    const run = async (): Promise<void> => {
      if (req.method === "POST" && url.pathname === "/graphql") await handleGraphql(req, res);
      else if (req.method === "GET" && url.pathname === "/oauth/authorize") handleAuthorize(url, res);
      else if (req.method === "POST" && url.pathname === "/oauth/token") await handleToken(req, res);
      else json(res, 404, { error: "not-found" });
    };
    run().catch((error: unknown) => {
      if (lifetime.signal.aborted) {
        res.destroy();
        return;
      }
      log.error("fake_request_failed", { error: error instanceof Error ? error.name : "unknown" });
      if (!res.headersSent) json(res, 500, { error: "fake-failed" });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake Linear has no TCP address");
  const base = `http://127.0.0.1:${String(address.port)}`;

  const must = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`fake Linear: ${what}`);
    return value;
  };

  return {
    apiUrl: `${base}/graphql`,
    authorizeUrl: `${base}/oauth/authorize`,
    tokenUrl: `${base}/oauth/token`,
    organizationId,
    admin,
    adminApiKey,
    rules,
    createAppFromLink: (link, deliveryUrl) => {
      const parsed = parseManifestLink(link);
      if (!parsed.ok) return { ok: false, problems: parsed.problems };
      app = {
        clientId: randomBytes(16).toString("hex"),
        clientSecret: randomBytes(24).toString("hex"),
        webhookSecret: `lin_wh_${randomBytes(24).toString("hex")}`,
        manifest: parsed.manifest,
        deliveryUrl,
      };
      return { ok: true, clientId: app.clientId, clientSecret: app.clientSecret, webhookSecret: app.webhookSecret, manifest: parsed.manifest };
    },
    setDeliveryUrl: (deliveryUrl) => {
      must(app, "no app yet").deliveryUrl = deliveryUrl;
    },
    setHonorActorApp: (honor) => {
      honorActorApp = honor;
    },
    authorizations: () => [...authorizations],
    mintToken: (kind) => {
      const accessToken = `lin_oauth_${randomBytes(24).toString("hex")}`;
      if (kind === "app") {
        const owner = must(appUser, "no app user yet: install first");
        tokens.set(accessToken, { appUserId: owner.id, name: owner.name, via: "oauth" });
      } else {
        tokens.set(accessToken, { appUserId: null, name: admin.name, via: "oauth" });
      }
      return accessToken;
    },
    appUser: () => appUser,
    delegate: async (opts = {}) => {
      const session = makeSession(opts.title ?? "Fix the flaky retry in the sync job", opts.description ?? "Steps to reproduce are in the thread.");
      const delivery = await deliver(session, "created", (now) => ({ ...buildCreatedPayload(common(session, now)) }));
      return { sessionId: session.id, delivery };
    },
    seedSession: (opts = {}) => {
      const session = makeSession(opts.title ?? "Replayed delegation", opts.description ?? "Replay fixture.");
      return {
        sessionId: session.id,
        createdPayload: () => ({ ...buildCreatedPayload(common(session, Date.now())) }),
      };
    },
    prompt: async (sessionId, body, opts = {}) => {
      const session = must(sessions.get(sessionId), "unknown session");
      const stop = opts.stop === true;
      touch(session, "prompt", stop ? "stop" : null, false, body);
      return deliver(session, "prompted", (now) => ({
        ...buildPromptedPayload({ ...common(session, now), activityId: randomUUID(), body, stop }),
      }));
    },
    session: (sessionId) => {
      const session = sessions.get(sessionId);
      return session === undefined ? undefined : view(session);
    },
    sessions: () => [...sessions.values()].map(view),
    injectActivityFaults: (list) => {
      faults.push(...list);
    },
    setApiLatencyMs: (ms) => {
      apiLatencyMs = ms;
    },
    apiCalls: () => Object.fromEntries(calls),
    close: async () => {
      lifetime.abort();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
};
