// Ported from spikes/how-should-the-runner-drive-opencode/src/lib/stub-models/normalize.ts.
// Turns an incoming OpenAI-compatible or Anthropic Messages request body into
// the stub's normalized conversation. Vendor formats: schemas are loose.

import { z } from "zod";
import type { NormalizedMessage, StubToolCall } from "./types.ts";

const textPart = z.looseObject({ type: z.string(), text: z.string().optional() });

const openAiContent = z.union([z.string(), z.array(textPart), z.null()]).optional();

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
  content: z.union([z.string(), z.array(textPart)]).optional(),
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
    return {
      role: toRole(message.role),
      text: joinText(message.content),
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
    out.push({ role: "system", text, toolCalls: [], toolCallId: undefined, isError: false });
  }
  for (const message of body.messages) {
    if (typeof message.content === "string") {
      out.push({ role: toRole(message.role), text: message.content, toolCalls: [], toolCallId: undefined, isError: false });
      continue;
    }
    let text = "";
    const toolCalls: StubToolCall[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          text += block.text ?? "";
          break;
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
    if (text !== "" || toolCalls.length > 0) {
      out.push({ role: toRole(message.role), text, toolCalls, toolCallId: undefined, isError: false });
    }
  }
  return out;
};
