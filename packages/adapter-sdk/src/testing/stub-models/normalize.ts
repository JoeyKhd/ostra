// Ported from spikes/how-should-the-runner-drive-opencode/src/lib/stub-models/normalize.ts.
// Turns an incoming OpenAI-compatible or Anthropic Messages request body into
// the stub's normalized conversation. Vendor formats: schemas are loose.

import { z } from "zod";
import type { NormalizedMessage, StubImage, StubToolCall } from "./types.ts";

const textPart = z.looseObject({ type: z.string(), text: z.string().optional() });

/** Milestone 9: OpenAI's image part, `{ type: "image_url", image_url: { url: "data:<type>;base64,<data>" } }`. */
const openAiPart = textPart.extend({ image_url: z.looseObject({ url: z.string() }).optional() });

const openAiContent = z.union([z.string(), z.array(openAiPart), z.null()]).optional();

/** Milestone 9: an Anthropic `image` block's source. */
const anthropicImageSource = z.looseObject({ type: z.string(), media_type: z.string().optional(), data: z.string().optional() });
const anthropicContentPart = textPart.extend({ source: anthropicImageSource.optional() });

const DATA_URL = /^data:([^;,]{1,100});base64,(.*)$/s;

/** An OpenAI image part's data URL as a stub image; another URL (a link) isn't one. */
const openAiImageOf = (part: z.infer<typeof openAiPart>): StubImage | null => {
  if (part.type !== "image_url" || part.image_url === undefined) return null;
  const match = DATA_URL.exec(part.image_url.url);
  return match === null ? null : { mimeType: match[1] ?? "", base64: match[2] ?? "" };
};

/** An Anthropic `image` block's base64 source as a stub image. */
const anthropicImageOf = (part: { readonly type: string; readonly source?: z.infer<typeof anthropicImageSource> | undefined }): StubImage | null =>
  part.type === "image" && part.source?.type === "base64" && part.source.data !== undefined ? { mimeType: part.source.media_type ?? "", base64: part.source.data } : null;

const present = <T>(values: readonly (T | null)[]): T[] => values.flatMap((value) => (value === null ? [] : [value]));

const openAiMessage = z.looseObject({
  role: z.string(),
  content: openAiContent,
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(
      z.looseObject({
        id: z.string(),
        function: z.looseObject({ name: z.string(), arguments: z.string().optional() }),
      }),
    )
    .nullish(),
});

export const openAiRequestSchema = z.looseObject({
  model: z.string(),
  stream: z.boolean().optional(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).nullish(),
  messages: z.array(openAiMessage),
  tools: z.array(z.looseObject({ function: z.looseObject({ name: z.string() }).optional() })).optional(),
});

const anthropicBlock = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  content: z.union([z.string(), z.array(anthropicContentPart)]).optional(),
  source: anthropicImageSource.optional(),
});

export const anthropicRequestSchema = z.looseObject({
  model: z.string(),
  stream: z.boolean().optional(),
  system: z.union([z.string(), z.array(textPart)]).optional(),
  messages: z.array(
    z.looseObject({
      role: z.string(),
      content: z.union([z.string(), z.array(anthropicBlock)]),
    }),
  ),
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
});

const record = z.record(z.string(), z.unknown());

const parseArguments = (raw: string | undefined): Record<string, unknown> => {
  if (raw === undefined || raw === "") return {};
  try {
    const parsed = record.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
};

const joinText = (content: z.infer<typeof openAiContent>): string => {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  return content.map((part) => part.text ?? "").join("");
};

const toRole = (role: string): NormalizedMessage["role"] => {
  switch (role) {
    case "system":
    case "developer":
      return "system";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    default:
      return "user";
  }
};

export const normalizeOpenAi = (body: z.infer<typeof openAiRequestSchema>): NormalizedMessage[] =>
  body.messages.map((message) => {
    const toolCalls: StubToolCall[] = (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: parseArguments(call.function.arguments),
    }));
    const { content } = message;
    return {
      role: toRole(message.role),
      text: joinText(content),
      images: content === undefined || content === null || typeof content === "string" ? [] : present(content.map(openAiImageOf)),
      toolCalls,
      toolCallId: message.tool_call_id,
      isError: false,
    };
  });

const recordOf = (value: unknown): Record<string, unknown> => {
  const parsed = record.safeParse(value);
  return parsed.success ? parsed.data : {};
};

export const normalizeAnthropic = (body: z.infer<typeof anthropicRequestSchema>): NormalizedMessage[] => {
  const out: NormalizedMessage[] = [];
  if (body.system !== undefined) {
    const text = typeof body.system === "string" ? body.system : body.system.map((part) => part.text ?? "").join("");
    out.push({ role: "system", text, images: [], toolCalls: [], toolCallId: undefined, isError: false });
  }
  for (const message of body.messages) {
    if (typeof message.content === "string") {
      out.push({ role: toRole(message.role), text: message.content, images: [], toolCalls: [], toolCallId: undefined, isError: false });
      continue;
    }
    let text = "";
    const images: StubImage[] = [];
    const toolCalls: StubToolCall[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          text += block.text ?? "";
          break;
        case "image": {
          const image = anthropicImageOf(block);
          if (image !== null) images.push(image);
          break;
        }
        case "tool_use":
          toolCalls.push({ id: block.id ?? "", name: block.name ?? "", arguments: recordOf(block.input) });
          break;
        case "tool_result": {
          const content = block.content;
          const resultText =
            content === undefined ? "" : typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
          out.push({
            role: "tool",
            text: resultText,
            images: content === undefined || typeof content === "string" ? [] : present(content.map(anthropicImageOf)),
            toolCalls: [],
            toolCallId: block.tool_use_id,
            isError: block.is_error ?? false,
          });
          break;
        }
        default:
          break;
      }
    }
    if (text !== "" || toolCalls.length > 0 || images.length > 0) {
      out.push({ role: toRole(message.role), text, images, toolCalls, toolCallId: undefined, isError: false });
    }
  }
  return out;
};
