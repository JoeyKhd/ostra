import type { UIToolInvocation } from "ai";
import type { z } from "zod";

import { messageDeliveries, typedToolSchemas } from "@ostra/protocol";
import type {
  ApprovalId,
  ApprovalOption,
  ClientMessageId,
  MemberId,
  MessageDelivery,
  MessageIntent,
  PlanEntry,
  QuestionField,
  QuestionId,
  RepoId,
  SegmentId,
  SessionId,
  StopReason,
  StoredEvent,
  SubagentId,
  SubagentStatus,
  ToolCallId,
  ToolKind,
  TurnId,
} from "@ostra/protocol";

import type { LiveText } from "./live-text.ts";
import type {
  ApprovalDescriptor,
  ApprovalReceipt,
  ApprovalStatus,
  PullRequestData,
  QuestionStatus,
  SetupData,
  SetupOutputLine,
  SubagentNode,
  SubagentState,
  SubagentTree,
  TaskMessageMeta,
  TaskToolPart,
  TaskUIMessage,
  TaskUIPart,
  TokenCounts,
} from "./ui-types.ts";

// The one fold from events to UIMessage[] (ADR 0036). Pure. The panel, its tests and any later
// consumer run the same function, and a stored session and a live one go through the same code.
// Messages that didn't change keep their object identity. Ported from
// spikes/live-stream-and-task-view/src/shared/fold.ts, with milestone 1's kinds added.

/** The driver's own message, shown at once and replaced by the committed one (same client ID). */
export type OptimisticMessage = {
  readonly clientMessageId: ClientMessageId;
  readonly memberId: MemberId;
  readonly text: string;
  readonly delivery: MessageDelivery;
};

export type FoldOptions = {
  readonly optimistic?: readonly OptimisticMessage[];
  /** The previous result, so unchanged messages keep their identity. */
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
  owner: Builder;
  /** F-138: the subagent whose call it is; missing for the main agent's. */
  subagentId?: SubagentId;
  /** F-138: it's in the thread (the main agent's, or a subagent's that asked for an approval). */
  inThread?: boolean;
};

/** F-138: one round of a subagent, as the fold builds it. */
type RoundRecord = {
  toolCallId: ToolCallId | null;
  prompt: string;
  askedAt: number | null;
  calls: ToolRecord[];
  answer: string | null;
};

/** F-138: one subagent, as the fold builds it, until the tree is made at the end. */
type SubagentRecord = {
  id: SubagentId;
  parentId: SubagentId | null;
  depth: number;
  type: string | null;
  description: string;
  /** Its last reported state; `null` while its agent reported none. */
  status: SubagentStatus | null;
  error?: string;
  startedAt: number | null;
  endedAt: number | null;
  startedBy: ToolCallId | null;
  rounds: RoundRecord[];
  children: SubagentId[];
  orphan: boolean;
  /** The turn whose tree it's in: the one that started it, or its parent's. */
  turn: Builder;
  sessionId: SessionId;
  /** Its session ended or crashed while it ran: it's stopped. */
  boxEnded: boolean;
  /** Its place in start order. */
  order: number;
};

type QuestionRecord = {
  questionId: QuestionId;
  message: string;
  fields: QuestionField[];
  status: QuestionStatus;
  owner: Builder;
};

type SetupRecord = {
  sessionId: SessionId;
  state: SetupData["state"];
  output: SetupOutputLine[];
  exitCode?: number | null;
  durationMs?: number;
  dependencyCache?: "warm" | "cold";
};

type Slot =
  | { t: "part"; part: TaskUIPart }
  | { t: "tool"; rec: ToolRecord }
  | { t: "question"; rec: QuestionRecord }
  | { t: "plan"; id: string; entries: PlanEntry[] }
  | { t: "compaction"; id: string; status: "running" | "done"; summary?: string }
  | { t: "setup"; id: string; rec: SetupRecord };

type Builder = {
  id: string;
  role: "user" | "assistant" | "system";
  slots: Slot[];
  meta: TaskMessageMeta;
  planSlot?: Extract<Slot, { t: "plan" }>;
  compactionSlot?: Extract<Slot, { t: "compaction" }>;
  /** F-138: the turn's subagents, nested ones included. */
  subagents?: SubagentRecord[];
};

// ---- tool parts -------------------------------------------------------------------------

type OutputParse<O> = { ok: true; value: O } | { ok: false };

const receiptOf = (approval: ApprovalRecord): ApprovalReceipt | undefined =>
  approval.status.state === "pending" ? undefined : approval.status;

const descriptorOf = (approval: ApprovalRecord): ApprovalDescriptor => {
  const receipt = receiptOf(approval);
  return { options: approval.options, ...(receipt === undefined ? {} : { receipt }) };
};

// One state machine for every kind. `I` and `O` are the kind's normalised input and output.
const buildInvocation = <I, O>(
  rec: ToolRecord,
  input: I,
  parseOutput: (raw: unknown) => OutputParse<O>,
): UIToolInvocation<{ input: I; output: O }> => {
  const approval = rec.approval;
  // The approval's options and receipt also ride in `toolMetadata`, so a request that closed
  // without a decision (the AI SDK only allows `approved: true` after the call ran) still shows.
  const base = {
    toolCallId: rec.toolCallId,
    title: rec.title,
    ...(approval === undefined
      ? {}
      : {
          toolMetadata: {
            approval: { id: approval.approvalId, descriptor: descriptorOf(approval) },
          },
        }),
  };
  const status = approval?.status;
  const approved =
    approval !== undefined &&
    status !== undefined &&
    (status.state === "auto" || (status.state === "answered" && status.decision !== "deny"));
  const approvedTrue = approved
    ? { id: approval.approvalId, approved: true as const, descriptor: descriptorOf(approval) }
    : undefined;

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
    return { ...base, state: "output-error", input, errorText: `approval ${status.reason}` };
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
    if (parsed.ok) {
      return {
        ...base,
        state: "output-available",
        input,
        output: parsed.value,
        preliminary: true,
        ...(approvedTrue === undefined ? {} : { approval: approvedTrue }),
      };
    }
    // Progress that doesn't fit the kind's output (OpenCode sends some) leaves the call running.
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

const dynamicPart = (rec: ToolRecord): TaskUIPart => ({
  type: "dynamic-tool",
  toolName: rec.kind,
  ...buildInvocation(rec, rec.input, passThrough),
});

const toolPart = (rec: ToolRecord): TaskUIPart => {
  switch (rec.kind) {
    case "read": {
      const input = typedToolSchemas.read.input.safeParse(rec.input);
      if (!input.success) return dynamicPart(rec);
      return {
        type: "tool-read",
        ...buildInvocation(rec, input.data, parseWith(typedToolSchemas.read.output)),
      };
    }
    case "edit": {
      const input = typedToolSchemas.edit.input.safeParse(rec.input);
      if (!input.success) return dynamicPart(rec);
      return {
        type: "tool-edit",
        ...buildInvocation(rec, input.data, parseWith(typedToolSchemas.edit.output)),
      };
    }
    case "execute": {
      const input = typedToolSchemas.execute.input.safeParse(rec.input);
      if (!input.success) return dynamicPart(rec);
      return {
        type: "tool-execute",
        ...buildInvocation(rec, input.data, parseWith(typedToolSchemas.execute.output)),
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

const setupPart = (id: string, rec: SetupRecord): TaskUIPart => ({
  type: "data-setup",
  id,
  data: {
    sessionId: rec.sessionId,
    state: rec.state,
    output: [...rec.output],
    ...(rec.exitCode === undefined ? {} : { exitCode: rec.exitCode }),
    ...(rec.durationMs === undefined ? {} : { durationMs: rec.durationMs }),
    ...(rec.dependencyCache === undefined ? {} : { dependencyCache: rec.dependencyCache }),
  },
});

const slotToPart = (slot: Slot): TaskUIPart => {
  switch (slot.t) {
    case "part":
      return slot.part;
    case "tool":
      return toolPart(slot.rec);
    case "question":
      return {
        type: "data-question",
        id: slot.rec.questionId,
        data: {
          questionId: slot.rec.questionId,
          message: slot.rec.message,
          fields: slot.rec.fields,
          status: slot.rec.status,
        },
      };
    case "plan":
      return { type: "data-plan", id: slot.id, data: { entries: slot.entries } };
    case "compaction":
      return {
        type: "data-compaction",
        id: slot.id,
        data: {
          status: slot.status,
          ...(slot.summary === undefined ? {} : { summary: slot.summary }),
        },
      };
    case "setup":
      return setupPart(slot.id, slot.rec);
    default:
      return slot satisfies never;
  }
};

/** Structural equality on plain data, for keeping the identity of unchanged messages. */
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

const hiddenRefPrefix = "refs/ostra/wip/";

const addUsage = (sum: TokenCounts | undefined, add: Omit<TokenCounts, "reasoningTokens"> & { readonly reasoningTokens?: number | undefined }): TokenCounts => {
  const reasoningTokens = (sum?.reasoningTokens ?? 0) + (add.reasoningTokens ?? 0);
  return {
    inputTokens: (sum?.inputTokens ?? 0) + add.inputTokens,
    outputTokens: (sum?.outputTokens ?? 0) + add.outputTokens,
    cacheReadTokens: (sum?.cacheReadTokens ?? 0) + add.cacheReadTokens,
    cacheWriteTokens: (sum?.cacheWriteTokens ?? 0) + add.cacheWriteTokens,
    estimated: (sum?.estimated ?? false) || add.estimated,
    // F-137: the reasoning subset, kept only when an endpoint reported some.
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
};

/**
 * Minor 3 (F-037, ADR 0055): a member's message to an idle session that the budget gate held is
 * saved queued, then `turn.held` with the origin `message` follows it; it stays held until the
 * session's next `turn.released` or turn start.
 */
export const heldMessages = (events: readonly StoredEvent[]): ReadonlySet<ClientMessageId> => {
  const held = new Set<ClientMessageId>();
  const lastQueued = new Map<SessionId, ClientMessageId>();
  const bySession = new Map<SessionId, ClientMessageId[]>();
  for (const { sessionId, event } of events) {
    if (event.kind === "user.message") {
      if (event.delivery === "queued") lastQueued.set(sessionId, event.clientMessageId);
    } else if (event.kind === "turn.held") {
      const id = lastQueued.get(sessionId);
      if (event.origin === "message" && id !== undefined) {
        held.add(id);
        bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), id]);
        lastQueued.delete(sessionId);
      }
    } else if (event.kind === "turn.released" || event.kind === "turn.started") {
      for (const id of bySession.get(sessionId) ?? []) held.delete(id);
      bySession.delete(sessionId);
      lastQueued.delete(sessionId);
    }
  }
  return held;
};

// ---- subagents (F-138) -------------------------------------------------------------------

const isToolPart = (part: TaskUIPart): part is TaskToolPart =>
  part.type === "dynamic-tool" || part.type === "tool-read" || part.type === "tool-edit" || part.type === "tool-execute";

const toolPartOf = (rec: ToolRecord): TaskToolPart => {
  const part = toolPart(rec);
  if (!isToolPart(part)) throw new Error("a tool record's part is a tool part");
  return part;
};

/** A subagent's state on the page, from its last report, its calls and its turn (`SubagentState`). */
const stateOf = (record: SubagentRecord): SubagentState => {
  switch (record.status) {
    case "failed":
      return "failed";
    case "interrupted":
      return "stopped";
    case "completed":
      return "done";
    case "created":
    case "running":
    case null: {
      const round = record.rounds.at(-1);
      if (round?.calls.some((call) => call.approval?.status.state === "pending" && call.outcome === undefined && !call.cancelled) === true) {
        return "needs-approval";
      }
      if (record.boxEnded) return "stopped";
      // An agent that reports no states (its start alone, or a peer that sent none): once its turn
      // is over, it's done when it answered, and stopped when it didn't.
      if (record.status === null && record.turn.meta.turnState !== "running") {
        return round?.answer === null || round === undefined ? "stopped" : "done";
      }
      return "running";
    }
    default:
      return record.status satisfies never;
  }
};

/** A turn's subagents as the tree the badge and the window read: depth first, in start order. */
const treeOf = (turn: Builder, records: readonly SubagentRecord[]): SubagentTree => {
  const byId = new Map(records.map((record) => [record.id, record] as const));
  const ordered = [...records].sort((a, b) => a.order - b.order);
  const nodes: SubagentNode[] = [];
  const seen = new Set<SubagentId>();
  const visit = (record: SubagentRecord): void => {
    if (seen.has(record.id)) return;
    seen.add(record.id);
    const state = stateOf(record);
    nodes.push({
      id: record.id,
      parentId: record.parentId !== null && byId.has(record.parentId) ? record.parentId : null,
      depth: record.depth,
      type: record.type,
      description: record.description,
      state,
      ...(record.error === undefined ? {} : { error: record.error }),
      startedAt: record.startedAt,
      endedAt: state === "running" || state === "needs-approval" ? null : record.endedAt,
      startedBy: record.startedBy,
      rounds: record.rounds.map((round) => ({ toolCallId: round.toolCallId, prompt: round.prompt, askedAt: round.askedAt, calls: round.calls.map(toolPartOf), answer: round.answer })),
      callCount: record.rounds.reduce((sum, round) => sum + round.calls.length, 0),
      children: [...record.children].filter((child) => byId.has(child)).sort((a, b) => (byId.get(a)?.order ?? 0) - (byId.get(b)?.order ?? 0)),
      orphan: record.orphan,
    });
    for (const child of [...record.children].sort((a, b) => (byId.get(a)?.order ?? 0) - (byId.get(b)?.order ?? 0))) {
      const next = byId.get(child);
      if (next !== undefined) visit(next);
    }
  };
  // The main agent's subagents first, then any whose parent is in another turn's tree.
  for (const record of ordered) if (record.parentId === null || !byId.has(record.parentId)) visit(record);
  for (const record of ordered) visit(record);
  const count = (state: SubagentState): number => nodes.filter((node) => node.state === state).length;
  return {
    nodes,
    rootCalls: turn.slots.filter((slot) => slot.t === "tool" && slot.rec.subagentId === undefined).length,
    counts: { total: nodes.length, running: count("running"), needsApproval: count("needs-approval"), failed: count("failed"), stopped: count("stopped"), done: count("done") },
  };
};

// ---- the fold ---------------------------------------------------------------------------

/**
 * Folds a task's stored events, the viewer's partial text and its own unsent messages into the
 * thread. Every event kind lands somewhere visible (`foldCoverage`); a kind this build doesn't
 * know is an "unsupported" row, never dropped.
 */
export const foldTaskEvents = (
  events: readonly StoredEvent[],
  liveText: readonly LiveText[],
  options: FoldOptions = {},
): TaskUIMessage[] => {
  const builders: Builder[] = [];
  const turns = new Map<TurnId, Builder>();
  const lastTurnBySession = new Map<SessionId, Builder>();
  const tools = new Map<ToolCallId, ToolRecord>();
  const approvals = new Map<ApprovalId, ToolRecord>();
  const questions = new Map<QuestionId, QuestionRecord>();
  const setups = new Map<SessionId, { builder: Builder; rec: SetupRecord }>();
  const prTitles = new Map<RepoId, string>();
  const committedSegments = new Set<SegmentId>();
  const committedClientIds = new Set<ClientMessageId>();
  // Each member message's first event: its sequence and why it was written. A reopen's replay of a
  // message no turn answered carries no intent of its own (`reopen.ts`), so it keeps the first's,
  // and the sequence that names what it carried (a diff-comments message's comments, F-072).
  const sentFirst = new Map<ClientMessageId, { readonly seq: number; readonly intent: MessageIntent | undefined }>();
  // F-138: every subagent of the task, by its ID, and the call that started each one.
  const subagents = new Map<SubagentId, SubagentRecord>();
  // Where each member message stands, the same for every viewer (ticket 19): "queued" until the
  // turn that carries it starts, then "delivered after the turn".
  const deliveries = messageDeliveries(events);
  // Minor 3 (F-037): the messages whose turn the budget gate holds now.
  const held = heldMessages(events);

  const push = (builder: Builder): Builder => {
    builders.push(builder);
    return builder;
  };

  const row = (seq: number, sessionId: SessionId, part: TaskUIPart): void => {
    push({
      id: `sys:${String(seq)}`,
      role: "system",
      slots: [{ t: "part", part }],
      meta: { firstSeq: seq, lastSeq: seq, sessionId },
    });
  };

  const problem = (seq: number, sessionId: SessionId, text: string): void => {
    row(seq, sessionId, {
      type: "data-problem",
      id: `problem:${String(seq)}`,
      data: { seq, text },
    });
  };

  // When the event being folded was recorded: a message's time is its first event's.
  let at: number | undefined;

  const ensureTurn = (turnId: TurnId, sessionId: SessionId, seq: number): Builder => {
    const existing = turns.get(turnId);
    if (existing !== undefined) {
      existing.meta.lastSeq = Math.max(existing.meta.lastSeq, seq);
      return existing;
    }
    const builder = push({
      id: `turn:${turnId}`,
      role: "assistant",
      slots: [{ t: "part", part: { type: "step-start" } }],
      meta: { firstSeq: seq, lastSeq: seq, sessionId, turnId, turnState: "running", ...(at === undefined ? {} : { at }) },
    });
    turns.set(turnId, builder);
    lastTurnBySession.set(sessionId, builder);
    return builder;
  };

  const touch = (owner: Builder, seq: number): void => {
    owner.meta.lastSeq = Math.max(owner.meta.lastSeq, seq);
  };

  const text = (value: string, state: "streaming" | "done"): TaskUIPart => ({
    type: "text",
    text: value,
    state,
  });
  const reasoning = (value: string, state: "streaming" | "done"): TaskUIPart => ({
    type: "reasoning",
    text: value,
    state,
  });

  /**
   * F-138: a subagent's record, made when its first event comes. One whose start hasn't come yet is
   * an orphan under the main agent of `turn`, until its `subagent.started` places it.
   */
  const subagentOf = (id: SubagentId, turn: Builder, sessionId: SessionId): SubagentRecord => {
    const existing = subagents.get(id);
    if (existing !== undefined) return existing;
    const record: SubagentRecord = {
      id,
      parentId: null,
      depth: 1,
      type: null,
      description: "",
      status: null,
      startedAt: null,
      endedAt: null,
      startedBy: null,
      rounds: [{ toolCallId: null, prompt: "", askedAt: null, calls: [], answer: null }],
      children: [],
      orphan: true,
      turn,
      sessionId,
      boxEnded: false,
      order: subagents.size,
    };
    subagents.set(id, record);
    turn.subagents = [...(turn.subagents ?? []), record];
    return record;
  };

  /** The current round of a subagent: where its calls and its answer go. */
  const roundOf = (record: SubagentRecord): RoundRecord => {
    const round = record.rounds.at(-1);
    if (round !== undefined) return round;
    const first: RoundRecord = { toolCallId: null, prompt: "", askedAt: null, calls: [], answer: null };
    record.rounds.push(first);
    return first;
  };

  /** Moves a record into another turn's tree (its parent's), keeping its place in start order. */
  const moveTo = (record: SubagentRecord, turn: Builder): void => {
    if (record.turn === turn) return;
    record.turn.subagents = (record.turn.subagents ?? []).filter((other) => other !== record);
    record.turn = turn;
    turn.subagents = [...(turn.subagents ?? []), record];
    for (const child of record.children) {
      const next = subagents.get(child);
      if (next !== undefined) moveTo(next, turn);
    }
  };

  /** F-138: the session ended or crashed: what of its subagents still ran is stopped. */
  const stopSubagentsOf = (sessionId: SessionId, endedAt: number): void => {
    for (const record of subagents.values()) {
      if (record.sessionId === sessionId && (record.status === null || record.status === "created" || record.status === "running")) {
        record.boxEnded = true;
        record.endedAt ??= endedAt;
      }
    }
  };


  const setupOf = (sessionId: SessionId, seq: number): SetupRecord => {
    const existing = setups.get(sessionId);
    if (existing !== undefined) {
      touch(existing.builder, seq);
      return existing.rec;
    }
    const rec: SetupRecord = { sessionId, state: "running", output: [] };
    const id = `setup:${sessionId}`;
    const builder = push({
      id,
      role: "system",
      slots: [{ t: "setup", id, rec }],
      meta: { firstSeq: seq, lastSeq: seq, sessionId },
    });
    setups.set(sessionId, { builder, rec });
    return rec;
  };

  for (const stored of events) {
    const { seq, sessionId, event } = stored;
    at = stored.at;
    switch (event.kind) {
      case "user.message": {
        committedClientIds.add(event.clientMessageId);
        const first = sentFirst.get(event.clientMessageId);
        if (first === undefined) sentFirst.set(event.clientMessageId, { seq, intent: event.intent });
        const replayOf = event.replayed === true && first !== undefined ? first : null;
        const intent = event.intent ?? replayOf?.intent;
        push({
          id: `user:${event.clientMessageId}`,
          role: "user",
          slots: [{ t: "part", part: text(event.text, "done") }],
          meta: {
            firstSeq: seq,
            lastSeq: seq,
            sessionId,
            at: stored.at,
            author: {
              memberId: event.memberId,
              delivery: event.delivery,
              deliveryState: deliveries.get(event.clientMessageId) ?? "delivered",
              ...(held.has(event.clientMessageId) ? { held: true } : {}),
              ...(event.reopen === true ? { reopen: true } : {}),
              ...(event.replayed === true ? { replayed: true } : {}),
              ...(replayOf === null ? {} : { replayOf: replayOf.seq }),
              ...(intent === undefined || intent === "message" ? {} : { intent }),
            },
          },
        });
        break;
      }
      case "turn.started": {
        const started = ensureTurn(event.turnId, sessionId, seq);
        started.meta.turnState = "running";
        if (event.mode === "plan") started.meta.turnMode = "plan";
        // F-137: the level the turn ran at, and the one asked for when the clamp moved it.
        if (event.effort !== undefined && event.effort !== "default") started.meta.effort = event.effort;
        if (event.adjustedFrom !== undefined) started.meta.adjustedFrom = event.adjustedFrom;
        break;
      }
      case "turn.ended": {
        const turn = ensureTurn(event.turnId, sessionId, seq);
        turn.meta.turnState = "ended";
        turn.meta.stopReason = event.stopReason satisfies StopReason;
        turn.meta.endedAt = stored.at;
        if (event.stopReason === "cancelled") {
          // F-138: the turn's subagents' calls stop with it, as its own do.
          const subagentCalls = (turn.subagents ?? []).flatMap((record) => record.rounds.flatMap((round) => round.calls));
          for (const rec of [...turn.slots.flatMap((slot) => (slot.t === "tool" ? [slot.rec] : [])), ...subagentCalls]) {
            if (rec.outcome === undefined) {
              rec.cancelled = true;
              if (rec.approval?.status.state === "pending") {
                rec.approval.status = { state: "closed", reason: "cancelled" };
              }
            }
          }
        }
        break;
      }
      case "turn.failed": {
        const turn = ensureTurn(event.turnId, sessionId, seq);
        turn.meta.turnState = "failed";
        turn.meta.error = event.error;
        turn.meta.endedAt = stored.at;
        break;
      }
      case "agent.message": {
        committedSegments.add(event.segmentId);
        const turn = ensureTurn(event.turnId, sessionId, seq);
        if (event.subagentId !== undefined) {
          // F-138: a subagent's words are its own, in its window: never the main agent's in the thread.
          roundOf(subagentOf(event.subagentId, turn, sessionId)).answer = event.text;
          break;
        }
        turn.slots.push({
          t: "part",
          part: text(event.text, "done"),
        });
        break;
      }
      case "agent.thought": {
        committedSegments.add(event.segmentId);
        const turn = ensureTurn(event.turnId, sessionId, seq);
        if (event.subagentId !== undefined) {
          // F-138: a subagent's thinking stays with it; the window shows its calls and its answer.
          subagentOf(event.subagentId, turn, sessionId);
          break;
        }
        turn.slots.push({
          t: "part",
          part: reasoning(event.text, "done"),
        });
        break;
      }
      case "agent.content": {
        const turn = ensureTurn(event.turnId, sessionId, seq);
        const block = event.block;
        switch (block.type) {
          case "image":
            turn.slots.push({
              t: "part",
              part: { type: "file", mediaType: block.mediaType, url: block.url },
            });
            break;
          case "resource_link":
            turn.slots.push({
              t: "part",
              part: {
                type: "source-url",
                sourceId: `link:${String(seq)}`,
                url: block.uri,
                title: block.title,
              },
            });
            break;
          default:
            block satisfies never;
        }
        break;
      }
      case "tool.called": {
        const turn = ensureTurn(event.turnId, sessionId, seq);
        if (tools.has(event.toolCallId)) {
          problem(seq, sessionId, `duplicate tool call ${event.toolCallId}`);
          break;
        }
        const rec: ToolRecord = {
          toolCallId: event.toolCallId,
          kind: event.toolKind,
          title: event.title,
          input: event.input,
          cancelled: false,
          owner: turn,
        };
        tools.set(event.toolCallId, rec);
        if (event.subagentId !== undefined) {
          // F-138: a subagent's call is in its window, not the thread.
          rec.subagentId = event.subagentId;
          const record = subagentOf(event.subagentId, turn, sessionId);
          rec.owner = record.turn;
          roundOf(record).calls.push(rec);
          break;
        }
        rec.inThread = true;
        turn.slots.push({ t: "tool", rec });
        break;
      }
      case "tool.progress":
      case "tool.completed":
      case "tool.failed": {
        const rec = tools.get(event.toolCallId);
        if (rec === undefined) {
          problem(seq, sessionId, `${event.kind} for unknown tool call ${event.toolCallId}`);
          break;
        }
        touch(rec.owner, seq);
        if (event.kind === "tool.progress") rec.progress = { value: event.output };
        else if (event.kind === "tool.completed")
          rec.outcome = { type: "done", output: event.output };
        else rec.outcome = { type: "failed", error: event.error };
        break;
      }
      case "approval.requested": {
        const rec = tools.get(event.toolCallId);
        if (rec === undefined) {
          problem(seq, sessionId, `approval for unknown tool call ${event.toolCallId}`);
          break;
        }
        touch(rec.owner, seq);
        rec.approval = {
          approvalId: event.approvalId,
          options: event.options,
          status: { state: "pending" },
        };
        approvals.set(event.approvalId, rec);
        if (rec.subagentId !== undefined && rec.inThread !== true) {
          // F-138: a subagent's call that asks asks in the thread too, where it was asked: one
          // answer, from either place, closes both.
          rec.inThread = true;
          rec.owner.slots.push({ t: "tool", rec });
        }
        break;
      }
      case "approval.answered":
      case "approval.auto_answered":
      case "approval.closed": {
        const rec = approvals.get(event.approvalId);
        const approval = rec?.approval;
        if (rec === undefined || approval === undefined) {
          problem(seq, sessionId, `${event.kind} for unknown approval ${event.approvalId}`);
          break;
        }
        touch(rec.owner, seq);
        if (event.kind === "approval.answered") {
          approval.status = {
            state: "answered",
            decision: event.decision,
            optionId: event.optionId,
            by: event.memberId,
          };
        } else if (event.kind === "approval.auto_answered") {
          approval.status = { state: "auto", ruleId: event.ruleId };
        } else {
          approval.status = { state: "closed", reason: event.reason };
        }
        break;
      }
      case "question.asked": {
        const turn = ensureTurn(event.turnId, sessionId, seq);
        const rec: QuestionRecord = {
          questionId: event.questionId,
          message: event.message,
          fields: event.fields,
          status: { state: "open" },
          owner: turn,
        };
        questions.set(event.questionId, rec);
        turn.slots.push({ t: "question", rec });
        break;
      }
      case "question.answered":
      case "question.closed": {
        const rec = questions.get(event.questionId);
        if (rec === undefined) {
          problem(seq, sessionId, `${event.kind} for unknown question ${event.questionId}`);
          break;
        }
        touch(rec.owner, seq);
        rec.status =
          event.kind === "question.answered"
            ? { state: "answered", answers: event.answers, answeredBy: event.memberId }
            : { state: "closed", closedReason: event.reason };
        break;
      }
      case "plan.updated": {
        const turn = ensureTurn(event.turnId, sessionId, seq);
        if (event.subagentId !== undefined) {
          // F-138: a subagent's plan is its own, not the turn's.
          subagentOf(event.subagentId, turn, sessionId);
          break;
        }
        if (turn.planSlot === undefined) {
          turn.planSlot = { t: "plan", id: `plan:${event.turnId}`, entries: event.entries };
          turn.slots.push(turn.planSlot);
        } else {
          turn.planSlot.entries = event.entries;
        }
        break;
      }
      case "compaction.updated": {
        const turn = ensureTurn(event.turnId, sessionId, seq);
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
      case "environment.setup_started": {
        setupOf(sessionId, seq).state = "running";
        break;
      }
      case "environment.setup_output": {
        setupOf(sessionId, seq).output.push({ stream: event.stream, text: event.text });
        break;
      }
      case "environment.setup_finished": {
        const rec = setupOf(sessionId, seq);
        rec.state = event.exitCode === 0 ? "succeeded" : "failed";
        rec.exitCode = event.exitCode;
        rec.durationMs = event.durationMs;
        if (event.dependencyCache !== undefined) rec.dependencyCache = event.dependencyCache;
        break;
      }
      case "git.pushed": {
        row(seq, sessionId, {
          type: "data-pushed",
          id: `pushed:${String(seq)}`,
          data: {
            repoId: event.repoId,
            branch: event.branch,
            headSha: event.headSha,
            ref: event.ref,
            hidden: event.ref.startsWith(hiddenRefPrefix),
          },
        });
        break;
      }
      case "pr.text_set": {
        prTitles.set(event.repoId, event.title);
        row(seq, sessionId, {
          type: "data-pr-text",
          id: `pr-text:${String(seq)}`,
          data: { repoId: event.repoId, title: event.title, body: event.body },
        });
        break;
      }
      case "pr.opened": {
        const title = prTitles.get(event.repoId);
        row(seq, sessionId, {
          type: "data-pr",
          id: `pr:${event.repoId}:${String(event.number)}`,
          data: {
            repoId: event.repoId,
            url: event.url,
            number: event.number,
            ...(title === undefined ? {} : { title }),
          },
        });
        break;
      }
      case "session.ended": {
        stopSubagentsOf(sessionId, stored.at);
        row(seq, sessionId, {
          type: "data-session-end",
          id: `session-end:${sessionId}`,
          data: { sessionId, outcome: event.outcome, repos: event.repos },
        });
        break;
      }
      case "workspace.files_outside_repos": {
        // Q133: the names the agent left beside the repos, each time the set changes.
        row(seq, sessionId, {
          type: "data-files-outside",
          id: `files-outside:${String(seq)}`,
          data: { paths: event.paths, more: event.more },
        });
        break;
      }
      case "driver.changed": {
        row(seq, sessionId, {
          type: "data-driver",
          id: `driver:${String(seq)}`,
          data: { memberId: event.memberId, byMemberId: event.byMemberId },
        });
        break;
      }
      case "usage.recorded": {
        const turn = lastTurnBySession.get(sessionId);
        if (turn === undefined) {
          problem(seq, sessionId, "usage recorded before any turn");
          break;
        }
        touch(turn, seq);
        turn.meta.usage = addUsage(turn.meta.usage, event);
        break;
      }
      case "session.usage": {
        const turn = lastTurnBySession.get(sessionId);
        if (turn === undefined) {
          problem(seq, sessionId, "context usage before any turn");
          break;
        }
        touch(turn, seq);
        turn.meta.context = { used: event.contextUsed, size: event.contextSize };
        break;
      }
      case "provider.rate_limited":
        // The server holds new dispatches on the provider; the thread has nothing to show.
        break;
      case "session.saved": {
        // Protocol minor 1 (ticket 36): the work saved after a turn.
        row(seq, sessionId, {
          type: "data-saved",
          id: `saved:${String(seq)}`,
          data: {
            turnOrdinal: event.turnOrdinal,
            archiveBytes: event.archive === null ? null : event.archive.size,
            hiddenRefs: event.repos.flatMap((repo) => (repo.hiddenRefSha === null ? [] : [repo.hiddenRefSha])),
            unsaved: event.repos.filter((repo) => repo.hiddenRefSha === null).length,
          },
        });
        break;
      }
      case "session.limit_reached": {
        row(seq, sessionId, { type: "data-limit", id: `limit:${String(seq)}`, data: { limit: event.limit, observed: event.observed } });
        break;
      }
      case "ticket.files_ready": {
        row(seq, sessionId, { type: "data-ticket-files", id: `ticket-files:${String(seq)}`, data: { paths: event.files.map((file) => file.path) } });
        break;
      }
      case "plan.proposed":
      case "plan.answered":
      case "check.started":
      case "check.finished":
      case "snapshot.built":
      case "snapshot.failed":
      case "service.healthy":
      case "service.failed":
      case "diff.comments_sent":
      case "ticket.closed":
        // Protocol minor 2. No row until the milestone 3 task page (tickets 43, 46, 47) draws them.
        break;
      case "pr.comment_received":
        // F-111 (m4 ticket 38): an accepted `@ostra` comment is a row, with "Remember this" by its seq.
        row(seq, sessionId, { type: "data-pr-comment", id: `pr-comment:${String(seq)}`, data: { seq, url: event.url, login: event.login, path: event.path, line: event.line } });
        break;
      case "turn.held": {
        row(seq, sessionId, { type: "data-held", id: `held:${String(seq)}`, data: { origin: event.origin, scope: event.scope, at: stored.at } });
        break;
      }
      case "turn.released": {
        row(seq, sessionId, { type: "data-released", id: `released:${String(seq)}`, data: { at: stored.at } });
        break;
      }
      case "memory.proposed": {
        row(seq, sessionId, { type: "data-memory-proposed", id: `memory-proposed:${String(seq)}`, data: { proposalId: event.proposalId, title: event.title } });
        break;
      }
      case "memory.used":
      case "review.check_updated":
      case "pr.related_updated":
        // Protocol minor 3. No row until the milestone 4 task page draws them.
        break;
      case "effort.changed": {
        // F-137: in time order; during a turn it applies from the next one (ADR 0066).
        const turn = lastTurnBySession.get(sessionId);
        row(seq, sessionId, {
          type: "data-effort",
          id: `effort:${String(seq)}`,
          data: { from: event.from, to: event.to, memberId: event.memberId, duringTurn: turn?.meta.turnState === "running", at: stored.at },
        });
        break;
      }
      case "box.waiting":
      case "box.scheduled":
      case "task.cancelled":
      case "runner.drained":
      case "runner.resumed":
        // Protocol minor 4. No row until the milestone 5 task page draws them (ticket 33).
        break;
      case "question.auto_answered":
      case "commit.filtered":
      case "automation.started":
      case "task.approval_requested":
      case "task.approved":
      case "task.rejected":
      case "tracker.session_event":
      case "draft.submitted":
      case "draft.applied":
      case "ci.updated":
      case "round.started":
      case "round.capped":
      case "review.submitted":
      case "review.posted":
      case "reviewers.updated":
      case "environment.proposed":
        // Protocol minor 5. No row until the milestone 6 task page draws them (tickets 30 to 36).
        break;
      case "app.process":
      case "app.browser":
      case "attachment.added":
      case "attachment.skipped":
      case "preview.list":
      case "preview.dropped":
      case "preview.opened":
      case "preview.closed":
      case "preview.level_changed":
      case "preview.link_created":
      case "preview.link_revoked":
      case "app.started_by":
        // Protocol minor 7 (milestone 8, ADR 0068). No row until the milestone 8 task page draws
        // them: the pictures in the thread (ticket 17) and the preview pane (ticket 21).
        break;
      case "subagent.started": {
        // F-138: placed in the tree of its parent's turn, or of the turn of the call that started it.
        const parent = event.parentSubagentId === undefined ? undefined : subagents.get(event.parentSubagentId);
        const starter = tools.get(event.toolCallId);
        const turn = parent?.turn ?? starter?.owner ?? lastTurnBySession.get(sessionId);
        if (turn === undefined) {
          problem(seq, sessionId, `subagent ${event.subagentId} started before any turn`);
          break;
        }
        touch(turn, seq);
        const known = subagents.get(event.subagentId);
        const record = known ?? subagentOf(event.subagentId, turn, sessionId);
        if (known !== undefined && !known.orphan) {
          // A follow-up: the same subagent asked again, a round of its own.
          record.rounds.push({ toolCallId: event.toolCallId, prompt: event.prompt, askedAt: stored.at, calls: [], answer: null });
          record.status = null;
          record.endedAt = null;
        } else {
          const first = roundOf(record);
          first.toolCallId = event.toolCallId;
          first.prompt = event.prompt;
          first.askedAt = stored.at;
          record.orphan = false;
          record.startedBy = event.toolCallId;
          record.parentId = event.parentSubagentId ?? null;
          record.depth = event.depth;
          record.type = event.type;
          record.description = event.description;
          record.startedAt ??= stored.at;
          moveTo(record, turn);
          if (event.parentSubagentId !== undefined) {
            const parentRecord = parent ?? subagentOf(event.parentSubagentId, turn, sessionId);
            if (!parentRecord.children.includes(record.id)) parentRecord.children.push(record.id);
          }
        }
        break;
      }
      case "subagent.status": {
        const turn = lastTurnBySession.get(sessionId);
        const known = subagents.get(event.subagentId);
        if (known === undefined && turn === undefined) {
          problem(seq, sessionId, `subagent ${event.subagentId} reported before any turn`);
          break;
        }
        const record = known ?? (turn === undefined ? undefined : subagentOf(event.subagentId, turn, sessionId));
        if (record === undefined) break;
        touch(record.turn, seq);
        record.status = event.status;
        if (event.status === "created" || event.status === "running") {
          record.startedAt ??= stored.at;
          record.endedAt = null;
        } else {
          record.endedAt = stored.at;
        }
        if (event.status === "failed" && event.error !== undefined) record.error = event.error;
        break;
      }
      case "session.config_changed":
      case "runner.connected":
      case "runner.lost":
      case "session.restored":
      case "session.crashed":
      case "turn.cancel_requested": {
        if (event.kind === "session.crashed") stopSubagentsOf(sessionId, stored.at);
        row(seq, sessionId, {
          type: "data-system",
          id: `system:${String(seq)}`,
          data: { seq, event },
        });
        break;
      }
      case "agent.unknown": {
        row(seq, sessionId, {
          type: "data-unsupported",
          id: `unsupported:${String(seq)}`,
          data: { seq, rawKind: event.acpKind, acp: true },
        });
        break;
      }
      case "unsupported": {
        row(seq, sessionId, {
          type: "data-unsupported",
          id: `unsupported:${String(seq)}`,
          data: { seq, rawKind: event.rawKind, acp: false },
        });
        break;
      }
      default:
        event satisfies never;
    }
  }

  // Partial text: shown, never saved. A segment that already has its completed message is dropped.
  for (const live of liveText) {
    if (committedSegments.has(live.segmentId)) continue;
    const turn = ensureTurn(live.turnId, live.sessionId, turns.get(live.turnId)?.meta.lastSeq ?? 0);
    turn.slots.push({
      t: "part",
      part:
        live.kind === "message" ? text(live.text, "streaming") : reasoning(live.text, "streaming"),
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
    // F-138: the turn's subagents, as a tree, made once every event is in.
    const records = builder.subagents ?? [];
    const message: TaskUIMessage = {
      id: builder.id,
      role: builder.role,
      metadata: records.length === 0 ? builder.meta : { ...builder.meta, subagents: treeOf(builder, records) },
      parts: builder.slots.map(slotToPart),
    };
    const previous = previousById.get(message.id);
    return previous !== undefined && deepEqual(previous, message) ? previous : message;
  });
};

/** The pull requests a fold's thread shows, newest last. */
export const pullRequestsOf = (messages: readonly TaskUIMessage[]): PullRequestData[] =>
  messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "data-pr" ? [part.data] : [])),
  );
