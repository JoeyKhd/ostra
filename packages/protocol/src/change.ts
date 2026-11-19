import { z } from "zod";

// The kinds of record a change notice (ADR 0035) can name. The panel switches on it, so the list is
// one closed union that the producers (domain, api, core), the stream hub and the panel all share.
// A notice carries the kind and an ID, never content. An audit entry's `entity` is a different,
// open string (e.g. `join-token`, `approval`): it is not here.

export const changeEntities = [
  "task",
  "runner",
  "runner-pool",
  "model-provider",
  "model",
  "agent-profile",
  "project",
  "environment",
  "connection",
  "member",
  "organization",
] as const;

export const changeEntitySchema = z.enum(changeEntities);
export type ChangeEntity = z.infer<typeof changeEntitySchema>;
