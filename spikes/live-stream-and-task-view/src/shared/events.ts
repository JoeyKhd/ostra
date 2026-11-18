import { z } from "zod";
import {
  ApprovalId,
  ClientMessageId,
  MemberId,
  OptionId,
  QuestionId,
  RunnerId,
  SegmentId,
  TaskId,
  ToolCallId,
  TurnId,
} from "./ids.ts";
import { ToolKind } from "./tools.ts";

// ostra's own event union (ADR 0018, research/agent-ui-stream.md mapping table). The runner,
// the server and the page all import it. It is ostra-owned, so every object rejects unknown fields.
// Vendor-owned formats (ACP) are mapped into it by the runner and tolerate unknown fields there.

export const stopReason = z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);
export type StopReason = z.infer<typeof stopReason>;

export const approvalOptionKind = z.enum(["allow-once", "allow-always", "reject-once", "reject-always"]);

// ADR 0036: the three options a member sees.
export const approvalDecision = z.enum(["allow_once", "allow_task", "deny"]);
export type ApprovalDecision = z.infer<typeof approvalDecision>;

export const approvalOption = z.strictObject({
  optionId: OptionId,
  label: z.string(),
  kind: approvalOptionKind,
  decision: approvalDecision,
});
export type ApprovalOption = z.infer<typeof approvalOption>;

export const planEntry = z.strictObject({
  content: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  status: z.enum(["pending", "in_progress", "completed"]),
});

export const questionField = z.strictObject({
  id: z.string().min(1),
  label: z.string(),
  type: z.enum(["text", "select"]),
  options: z.array(z.string()).optional(),
});
export type QuestionField = z.infer<typeof questionField>;

export const delivery = z.enum(["immediate", "queued", "after-interrupt"]);

export const contentBlock = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("image"), mediaType: z.string(), url: z.string() }),
  z.strictObject({ type: z.literal("resource_link"), uri: z.string(), title: z.string() }),
]);

export const eventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user.message"),
    memberId: MemberId,
    clientMessageId: ClientMessageId,
    text: z.string(),
    delivery,
  }),
  z.strictObject({ kind: z.literal("turn.started"), turnId: TurnId }),
  z.strictObject({ kind: z.literal("turn.ended"), turnId: TurnId, stopReason }),
  z.strictObject({ kind: z.literal("turn.failed"), turnId: TurnId, error: z.string() }),
  z.strictObject({ kind: z.literal("turn.cancel_requested"), memberId: MemberId }),
  z.strictObject({ kind: z.literal("agent.message"), turnId: TurnId, segmentId: SegmentId, text: z.string() }),
  z.strictObject({ kind: z.literal("agent.thought"), turnId: TurnId, segmentId: SegmentId, text: z.string() }),
  z.strictObject({ kind: z.literal("agent.content"), turnId: TurnId, block: contentBlock }),
  z.strictObject({
    kind: z.literal("tool.called"),
    turnId: TurnId,
    toolCallId: ToolCallId,
    toolKind: ToolKind,
    title: z.string(),
    input: z.unknown(),
  }),
  z.strictObject({ kind: z.literal("tool.progress"), toolCallId: ToolCallId, output: z.unknown() }),
  z.strictObject({ kind: z.literal("tool.completed"), toolCallId: ToolCallId, output: z.unknown() }),
  z.strictObject({ kind: z.literal("tool.failed"), toolCallId: ToolCallId, error: z.string() }),
  z.strictObject({
    kind: z.literal("approval.requested"),
    turnId: TurnId,
    approvalId: ApprovalId,
    toolCallId: ToolCallId,
    options: z.array(approvalOption).min(1),
  }),
  z.strictObject({
    kind: z.literal("approval.answered"),
    approvalId: ApprovalId,
    optionId: OptionId,
    decision: approvalDecision,
    memberId: MemberId,
  }),
  z.strictObject({ kind: z.literal("approval.auto_answered"), approvalId: ApprovalId, ruleId: z.string() }),
  z.strictObject({
    kind: z.literal("approval.closed"),
    approvalId: ApprovalId,
    reason: z.enum(["cancelled", "expired"]),
  }),
  z.strictObject({
    kind: z.literal("question.asked"),
    turnId: TurnId,
    questionId: QuestionId,
    message: z.string(),
    fields: z.array(questionField),
  }),
  z.strictObject({
    kind: z.literal("question.answered"),
    questionId: QuestionId,
    answers: z.record(z.string(), z.string()),
    memberId: MemberId,
  }),
  z.strictObject({
    kind: z.literal("question.closed"),
    questionId: QuestionId,
    reason: z.enum(["cancelled", "expired", "declined"]),
  }),
  z.strictObject({ kind: z.literal("plan.updated"), turnId: TurnId, entries: z.array(planEntry) }),
  z.strictObject({
    kind: z.literal("compaction.updated"),
    turnId: TurnId,
    status: z.enum(["running", "done"]),
    summary: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal("session.config_changed"), key: z.string(), value: z.string() }),
  z.strictObject({ kind: z.literal("driver.changed"), memberId: MemberId, byMemberId: MemberId }),
  z.strictObject({ kind: z.literal("runner.connected"), runnerId: RunnerId }),
  z.strictObject({ kind: z.literal("runner.lost"), runnerId: RunnerId }),
  z.strictObject({ kind: z.literal("session.restored") }),
  z.strictObject({ kind: z.literal("session.crashed"), error: z.string() }),
  z.strictObject({ kind: z.literal("pr.opened"), url: z.string(), number: z.number().int() }),
  // ADR 0018: an agent update the mapping has no kind for. The raw payload is capped.
  z.strictObject({ kind: z.literal("agent.unknown"), acpKind: z.string(), raw: z.string().max(4000) }),
]);
export type TaskEvent = z.infer<typeof eventSchema>;
export type TaskEventKind = TaskEvent["kind"];

export const taskEventKinds = eventSchema.options.map((o) => o.shape.kind.value);

// What a reader gets for a stored event whose kind this build does not know (an older panel
// reading a newer server). The fold shows it as a visible "unsupported event" row.
export type UnsupportedEvent = { readonly kind: "unsupported"; readonly rawKind: string };

const unsupportedFromWire = z.looseObject({ kind: z.string() }).transform(
  (raw): UnsupportedEvent => ({ kind: "unsupported", rawKind: raw.kind }),
);

export const readEventSchema = z.union([eventSchema, unsupportedFromWire]);
export type ReadEvent = z.infer<typeof readEventSchema>;

// An event as the server stores it and the panel reads it.
export const storedEventSchema = z.strictObject({
  seq: z.number().int().positive(),
  at: z.number(),
  event: readEventSchema,
});
export type StoredEvent = z.infer<typeof storedEventSchema>;

// Runner -> server (the ostra-owned protocol of ADR 0034, reduced to what this spike needs).
export const runnerEvent = z.strictObject({
  runnerSeq: z.number().int().positive(),
  at: z.number(),
  event: eventSchema,
});
export type RunnerEvent = z.infer<typeof runnerEvent>;

export const liveSegmentKind = z.enum(["message", "thought"]);

// Partial text, at most every 250 ms. Display only: never stored in the log, and nothing acts on it.
export const liveTextFrame = z.strictObject({
  segmentId: SegmentId,
  turnId: TurnId,
  part: liveSegmentKind,
  text: z.string(),
});
export type LiveTextFrame = z.infer<typeof liveTextFrame>;

export const ingestBatch = z.strictObject({
  taskId: TaskId,
  events: z.array(runnerEvent).max(5000),
  live: z.array(liveTextFrame).max(200),
});
export type IngestBatch = z.infer<typeof ingestBatch>;

// One runner connection carries many tasks: a request holds a batch per task (ADR 0034).
export const ingestRequest = z.strictObject({ tasks: z.array(ingestBatch).min(1).max(2000) });
export type IngestRequest = z.infer<typeof ingestRequest>;

export const ingestOutcome = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    accepted: z.number().int(),
    duplicates: z.number().int(),
    headSeq: z.number().int(),
    lastRunnerSeq: z.number().int(),
  }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(["unknown-task", "gap"]), expectedRunnerSeq: z.number().int().optional() }),
]);
export const ingestResponse = z.strictObject({ outcomes: z.array(ingestOutcome) });
export type IngestResponse = z.infer<typeof ingestResponse>;

// Server -> browser, over SSE. Committed events carry `id: <seq>`; live frames carry none, so
// the browser's Last-Event-ID stays on the newest committed event.
export const liveFrame = z.strictObject({
  segmentId: SegmentId,
  turnId: TurnId,
  part: liveSegmentKind,
  // offset 0 is a snapshot that replaces the segment's text; any other offset appends.
  offset: z.number().int().nonnegative(),
  text: z.string(),
});
export type LiveFrame = z.infer<typeof liveFrame>;

// Kinds only the server may write: a runner can never forge a member's message or answer (ADR 0036).
export const serverOnlyKinds: ReadonlySet<TaskEventKind> = new Set<TaskEventKind>([
  "user.message",
  "turn.cancel_requested",
  "approval.answered",
  "question.answered",
  "driver.changed",
]);
