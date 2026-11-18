// The payload of every job, written once and imported by both the job catalog (job-defs.ts) and the
// harness messages (messages.ts). This file imports nothing from pg-boss.
// Jobs carry only IDs and short values (ADR 0037, rule 2).

import { z } from "zod";
import { boardIdSchema, effectKeySchema, groupKeySchema, taskIdSchema, taskStateSchema, taskTransitionSchema } from "./ids.ts";

export const taskTransitionPayload = z.strictObject({
  taskId: taskIdSchema,
  transition: taskTransitionSchema,
  seq: z.number().int().nonnegative(),
});

export const taskTimeoutPayload = z.strictObject({
  taskId: taskIdSchema,
  expectState: taskStateSchema,
});

/**
 * A side effect on the code host (a pull request, found again by its branch). The hold fields are
 * the harness's knobs for the kill scenarios (C2): how long the handler keeps working after the
 * effect landed, and how long the fake GitHub holds the request before it counts it or after.
 */
export const githubEffectPayload = z.strictObject({
  key: effectKeySchema,
  holdMs: z.number().int().nonnegative(),
  beforeCountHoldMs: z.number().int().nonnegative().default(0),
  afterCountHoldMs: z.number().int().nonnegative().default(0),
});

export const groupWorkPayload = z.strictObject({
  key: groupKeySchema,
  workMs: z.number().int().nonnegative(),
});

export const scheduleFirePayload = z.strictObject({
  board: boardIdSchema,
  variant: z.enum(["plain", "guarded"]),
});
