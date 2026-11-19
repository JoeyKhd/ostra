import type { IncomingMessage, ServerResponse } from "node:http";

import { secretRefSchema } from "@ostra/adapter-sdk";
import type { CodeHostAdapter, Logger, SecretStoreAdapter, TrackerAdapter } from "@ostra/adapter-sdk";
import type { Db, Prisma } from "@ostra/db";
import type { Clock } from "@ostra/domain";
import type { Jobs } from "@ostra/jobs";
import { connectionIdSchema, organizationIdSchema, parseJson, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, WebhookDeliveryId } from "@ostra/protocol";

import { readBody, sendJson } from "../http.ts";

// The webhook inbox (ADR 0013, ADR 0047, ticket 13): `POST /webhooks/linear/:connectionId` and
// `POST /webhooks/github/:connectionId` on core's public address. The connection's ID routes a
// delivery to its organization. Nothing but these steps comes before the 200:
//   1. read the raw body, capped at 1 MiB;
//   2. verify it with the connection's secret, through the adapter (pure: no call is made);
//   3. one transaction: insert the `WebhookDelivery`, claimed by its unique (connection, delivery
//      ID) and, for Linear, (connection, signature hash), and enqueue `webhook.process`;
//   4. answer 200. A duplicate answers 200 too, and enqueues nothing.
// The insert has a deadline (OSTRA_WEBHOOK_INSERT_DEADLINE_MS): past it, or on any failure, the
// answer is 503 so the sender retries, instead of an event lost behind a 200. A bad signature or a
// stale timestamp answers 400 and stores nothing.
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

export type WebhookKind = "linear" | "github";

export const webhookKinds: readonly WebhookKind[] = ["linear", "github"];

const pathPattern = /^\/webhooks\/(linear|github)(?:\/([^/]+))?\/?$/;

/** GitHub's App-wide address, before connections had their own (milestone 1's manifests). */
const GITHUB_APP_TARGET_HEADER = "x-github-hook-installation-target-id";

export type WebhookInboxDeps = {
  readonly db: Db;
  readonly jobs: Pick<Jobs, "sendInTx">;
  readonly secretStore: SecretStoreAdapter;
  /** Verifies a tracker's delivery, by the connection's kind. Pure: no call is made. */
  readonly trackerVerifiers: { readonly linear: Pick<TrackerAdapter, "verifyWebhook"> };
  readonly codeHost: Pick<CodeHostAdapter, "verifyWebhook">;
  readonly clock: Clock;
  readonly logger: Logger;
  /** OSTRA_WEBHOOK_INSERT_DEADLINE_MS. */
  readonly insertDeadlineMs: number;
  /** OSTRA_DEV_BLOCK_WEBHOOKS (development only): these routes answer 503 and store nothing. */
  readonly blocked: ReadonlySet<WebhookKind>;
};

/** Reads OSTRA_DEV_BLOCK_WEBHOOKS: a comma list of `linear` and `github`, honoured outside production only. */
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
  readonly secretRef: string | null;
};

type Verified = {
  readonly deliveryId: WebhookDeliveryId;
  readonly event: string;
  readonly signatureHash: string | null;
  readonly sentAt: number | null;
  readonly payload: Prisma.InputJsonValue;
};

const headerMap = (request: IncomingMessage): Readonly<Record<string, string | undefined>> => {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
};

/** Reads a request's body to its end and drops it, for at most `ms`. */
const drain = (request: IncomingMessage, ms: number): Promise<void> =>
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
const toPayload = (value: unknown): Prisma.InputJsonValue | null => {
  return toJson(value) ?? null;
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

  const findConnection = async (kind: WebhookKind, rawId: string | undefined, headers: Readonly<Record<string, string | undefined>>): Promise<ConnectionRow | null> => {
    const select = { id: true, organizationId: true, webhookSecretSecretRef: true } as const;
    let row: { readonly id: string; readonly organizationId: string; readonly webhookSecretSecretRef: string | null } | null = null;
    if (rawId !== undefined) {
      const id = connectionIdSchema.safeParse(decodeURIComponent(rawId));
      if (!id.success) {
        return null;
      }
      row = await deps.db.connection.findFirst({ where: { id: id.data, kind, state: { in: ["active", "failed"] } }, select });
    } else if (kind === "github") {
      // Milestone 1's App-wide URL: the App's ID, which GitHub names in a header, finds the connection.
      const appId = headers[GITHUB_APP_TARGET_HEADER];
      if (appId === undefined || !/^\d{1,20}$/.test(appId)) {
        return null;
      }
      const rows = await deps.db.connection.findMany({ where: { kind: "github", appId, state: { in: ["active", "failed"] } }, select, take: 2 });
      row = rows.length === 1 ? (rows[0] ?? null) : null;
    }
    return row === null
      ? null
      : { id: connectionIdSchema.parse(row.id), organizationId: organizationIdSchema.parse(row.organizationId), secretRef: row.webhookSecretSecretRef };
  };

  type Verification = { readonly ok: true; readonly verified: Verified } | { readonly ok: false; readonly reason: string };

  const verify = (kind: WebhookKind, rawBody: Buffer, headers: Readonly<Record<string, string | undefined>>, secret: string, now: number): Verification => {
    switch (kind) {
      case "linear": {
        const result = deps.trackerVerifiers.linear.verifyWebhook({ rawBody, headers, secret, now });
        if (!result.ok) {
          return { ok: false, reason: result.reason };
        }
        const payload = toPayload(result.body);
        if (payload === null) {
          return { ok: false, reason: "malformed" };
        }
        return {
          ok: true,
          verified: { deliveryId: result.deliveryId, event: linearEventOf(result.body), signatureHash: result.signatureHash, sentAt: result.sentAt, payload },
        };
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
        return { ok: true, verified: { deliveryId: deliveryId.data, event, signatureHash: null, sentAt: null, payload } };
      }
      default:
        return kind satisfies never;
    }
  };

  /** One transaction: the row, claimed by its unique keys, and its job. `false`: a duplicate. */
  const claim = async (connection: ConnectionRow, verified: Verified, transitMs: number | null): Promise<boolean> =>
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
        await deps.jobs.sendInTx(tx, "webhook.process", {
          organizationId: connection.organizationId,
          connectionId: connection.id,
          deliveryId: verified.deliveryId,
        });
        return true;
      },
      { maxWait: deps.insertDeadlineMs, timeout: deps.insertDeadlineMs },
    );

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
    const kind: WebhookKind = match[1] === "github" ? "github" : "linear";
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
    const connection = await findConnection(kind, rawId, headers);
    if (connection === null) {
      request.resume();
      sendJson(response, 404, { error: "not-found" });
      return true;
    }
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
      sendJson(response, 400, { error: verification.reason });
      return true;
    }
    const { verified } = verification;
    const transitMs = verified.sentAt === null ? null : receivedAt - verified.sentAt;
    if (transitMs !== null && Math.abs(transitMs) > WEBHOOK_SKEW_WARN_MS) {
      connectionLogger.warn("webhook.clock-skew", { deliveryId: verified.deliveryId, transitMs });
    }
    let outcome: { readonly done: true; readonly value: boolean } | { readonly done: false };
    try {
      outcome = await withDeadline(claim(connection, verified, transitMs));
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
