import { describe, expect, it } from "vitest";
import { createSseParser } from "../src/lib/sse.ts";
import { createUsageMeter, formatForPath, totalTokens } from "../src/lib/usage.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Feeds `text` one byte at a time: the worst chunking a stream can have. */
const feedByByte = (push: (chunk: Uint8Array) => void, text: string): void => {
  for (const b of bytes(text)) push(new Uint8Array([b]));
};

describe("createSseParser", () => {
  it("joins events split across chunks, multi-line data, CRLF and comments", () => {
    const seen: { event: string | undefined; data: string }[] = [];
    const parser = createSseParser((e) => seen.push(e));
    feedByByte(parser.push, ": keepalive\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: three\n\n");
    parser.end();
    expect(seen).toEqual([
      { event: "a", data: "one\ntwo" },
      { event: undefined, data: "three" },
    ]);
  });
});

describe("formatForPath", () => {
  it("maps model-call paths to formats", () => {
    expect(formatForPath("/v1/chat/completions")).toBe("openai-chat");
    expect(formatForPath("/api/v1/responses/")).toBe("openai-responses");
    expect(formatForPath("/v1/messages")).toBe("anthropic-messages");
    expect(formatForPath("/v1/models")).toBeUndefined();
  });
});

describe("createUsageMeter", () => {
  it("reads OpenAI chat usage from the final stream chunk, cached tokens split out", () => {
    const meter = createUsageMeter("openai-chat", true);
    feedByByte(
      meter.push,
      [
        `data: {"choices":[{"delta":{"content":"hi"}}],"model":"m"}`,
        `data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":40}}}`,
        "data: [DONE]",
        "",
      ].join("\n\n"),
    );
    const result = meter.end();
    expect(result.usage).toEqual({ input: 60, output: 7, cacheRead: 40, cacheWrite: 0, reasoning: 0 });
    expect(result.responseModel).toBe("m");
  });

  it("reports no usage when an OpenAI stream carries none", () => {
    const meter = createUsageMeter("openai-chat", true);
    meter.push(bytes(`data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n`));
    expect(meter.end().usage).toBeUndefined();
  });

  it("merges Anthropic message_start and cumulative message_delta usage", () => {
    const meter = createUsageMeter("anthropic-messages", true);
    feedByByte(
      meter.push,
      [
        `event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":50,"output_tokens":1,"cache_read_input_tokens":30,"cache_creation_input_tokens":5}}}`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}`,
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}`,
        `event: message_stop\ndata: {"type":"message_stop"}`,
        "",
      ].join("\n\n"),
    );
    const usage = meter.end().usage;
    expect(usage).toEqual({ input: 50, output: 12, cacheRead: 30, cacheWrite: 5, reasoning: 0 });
    expect(usage === undefined ? 0 : totalTokens(usage)).toBe(97);
  });

  it("reads plain JSON responses in both formats", () => {
    const openai = createUsageMeter("openai-chat", false);
    openai.push(bytes(`{"model":"m","usage":{"prompt_tokens":10,"completion_tokens":2}}`));
    expect(openai.end().usage?.output).toBe(2);
    const anthropic = createUsageMeter("anthropic-messages", false);
    anthropic.push(bytes(`{"model":"m","usage":{"input_tokens":10,"output_tokens":3}}`));
    expect(anthropic.end().usage?.output).toBe(3);
  });

  it("reads Responses API usage from response.completed", () => {
    const meter = createUsageMeter("openai-responses", true);
    meter.push(bytes(`event: response.completed\ndata: {"type":"response.completed","response":{"model":"m","usage":{"input_tokens":20,"output_tokens":4,"input_tokens_details":{"cached_tokens":5}}}}\n\n`));
    expect(meter.end().usage).toEqual({ input: 15, output: 4, cacheRead: 5, cacheWrite: 0, reasoning: 0 });
  });
});
