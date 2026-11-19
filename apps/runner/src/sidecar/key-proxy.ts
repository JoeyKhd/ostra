import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, Agent as HttpAgent } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import type { AddressInfo } from "node:net";
import { createUsageMeter, formatForPath, resolveUsage } from "@ostra/adapter-sdk";
import type { Logger, TokenUsage, WireFormat } from "@ostra/adapter-sdk";
import { RATE_LIMIT_HOLD_DEFAULT_SECONDS, RATE_LIMIT_HOLD_MAX_SECONDS } from "@ostra/protocol";
import type { ApiFormat, ModelId, ProviderId, SpendCap, TaskCredentials, TaskEventOf, TaskId } from "@ostra/protocol";
import { z } from "zod";
import { createSpendMeter } from "./spend-cap.ts";
import type { SpendUnit } from "./spend-cap.ts";

// The key proxy (ADR 0030, ADR 0042, F-089). The agent holds a fake key and a base URL that points
// here; the real token stays in the runner's process. For each request the proxy checks the fake
// key, strips every client credential header, sets the real one, opens its own connection to the
// provider, and passes the request and the answer through byte for byte, streamed or not, error
// bodies as received. On the way back it reads the usage the endpoint reports, in both API
// formats, and counts every call it carries, title calls and other tool-less calls included. A
// call whose answer reported no usage is estimated, and marked so.
//
// It forwards model calls only (ADR 0030 limits the agent to using the model): a POST to the chat,
// responses or messages route, or a GET of the model list, under the provider's own base path.
// Anything else is refused with a 403, before the real token goes near it.
//
// It logs the task ID, statuses and counts only: never a key, a prompt or an answer.
//
// Milestone 2 (F-068, ticket 25): with the spec's spend cap, every call's usage is priced (or its
// tokens counted) against the cap, from what the task had spent before. Once the cap is reached,
// the next model call is refused in the API's own shape, so the agent stops cleanly; a call already
// streaming finishes and is counted, and a refused call counts as nothing spent.
//
// Ported from spikes/how-should-the-runner-drive-opencode/src/lib/key-proxy.ts.

export type ModelCredentials = TaskCredentials["model"];

/** Why the provider refused the real token: the task fails at once (F-089). */
export type UpstreamRefusal = { readonly status: 401 | 403; readonly path: string };

/** A rate-limit answer, so the server holds new dispatches on this provider. */
export type RateLimit = {
  readonly status: 429 | 503;
  /** From `Retry-After`, in ms from now, when the provider said. */
  readonly retryAfterMs: number | null;
};

export type KeyProxyOptions = {
  readonly taskId: TaskId;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  /** The real endpoint and token. Held in memory, in this process, only. */
  readonly model: ModelCredentials;
  /** The address to listen on: loopback on `host`, the box network's on `docker`. */
  readonly listenHost: string;
  /** The address the agent reaches the proxy on, when it differs from `listenHost`. */
  readonly advertiseHost?: string;
  readonly port?: number;
  /** How long the fake key is valid. */
  readonly fakeKeyTtlMs: number;
  readonly logger: Logger;
  /** One per model call with usage: the key proxy's count, which spend comes from. */
  readonly onUsage: (event: TaskEventOf<"usage.recorded">) => void;
  readonly onRateLimited?: (limit: RateLimit) => void;
  readonly onUpstreamRefused?: (refusal: UpstreamRefusal) => void;
  /** Minor 1: the task's spend cap, which this proxy enforces (F-068). Absent: no cap (milestone 1). */
  readonly spendCap?: SpendCap;
  /** Called once, when the cap is reached: what the task has spent, in micro-USD or tokens. */
  readonly onSpendCapReached?: (reached: SpendCapReached) => void;
  readonly now?: () => number;
};

/** The cap was reached: `observed` is what the task had spent then, in `unit`. */
export type SpendCapReached = { readonly observed: number; readonly unit: SpendUnit };

export type KeyProxyTotals = {
  readonly calls: number;
  readonly refused: number;
  readonly usage: TokenUsage;
  readonly estimatedCalls: number;
};

export type KeyProxy = {
  /** The base URL to hand the agent: the proxy's origin plus the provider's base path. */
  readonly baseUrl: string;
  /** The task's fake key: valid here only, until revoked or expired. */
  readonly fakeKey: string;
  readonly totals: () => KeyProxyTotals;
  /** The fake key stops working at once (the session ended). */
  readonly revoke: () => void;
  readonly close: () => Promise<void>;
};

const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/** Every header a client could carry a credential in. All are dropped before the real one is set. */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "x-goog-api-key",
  "proxy-authorization",
]);

// Dropped from the request: the meter reads plain bytes, so the provider is asked for an
// uncompressed answer (spike 1 found every endpoint honours it).
const REPLACED_HEADERS: ReadonlySet<string> = new Set([...CREDENTIAL_HEADERS, "accept-encoding"]);

const requestHeadSchema = z.looseObject({ stream: z.boolean().optional() });

/** A fake key with 192 random bits. It carries nothing of the real one. */
export const createFakeKey = (): string => `ostra-fake-${randomBytes(24).toString("base64url")}`;

const presentedKey = (headers: IncomingHttpHeaders): string | undefined => {
  const auth = headers.authorization;
  if (auth !== undefined) {
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  for (const name of ["x-api-key", "api-key"]) {
    const value = headers[name];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
};

const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const forwardHeaders = (headers: IncomingHttpHeaders, drop: ReadonlySet<string>): OutgoingHttpHeaders => {
  const out: OutgoingHttpHeaders = {};
  const connectionTokens = new Set(
    (headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ""),
  );
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(lower) || connectionTokens.has(lower) || drop.has(lower)) {
      continue;
    }
    out[lower] = value;
  }
  return out;
};

const readAll = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
};

/** A 401 in the provider's own shape, so the agent's SDK reads it as an auth error. */
const rejectBody = (format: WireFormat | undefined): string =>
  JSON.stringify(
    format === "anthropic-messages"
      ? { type: "error", error: { type: "authentication_error", message: "ostra key proxy: invalid or expired key" } }
      : { error: { message: "ostra key proxy: invalid or expired key", type: "invalid_request_error", code: "invalid_api_key" } },
  );

/** What a refused call says once the task's spend cap is reached. */
export const SPEND_CAP_MESSAGE = "ostra: this task reached its spend cap";

/**
 * A 400 in the provider's own shape: the agent's SDK reads it as a request it mustn't retry (a 429
 * or a 5xx would be retried), so the agent stops cleanly.
 */
const spendCapBody = (format: WireFormat | ApiFormat): string =>
  JSON.stringify(
    format === "anthropic-messages"
      ? { type: "error", error: { type: "invalid_request_error", message: SPEND_CAP_MESSAGE } }
      : { error: { message: SPEND_CAP_MESSAGE, type: "invalid_request_error", code: "spend_cap_reached" } },
  );

/** A 403 in the provider's own shape: the agent's SDK reads it as a refusal, not an outage. */
const forbiddenBody = (format: ApiFormat): string =>
  JSON.stringify(
    format === "anthropic-messages"
      ? { type: "error", error: { type: "permission_error", message: "ostra key proxy: this route isn't available to the agent" } }
      : { error: { message: "ostra key proxy: this route isn't available to the agent", type: "invalid_request_error", code: "route_not_allowed" } },
  );

/** The model calls, below the provider's base path (an optional version segment is allowed for a base that lacks one). */
const MODEL_CALL_ROUTE = /^(?:\/v\d+)?\/(?:chat\/completions|responses|messages)$/;
const MODEL_LIST_ROUTE = /^(?:\/v\d+)?\/models$/;

/**
 * Is this request one the agent may make with the real token? Only the model API: a POST of a
 * model call, or a GET of the model list, exactly under `upstreamPath`.
 */
export const isAllowedRoute = (method: string, path: string, upstreamPath: string): boolean => {
  if (!path.startsWith(`${upstreamPath}/`)) {
    return false;
  }
  const route = path.slice(upstreamPath.length).replace(/\/+$/, "");
  if (method === "POST") {
    return MODEL_CALL_ROUTE.test(route) && formatForPath(path) !== undefined;
  }
  return method === "GET" && MODEL_LIST_ROUTE.test(route);
};

/** `Retry-After` as seconds or an HTTP date, in ms from `now`. */
export const parseRetryAfter = (value: string | undefined, now: number): number | null => {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.round(Number(trimmed) * 1000);
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
};

/**
 * How long the server holds new dispatches after a rate limit: the provider's `Retry-After` in
 * whole seconds, rounded up, at least one and at most the protocol's cap; a default when the
 * provider didn't say.
 */
export const rateLimitHoldSeconds = (retryAfterMs: number | null): number => {
  if (retryAfterMs === null) {
    return RATE_LIMIT_HOLD_DEFAULT_SECONDS;
  }
  return Math.min(RATE_LIMIT_HOLD_MAX_SECONDS, Math.max(1, Math.ceil(retryAfterMs / 1000)));
};

/** The real credential's headers, by the provider's auth scheme (ADR 0033). */
const credentialHeaders = (model: ModelCredentials, clientHeaders: IncomingHttpHeaders): OutgoingHttpHeaders => {
  switch (model.authScheme) {
    case "bearer":
      return { authorization: `Bearer ${model.token}` };
    case "x-api-key":
      // Keep the client's own `anthropic-version`: headers pass through unchanged.
      return clientHeaders["anthropic-version"] === undefined
        ? { "x-api-key": model.token, "anthropic-version": "2023-06-01" }
        : { "x-api-key": model.token };
    default:
      return model.authScheme satisfies never;
  }
};

export const startKeyProxy = async (options: KeyProxyOptions): Promise<KeyProxy> => {
  const now = options.now ?? Date.now;
  const upstream = new URL(options.model.baseUrl);
  const upstreamPath = upstream.pathname.replace(/\/+$/, "");
  const fakeKey = createFakeKey();
  const expiresAt = now() + options.fakeKeyTtlMs;
  const log = options.logger.child({ taskId: options.taskId, component: "key-proxy" });
  const secure = upstream.protocol === "https:";
  // The proxy's own connections to the provider: its own TLS, kept alive across calls.
  const agent = secure ? new HttpsAgent({ keepAlive: true, maxSockets: 16 }) : new HttpAgent({ keepAlive: true, maxSockets: 16 });
  let revoked = false;
  let calls = 0;
  let refused = 0;
  let estimatedCalls = 0;
  let total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const meter = options.spendCap === undefined ? undefined : createSpendMeter(options.spendCap);
  let capNotified = false;
  const capReached = (): void => {
    if (meter !== undefined && !capNotified) {
      capNotified = true;
      log.warn("the task reached its spend cap", { unit: meter.unit, observed: meter.spent() });
      options.onSpendCapReached?.({ observed: meter.spent(), unit: meter.unit });
    }
  };

  const record = (usage: TokenUsage, estimated: boolean): void => {
    total = {
      input: total.input + usage.input,
      output: total.output + usage.output,
      cacheRead: total.cacheRead + usage.cacheRead,
      cacheWrite: total.cacheWrite + usage.cacheWrite,
      reasoning: total.reasoning + usage.reasoning,
    };
    if (estimated) {
      estimatedCalls += 1;
    }
    if (meter?.add(usage) === true) {
      capReached();
    }
    options.onUsage({
      kind: "usage.recorded",
      providerId: options.providerId,
      modelId: options.modelId,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      estimated,
    });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const startedAt = now();
    const incoming = new URL(request.url ?? "/", "http://key-proxy.local");
    // The agent's base URL is the proxy's origin plus the provider's path, so the path passes as is.
    const path = incoming.pathname;
    const format = formatForPath(path);
    const presented = presentedKey(request.headers);
    const keyOk = presented !== undefined && !revoked && now() < expiresAt && sameSecret(presented, fakeKey);
    const body = await readAll(request);

    if (!keyOk) {
      refused += 1;
      const payload = rejectBody(format);
      response.writeHead(401, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      response.end(payload);
      log.warn("key proxy refused a call", {
        reason: presented === undefined ? "no-key" : revoked ? "revoked" : now() >= expiresAt ? "expired" : "wrong-key",
      });
      return;
    }
    if (!isAllowedRoute(request.method ?? "GET", path, upstreamPath)) {
      refused += 1;
      const payload = forbiddenBody(options.model.apiFormat);
      response.writeHead(403, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      response.end(payload);
      log.warn("key proxy refused a call", { reason: "path-not-allowed" });
      return;
    }
    if (meter?.reached() === true && request.method === "POST") {
      // The cap is reached: this call never reaches the provider, and costs nothing.
      refused += 1;
      const payload = spendCapBody(format ?? options.model.apiFormat);
      response.writeHead(400, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      response.end(payload);
      log.warn("key proxy refused a call", { reason: "spend-cap" });
      capReached();
      return;
    }
    calls += 1;

    let streamedRequest = false;
    if (format !== undefined && body.length > 0) {
      try {
        const head = requestHeadSchema.safeParse(JSON.parse(body.toString("utf8")));
        streamedRequest = head.success && head.data.stream === true;
      } catch {
        // Not JSON: pass it through and let the provider answer.
      }
    }

    const headers = forwardHeaders(request.headers, REPLACED_HEADERS);
    headers.host = upstream.host;
    headers["accept-encoding"] = "identity";
    headers["content-length"] = String(body.length);
    Object.assign(headers, credentialHeaders(options.model, request.headers));

    const target = new URL(upstream.origin);
    target.pathname = path;
    target.search = incoming.search;
    const send = secure ? httpsRequest : httpRequest;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const upstreamRequest = send(target, { method: request.method ?? "GET", headers, agent }, (upstreamResponse) => {
        const status = upstreamResponse.statusCode ?? 502;
        const streamed = (upstreamResponse.headers["content-type"] ?? "").includes("text/event-stream");
        const meter = format !== undefined && status < 400 ? createUsageMeter(format, streamed) : undefined;
        response.writeHead(status, upstreamResponse.statusMessage ?? "", forwardHeaders(upstreamResponse.headers, new Set()));
        response.flushHeaders();
        let bytesOut = 0;
        upstreamResponse.on("data", (chunk: Buffer) => {
          bytesOut += chunk.length;
          meter?.push(chunk);
          response.write(chunk);
        });
        const finish = (): void => {
          if (meter !== undefined) {
            const metered = resolveUsage(meter.end(), body.length);
            record(metered.usage, metered.estimated);
          }
          if (status === 401 || status === 403) {
            options.onUpstreamRefused?.({ status, path });
          }
          if (status === 429 || status === 503) {
            const retryAfter = upstreamResponse.headers["retry-after"];
            options.onRateLimited?.({ status, retryAfterMs: parseRetryAfter(retryAfter, now()) });
          }
          log.info("model call", {
            format: format ?? null,
            status,
            streamed: streamed || streamedRequest,
            bytesOut,
            ms: now() - startedAt,
          });
          done();
        };
        upstreamResponse.on("end", () => {
          response.end();
          finish();
        });
        upstreamResponse.on("error", () => {
          response.destroy();
          finish();
        });
      });
      response.on("close", () => {
        if (!response.writableFinished) {
          // The agent went away mid-answer: stop the provider's answer too.
          upstreamRequest.destroy();
        }
      });
      upstreamRequest.on("error", (error) => {
        if (!response.headersSent) {
          const payload = JSON.stringify({ error: { message: "ostra key proxy: the model provider is unreachable", type: "upstream_error" } });
          response.writeHead(502, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
          response.end(payload);
        } else {
          response.destroy();
        }
        log.warn("model provider unreachable", { error: error.name });
        done();
      });
      upstreamRequest.end(body);
    });
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500).end();
      } else {
        response.destroy();
      }
    });
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });
  // Long turns stream for minutes: no server-side timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 60_000;
  server.timeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const origin = `http://${options.advertiseHost ?? options.listenHost}:${String(port)}`;

  return {
    baseUrl: `${origin}${upstreamPath}`,
    fakeKey,
    totals: () => ({ calls, refused, usage: total, estimatedCalls }),
    revoke: () => {
      revoked = true;
    },
    close: async () => {
      revoked = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      agent.destroy();
    },
  };
};
