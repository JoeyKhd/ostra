import { z } from "zod";

// Branded IDs (AGENTS.md: never bare strings). Each is parsed once, where it
// enters: a task ID where the runner makes it, a session ID where the agent
// returns it, an RPC ID where a request arrives.
export const TaskIdSchema = z.string().min(1).brand<"TaskId">();
export type TaskId = z.infer<typeof TaskIdSchema>;
export const taskId = (value: string): TaskId => TaskIdSchema.parse(value);

/** An agent's session, as the agent names it (ACP `sessionId`). */
export const SessionIdSchema = z.string().min(1).brand<"SessionId">();
export type SessionId = z.infer<typeof SessionIdSchema>;
export const sessionId = (value: string): SessionId => SessionIdSchema.parse(value);

/** A JSON-RPC request ID the agent sent, as text. */
export const RpcIdSchema = z.string().min(1).brand<"RpcId">();
export type RpcId = z.infer<typeof RpcIdSchema>;
export const rpcId = (value: string | number): RpcId => RpcIdSchema.parse(String(value));

/** One call through the key proxy. */
export const ProxyCallIdSchema = z.string().min(1).brand<"ProxyCallId">();
export type ProxyCallId = z.infer<typeof ProxyCallIdSchema>;
export const proxyCallId = (value: string): ProxyCallId => ProxyCallIdSchema.parse(value);
