import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createAgentSessionService } from "./agent-sessions.ts";
import type { AgentConfig, AgentSessionService } from "./agent-sessions.ts";
import { isAbortError, realClock } from "./clock.ts";
import type { Clock } from "./clock.ts";
import type { LinearEndpoints } from "./env.ts";
import type { AgentSessionId, AppUserId, OrganizationId } from "./ids.ts";
import { createLinearApi } from "./linear-api.ts";
import type { LinearApi } from "./linear-api.ts";
import type { Logger } from "./log.ts";
import { buildManifest, CALLBACK_PATH, WEBHOOK_PATH } from "./manifest.ts";
import type { ManifestResult } from "./manifest.ts";
import { buildAuthorizeUrl, createPkce, exchangeCode, randomState, scopesOf } from "./oauth.ts";
import type { TurnDriver } from "./turn-driver.ts";
import { errorName } from "./util.ts";
import { createDeliveryLedger, createWebhookVerifier } from "./webhook-verify.ts";
import type { VerifyFailure } from "./webhook-verify.ts";
import { agentSessionEventSchema, envelopeSchema, toSessionEvent } from "./webhook-schema.ts";

export const INSTALL_PATH = "/integrations/linear/install";
export const MANIFEST_PATH = "/integrations/linear/manifest";
export const HEALTH_PATH = "/healthz";

export type OstraServerConfig = {
  /** The https origin Linear reaches this server at. It goes into the manifest and the OAuth redirect. */
  readonly publicUrl: string;
  readonly linear: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly webhookSecret: string;
    readonly endpoints: LinearEndpoints;
  };
  readonly agent: Omit<AgentConfig, "taskUrl">;
  /** The clock heartbeats and the silent turn run on. */
  readonly clock?: Clock;
  readonly driver: TurnDriver;
  readonly log: Logger;
  /** Webhook bodies larger than this are refused with 413 (default 1 MiB). */
  readonly maxBodyBytes?: number;
  /**
   * Real milliseconds the durable inbox insert takes before the 200 (default 0: the in-memory ledger alone).
   * In ostra the 200 follows a Postgres insert and travels through a proxy; this knob stands in for both.
   */
  readonly inboxDelayMs?: number;
  /** Limits on installs that are started and not yet finished (the OAuth `state` table). */
  readonly pendingInstalls?: PendingInstallLimits;
};

export type PendingInstallLimits = {
  /** The most install starts held at once. A new one past this evicts the oldest. */
  readonly max: number;
  /** An install not finished within this many milliseconds is forgotten. */
  readonly ttlMs: number;
  /** How often forgotten ones are swept out, even when no install request arrives. */
  readonly sweepMs: number;
};

export type InstallationSummary = {
  readonly organizationId: OrganizationId;
  readonly appUserId: AppUserId;
  readonly appUserName: string;
  readonly scopes: readonly string[];
  readonly hasRefreshToken: boolean;
};

type Installation = InstallationSummary & { readonly accessToken: string };

/** One accepted webhook. Kept per session, so a reader joins on `sessionId` and never on array position. */
export type WebhookTiming = {
  readonly sessionId: AgentSessionId;
  readonly kind: "created" | "prompted";
  /** Server-side time from the request arriving to the 200 being flushed. Null until the flush happens. */
  ackMs: number | null;
  /**
   * Our wall clock at receipt minus Linear's own timestamp: one-way network transit plus clock skew. Negative when
   * this machine's clock is behind Linear's by more than the transit, which makes the figure unusable as a delay.
   * It is never clamped here. The return leg of the 200 is not measured at all.
   */
  readonly transitMs: number;
};

export type WebhookStats = {
  accepted: number;
  duplicates: number;
  ignored: number;
  unparsed: number;
  rejected: Record<VerifyFailure | "method" | "too-large", number>;
  /** In the order webhooks were accepted. */
  readonly timings: WebhookTiming[];
};

export type OstraServer = {
  listen: (port?: number, host?: string) => Promise<{ readonly port: number }>;
  close: () => Promise<void>;
  readonly service: AgentSessionService;
  installations: () => readonly InstallationSummary[];
  /** The Linear API client for a workspace the app is installed in. */
  api: (organizationId: OrganizationId) => LinearApi | undefined;
  stats: () => WebhookStats;
  /** Install starts held for a callback that has not come (the OAuth `state` table). */
  pendingInstallCount: () => number;
  manifest: () => ManifestResult;
};

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PENDING_INSTALLS: PendingInstallLimits = { max: 100, ttlMs: 10 * 60 * 1000, sweepMs: 60 * 1000 };

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const sendJson = (res: ServerResponse, status: number, body: unknown, onFlushed?: () => void): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body), onFlushed);
};

const readBody = (req: IncomingMessage, maxBytes: number): Promise<Buffer | "too-large"> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        resolve("too-large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });

export const createOstraServer = (config: OstraServerConfig): OstraServer => {
  const { log, linear } = config;
  const clock = config.clock ?? realClock;
  const maxBodyBytes = config.maxBodyBytes ?? 1024 * 1024;
  const publicOrigin = new URL(config.publicUrl).origin;
  const redirectUri = `${publicOrigin}${CALLBACK_PATH}`;
  const installLimits = config.pendingInstalls ?? DEFAULT_PENDING_INSTALLS;
  /** Aborted when the server closes: a webhook still waiting on the inbox stops instead of running into a closed server. */
  const lifetime = new AbortController();

  const installations = new Map<OrganizationId, Installation>();
  const apis = new Map<OrganizationId, LinearApi>();
  const pendingInstalls = new Map<string, { readonly verifier: string; readonly at: number }>();
  const verify = createWebhookVerifier(linear.webhookSecret);
  const ledger = createDeliveryLedger({
    windowMs: DEDUPE_WINDOW_MS,
    now: () => Date.now(),
    signal: lifetime.signal,
    ...(config.inboxDelayMs === undefined ? {} : { insertDelayMs: config.inboxDelayMs }),
  });
  const stats: WebhookStats = {
    accepted: 0,
    duplicates: 0,
    ignored: 0,
    unparsed: 0,
    rejected: { "missing-signature": 0, "bad-signature": 0, "bad-timestamp": 0, "malformed-body": 0, method: 0, "too-large": 0 },
    timings: [],
  };

  const apiFor = (organizationId: OrganizationId): LinearApi | undefined => {
    const cached = apis.get(organizationId);
    if (cached !== undefined) return cached;
    const installation = installations.get(organizationId);
    if (installation === undefined) return undefined;
    const api = createLinearApi({ apiUrl: linear.endpoints.apiUrl, accessToken: installation.accessToken });
    apis.set(organizationId, api);
    return api;
  };

  const service = createAgentSessionService({
    apiFor,
    driver: config.driver,
    clock,
    wall: realClock,
    log,
    config: { ...config.agent, taskUrl: (sessionId) => `${publicOrigin}/tasks/${encodeURIComponent(sessionId)}` },
  });

  // --- POST /integrations/linear/webhook ----------------------------------------------------
  const handleWebhook = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const receivedPerf = performance.now();
    const receivedAt = realClock.now();
    if (req.method !== "POST") {
      stats.rejected.method += 1;
      res.setHeader("allow", "POST");
      sendJson(res, 405, { error: "method-not-allowed" });
      return;
    }
    const body = await readBody(req, maxBodyBytes);
    if (body === "too-large") {
      stats.rejected["too-large"] += 1;
      res.setHeader("connection", "close");
      sendJson(res, 413, { error: "payload-too-large" });
      return;
    }
    const verified = verify(body, { signature: header(req, "linear-signature"), delivery: header(req, "linear-delivery") });
    if (!verified.ok) {
      stats.rejected[verified.reason] += 1;
      log.warn("webhook_rejected", { reason: verified.reason });
      sendJson(res, 400, { error: verified.reason });
      return;
    }
    const deliveryKey = verified.delivery === null ? null : `delivery:${verified.delivery}`;
    // One insert in ostra, keyed by both the signature and the delivery ID. Both claims go out together, so the
    // inbox's latency is paid once, as it would be by a single INSERT.
    const [firstSignature, firstDelivery] = await Promise.all([
      ledger.claim(`signature:${verified.signature}`),
      deliveryKey === null ? Promise.resolve(true) : ledger.claim(deliveryKey),
    ]);
    if (!firstSignature || !firstDelivery) {
      stats.duplicates += 1;
      log.info("webhook_duplicate", { delivery: verified.delivery });
      sendJson(res, 200, { status: "duplicate" });
      return;
    }
    const envelope = envelopeSchema.safeParse(verified.body);
    if (!envelope.success || envelope.data.type !== "AgentSessionEvent") {
      stats.ignored += 1;
      log.info("webhook_ignored", { type: envelope.success ? envelope.data.type : null, delivery: verified.delivery });
      sendJson(res, 200, { status: "ignored" });
      return;
    }
    const parsed = agentSessionEventSchema.safeParse(verified.body);
    if (!parsed.success) {
      // Answer 200 anyway: a payload we cannot read is not a reason for Linear to retry it three more times.
      stats.unparsed += 1;
      log.warn("webhook_unparsed", { action: envelope.data.action ?? null, delivery: verified.delivery });
      sendJson(res, 200, { status: "unparsed" });
      return;
    }
    const event = toSessionEvent(parsed.data);
    // Acknowledge first. Everything after this line is off the 5-second clock.
    const timing: WebhookTiming = { sessionId: event.sessionId, kind: event.kind, ackMs: null, transitMs: Date.now() - event.sentAtMs };
    stats.timings.push(timing);
    sendJson(res, 200, { status: "accepted" }, () => {
      timing.ackMs = performance.now() - receivedPerf;
    });
    stats.accepted += 1;
    log.info("webhook_accepted", {
      delivery: verified.delivery,
      action: event.kind,
      session: event.sessionId,
      org: event.organizationId,
    });
    service.handle(event, receivedAt);
  };

  // --- GET /integrations/linear/install and /callback ---------------------------------------
  const sweepPendingInstalls = (): void => {
    const now = Date.now();
    for (const [state, entry] of pendingInstalls) {
      if (now - entry.at > installLimits.ttlMs) pendingInstalls.delete(state);
    }
  };

  // The install routes are open on the public address, so what they hold is bounded: forgotten after the TTL (by a
  // timer, not only when the next request comes), and never more than `max` at once, oldest out first.
  const handleInstall = (res: ServerResponse): void => {
    const now = Date.now();
    sweepPendingInstalls();
    while (pendingInstalls.size >= installLimits.max) {
      const oldest = pendingInstalls.keys().next();
      if (oldest.done) break;
      pendingInstalls.delete(oldest.value);
    }
    const state = randomState();
    const pkce = createPkce();
    pendingInstalls.set(state, { verifier: pkce.verifier, at: now });
    const location = buildAuthorizeUrl({
      authorizeUrl: linear.endpoints.authorizeUrl,
      clientId: linear.clientId,
      redirectUri,
      state,
      challenge: pkce.challenge,
    });
    res.writeHead(302, { location });
    res.end();
  };

  const handleCallback = async (url: URL, res: ServerResponse): Promise<void> => {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const pending = state === null ? undefined : pendingInstalls.get(state);
    if (state === null || pending === undefined || code === null) {
      // Unknown or reused state: nothing is exchanged. This is the CSRF check.
      log.warn("install_rejected", { reason: "state" });
      sendJson(res, 400, { error: "invalid-state" });
      return;
    }
    pendingInstalls.delete(state);
    const exchanged = await exchangeCode({
      tokenUrl: linear.endpoints.tokenUrl,
      clientId: linear.clientId,
      clientSecret: linear.clientSecret,
      redirectUri,
      code,
      verifier: pending.verifier,
    });
    if (!exchanged.ok) {
      log.error("install_failed", { step: "token", reason: exchanged.reason, status: exchanged.status });
      sendJson(res, 502, { error: "token-exchange-failed" });
      return;
    }
    const token = exchanged.token;
    const viewer = await createLinearApi({ apiUrl: linear.endpoints.apiUrl, accessToken: token.access_token }).viewer();
    if (!viewer.isApp) {
      // The token is a person's, so the install was not `actor=app`: agent mode cannot work with it.
      log.error("install_failed", { step: "viewer", reason: "not-an-app-user", org: viewer.organizationId });
      sendJson(res, 409, { error: "token-is-not-an-app-user" });
      return;
    }
    const scopes = scopesOf(token);
    const installation: Installation = {
      organizationId: viewer.organizationId,
      appUserId: viewer.appUserId,
      appUserName: viewer.name,
      scopes,
      hasRefreshToken: token.refresh_token !== undefined,
      accessToken: token.access_token,
    };
    installations.set(viewer.organizationId, installation);
    apis.delete(viewer.organizationId);
    log.info("installed", { org: viewer.organizationId, appUser: viewer.appUserId, scopes: scopes.join(",") });
    sendJson(res, 200, {
      installed: true,
      organizationId: viewer.organizationId,
      appUserId: viewer.appUserId,
      appUserName: viewer.name,
      scopes,
    });
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://ostra.invalid");
    switch (url.pathname) {
      case WEBHOOK_PATH:
        await handleWebhook(req, res);
        return;
      case INSTALL_PATH:
        handleInstall(res);
        return;
      case CALLBACK_PATH:
        await handleCallback(url, res);
        return;
      case MANIFEST_PATH: {
        const result = buildManifest({ publicUrl: config.publicUrl, developerName: "ostra" });
        if (result.ok) {
          res.writeHead(302, { location: result.links.json });
          res.end();
        } else {
          sendJson(res, 409, { error: "agent-mode-unavailable", problems: result.problems });
        }
        return;
      }
      case HEALTH_PATH:
        sendJson(res, 200, { ok: true });
        return;
      default:
        sendJson(res, 404, { error: "not-found" });
    }
  };

  let sweepTimer: NodeJS.Timeout | undefined;

  const server: Server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (lifetime.signal.aborted && isAbortError(error)) {
        // The server is closing while this request waited on the inbox: nothing was accepted, so nothing is answered.
        res.destroy();
        return;
      }
      log.error("request_failed", { error: errorName(error) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal-error" });
      else res.end();
    });
  });

  return {
    service,
    listen: (port = 0, host = "127.0.0.1") =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("server has no TCP address"));
            return;
          }
          resolve({ port: address.port });
          sweepTimer = setInterval(sweepPendingInstalls, installLimits.sweepMs);
          sweepTimer.unref();
        });
      }),
    close: async () => {
      lifetime.abort();
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
      await service.shutdown();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
    // An allow-list, not "everything but the token": a field added to Installation later stays out until it is added here.
    installations: () =>
      [...installations.values()].map(
        (i): InstallationSummary => ({
          organizationId: i.organizationId,
          appUserId: i.appUserId,
          appUserName: i.appUserName,
          scopes: i.scopes,
          hasRefreshToken: i.hasRefreshToken,
        }),
      ),
    api: apiFor,
    stats: () => stats,
    pendingInstallCount: () => pendingInstalls.size,
    manifest: () => buildManifest({ publicUrl: config.publicUrl, developerName: "ostra" }),
  };
};
