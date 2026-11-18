import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { taskId } from "../src/lib/ids.ts";
import { startKeyProxy, type KeyProxy } from "../src/lib/key-proxy.ts";
import { createScenarioBrain } from "../src/lib/stub-models/scenario.ts";
import { startStubModelServer, type StubServer } from "../src/lib/stub-models/server.ts";
import type { StubFormat } from "../src/lib/stub-models/types.ts";
import { totalTokens } from "../src/lib/usage.ts";

const brain = createScenarioBrain({
  hello: ({ step }) => (step === 0 ? { text: "hello there, this is a longer streamed answer" } : undefined),
  tool: ({ step }) => (step === 0 ? { toolCalls: [{ name: "read", arguments: { path: "a.txt" } }] } : undefined),
});

type Pair = { stub: StubServer; proxy: KeyProxy; realKey: string };

const pairs = new Map<StubFormat, Pair>();

beforeAll(async () => {
  for (const format of ["openai", "anthropic"] as const) {
    const realKey = randomBytes(16).toString("hex");
    const stub = await startStubModelServer({ format, realKey, models: ["m1"], brain, chunkChars: 3 });
    const proxy = await startKeyProxy({ upstreamBaseUrl: stub.baseUrl, realKey, upstreamAuth: format === "openai" ? "bearer" : "x-api-key", taskId: taskId("test") });
    pairs.set(format, { stub, proxy, realKey });
  }
});

afterAll(async () => {
  for (const pair of pairs.values()) {
    await pair.proxy.close();
    await pair.stub.close();
  }
});

const get = (format: StubFormat): Pair => {
  const pair = pairs.get(format);
  if (pair === undefined) throw new Error("not started");
  return pair;
};

const call = async (format: StubFormat, key: string, stream: boolean, marker = "[[stub:hello]]"): Promise<Response> => {
  const { proxy } = get(format);
  const tools = format === "openai" ? [{ type: "function", function: { name: "read", parameters: {} } }] : [{ name: "read", input_schema: {} }];
  const body =
    format === "openai"
      ? { model: "m1", stream, stream_options: stream ? { include_usage: true } : undefined, messages: [{ role: "user", content: marker }], tools }
      : { model: "m1", stream, max_tokens: 100, messages: [{ role: "user", content: marker }], tools };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (format === "openai") headers["authorization"] = `Bearer ${key}`;
  else headers["x-api-key"] = key;
  return fetch(`${proxy.agentBaseUrl}/${format === "openai" ? "chat/completions" : "messages"}`, { method: "POST", headers, body: JSON.stringify(body) });
};

describe.each(["openai", "anthropic"] as const)("key proxy, %s format", (format) => {
  it("refuses a request without the fake key, and never reaches the endpoint", async () => {
    const { stub } = get(format);
    const before = stub.calls.length;
    const response = await call(format, "not-the-fake-key", false);
    expect(response.status).toBe(401);
    expect(stub.calls.length).toBe(before);
  });

  it("swaps in the real key and counts streamed usage exactly", async () => {
    const { proxy, stub } = get(format);
    const response = await call(format, proxy.fakeKey, true);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("data:");
    const last = stub.calls.at(-1);
    expect(last?.authOk).toBe(true);
    const record = proxy.calls.at(-1);
    expect(record?.keySwapped).toBe(true);
    expect(record?.requestedModel).toBe("m1");
    expect(record?.hasTools).toBe(true);
    const billed = last?.billed;
    expect(billed).toBeDefined();
    const usage = record?.usage;
    expect(usage === undefined ? -1 : totalTokens(usage)).toBe(billed === undefined ? -2 : billed.inputTokens + billed.outputTokens + billed.cacheReadTokens);
  });

  it("passes a non-streamed response through and counts it", async () => {
    const { proxy } = get(format);
    const response = await call(format, proxy.fakeKey, false, "[[stub:tool]]");
    expect(response.status).toBe(200);
    await response.json();
    expect(proxy.calls.at(-1)?.usage?.output).toBeGreaterThan(0);
  });
});

describe("revocation", () => {
  it("refuses the fake key once revoked", async () => {
    const realKey = randomBytes(16).toString("hex");
    const stub = await startStubModelServer({ format: "openai", realKey, models: ["m1"], brain });
    const proxy = await startKeyProxy({ upstreamBaseUrl: stub.baseUrl, realKey, upstreamAuth: "bearer", taskId: taskId("revoke") });
    proxy.revoke();
    const response = await fetch(`${proxy.agentBaseUrl}/models`, { headers: { authorization: `Bearer ${proxy.fakeKey}` } });
    expect(response.status).toBe(401);
    await proxy.close();
    await stub.close();
  });
});

describe("compression", () => {
  it("asks the upstream for an uncompressed body, so the meter can read it", async () => {
    let seen: string | undefined;
    const upstream = createServer((req, res) => {
      seen = req.headers["accept-encoding"];
      const body = JSON.stringify({ model: "m1", usage: { prompt_tokens: 7, completion_tokens: 3 } });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address: AddressInfo | string | null = upstream.address();
    const upstreamPort = typeof address === "object" && address !== null ? address.port : 0;
    const proxy = await startKeyProxy({ upstreamBaseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`, realKey: "k", upstreamAuth: "bearer", taskId: taskId("gzip") });
    const response = await fetch(`${proxy.agentBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.fakeKey}`, "content-type": "application/json", "accept-encoding": "gzip, br" },
      body: JSON.stringify({ model: "m1", messages: [] }),
    });
    await response.text();
    expect(seen).toBe("identity");
    expect(proxy.calls.at(-1)?.usage?.input).toBe(7);
    expect(proxy.calls.at(-1)?.hasTools).toBe(false);
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => { resolve(); }));
  });
});
