import { z } from "zod";

// Branded IDs (AGENTS.md): never bare strings across a boundary.
const slug = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);

export const RunnerId = slug.brand<"RunnerId">();
export type RunnerId = z.infer<typeof RunnerId>;

export const TaskId = slug.brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;

export const SessionId = slug.brand<"SessionId">();
export type SessionId = z.infer<typeof SessionId>;

export const CommandId = z.uuid().brand<"CommandId">();
export type CommandId = z.infer<typeof CommandId>;

export const ReplicaId = slug.brand<"ReplicaId">();
export type ReplicaId = z.infer<typeof ReplicaId>;
