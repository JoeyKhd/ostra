// The key proxy (ADR 0030, ADR 0042). The agent holds a fake key and a base
// URL that points here. The proxy checks the fake key, strips every client
// credential header, sets the real key, and passes the request and the
// response through byte for byte. On the way back it reads the usage the
// endpoint reports, streamed or not, in both API formats, and records counts.
// It logs IDs and counts only: never a key, a prompt or a response body.

import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { proxyCallId, type ProxyCallId, type TaskId } from "./ids.ts";
import { createUsageMeter, formatForPath, type ApiFormat, type TokenUsage } from "./usage.ts";

export type UpstreamAuth = "bearer" | "x-api-key";

export type KeyProxyOptions = {
  /** The model provider's base URL, e.g. `https://host/v1`. */
  readonly upstreamBaseUrl: string;
  /** Held in memory only. */
  readonly realKey: string;
  /** How the upstream takes its key. Anthropic's API takes `x-api-key`; OpenAI-compatible ones take a bearer token. */
  readonly upstreamAuth: UpstreamAuth;
  /** IDs for log lines. */
  readonly taskId: TaskId;
  /** Lifetime of the fake key. Default 24 h. */
  readonly fakeKeyTtlMs?: number;
  readonly host?: string;
  readonly port?: number;
  /** Structured log sink: IDs and counts only. */
  readonly log?: (line: Readonly<Record<string, string | number | boolean | null>>) => void;
};

export type ProxyCallRecord = {
  readonly callId: ProxyCallId;
  readonly taskId: TaskId;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly method: string;
  readonly path: string;
  readonly format: ApiFormat | undefined;
  /** The model ID the agent asked for, read from the request body. */
  readonly requestedModel: string | undefined;
  readonly streamed: boolean;
  /** The request offered tools: a turn's own model call, not a title or summary call. */
  readonly hasTools: boolean;
  readonly status: number;
  /** The agent presented the valid fake key, and the real one was swapped in. */
  readonly keySwapped: boolean;
  /** Undefined when the endpoint reported no usage. */
  readonly usage: TokenUsage | undefined;
  readonly upstreamAuthFailed: boolean;
  readonly rateLimited: boolean;
  readonly retryAfter: string | undefined;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly clientAborted: boolean;
};

export type KeyProxy = {
  /** The proxy's origin, e.g. `http://127.0.0.1:41234`. */
  readonly origin: string;
  /** The base URL to hand the agent: the proxy origin plus the upstream's path. */
  readonly agentBaseUrl: string;
  /** The fake key to hand the agent. Valid for this proxy only, until revoked or expired. */
  readonly fakeKey: string;
  readonly calls: readonly ProxyCallRecord[];
  readonly revoke: () => void;
  readonly close: () => Promise<void>;
};

const HOP_BY_HOP = new Set([
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

const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "api-key", "cookie", "x-goog-api-key"]);

// Dropped from the request and replaced: the meter reads plain bytes, so the upstream is asked for an uncompressed body.
const REPLACED_HEADERS = new Set([...CREDENTIAL_HEADERS, "accept-encoding"]);

const requestBodyHead = z.looseObject({ model: z.string().optional(), stream: z.boolean().optional(), tools: z.array(z.unknown()).optional() });

const presentedKey = (headers: IncomingHttpHeaders): string | undefined => {
  const auth = headers.authorization;
  if (auth !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match?.[1] !== undefined) return match[1];
  }
  const xApiKey = headers["x-api-key"];
  if (typeof xApiKey === "string") return xApiKey;
  const apiKey = headers["api-key"];
  if (typeof apiKey === "string") return apiKey;
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
    if (value === undefined || HOP_BY_HOP.has(lower) || connectionTokens.has(lower) || drop.has(lower)) continue;
    out[lower] = value;
  }
  return out;
};

const readAll = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
};

const rejectBody = (format: ApiFormat | undefined): string =>
  JSON.stringify(
    format === "anthropic-messages"
      ? { type: "error", error: { type: "authentication_error", message: "ostra key proxy: invalid or expired key" } }
      : { error: { message: "ostra key proxy: invalid or expired key", type: "invalid_request_error", code: "invalid_api_key" } },
  );

/** A fake key with 192 random bits. It carries no information about the real one. */
export const createFakeKey = (): string => `ostra-fake-${randomBytes(24).toString("base64url")}`;

export const startKeyProxy = async (options: KeyProxyOptions): Promise<KeyProxy> => {
  const upstream = new URL(options.upstreamBaseUrl);
  const upstreamPath = upstream.pathname.replace(/\/+$/, "");
  const fakeKey = createFakeKey();
  const expiresAt = Date.now() + (options.fakeKeyTtlMs ?? 24 * 60 * 60 * 1000);
  let revoked = false;
  const calls: ProxyCallRecord[] = [];
  const log = options.log ?? ((): void => undefined);
  const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const callId = proxyCallId(randomUUID());
    const startedAt = Date.now();
    const incomingUrl = new URL(req.url ?? "/", "http://proxy.local");
    // The agent's base URL is the proxy origin plus the upstream path, so the path passes through unchanged.
    const path = incomingUrl.pathname;
    const format = formatForPath(path);
    const presented = presentedKey(req.headers);
    const keyOk = presented !== undefined && !revoked && Date.now() < expiresAt && sameSecret(presented, fakeKey);

    const body = await readAll(req);
    let requestedModel: string | undefined;
    let streamedRequest = false;
    let hasTools = false;
    if (format !== undefined && body.length > 0) {
      try {
        const head = requestBodyHead.safeParse(JSON.parse(body.toString("utf8")));
        if (head.success) {
          requestedModel = head.data.model;
          streamedRequest = head.data.stream ?? false;
          hasTools = (head.data.tools?.length ?? 0) > 0;
        }
      } catch {
        // Not JSON: pass it through and let the endpoint answer.
      }
    }

    const base = {
      callId,
      taskId: options.taskId,
      startedAt,
      method: req.method ?? "GET",
      path,
      format,
      requestedModel,
      hasTools,
      bytesIn: body.length,
    };

    if (!keyOk) {
      const payload = rejectBody(format);
      res.writeHead(401, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
      calls.push({
        ...base,
        endedAt: Date.now(),
        streamed: false,
        status: 401,
        keySwapped: false,
        usage: undefined,
        upstreamAuthFailed: false,
        rateLimited: false,
        retryAfter: undefined,
        bytesOut: Buffer.byteLength(payload),
        clientAborted: false,
      });
      log({ event: "proxy.rejected", taskId: options.taskId, callId, reason: presented === undefined ? "no_key" : revoked ? "revoked" : "bad_key" });
      return;
    }

    const headers = forwardHeaders(req.headers, REPLACED_HEADERS);
    headers.host = upstream.host;
    headers["accept-encoding"] = "identity";
    headers["content-length"] = String(body.length);
    if (options.upstreamAuth === "bearer") headers.authorization = `Bearer ${options.realKey}`;
    else headers["x-api-key"] = options.realKey;

    const target = new URL(upstream.origin);
    target.pathname = path;
    target.search = incomingUrl.search;

    await new Promise<void>((resolve) => {
      let clientAborted = false;
      const upstreamReq = send(target, { method: req.method ?? "GET", headers }, (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        const contentType = upstreamRes.headers["content-type"] ?? "";
        const streamed = contentType.includes("text/event-stream");
        const meter = format !== undefined && status < 400 ? createUsageMeter(format, streamed) : undefined;
        res.writeHead(status, upstreamRes.statusMessage ?? "", forwardHeaders(upstreamRes.headers, new Set()));
        res.flushHeaders();
        let bytesOut = 0;
        upstreamRes.on("data", (chunk: Buffer) => {
          bytesOut += chunk.length;
          meter?.push(chunk);
          res.write(chunk);
        });
        const finish = (): void => {
          const result = meter?.end();
          const retryAfter = upstreamRes.headers["retry-after"];
          const record: ProxyCallRecord = {
            ...base,
            endedAt: Date.now(),
            streamed: streamed || streamedRequest,
            status,
            keySwapped: true,
            usage: result?.usage,
            upstreamAuthFailed: status === 401 || status === 403,
            rateLimited: status === 429,
            retryAfter,
            bytesOut,
            clientAborted,
          };
          calls.push(record);
          log({
            event: "proxy.call",
            taskId: options.taskId,
            callId,
            format: format ?? null,
            model: requestedModel ?? null,
            status,
            streamed: record.streamed,
            inputTokens: result?.usage?.input ?? null,
            outputTokens: result?.usage?.output ?? null,
            cacheReadTokens: result?.usage?.cacheRead ?? null,
            cacheWriteTokens: result?.usage?.cacheWrite ?? null,
            usageReported: result?.usage !== undefined,
            ms: record.endedAt - startedAt,
          });
          resolve();
        };
        upstreamRes.on("end", () => {
          res.end();
          finish();
        });
        upstreamRes.on("error", () => {
          res.destroy();
          finish();
        });
      });
      res.on("close", () => {
        if (!res.writableFinished) {
          clientAborted = true;
          upstreamReq.destroy();
        }
      });
      upstreamReq.on("error", () => {
        if (!res.headersSent) {
          const payload = JSON.stringify({ error: { message: "ostra key proxy: upstream unreachable", type: "upstream_error" } });
          res.writeHead(502, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
          res.end(payload);
        } else {
          res.destroy();
        }
        calls.push({
          ...base,
          endedAt: Date.now(),
          streamed: streamedRequest,
          status: 502,
          keySwapped: true,
          usage: undefined,
          upstreamAuthFailed: false,
          rateLimited: false,
          retryAfter: undefined,
          bytesOut: 0,
          clientAborted,
        });
        log({ event: "proxy.upstream_error", taskId: options.taskId, callId });
        resolve();
      });
      upstreamReq.end(body);
    });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });
  // Long turns and long streams: no server-side timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 60_000;
  server.timeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : 0;
  const origin = `http://${options.host ?? "127.0.0.1"}:${String(port)}`;

  return {
    origin,
    agentBaseUrl: `${origin}${upstreamPath}`,
    fakeKey,
    calls,
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
    },
  };
};
