import type { UIToolInvocation } from "ai";
import type { z } from "zod";
import type { ApprovalOption, QuestionField, StopReason, StoredEvent, TaskEvent } from "./events.ts";
import type { ApprovalId, ClientMessageId, MemberId, QuestionId, SegmentId, ToolCallId, TurnId } from "./ids.ts";
import { toolSchemas, type ToolKind } from "./tools.ts";
import type {
  ApprovalDescriptor,
  ApprovalReceipt,
  ApprovalStatus,
  QuestionStatus,
  TaskMessageMeta,
  TaskUIMessage,
  TaskUIPart,
} from "./ui-types.ts";

// The one fold from events to UIMessage[] (ADR 0036). Pure. The page, the server's tests and any
// later consumer (PR summaries, `ostra attach`) run the same function. A stored session and a
// live one go through the same code. Unchanged messages keep their object identity.

export type LiveText = {
  readonly segmentId: SegmentId;
  readonly turnId: TurnId;
  readonly part: "message" | "thought";
  readonly text: string;
};

export type OptimisticMessage = {
  readonly clientMessageId: ClientMessageId;
  readonly memberId: MemberId;
  readonly text: string;
  readonly delivery: "immediate" | "queued" | "after-interrupt";
};

export type FoldOptions = {
  // The driver's own sends, shown at once and replaced by the committed message (same id).
  readonly optimistic?: readonly OptimisticMessage[];
  // The previous result, for identity reuse.
  readonly previous?: readonly TaskUIMessage[];
};

type ApprovalRecord = {
  approvalId: ApprovalId;
  options: ApprovalOption[];
  status: ApprovalStatus;
};

type ToolRecord = {
  toolCallId: ToolCallId;
  kind: ToolKind;
  title: string;
  input: unknown;
  progress?: { value: unknown };
  outcome?: { type: "done"; output: unknown } | { type: "failed"; error: string };
  cancelled: boolean;
  approval?: ApprovalRecord;
};

type QuestionRecord = { questionId: QuestionId; message: string; fields: QuestionField[]; status: QuestionStatus };
type PlanEntries = Extract<TaskEvent, { kind: "plan.updated" }>["entries"];

type Slot =
  | { t: "part"; part: TaskUIPart }
  | { t: "tool"; rec: ToolRecord }
  | { t: "question"; rec: QuestionRecord }
  | { t: "plan"; id: string; entries: PlanEntries }
  | { t: "compaction"; id: string; status: "running" | "done"; summary?: string };

type Builder = {
  id: string;
  role: "user" | "assistant" | "system";
  slots: Slot[];
  meta: TaskMessageMeta;
  planSlot?: Extract<Slot, { t: "plan" }>;
  compactionSlot?: Extract<Slot, { t: "compaction" }>;
};

// ---- tool parts -------------------------------------------------------------------------

type OutputParse<O> = { ok: true; value: O } | { ok: false };

const approvalOf = (rec: ToolRecord): ApprovalRecord | undefined => rec.approval;

const receiptOf = (approval: ApprovalRecord): ApprovalReceipt | undefined =>
  approval.status.state === "pending" ? undefined : approval.status;

const descriptorOf = (approval: ApprovalRecord): ApprovalDescriptor => {
  const receipt = receiptOf(approval);
  return { options: approval.options, ...(receipt === undefined ? {} : { receipt }) };
};

// One state machine for every kind. `I` and `O` are the kind's normalized input and output.
const buildInvocation = <I, O>(
  rec: ToolRecord,
  input: I,
  parseOutput: (raw: unknown) => OutputParse<O>,
): UIToolInvocation<{ input: I; output: O }> => {
  const approval = approvalOf(rec);
  // The approval's options and receipt also ride in `toolMetadata`, so a request that closed without
  // a decision (the AI SDK's types only allow `approved: true` after the call ran) still shows its receipt.
  const base = {
    toolCallId: rec.toolCallId,
    title: rec.title,
    ...(approval === undefined ? {} : { toolMetadata: { approval: { id: approval.approvalId, descriptor: descriptorOf(approval) } } }),
  };
  const status = approval?.status;
  const approved =
    approval !== undefined &&
    status !== undefined &&
    (status.state === "auto" || (status.state === "answered" && status.decision !== "deny"));
  const approvedTrue = approved ? { id: approval.approvalId, approved: true as const, descriptor: descriptorOf(approval) } : undefined;

  if (rec.outcome?.type === "failed") {
    return {
      ...base,
      state: "output-error",
      input,
      errorText: rec.outcome.error,
      ...(approvedTrue === undefined ? {} : { approval: approvedTrue }),
    };
  }
  if (rec.cancelled) {
    return { ...base, state: "output-error", input, errorText: "cancelled" };
  }
  if (approval !== undefined && status?.state === "answered" && status.decision === "deny") {
    return {
      ...base,
      state: "output-denied",
      input,
      approval: { id: approval.approvalId, approved: false, descriptor: descriptorOf(approval) },
    };
  }
  if (status?.state === "closed" && rec.outcome === undefined) {
    return {
      ...base,
      state: "output-error",
      input,
      errorText: `approval ${status.reason}`,
    };
  }
  if (rec.outcome?.type === "done") {
    const parsed = parseOutput(rec.outcome.output);
    if (!parsed.ok) {
      return { ...base, state: "output-error", input, errorText: "invalid tool output" };
    }
    return {
      ...base,
      state: "output-available",
      input,
      output: parsed.value,
      ...(approvedTrue === undefined ? {} : { approval: approvedTrue }),
    };
  }
  if (rec.progress !== undefined) {
    const parsed = parseOutput(rec.progress.value);
    if (!parsed.ok) {
      return { ...base, state: "output-error", input, errorText: "invalid tool progress" };
    }
    return {
      ...base,
      state: "output-available",
      input,
      output: parsed.value,
      preliminary: true,
      ...(approvedTrue === undefined ? {} : { approval: approvedTrue }),
    };
  }
  if (approval !== undefined && status?.state === "pending") {
    return {
      ...base,
      state: "approval-requested",
      input,
      approval: { id: approval.approvalId, descriptor: descriptorOf(approval) },
    };
  }
  if (approval !== undefined && approved) {
    return {
      ...base,
      state: "approval-responded",
      input,
      approval: {
        id: approval.approvalId,
        approved: true,
        descriptor: descriptorOf(approval),
        ...(status.state === "auto" ? { isAutomatic: true } : {}),
      },
    };
  }
  return { ...base, state: "input-available", input };
};

const parseWith =
  <S extends z.ZodType>(schema: S) =>
  (raw: unknown): OutputParse<z.infer<S>> => {
    const result = schema.safeParse(raw);
    return result.success ? { ok: true, value: result.data } : { ok: false };
  };

const passThrough = (raw: unknown): OutputParse<unknown> => ({ ok: true, value: raw });

const dynamicPart = (rec: ToolRecord): TaskUIPart => {
  const inv = buildInvocation(rec, rec.input, passThrough);
  return { type: "dynamic-tool", toolName: rec.kind, ...inv };
};

const toolPart = (rec: ToolRecord): TaskUIPart => {
  switch (rec.kind) {
    case "read": {
      const input = toolSchemas.read.input.safeParse(rec.input);
      if (!input.success) return dynamicPart(rec);
      return { type: "tool-read", ...buildInvocation(rec, input.data, parseWith(toolSchemas.read.output)) };
    }
    case "edit": {
      const input = toolSchemas.edit.input.safeParse(rec.input);
      if (!input.success) return dynamicPart(rec);
      return { type: "tool-edit", ...buildInvocation(rec, input.data, parseWith(toolSchemas.edit.output)) };
    }
    case "execute": {
      const input = toolSchemas.execute.input.safeParse(rec.input);
      if (!input.success) return dynamicPart(rec);
      return {
        type: "tool-execute",
        ...buildInvocation(rec, input.data, parseWith(toolSchemas.execute.output)),
      };
    }
    case "delete":
    case "move":
    case "search":
    case "fetch":
    case "think":
    case "switch_mode":
    case "other":
      return dynamicPart(rec);
    default:
      return rec.kind satisfies never;
  }
};

// ---- the fold ---------------------------------------------------------------------------

const questionPart = (rec: QuestionRecord): TaskUIPart => ({
  type: "data-question",
  id: rec.questionId,
  data: { questionId: rec.questionId, message: rec.message, fields: rec.fields, status: rec.status },
});

const slotToPart = (slot: Slot): TaskUIPart => {
  switch (slot.t) {
    case "part":
      return slot.part;
    case "tool":
      return toolPart(slot.rec);
    case "question":
      return questionPart(slot.rec);
    case "plan":
      return { type: "data-plan", id: slot.id, data: { entries: slot.entries } };
    case "compaction":
      return {
        type: "data-compaction",
        id: slot.id,
        data: { status: slot.status, ...(slot.summary === undefined ? {} : { summary: slot.summary }) },
      };
    default:
      return slot satisfies never;
  }
};

export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item: unknown, i) => deepEqual(item, b[i]));
  }
  if (Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => key in b && deepEqual(Reflect.get(a, key), Reflect.get(b, key)));
};

export const foldTaskEvents = (
  events: readonly StoredEvent[],
  liveText: readonly LiveText[],
  options: FoldOptions = {},
): TaskUIMessage[] => {
  const builders: Builder[] = [];
  const turns = new Map<TurnId, Builder>();
  const tools = new Map<ToolCallId, ToolRecord>();
  const approvals = new Map<ApprovalId, ToolRecord>();
  const questions = new Map<QuestionId, QuestionRecord>();
  const committedSegments = new Set<SegmentId>();
  const committedClientIds = new Set<ClientMessageId>();

  const push = (builder: Builder): Builder => {
    builders.push(builder);
    return builder;
  };

  const system = (seq: number, part: TaskUIPart): void => {
    push({
      id: `sys:${String(seq)}`,
      role: "system",
      slots: [{ t: "part", part }],
      meta: { firstSeq: seq, lastSeq: seq },
    });
  };

  const problem = (seq: number, text: string): void => {
    system(seq, { type: "data-problem", id: `problem:${String(seq)}`, data: { seq, text } });
  };

  const ensureTurn = (turnId: TurnId, seq: number): Builder => {
    const existing = turns.get(turnId);
    if (existing !== undefined) {
      existing.meta.lastSeq = seq;
      return existing;
    }
    const builder = push({
      id: `turn:${turnId}`,
      role: "assistant",
      slots: [{ t: "part", part: { type: "step-start" } }],
      meta: { firstSeq: seq, lastSeq: seq, turnId, turnState: "running" },
    });
    turns.set(turnId, builder);
    return builder;
  };

  const text = (value: string, state: "streaming" | "done"): TaskUIPart => ({ type: "text", text: value, state });
  const reasoning = (value: string, state: "streaming" | "done"): TaskUIPart => ({
    type: "reasoning",
    text: value,
    state,
  });

  for (const stored of events) {
    const { seq, event } = stored;
    switch (event.kind) {
      case "user.message": {
        committedClientIds.add(event.clientMessageId);
        push({
          id: `user:${event.clientMessageId}`,
          role: "user",
          slots: [{ t: "part", part: text(event.text, "done") }],
          meta: {
            firstSeq: seq,
            lastSeq: seq,
            author: { memberId: event.memberId, delivery: event.delivery },
          },
        });
        break;
      }
      case "turn.started": {
        ensureTurn(event.turnId, seq).meta.turnState = "running";
        break;
      }
      case "turn.ended": {
        const turn = ensureTurn(event.turnId, seq);
        turn.meta.turnState = "ended";
        turn.meta.stopReason = event.stopReason satisfies StopReason;
        if (event.stopReason === "cancelled") {
          for (const slot of turn.slots) {
            if (slot.t === "tool" && slot.rec.outcome === undefined) {
              slot.rec.cancelled = true;
              if (slot.rec.approval?.status.state === "pending") {
                slot.rec.approval.status = { state: "closed", reason: "cancelled" };
              }
            }
          }
        }
        break;
      }
      case "turn.failed": {
        const turn = ensureTurn(event.turnId, seq);
        turn.meta.turnState = "failed";
        turn.meta.error = event.error;
        break;
      }
      case "agent.message": {
        committedSegments.add(event.segmentId);
        ensureTurn(event.turnId, seq).slots.push({ t: "part", part: text(event.text, "done") });
        break;
      }
      case "agent.thought": {
        committedSegments.add(event.segmentId);
        ensureTurn(event.turnId, seq).slots.push({ t: "part", part: reasoning(event.text, "done") });
        break;
      }
      case "agent.content": {
        const turn = ensureTurn(event.turnId, seq);
        const block = event.block;
        switch (block.type) {
          case "image":
            turn.slots.push({ t: "part", part: { type: "file", mediaType: block.mediaType, url: block.url } });
            break;
          case "resource_link":
            turn.slots.push({
              t: "part",
              part: { type: "source-url", sourceId: `link:${String(seq)}`, url: block.uri, title: block.title },
            });
            break;
          default:
            block satisfies never;
        }
        break;
      }
      case "tool.called": {
        const turn = ensureTurn(event.turnId, seq);
        if (tools.has(event.toolCallId)) {
          problem(seq, `duplicate tool call ${event.toolCallId}`);
          break;
        }
        const rec: ToolRecord = {
          toolCallId: event.toolCallId,
          kind: event.toolKind,
          title: event.title,
          input: event.input,
          cancelled: false,
        };
        tools.set(event.toolCallId, rec);
        turn.slots.push({ t: "tool", rec });
        break;
      }
      case "tool.progress":
      case "tool.completed":
      case "tool.failed": {
        const rec = tools.get(event.toolCallId);
        if (rec === undefined) {
          problem(seq, `${event.kind} for unknown tool call ${event.toolCallId}`);
          break;
        }
        for (const turn of turns.values()) {
          if (turn.slots.some((s) => s.t === "tool" && s.rec === rec)) turn.meta.lastSeq = seq;
        }
        if (event.kind === "tool.progress") rec.progress = { value: event.output };
        else if (event.kind === "tool.completed") rec.outcome = { type: "done", output: event.output };
        else rec.outcome = { type: "failed", error: event.error };
        break;
      }
      case "approval.requested": {
        ensureTurn(event.turnId, seq);
        const rec = tools.get(event.toolCallId);
        if (rec === undefined) {
          problem(seq, `approval for unknown tool call ${event.toolCallId}`);
          break;
        }
        rec.approval = { approvalId: event.approvalId, options: event.options, status: { state: "pending" } };
        approvals.set(event.approvalId, rec);
        break;
      }
      case "approval.answered":
      case "approval.auto_answered":
      case "approval.closed": {
        const rec = approvals.get(event.approvalId);
        const approval = rec?.approval;
        if (rec === undefined || approval === undefined) {
          problem(seq, `${event.kind} for unknown approval ${event.approvalId}`);
          break;
        }
        for (const turn of turns.values()) {
          if (turn.slots.some((s) => s.t === "tool" && s.rec === rec)) turn.meta.lastSeq = seq;
        }
        if (event.kind === "approval.answered") {
          approval.status = { state: "answered", decision: event.decision, optionId: event.optionId, by: event.memberId };
        } else if (event.kind === "approval.auto_answered") {
          approval.status = { state: "auto", ruleId: event.ruleId };
        } else {
          approval.status = { state: "closed", reason: event.reason };
        }
        break;
      }
      case "question.asked": {
        const turn = ensureTurn(event.turnId, seq);
        const rec: QuestionRecord = {
          questionId: event.questionId,
          message: event.message,
          fields: event.fields,
          status: { state: "open" },
        };
        questions.set(event.questionId, rec);
        turn.slots.push({ t: "question", rec });
        break;
      }
      case "question.answered": {
        const rec = questions.get(event.questionId);
        if (rec === undefined) {
          problem(seq, `answer for unknown question ${event.questionId}`);
          break;
        }
        rec.status = { state: "answered", answers: event.answers, answeredBy: event.memberId };
        for (const turn of turns.values()) {
          if (turn.slots.some((s) => s.t === "question" && s.rec === rec)) turn.meta.lastSeq = seq;
        }
        break;
      }
      case "question.closed": {
        const rec = questions.get(event.questionId);
        if (rec === undefined) {
          problem(seq, `close for unknown question ${event.questionId}`);
          break;
        }
        rec.status = { state: "closed", closedReason: event.reason };
        for (const turn of turns.values()) {
          if (turn.slots.some((s) => s.t === "question" && s.rec === rec)) turn.meta.lastSeq = seq;
        }
        break;
      }
      case "plan.updated": {
        const turn = ensureTurn(event.turnId, seq);
        if (turn.planSlot === undefined) {
          turn.planSlot = { t: "plan", id: `plan:${event.turnId}`, entries: event.entries };
          turn.slots.push(turn.planSlot);
        } else {
          turn.planSlot.entries = event.entries;
        }
        break;
      }
      case "compaction.updated": {
        const turn = ensureTurn(event.turnId, seq);
        if (turn.compactionSlot === undefined) {
          turn.compactionSlot = {
            t: "compaction",
            id: `compaction:${event.turnId}`,
            status: event.status,
            ...(event.summary === undefined ? {} : { summary: event.summary }),
          };
          turn.slots.push(turn.compactionSlot);
        } else {
          turn.compactionSlot.status = event.status;
          if (event.summary !== undefined) turn.compactionSlot.summary = event.summary;
        }
        break;
      }
      case "session.config_changed":
      case "driver.changed":
      case "runner.connected":
      case "runner.lost":
      case "session.restored":
      case "session.crashed":
      case "pr.opened":
      case "turn.cancel_requested": {
        system(seq, { type: "data-system", id: `system:${String(seq)}`, data: { seq, event } });
        break;
      }
      case "agent.unknown": {
        system(seq, { type: "data-unsupported", id: `unsupported:${String(seq)}`, data: { seq, rawKind: event.acpKind } });
        break;
      }
      case "unsupported": {
        system(seq, { type: "data-unsupported", id: `unsupported:${String(seq)}`, data: { seq, rawKind: event.rawKind } });
        break;
      }
      default:
        event satisfies never;
    }
  }

  // Live text: shown, never saved. A frame whose segment already has its completed message is dropped.
  for (const live of liveText) {
    if (committedSegments.has(live.segmentId)) continue;
    const turn = turns.get(live.turnId) ?? ensureTurn(live.turnId, 0);
    turn.slots.push({
      t: "part",
      part: live.part === "message" ? text(live.text, "streaming") : reasoning(live.text, "streaming"),
    });
  }

  for (const optimistic of options.optimistic ?? []) {
    if (committedClientIds.has(optimistic.clientMessageId)) continue;
    push({
      id: `user:${optimistic.clientMessageId}`,
      role: "user",
      slots: [{ t: "part", part: text(optimistic.text, "done") }],
      meta: {
        firstSeq: 0,
        lastSeq: 0,
        author: { memberId: optimistic.memberId, delivery: optimistic.delivery },
        optimistic: true,
      },
    });
  }

  const previousById = new Map<string, TaskUIMessage>();
  for (const message of options.previous ?? []) previousById.set(message.id, message);

  return builders.map((builder): TaskUIMessage => {
    const message: TaskUIMessage = {
      id: builder.id,
      role: builder.role,
      metadata: builder.meta,
      parts: builder.slots.map(slotToPart),
    };
    const previous = previousById.get(message.id);
    return previous !== undefined && deepEqual(previous, message) ? previous : message;
  });
};

// ---- derived task state -----------------------------------------------------------------

export type TaskViewState = {
  readonly driverMemberId: MemberId | null;
  readonly turnRunning: boolean;
  readonly headSeq: number;
  readonly pendingApprovalIds: readonly ApprovalId[];
};

// The driver and the running state come from the same events, so every viewer converges.
export const deriveTaskState = (events: readonly StoredEvent[], initialDriver: MemberId | null): TaskViewState => {
  let driver = initialDriver;
  let running = false;
  let head = 0;
  const pending = new Set<ApprovalId>();
  for (const { seq, event } of events) {
    head = Math.max(head, seq);
    switch (event.kind) {
      case "driver.changed":
        driver = event.memberId;
        break;
      case "turn.started":
        running = true;
        break;
      case "turn.ended":
      case "turn.failed":
        running = false;
        break;
      case "approval.requested":
        pending.add(event.approvalId);
        break;
      case "approval.answered":
      case "approval.auto_answered":
      case "approval.closed":
        pending.delete(event.approvalId);
        break;
      default:
        break;
    }
  }
  return { driverMemberId: driver, turnRunning: running, headSeq: head, pendingApprovalIds: [...pending] };
};

// Every event kind the fold turns into at least one visible part or record. Kinds that only
// change an existing part (tool updates, approvals, turn boundaries) are listed with what they update.
export const foldCoverage = {
  "user.message": "user message",
  "turn.started": "assistant message",
  "turn.ended": "assistant message metadata",
  "turn.failed": "assistant message metadata",
  "turn.cancel_requested": "system row",
  "agent.message": "text part",
  "agent.thought": "reasoning part",
  "agent.content": "file or source part",
  "tool.called": "tool part",
  "tool.progress": "tool part output",
  "tool.completed": "tool part output",
  "tool.failed": "tool part error",
  "approval.requested": "tool part approval",
  "approval.answered": "tool part receipt",
  "approval.auto_answered": "tool part receipt",
  "approval.closed": "tool part receipt",
  "question.asked": "question part",
  "question.answered": "question part",
  "question.closed": "question part",
  "plan.updated": "plan part",
  "compaction.updated": "compaction part",
  "session.config_changed": "system row",
  "driver.changed": "system row",
  "runner.connected": "system row",
  "runner.lost": "system row",
  "session.restored": "system row",
  "session.crashed": "system row",
  "pr.opened": "system row",
  "agent.unknown": "unsupported row",
} as const satisfies Record<TaskEvent["kind"], string>;
