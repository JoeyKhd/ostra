// Ported from spikes/how-should-the-runner-drive-opencode/src/lib/stub-models/types.ts.
// Shared types of the two stub model servers. A stub turns each model call
// into a `StubRequest`, asks a `StubBrain` what to answer, and writes that
// answer in its own wire format, streamed or not.

import type { ApiFormat } from "@ostra/protocol";

/** The stub speaks one of ostra's two API formats. */
export type StubFormat = ApiFormat;

export type StubToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
};

export type NormalizedMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly text: string;
  readonly toolCalls: readonly StubToolCall[];
  /** Set on `tool` messages: the call this result answers. */
  readonly toolCallId: string | undefined;
  readonly isError: boolean;
};

export type StubRequest = {
  readonly requestId: string;
  readonly format: StubFormat;
  readonly path: string;
  readonly model: string;
  readonly stream: boolean;
  /** OpenAI only: whether `stream_options.include_usage` was set. */
  readonly includeUsage: boolean;
  readonly messages: readonly NormalizedMessage[];
  readonly toolNames: readonly string[];
  /** The raw tool definitions, for recording what the agent offers. */
  readonly tools: readonly unknown[];
  /** Fires when the client goes away mid-response. */
  readonly signal: AbortSignal;
};

export type StubReply = {
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCalls?: readonly { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }[];
  /** Wait before the first byte. */
  readonly delayMs?: number;
  /** While waiting `delayMs` on a stream, send SSE keepalives every 10 s. Default true; false is a silent upstream. */
  readonly keepalive?: boolean;
  /** Wait between streamed chunks, to make a model call last. */
  readonly chunkDelayMs?: number;
  /** Answer with an HTTP error instead. A 429 can carry the `Retry-After` it asks for, in seconds. */
  readonly error?: { readonly status: number; readonly message: string; readonly retryAfterSeconds?: number };
  /**
   * Whether the answer reports token usage. Default true. False is an endpoint that reports none,
   * in a stream or a plain answer, so the key proxy must estimate.
   */
  readonly reportUsage?: boolean;
};

export type StubBrain = (request: StubRequest) => StubReply | Promise<StubReply>;

export type StubUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
};

/** What the stub recorded about one call. Kept in memory for assertions, never logged. */
export type StubCallRecord = {
  readonly requestId: string;
  readonly at: number;
  readonly format: StubFormat;
  readonly path: string;
  readonly model: string;
  readonly authOk: boolean;
  readonly stream: boolean;
  readonly includeUsage: boolean;
  readonly toolNames: readonly string[];
  readonly tools: readonly unknown[];
  readonly messages: readonly NormalizedMessage[];
  /** Milestone 4 (F-137): the request's whole JSON body, so a case can read what the agent sent (`reasoning_effort`, `thinking`, `max_tokens`). */
  readonly body: unknown;
  /** The ground truth the stub billed, whether or not it was reported in the response. */
  readonly billed: StubUsage | undefined;
  /** Whether that usage was written into the response. */
  readonly usageReported: boolean;
  readonly reply: StubReply | undefined;
  readonly aborted: boolean;
};
