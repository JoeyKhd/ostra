import { z } from "zod";

import { callOut } from "./outbound.ts";
import type { OutboundAnswer, OutboundDeps } from "./outbound.ts";

// F-145 (ADR 0069, Q321, ticket 27): the test call to an MCP server's remote, from core: over
// streamable HTTP, `initialize` (which a server on the 2026-07-28 revision may refuse, and then
// isn't needed), `notifications/initialized`, then `tools/list`, with the item's headers, under one
// 10 s deadline. A 401 whose `WWW-Authenticate` names resource metadata is an OAuth challenge:
// ostra doesn't sign in yet, so the server is marked and can't be attached (ticket 28). An answer
// may be JSON or a server-sent stream. The tools' names are the server's text: kept as data, never
// logged, and so is everything else it answers.

/** The whole test call's deadline. */
export const MCP_TEST_DEADLINE_MS = 10_000;
/** The protocol revision ostra asks for, which a server may lower. */
const PROTOCOL_VERSION = "2025-06-18";
const ANSWER_MAX_BYTES = 4 * 1024 * 1024;
const PAGES_MAX = 10;
const TOOLS_MAX = 500;
const TOOL_NAME = /^[A-Za-z0-9_./-]{1,128}$/;

export type McpToolsList =
  | { readonly kind: "tools"; readonly names: readonly string[] }
  /** The server asked for an OAuth sign-in (a 401 naming its resource metadata). */
  | { readonly kind: "oauth" }
  /** The server refused the headers (a 401 or 403 with no OAuth challenge). */
  | { readonly kind: "refused"; readonly status: number }
  | { readonly kind: "unavailable"; readonly reason: "unreachable" | "timeout" | "status"; readonly status: number | null }
  | { readonly kind: "invalid" };

const rpcResponseSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).nullish(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number().optional(), message: z.string().optional() }).optional(),
});

const initializeResultSchema = z.looseObject({ protocolVersion: z.string().min(1).max(64).optional() });

const toolsResultSchema = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })),
  nextCursor: z.string().max(4096).nullish(),
});

const decoder = new TextDecoder();

/** Every message a server-sent stream's text holds so far, from its complete events. */
const streamMessages = (text: string): unknown[] => {
  const messages: unknown[] = [];
  const events = text.split(/\r?\n\r?\n/);
  // The last part has no blank line after it yet: it may be cut.
  for (const event of events.slice(0, -1)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "") continue;
    try {
      const parsed: unknown = JSON.parse(data);
      messages.push(parsed);
    } catch {
      // Not JSON: a keep-alive or a comment.
    }
  }
  return messages;
};

const isStream = (headers: Headers): boolean => (headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");

/** The JSON-RPC response with this ID in an answer, JSON or a stream. */
const responseIn = (answer: OutboundAnswer, id: number): z.infer<typeof rpcResponseSchema> | null => {
  const text = decoder.decode(answer.bytes);
  let messages: unknown[];
  if (isStream(answer.headers)) {
    messages = streamMessages(`${text}\n\n`);
  } else {
    try {
      const parsed: unknown = JSON.parse(text);
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return null;
    }
  }
  for (const message of messages) {
    const parsed = rpcResponseSchema.safeParse(message);
    if (parsed.success && parsed.data.id === id) {
      return parsed.data;
    }
  }
  return null;
};

/** Whether a stream's text so far holds the response with this ID, so the call stops reading it. */
const holds = (id: number) => (bytes: Uint8Array): boolean =>
  streamMessages(decoder.decode(bytes)).some((message) => {
    const parsed = rpcResponseSchema.safeParse(message);
    return parsed.success && parsed.data.id === id;
  });

const challengeOf = (answer: OutboundAnswer): boolean => answer.status === 401 && /resource_metadata\s*=/i.test(answer.headers.get("www-authenticate") ?? "");

/** Lists a remote's tools with its headers. `headers` are the admin's: the server's credentials, never logged. */
export const listMcpTools = async (deps: OutboundDeps, url: string, headers: Readonly<Record<string, string>>, deadlineMs: number = MCP_TEST_DEADLINE_MS): Promise<McpToolsList> => {
  const signal = AbortSignal.timeout(deadlineMs);
  const session: Record<string, string> = {};
  const post = async (message: Readonly<Record<string, unknown>>, id: number | null): Promise<{ readonly ok: true; readonly answer: OutboundAnswer } | { readonly ok: false; readonly result: McpToolsList }> => {
    const called = await callOut(deps, url, {
      method: "POST",
      headers: { ...headers, ...session, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), ...message }),
      maxBytes: ANSWER_MAX_BYTES,
      signal,
      followRedirects: false,
      ...(id === null ? {} : { until: holds(id) }),
    });
    if (!called.ok) {
      return {
        ok: false,
        result: called.failure.kind === "too-large" ? { kind: "invalid" } : { kind: "unavailable", reason: called.failure.reason === "timeout" ? "timeout" : "unreachable", status: null },
      };
    }
    const answer = called.answer;
    if (challengeOf(answer)) {
      return { ok: false, result: { kind: "oauth" } };
    }
    if (answer.status === 401 || answer.status === 403) {
      return { ok: false, result: { kind: "refused", status: answer.status } };
    }
    return { ok: true, answer };
  };

  // `initialize`: a server that doesn't take it (the 2026-07-28 revision dropped it) answers an error, and the list goes on without it.
  const initialized = await post({ method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "ostra", version: deps.serverVersion } } }, 1);
  if (!initialized.ok) {
    return initialized.result;
  }
  const initAnswer = initialized.answer;
  const initResponse = initAnswer.status >= 200 && initAnswer.status < 300 ? responseIn(initAnswer, 1) : null;
  if (initResponse?.result !== undefined && initResponse.error === undefined) {
    const sessionId = initAnswer.headers.get("mcp-session-id");
    if (sessionId !== null && /^[!-~]{1,256}$/.test(sessionId)) {
      session["mcp-session-id"] = sessionId;
    }
    const result = initializeResultSchema.safeParse(initResponse.result);
    session["mcp-protocol-version"] = result.success && result.data.protocolVersion !== undefined && /^[\w.-]+$/.test(result.data.protocolVersion) ? result.data.protocolVersion : PROTOCOL_VERSION;
    const notified = await post({ method: "notifications/initialized" }, null);
    if (!notified.ok) {
      return notified.result;
    }
  }

  const names: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PAGES_MAX; page += 1) {
    const id = 2 + page;
    const listed = await post({ method: "tools/list", ...(cursor === null ? {} : { params: { cursor } }) }, id);
    if (!listed.ok) {
      return listed.result;
    }
    if (listed.answer.status < 200 || listed.answer.status >= 300) {
      return { kind: "unavailable", reason: "status", status: listed.answer.status };
    }
    const response = responseIn(listed.answer, id);
    const tools = toolsResultSchema.safeParse(response?.result);
    if (!tools.success) {
      return { kind: "invalid" };
    }
    for (const tool of tools.data.tools) {
      if (TOOL_NAME.test(tool.name) && !names.includes(tool.name) && names.length < TOOLS_MAX) names.push(tool.name);
    }
    cursor = tools.data.nextCursor ?? null;
    if (cursor === null) {
      break;
    }
  }
  return { kind: "tools", names };
};
