import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { startAnthropicStub, startOpenAiStub } from "@ostra/adapter-sdk/testing";
import type { StubReply, StubServer } from "@ostra/adapter-sdk/testing";
import { modelIdSchema, providerIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ApiFormat, AuthScheme, SpendCap, TaskEventOf, TokenPrices } from "@ostra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { SPEND_CAP_MESSAGE, startKeyProxy } from "./key-proxy.ts";
import type { KeyProxy, SpendCapReached } from "./key-proxy.ts";
import { countTokens, createSpendMeter, priceUsage } from "./spend-cap.ts";

// Ticket 25's "done when", at the key proxy against both stub formats: the cap fires once at its
// value; a refused call counts as nothing spent; the token form works; a call already streaming
// finishes and is counted.

const REAL_TOKEN = "sk-real-provider-token-spend-cap-0123456789";
const taskId = taskIdSchema.parse("task-spend-cap");
const providerId = providerIdSchema.parse("provider-1");
const modelId = modelIdSchema.parse("model-1");
const prices: TokenPrices = { inputPerMTok: 3_000_000, outputPerMTok: 15_000_000, cacheReadPerMTok: 300_000, cacheWritePerMTok: 3_750_000 };

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

type Proxy = {
  readonly proxy: KeyProxy;
  readonly usage: TaskEventOf<"usage.recorded">[];
  readonly reached: SpendCapReached[];
  readonly logs: LogRecord[];
};

const stub = async (format: ApiFormat, reply: StubReply = { text: "Hello there, from the stub." }): Promise<StubServer> => {
  const options = { realKey: REAL_TOKEN, models: ["stub-model"], brain: () => reply };
  const server = format === "openai-compatible" ? await startOpenAiStub(options) : await startAnthropicStub(options);
  closers.push(server.close);
  return server;
};

const proxyFor = async (server: StubServer, format: ApiFormat, spendCap: SpendCap): Promise<Proxy> => {
  const usage: TaskEventOf<"usage.recorded">[] = [];
  const reached: SpendCapReached[] = [];
  const logs: LogRecord[] = [];
  const authScheme: AuthScheme = format === "anthropic-messages" ? "x-api-key" : "bearer";
  const proxy = await startKeyProxy({
    taskId,
    providerId,
    modelId,
    model: { baseUrl: server.baseUrl, apiFormat: format, authScheme, token: REAL_TOKEN },
    listenHost: "127.0.0.1",
    fakeKeyTtlMs: 60_000,
    logger: createLogger((record) => logs.push(record)),
    onUsage: (event) => usage.push(event),
    spendCap,
    onSpendCapReached: (event) => reached.push(event),
  });
  closers.push(proxy.close);
  return { proxy, usage, reached, logs };
};

const callModel = async (proxy: KeyProxy, format: ApiFormat, stream = false): Promise<{ readonly status: number; readonly text: string }> => {
  const anthropic = format === "anthropic-messages";
  const response = await fetch(`${proxy.baseUrl}${anthropic ? "/messages" : "/chat/completions"}`, {
    method: "POST",
    headers: anthropic
      ? { "content-type": "application/json", "x-api-key": proxy.fakeKey, "anthropic-version": "2023-06-01" }
      : { "content-type": "application/json", authorization: `Bearer ${proxy.fakeKey}` },
    body: JSON.stringify(
      anthropic
        ? { model: "stub-model", stream, max_tokens: 64, messages: [{ role: "user", content: "Say hello." }] }
        : { model: "stub-model", stream, ...(stream ? { stream_options: { include_usage: true } } : {}), messages: [{ role: "user", content: "Say hello." }] },
    ),
  });
  return { status: response.status, text: await response.text() };
};

/** The micro-USD of the usage events, priced as the proxy prices them. */
const priced = (usage: readonly TaskEventOf<"usage.recorded">[]): number =>
  usage.reduce(
    (sum, event) =>
      sum + priceUsage({ input: event.inputTokens, output: event.outputTokens, cacheRead: event.cacheReadTokens, cacheWrite: event.cacheWriteTokens, reasoning: 0 }, prices),
    0,
  );

describe("the spend cap at the key proxy (F-068)", () => {
  it.each(["openai-compatible", "anthropic-messages"] as const)("fires once at its value and refuses the next call in the %s shape", async (format) => {
    const server = await stub(format);
    // One call's cost, measured through a proxy with a cap it can't reach.
    const probe = await proxyFor(server, format, { capMicroUsd: 1_000_000_000, spentMicroUsd: 0, prices });
    expect((await callModel(probe.proxy, format)).status).toBe(200);
    const oneCall = priced(probe.usage);
    expect(oneCall).toBeGreaterThan(0);

    // Earlier sessions spent most of it: the second call of this session reaches the cap.
    const spent = 1_000;
    const cap = spent + Math.ceil(oneCall * 1.5);
    const { proxy, usage, reached, logs } = await proxyFor(server, format, { capMicroUsd: cap, spentMicroUsd: spent, prices });
    expect((await callModel(proxy, format)).status).toBe(200);
    expect(reached).toEqual([]);
    expect((await callModel(proxy, format)).status).toBe(200);
    expect(reached).toEqual([{ unit: "micro-usd", observed: Math.round(spent + priced(usage)) }]);
    expect(reached[0]?.observed).toBeGreaterThanOrEqual(cap);

    // The next call never reaches the provider, is refused in the API's own shape, and costs nothing.
    const callsBefore = server.calls.length;
    const refused = await callModel(proxy, format);
    expect(refused.status).toBe(400);
    expect(refused.text).toContain(SPEND_CAP_MESSAGE);
    expect(JSON.parse(refused.text)).toMatchObject(format === "anthropic-messages" ? { type: "error", error: { type: "invalid_request_error" } } : { error: { code: "spend_cap_reached" } });
    expect(server.calls.length).toBe(callsBefore);
    expect(usage).toHaveLength(2);
    expect((await callModel(proxy, format)).status).toBe(400);
    // Still once.
    expect(reached).toHaveLength(1);
    expect(proxy.totals()).toMatchObject({ calls: 2, refused: 2 });
    expect(JSON.stringify(logs)).not.toContain(REAL_TOKEN);
  }, 60_000);

  it.each(["openai-compatible", "anthropic-messages"] as const)("lets a call already streaming finish and counts it, in the %s shape", async (format) => {
    const server = await stub(format, { text: "A streamed answer, a few words at a time.", chunkDelayMs: 40 });
    const probe = await proxyFor(server, format, { capMicroUsd: 1_000_000_000, spentMicroUsd: 0, prices });
    await callModel(probe.proxy, format, true);
    const oneCall = priced(probe.usage);
    // The cap is reached by the first stream to end: the second, already streaming, still finishes.
    const { proxy, usage, reached } = await proxyFor(server, format, { capMicroUsd: Math.ceil(oneCall), spentMicroUsd: 0, prices });
    const [first, second] = await Promise.all([callModel(proxy, format, true), callModel(proxy, format, true)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(usage).toHaveLength(2);
    expect(reached).toHaveLength(1);
    expect((await callModel(proxy, format, true)).status).toBe(400);
  }, 60_000);

  it("counts tokens for a model with no price, and refuses at the token cap", async () => {
    const format = "anthropic-messages";
    const server = await stub(format);
    const probe = await proxyFor(server, format, { capTokens: 100_000_000, spentTokens: 0 });
    await callModel(probe.proxy, format);
    const [event] = probe.usage;
    if (event === undefined) throw new Error("no usage");
    const tokens = event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens;
    const { proxy, reached } = await proxyFor(server, format, { capTokens: 500 + tokens, spentTokens: 500 });
    expect((await callModel(proxy, format)).status).toBe(200);
    expect(reached).toEqual([{ unit: "tokens", observed: 500 + tokens }]);
    expect((await callModel(proxy, format)).status).toBe(400);
  }, 60_000);

  it("refuses the first call when earlier sessions already spent the cap, and says so once", async () => {
    const format = "openai-compatible";
    const server = await stub(format);
    const { proxy, reached, usage } = await proxyFor(server, format, { capMicroUsd: 100, spentMicroUsd: 100, prices });
    expect((await callModel(proxy, format)).status).toBe(400);
    expect((await callModel(proxy, format)).status).toBe(400);
    expect(reached).toEqual([{ unit: "micro-usd", observed: 100 }]);
    expect(usage).toEqual([]);
    expect(server.calls).toHaveLength(0);
  }, 60_000);

  it("prices the four token kinds, and counts every kind in the token form", () => {
    const usage = { input: 1_000, output: 2_000, cacheRead: 10_000, cacheWrite: 4_000, reasoning: 500 };
    // 1000*3 + 2000*15 + 10000*0.3 + 4000*3.75 micro-USD.
    expect(priceUsage(usage, prices)).toBe(3_000 + 30_000 + 3_000 + 15_000);
    expect(countTokens(usage)).toBe(17_000);
    const meter = createSpendMeter({ capMicroUsd: 51_001, spentMicroUsd: 1, prices });
    expect(meter.add(usage)).toBe(true);
    expect(meter.add(usage)).toBe(false);
    expect(meter.spent()).toBe(102_001);
  });
});
