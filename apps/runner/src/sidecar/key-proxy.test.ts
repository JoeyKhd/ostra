import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger, createUsageMeter } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { startAnthropicStub, startOpenAiStub } from "@ostra/adapter-sdk/testing";
import type { StubReply, StubServer } from "@ostra/adapter-sdk/testing";
import { modelIdSchema, providerIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ApiFormat, AuthScheme, TaskEventOf } from "@ostra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseRetryAfter, startKeyProxy } from "./key-proxy.ts";
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

const startRawUpstream = async (status = 200, errorBody?: string): Promise<RawUpstream> => {
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
      const chunk = SSE_CHUNKS[index];
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
