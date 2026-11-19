// Ported from spikes/how-should-the-runner-drive-opencode/src/lib/usage.ts.
// Token metering for the key proxy. Reads the usage a model endpoint reports,
// in a streamed or a plain JSON response, in both API formats ostra supports:
// OpenAI-compatible (Chat Completions, and Responses) and Anthropic Messages.
// Vendor formats: every schema here tolerates unknown fields.

import { z } from "zod";

import { createSseParser } from "./sse.ts";

/**
 * The wire format of one model call, by its path. ostra's two API formats (`ApiFormat`) are
 * OpenAI-compatible, which has Chat Completions and Responses, and Anthropic Messages.
 */
export type WireFormat = "openai-chat" | "openai-responses" | "anthropic-messages";

export type TokenUsage = {
  /** Input tokens that were neither read from nor written to a cache. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Reasoning tokens, informational: already included in `output`. */
  readonly reasoning: number;
};

export type MeterResult = {
  /** Undefined when the endpoint reported no usage in this response. */
  readonly usage: TokenUsage | undefined;
  readonly responseModel: string | undefined;
  /**
   * The bytes of text the model produced (message, reasoning and tool arguments) as far as the
   * stream shows them, or the whole body's size for a plain answer. It feeds the estimate.
   */
  readonly outputBytes: number;
};

/** Usage as the key proxy records it: what the endpoint said, or an estimate when it said nothing. */
export type MeteredUsage = { readonly usage: TokenUsage; readonly estimated: boolean };

/** About four bytes a token: the rule of thumb the estimate uses, and what the stubs bill by. */
export const BYTES_PER_TOKEN = 4;

/**
 * The usage of one call: the endpoint's own figure, or an estimate from the request's and the
 * answer's sizes, marked `estimated` (F-089: "estimate when usage is missing").
 */
export const resolveUsage = (result: MeterResult, requestBytes: number): MeteredUsage =>
  result.usage === undefined
    ? {
        usage: {
          input: Math.ceil(requestBytes / BYTES_PER_TOKEN),
          output: Math.ceil(result.outputBytes / BYTES_PER_TOKEN),
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
        },
        estimated: true,
      }
    : { usage: result.usage, estimated: false };

export type UsageMeter = {
  readonly push: (chunk: Uint8Array) => void;
  readonly end: () => MeterResult;
};

export const totalTokens = (usage: TokenUsage): number =>
  usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  reasoning: a.reasoning + b.reasoning,
});

export const zeroUsage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

/** Which format a request path speaks, or undefined when it is not a model call. */
export const formatForPath = (pathname: string): WireFormat | undefined => {
  const path = pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) return "openai-chat";
  if (path.endsWith("/responses")) return "openai-responses";
  if (path.endsWith("/messages")) return "anthropic-messages";
  return undefined;
};

const count = z.number().int().nonnegative();

const openAiChatUsage = z.looseObject({
  prompt_tokens: count.optional(),
  completion_tokens: count.optional(),
  prompt_tokens_details: z.looseObject({ cached_tokens: count.nullish() }).nullish(),
  completion_tokens_details: z.looseObject({ reasoning_tokens: count.nullish() }).nullish(),
});

const openAiChatBody = z.looseObject({
  model: z.string().optional(),
  usage: openAiChatUsage.nullish(),
});

const openAiResponsesUsage = z.looseObject({
  input_tokens: count.optional(),
  output_tokens: count.optional(),
  input_tokens_details: z.looseObject({ cached_tokens: count.nullish() }).nullish(),
  output_tokens_details: z.looseObject({ reasoning_tokens: count.nullish() }).nullish(),
});

const openAiResponsesBody = z.looseObject({
  model: z.string().optional(),
  usage: openAiResponsesUsage.nullish(),
});

const openAiResponsesEvent = z.looseObject({
  type: z.string(),
  response: openAiResponsesBody.optional(),
});

const anthropicUsage = z.looseObject({
  input_tokens: count.nullish(),
  output_tokens: count.nullish(),
  cache_read_input_tokens: count.nullish(),
  cache_creation_input_tokens: count.nullish(),
  // F-137: how many of the billed output tokens were thinking. Streamed, it's on the final
  // `message_delta` only (Anthropic, "Extended thinking").
  output_tokens_details: z.looseObject({ thinking_tokens: count.nullish() }).nullish(),
});

const anthropicBody = z.looseObject({
  model: z.string().optional(),
  usage: anthropicUsage.nullish(),
});

const anthropicEvent = z.looseObject({
  type: z.string(),
  message: anthropicBody.optional(),
  usage: anthropicUsage.nullish(),
});

const fromOpenAiChat = (usage: z.infer<typeof openAiChatUsage>): TokenUsage => {
  const prompt = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, prompt - cached),
    output: usage.completion_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
    reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
};

const fromOpenAiResponses = (usage: z.infer<typeof openAiResponsesUsage>): TokenUsage => {
  const input = usage.input_tokens ?? 0;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, input - cached),
    output: usage.output_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
    reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
};

type AnthropicFields = {
  input: number | undefined;
  output: number | undefined;
  cacheRead: number | undefined;
  cacheWrite: number | undefined;
  reasoning: number | undefined;
};

/** Later Anthropic usage objects carry cumulative values: a present field replaces the earlier one. */
const mergeAnthropic = (into: AnthropicFields, usage: z.infer<typeof anthropicUsage>): void => {
  if (usage.input_tokens !== undefined && usage.input_tokens !== null) into.input = usage.input_tokens;
  if (usage.output_tokens !== undefined && usage.output_tokens !== null) into.output = usage.output_tokens;
  if (usage.cache_read_input_tokens !== undefined && usage.cache_read_input_tokens !== null) into.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens !== undefined && usage.cache_creation_input_tokens !== null) into.cacheWrite = usage.cache_creation_input_tokens;
  const thinking = usage.output_tokens_details?.thinking_tokens;
  if (thinking !== undefined && thinking !== null) into.reasoning = thinking;
};

const anthropicToUsage = (fields: AnthropicFields): TokenUsage | undefined => {
  if (fields.input === undefined && fields.output === undefined) return undefined;
  return {
    input: fields.input ?? 0,
    output: fields.output ?? 0,
    cacheRead: fields.cacheRead ?? 0,
    cacheWrite: fields.cacheWrite ?? 0,
    // A part of `output`, as OpenAI's is: never added to it.
    reasoning: fields.reasoning ?? 0,
  };
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const byteLength = (text: string | null | undefined): number => (typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0);

/** The text a streamed event adds, by format: the bytes of its deltas. */
const deltaBytes = (format: WireFormat, json: unknown): number => {
  switch (format) {
    case "openai-chat": {
      const parsed = z
        .looseObject({
          choices: z
            .array(
              z.looseObject({
                delta: z
                  .looseObject({
                    content: z.string().nullish(),
                    reasoning_content: z.string().nullish(),
                    reasoning: z.string().nullish(),
                    tool_calls: z
                      .array(z.looseObject({ function: z.looseObject({ arguments: z.string().nullish() }).nullish() }))
                      .nullish(),
                  })
                  .nullish(),
              }),
            )
            .nullish(),
        })
        .safeParse(json);
      if (!parsed.success) {
        return 0;
      }
      let bytes = 0;
      for (const choice of parsed.data.choices ?? []) {
        const delta = choice.delta;
        bytes += byteLength(delta?.content) + byteLength(delta?.reasoning_content) + byteLength(delta?.reasoning);
        for (const call of delta?.tool_calls ?? []) {
          bytes += byteLength(call.function?.arguments);
        }
      }
      return bytes;
    }
    case "openai-responses": {
      const parsed = z.looseObject({ type: z.string(), delta: z.string().optional() }).safeParse(json);
      return parsed.success && parsed.data.type.endsWith(".delta") ? byteLength(parsed.data.delta) : 0;
    }
    case "anthropic-messages": {
      const parsed = z
        .looseObject({
          type: z.string(),
          delta: z
            .looseObject({
              text: z.string().optional(),
              thinking: z.string().optional(),
              partial_json: z.string().optional(),
            })
            .optional(),
        })
        .safeParse(json);
      return parsed.success && parsed.data.type === "content_block_delta"
        ? byteLength(parsed.data.delta?.text) + byteLength(parsed.data.delta?.thinking) + byteLength(parsed.data.delta?.partial_json)
        : 0;
    }
    default:
      return format satisfies never;
  }
};

export const createUsageMeter = (format: WireFormat, streamed: boolean): UsageMeter => {
  let usage: TokenUsage | undefined;
  let responseModel: string | undefined;
  let outputBytes = 0;
  const anthropic: AnthropicFields = { input: undefined, output: undefined, cacheRead: undefined, cacheWrite: undefined, reasoning: undefined };

  const onData = (data: string): void => {
    if (data === "[DONE]") return;
    const json = parseJson(data);
    if (json === undefined) return;
    if (streamed) outputBytes += deltaBytes(format, json);
    switch (format) {
      case "openai-chat": {
        const parsed = openAiChatBody.safeParse(json);
        if (!parsed.success) return;
        if (parsed.data.model !== undefined) responseModel = parsed.data.model;
        if (parsed.data.usage) usage = fromOpenAiChat(parsed.data.usage);
        return;
      }
      case "openai-responses": {
        if (streamed) {
          const parsed = openAiResponsesEvent.safeParse(json);
          if (!parsed.success) return;
          const response = parsed.data.response;
          if (response?.model !== undefined) responseModel = response.model;
          if (response?.usage) usage = fromOpenAiResponses(response.usage);
        } else {
          const parsed = openAiResponsesBody.safeParse(json);
          if (!parsed.success) return;
          if (parsed.data.model !== undefined) responseModel = parsed.data.model;
          if (parsed.data.usage) usage = fromOpenAiResponses(parsed.data.usage);
        }
        return;
      }
      case "anthropic-messages": {
        if (streamed) {
          const parsed = anthropicEvent.safeParse(json);
          if (!parsed.success) return;
          const message = parsed.data.message;
          if (message?.model !== undefined) responseModel = message.model;
          if (message?.usage) mergeAnthropic(anthropic, message.usage);
          if (parsed.data.usage) mergeAnthropic(anthropic, parsed.data.usage);
        } else {
          const parsed = anthropicBody.safeParse(json);
          if (!parsed.success) return;
          if (parsed.data.model !== undefined) responseModel = parsed.data.model;
          if (parsed.data.usage) mergeAnthropic(anthropic, parsed.data.usage);
        }
        usage = anthropicToUsage(anthropic);
        return;
      }
      default:
        format satisfies never;
    }
  };

  if (streamed) {
    const sse = createSseParser((event) => {
      onData(event.data);
    });
    return {
      push: (chunk) => {
        sse.push(chunk);
      },
      end: () => {
        sse.end();
        return { usage, responseModel, outputBytes };
      },
    };
  }

  const chunks: Uint8Array[] = [];
  return {
    push: (chunk) => {
      chunks.push(chunk);
    },
    end: () => {
      const body = Buffer.concat(chunks);
      onData(body.toString("utf8"));
      // A plain answer: its size stands for the text it holds.
      return { usage, responseModel, outputBytes: body.length };
    },
  };
};
