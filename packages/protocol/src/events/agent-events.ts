import { z } from "zod";

import {
  approvalIdSchema,
  clientMessageIdSchema,
  memberIdSchema,
  modelIdSchema,
  optionIdSchema,
  providerIdSchema,
  questionIdSchema,
  repoIdSchema,
  runnerIdSchema,
  segmentIdSchema,
  sessionIdSchema,
  taskIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "../ids.ts";
import {
  branchNameSchema,
  epochMsSchema,
  gitShaSchema,
  leaseEpochSchema,
  sessionSeqSchema,
  taskSeqSchema,
} from "../common.ts";
import { toolKindSchema } from "./tools.ts";

// ostra's event union (ADR 0018, ADR 0035, ADR 0036): one thing the agent or ostra did in a
// session. The runner, the server and the panel all import it. ostra owns this format, so every
// object refuses unknown fields. Vendor formats (ACP) are mapped into it by the runner, which
// tolerates unknown fields on its side (ticket 09). Ported from
// spikes/live-stream-and-task-view/src/shared/events.ts, with milestone 1's kinds added.

/** Why a turn ended, as ACP reports it. */
export const stopReasonSchema = z.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);
export type StopReason = z.infer<typeof stopReasonSchema>;

/** ACP's kinds of permission option. */
export const approvalOptionKindSchema = z.enum([
  "allow-once",
  "allow-always",
  "reject-once",
  "reject-always",
]);
export type ApprovalOptionKind = z.infer<typeof approvalOptionKindSchema>;

/** The three answers a member sees (ADR 0036, F-026). The agent is always answered "once". */
export const approvalDecisionSchema = z.enum(["allow_once", "allow_task", "deny"]);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const approvalOptionSchema = z.strictObject({
  optionId: optionIdSchema,
  label: z.string().max(500),
  kind: approvalOptionKindSchema,
  decision: approvalDecisionSchema,
});
export type ApprovalOption = z.infer<typeof approvalOptionSchema>;

export const planEntrySchema = z.strictObject({
  content: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type PlanEntry = z.infer<typeof planEntrySchema>;

/** One field of a question the agent asked (ACP `elicitation.form`). */
export const questionFieldSchema = z.strictObject({
  id: z.string().min(1).max(200),
  label: z.string().max(2000),
  type: z.enum(["text", "select"]),
  options: z.array(z.string().max(500)).max(100).optional(),
});
export type QuestionField = z.infer<typeof questionFieldSchema>;

/** How a member's message reached the agent (ADR 0036). */
export const messageDeliverySchema = z.enum(["immediate", "queued", "after-interrupt"]);
export type MessageDelivery = z.infer<typeof messageDeliverySchema>;

/** A block of agent output that isn't text. */
export const contentBlockSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("image"), mediaType: z.string(), url: z.string() }),
  z.strictObject({ type: z.literal("resource_link"), uri: z.string(), title: z.string() }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

/** Whether a session ended with changes to push, which decides PR or needs-you (F-030, F-065). */
export const sessionOutcomeSchema = z.enum(["with-changes", "without-changes"]);
export type SessionOutcome = z.infer<typeof sessionOutcomeSchema>;

const tokenCount = z.number().int().nonnegative();

/** The longest a provider's rate limit holds new dispatches, whatever its `Retry-After` said. */
export const RATE_LIMIT_HOLD_MAX_SECONDS = 3600;
/** The hold when the provider answered with a rate limit but didn't say for how long. */
export const RATE_LIMIT_HOLD_DEFAULT_SECONDS = 30;

/** The largest piece of setup output in one event; longer output is split. */
export const SETUP_OUTPUT_MAX_CHARS = 16_384;

export const taskEventSchema = z.discriminatedUnion("kind", [
  // ---- members and turns ----
  z.strictObject({
    kind: z.literal("user.message"),
    memberId: memberIdSchema,
    clientMessageId: clientMessageIdSchema,
    text: z.string(),
    delivery: messageDeliverySchema,
  }),
  z.strictObject({ kind: z.literal("turn.started"), turnId: turnIdSchema }),
  z.strictObject({ kind: z.literal("turn.ended"), turnId: turnIdSchema, stopReason: stopReasonSchema }),
  z.strictObject({ kind: z.literal("turn.failed"), turnId: turnIdSchema, error: z.string().max(4000) }),
  z.strictObject({ kind: z.literal("turn.cancel_requested"), memberId: memberIdSchema }),

  // ---- the agent's output ----
  z.strictObject({
    kind: z.literal("agent.message"),
    turnId: turnIdSchema,
    segmentId: segmentIdSchema,
    text: z.string(),
  }),
  z.strictObject({
    kind: z.literal("agent.thought"),
    turnId: turnIdSchema,
    segmentId: segmentIdSchema,
    text: z.string(),
  }),
  z.strictObject({ kind: z.literal("agent.content"), turnId: turnIdSchema, block: contentBlockSchema }),

  // ---- tool calls, by ACP's tool kind ----
  z.strictObject({
    kind: z.literal("tool.called"),
    turnId: turnIdSchema,
    toolCallId: toolCallIdSchema,
    toolKind: toolKindSchema,
    title: z.string().max(2000),
    input: z.json(),
  }),
  z.strictObject({ kind: z.literal("tool.progress"), toolCallId: toolCallIdSchema, output: z.json() }),
  z.strictObject({ kind: z.literal("tool.completed"), toolCallId: toolCallIdSchema, output: z.json() }),
  z.strictObject({ kind: z.literal("tool.failed"), toolCallId: toolCallIdSchema, error: z.string().max(4000) }),

  // ---- approvals and questions ----
  z.strictObject({
    kind: z.literal("approval.requested"),
    turnId: turnIdSchema,
    approvalId: approvalIdSchema,
    toolCallId: toolCallIdSchema,
    options: z.array(approvalOptionSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("approval.answered"),
    approvalId: approvalIdSchema,
    optionId: optionIdSchema,
    decision: approvalDecisionSchema,
    memberId: memberIdSchema,
  }),
  z.strictObject({
    kind: z.literal("approval.auto_answered"),
    approvalId: approvalIdSchema,
    ruleId: z.string().min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal("approval.closed"),
    approvalId: approvalIdSchema,
    reason: z.enum(["cancelled", "expired"]),
  }),
  z.strictObject({
    kind: z.literal("question.asked"),
    turnId: turnIdSchema,
    questionId: questionIdSchema,
    message: z.string(),
    fields: z.array(questionFieldSchema),
  }),
  z.strictObject({
    kind: z.literal("question.answered"),
    questionId: questionIdSchema,
    answers: z.record(z.string(), z.string()),
    memberId: memberIdSchema,
  }),
  z.strictObject({
    kind: z.literal("question.closed"),
    questionId: questionIdSchema,
    reason: z.enum(["cancelled", "expired", "declined"]),
  }),

  // ---- the session ----
  z.strictObject({ kind: z.literal("plan.updated"), turnId: turnIdSchema, entries: z.array(planEntrySchema) }),
  z.strictObject({
    kind: z.literal("compaction.updated"),
    turnId: turnIdSchema,
    status: z.enum(["running", "done"]),
    summary: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("session.config_changed"),
    key: z.string().min(1).max(200),
    value: z.string().max(2000),
  }),
  z.strictObject({ kind: z.literal("driver.changed"), memberId: memberIdSchema, byMemberId: memberIdSchema }),
  z.strictObject({ kind: z.literal("runner.connected"), runnerId: runnerIdSchema }),
  z.strictObject({ kind: z.literal("runner.lost"), runnerId: runnerIdSchema }),
  z.strictObject({ kind: z.literal("session.restored") }),
  z.strictObject({ kind: z.literal("session.crashed"), error: z.string().max(4000) }),
  z.strictObject({
    kind: z.literal("pr.opened"),
    repoId: repoIdSchema,
    url: z.url(),
    number: z.number().int().positive(),
  }),
  // ADR 0018: an agent update the mapping has no kind for. The raw payload is capped.
  z.strictObject({ kind: z.literal("agent.unknown"), acpKind: z.string().max(200), raw: z.string().max(4000) }),

  // ---- milestone 1: the environment's setup (F-050) ----
  z.strictObject({ kind: z.literal("environment.setup_started") }),
  z.strictObject({
    kind: z.literal("environment.setup_output"),
    stream: z.enum(["stdout", "stderr"]),
    text: z.string().max(SETUP_OUTPUT_MAX_CHARS),
  }),
  z.strictObject({
    kind: z.literal("environment.setup_finished"),
    /** `null` when the script was killed by a signal or a timeout. */
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
  }),

  // ---- milestone 1: git and the PR (F-030, F-065, F-078) ----
  z.strictObject({
    kind: z.literal("git.pushed"),
    repoId: repoIdSchema,
    branch: branchNameSchema,
    headSha: gitShaSchema,
    /** The full ref pushed: `refs/heads/<branch>` or the hidden `refs/ostra/wip/<taskId>`. */
    ref: z.string().regex(/^refs\/[^\s]+$/, "a full ref"),
  }),
  z.strictObject({
    kind: z.literal("pr.text_set"),
    repoId: repoIdSchema,
    title: z.string().min(1).max(256),
    body: z.string().max(65_536),
  }),
  z.strictObject({
    kind: z.literal("session.ended"),
    outcome: sessionOutcomeSchema,
    /** Per repo of the task: whether its branch is ahead of its base after the final push. */
    repos: z.array(z.strictObject({ repoId: repoIdSchema, ahead: z.boolean() })),
  }),

  // ---- milestone 1: usage (F-089, ADR 0042, ADR 0036) ----
  z.strictObject({
    kind: z.literal("usage.recorded"),
    providerId: providerIdSchema,
    modelId: modelIdSchema,
    inputTokens: tokenCount,
    outputTokens: tokenCount,
    cacheReadTokens: tokenCount,
    cacheWriteTokens: tokenCount,
    /** True when the endpoint reported no usage and the key proxy estimated it. */
    estimated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("provider.rate_limited"),
    /** The key proxy saw the model provider answer with a rate limit (F-088, F-089). */
    providerId: providerIdSchema,
    /** How long the server holds new dispatches on the provider; the runner clamps it. */
    retryAfterSeconds: z.number().int().positive().max(RATE_LIMIT_HOLD_MAX_SECONDS),
  }),
  z.strictObject({
    kind: z.literal("session.usage"),
    /** The agent's own figure for its context window, once per turn: the context meter only. */
    contextUsed: tokenCount,
    contextSize: tokenCount,
  }),
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;
export type TaskEventKind = TaskEvent["kind"];
export type TaskEventOf<K extends TaskEventKind> = Extract<TaskEvent, { kind: K }>;

export const taskEventKinds: readonly TaskEventKind[] = taskEventSchema.options.map(
  (option) => option.shape.kind.value,
);

const knownKinds: ReadonlySet<string> = new Set(taskEventKinds);

/** Whether a string names an event kind this build knows. */
export const isTaskEventKind = (kind: string): kind is TaskEventKind => knownKinds.has(kind);

/**
 * Kinds only the server writes. A runner can never forge a member's message or answer, a runner's
 * connection or a PR (ADR 0036). The gateway refuses a batch that holds one.
 */
export const serverOnlyKinds: ReadonlySet<TaskEventKind> = new Set<TaskEventKind>([
  "user.message",
  "turn.cancel_requested",
  "approval.answered",
  "question.answered",
  "driver.changed",
  "runner.connected",
  "runner.lost",
  "pr.opened",
]);

// ---------- the read side ----------

/**
 * What a reader gets for a stored event whose kind this build doesn't know (an older panel reading
 * a newer server). The fold shows it as a visible "unsupported event" row, never a silent drop.
 */
export type UnsupportedEvent = { readonly kind: "unsupported"; readonly rawKind: string };

const unsupportedEventSchema = z
  .looseObject({
    kind: z.string().refine((kind) => !knownKinds.has(kind), "a known kind must match its schema"),
  })
  .transform((raw): UnsupportedEvent => ({ kind: "unsupported", rawKind: raw.kind }));

/**
 * The read side's event schema. A known kind must match its schema exactly, unknown fields
 * refused. An unknown kind reads as `unsupported`.
 */
export const readEventSchema = z.union([taskEventSchema, unsupportedEventSchema]);
export type ReadEvent = z.infer<typeof readEventSchema>;

/** An event as the server stores it and the panel reads it, with both its numbers (ADR 0035). */
export const storedEventSchema = z.strictObject({
  taskId: taskIdSchema,
  /** The server's number within the task: the browser's cursor. */
  seq: taskSeqSchema,
  sessionId: sessionIdSchema,
  /**
   * The peer's number within the session: what makes saving idempotent. `null` for an event the
   * server wrote itself (the server-only kinds), which no peer numbered.
   */
  sessionSeq: sessionSeqSchema.nullable(),
  /** When the peer recorded it (the server, for its own events), in ms since the epoch. */
  at: epochMsSchema,
  event: readEventSchema,
});
export type StoredEvent = z.infer<typeof storedEventSchema>;

/**
 * An event as a peer sends it up, in an `events` frame (ADR 0034). Server-only kinds are refused
 * here, so the gateway never has to remember to.
 */
export const runnerEventSchema = z.strictObject({
  sessionId: sessionIdSchema,
  sessionSeq: sessionSeqSchema,
  leaseEpoch: leaseEpochSchema,
  /** When the peer recorded it, in ms since the epoch, by the peer's clock. */
  at: epochMsSchema,
  event: taskEventSchema.refine((event) => !serverOnlyKinds.has(event.kind), {
    message: "only the server writes this kind",
  }),
});
export type RunnerEvent = z.infer<typeof runnerEventSchema>;
