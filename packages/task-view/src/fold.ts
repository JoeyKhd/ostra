import type { UIToolInvocation } from "ai";
import type { z } from "zod";

import { RECORD_APP_TOOL, TAKE_SCREENSHOT_TOOL, messageDeliveries, typedToolSchemas } from "@ostra/protocol";
import type {
  ApprovalId,
  ApprovalOption,
  ClientMessageId,
  ImagesNotSent,
  MemberId,
  MessageDelivery,
  MessageFileId,
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
import { messageFileViewOf, noRemovedFiles } from "./message-files.ts";
import type {
  ApprovalDescriptor,
  ApprovalReceipt,
  ApprovalStatus,
  AppProcessData,
  AttachmentItem,
  AttachmentsData,
  MessageFileLeftOut,
  MessageFileSkipped,
  MessageFileView,
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
  /**
   * Milestone 9 (F-148, ticket 15): the files it carries while it sends, drawn from the browser's
   * own copies (`downloadPath` a `blob:` URL), until the committed message brings the stored ones.
   */
  readonly files?: readonly MessageFileView[];
};

export type FoldOptions = {
  readonly optimistic?: readonly OptimisticMessage[];
  /** The previous result, so unchanged messages keep their identity. */
  readonly previous?: readonly TaskUIMessage[];
  /**
   * Milestone 9 (ticket 14): the message files whose blobs are gone (`tasks.files`' `downloadPath:
   * null`), so their downloads show as removed. Every other file downloads from its route.
   */
  readonly removedFiles?: ReadonlySet<MessageFileId>;
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
  /**
   * F-121: an app-picture call (`take_screenshot`, `record_app`) whose picture came: the capture row
   * stands in its place, so the call isn't drawn twice.
   */
  absorbed?: boolean;
};

/** F-121: a run of pictures in a turn, as the fold builds it. */
type AttachmentsRecord = {
  kind: AttachmentsData["kind"];
  source: AttachmentsData["source"];
  items: AttachmentItem[];
  lastInTurn: boolean;
  turnId: AttachmentsData["turnId"];
  turnAt: number | null;
};

/** F-140: one start of an app process, as the fold builds it: its line updates in place. */
type AppProcessRecord = {
  -readonly [K in keyof AppProcessData]: AppProcessData[K];
} & { startedAt: number | null };

/** Whether a call is one of ostra's app-picture tools, whatever prefix its agent names it with (`ostra_take_screenshot`). */
const isPictureTool = (title: string): boolean =>
  [TAKE_SCREENSHOT_TOOL, RECORD_APP_TOOL].some((name) => title === name || title.endsWith(`_${name}`) || title.endsWith(`.${name}`) || title.endsWith(`/${name}`));

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

/** Milestone 9 (ticket 14): a member's message's files, as the fold builds them: `files.written` updates them. */
type MessageFilesRecord = {
  seq: number;
  files: MessageFileView[];
  leftOut: MessageFileLeftOut[];
  imagesNotSent: ImagesNotSent | null;
  skipped: MessageFileSkipped[];
};

type Slot =
  | { t: "part"; part: TaskUIPart }
  | { t: "message-files"; id: string; rec: MessageFilesRecord }
  | { t: "tool"; rec: ToolRecord }
  | { t: "question"; rec: QuestionRecord }
  | { t: "plan"; id: string; entries: PlanEntry[] }
  | { t: "compaction"; id: string; status: "running" | "done"; summary?: string }
  | { t: "setup"; id: string; rec: SetupRecord }
  | { t: "attachments"; id: string; rec: AttachmentsRecord }
  | { t: "app-process"; id: string; rec: AppProcessRecord };

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
    case "message-files":
      return {
        type: "data-message-files",
        id: slot.id,
        data: { seq: slot.rec.seq, files: slot.rec.files.map((file) => ({ ...file })), leftOut: [...slot.rec.leftOut], imagesNotSent: slot.rec.imagesNotSent, skipped: [...slot.rec.skipped] },
      };
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
    case "attachments":
      return { type: "data-attachments", id: slot.id, data: { ...slot.rec, items: [...slot.rec.items] } };
    case "app-process": {
      const { name, port, state, exitCode, reason, logBlobId, readyAfterMs } = slot.rec;
      return { type: "data-app-process", id: slot.id, data: { name, port, state, exitCode, reason, logBlobId, readyAfterMs } };
    }
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
  // F-140: each app process's line while it runs, by session and name: its later states update it.
  const openApps = new Map<string, { readonly rec: AppProcessRecord; readonly owner: Builder }>();
  // F-121: "the box has no browser" is said once per task.
  let noBrowserShown = false;
  // Milestone 9 (ticket 14): each message's files, by each file's ID, so the runner's `files.written`
  // finds the message it wrote them for; and the files whose blobs are gone.
  const messageFilesOf = new Map<MessageFileId, { readonly rec: MessageFilesRecord; readonly owner: Builder }>();
  const removedFiles = options.removedFiles ?? noRemovedFiles;

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

  /** A row of its own outside any turn, holding one slot that later events may update. */
  const slotRow = (id: string, seq: number, sessionId: SessionId, slot: Slot): Builder =>
    push({ id, role: "system", slots: [slot], meta: { firstSeq: seq, lastSeq: seq, sessionId } });

  /** The session's turn while it runs: where the agent's app lines go. Outside a turn, `undefined`. */
  const runningTurnOf = (sessionId: SessionId): Builder | undefined => {
    const turn = lastTurnBySession.get(sessionId);
    return turn?.meta.turnState === "running" ? turn : undefined;
  };

  /**
   * F-121: a picture at its place. In a turn, a screenshot joins the run of screenshots just
   * before it (by the same hand), and a recording starts its own; the agent's own call to the tool
   * that took it is folded into the row. A member's from the pane, or one with no turn, is a row.
   */
  const addAttachment = (seq: number, sessionId: SessionId, item: AttachmentItem): void => {
    const turn = item.source === "member" ? undefined : lastTurnBySession.get(sessionId);
    const id = `attachments:${String(seq)}`;
    if (turn === undefined) {
      slotRow(id, seq, sessionId, { t: "attachments", id, rec: { kind: item.kind, source: item.source, items: [item], lastInTurn: false, turnId: null, turnAt: null } });
      return;
    }
    touch(turn, seq);
    if (item.source === "agent") {
      const call = turn.slots.findLast(
        (slot): slot is Extract<Slot, { t: "tool" }> => slot.t === "tool" && slot.rec.absorbed !== true && slot.rec.outcome?.type !== "failed" && isPictureTool(slot.rec.title),
      );
      if (call !== undefined) call.rec.absorbed = true;
    }
    const last = turn.slots.findLast((slot) => !(slot.t === "tool" && slot.rec.absorbed === true));
    if (last?.t === "attachments" && last.rec.kind === "screenshot" && item.kind === "screenshot" && last.rec.source === item.source) {
      last.rec.items.push(item);
      return;
    }
    for (const slot of turn.slots) if (slot.t === "attachments") slot.rec.lastInTurn = false;
    turn.slots.push({ t: "attachments", id, rec: { kind: item.kind, source: item.source, items: [item], lastInTurn: true, turnId: turn.meta.turnId ?? null, turnAt: turn.meta.at ?? null } });
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
        const slots: Slot[] = [{ t: "part", part: text(event.text, "done") }];
        // Milestone 9 (F-148, ticket 14): its files under its words, each with its download, and
        // what the limits left out. A replay's files keep their folder: the first message's number.
        const files = event.files ?? [];
        const leftOut = event.filesLeftOut ?? [];
        let filesRecord: MessageFilesRecord | null = null;
        if (files.length > 0 || leftOut.length > 0) {
          filesRecord = {
            seq: replayOf?.seq ?? seq,
            files: files.map((file) => messageFileViewOf(stored.taskId, file, removedFiles.has(file.fileId))),
            leftOut: leftOut.map((note) => ({ name: note.name, reason: note.reason, size: note.size ?? null })),
            imagesNotSent: event.imagesNotSent ?? null,
            skipped: [],
          };
          slots.push({ t: "message-files", id: `files:${String(seq)}`, rec: filesRecord });
        }
        const owner = push({
          id: `user:${event.clientMessageId}`,
          role: "user",
          slots,
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
        if (filesRecord !== null) {
          for (const file of files) messageFilesOf.set(file.fileId, { rec: filesRecord, owner });
        }
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
      case "app.process": {
        // F-140: one line per start of a process, updated in place by its later states.
        const key = `${sessionId}:${event.name}`;
        const open = openApps.get(key);
        const ended = event.state === "exited" || event.state === "failed" || event.state === "stopped";
        if (open === undefined || event.state === "starting") {
          // A process that stops before anything was said of it says nothing.
          if (event.state === "stopped") break;
          const rec: AppProcessRecord = {
            name: event.name,
            port: event.port,
            state: event.state,
            exitCode: event.exitCode,
            reason: event.reason,
            logBlobId: event.logBlobId,
            readyAfterMs: null,
            startedAt: event.state === "starting" ? stored.at : null,
          };
          const id = `app:${String(seq)}`;
          const turn = runningTurnOf(sessionId);
          let owner: Builder;
          if (turn === undefined) owner = slotRow(id, seq, sessionId, { t: "app-process", id, rec });
          else {
            touch(turn, seq);
            turn.slots.push({ t: "app-process", id, rec });
            owner = turn;
          }
          if (!ended) openApps.set(key, { rec, owner });
          break;
        }
        const { rec } = open;
        if (event.state === "stopped" && rec.state === "ready") {
          // Stopped with its box once it was ready: the box's end says so, and its line keeps how it started.
          openApps.delete(key);
          break;
        }
        rec.state = event.state;
        rec.port = event.port;
        rec.exitCode = event.exitCode;
        rec.reason = event.reason;
        rec.logBlobId = event.logBlobId ?? rec.logBlobId;
        if (event.state === "ready" && rec.startedAt !== null) rec.readyAfterMs = Math.max(0, stored.at - rec.startedAt);
        touch(open.owner, seq);
        if (ended) openApps.delete(key);
        break;
      }
      case "app.browser": {
        // F-121: a box without a browser takes no pictures: said once per task, where the turn is.
        if (event.browser.available || noBrowserShown) break;
        noBrowserShown = true;
        const part: TaskUIPart = { type: "data-no-browser", id: `no-browser:${String(seq)}`, data: { reason: event.browser.reason } };
        const turn = runningTurnOf(sessionId);
        if (turn === undefined) row(seq, sessionId, part);
        else {
          touch(turn, seq);
          turn.slots.push({ t: "part", part });
        }
        break;
      }
      case "attachment.added": {
        addAttachment(seq, sessionId, {
          attachmentId: event.attachmentId,
          kind: event.attachmentKind,
          source: event.source,
          target: event.target,
          path: event.path,
          width: event.width,
          height: event.height,
          durationMs: event.durationMs,
          frameCount: event.frameCount,
          caption: event.caption,
          browser: { name: event.browser.name, version: event.browser.version },
          memberId: event.memberId,
          at: stored.at,
        });
        break;
      }
      case "attachment.skipped": {
        // Ticket 13: the after-turn screenshots that weren't taken, at the turn's end; a member's, a row.
        const part: TaskUIPart = { type: "data-attachment-skipped", id: `skipped:${String(seq)}`, data: { source: event.source, reason: event.reason, count: event.count } };
        const turn = event.source === "member" ? undefined : lastTurnBySession.get(sessionId);
        if (turn === undefined) row(seq, sessionId, part);
        else {
          touch(turn, seq);
          turn.slots.push({ t: "part", part });
        }
        break;
      }
      case "preview.list":
      case "preview.dropped":
      case "preview.opened":
      case "preview.closed":
      case "preview.level_changed":
      case "preview.link_created":
      case "preview.link_revoked":
      case "app.started_by":
        // Protocol minor 7 (milestone 8, ADR 0068). No row: the preview pane (ticket 21) reads them.
        break;
      case "box.lost":
        // A pool runner's runner event (F-047): core records it as `session.crashed`, never as itself.
        break;
      case "files.written": {
        // Milestone 9 (ticket 14): what the runner wrote into the box, onto the messages the files
        // are of. A file written clears an earlier skip (a fresh box writes every file again); a
        // skipped one is named under its message with why. A prompt whose images went as files
        // because the agent advertised none says so under its message.
        const touched = new Set<MessageFilesRecord>();
        for (const written of event.files) {
          const found = messageFilesOf.get(written.fileId);
          if (found === undefined) continue;
          found.rec.skipped = found.rec.skipped.filter((skip) => skip.fileId !== written.fileId);
          touched.add(found.rec);
          touch(found.owner, seq);
        }
        for (const skip of event.skipped) {
          const found = messageFilesOf.get(skip.fileId);
          const file = found?.rec.files.find((one) => one.fileId === skip.fileId);
          if (found === undefined || file === undefined) continue;
          found.rec.skipped = [...found.rec.skipped.filter((one) => one.fileId !== skip.fileId), { fileId: skip.fileId, name: file.name, reason: skip.reason }];
          touched.add(found.rec);
          touch(found.owner, seq);
        }
        const [only] = touched;
        if (event.imagesAsFiles !== null && touched.size === 1 && only?.files.some((file) => file.asImage) === true) {
          only.files = only.files.map((file) => ({ ...file, asImage: false }));
          only.imagesNotSent = "agent";
        }
        break;
      }
      case "ticket.context_read":
        // Protocol minor 8 (milestone 9, ADR 0070): server-only; "What the agent got" reads the
        // rounds from `tasks.ticketContext` (ticket 14), and the thread draws it (ticket 16).
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
    const files = optimistic.files ?? [];
    push({
      id: `user:${optimistic.clientMessageId}`,
      role: "user",
      slots: [
        { t: "part", part: text(optimistic.text, "done") },
        ...(files.length === 0 ? [] : [{ t: "message-files" as const, id: `files:${optimistic.clientMessageId}`, rec: { seq: 0, files: [...files], leftOut: [], imagesNotSent: null, skipped: [] } }]),
      ],
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
      // F-121: an app-picture call whose picture came is drawn as the picture's row only.
      parts: builder.slots.filter((slot) => !(slot.t === "tool" && slot.rec.absorbed === true)).map(slotToPart),
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
