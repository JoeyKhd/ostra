import type { IncomingMessage, ServerResponse } from "node:http";

import { secretRefSchema } from "@ostra/adapter-sdk";
import type { Logger, SecretStoreAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { automationWebhookIdSchema, idempotencyKeyOf, receiveWebhookRequest, verifyWebhookRequest } from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock, JobQueue, TeamSettings, WebhookRequestOutcome } from "@ostra/domain";
import { automationIdSchema, organizationIdSchema, parseJson, projectIdSchema } from "@ostra/protocol";
import type { AutomationId, OrganizationId, ProjectId } from "@ostra/protocol";

import { sendJson } from "../http.ts";
import { drain, headerMap } from "./inbox.ts";

// Webhook automations' address (F-139, ADR 0056 amended 2026-11-21): `POST
// /webhooks/automations/<webhookId>` on core's public address. Before anything is written, in this
// order: the automation by its random ID (404), the body up to `OSTRA_WEBHOOK_BODY_MAX_KIB` (413), the
// signature or the bearer token the automation names (401), and the body as JSON, an empty one as
// `{}` (422). Then the domain's one transaction decides it (`receiveWebhookRequest`): the request
// rate (429 with Retry-After, nothing written), a repeat of its idempotency key, a pause, the filter,
// "skip while the last one is open", the hourly limit, and the start. A start is answered 202 with
// the task's ID; a request the automation's own settings skip, 200, so the sender doesn't retry it.
//
// Every request is logged with IDs, its outcome and its size: never its body, its key or a header.

const pathPattern = /^\/webhooks\/automations\/([^/]+)\/?$/;

/** How long a webhook's secret is kept in memory, by its reference: a new secret has a new reference, so it's read at once. */
const SECRET_CACHE_MS = 5 * 60_000;

/** How long a body may take to arrive. */
const BODY_TIMEOUT_MS = 10_000;

/**
 * A request's body up to `cap` bytes. Past the cap the rest is read and dropped, for a few seconds
 * at most, so the sender sees the 413 instead of a reset connection.
 */
const readCapped = (request: IncomingMessage, cap: number): Promise<Buffer | "too-large" | "timeout"> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: Buffer | "too-large" | "timeout"): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      request.off("data", onData);
      resolve(value);
    };
    const timer = setTimeout(() => {
      settle("timeout");
      request.destroy();
    }, BODY_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > cap) {
        settle("too-large");
        void drain(request, 5_000);
        return;
      }
      chunks.push(chunk);
    };
    request.on("data", onData);
    request.on("end", () => {
      settle(Buffer.concat(chunks));
    });
    request.on("error", () => {
      settle("timeout");
    });
  });

/** The transaction's deadline: past it the answer is 503, and the sender retries. */
const DECIDE_DEADLINE_MS = 15_000;

export type AutomationWebhookDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly secretStore: Pick<SecretStoreAdapter, "get">;
  readonly logger: Logger;
  /** The panel's address: the link to a task that its thread names. */
  readonly publicUrl: string;
  readonly team: Pick<TeamSettings, "webhookStartsPerHour" | "webhookRequestsPerMinute" | "webhookBodyMaxBytes">;
};

type WebhookRow = {
  readonly automationId: AutomationId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly auth: "signature" | "bearer";
  readonly secretRef: string;
  readonly idempotencyField: string | null;
};

/** The answer to a decided request, with its log line's event and fields. */
const answerOf = (outcome: Exclude<WebhookRequestOutcome, { readonly kind: "not-found" }>, startsPerHour: number) => {
  switch (outcome.kind) {
    case "started":
      return { status: 202, body: { status: "started", taskId: outcome.taskId, runId: outcome.runId }, headers: {}, event: "webhook-automation.started", fields: { runId: outcome.runId, taskId: outcome.taskId } };
    case "duplicate":
      return { status: 200, body: { status: "duplicate", taskId: outcome.taskId, runId: outcome.runId }, headers: {}, event: "webhook-automation.duplicate", fields: { runId: outcome.runId, taskId: outcome.taskId } };
    case "skipped":
      return {
        status: 200,
        body: { status: "skipped", reason: outcome.reason, runId: outcome.runId, ...(outcome.taskId === null ? {} : { taskId: outcome.taskId }) },
        headers: {},
        event: "webhook-automation.skipped",
        fields: { runId: outcome.runId, reason: outcome.reason, taskId: outcome.taskId },
      };
    case "hourly-limit":
      return {
        status: 429,
        body: { error: "hourly-limit", message: `The automation started ${String(startsPerHour)} tasks in the last hour and is paused until a project admin resumes it`, runId: outcome.runId },
        headers: {},
        event: "webhook-automation.refused",
        fields: { runId: outcome.runId, reason: "hourly-limit" },
      };
    case "rate-limited":
      return {
        status: 429,
        body: { error: "rate-limited", retryAfterSeconds: outcome.retryAfterSeconds },
        headers: { "retry-after": String(outcome.retryAfterSeconds) },
        event: "webhook-automation.refused",
        fields: { reason: "rate-limited", retryAfterSeconds: outcome.retryAfterSeconds },
      };
    case "prompt-too-long":
      return { status: 422, body: { error: "prompt-too-long", message: "The prompt this body renders is too long" }, headers: {}, event: "webhook-automation.refused", fields: { reason: "prompt-too-long" } };
    case "not-started":
      return {
        status: 422,
        body: { error: "not-started", reason: outcome.error, message: outcome.message, runId: outcome.runId },
        headers: {},
        event: "webhook-automation.not-started",
        fields: { runId: outcome.runId, reason: outcome.error },
      };
    default:
      return outcome satisfies never;
  }
};

export const createAutomationWebhooks = (deps: AutomationWebhookDeps) => {
  const secrets = new Map<string, { readonly value: string; readonly until: number }>();

  const secretFor = async (row: WebhookRow): Promise<string | null> => {
    const cacheKey = `${row.automationId}:${row.secretRef}`;
    const now = deps.clock.now();
    const cached = secrets.get(cacheKey);
    if (cached !== undefined && cached.until > now) {
      return cached.value;
    }
    const ref = secretRefSchema.safeParse(row.secretRef);
    if (!ref.success) {
      return null;
    }
    const read = await deps.secretStore.get(row.organizationId, ref.data);
    if (!read.ok) {
      return null;
    }
    if (secrets.size >= 10_000) {
      secrets.clear();
    }
    secrets.set(cacheKey, { value: read.value, until: now + SECRET_CACHE_MS });
    return read.value;
  };

  const findWebhook = async (rawId: string): Promise<WebhookRow | null> => {
    const id = automationWebhookIdSchema.safeParse(rawId);
    if (!id.success) {
      return null;
    }
    const row = await deps.db.automation.findFirst({
      where: { webhookId: id.data, kind: "webhook", deletedAt: null },
      select: { id: true, organizationId: true, projectId: true, webhookAuth: true, webhookSecretRef: true, idempotencyField: true },
    });
    if (row?.webhookAuth === null || row?.webhookAuth === undefined || row.webhookSecretRef === null) {
      return null;
    }
    return {
      automationId: automationIdSchema.parse(row.id),
      organizationId: organizationIdSchema.parse(row.organizationId),
      projectId: projectIdSchema.parse(row.projectId),
      auth: row.webhookAuth,
      secretRef: row.webhookSecretRef,
      idempotencyField: row.idempotencyField,
    };
  };

  /** The route handler: takes `POST /webhooks/automations/<id>` and nothing else. */
  const handle = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const match = pathPattern.exec(url.pathname);
    if (match === null) {
      return false;
    }
    if (request.method !== "POST") {
      request.resume();
      sendJson(response, 405, { error: "method-not-allowed" }, { allow: "POST" });
      return true;
    }
    const receivedAt = deps.clock.now();
    const webhook = await findWebhook(match[1] ?? "");
    if (webhook === null) {
      request.resume();
      sendJson(response, 404, { error: "not-found" });
      return true;
    }
    const logger = deps.logger.child({ component: "webhook-automation", organizationId: webhook.organizationId, projectId: webhook.projectId, automationId: webhook.automationId });
    const max = deps.team.webhookBodyMaxBytes;
    const headers = headerMap(request);
    const declared = Number(headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > max) {
      // Said up front: answered before a byte of it is read, then read and dropped so the sender sees the answer.
      logger.warn("webhook-automation.refused", { reason: "too-large", bytes: declared });
      await drain(request, 5_000);
      sendJson(response, 413, { error: "payload-too-large", maxBytes: max }, { connection: "close" });
      return true;
    }
    const body = await readCapped(request, max);
    if (body === "too-large") {
      logger.warn("webhook-automation.refused", { reason: "too-large" });
      sendJson(response, 413, { error: "payload-too-large", maxBytes: max }, { connection: "close" });
      return true;
    }
    if (body === "timeout") {
      sendJson(response, 400, { error: "incomplete" });
      return true;
    }
    const secret = await secretFor(webhook);
    if (secret === null) {
      logger.warn("webhook-automation.refused", { reason: "no-secret" });
      sendJson(response, 503, { error: "unavailable" }, { "retry-after": "60" });
      return true;
    }
    const verified = verifyWebhookRequest({ auth: webhook.auth, secret, rawBody: body, headers });
    if (!verified.ok) {
      logger.warn("webhook-automation.refused", { reason: verified.reason, bytes: body.length });
      sendJson(response, 401, { error: verified.reason });
      return true;
    }
    const text = body.toString("utf8");
    const json = text.trim() === "" ? { ok: true as const, value: {} } : parseJson(text);
    if (!json.ok) {
      logger.warn("webhook-automation.refused", { reason: "not-json", bytes: body.length });
      sendJson(response, 422, { error: "not-json", message: "The body isn't JSON" });
      return true;
    }
    const key = idempotencyKeyOf(headers["idempotency-key"], json.value, webhook.idempotencyField);
    if (!key.ok) {
      logger.warn("webhook-automation.refused", { reason: key.reason, bytes: body.length });
      sendJson(response, 422, { error: key.reason, message: "An idempotency key is at most 255 characters, with no control characters" });
      return true;
    }
    let outcome: WebhookRequestOutcome;
    try {
      outcome = await receiveWebhookRequest(
        {
          db: deps.db,
          jobs: deps.jobs,
          notices: deps.notices,
          audit: deps.audit,
          clock: deps.clock,
          publicUrl: deps.publicUrl,
          webhookStartsPerHour: deps.team.webhookStartsPerHour,
          webhookRequestsPerMinute: deps.team.webhookRequestsPerMinute,
          timeoutMs: DECIDE_DEADLINE_MS,
        },
        { organizationId: webhook.organizationId, automationId: webhook.automationId, body: json.value, idempotencyKey: key.key },
      );
    } catch (error) {
      logger.warn("webhook-automation.failed", { error: error instanceof Error ? error.name : "unknown", bytes: body.length });
      sendJson(response, 503, { error: "unavailable" }, { "retry-after": "5" });
      return true;
    }
    if (outcome.kind === "not-found") {
      // Deleted between the lookup and the lock.
      sendJson(response, 404, { error: "not-found" });
      return true;
    }
    const answer = answerOf(outcome, deps.team.webhookStartsPerHour);
    const fields = { ...answer.fields, keyed: key.key !== null, bytes: body.length, answeredInMs: deps.clock.now() - receivedAt };
    if (answer.status >= 400) {
      logger.warn(answer.event, fields);
    } else {
      logger.info(answer.event, fields);
    }
    sendJson(response, answer.status, answer.body, answer.headers);
    return true;
  };

  return { handle };
};
