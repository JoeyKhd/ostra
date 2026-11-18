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

/** A blob's key in the server's store: `<task>/<name>`, each a safe path segment. */
export const BlobKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine((key) => !key.includes(".."), "no '..' in a blob key")
  .brand<"BlobKey">();
export type BlobKey = z.infer<typeof BlobKeySchema>;
export const blobKey = (value: string): BlobKey => BlobKeySchema.parse(value);

/** A GitHub App's ID, as its settings page shows it. */
export const GitHubAppIdSchema = z.string().regex(/^\d{1,20}$/).brand<"GitHubAppId">();
export type GitHubAppId = z.infer<typeof GitHubAppIdSchema>;

/** One installation of a GitHub App. */
export const InstallationIdSchema = z.string().regex(/^\d{1,20}$/).brand<"InstallationId">();
export type InstallationId = z.infer<typeof InstallationIdSchema>;
