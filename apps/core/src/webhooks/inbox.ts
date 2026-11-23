import type { IncomingMessage, ServerResponse } from "node:http";

import { secretRefSchema } from "@ostra/adapter-sdk";
import type { CodeHostAdapter, Logger, SecretStoreAdapter, TrackerAdapter, TrackerCapabilities } from "@ostra/adapter-sdk";
import type { Db, DbEnum, Prisma } from "@ostra/db";
import { activateOnFirstDelivery, installationUsableInTx } from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock } from "@ostra/domain";
import type { Jobs } from "@ostra/jobs";
import { connectionIdSchema, organizationIdSchema, parseJson, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, WebhookDeliveryId } from "@ostra/protocol";

import { readBody, sendJson } from "../http.ts";

// The webhook inbox (ADR 0013, ADR 0047, ADR 0071, ticket 13): `POST /webhooks/linear/:connectionId`,
// `POST /webhooks/jira/:connectionId` (milestone 11, ticket 07) and `POST /webhooks/github/:connectionId`
// on core's public address. The connection's ID routes a delivery to its organization, and only
// that connection's secret verifies it. Nothing but these steps comes before the 200:
//   1. read the raw body, capped at 1 MiB;
//   2. verify it with the connection's secret, through the adapter (pure: no call is made);
//   3. one transaction: insert the `WebhookDelivery`, claimed by its unique (connection, delivery
//      ID) and, for a tracker, (connection, signature hash), and enqueue `webhook.process`; a
//      pending Jira connection's first valid delivery activates it in the same transaction;
//   4. answer 200. A duplicate answers 200 too, and enqueues nothing.
// The insert has a deadline (OSTRA_WEBHOOK_INSERT_DEADLINE_MS): past it, or on any failure, the
// answer is 503 so the sender retries, instead of an event lost behind a 200. A bad signature or a
// stale timestamp answers 400 (Jira's bad signature 401, and its connection's `badSignatureAt` is
// set for step 3's red row) and stores nothing. A disconnected (`revoked`) tracker connection's
// address answers 410 Gone and stores nothing, so its sender stops (Q351); so does an unknown
// Jira one.
//
// Jira's freshness window is 20 minutes (its secondary flow and retries come late, `adapter-jira`'s
// `JIRA_WEBHOOK_MAX_AGE_MS`), against Linear's 60 s. The claims are what make that safe: a delivery
// row is never pruned (it goes only with its connection), and a Jira delivery is claimed by its
// `X-Atlassian-Webhook-Identifier` and by its signature's hash, so a replay inside the window, or
// after it, is a duplicate however it's labelled. A late Jira delivery is no clock skew: only a
// timestamp ahead of ours warns for it.
//
// Ported from spikes/linear-agent-mode/src/server.ts (verify, claim, 200, then work).
//
// Logs carry the connection, the delivery ID, the reason and the transit, never the body.

/** The largest body the inbox reads: a working value (ticket 13). */
export const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024;

/** A sender's clock this far from ours logs a warning: a minute off would refuse every webhook. */
export const WEBHOOK_SKEW_WARN_MS = 10_000;

/** How long a connection's webhook secret is kept in memory before it's read again. */
const SECRET_CACHE_MS = 5 * 60_000;

export type WebhookKind = "linear" | "jira" | "github";

export const webhookKinds: readonly WebhookKind[] = ["linear", "jira", "github"];

const pathPattern = /^\/webhooks\/(linear|jira|github)(?:\/([^/]+))?\/?$/;

/** A tracker kind's verifier: its adapter, pure for this, and whether it declares agent sessions (agent mode's lane). */
export type TrackerVerifier = Pick<TrackerAdapter, "verifyWebhook"> & { readonly capabilities: Pick<TrackerCapabilities, "agentSessions"> };

/** GitHub's App-wide address, before connections had their own (milestone 1's manifests). */
const GITHUB_APP_TARGET_HEADER = "x-github-hook-installation-target-id";

export type WebhookInboxDeps = {
  readonly db: Db;
  readonly jobs: Pick<Jobs, "sendInTx">;
  readonly secretStore: SecretStoreAdapter;
  /** Verifies a tracker's delivery, by the connection's kind. Pure: no call is made. */
  readonly trackerVerifiers: { readonly linear: TrackerVerifier; readonly jira: TrackerVerifier };
  readonly codeHost: Pick<CodeHostAdapter, "verifyWebhook">;
  /** A pending Jira connection's activation by its first delivery, and its bad-signature mark (ticket 07). */
  readonly audit: AuditLog;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly logger: Logger;
  /** OSTRA_WEBHOOK_INSERT_DEADLINE_MS. */
  readonly insertDeadlineMs: number;
  /** OSTRA_DEV_BLOCK_WEBHOOKS (development only): these routes answer 503 and store nothing. */
  readonly blocked: ReadonlySet<WebhookKind>;
};

/** Reads OSTRA_DEV_BLOCK_WEBHOOKS: a comma list of `linear`, `jira` and `github`, honoured outside production only. */
export const parseBlockedWebhooks = (value: string | undefined, mode: "development" | "production" | "test"): ReadonlySet<WebhookKind> => {
  if (mode === "production" || value === undefined) {
    return new Set();
  }
  const names = value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  return new Set(webhookKinds.filter((kind) => names.includes(kind)));
};

type ConnectionRow = {
  readonly id: ConnectionId;
  readonly organizationId: OrganizationId;
  readonly state: "pending" | "active" | "failed";
  readonly secretRef: string | null;
};

/** A route's connection: found, gone (a disconnected tracker connection: 410), or no such one (404). */
type Lookup = { readonly kind: "found"; readonly connection: ConnectionRow } | { readonly kind: "gone" } | { readonly kind: "unknown" };

type Verified = {
  readonly deliveryId: WebhookDeliveryId;
  readonly event: string;
  readonly signatureHash: string | null;
  readonly sentAt: number | null;
  readonly payload: Prisma.InputJsonValue;
  /** Milestone 4 (F-136): the GitHub installation the delivery is from; `null` for one that names none, and for Linear. */
  readonly installationId: string | null;
};

/** GitHub's App events about an installation itself, stored whatever its state: they link or remove it. */
const INSTALLATION_EVENTS: ReadonlySet<string> = new Set(["installation"]);

/** The installation a GitHub delivery names (`installation.id`), as a string; `null` when none. */
const installationIdOf = (body: unknown): string | null => {
  const installation: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "installation") : undefined;
  const id: unknown = typeof installation === "object" && installation !== null ? Reflect.get(installation, "id") : undefined;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
    return String(id);
  }
  return typeof id === "string" && /^\d{1,20}$/.test(id) ? id : null;
};

/** A request's headers by their lowercase names, a repeated one joined. */
export const headerMap = (request: IncomingMessage): Readonly<Record<string, string | undefined>> => {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
};

/** Reads a request's body to its end and drops it, for at most `ms`. */
export const drain = (request: IncomingMessage, ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      request.destroy();
      resolve();
    }, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    request.on("end", done);
    request.on("error", done);
    request.resume();
  });

type JsonIn = Prisma.InputJsonValue | null;

/** A parsed JSON value as Prisma stores it; `undefined` for anything JSON can't hold. */
const toJson = (value: unknown): JsonIn | undefined => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const items: JsonIn[] = [];
    for (const item of value) {
      const converted = toJson(item);
      if (converted === undefined) return undefined;
      items.push(converted);
    }
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, JsonIn> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toJson(item);
      if (converted === undefined) return undefined;
      out[key] = converted;
    }
    return out;
  }
  return undefined;
};

/** A verified body as a stored payload: a JSON object or array, never a bare `null`. */
export const toPayload = (value: unknown): Prisma.InputJsonValue | null => {
  return toJson(value) ?? null;
};

/** Jira's event, `jira:issue_updated` or `comment_created`, from its body's `webhookEvent`. */
const jiraEventOf = (body: unknown): string => {
  const event: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "webhookEvent") : undefined;
  return typeof event === "string" && event !== "" ? event.slice(0, 128) : "unknown";
};

const linearEventOf = (body: unknown): string => {
  if (typeof body === "object" && body !== null) {
    const type: unknown = Reflect.get(body, "type");
    const action: unknown = Reflect.get(body, "action");
    if (typeof type === "string") {
      return typeof action === "string" ? `${type}.${action}`.slice(0, 128) : type.slice(0, 128);
    }
  }
  return "unknown";
};

/** Whether a Linear delivery is an agent session's event (`AgentSessionEvent.created`, `.prompted`). */
export const isAgentSessionEvent = (event: string): boolean => event === "AgentSessionEvent" || event.startsWith("AgentSessionEvent.");

export const createWebhookInbox = (deps: WebhookInboxDeps) => {
  const secrets = new Map<string, { readonly value: string; readonly until: number }>();

  const secretFor = async (connection: ConnectionRow): Promise<string | null> => {
    if (connection.secretRef === null) {
      return null;
    }
    const cacheKey = `${connection.id}:${connection.secretRef}`;
    const cached = secrets.get(cacheKey);
    const now = deps.clock.now();
    if (cached !== undefined && cached.until > now) {
      return cached.value;
    }
    const ref = secretRefSchema.safeParse(connection.secretRef);
    if (!ref.success) {
      return null;
    }
    const read = await deps.secretStore.get(connection.organizationId, ref.data);
    if (!read.ok) {
      return null;
    }
    secrets.set(cacheKey, { value: read.value, until: now + SECRET_CACHE_MS });
    return read.value;
  };

  const findConnection = async (kind: WebhookKind, rawId: string | undefined, headers: Readonly<Record<string, string | undefined>>): Promise<Lookup> => {
    const select = { id: true, organizationId: true, state: true, webhookSecretSecretRef: true } as const;
    let row: { readonly id: string; readonly organizationId: string; readonly state: DbEnum.ConnectionState; readonly webhookSecretSecretRef: string | null } | null = null;
    if (rawId !== undefined) {
      const id = connectionIdSchema.safeParse(decodeURIComponent(rawId));
      if (!id.success) {
        return { kind: "unknown" };
      }
      row = await deps.db.connection.findFirst({ where: { id: id.data, kind }, select });
      if (row === null) {
        // Jira's admin webhook can't be deleted by ostra: an address that names no connection is gone (ticket 07).
        return kind === "jira" ? { kind: "gone" } : { kind: "unknown" };
      }
    } else if (kind === "github") {
      // Milestone 1's App-wide URL: the App's ID, which GitHub names in a header, finds the connection.
      const appId = headers[GITHUB_APP_TARGET_HEADER];
      if (appId === undefined || !/^\d{1,20}$/.test(appId)) {
        return { kind: "unknown" };
      }
      const rows = await deps.db.connection.findMany({ where: { kind: "github", appId, state: { in: ["active", "failed"] } }, select, take: 2 });
      row = rows.length === 1 ? (rows[0] ?? null) : null;
    }
    if (row === null) {
      return { kind: "unknown" };
    }
    const state = row.state;
    switch (state) {
      case "revoked":
        // A disconnected tracker connection (ADR 0071, Q351): 410, so its sender stops retrying.
        return kind === "github" ? { kind: "unknown" } : { kind: "gone" };
      case "pending":
        // Only Jira's pending connection takes a delivery: its first valid one activates it.
        if (kind !== "jira") {
          return { kind: "unknown" };
        }
        break;
      case "active":
      case "failed":
        break;
      default:
        return state satisfies never;
    }
    return {
      kind: "found",
      connection: { id: connectionIdSchema.parse(row.id), organizationId: organizationIdSchema.parse(row.organizationId), state, secretRef: row.webhookSecretSecretRef },
    };
  };

  type Verification = { readonly ok: true; readonly verified: Verified } | { readonly ok: false; readonly reason: string };

  const verify = (kind: WebhookKind, rawBody: Buffer, headers: Readonly<Record<string, string | undefined>>, secret: string, now: number): Verification => {
    switch (kind) {
      case "linear":
      case "jira": {
        const result = deps.trackerVerifiers[kind].verifyWebhook({ rawBody, headers, secret, now });
        if (!result.ok) {
          return { ok: false, reason: result.reason };
        }
        const payload = toPayload(result.body);
        if (payload === null) {
          return { ok: false, reason: "malformed" };
        }
        const event = kind === "linear" ? linearEventOf(result.body) : jiraEventOf(result.body);
        return { ok: true, verified: { deliveryId: result.deliveryId, event, signatureHash: result.signatureHash, sentAt: result.sentAt, payload, installationId: null } };
      }
      case "github": {
        const body = rawBody.toString("utf8");
        if (!deps.codeHost.verifyWebhook({ headers, body, secret })) {
          return { ok: false, reason: headers["x-hub-signature-256"] === undefined ? "missing-signature" : "bad-signature" };
        }
        const deliveryId = webhookDeliveryIdSchema.safeParse(headers["x-github-delivery"]);
        const json = parseJson(body);
        const payload = json.ok ? toPayload(json.value) : null;
        if (!deliveryId.success || payload === null) {
          return { ok: false, reason: "malformed" };
        }
        const event = (headers["x-github-event"] ?? "unknown").slice(0, 128);
        // GitHub sends no timestamp: its transit isn't known.
        return { ok: true, verified: { deliveryId: deliveryId.data, event, signatureHash: null, sentAt: null, payload, installationId: json.ok ? installationIdOf(json.value) : null } };
      }
      default:
        return kind satisfies never;
    }
  };

  /** One transaction: the row, claimed by its unique keys, its job, and a pending Jira connection's activation. `false`: a duplicate. */
  const claim = async (kind: WebhookKind, connection: ConnectionRow, verified: Verified, transitMs: number | null): Promise<boolean> =>
    deps.db.$transaction(
      async (tx) => {
        // Postgres itself cancels a statement past the deadline, so nothing outlives the 503.
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(deps.insertDeadlineMs)}, true)`;
        const inserted = await tx.webhookDelivery.createMany({
          data: [
            {
              organizationId: connection.organizationId,
              connectionId: connection.id,
              deliveryId: verified.deliveryId,
              event: verified.event,
              payload: verified.payload,
              signatureHash: verified.signatureHash,
              transitMs,
            },
          ],
          skipDuplicates: true,
        });
        if (inserted.count === 0) {
          return false;
        }
        const ids = { organizationId: connection.organizationId, connectionId: connection.id, deliveryId: verified.deliveryId };
        // Milestone 11 (F-008/c1, ticket 07): a pending Jira connection's first valid delivery
        // connects it, with the claim, so its job finds it active. Anything else activates nothing.
        if (kind === "jira" && connection.state === "pending") {
          await activateOnFirstDelivery({ tx, audit: deps.audit, notices: deps.notices, clock: deps.clock }, { organizationId: connection.organizationId, connectionId: connection.id });
        }
        // Milestone 6 (F-012, ticket 13): a Linear agent session's event is agent mode's fast lane,
        // its own job; any other delivery is a hint for the ticket cache. Either job commits with the
        // claim, so a claim that fails leaves no job, and a job never runs without its claim. Only a
        // kind whose adapter declares agent sessions has the lane (milestone 11).
        if (kind !== "github" && deps.trackerVerifiers[kind].capabilities.agentSessions && isAgentSessionEvent(verified.event)) {
          await deps.jobs.sendInTx(tx, "linear.agent-event", ids);
        } else {
          await deps.jobs.sendInTx(tx, "webhook.process", ids);
        }
        return true;
      },
      { maxWait: deps.insertDeadlineMs, timeout: deps.insertDeadlineMs },
    );

  /** A Jira delivery refused for its signature: the connection's `badSignatureAt`, and its page told. */
  const markBadSignature = (connection: ConnectionRow): Promise<void> =>
    deps.db.$transaction(async (tx) => {
      await tx.connection.updateMany({ where: { id: connection.id, organizationId: connection.organizationId, kind: "jira" }, data: { badSignatureAt: new Date(deps.clock.now()) } });
      await deps.notices.emitInTx(tx, { organizationId: connection.organizationId, projectId: null, entity: "connection", entityId: connection.id });
    });

  const withDeadline = <T,>(work: Promise<T>): Promise<{ readonly done: true; readonly value: T } | { readonly done: false }> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({ done: false });
      }, deps.insertDeadlineMs);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve({ done: true, value });
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("the insert failed"));
        },
      );
    });

  /** The route handler: takes `POST /webhooks/...` and nothing else. */
  const handle = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const match = pathPattern.exec(url.pathname);
    if (match === null) {
      return false;
    }
    const kind: WebhookKind = match[1] === "github" ? "github" : match[1] === "jira" ? "jira" : "linear";
    const rawId = match[2];
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method-not-allowed" }, { allow: "POST" });
      return true;
    }
    const receivedAt = deps.clock.now();
    const logger = deps.logger.child({ component: "webhook-inbox", kind });
    if (deps.blocked.has(kind)) {
      // The demo's and the failure suite's "drop webhooks": the sender retries, and polling finds it.
      logger.info("webhook.blocked", {});
      request.resume();
      sendJson(response, 503, { error: "unavailable" }, { "retry-after": "60" });
      return true;
    }
    const headers = headerMap(request);
    const lookup = await findConnection(kind, rawId, headers);
    if (lookup.kind !== "found") {
      request.resume();
      if (lookup.kind === "gone") {
        logger.info("webhook.gone", {});
        sendJson(response, 410, { error: "gone" });
      } else {
        sendJson(response, 404, { error: "not-found" });
      }
      return true;
    }
    const { connection } = lookup;
    const connectionLogger = logger.child({ organizationId: connection.organizationId, connectionId: connection.id });
    const declared = Number(headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > WEBHOOK_BODY_MAX_BYTES) {
      // Said up front: answer before reading a byte of it.
      connectionLogger.warn("webhook.refused", { reason: "too-large", bytes: declared });
      // Read and drop it (a few seconds at most), so the sender sees the answer instead of a reset.
      await drain(request, 5_000);
      sendJson(response, 413, { error: "payload-too-large" }, { connection: "close" });
      return true;
    }
    const body = await readBody(request, WEBHOOK_BODY_MAX_BYTES);
    if (body === "too-large") {
      connectionLogger.warn("webhook.refused", { reason: "too-large" });
      sendJson(response, 413, { error: "payload-too-large" }, { connection: "close" });
      return true;
    }
    if (body === "timeout") {
      sendJson(response, 400, { error: "incomplete" });
      return true;
    }
    const secret = await secretFor(connection);
    if (secret === null) {
      // A connection with no webhook secret takes no webhooks: it polls (F-042).
      connectionLogger.warn("webhook.refused", { reason: "no-secret" });
      sendJson(response, 404, { error: "not-found" });
      return true;
    }
    const verification = verify(kind, body, headers, secret, receivedAt);
    if (!verification.ok) {
      connectionLogger.warn("webhook.refused", { reason: verification.reason, bytes: body.length });
      if (kind === "jira" && (verification.reason === "bad-signature" || verification.reason === "missing-signature")) {
        // Step 3's red row (F-008/c1): the time only, never a header or the body. Answered 401.
        await markBadSignature(connection).catch((error: unknown) => {
          connectionLogger.warn("webhook.bad-signature-unmarked", { error: error instanceof Error ? error.name : "unknown" });
        });
        sendJson(response, 401, { error: verification.reason });
        return true;
      }
      sendJson(response, 400, { error: verification.reason });
      return true;
    }
    const { verified } = verification;
    // Milestone 4 (F-136, ADR 0065): a GitHub delivery is stored only from an installation linked to
    // this connection. Any other gets a 202, so GitHub doesn't retry it, and changes nothing. An
    // `installation` event is the exception: it's how ostra learns of one, or of its removal.
    if (kind === "github" && !INSTALLATION_EVENTS.has(verified.event)) {
      const linked =
        verified.installationId !== null &&
        (await installationUsableInTx(deps.db, { organizationId: connection.organizationId, connectionId: connection.id, installationId: verified.installationId }));
      if (!linked) {
        connectionLogger.info("webhook.installation-not-linked", { deliveryId: verified.deliveryId, installationId: verified.installationId, event: verified.event });
        sendJson(response, 202, { status: "not-linked" });
        return true;
      }
    }
    const transitMs = verified.sentAt === null ? null : receivedAt - verified.sentAt;
    // Jira's timestamp is when the event was made, and its secondary flow and retries come minutes
    // later: only a time ahead of ours is skew there.
    if (transitMs !== null && (kind === "jira" ? -transitMs : Math.abs(transitMs)) > WEBHOOK_SKEW_WARN_MS) {
      connectionLogger.warn("webhook.clock-skew", { deliveryId: verified.deliveryId, transitMs });
    }
    let outcome: { readonly done: true; readonly value: boolean } | { readonly done: false };
    try {
      outcome = await withDeadline(claim(kind, connection, verified, transitMs));
    } catch (error) {
      connectionLogger.warn("webhook.insert-failed", { deliveryId: verified.deliveryId, error: error instanceof Error ? error.name : "unknown" });
      sendJson(response, 503, { error: "unavailable" }, { "retry-after": "5" });
      return true;
    }
    if (!outcome.done) {
      connectionLogger.warn("webhook.insert-deadline", { deliveryId: verified.deliveryId, deadlineMs: deps.insertDeadlineMs });
      sendJson(response, 503, { error: "unavailable" }, { "retry-after": "5" });
      return true;
    }
    const answeredInMs = deps.clock.now() - receivedAt;
    if (outcome.value) {
      connectionLogger.info("webhook.accepted", { deliveryId: verified.deliveryId, event: verified.event, transitMs, answeredInMs });
      sendJson(response, 200, { status: "accepted" });
    } else {
      connectionLogger.info("webhook.duplicate", { deliveryId: verified.deliveryId, answeredInMs });
      sendJson(response, 200, { status: "duplicate" });
    }
    return true;
  };

  return { handle };
};
