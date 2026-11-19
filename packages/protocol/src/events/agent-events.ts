import { z } from "zod";

import {
  approvalIdSchema,
  approvalRuleIdSchema,
  blobIdSchema,
  boxIdSchema,
  budgetIdSchema,
  checkIdSchema,
  clientMessageIdSchema,
  diffCommentIdSchema,
  memberIdSchema,
  modelIdSchema,
  noteIdSchema,
  optionIdSchema,
  proposalIdSchema,
  providerIdSchema,
  questionIdSchema,
  repoIdSchema,
  runnerIdSchema,
  segmentIdSchema,
  sessionIdSchema,
  snapshotIdSchema,
  taskApprovalRuleIdSchema,
  taskIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "../ids.ts";
import {
  branchNameSchema,
  epochMsSchema,
  gitShaSchema,
  httpUrlSchema,
  imageDigestSchema,
  leaseEpochSchema,
  serviceNameSchema,
  sessionSeqSchema,
  taskSeqSchema,
} from "../common.ts";
import { effortLevelSchema } from "../agent/effort.ts";
import { approvalSubjectSchema, taskRuleSchema } from "../agent/rules.ts";
import { memoryNoteTitleSchema, memoryUseViaSchema } from "../memory/notes.ts";
import { blobRefSchema } from "../runner/blobs.ts";
import { runnerLimits } from "../runner/limits.ts";
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

// ---------- protocol minor 1's vocabularies (milestone 2) ----------

/**
 * How a reopened session came back (ADR 0039's three steps): the same box (`resumed`), a fresh box
 * from the session archive and the hidden ref (`restored`), or the rebuild template (`rebuilt`).
 */
export const restoreOriginSchema = z.enum(["resumed", "restored", "rebuilt"]);
export type RestoreOrigin = z.infer<typeof restoreOriginSchema>;

/** What happened to the saved work in progress on a restore (ADR 0039, Q150). */
export const hiddenRefOutcomeSchema = z.enum([
  /** The hidden ref was restored, and the branch's newer commits merged in. */
  "applied",
  /** There was no hidden ref to restore. */
  "none",
  /** Merging the branch's newer commits conflicted: nothing restored, the branch's head checked out. */
  "conflict",
]);
export type HiddenRefOutcome = z.infer<typeof hiddenRefOutcomeSchema>;

/** What became of the box the task ran on before, so the thread can say why it moved. */
export const previousBoxSchema = z.enum(["kept", "released", "lost"]);
export type PreviousBox = z.infer<typeof previousBoxSchema>;

/** Why a session crashed (F-047): the agent's process died, or the box itself went away. */
export const crashCauseSchema = z.enum(["agent_exited", "box_lost"]);
export type CrashCause = z.infer<typeof crashCauseSchema>;

/** The runaway limits (F-068). Core times the first two; the runner's key proxy enforces the third. */
export const sessionLimitSchema = z.enum(["max-duration", "stall", "spend-cap"]);
export type SessionLimit = z.infer<typeof sessionLimitSchema>;

/** A file name inside the ticket folder: one segment, no `..`, no separators. */
export const ticketFileNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!\.{1,2}$)[A-Za-z0-9._ -]+$/, "one file name inside the ticket folder");

/** The workspace folder ticket files are written to; the workspace's git excludes it (spec section 11, item 9). */
export const TICKET_FILES_DIR = ".ostra/ticket";

/**
 * The content types a ticket file is written for (spec section 11, item 9, a working value), and
 * each one's extension: images and PDFs. Anything else is skipped.
 */
export const TICKET_FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
};

/**
 * A ticket file's name in `TICKET_FILES_DIR` (ticket 26): made from its blob ID and content type,
 * never from the ticket's text, so core names the same file in the prompt (`contextFiles[].path`)
 * as the runner writes. `null` for a type that isn't written.
 */
export const ticketFileNameFor = (blobId: string, contentType: string): string | null => {
  const extension = TICKET_FILE_EXTENSIONS[contentType.toLowerCase()];
  if (extension === undefined) {
    return null;
  }
  const stem = blobId.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 120);
  return `${stem === "" ? "file" : stem}.${extension}`;
};

/** Why a ticket file wasn't written (minor 2, on `ticket.files_ready`). */
export const ticketFileSkipReasonSchema = z.enum([
  /** Not an image or a PDF. */
  "type-not-allowed",
  /** The bulk path didn't give it. */
  "download-failed",
  /** Its bytes didn't match their digest or their size. */
  "digest-mismatch",
  /** It couldn't be written into the workspace. */
  "write-failed",
]);
export type TicketFileSkipReason = z.infer<typeof ticketFileSkipReasonSchema>;

/** One repo's state after a turn, in `session.saved`. */
export const savedRepoSchema = z.strictObject({
  repoId: repoIdSchema,
  /** The branch's head after the push, or `null` when nothing was ever committed or the push failed. */
  headSha: gitShaSchema.nullable(),
  /** Whether the branch is ahead of its base. */
  ahead: z.boolean(),
  /** The commit `refs/ostra/wip/<taskId>` points at, or `null` when the save failed. */
  hiddenRefSha: gitShaSchema.nullable(),
});
export type SavedRepo = z.infer<typeof savedRepoSchema>;

// ---------- the events whose shape changed in minor 1 ----------

const userMessageV0 = z.strictObject({
  kind: z.literal("user.message"),
  memberId: memberIdSchema,
  clientMessageId: clientMessageIdSchema,
  /** The member's text. Never logged. */
  text: z.string(),
  delivery: messageDeliverySchema,
});

const userMessage = userMessageV0.extend({
  /** Minor 1: the member's message a lost box never answered, replayed as a new session's first prompt. */
  replayed: z.literal(true).optional(),
  /** Minor 1: the message a reopen wrote, for the thread's reopen tag. */
  reopen: z.literal(true).optional(),
});

const sessionRestoredV0 = z.strictObject({ kind: z.literal("session.restored") });

const sessionRestored = sessionRestoredV0.extend({
  /** Minor 1: which of ADR 0039's steps brought the session back. Missing on a minor-0 event. */
  origin: restoreOriginSchema.optional(),
  /** Minor 1: how many `session/load` updates were replay, never stored as new events. */
  replayedUpdates: z.number().int().nonnegative().optional(),
  /** Minor 1: what became of the saved work in progress. */
  hiddenRef: hiddenRefOutcomeSchema.optional(),
  /** Minor 1: what became of the box before this one. */
  previousBox: previousBoxSchema.optional(),
});

const sessionCrashedV0 = z.strictObject({ kind: z.literal("session.crashed"), error: z.string().max(4000) });

const sessionCrashed = sessionCrashedV0.extend({
  /** Minor 1: whether the agent died or the box went away. */
  cause: crashCauseSchema.optional(),
});

// ---------- the events new in minor 1 ----------

const sessionSaved = z.strictObject({
  kind: z.literal("session.saved"),
  /** The turn this save followed, from 1 within the session. */
  turnOrdinal: z.number().int().positive(),
  repos: z.array(savedRepoSchema),
  /** The uploaded session archive, or `null` when its export or upload failed. That never fails the turn. */
  archive: blobRefSchema.nullable(),
});

const sessionLimitReached = z.strictObject({
  kind: z.literal("session.limit_reached"),
  limit: sessionLimitSchema,
  /** What was measured: minutes, micro-USD or tokens. A number, never content. */
  observed: z.number().nonnegative(),
});

const ticketFilesReady = z.strictObject({
  kind: z.literal("ticket.files_ready"),
  /** Each file written under `TICKET_FILES_DIR`, by its name there and its blob. */
  files: z
    .array(z.strictObject({ path: ticketFileNameSchema, blobId: blobIdSchema }))
    .max(runnerLimits.ticketFilesMax),
});

/**
 * One name in the workspace root (Q133, milestone 2's ticket 44): a file or a folder beside the
 * repos' checkouts, top level only, never a path that climbs or descends.
 */
export const workspaceEntryNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => name !== "." && name !== ".." && !/[/\\\u0000]/.test(name), "a name in the workspace root, with no separator");

/**
 * Files the agent left in the workspace root, outside every repo (Q133): no branch, hidden ref or
 * PR carries them. At most `filesOutsideReposMax` names, and how many more there were. Sent when
 * the set changes, an empty list when they're gone. The names are content: never logged.
 */
const workspaceFilesOutsideRepos = z.strictObject({
  kind: z.literal("workspace.files_outside_repos"),
  paths: z.array(workspaceEntryNameSchema).max(runnerLimits.filesOutsideReposMax),
  more: z.number().int().nonnegative(),
});

// ---------- protocol minor 2's vocabularies (milestone 3) ----------

/** How a turn runs (ADR 0049, F-063): a plan turn reads and never writes; a build turn works. */
export const turnModeSchema = z.enum(["plan", "build"]);
export type TurnMode = z.infer<typeof turnModeSchema>;

/**
 * Why a member's message was written (milestone 3): typed in the composer, or rendered by ostra
 * from diff comments, "Update branch", a plan revision, an `@ostra` comment, "Ask the agent to
 * fix" or "Keep working". The thread draws each with its own marker.
 */
export const messageIntentSchema = z.enum([
  "message",
  "diff-comments",
  "update-branch",
  "plan-revision",
  "pr-comment",
  "fix-checks",
  "keep-working",
]);
export type MessageIntent = z.infer<typeof messageIntentSchema>;

/** A check's result (ADR 0052, F-054). */
export const checkStatusSchema = z.enum(["passed", "failed", "timed-out", "error"]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

/** Why a snapshot build failed (F-051, ADR 0038). `secret-found`: the image scan found a setup secret's value. */
export const snapshotFailureReasonSchema = z.enum(["setup-failed", "secret-found", "build-failed"]);
export type SnapshotFailureReason = z.infer<typeof snapshotFailureReasonSchema>;

/** The rule that asked for an approval, for the card and the receipt (ADR 0049). */
export const approvalRuleRefSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("profile"), ruleId: approvalRuleIdSchema, name: z.string().min(1).max(200) }),
  z.strictObject({ source: z.literal("task"), ruleId: taskApprovalRuleIdSchema, name: z.string().min(1).max(200) }),
]);
export type ApprovalRuleRef = z.infer<typeof approvalRuleRefSchema>;

/** A plan's entries, at most `planEntriesMax`. */
export const planEntriesSchema = z.array(planEntrySchema).max(runnerLimits.planEntriesMax);

/** A plan turn's message or an approved plan's text: capped (64 KiB), never logged. */
export const planTextSchema = z.string().max(runnerLimits.planMessageMaxBytes);

/** A deny's reason (ADR 0049): shown to the project's members, never logged, never in the audit entry. */
export const denyReasonSchema = z.string().trim().min(1).max(runnerLimits.denyReasonMaxChars);

/** A check's result as `session.saved` carries it, for the PR opener. */
export const savedCheckSchema = z.strictObject({ checkId: checkIdSchema, status: checkStatusSchema });
export type SavedCheck = z.infer<typeof savedCheckSchema>;

// ---------- the events whose shape changed in minor 2 ----------

const turnStartedV1 = z.strictObject({ kind: z.literal("turn.started"), turnId: turnIdSchema });

const turnStartedV2 = turnStartedV1.extend({
  /** Minor 2: a plan turn or a build turn. Missing means `build`. */
  mode: turnModeSchema.optional(),
});

/** `turn.started` at the current minor (3): minor 2's, with the level the turn ran at (F-137). */
const turnStarted = turnStartedV2.extend({
  /** Minor 3: the reasoning level the turn ran at. Missing means `default`, or a turn before minor 3. */
  effort: effortLevelSchema.optional(),
  /** Minor 3: the level asked for, when the clamp changed it (ADR 0066). */
  adjustedFrom: effortLevelSchema.optional(),
});

const approvalRequestedV1 = z.strictObject({
  kind: z.literal("approval.requested"),
  turnId: turnIdSchema,
  approvalId: approvalIdSchema,
  toolCallId: toolCallIdSchema,
  options: z.array(approvalOptionSchema).min(1),
});

const approvalRequested = approvalRequestedV1.extend({
  /** Minor 2: the rule that asked, or `null` when the agent asked on its own. */
  rule: approvalRuleRefSchema.nullable().optional(),
  /** Minor 2: what the request touches, which the card shows and "for this task" narrows. Never logged. */
  subject: approvalSubjectSchema.optional(),
});

const approvalAnsweredV1 = z.strictObject({
  kind: z.literal("approval.answered"),
  approvalId: approvalIdSchema,
  optionId: optionIdSchema,
  decision: approvalDecisionSchema,
  memberId: memberIdSchema,
});

const approvalAnswered = approvalAnsweredV1.extend({
  /** Minor 2: a deny's reason. Never logged, never in the audit entry. */
  reason: denyReasonSchema.optional(),
  /** Minor 2: the task rule "Approve for this task" wrote, or `null`. */
  taskRule: taskRuleSchema.nullable().optional(),
});

const userMessageV2 = userMessage.extend({
  /** Minor 2: why the message was written. Missing means `message`. */
  intent: messageIntentSchema.optional(),
});

const sessionRestoredV2 = sessionRestored.extend({
  /** Minor 2: why a restore fell back to the rebuild template, in words (ticket 24). Never content. */
  fallbackReason: z.string().min(1).max(500).optional(),
});

const ticketFilesReadyV2 = ticketFilesReady.extend({
  /** Minor 2: the files that weren't written, each with why (ticket 26). The turn starts anyway. */
  skipped: z
    .array(z.strictObject({ blobId: blobIdSchema, reason: ticketFileSkipReasonSchema }))
    .max(runnerLimits.ticketFilesMax)
    .optional(),
});

const setupFinishedV1 = z.strictObject({
  kind: z.literal("environment.setup_finished"),
  /** `null` when the script was killed by a signal or a timeout. */
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
});

const setupFinished = setupFinishedV1.extend({
  /** Minor 2, `host`: whether the project's dependency cache was there already (F-051, ADR 0038). */
  dependencyCache: z.enum(["warm", "cold"]).optional(),
  /**
   * Minor 2, `docker`: whether the box started from the spec's snapshot image, or fell back to a
   * full setup because this runner doesn't hold it (F-051, ADR 0038).
   */
  snapshot: z.enum(["used", "fell-back"]).optional(),
});

const sessionSavedV2 = sessionSaved.extend({
  /** Minor 2: the checks run after the turn, in order, for the PR opener (ADR 0052). */
  checks: z.array(savedCheckSchema).max(runnerLimits.checksMax).optional(),
});

/** `usage.recorded` at minors 0 to 2 (F-089, ADR 0042, ADR 0036). */
const usageRecordedV2 = z.strictObject({
  kind: z.literal("usage.recorded"),
  providerId: providerIdSchema,
  modelId: modelIdSchema,
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheWriteTokens: tokenCount,
  /** True when the endpoint reported no usage and the key proxy estimated it. */
  estimated: z.boolean(),
});

/** `usage.recorded` at the current minor (3): minor 2's, with the reasoning subset (F-137). */
const usageRecorded = usageRecordedV2.extend({
  /** Minor 3: the reasoning tokens, a part of `outputTokens`, where the endpoint reports them. Missing means 0. */
  reasoningTokens: tokenCount.optional(),
});

// ---------- the events new in minor 2 ----------

const minor2NewEventOptions = [
  // ---- plan first (F-063) ----
  z.strictObject({
    kind: z.literal("plan.proposed"),
    turnId: turnIdSchema,
    entries: planEntriesSchema,
    /** The plan turn's last agent message. Never logged. */
    message: planTextSchema,
  }),
  z.strictObject({
    kind: z.literal("plan.answered"),
    decision: z.enum(["approve", "revise"]),
    /** The plan as approved, or the driver's request for changes. Never logged. */
    text: planTextSchema,
    memberId: memberIdSchema,
    /** On an approve: the plan as approved, structured, for the receipt's `edited` marks. */
    entries: planEntriesSchema.optional(),
    /** On an approve: the plan's message as approved. Never logged. */
    message: planTextSchema.optional(),
  }),

  // ---- checks (F-054, ADR 0052) ----
  z.strictObject({
    kind: z.literal("check.started"),
    checkId: checkIdSchema,
    /** The repo the check runs in, or `null` for the workspace root (Q188). */
    repoId: repoIdSchema.nullable(),
    name: z.string().min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal("check.finished"),
    checkId: checkIdSchema,
    status: checkStatusSchema,
    /** `null` when the check was killed (a timeout) or never started (an error). */
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    /** The output's end, at most 16 KiB. Never logged. */
    outputTail: z.string().max(runnerLimits.checkOutputTailMaxBytes),
    /** The full output as a blob, or `null` when its upload failed. */
    outputBlobId: blobIdSchema.nullable(),
  }),

  // ---- snapshots and services (F-051, F-094) ----
  z.strictObject({
    kind: z.literal("snapshot.built"),
    snapshotId: snapshotIdSchema,
    imageDigest: imageDigestSchema,
    durationMs: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("snapshot.failed"),
    snapshotId: snapshotIdSchema,
    reason: snapshotFailureReasonSchema,
    /** Words for the panel, never a secret's value or the build's output. */
    detail: z.string().max(2000),
  }),
  z.strictObject({
    kind: z.literal("service.healthy"),
    name: serviceNameSchema,
    afterMs: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("service.failed"),
    name: serviceNameSchema,
    /** Words for the panel, never the service's output. */
    reason: z.string().max(2000),
  }),

  // ---- server-only (milestone 3) ----
  z.strictObject({
    kind: z.literal("diff.comments_sent"),
    /** The drafts the member message carried (F-072). */
    commentIds: z.array(diffCommentIdSchema).min(1).max(runnerLimits.diffCommentsPerSendMax),
    count: z.number().int().positive().max(runnerLimits.diffCommentsPerSendMax),
  }),
  z.strictObject({
    kind: z.literal("ticket.closed"),
    /** The ticket's new status, as the tracker names it. */
    status: z.string().min(1).max(200),
    category: z.enum(["done", "cancelled"]),
  }),
  z.strictObject({
    kind: z.literal("pr.comment_received"),
    /** The `@ostra` comment's URL. Its text is in the member message, never here. */
    url: httpUrlSchema,
    /** The commenter's code host login. */
    login: z.string().min(1).max(100),
    /** For a line comment, its file and line; `null` for a PR comment. */
    path: z.string().min(1).max(1024).nullable(),
    line: z.number().int().positive().nullable(),
  }),
] as const;

// ---------- protocol minor 3's vocabularies (milestone 4) ----------

/**
 * What starts a turn, for the budget gate (F-037, ADR 0055): one closed list, so every origin
 * passes the same gate and a new one can't skip it.
 */
export const turnOriginSchema = z.enum([
  "dispatch",
  "reopen",
  "message",
  "diff-comments",
  "update-branch",
  "pr-comment",
  "keep-working",
  "closing-turn",
  "automatic-round",
]);
export type TurnOrigin = z.infer<typeof turnOriginSchema>;

/** Whose budget held a turn: the organization's or the project's (ADR 0055). */
export const budgetScopeSchema = z.enum(["organization", "project"]);
export type BudgetScope = z.infer<typeof budgetScopeSchema>;

/** The independent-review check's result on one head (F-104, ADR 0040). */
export const reviewCheckStatusSchema = z.enum(["pending", "passed"]);
export type ReviewCheckStatus = z.infer<typeof reviewCheckStatusSchema>;

const prNumberSchema = z.number().int().positive();

/** A PR of another repo of the same task, for a PR's "Related" section (F-098). */
export const relatedPullRequestSchema = z.strictObject({ repoId: repoIdSchema, prNumber: prNumberSchema });
export type RelatedPullRequest = z.infer<typeof relatedPullRequestSchema>;

// ---------- the events new in minor 3 ----------

const minor3NewEventOptions = [
  // ---- memory (F-110, F-111, ADR 0044) ----
  z.strictObject({
    kind: z.literal("memory.used"),
    /** The notes the session saw this way. IDs only, never a note's text. */
    noteIds: z.array(noteIdSchema).min(1).max(runnerLimits.memoryIndexMaxNotes * 2),
    via: memoryUseViaSchema,
  }),
  // ---- server-only (milestone 4) ----
  z.strictObject({
    kind: z.literal("memory.proposed"),
    proposalId: proposalIdSchema,
    /** The proposal's title, for the thread. Never logged. */
    title: memoryNoteTitleSchema,
  }),
  z.strictObject({
    kind: z.literal("turn.held"),
    origin: turnOriginSchema,
    budgetId: budgetIdSchema,
    scope: budgetScopeSchema,
  }),
  z.strictObject({ kind: z.literal("turn.released"), budgetId: budgetIdSchema }),
  z.strictObject({
    kind: z.literal("review.check_updated"),
    repoId: repoIdSchema,
    prNumber: prNumberSchema,
    headSha: gitShaSchema,
    status: reviewCheckStatusSchema,
    /** The member whose approval passed it, or `null` while it's pending. */
    approverMemberId: memberIdSchema.nullable(),
    /** Words for the thread, never a review's text. */
    reason: z.string().max(2000),
  }),
  z.strictObject({
    kind: z.literal("pr.related_updated"),
    repoId: repoIdSchema,
    prNumber: prNumberSchema,
    related: z.array(relatedPullRequestSchema).max(runnerLimits.projectReposMax),
  }),
  // ---- reasoning effort (F-137, ADR 0066), server-only ----
  z.strictObject({
    kind: z.literal("effort.changed"),
    from: effortLevelSchema,
    to: effortLevelSchema,
    /** The driver who changed it. */
    memberId: memberIdSchema,
  }),
] as const;

// ---------- protocol minor 4's vocabularies (milestone 5) ----------

/**
 * Why a box is still being made (F-093, ADR 0060): the cluster has no node for its pod yet (the
 * autoscaler is adding one), or its image is still being pulled.
 */
export const boxWaitingReasonSchema = z.enum(["node", "image-pull"]);
export type BoxWaitingReason = z.infer<typeof boxWaitingReasonSchema>;

// ---------- the events new in minor 4 ----------

const minor4NewEventOptions = [
  // ---- a box on its way (F-093) ----
  z.strictObject({
    kind: z.literal("box.waiting"),
    boxId: boxIdSchema,
    reason: boxWaitingReasonSchema,
    /** When the wait started, in ms since the epoch, by the runner's clock. */
    since: epochMsSchema,
  }),
  z.strictObject({
    kind: z.literal("box.scheduled"),
    boxId: boxIdSchema,
    /** How long the box waited before it was scheduled. */
    afterMs: z.number().int().nonnegative(),
  }),
  // ---- server-only (milestone 5) ----
  /** A queued task an admin cancelled from its pool's queue (F-067). */
  z.strictObject({ kind: z.literal("task.cancelled"), memberId: memberIdSchema }),
  /** The task's runner was drained by an admin (F-092): it finishes this task and takes no new one. */
  z.strictObject({ kind: z.literal("runner.drained"), memberId: memberIdSchema }),
  /** The task's runner was resumed by an admin (F-092). */
  z.strictObject({ kind: z.literal("runner.resumed"), memberId: memberIdSchema }),
] as const;

// ---------- the events every minor shares ----------

const sharedEventOptions = [
  // ---- members and turns ----
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
  // `memberId: null`: nobody drives now, as when the driver is removed from the organization (ADR 0053).
  z.strictObject({ kind: z.literal("driver.changed"), memberId: memberIdSchema.nullable(), byMemberId: memberIdSchema }),
  z.strictObject({ kind: z.literal("runner.connected"), runnerId: runnerIdSchema }),
  z.strictObject({ kind: z.literal("runner.lost"), runnerId: runnerIdSchema }),
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
  // `environment.setup_finished` grew in minor 2: `setupFinished` and `setupFinishedV1` above.

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
  // `usage.recorded` grew in minor 3: `usageRecorded` and `usageRecordedV2` above.
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
] as const;

/** The event union at the current minor (4). */
export const taskEventSchema = z.discriminatedUnion("kind", [
  userMessageV2,
  sessionRestoredV2,
  sessionCrashed,
  sessionSavedV2,
  sessionLimitReached,
  ticketFilesReadyV2,
  workspaceFilesOutsideRepos,
  turnStarted,
  usageRecorded,
  approvalRequested,
  approvalAnswered,
  setupFinished,
  ...minor2NewEventOptions,
  ...minor3NewEventOptions,
  ...minor4NewEventOptions,
  ...sharedEventOptions,
]);

/**
 * Minor 3's event union, kept for the codecs (ADR 0034): a minor-3 peer's events parse with it,
 * and it refuses minor 4's kinds.
 */
export const taskEventSchemaV3 = z.discriminatedUnion("kind", [
  userMessageV2,
  sessionRestoredV2,
  sessionCrashed,
  sessionSavedV2,
  sessionLimitReached,
  ticketFilesReadyV2,
  workspaceFilesOutsideRepos,
  turnStarted,
  usageRecorded,
  approvalRequested,
  approvalAnswered,
  setupFinished,
  ...minor2NewEventOptions,
  ...minor3NewEventOptions,
  ...sharedEventOptions,
]);

/**
 * Minor 2's event union, kept for the codecs (ADR 0034): a minor-2 peer's events parse with it,
 * and it refuses minor 3's kinds.
 */
export const taskEventSchemaV2 = z.discriminatedUnion("kind", [
  userMessageV2,
  sessionRestoredV2,
  sessionCrashed,
  sessionSavedV2,
  sessionLimitReached,
  ticketFilesReadyV2,
  workspaceFilesOutsideRepos,
  turnStartedV2,
  usageRecordedV2,
  approvalRequested,
  approvalAnswered,
  setupFinished,
  ...minor2NewEventOptions,
  ...sharedEventOptions,
]);

/**
 * Minor 1's event union, kept for the codecs (ADR 0034): a minor-1 peer's events parse with it,
 * and it refuses minor 2's kinds and fields.
 */
export const taskEventSchemaV1 = z.discriminatedUnion("kind", [
  userMessage,
  sessionRestored,
  sessionCrashed,
  sessionSaved,
  sessionLimitReached,
  ticketFilesReady,
  workspaceFilesOutsideRepos,
  turnStartedV1,
  usageRecordedV2,
  approvalRequestedV1,
  approvalAnsweredV1,
  setupFinishedV1,
  ...sharedEventOptions,
]);

/**
 * Minor 0's event union, kept for the codecs (ADR 0034): a minor-0 peer's events parse with it,
 * and it refuses minor 1's kinds and fields.
 */
export const taskEventSchemaV0 = z.discriminatedUnion("kind", [
  userMessageV0,
  sessionRestoredV0,
  sessionCrashedV0,
  turnStartedV1,
  usageRecordedV2,
  approvalRequestedV1,
  approvalAnsweredV1,
  setupFinishedV1,
  ...sharedEventOptions,
]);

export type TaskEvent = z.infer<typeof taskEventSchema>;
export type TaskEventKind = TaskEvent["kind"];
export type TaskEventOf<K extends TaskEventKind> = Extract<TaskEvent, { kind: K }>;

/**
 * The kinds minor 1 added. A sender never makes one for a peer at a lower minor: the runner
 * checks the negotiated minor before it records one, so its session numbers stay gap-free.
 */
export const minor1EventKinds: ReadonlySet<TaskEventKind> = new Set<TaskEventKind>([
  "session.saved",
  "session.limit_reached",
  "ticket.files_ready",
  "workspace.files_outside_repos",
]);

/** The kinds minor 2 added (milestone 3). As with minor 1's, a sender checks the minor first. */
export const minor2EventKinds: ReadonlySet<TaskEventKind> = new Set<TaskEventKind>(
  minor2NewEventOptions.map((option) => option.shape.kind.value),
);

/**
 * The kinds minor 3 added (milestone 4). A minor-3 runner talking to a minor-2 server sends no
 * `memory.used`; the rest are the server's own.
 */
export const minor3EventKinds: ReadonlySet<TaskEventKind> = new Set<TaskEventKind>(
  minor3NewEventOptions.map((option) => option.shape.kind.value),
);

/**
 * The kinds minor 4 added (milestone 5). A minor-4 runner talking to a minor-3 server sends no
 * `box.waiting` or `box.scheduled`; the rest are the server's own.
 */
export const minor4EventKinds: ReadonlySet<TaskEventKind> = new Set<TaskEventKind>(
  minor4NewEventOptions.map((option) => option.shape.kind.value),
);

/**
 * The kinds a runner may also send outside a task, in a `runner-event` frame: a snapshot build's
 * result when no task triggered the build (F-051).
 */
export const runnerScopedEventKinds: ReadonlySet<TaskEventKind> = new Set<TaskEventKind>([
  "snapshot.built",
  "snapshot.failed",
]);

/** The lowest minor that carries an event kind. */
export const eventKindMinMinor = (kind: TaskEventKind): number => {
  if (minor4EventKinds.has(kind)) {
    return 4;
  }
  if (minor3EventKinds.has(kind)) {
    return 3;
  }
  if (minor2EventKinds.has(kind)) {
    return 2;
  }
  return minor1EventKinds.has(kind) ? 1 : 0;
};

/** Whether a peer at `minor` can read an event of `kind`. */
export const eventKindSupportedAt = (kind: TaskEventKind, minor: number): boolean =>
  eventKindMinMinor(kind) <= minor;

// Minor 1's shapes of the events that grew in minor 2, as stripping objects: parsing a current
// event with one keeps minor 1's fields and drops the rest.
const userMessageStripV1 = z.object(userMessage.shape);
const turnStartedStripV1 = z.object(turnStartedV1.shape);
const approvalRequestedStripV1 = z.object(approvalRequestedV1.shape);
const approvalAnsweredStripV1 = z.object(approvalAnsweredV1.shape);
const sessionSavedStripV1 = z.object(sessionSaved.shape);
const sessionRestoredStripV1 = z.object(sessionRestored.shape);
const ticketFilesReadyStripV1 = z.object(ticketFilesReady.shape);
const setupFinishedStripV1 = z.object(setupFinishedV1.shape);

// Minor 2's shapes of the events that grew in minor 3, as stripping objects.
const turnStartedStripV2 = z.object(turnStartedV2.shape);
const usageRecordedStripV2 = z.object(usageRecordedV2.shape);

/** An event without the fields minor 3 added: what a minor-2 peer reads. */
const dropMinor3Fields = (event: TaskEvent): TaskEvent => {
  if (event.kind === "turn.started") {
    return turnStartedStripV2.parse(event);
  }
  if (event.kind === "usage.recorded") {
    return usageRecordedStripV2.parse(event);
  }
  return event;
};

/** An event without the fields minor 2 added: what a minor-1 peer reads. */
const dropMinor2Fields = (event: TaskEvent): TaskEvent => {
  if (event.kind === "user.message") {
    return userMessageStripV1.parse(event);
  }
  if (event.kind === "turn.started") {
    return turnStartedStripV1.parse(event);
  }
  if (event.kind === "approval.requested") {
    return approvalRequestedStripV1.parse(event);
  }
  if (event.kind === "approval.answered") {
    return approvalAnsweredStripV1.parse(event);
  }
  if (event.kind === "session.saved") {
    return sessionSavedStripV1.parse(event);
  }
  if (event.kind === "session.restored") {
    return sessionRestoredStripV1.parse(event);
  }
  if (event.kind === "ticket.files_ready") {
    return ticketFilesReadyStripV1.parse(event);
  }
  if (event.kind === "environment.setup_finished") {
    return setupFinishedStripV1.parse(event);
  }
  return event;
};

/**
 * An event as a peer at `minor` reads it: below minor 2, the fields minor 2 added are dropped;
 * below minor 1, minor 1's too. Below minor 3, `turn.started` loses its level and
 * `usage.recorded` its reasoning tokens (F-137). A kind the minor lacks is returned as it is, and
 * that peer refuses it: senders check `eventKindSupportedAt` first.
 */
export const encodeEventForMinor = (event: TaskEvent, minor: number): TaskEvent => {
  if (minor >= 3) {
    return event;
  }
  const v2 = dropMinor3Fields(event);
  if (minor >= 2) {
    return v2;
  }
  const v1 = dropMinor2Fields(v2);
  if (minor >= 1) {
    return v1;
  }
  if (v1.kind === "user.message") {
    return {
      kind: v1.kind,
      memberId: v1.memberId,
      clientMessageId: v1.clientMessageId,
      text: v1.text,
      delivery: v1.delivery,
    };
  }
  if (v1.kind === "session.restored") {
    return { kind: v1.kind };
  }
  if (v1.kind === "session.crashed") {
    return { kind: v1.kind, error: v1.error };
  }
  return v1;
};

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
  // Minor 2 (milestone 3):
  "plan.answered",
  "diff.comments_sent",
  "ticket.closed",
  "pr.comment_received",
  // Minor 3 (milestone 4):
  "memory.proposed",
  "turn.held",
  "turn.released",
  "review.check_updated",
  "pr.related_updated",
  "effort.changed",
  // Minor 4 (milestone 5):
  "task.cancelled",
  "runner.drained",
  "runner.resumed",
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

/** Minor 3's `runnerEventSchema`, for the up codec of a minor-3 peer. */
export const runnerEventSchemaV3 = runnerEventSchema.extend({
  event: taskEventSchemaV3.refine((event) => !serverOnlyKinds.has(event.kind), {
    message: "only the server writes this kind",
  }),
});

/** Minor 2's `runnerEventSchema`, for the up codec of a minor-2 peer. */
export const runnerEventSchemaV2 = runnerEventSchema.extend({
  event: taskEventSchemaV2.refine((event) => !serverOnlyKinds.has(event.kind), {
    message: "only the server writes this kind",
  }),
});

/** Minor 1's `runnerEventSchema`, for the up codec of a minor-1 peer. */
export const runnerEventSchemaV1 = runnerEventSchema.extend({
  event: taskEventSchemaV1.refine((event) => !serverOnlyKinds.has(event.kind), {
    message: "only the server writes this kind",
  }),
});

/** Minor 0's `runnerEventSchema`, for the up codec of a minor-0 peer. */
export const runnerEventSchemaV0 = runnerEventSchema.extend({
  event: taskEventSchemaV0.refine((event) => !serverOnlyKinds.has(event.kind), {
    message: "only the server writes this kind",
  }),
});
