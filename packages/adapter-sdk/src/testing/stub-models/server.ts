// Ported from spikes/how-should-the-runner-drive-opencode/src/lib/stub-models/server.ts.
// Two local stub model servers, one per API format ostra supports:
//   - OpenAI-compatible: POST /v1/chat/completions (streaming or not), GET /v1/models
//   - Anthropic-compatible: POST /v1/messages (streaming or not), GET /v1/models
// A `StubBrain` scripts each answer, tool calls included, so an agent does
// real file edits without a real model. Each stub bills a deterministic token
// count per call and keeps that ground truth, so the key proxy's count can be
// checked against it.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { anthropicRequestSchema, normalizeAnthropic, normalizeOpenAi, openAiRequestSchema } from "./normalize.ts";
import type { StubBrain, StubCallRecord, StubFormat, StubOpenCall, StubReply, StubRequest, StubUsage } from "./types.ts";

export type StubServerOptions = {
  readonly format: StubFormat;
  /** The key the stub accepts. The agent never sees it: only the key proxy does. */
  readonly realKey: string;
  /** Model IDs served by GET /v1/models. */
  readonly models: readonly string[];
  readonly brain: StubBrain;
  readonly host?: string;
  readonly port?: number;
  /** Text chunk size when streaming. */
  readonly chunkChars?: number;
};

export type StubServer = {
  readonly format: StubFormat;
  /** Base URL including `/v1`, as an SDK or an agent's provider config expects it. */
  readonly baseUrl: string;
  /** Each call once it has ended, in the order they ended. */
  readonly calls: readonly StubCallRecord[];
  /**
   * The calls that have reached the stub and not ended yet, in arrival order. A turn whose model
   * call is open here is at work: past the agent's own set-up, waiting on its model.
   */
  readonly openCalls: () => readonly StubOpenCall[];
  readonly close: () => Promise<void>;
};

/** The stub's tokenizer: deterministic, about four bytes per token. */
export const stubTokenCount = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 4);

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const bearer = (req: IncomingMessage): string | undefined => {
  const header = req.headers.authorization;
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
};

const headerValue = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const splitText = (text: string, size: number): string[] => {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
};

const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
};

const errorBody = (format: StubFormat, status: number, message: string): unknown =>
  format === "openai-compatible"
    ? { error: { message, type: status === 401 ? "invalid_request_error" : "server_error", code: status } }
    : { type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message } };

const outputText = (reply: StubReply): string =>
  (reply.reasoning ?? "") + (reply.text ?? "") + (reply.toolCalls ?? []).map((call) => call.name + JSON.stringify(call.arguments)).join("");

type Writer = {
  readonly write: (chunk: string) => Promise<boolean>;
};

const makeWriter = (res: ServerResponse, signal: AbortSignal, chunkDelayMs: number): Writer => ({
  write: async (chunk) => {
    if (signal.aborted) return false;
    if (chunkDelayMs > 0) {
      try {
        await sleep(chunkDelayMs, undefined, { signal });
      } catch {
        return false;
      }
    }
    if (res.destroyed) return false;
    res.write(chunk);
    return true;
  },
});

const waitWithKeepalive = async (
  res: ServerResponse,
  delayMs: number,
  signal: AbortSignal,
  keepalive: (() => string) | undefined,
): Promise<boolean> => {
  const until = Date.now() + delayMs;
  while (Date.now() < until) {
    try {
      await sleep(Math.min(10_000, until - Date.now()), undefined, { signal });
    } catch {
      return false;
    }
    if (keepalive !== undefined && Date.now() < until && !res.destroyed) res.write(keepalive());
  }
  return !signal.aborted;
};

const writeOpenAiStream = async (
  res: ServerResponse,
  request: StubRequest,
  reply: StubReply,
  usage: StubUsage,
  chunkChars: number,
): Promise<boolean> => {
  const id = `chatcmpl-${request.requestId}`;
  const created = Math.floor(Date.now() / 1000);
  const frame = (choices: unknown[], extra: Record<string, unknown> = {}): string =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: request.model, choices, ...extra })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  // Headers go out at once, as a real provider sends them: a silent upstream is silent after its headers.
  res.flushHeaders();
  const writer = makeWriter(res, request.signal, reply.chunkDelayMs ?? 0);
  if ((reply.delayMs ?? 0) > 0 && !(await waitWithKeepalive(res, reply.delayMs ?? 0, request.signal, reply.keepalive === false ? undefined : () => ": keepalive\n\n"))) return false;
  if (!(await writer.write(frame([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }])))) return false;
  for (const part of splitText(reply.reasoning ?? "", chunkChars)) {
    if (!(await writer.write(frame([{ index: 0, delta: { reasoning_content: part }, finish_reason: null }])))) return false;
  }
  for (const part of splitText(reply.text ?? "", chunkChars)) {
    if (!(await writer.write(frame([{ index: 0, delta: { content: part }, finish_reason: null }])))) return false;
  }
  const calls = reply.toolCalls ?? [];
  for (const [index, call] of calls.entries()) {
    const callId = `call_${request.requestId.slice(0, 8)}_${String(index)}`;
    const head = { index, id: callId, type: "function", function: { name: call.name, arguments: "" } };
    if (!(await writer.write(frame([{ index: 0, delta: { tool_calls: [head] }, finish_reason: null }])))) return false;
    for (const part of splitText(JSON.stringify(call.arguments), chunkChars)) {
      const delta = { tool_calls: [{ index, function: { arguments: part } }] };
      if (!(await writer.write(frame([{ index: 0, delta, finish_reason: null }])))) return false;
    }
  }
  const finish = calls.length > 0 ? "tool_calls" : "stop";
  if (!(await writer.write(frame([{ index: 0, delta: {}, finish_reason: finish }])))) return false;
  if (request.includeUsage && reply.reportUsage !== false) {
    const usageBody = {
      prompt_tokens: usage.inputTokens + usage.cacheReadTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.cacheReadTokens + usage.outputTokens,
      prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
    };
    if (!(await writer.write(frame([], { usage: usageBody })))) return false;
  }
  if (!(await writer.write("data: [DONE]\n\n"))) return false;
  res.end();
  return true;
};

const openAiJson = (request: StubRequest, reply: StubReply, usage: StubUsage): unknown => {
  const calls = reply.toolCalls ?? [];
  return {
    id: `chatcmpl-${request.requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: reply.text ?? null,
          ...(calls.length > 0
            ? {
                tool_calls: calls.map((call, index) => ({
                  id: `call_${request.requestId.slice(0, 8)}_${String(index)}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : {}),
        },
        finish_reason: calls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    ...(reply.reportUsage === false
      ? {}
      : {
          usage: {
            prompt_tokens: usage.inputTokens + usage.cacheReadTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.cacheReadTokens + usage.outputTokens,
            prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
          },
        }),
  };
};

const writeAnthropicStream = async (
  res: ServerResponse,
  request: StubRequest,
  reply: StubReply,
  usage: StubUsage,
  chunkChars: number,
): Promise<boolean> => {
  const event = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  // Headers go out at once, as a real provider sends them: a silent upstream is silent after its headers.
  res.flushHeaders();
  const writer = makeWriter(res, request.signal, reply.chunkDelayMs ?? 0);
  const startUsage = {
    input_tokens: usage.inputTokens,
    output_tokens: 1,
    cache_read_input_tokens: usage.cacheReadTokens,
    cache_creation_input_tokens: 0,
  };
  const message = {
    id: `msg_${request.requestId}`,
    type: "message",
    role: "assistant",
    model: request.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    ...(reply.reportUsage === false ? {} : { usage: startUsage }),
  };
  if (!(await writer.write(event("message_start", { message })))) return false;
  if ((reply.delayMs ?? 0) > 0 && !(await waitWithKeepalive(res, reply.delayMs ?? 0, request.signal, reply.keepalive === false ? undefined : () => event("ping", {})))) return false;
  let index = 0;
  if (reply.reasoning !== undefined && reply.reasoning !== "") {
    if (!(await writer.write(event("content_block_start", { index, content_block: { type: "thinking", thinking: "" } })))) return false;
    for (const part of splitText(reply.reasoning, chunkChars)) {
      if (!(await writer.write(event("content_block_delta", { index, delta: { type: "thinking_delta", thinking: part } })))) return false;
    }
    if (!(await writer.write(event("content_block_delta", { index, delta: { type: "signature_delta", signature: "stub" } })))) return false;
    if (!(await writer.write(event("content_block_stop", { index })))) return false;
    index += 1;
  }
  if (reply.text !== undefined && reply.text !== "") {
    if (!(await writer.write(event("content_block_start", { index, content_block: { type: "text", text: "" } })))) return false;
    for (const part of splitText(reply.text, chunkChars)) {
      if (!(await writer.write(event("content_block_delta", { index, delta: { type: "text_delta", text: part } })))) return false;
    }
    if (!(await writer.write(event("content_block_stop", { index })))) return false;
    index += 1;
  }
  const calls = reply.toolCalls ?? [];
  for (const [callIndex, call] of calls.entries()) {
    const block = { type: "tool_use", id: `toolu_${request.requestId.slice(0, 8)}_${String(callIndex)}`, name: call.name, input: {} };
    if (!(await writer.write(event("content_block_start", { index, content_block: block })))) return false;
    for (const part of splitText(JSON.stringify(call.arguments), chunkChars)) {
      if (!(await writer.write(event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: part } })))) return false;
    }
    if (!(await writer.write(event("content_block_stop", { index })))) return false;
    index += 1;
  }
  const stopReason = calls.length > 0 ? "tool_use" : "end_turn";
  const deltaUsage = { output_tokens: usage.outputTokens };
  if (!(await writer.write(event("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, ...(reply.reportUsage === false ? {} : { usage: deltaUsage }) })))) return false;
  if (!(await writer.write(event("message_stop", {})))) return false;
  res.end();
  return true;
};

const anthropicJson = (request: StubRequest, reply: StubReply, usage: StubUsage): unknown => {
  const calls = reply.toolCalls ?? [];
  const content: unknown[] = [];
  if (reply.text !== undefined && reply.text !== "") content.push({ type: "text", text: reply.text });
  for (const [index, call] of calls.entries()) {
    content.push({ type: "tool_use", id: `toolu_${request.requestId.slice(0, 8)}_${String(index)}`, name: call.name, input: call.arguments });
  }
  return {
    id: `msg_${request.requestId}`,
    type: "message",
    role: "assistant",
    model: request.model,
    content,
    stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    ...(reply.reportUsage === false
      ? {}
      : {
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_read_input_tokens: usage.cacheReadTokens,
            cache_creation_input_tokens: 0,
          },
        }),
  };
};

const modelList = (format: StubFormat, models: readonly string[]): unknown =>
  format === "openai-compatible"
    ? { object: "list", data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "ostra-stub" })) }
    : {
        data: models.map((id) => ({ type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z" })),
        has_more: false,
        first_id: models[0] ?? null,
        last_id: models.at(-1) ?? null,
      };

export const startStubModelServer = async (options: StubServerOptions): Promise<StubServer> => {
  const calls: StubCallRecord[] = [];
  const open = new Set<StubOpenCall>();
  const chunkChars = options.chunkChars ?? 24;
  const { format } = options;

  const authOk = (req: IncomingMessage): boolean => {
    // Anthropic's API takes `x-api-key` only; the OpenAI-compatible one takes a bearer token.
    const presented = format === "openai-compatible" ? bearer(req) : headerValue(req, "x-api-key");
    return presented === options.realKey;
  };

  const handleModelCall = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const requestId = randomUUID().replaceAll("-", "");
    const raw = await readBody(req);
    const ok = authOk(req);
    const json: unknown = (() => {
      try {
        const parsed: unknown = JSON.parse(raw);
        return parsed;
      } catch {
        return undefined;
      }
    })();
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    const parsed =
      format === "openai-compatible"
        ? (() => {
            const body = openAiRequestSchema.safeParse(json);
            if (!body.success) return undefined;
            return {
              model: body.data.model,
              stream: body.data.stream ?? false,
              includeUsage: body.data.stream_options?.include_usage ?? false,
              messages: normalizeOpenAi(body.data),
              tools: body.data.tools ?? [],
              toolNames: (body.data.tools ?? []).flatMap((tool) => (tool.function ? [tool.function.name] : [])),
            };
          })()
        : (() => {
            const body = anthropicRequestSchema.safeParse(json);
            if (!body.success) return undefined;
            return {
              model: body.data.model,
              stream: body.data.stream ?? false,
              includeUsage: true,
              messages: normalizeAnthropic(body.data),
              tools: body.data.tools ?? [],
              toolNames: (body.data.tools ?? []).map((tool) => tool.name),
            };
          })();

    if (parsed === undefined) {
      sendJson(res, 400, errorBody(format, 400, "stub: request body did not parse"));
      return;
    }

    const request: StubRequest = { requestId, format, path, signal: controller.signal, ...parsed };
    const base = {
      requestId,
      at: Date.now(),
      format,
      path,
      model: request.model,
      authOk: ok,
      stream: request.stream,
      includeUsage: request.includeUsage,
      toolNames: request.toolNames,
      tools: request.tools,
      messages: request.messages,
      body: json,
    };
    // Open from here until the response is done or its connection drops, whichever way it ends.
    open.add(base);
    res.once("close", () => {
      open.delete(base);
    });

    if (!ok) {
      calls.push({ ...base, billed: undefined, usageReported: false, reply: undefined, aborted: false });
      sendJson(res, 401, errorBody(format, 401, "stub: invalid key"));
      return;
    }

    const reply = await options.brain(request);
    if (reply.error !== undefined) {
      calls.push({ ...base, billed: undefined, usageReported: false, reply, aborted: false });
      sendJson(
        res,
        reply.error.status,
        errorBody(format, reply.error.status, reply.error.message),
        reply.error.retryAfterSeconds === undefined ? {} : { "retry-after": String(reply.error.retryAfterSeconds) },
      );
      return;
    }

    const totalIn = stubTokenCount(raw);
    const cacheRead = format === "anthropic-messages" && raw.includes("cache_control") ? Math.floor(totalIn * 0.4) : 0;
    const usage: StubUsage = {
      inputTokens: totalIn - cacheRead,
      cacheReadTokens: cacheRead,
      outputTokens: Math.max(1, stubTokenCount(outputText(reply))),
    };

    let completed = true;
    if (request.stream) {
      completed =
        format === "openai-compatible"
          ? await writeOpenAiStream(res, request, reply, usage, chunkChars)
          : await writeAnthropicStream(res, request, reply, usage, chunkChars);
    } else {
      if ((reply.delayMs ?? 0) > 0) {
        try {
          await sleep(reply.delayMs ?? 0, undefined, { signal: controller.signal });
        } catch {
          completed = false;
        }
      }
      if (completed) sendJson(res, 200, format === "openai-compatible" ? openAiJson(request, reply, usage) : anthropicJson(request, reply, usage));
    }
    if (!completed && !res.destroyed) res.destroy();
    calls.push({
      ...base,
      billed: completed ? usage : undefined,
      usageReported: completed && request.includeUsage && reply.reportUsage !== false,
      reply,
      aborted: !completed,
    });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub.local");
    const path = url.pathname.replace(/\/+$/, "");
    const route = async (): Promise<void> => {
      if (req.method === "GET" && path === "/v1/models") {
        if (!authOk(req)) {
          sendJson(res, 401, errorBody(format, 401, "stub: invalid key"));
          return;
        }
        sendJson(res, 200, modelList(format, options.models));
        return;
      }
      if (req.method === "POST" && format === "openai-compatible" && path === "/v1/chat/completions") {
        await handleModelCall(req, res, path);
        return;
      }
      if (req.method === "POST" && format === "anthropic-messages" && path === "/v1/messages/count_tokens") {
        const raw = await readBody(req);
        sendJson(res, 200, { input_tokens: stubTokenCount(raw) });
        return;
      }
      if (req.method === "POST" && format === "anthropic-messages" && path === "/v1/messages") {
        await handleModelCall(req, res, path);
        return;
      }
      sendJson(res, 404, errorBody(format, 404, `stub: no route ${req.method ?? "?"} ${path}`));
    };
    route().catch(() => {
      if (!res.headersSent) sendJson(res, 500, errorBody(format, 500, "stub: internal error"));
      else res.destroy();
    });
  });

  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : 0;

  return {
    format,
    baseUrl: `http://${options.host ?? "127.0.0.1"}:${String(port)}/v1`,
    calls,
    openCalls: () => [...open],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};

export const startOpenAiStub = async (options: Omit<StubServerOptions, "format">): Promise<StubServer> =>
  startStubModelServer({ ...options, format: "openai-compatible" });

export const startAnthropicStub = async (options: Omit<StubServerOptions, "format">): Promise<StubServer> =>
  startStubModelServer({ ...options, format: "anthropic-messages" });
