import type { UIMessage } from "ai";
import { z } from "zod";

import {
  approvalDecisionSchema,
  approvalIdSchema,
  approvalOptionSchema,
  memberIdSchema,
  optionIdSchema,
} from "@ostra/protocol";
import type {
  BudgetScope,
  EffortLevel,
  MemberId,
  MessageDelivery,
  MessageDeliveryState,
  MessageIntent,
  PlanEntry,
  QuestionField,
  QuestionId,
  RepoId,
  SessionId,
  SessionOutcome,
  StopReason,
  TaskEventOf,
  ToolInput,
  ToolOutput,
  TurnId,
  TurnMode,
  TurnOrigin,
  TypedToolKind,
} from "@ostra/protocol";

// The AI SDK's UIMessage with ostra's generics, derived from the protocol's Zod schemas and never
// typed again by hand (ADR 0036). `ai` is an `import type` dependency only, so it's erased.
// Ported from spikes/live-stream-and-task-view/src/shared/ui-types.ts, with milestone 1's parts.

/** The tools with a typed part: `tool-read`, `tool-edit`, `tool-execute`. Every other kind is a `dynamic-tool`. */
export type TaskUITools = {
  [K in TypedToolKind]: { input: ToolInput<K>; output: ToolOutput<K> };
};

/**
 * An approval's settled state. It rides in `toolMetadata` of the tool part, so a request that
 * closed without a decision still shows its receipt (spike 7, surprise 5).
 */
export const approvalReceiptSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("answered"),
    decision: approvalDecisionSchema,
    optionId: optionIdSchema,
    by: memberIdSchema,
  }),
  z.strictObject({ state: z.literal("auto"), ruleId: z.string() }),
  z.strictObject({ state: z.literal("closed"), reason: z.enum(["cancelled", "expired"]) }),
]);
export type ApprovalReceipt = z.infer<typeof approvalReceiptSchema>;

export type ApprovalStatus = { readonly state: "pending" } | ApprovalReceipt;

export const approvalDescriptorSchema = z.strictObject({
  options: z.array(approvalOptionSchema),
  receipt: approvalReceiptSchema.optional(),
});
export type ApprovalDescriptor = z.infer<typeof approvalDescriptorSchema>;

/** What a tool part's `toolMetadata` holds when the call asked for an approval. */
export const approvalMetadataSchema = z.strictObject({
  approval: z.strictObject({ id: approvalIdSchema, descriptor: approvalDescriptorSchema }),
});
export type ApprovalMetadata = z.infer<typeof approvalMetadataSchema>;

/** The events the thread shows as a one-line system row. */
export type SystemEvent = TaskEventOf<
  | "runner.connected"
  | "runner.lost"
  | "session.restored"
  | "session.crashed"
  | "session.config_changed"
  | "turn.cancel_requested"
>;

export type QuestionStatus =
  | { readonly state: "open" }
  | {
      readonly state: "answered";
      readonly answers: Readonly<Record<string, string>>;
      readonly answeredBy: MemberId;
    }
  | { readonly state: "closed"; readonly closedReason: "cancelled" | "expired" | "declined" };

export type QuestionData = {
  readonly questionId: QuestionId;
  readonly message: string;
  readonly fields: readonly QuestionField[];
  readonly status: QuestionStatus;
};

export type SetupOutputLine = { readonly stream: "stdout" | "stderr"; readonly text: string };

/** The environment's setup script for one session (F-050), as one row. */
export type SetupData = {
  readonly sessionId: SessionId;
  readonly state: "running" | "succeeded" | "failed";
  readonly output: readonly SetupOutputLine[];
  readonly exitCode?: number | null;
  readonly durationMs?: number;
  /** Milestone 3 (F-051): on `host`, whether the project's dependency cache was warm or cold for this box. */
  readonly dependencyCache?: "warm" | "cold";
};

export type PushedData = {
  readonly repoId: RepoId;
  readonly branch: string;
  readonly headSha: string;
  readonly ref: string;
  /** True for the hidden `refs/ostra/wip/<taskId>` ref that holds unfinished work. */
  readonly hidden: boolean;
};

export type PullRequestData = {
  readonly repoId: RepoId;
  readonly url: string;
  readonly number: number;
  /** The title the agent set through the MCP tool, when it set one. */
  readonly title?: string;
};

export type PullRequestTextData = {
  readonly repoId: RepoId;
  readonly title: string;
  readonly body: string;
};

export type SessionEndData = {
  readonly sessionId: SessionId;
  readonly outcome: SessionOutcome;
  readonly repos: readonly { readonly repoId: RepoId; readonly ahead: boolean }[];
};

/** `memberId: null`: nobody drives now (a removed member's tasks, ADR 0053). */
export type DriverChangeData = { readonly memberId: MemberId | null; readonly byMemberId: MemberId };

/** The driver changed the task's reasoning level (F-137, `effort.changed`). */
export type EffortChangeData = {
  readonly from: EffortLevel;
  readonly to: EffortLevel;
  readonly memberId: MemberId;
  /** A turn was running, so the change applies from the next one (ADR 0066). */
  readonly duringTurn: boolean;
  /** When it was recorded, in ms since the epoch. */
  readonly at: number;
};

/** Files the agent left outside every repo (Q133): their names, and how many more. Empty: they're gone. */
export type FilesOutsideReposData = { readonly paths: readonly string[]; readonly more: number };

/** Work saved after a turn (`session.saved`): the archive's size, and the hidden refs. */
export type SavedData = {
  readonly turnOrdinal: number;
  /** The session archive's size in bytes, or `null` when its upload failed. */
  readonly archiveBytes: number | null;
  /** The hidden ref's commit per repo that has one. */
  readonly hiddenRefs: readonly string[];
  /** Repos whose unfinished work wasn't saved. */
  readonly unsaved: number;
};

/** A runaway limit that stopped the session (`session.limit_reached`, F-068). */
export type LimitData = { readonly limit: "max-duration" | "stall" | "spend-cap"; readonly observed: number };

/**
 * Minor 3 (F-037, ADR 0055): the budget gate held a turn (`turn.held`), or the held turns went
 * (`turn.released`). The thread words it with the task's project and the month it was held in.
 */
export type HeldData = {
  readonly origin: TurnOrigin;
  readonly scope: BudgetScope;
  /** When it was recorded, in ms since the epoch: the month it names. */
  readonly at: number;
};
export type ReleasedData = { readonly at: number };

/** Minor 3 (F-111): the agent proposed a note for memory (`memory.proposed`); nothing reaches an agent until a member decides. */
export type MemoryProposedData = { readonly proposalId: string; readonly title: string };

/** Minor 2 (F-053, F-111): an accepted `@ostra` PR comment (`pr.comment_received`), by its seq; its text is the member message's. */
export type PrCommentData = { readonly seq: number; readonly url: string; readonly login: string; readonly path: string | null; readonly line: number | null };

/** The ticket's files, written into the workspace for the agent (`ticket.files_ready`). */
export type TicketFilesData = { readonly paths: readonly string[] };

export type TaskDataParts = {
  plan: { entries: PlanEntry[] };
  question: QuestionData;
  compaction: { status: "running" | "done"; summary?: string };
  setup: SetupData;
  pushed: PushedData;
  "pr-text": PullRequestTextData;
  pr: PullRequestData;
  "session-end": SessionEndData;
  driver: DriverChangeData;
  effort: EffortChangeData;
  "files-outside": FilesOutsideReposData;
  saved: SavedData;
  limit: LimitData;
  held: HeldData;
  released: ReleasedData;
  "memory-proposed": MemoryProposedData;
  "pr-comment": PrCommentData;
  "ticket-files": TicketFilesData;
  system: { seq: number; event: SystemEvent };
  unsupported: { seq: number; rawKind: string; acp: boolean };
  problem: { seq: number; text: string };
};

export type TokenCounts = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** True when any count in the sum was the key proxy's estimate. */
  readonly estimated: boolean;
  /** Minor 3 (F-137): the reasoning tokens inside `outputTokens`, when the endpoint reported any. */
  readonly reasoningTokens?: number;
};

/**
 * F-138: a subagent's state on the page, from its agent's reports: at work, waiting on a person
 * for one of its calls, done, failed, or stopped (interrupted, or its box ended).
 */
export type SubagentState = "running" | "needs-approval" | "done" | "failed" | "stopped";

/** A tool call's part, as the thread draws it: what a subagent's calls are, in its window. */
export type TaskToolPart = Extract<TaskUIPart, { toolCallId: string }>;

/** One round of a subagent: what it was asked, its calls and its answer. A follow-up adds one. */
export type SubagentRound = {
  /** The call that asked it, or `null` when its start never arrived. */
  readonly toolCallId: string | null;
  readonly prompt: string;
  /** When it was asked, in ms since the epoch. */
  readonly askedAt: number | null;
  readonly calls: readonly TaskToolPart[];
  /** Its last message: the answer. `null` until it says one. */
  readonly answer: string | null;
};

/** One subagent of a turn, for the badge and the window (F-138). */
export type SubagentNode = {
  readonly id: string;
  /** The subagent that started it; `null`: the main agent. */
  readonly parentId: string | null;
  readonly depth: number;
  /** The agent's own name for its kind (`explore`, `general`); `null` when its start never arrived. */
  readonly type: string | null;
  readonly description: string;
  readonly state: SubagentState;
  /** A failed subagent's error, in its agent's words. */
  readonly error?: string;
  readonly startedAt: number | null;
  /** When it ended; `null` while it runs. */
  readonly endedAt: number | null;
  /** The call that started it (its first round's). */
  readonly startedBy: string | null;
  readonly rounds: readonly SubagentRound[];
  /** Its calls, every round's. */
  readonly callCount: number;
  /** The subagents it started, in start order. */
  readonly children: readonly string[];
  /** Its start never arrived: it shows under the main agent, with a note, so nothing is lost. */
  readonly orphan: boolean;
};

/** A turn's subagents, nested ones included, as one tree under the main agent. */
export type SubagentTree = {
  /** Depth first, each parent before its children, in start order: the window's order. */
  readonly nodes: readonly SubagentNode[];
  /** The main agent's own calls in the turn. */
  readonly rootCalls: number;
  readonly counts: {
    readonly total: number;
    readonly running: number;
    readonly needsApproval: number;
    readonly failed: number;
    readonly stopped: number;
    readonly done: number;
  };
};

export type TaskMessageMeta = {
  firstSeq: number;
  lastSeq: number;
  sessionId?: SessionId;
  /** When its first event was recorded, in ms since the epoch: the time in the message's header. */
  at?: number;
  turnId?: TurnId;
  turnState?: "running" | "ended" | "failed";
  /** Milestone 3 (F-063): a plan turn's mode, so its header reads "Planning". Missing means a build turn. */
  turnMode?: TurnMode;
  /** Minor 3 (F-137): the reasoning level the turn ran at. Missing means `default`. */
  effort?: EffortLevel;
  /** Minor 3: the level asked for, when the clamp changed it (ADR 0066). */
  adjustedFrom?: EffortLevel;
  stopReason?: StopReason;
  error?: string;
  author?: {
    memberId: MemberId;
    delivery: MessageDelivery;
    /** Where the message stands now, from the log (ticket 19): a queued one reads "delivered after the turn" once its turn starts. Missing on an optimistic message. */
    deliveryState?: MessageDeliveryState;
    /** Minor 3 (F-037): the budget gate holds the turn this message would start, until a raise releases it. */
    held?: boolean;
    reopen?: boolean;
    replayed?: boolean;
    /** A replayed message: the sequence of the message it sends again, which names what that one carried. */
    replayOf?: number;
    /** Milestone 3 (ticket 46): why ostra sent it for the member (diff comments, update branch, a PR comment, fix checks, keep working). A replay keeps the first's. */
    intent?: MessageIntent;
  };
  optimistic?: boolean;
  /** The key proxy's counts for this turn (F-089): what spend comes from. */
  usage?: TokenCounts;
  /** The agent's own context figure, once per turn: the context meter only (Q124). */
  context?: { used: number; size: number };
  /** When the turn ended, in ms since the epoch: its time in the subagents' window (F-138). */
  endedAt?: number;
  /** F-138: the subagents the turn started, as a tree. Missing when it started none. */
  subagents?: SubagentTree;
};

export type TaskUIMessage = UIMessage<TaskMessageMeta, TaskDataParts, TaskUITools>;
export type TaskUIPart = TaskUIMessage["parts"][number];
export type TaskDataPart = Extract<TaskUIPart, { type: `data-${string}` }>;
