import type { UIToolInvocation } from "ai";
import type { z } from "zod";

import { messageDeliveries, typedToolSchemas } from "@ostra/protocol";
import type {
  ApprovalId,
  ApprovalOption,
  ClientMessageId,
  MemberId,
  MessageDelivery,
  PlanEntry,
  QuestionField,
  QuestionId,
  RepoId,
  SegmentId,
  SessionId,
  StopReason,
  StoredEvent,
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
  TaskMessageMeta,
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

const addUsage = (sum: TokenCounts | undefined, add: TokenCounts): TokenCounts => ({
  inputTokens: (sum?.inputTokens ?? 0) + add.inputTokens,
  outputTokens: (sum?.outputTokens ?? 0) + add.outputTokens,
  cacheReadTokens: (sum?.cacheReadTokens ?? 0) + add.cacheReadTokens,
  cacheWriteTokens: (sum?.cacheWriteTokens ?? 0) + add.cacheWriteTokens,
  estimated: (sum?.estimated ?? false) || add.estimated,
});

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
  // Where each member message stands, the same for every viewer (ticket 19): "queued" until the
  // turn that carries it starts, then "delivered after the turn".
  const deliveries = messageDeliveries(events);

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
              ...(event.reopen === true ? { reopen: true } : {}),
              ...(event.replayed === true ? { replayed: true } : {}),
            },
          },
        });
        break;
      }
      case "turn.started": {
        ensureTurn(event.turnId, sessionId, seq).meta.turnState = "running";
        break;
      }
      case "turn.ended": {
        const turn = ensureTurn(event.turnId, sessionId, seq);
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
        const turn = ensureTurn(event.turnId, sessionId, seq);
        turn.meta.turnState = "failed";
        turn.meta.error = event.error;
        break;
      }
      case "agent.message": {
        committedSegments.add(event.segmentId);
        ensureTurn(event.turnId, sessionId, seq).slots.push({
          t: "part",
          part: text(event.text, "done"),
        });
        break;
      }
      case "agent.thought": {
        committedSegments.add(event.segmentId);
        ensureTurn(event.turnId, sessionId, seq).slots.push({
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
      case "pr.comment_received":
        // Protocol minor 2. No row until the milestone 3 task page (tickets 43, 46, 47) draws them.
        break;
      case "session.config_changed":
      case "runner.connected":
      case "runner.lost":
      case "session.restored":
      case "session.crashed":
      case "turn.cancel_requested": {
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

/** The pull requests a fold's thread shows, newest last. */
export const pullRequestsOf = (messages: readonly TaskUIMessage[]): PullRequestData[] =>
  messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "data-pr" ? [part.data] : [])),
  );
