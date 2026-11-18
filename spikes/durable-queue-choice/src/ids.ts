// One branded type per ID, never a bare string (AGENTS.md, Code). Each schema is written once and
// every side imports it: the job definitions, the harness messages and the handlers.
//
// A brand exists only in the type system: at run time these are the strings they validate. A value
// becomes a TaskId by being parsed at a boundary, so a JobId cannot be passed where a TaskId is wanted.

import { z } from "zod";

export const taskIdSchema = z.string().min(1).brand<"TaskId">();
export type TaskId = z.output<typeof taskIdSchema>;

/** The id pg-boss gives a job (a uuid). */
export const jobIdSchema = z.string().min(1).brand<"JobId">();
export type JobId = z.output<typeof jobIdSchema>;

/** A core service replica: one process that works queues. */
export const replicaIdSchema = z.string().min(1).brand<"ReplicaId">();
export type ReplicaId = z.output<typeof replicaIdSchema>;

/** A panel process: a producer that never works. */
export const panelIdSchema = z.string().min(1).brand<"PanelId">();
export type PanelId = z.output<typeof panelIdSchema>;

/** The key a per-group limit counts by. */
export const groupKeySchema = z.string().min(1).brand<"GroupKey">();
export type GroupKey = z.output<typeof groupKeySchema>;

/** One connected board: the owner of a runtime schedule. */
export const boardIdSchema = z.string().min(1).brand<"BoardId">();
export type BoardId = z.output<typeof boardIdSchema>;

/** The key an outgoing code-host effect is filed under (its idempotency key and its branch name). */
export const effectKeySchema = z.string().min(1).brand<"EffectKey">();
export type EffectKey = z.output<typeof effectKeySchema>;

/** The states the spike's stand-in task row moves through. A union, not a free string. */
export const taskStateSchema = z.enum(["queued", "prepared", "timed-out", "done"]);
export type TaskState = z.output<typeof taskStateSchema>;

/** What a task transition job does. One literal today; the job key is built from it. */
export const taskTransitionSchema = z.enum(["prepare"]);
export type TaskTransition = z.output<typeof taskTransitionSchema>;

/**
 * The fixed key of a task-transition job (ADR 0037, rule 2): what it does, to which task, and
 * which time around. Sending the same key twice must not make a second job.
 */
export const transitionJobKey = (taskId: TaskId, transition: TaskTransition, seq: number): string =>
  `task:${taskId}:${transition}:${String(seq)}`;
