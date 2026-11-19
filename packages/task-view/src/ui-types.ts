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
  MemberId,
  MessageDelivery,
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

export type DriverChangeData = { readonly memberId: MemberId; readonly byMemberId: MemberId };

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
  "files-outside": FilesOutsideReposData;
  saved: SavedData;
  limit: LimitData;
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
};

export type TaskMessageMeta = {
  firstSeq: number;
  lastSeq: number;
  sessionId?: SessionId;
  /** When its first event was recorded, in ms since the epoch: the time in the message's header. */
  at?: number;
  turnId?: TurnId;
  turnState?: "running" | "ended" | "failed";
  stopReason?: StopReason;
  error?: string;
  author?: { memberId: MemberId; delivery: MessageDelivery; reopen?: boolean; replayed?: boolean };
  optimistic?: boolean;
  /** The key proxy's counts for this turn (F-089): what spend comes from. */
  usage?: TokenCounts;
  /** The agent's own context figure, once per turn: the context meter only (Q124). */
  context?: { used: number; size: number };
};

export type TaskUIMessage = UIMessage<TaskMessageMeta, TaskDataParts, TaskUITools>;
export type TaskUIPart = TaskUIMessage["parts"][number];
export type TaskDataPart = Extract<TaskUIPart, { type: `data-${string}` }>;
