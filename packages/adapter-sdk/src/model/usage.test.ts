import type { ApiFormat } from "@ostra/protocol";
import { afterAll, describe, expect, it } from "vitest";

import { startStubModelServer } from "../testing/stub-models/server.ts";
import type { StubServer } from "../testing/stub-models/server.ts";
import type { StubReply } from "../testing/stub-models/types.ts";
import { modelAuthHeaders } from "./auth.ts";
import { createSseParser } from "./sse.ts";
import { createUsageMeter, formatForPath, resolveUsage } from "./usage.ts";
import type { WireFormat } from "./usage.ts";

// Usage parsing and the stub model servers, against each other: the meter must read exactly what
// each stub billed, byte for byte as it passes, however the bytes are split.

const KEY = "stub-real-key-0123456789";

type Case = {
  readonly format: ApiFormat;
  readonly wire: WireFormat;
  readonly path: string;
  readonly request: (stream: boolean) => Record<string, unknown>;
  readonly headers: Readonly<Record<string, string>>;
};

const cases: readonly Case[] = [
  {
    format: "openai-compatible",
    wire: "openai-chat",
    path: "/chat/completions",
    request: (stream) => ({
      model: "stub-model",
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      messages: [{ role: "user", content: "Say hello to the nice meter." }],
    }),
    headers: modelAuthHeaders("bearer", KEY),
  },
  {
    format: "anthropic-messages",
    wire: "anthropic-messages",
    path: "/messages",
    request: (stream) => ({
      model: "stub-model",
      stream,
      max_tokens: 200,
      messages: [{ role: "user", content: [{ type: "text", text: "Say hello to the nice meter.", cache_control: { type: "ephemeral" } }] }],
    }),
    headers: modelAuthHeaders("x-api-key", KEY),
  },
];

const servers: StubServer[] = [];
const start = async (format: ApiFormat, brain: () => StubReply): Promise<StubServer> => {
  const server = await startStubModelServer({ format, realKey: KEY, models: ["stub-model"], brain });
  servers.push(server);
  return server;
};
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const call = async (server: StubServer, spec: Case, stream: boolean): Promise<{ readonly body: Uint8Array[]; readonly requestBytes: number; readonly response: Response }> => {
  const raw = JSON.stringify(spec.request(stream));
  const response = await fetch(`${server.baseUrl}${spec.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...spec.headers },
    body: raw,
  });
  const body: Uint8Array[] = [new Uint8Array(await response.arrayBuffer())];
  return { body, requestBytes: Buffer.byteLength(raw, "utf8"), response };
};

/** The same bytes, split into pieces of `size`. */
const resplit = (chunks: readonly Uint8Array[], size: number): Uint8Array[] => {
  const all = Buffer.concat(chunks);
  const out: Uint8Array[] = [];
  for (let at = 0; at < all.length; at += size) {
    out.push(all.subarray(at, at + size));
  }
  return out;
};

describe.each(cases)("usage parsing: $format", (spec) => {
  const text: StubReply = { text: "Hello from the stub, with a few words to count." };

  it.each([true, false])("reads exactly what the stub billed (streamed: %s)", async (stream) => {
    const server = await start(spec.format, () => text);
    const { body } = await call(server, spec, stream);
    const meter = createUsageMeter(spec.wire, stream);
    for (const chunk of body) {
      meter.push(chunk);
    }
    const result = meter.end();
    const billed = server.calls.at(-1)?.billed;
    expect(billed).toBeDefined();
    expect(result.usage).toEqual({
      input: billed?.inputTokens,
      output: billed?.outputTokens,
      cacheRead: billed?.cacheReadTokens,
      cacheWrite: 0,
      reasoning: 0,
    });
    expect(result.responseModel).toBe("stub-model");
  });

  it.each([1, 2, 7, 64])("reads the same usage when the stream arrives in pieces of %i bytes", async (size) => {
    const server = await start(spec.format, () => ({ ...text, reasoning: "Thinking it over first." }));
    const { body } = await call(server, spec, true);
    const whole = createUsageMeter(spec.wire, true);
    for (const chunk of body) {
      whole.push(chunk);
    }
    const split = createUsageMeter(spec.wire, true);
    for (const chunk of resplit(body, size)) {
      split.push(chunk);
    }
    expect(split.end()).toEqual(whole.end());
  });

  it("counts a cache read separately from the input", async () => {
    const server = await start(spec.format, () => text);
    const { body } = await call(server, spec, true);
    const meter = createUsageMeter(spec.wire, true);
    for (const chunk of body) {
      meter.push(chunk);
    }
    const billed = server.calls.at(-1)?.billed;
    // Only Anthropic's stub bills a cache read, for a request that asks for caching.
    expect(meter.end().usage?.cacheRead).toBe(billed?.cacheReadTokens);
    expect(billed?.cacheReadTokens === 0).toBe(spec.format === "openai-compatible");
  });

  it("marks a stream that reports no usage as estimated, from the sizes it saw", async () => {
    const server = await start(spec.format, () => ({ ...text, reportUsage: false }));
    const { body, requestBytes } = await call(server, spec, true);
    const meter = createUsageMeter(spec.wire, true);
    for (const chunk of body) {
      meter.push(chunk);
    }
    const result = meter.end();
    expect(result.usage).toBeUndefined();
    const metered = resolveUsage(result, requestBytes);
    const billed = server.calls.at(-1)?.billed;
    expect(server.calls.at(-1)?.usageReported).toBe(false);
    expect(metered.estimated).toBe(true);
    expect(metered.usage.output).toBe(billed?.outputTokens);
    expect(metered.usage.input).toBe(Math.ceil(requestBytes / 4));
    expect(metered.usage.cacheRead).toBe(0);
  });

  it("estimates a plain answer that reports no usage", async () => {
    const server = await start(spec.format, () => ({ ...text, reportUsage: false }));
    const { body, requestBytes } = await call(server, spec, false);
    const meter = createUsageMeter(spec.wire, false);
    for (const chunk of body) {
      meter.push(chunk);
    }
    const metered = resolveUsage(meter.end(), requestBytes);
    expect(metered.estimated).toBe(true);
    expect(metered.usage.output).toBeGreaterThan(0);
  });

  it("keeps the endpoint's own figure, unestimated, when it reports usage", async () => {
    const server = await start(spec.format, () => text);
    const { body, requestBytes } = await call(server, spec, true);
    const meter = createUsageMeter(spec.wire, true);
    for (const chunk of body) {
      meter.push(chunk);
    }
    expect(resolveUsage(meter.end(), requestBytes).estimated).toBe(false);
  });

  it("answers a rate limit with Retry-After and a body in the format's own error shape", async () => {
    const server = await start(spec.format, () => ({ error: { status: 429, message: "slow down", retryAfterSeconds: 7 } }));
    const { response, body } = await call(server, spec, false);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(Buffer.concat(body).toString("utf8")).toContain("slow down");
  });

  it("refuses a wrong key", async () => {
    const server = await start(spec.format, () => text);
    const wrong = { ...spec, headers: spec.format === "openai-compatible" ? modelAuthHeaders("bearer", "nope") : modelAuthHeaders("x-api-key", "nope") };
    expect((await call(server, wrong, false)).response.status).toBe(401);
  });
});

describe("usage parsing: other shapes", () => {
  it("reads the Responses API's stream", () => {
    const meter = createUsageMeter("openai-responses", true);
    const events = [
      { type: "response.created", response: { model: "m" } },
      { type: "response.output_text.delta", delta: "hi" },
      {
        type: "response.completed",
        response: { model: "m", usage: { input_tokens: 30, output_tokens: 9, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 4 } } },
      },
    ];
    meter.push(Buffer.from(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")));
    expect(meter.end()).toEqual({
      usage: { input: 20, output: 9, cacheRead: 10, cacheWrite: 0, reasoning: 4 },
      responseModel: "m",
      outputBytes: 2,
    });
  });

  it("ignores a body that isn't JSON, and a [DONE] marker", () => {
    const meter = createUsageMeter("openai-chat", true);
    meter.push(Buffer.from("data: not json\n\ndata: [DONE]\n\n"));
    expect(meter.end().usage).toBeUndefined();
  });

  it("names the wire format of a model call by its path", () => {
    expect(formatForPath("/v1/chat/completions")).toBe("openai-chat");
    expect(formatForPath("/v1/responses/")).toBe("openai-responses");
    expect(formatForPath("/v1/messages")).toBe("anthropic-messages");
    expect(formatForPath("/v1/models")).toBeUndefined();
  });

  it("parses server-sent events across chunk borders, CRLF included", () => {
    const seen: string[] = [];
    const parser = createSseParser((event) => {
      seen.push(`${event.event ?? "-"}:${event.data}`);
    });
    for (const piece of ["event: a\r\nda", "ta: one\r\n\r\n: comment\r\ndata: t", "wo\ndata: lines\n\n", "data: tail"]) {
      parser.push(Buffer.from(piece));
    }
    parser.end();
    expect(seen).toEqual(["a:one", "-:two\nlines", "-:tail"]);
  });
});
