// Messages between the harness and the child processes it spawns, and the replica's config.
// ostra owns this format, so every schema rejects unknown fields.

import { z } from "zod";
import { jobIdSchema, panelIdSchema, replicaIdSchema, taskIdSchema, taskStateSchema } from "./ids.ts";
import { githubEffectPayload, groupWorkPayload } from "./payloads.ts";

export const workerNameSchema = z.enum(["effect", "effectNaive", "group", "scheduleFire", "transition", "timeout"]);
export type WorkerName = z.infer<typeof workerNameSchema>;

export const replicaConfigSchema = z.strictObject({
  replicaId: replicaIdSchema,
  databaseUrl: z.string().min(1),
  fakeGithubUrl: z.string().min(1),
  workers: z.array(workerNameSchema),
  localConcurrency: z.number().int().min(1),
  groupConcurrency: z.number().int().min(1),
  pollingIntervalSeconds: z.number().min(0.5),
  monitorIntervalSeconds: z.number().int().min(1),
  superviseIntervalSeconds: z.number().int().min(1),
  /** An experiment (C4): the expiry to set on pg-boss's internal forwarding queue. Absent: leave pg-boss's default. */
  forwardingExpireSeconds: z.number().int().min(1).optional(),
  /** The C4 fix: a heartbeat on pg-boss's internal forwarding queue. Absent: pg-boss's default (none). */
  forwardingHeartbeatSeconds: z.number().int().min(10).optional(),
});
/** What a replica trusts after it has parsed its config (IDs branded). */
export type ReplicaConfig = z.output<typeof replicaConfigSchema>;
/** What the harness writes when it builds one (IDs as plain strings: the replica parses them). */
export type ReplicaConfigInput = z.input<typeof replicaConfigSchema>;

export const panelConfigSchema = z.strictObject({
  panelId: panelIdSchema,
  databaseUrl: z.string().min(1),
});
export type PanelConfig = z.output<typeof panelConfigSchema>;

// Replica -> harness.
export const replicaOutSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), replicaId: replicaIdSchema, pid: z.number().int() }),
  z.strictObject({ type: z.literal("stopped"), replicaId: replicaIdSchema }),
  z.strictObject({ type: z.literal("fatal"), replicaId: replicaIdSchema, error: z.string() }),
]);
export type ReplicaOut = z.output<typeof replicaOutSchema>;

// Harness -> replica.
export const replicaInSchema = z.discriminatedUnion("type", [z.strictObject({ type: z.literal("stop") })]);

// Harness -> panel. Every command carries a requestId that the reply echoes.
export const panelCommandSchema = z.discriminatedUnion("type", [
  /** Task row + transition job in one transaction. `commit: false` throws after the enqueue, to roll back. */
  z.strictObject({
    type: z.literal("enqueue-task"),
    requestId: z.string(),
    taskId: taskIdSchema,
    commit: z.boolean(),
    /** false: the control. The job is sent on pg-boss's own pool, not through the transaction. */
    viaTransaction: z.boolean(),
  }),
  /** Same, but the transaction stays open until `settle-open-tx`. */
  z.strictObject({ type: z.literal("open-tx"), requestId: z.string(), taskId: taskIdSchema }),
  z.strictObject({
    type: z.literal("settle-open-tx"),
    requestId: z.string(),
    openRequestId: z.string(),
    decision: z.enum(["commit", "abort"]),
  }),
  /**
   * One transaction: a task row, then the same keyed job sent twice. The reply says what each send
   * returned. `transition` is an exclusive queue (the keyed job is deduplicated); `timeout` is a
   * standard queue (the control: the same key does nothing there).
   */
  z.strictObject({
    type: z.literal("send-twice"),
    requestId: z.string(),
    taskId: taskIdSchema,
    target: z.enum(["transition", "timeout"]),
  }),
  /** The same keyed transition job again, in a new transaction, for a task that already exists. */
  z.strictObject({ type: z.literal("resend-transition"), requestId: z.string(), taskId: taskIdSchema }),
  z.strictObject({
    type: z.literal("enqueue-effects"),
    requestId: z.string(),
    naive: z.boolean(),
    jobs: z.array(githubEffectPayload),
  }),
  z.strictObject({
    type: z.literal("enqueue-group"),
    requestId: z.string(),
    jobs: z.array(groupWorkPayload),
    batchSize: z.number().int().min(1),
  }),
  /** A task row in `taskState`, and a timer job that fires after `startAfterSeconds` and checks `expectState`. */
  z.strictObject({
    type: z.literal("send-timeout"),
    requestId: z.string(),
    taskId: taskIdSchema,
    taskState: taskStateSchema,
    expectState: taskStateSchema,
    startAfterSeconds: z.number().int().min(1),
  }),
  z.strictObject({
    type: z.literal("move-task-on"),
    requestId: z.string(),
    taskId: taskIdSchema,
    newState: taskStateSchema,
  }),
  z.strictObject({
    type: z.literal("cancel-timeout"),
    requestId: z.string(),
    jobId: jobIdSchema,
  }),
  z.strictObject({
    type: z.literal("create-schedules"),
    requestId: z.string(),
    count: z.number().int().min(1),
    /** Every second schedule is "guarded": it also sets a singleton key and a 60 s slot on its jobs. */
    cron: z.string().min(1),
    /** `alternate`: every second schedule is guarded (the default). `all`: every schedule is (the C4 fix). */
    guard: z.enum(["alternate", "all"]).default("alternate"),
  }),
  /** Removes the schedules `create-schedules` made, so a late or replayed fire can be told from a regular one. */
  z.strictObject({
    type: z.literal("remove-schedules"),
    requestId: z.string(),
    count: z.number().int().min(1),
  }),
  z.strictObject({ type: z.literal("report"), requestId: z.string() }),
  z.strictObject({ type: z.literal("stop") }),
]);
export type PanelCommand = z.output<typeof panelCommandSchema>;
/** What the harness sends: the schema's input side, so IDs are plain strings the panel parses. */
export type PanelCommandWire = z.input<typeof panelCommandSchema>;

export const panelReplySchema = z.strictObject({
  type: z.literal("reply"),
  requestId: z.string(),
  ok: z.boolean(),
  /** Error class and code only. A Prisma message can embed the query's arguments, which are ticket content in ostra. */
  error: z.string().optional(),
  jobIds: z.array(jobIdSchema),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type PanelReply = z.output<typeof panelReplySchema>;

export const panelOutSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), panelId: panelIdSchema, pid: z.number().int() }),
  z.strictObject({ type: z.literal("stopped"), panelId: panelIdSchema }),
  z.strictObject({ type: z.literal("fatal"), panelId: panelIdSchema, error: z.string() }),
  panelReplySchema,
]);
export type PanelOut = z.output<typeof panelOutSchema>;
