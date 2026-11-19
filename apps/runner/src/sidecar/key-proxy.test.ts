import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger, createUsageMeter } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { startAnthropicStub, startOpenAiStub } from "@ostra/adapter-sdk/testing";
import type { StubReply, StubServer } from "@ostra/adapter-sdk/testing";
import { modelIdSchema, providerIdSchema, RATE_LIMIT_HOLD_DEFAULT_SECONDS, RATE_LIMIT_HOLD_MAX_SECONDS, taskIdSchema } from "@ostra/protocol";
import type { ApiFormat, AuthScheme, TaskEventOf } from "@ostra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { isAllowedRoute, parseRetryAfter, rateLimitHoldSeconds, startKeyProxy } from "./key-proxy.ts";
import type { KeyProxy, KeyProxyOptions, RateLimit, UpstreamRefusal } from "./key-proxy.ts";

// Ticket 17's "done when", against both stub formats (spec section 8) and a raw upstream for the
// byte-for-byte checks.

const REAL_TOKEN = "sk-real-provider-token-0123456789abcdef";
const taskId = taskIdSchema.parse("task-kp");
const providerId = providerIdSchema.parse("provider-1");
const modelId = modelIdSchema.parse("model-1");

type Harness = {
  readonly proxy: KeyProxy;
  readonly usage: TaskEventOf<"usage.recorded">[];
  readonly logs: LogRecord[];
  readonly rateLimits: RateLimit[];
  readonly refusals: UpstreamRefusal[];
};

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

const startProxy = async (
  baseUrl: string,
  apiFormat: ApiFormat,
  authScheme: AuthScheme,
  extra: Partial<Pick<KeyProxyOptions, "fakeKeyTtlMs" | "now">> = {},
): Promise<Harness> => {
  const usage: TaskEventOf<"usage.recorded">[] = [];
  const logs: LogRecord[] = [];
  const rateLimits: RateLimit[] = [];
  const refusals: UpstreamRefusal[] = [];
  const proxy = await startKeyProxy({
    taskId,
    providerId,
    modelId,
    model: { baseUrl, apiFormat, authScheme, token: REAL_TOKEN },
    listenHost: "127.0.0.1",
    fakeKeyTtlMs: extra.fakeKeyTtlMs ?? 60_000,
    logger: createLogger((record) => logs.push(record)),
    onUsage: (event) => usage.push(event),
    onRateLimited: (limit) => rateLimits.push(limit),
    onUpstreamRefused: (refusal) => refusals.push(refusal),
    ...(extra.now === undefined ? {} : { now: extra.now }),
  });
  closers.push(proxy.close);
  return { proxy, usage, logs, rateLimits, refusals };
};

const stub = async (format: ApiFormat, reply: (request: { readonly toolNames: readonly string[] }) => StubReply): Promise<StubServer> => {
  const options = { realKey: REAL_TOKEN, models: ["stub-model"], brain: reply };
  const server = format === "openai-compatible" ? await startOpenAiStub(options) : await startAnthropicStub(options);
  closers.push(server.close);
  return server;
};

const tool = { name: "read", description: "read a file", parameters: { type: "object", properties: {} } };

const openAiBody = (stream: boolean, withTools = true): string =>
  JSON.stringify({
    model: "stub-model",
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    messages: [{ role: "user", content: "Say hello in a few words." }],
    ...(withTools ? { tools: [{ type: "function", function: tool }] } : {}),
  });

const anthropicBody = (stream: boolean): string =>
  JSON.stringify({
    model: "stub-model",
    stream,
    max_tokens: 256,
    messages: [{ role: "user", content: "Say hello in a few words." }],
    tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }],
  });

const call = async (
  harness: Harness,
  path: string,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number; readonly text: string; readonly headers: Headers }> => {
  const response = await fetch(`${harness.proxy.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${harness.proxy.fakeKey}`, ...headers },
    body,
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
};

describe("the key proxy, against both stub formats", () => {
  it.each([
    ["openai-compatible", "bearer", true],
    ["openai-compatible", "bearer", false],
    ["anthropic-messages", "x-api-key", true],
    ["anthropic-messages", "x-api-key", false],
  ] as const)("counts a %s call (streamed: %s) exactly as the stub billed it", async (format, scheme, stream) => {
    const server = await stub(format, () => ({ text: "Hello there, from the stub model." }));
    const harness = await startProxy(server.baseUrl, format, scheme);
    const path = format === "openai-compatible" ? "/chat/completions" : "/messages";
    const answer = await call(harness, path, format === "openai-compatible" ? openAiBody(stream) : anthropicBody(stream));
    expect(answer.status).toBe(200);
    expect(answer.text).toContain(stream ? "data:" : "Hello there");
    const [billed] = server.calls.map((item) => item.billed);
    expect(server.calls[0]?.authOk).toBe(true);
    expect(harness.usage).toEqual([
      {
        kind: "usage.recorded",
        providerId,
        modelId,
        inputTokens: billed?.inputTokens,
        outputTokens: billed?.outputTokens,
        cacheReadTokens: billed?.cacheReadTokens,
        cacheWriteTokens: 0,
        estimated: false,
      },
    ]);
  });

  it("counts every call, the tool-less title call included", async () => {
    const server = await stub("openai-compatible", () => ({ text: "A title" }));
    const harness = await startProxy(server.baseUrl, "openai-compatible", "bearer");
    await call(harness, "/chat/completions", openAiBody(true, false));
    await call(harness, "/chat/completions", openAiBody(true, true));
    expect(harness.usage).toHaveLength(2);
    expect(harness.proxy.totals().calls).toBe(2);
  });

  it("estimates a call whose stream reported no usage, and marks it", async () => {
    const server = await stub("anthropic-messages", () => ({ text: "No usage in this one.", reportUsage: false }));
    const harness = await startProxy(server.baseUrl, "anthropic-messages", "x-api-key");
    await call(harness, "/messages", anthropicBody(true));
    expect(harness.usage).toHaveLength(1);
    expect(harness.usage[0]).toMatchObject({ estimated: true });
    expect(harness.usage[0]?.inputTokens).toBeGreaterThan(0);
    expect(harness.usage[0]?.outputTokens).toBeGreaterThan(0);
    expect(harness.proxy.totals().estimatedCalls).toBe(1);
  });

  it("reports a rate-limit answer with its retry time", async () => {
    const server = await stub("openai-compatible", () => ({ error: { status: 429, message: "slow down", retryAfterSeconds: 7 } }));
    const harness = await startProxy(server.baseUrl, "openai-compatible", "bearer");
    const answer = await call(harness, "/chat/completions", openAiBody(false));
    expect(answer.status).toBe(429);
    expect(harness.rateLimits).toEqual([{ status: 429, retryAfterMs: 7_000 }]);
    expect(harness.usage).toEqual([]);
  });
});

describe("the fake key", () => {
  it("refuses a wrong key with 401, and the call never reaches the provider", async () => {
    const server = await stub("openai-compatible", () => ({ text: "never" }));
    const harness = await startProxy(server.baseUrl, "openai-compatible", "bearer");
    const answer = await call(harness, "/chat/completions", openAiBody(false), { authorization: "Bearer ostra-fake-not-the-right-one" });
    expect(answer.status).toBe(401);
    expect(answer.text).toContain("invalid or expired key");
    const none = await fetch(`${harness.proxy.baseUrl}/chat/completions`, { method: "POST", body: openAiBody(false) });
    expect(none.status).toBe(401);
    expect(server.calls).toHaveLength(0);
    expect(harness.proxy.totals()).toMatchObject({ calls: 0, refused: 2 });
  });

  it("refuses an expired key and a revoked one", async () => {
    let clock = 1_000_000;
    const server = await stub("anthropic-messages", () => ({ text: "never" }));
    const harness = await startProxy(server.baseUrl, "anthropic-messages", "x-api-key", { fakeKeyTtlMs: 1_000, now: () => clock });
    clock += 1_001;
    expect((await call(harness, "/messages", anthropicBody(false))).status).toBe(401);
    clock = 1_000_000;
    harness.proxy.revoke();
    expect((await call(harness, "/messages", anthropicBody(false), { "x-api-key": harness.proxy.fakeKey })).status).toBe(401);
    expect(server.calls).toHaveLength(0);
  });

  it("is ostra-fake- plus at least 128 random bits", async () => {
    const server = await stub("openai-compatible", () => ({ text: "x" }));
    const one = await startProxy(server.baseUrl, "openai-compatible", "bearer");
    const two = await startProxy(server.baseUrl, "openai-compatible", "bearer");
    expect(one.proxy.fakeKey).toMatch(/^ostra-fake-[A-Za-z0-9_-]{22,}$/);
    expect(one.proxy.fakeKey).not.toBe(two.proxy.fakeKey);
  });
});

// A raw upstream: fixed bytes, headers recorded, for the byte-for-byte and header checks.
type RawUpstream = { readonly baseUrl: string; readonly seen: IncomingHttpHeaders[] };

const SSE_CHUNKS = [
  "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":11,\"output_tokens\":1}}}\n\n",
  ": keep-alive\n\n",
  "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\",\"vendor_field\":[1,2]}}\n\n",
  "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n",
];

/** The same answer in the OpenAI-compatible format: usage in its last chunk, a cached part, then `[DONE]`. */
const OPENAI_SSE_CHUNKS = [
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"vendor_field":[1,2]}]}\n\n',
  ": keep-alive\n\n",
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":13,"completion_tokens":4,"total_tokens":17,"prompt_tokens_details":{"cached_tokens":3}}}\n\n',
  "data: [DONE]\n\n",
];

/** An Anthropic answer that reads from the cache and writes to it: all four kinds of token. */
const CACHING_SSE_CHUNKS = [
  'event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":21,"output_tokens":1,"cache_read_input_tokens":4000,"cache_creation_input_tokens":512}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
];

const startRawUpstream = async (status = 200, errorBody?: string, chunks: readonly string[] = SSE_CHUNKS): Promise<RawUpstream> => {
  const seen: IncomingHttpHeaders[] = [];
  const server: Server = createServer((request, response) => {
    seen.push(request.headers);
    request.resume();
    if (errorBody !== undefined) {
      response.writeHead(status, { "content-type": "application/json", "x-vendor-request-id": "req-123" });
      response.end(errorBody);
      return;
    }
    response.writeHead(status, { "content-type": "text/event-stream", "x-vendor-request-id": "req-123" });
    let index = 0;
    const next = (): void => {
      const chunk = chunks[index];
      if (chunk === undefined) {
        response.end();
        return;
      }
      response.write(chunk);
      index += 1;
      setTimeout(next, 5);
    };
    next();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${String(port)}/v1`, seen };
};

describe("F-089: the key proxy", () => {
  const formats = [
    { format: "openai-compatible", scheme: "bearer", path: "/chat/completions", chunks: OPENAI_SSE_CHUNKS, usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 0 } },
    { format: "anthropic-messages", scheme: "x-api-key", path: "/messages", chunks: SSE_CHUNKS, usage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  ] as const;

  it("F-089: swaps in the real key, passes the stream through byte for byte in both API formats, and records each call's tokens", async () => {
    for (const { format, scheme, path, chunks, usage } of formats) {
      const upstream = await startRawUpstream(200, undefined, chunks);
      const harness = await startProxy(upstream.baseUrl, format, scheme);
      // The agent presents its fake key, as its SDK does for the format.
      const answer = await call(harness, path, format === "openai-compatible" ? openAiBody(true) : anthropicBody(true), scheme === "x-api-key" ? { "x-api-key": harness.proxy.fakeKey } : {});
      expect(answer.status).toBe(200);
      expect(answer.text).toBe(chunks.join(""));
      expect(answer.headers.get("x-vendor-request-id")).toBe("req-123");
      // The provider saw the real key in its own scheme's header, and never the fake one.
      const [seen] = upstream.seen;
      expect(scheme === "bearer" ? seen?.authorization : seen?.["x-api-key"]).toBe(scheme === "bearer" ? `Bearer ${REAL_TOKEN}` : REAL_TOKEN);
      expect(JSON.stringify(seen)).not.toContain(harness.proxy.fakeKey);
      expect(harness.usage).toEqual([{ kind: "usage.recorded", providerId, modelId, ...usage, estimated: false }]);
    }
  });

  it("F-089: passes each chunk of a stream on as it comes, before the provider has sent the rest, in both API formats", async () => {
    for (const { format, scheme, path, chunks } of formats) {
      const [firstChunk] = chunks;
      if (firstChunk === undefined) {
        throw new Error("the answer has no chunk");
      }
      // The provider sends its first chunk, then holds the rest until the agent has read that one.
      const gate = Promise.withResolvers<undefined>();
      const server = createServer((request, response) => {
        request.resume();
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(firstChunk);
        void gate.promise.then(() => {
          response.end(chunks.slice(1).join(""));
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      closers.push(
        () =>
          new Promise<void>((resolve) => {
            gate.resolve(undefined);
            server.closeAllConnections();
            server.close(() => {
              resolve();
            });
          }),
      );
      const address: AddressInfo | string | null = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const harness = await startProxy(`http://127.0.0.1:${String(port)}/v1`, format, scheme);
      const response = await fetch(`${harness.proxy.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${harness.proxy.fakeKey}`, "x-api-key": harness.proxy.fakeKey },
        body: format === "openai-compatible" ? openAiBody(true) : anthropicBody(true),
      });
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error("the answer has no body");
      }
      const decoder = new TextDecoder();
      let text = "";
      const append = (value: unknown): void => {
        if (value instanceof Uint8Array) {
          text += decoder.decode(value, { stream: true });
        }
      };
      const timedOut = Symbol("timed out");
      // Read until the first chunk is in, or give up: a proxy that holds the answer never sends it.
      while (text.length < firstChunk.length) {
        const read = await Promise.race([
          reader.read(),
          new Promise<typeof timedOut>((resolve) => {
            setTimeout(() => {
              resolve(timedOut);
            }, 5_000);
          }),
        ]);
        if (read === timedOut || read.done) {
          break;
        }
        append(read.value);
      }
      expect(text, `${format}: the first chunk, while the provider holds the rest`).toBe(firstChunk);
      gate.resolve(undefined);
      for (;;) {
        const read = await reader.read();
        if (read.done) {
          break;
        }
        append(read.value);
      }
      expect(text).toBe(chunks.join(""));
    }
  });

  it("F-089: its count equals what the endpoint reports, in both formats, streamed or not", async () => {
    for (const { format, scheme, path } of formats) {
      for (const stream of [true, false]) {
        const server = await stub(format, () => ({ text: "Counted to the token, in every format and both ways." }));
        const harness = await startProxy(server.baseUrl, format, scheme);
        const answer = await call(harness, path, format === "openai-compatible" ? openAiBody(stream) : anthropicBody(stream));
        expect(answer.status).toBe(200);
        // What the endpoint billed and wrote into its answer, against the proxy's count: no more than 2% apart.
        const billed = server.calls[0]?.billed;
        if (billed === undefined) {
          throw new Error("the stub billed nothing");
        }
        const [counted] = harness.usage;
        const reported = billed.inputTokens + billed.outputTokens + billed.cacheReadTokens;
        const proxied = (counted?.inputTokens ?? 0) + (counted?.outputTokens ?? 0) + (counted?.cacheReadTokens ?? 0) + (counted?.cacheWriteTokens ?? 0);
        expect(reported).toBeGreaterThan(0);
        expect(Math.abs(proxied - reported)).toBeLessThanOrEqual(reported * 0.02);
        expect(counted).toMatchObject({ inputTokens: billed.inputTokens, outputTokens: billed.outputTokens, cacheReadTokens: billed.cacheReadTokens, estimated: false });
      }
    }
  });

  it("F-089: counts every call it carries, title calls and other calls with no tools included", async () => {
    const server = await stub("openai-compatible", () => ({ text: "A short title" }));
    const harness = await startProxy(server.baseUrl, "openai-compatible", "bearer");
    // A title call (no tools, not streamed), a tool-less streamed call, and a turn's call with tools.
    await call(harness, "/chat/completions", openAiBody(false, false));
    await call(harness, "/chat/completions", openAiBody(true, false));
    await call(harness, "/chat/completions", openAiBody(true, true));
    expect(server.calls.map((item) => item.toolNames.length)).toEqual([0, 0, 1]);
    expect(harness.usage).toHaveLength(3);
    expect(harness.proxy.totals().calls).toBe(3);
    expect(harness.usage.map((event) => event.outputTokens)).toEqual(server.calls.map((item) => item.billed?.outputTokens));
  });

  it("F-089: records fresh input, output, cache-read and cache-write tokens for each call", async () => {
    const upstream = await startRawUpstream(200, undefined, CACHING_SSE_CHUNKS);
    const harness = await startProxy(upstream.baseUrl, "anthropic-messages", "x-api-key");
    await call(harness, "/messages", anthropicBody(true));
    await call(harness, "/messages", anthropicBody(true));
    // One event per call, each with the four kinds apart.
    expect(harness.usage).toEqual([
      { kind: "usage.recorded", providerId, modelId, inputTokens: 21, outputTokens: 9, cacheReadTokens: 4000, cacheWriteTokens: 512, estimated: false },
      { kind: "usage.recorded", providerId, modelId, inputTokens: 21, outputTokens: 9, cacheReadTokens: 4000, cacheWriteTokens: 512, estimated: false },
    ]);
    expect(harness.proxy.totals().usage).toMatchObject({ input: 42, output: 18, cacheRead: 8000, cacheWrite: 1024 });
  });

  it("F-089: estimates a call whose endpoint reported no usage, and marks the count as an estimate", async () => {
    for (const { format, scheme, path } of formats) {
      const server = await stub(format, () => ({ text: "This answer carries no usage at all, so it is estimated.", reportUsage: false }));
      const harness = await startProxy(server.baseUrl, format, scheme);
      const answer = await call(harness, path, format === "openai-compatible" ? openAiBody(true) : anthropicBody(true));
      expect(answer.status).toBe(200);
      expect(harness.usage).toHaveLength(1);
      expect(harness.usage[0]).toMatchObject({ estimated: true });
      expect(harness.usage[0]?.inputTokens).toBeGreaterThan(0);
      expect(harness.usage[0]?.outputTokens).toBeGreaterThan(0);
      expect(harness.proxy.totals().estimatedCalls).toBe(1);
    }
  });

  it("F-089: reports a rate-limit answer with the provider's retry time, and passes the answer on", async () => {
    for (const { format, scheme, path } of formats) {
      const server = await stub(format, () => ({ error: { status: 429, message: "slow down", retryAfterSeconds: 7 } }));
      const harness = await startProxy(server.baseUrl, format, scheme);
      const answer = await call(harness, path, format === "openai-compatible" ? openAiBody(false) : anthropicBody(false));
      expect(answer.status).toBe(429);
      expect(harness.rateLimits).toEqual([{ status: 429, retryAfterMs: 7_000 }]);
      expect(rateLimitHoldSeconds(harness.rateLimits[0]?.retryAfterMs ?? null)).toBe(7);
      expect(harness.usage).toEqual([]);
    }
  });
});

describe("pass-through", () => {
  it("passes the stream through byte for byte, keep-alives and vendor fields included", async () => {
    const upstream = await startRawUpstream();
    const harness = await startProxy(upstream.baseUrl, "anthropic-messages", "x-api-key");
    const answer = await call(harness, "/messages", anthropicBody(true));
    expect(answer.text).toBe(SSE_CHUNKS.join(""));
    expect(answer.headers.get("x-vendor-request-id")).toBe("req-123");
    expect(harness.usage[0]).toMatchObject({ inputTokens: 11, outputTokens: 5, estimated: false });
  });

  it("passes an error body through as received, and counts no usage for it", async () => {
    const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad", extra: true } });
    const upstream = await startRawUpstream(400, body);
    const harness = await startProxy(upstream.baseUrl, "anthropic-messages", "x-api-key");
    const answer = await call(harness, "/messages", anthropicBody(false));
    expect(answer.status).toBe(400);
    expect(answer.text).toBe(body);
    expect(harness.usage).toEqual([]);
  });

  it("strips every client credential header and sets the real one", async () => {
    const upstream = await startRawUpstream();
    const harness = await startProxy(upstream.baseUrl, "openai-compatible", "bearer");
    await call(harness, "/chat/completions", openAiBody(true), {
      "x-api-key": "client-own-key",
      "api-key": "client-azure-key",
      cookie: "session=client",
      "anthropic-version": "2023-06-01",
    });
    const [headers] = upstream.seen;
    expect(headers?.authorization).toBe(`Bearer ${REAL_TOKEN}`);
    expect(headers?.["x-api-key"]).toBeUndefined();
    expect(headers?.["api-key"]).toBeUndefined();
    expect(headers?.cookie).toBeUndefined();
    expect(headers?.["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.stringify(headers)).not.toContain(harness.proxy.fakeKey);
  });

  it("reports an upstream 401 at once, as the task's typed failure", async () => {
    const upstream = await startRawUpstream(401, JSON.stringify({ error: { message: "bad key" } }));
    const harness = await startProxy(upstream.baseUrl, "openai-compatible", "bearer");
    const answer = await call(harness, "/chat/completions", openAiBody(false));
    expect(answer.status).toBe(401);
    expect(harness.refusals).toEqual([{ status: 401, path: "/v1/chat/completions" }]);
  });
});

describe("only the model API is forwarded", () => {
  const raw = async (harness: Harness, method: string, path: string, withBase = false): Promise<{ readonly status: number; readonly text: string }> => {
    const origin = new URL(harness.proxy.baseUrl).origin;
    const response = await fetch(`${withBase ? harness.proxy.baseUrl : origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${harness.proxy.fakeKey}`, "x-api-key": harness.proxy.fakeKey, "content-type": "application/json" },
      ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
    });
    return { status: response.status, text: await response.text() };
  };

  it.each([
    ["a file route under the base path", "POST", "/files", true],
    ["an assistants thread's messages", "POST", "/threads/thread_1/messages", true],
    ["a deletion", "DELETE", "/chat/completions", true],
    ["a read of a model route", "GET", "/chat/completions", true],
    ["the batches route", "POST", "/batches", true],
    ["a sibling of the base path", "POST", "/v1x/chat/completions", false],
    ["a route outside the base path", "POST", "/organization/projects", false],
    ["a model route outside the base path", "POST", "/other/v1/chat/completions", false],
    ["a path that climbs out of the base path", "POST", "/v1/../admin/chat/completions", false],
    ["the model list by POST", "POST", "/models", true],
    ["a model by id", "GET", "/models/stub-model", true],
  ] as const)("refuses %s with a 403 and never sends the real token", async (_name, method, path, withBase) => {
    const upstream = await startRawUpstream();
    const harness = await startProxy(upstream.baseUrl, "openai-compatible", "bearer");
    const answer = await raw(harness, method, path, withBase);
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.text)).toMatchObject({ error: { code: "route_not_allowed" } });
    expect(upstream.seen).toEqual([]);
    expect(harness.proxy.totals()).toMatchObject({ calls: 0, refused: 1 });
    const refusal = harness.logs.find((record) => JSON.stringify(record).includes("path-not-allowed"));
    expect(refusal).toBeDefined();
    expect(JSON.stringify(harness.logs)).not.toContain(path.split("/").filter((part) => part !== "").at(-1) ?? "never");
  });

  it("answers a refusal in the Anthropic shape for an Anthropic provider", async () => {
    const upstream = await startRawUpstream();
    const harness = await startProxy(upstream.baseUrl, "anthropic-messages", "x-api-key");
    const answer = await raw(harness, "POST", "/files", true);
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.text)).toMatchObject({ type: "error", error: { type: "permission_error" } });
    expect(upstream.seen).toEqual([]);
  });

  it("checks the key first: a wrong key still gets the 401", async () => {
    const upstream = await startRawUpstream();
    const harness = await startProxy(upstream.baseUrl, "openai-compatible", "bearer");
    const response = await fetch(`${harness.proxy.baseUrl}/files`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
    expect(response.status).toBe(401);
  });

  it.each([
    ["the chat route", "POST", "/chat/completions"],
    ["the responses route", "POST", "/responses"],
    ["the messages route", "POST", "/messages"],
    ["the model list", "GET", "/models"],
    ["the model list with a trailing slash", "GET", "/models/"],
  ] as const)("forwards %s with the real token", async (_name, method, path) => {
    const upstream = await startRawUpstream();
    const harness = await startProxy(upstream.baseUrl, "openai-compatible", "bearer");
    const answer = await raw(harness, method, path, true);
    expect(answer.status).toBe(200);
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]?.authorization).toBe(`Bearer ${REAL_TOKEN}`);
  });

  it("allows a version segment when the provider's base path lacks one", () => {
    expect(isAllowedRoute("POST", "/v1/chat/completions", "")).toBe(true);
    expect(isAllowedRoute("GET", "/v1/models", "")).toBe(true);
    expect(isAllowedRoute("POST", "/v1/files", "")).toBe(false);
    expect(isAllowedRoute("POST", "/openai/v1/chat/completions", "/openai/v1")).toBe(true);
    expect(isAllowedRoute("POST", "/openai/v1", "/openai/v1")).toBe(false);
    expect(isAllowedRoute("POST", "/openai/v2/chat/completions", "/openai/v1")).toBe(false);
  });
});

describe("the real token stays out", () => {
  it("is in no log line, answer, error or event", async () => {
    const server = await stub("openai-compatible", () => ({ text: "hello" }));
    const harness = await startProxy(server.baseUrl, "openai-compatible", "bearer");
    const outputs: string[] = [];
    outputs.push((await call(harness, "/chat/completions", openAiBody(true))).text);
    outputs.push((await call(harness, "/chat/completions", openAiBody(false), { authorization: "Bearer wrong" })).text);
    // An unreachable provider: the error the agent sees.
    const dead = await startProxy("http://127.0.0.1:1/v1", "openai-compatible", "bearer");
    outputs.push((await call(dead, "/chat/completions", openAiBody(false))).text);
    const everything = JSON.stringify([outputs, harness.logs, harness.usage, dead.logs, dead.usage]);
    expect(everything).not.toContain(REAL_TOKEN);
    expect(everything).not.toContain(harness.proxy.fakeKey);
    expect(harness.logs.length).toBeGreaterThan(0);
  });
});

describe("Retry-After", () => {
  it("reads seconds and an HTTP date", () => {
    expect(parseRetryAfter("12", 0)).toBe(12_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter(undefined, 0)).toBeNull();
    expect(parseRetryAfter("soon", 0)).toBeNull();
  });

  it("turns it into a hold in whole seconds: rounded up, at least one, capped, a default when absent", () => {
    expect(rateLimitHoldSeconds(7_000)).toBe(7);
    expect(rateLimitHoldSeconds(7_001)).toBe(8);
    expect(rateLimitHoldSeconds(0)).toBe(1);
    expect(rateLimitHoldSeconds(10 * 3_600_000)).toBe(RATE_LIMIT_HOLD_MAX_SECONDS);
    expect(rateLimitHoldSeconds(null)).toBe(RATE_LIMIT_HOLD_DEFAULT_SECONDS);
  });
});

// The live case: one call through the proxy to the development endpoint (model.env), and its count
// matches the endpoint's own figure in the answer. Skipped without model.env; prints no value.
const liveEnv = z
  .object({ OSTRA_DEV_MODEL_BASE_URL: z.url(), OSTRA_DEV_MODEL_API_KEY: z.string().min(1), OSTRA_DEV_MODEL_ID: z.string().min(1) })
  .safeParse(process.env);

describe.skipIf(!liveEnv.success)("the key proxy, live", () => {
  it("counts one real call within 2% of the endpoint's own figure", async () => {
    if (!liveEnv.success) {
      return;
    }
    const { OSTRA_DEV_MODEL_BASE_URL: baseUrl, OSTRA_DEV_MODEL_API_KEY: token, OSTRA_DEV_MODEL_ID: model } = liveEnv.data;
    const body = JSON.stringify({ model, stream: true, max_tokens: 64, messages: [{ role: "user", content: "Reply with the word ok." }] });
    for (const scheme of ["x-api-key", "bearer"] as const) {
      const usage: TaskEventOf<"usage.recorded">[] = [];
      const proxy = await startKeyProxy({
        taskId,
        providerId,
        modelId,
        model: { baseUrl, apiFormat: "anthropic-messages", authScheme: scheme, token },
        listenHost: "127.0.0.1",
        fakeKeyTtlMs: 60_000,
        logger: createLogger(() => undefined),
        onUsage: (event) => usage.push(event),
      });
      closers.push(proxy.close);
      const response = await fetch(`${proxy.baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": proxy.fakeKey, "anthropic-version": "2023-06-01" },
        body,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.status === 401 || response.status === 403) {
        continue;
      }
      expect(response.status, "the live endpoint answered").toBe(200);
      const own = createUsageMeter("anthropic-messages", true);
      own.push(bytes);
      const figure = own.end().usage;
      expect(figure, "the endpoint reported usage").toBeDefined();
      const counted = usage[0];
      expect(counted?.estimated).toBe(false);
      const ownTotal = (figure?.input ?? 0) + (figure?.output ?? 0) + (figure?.cacheRead ?? 0) + (figure?.cacheWrite ?? 0);
      const proxyTotal = (counted?.inputTokens ?? 0) + (counted?.outputTokens ?? 0) + (counted?.cacheReadTokens ?? 0) + (counted?.cacheWriteTokens ?? 0);
      expect(Math.abs(proxyTotal - ownTotal)).toBeLessThanOrEqual(Math.ceil(ownTotal * 0.02));
      return;
    }
    throw new Error("the live endpoint refused both auth schemes");
  }, 60_000);
});
