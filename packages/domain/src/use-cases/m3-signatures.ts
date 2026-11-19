import type { Db, Tx } from "@ostra/db";
import type {
  AgentProfileId,
  ApprovalDecision,
  ApprovalId,
  ApprovalRule,
  ApprovalSubject,
  BlobId,
  CheckId,
  CheckStatus,
  CliSessionId,
  DiffCommentId,
  GitSha,
  MemberId,
  NeedsYouItemId,
  NotificationDeliveryId,
  NotificationId,
  OptionId,
  PlanEntry,
  ProjectId,
  QuestionId,
  RepoId,
  SessionId,
  SnapshotFailureReason,
  SnapshotId,
  TaskApprovalRuleId,
  TaskId,
  TaskKind,
  TaskRepoId,
  TaskRule,
  TurnId,
  UserId,
} from "@ostra/protocol";

import type { MemberScope } from "../access.ts";
import type { NotificationChannel, NotificationChoice, NotificationKind } from "../notifications/choices.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import type { ReopenTaskResult } from "./reopen.ts";

// Milestone 3's use cases (spec section 5.4): each one's input, result and signature, with its
// ports. The signature is the contract the routers, core's workers and the tests are written
// against; the body comes with the ticket each names. Everything a member does goes through
// `MemberScope` and the access checks; every write is one transaction with the change notice and,
// where the spec says, the audit entry and the jobs it enqueues (ADR 0011).

/** What a milestone 3 use case takes: the database and the ports. */
export type M3Deps = { readonly db: Db } & Ports;

/**
 * Why a message sent to a task with no session going wasn't sent: the reopen it makes refused
 * (milestone 2's `reopenTask`). Added 2026-11-19 by tickets 22 to 25, which send as the composer does.
 */
export type ReopenRefusal = Exclude<ReopenTaskResult, { readonly ok: true }>["error"];

// ---------- agent profiles (F-021, ADR 0049; tickets 16, 34) ----------

/** An MCP server as a profile stores it: secret headers by reference, never by value. */
export type ProfileMcpServer =
  | {
      readonly name: string;
      readonly transport: "http";
      readonly url: string;
      readonly readOnly: boolean;
      /** Header name to its secret's reference; the values are the secret store's. */
      readonly headerSecretRefs: Readonly<Record<string, string>>;
    }
  | {
      readonly name: string;
      readonly transport: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly readOnly: boolean;
    };

export type SaveAgentProfileInput = {
  /** `null` creates one. */
  readonly profileId: AgentProfileId | null;
  readonly name: string;
  readonly adapter: string;
  readonly modelId: string | null;
  readonly instructions: string | null;
  readonly approvalRules: readonly ApprovalRule[];
  readonly planFirst: boolean;
  /** `listed` with `members`; the built-in profile is always `everyone` (ticket 07's decision). */
  readonly access: { readonly kind: "everyone" } | { readonly kind: "listed"; readonly members: readonly MemberId[] };
  /** A new header value is stored as a secret here, and only its reference kept. */
  readonly mcpServers: readonly ProfileMcpServer[];
  readonly skills: readonly { readonly name: string; readonly body: string; readonly files: readonly { readonly path: string; readonly blobId: BlobId }[] }[];
};
export type SaveAgentProfile = (
  deps: M3Deps,
  scope: MemberScope,
  input: SaveAgentProfileInput,
) => Promise<UseCaseResult<{ readonly profileId: AgentProfileId }, "forbidden" | "not-found" | "name-taken" | "built-in-is-everyones" | "archived" | "invalid-input">>;

/**
 * Archives a profile (Q189): any but the built-in one. In the same transaction every project
 * default that points at it moves to the organization's built-in profile, and the audit entry
 * names those projects. Tasks keep the profile they started with. No restore in milestone 3.
 */
export type ArchiveAgentProfile = (
  deps: M3Deps,
  scope: MemberScope,
  input: { readonly profileId: AgentProfileId },
) => Promise<UseCaseResult<{ readonly movedDefaults: readonly ProjectId[] }, "forbidden" | "not-found" | "built-in">>;

/** The profiles a member may start a task with: open to everyone, or listing them; admins see all. Never archived ones. */
export type ProfilesForMember = (
  db: Db,
  scope: MemberScope,
  input: { readonly projectId: ProjectId | null },
) => Promise<readonly { readonly profileId: AgentProfileId; readonly name: string; readonly builtIn: boolean; readonly planFirst: boolean }[]>;

/** A project's default profile for a task kind: it must be open to every member of the project. */
export type SetProjectDefaultProfile = (
  deps: M3Deps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly kind: TaskKind; readonly profileId: AgentProfileId },
) => Promise<UseCaseResult<{ readonly profileId: AgentProfileId }, "forbidden" | "not-found" | "not-open-to-every-member" | "archived">>;

// ---------- approvals, questions, plans (F-026, F-024, F-063; tickets 17, 18) ----------

/** An `approval.requested` stored: the approval, its item (audience: the driver, else the project), the task to needs you, a fan-out. */
export type RecordApprovalRequested = (
  deps: M3Deps,
  tx: Tx,
  input: {
    readonly taskId: TaskId;
    readonly sessionId: SessionId;
    readonly approvalId: ApprovalId;
    readonly rule: { readonly source: "profile" | "task"; readonly ruleId: string; readonly name: string } | null;
    readonly subject: ApprovalSubject | null;
  },
) => Promise<UseCaseResult<{ readonly itemId: NeedsYouItemId }, "not-found" | "not-running">>;

/**
 * A member's answer (F-026, extended): `allow_task` writes a `TaskApprovalRule` first and sends it in
 * the command; a deny carries the optional reason. The first answer wins by a compare-and-set.
 */
export type AnswerApprovalInput = {
  readonly approvalId: ApprovalId;
  readonly decision: ApprovalDecision;
  readonly optionId: OptionId;
  /** With `deny`: shown to the project's members, never logged or audited. */
  readonly reason: string | null;
};
export type AnswerApproval = (
  deps: M3Deps,
  scope: MemberScope,
  input: AnswerApprovalInput,
) => Promise<UseCaseResult<{ readonly taskRule: TaskRule | null; readonly reopened: boolean }, "not-found" | "already-answered" | "no-pattern" | "invalid-input">>;

/** The driver's answer to a question (Q168); anyone else is refused with "Take over to answer". */
export type AnswerQuestion = (
  deps: M3Deps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly questionId: QuestionId; readonly answers: Readonly<Record<string, string>> },
) => Promise<UseCaseResult<{ readonly reopened: boolean }, "not-found" | "not-driver" | "already-answered" | "invalid-input">>;

/** A `plan.proposed` stored: the task to needs you (`plan`), the item, `planState: proposed`, a fan-out. */
export type RecordPlanProposed = (
  deps: M3Deps,
  tx: Tx,
  input: { readonly taskId: TaskId; readonly turnId: TurnId; readonly entries: readonly PlanEntry[]; readonly message: string },
) => Promise<UseCaseResult<{ readonly itemId: NeedsYouItemId }, "not-found" | "not-running">>;

/** The driver's "Approve plan" (as shown or edited) or "Ask for changes": a `plan-answer` command, or a reopen. */
export type AnswerPlan = (
  deps: M3Deps,
  scope: MemberScope,
  input:
    | { readonly taskId: TaskId; readonly decision: "approve"; readonly entries: readonly PlanEntry[]; readonly message: string }
    | { readonly taskId: TaskId; readonly decision: "revise"; readonly request: string },
) => Promise<UseCaseResult<{ readonly reopened: boolean }, "not-found" | "not-driver" | "no-plan" | "invalid-input">>;

// ---------- notifications and email (F-036, F-115; tickets 20, 21) ----------

/** Fan-out of one item's change: one notification per member, one delivery per channel, keyed (ADR 0050). */
export type FanOutNotification = (
  deps: M3Deps,
  input: { readonly itemId: NeedsYouItemId; readonly change: "created" | "answered" | "dismissed" },
) => Promise<UseCaseResult<{ readonly notifications: number; readonly deliveries: number }, "not-found">>;

/**
 * Why a delivery was skipped: the member read it first, the item was no longer open, the channel is
 * off for them, mail is off for the install, they have no address, the task has no ticket, or there was nothing to edit.
 */
export type DeliverySkipReason = "read" | "closed" | "channel-off" | "mail-off" | "no-address" | "no-ticket" | "nothing-to-edit";

/** A delivery's outcome, from `notify.deliver`. `error` holds words and IDs, never a body. */
export type RecordDelivery = (
  deps: M3Deps,
  input:
    | { readonly deliveryId: NotificationDeliveryId; readonly outcome: "sent"; readonly providerMessageId: string | null }
    | { readonly deliveryId: NotificationDeliveryId; readonly outcome: "skipped"; readonly why: DeliverySkipReason }
    | { readonly deliveryId: NotificationDeliveryId; readonly outcome: "failed"; readonly error: string; readonly retryAfterMs: number | null },
) => Promise<UseCaseResult<{ readonly deliveryId: NotificationDeliveryId }, "not-found">>;

export type MarkNotificationRead = (
  deps: M3Deps,
  scope: MemberScope,
  input: { readonly notificationIds: readonly NotificationId[] },
) => Promise<UseCaseResult<{ readonly marked: number }, never>>;

/** A member's choices; the panel's can't be turned off. Each saved row gets `updatedAt`. */
export type SaveNotificationPreferences = (
  deps: M3Deps,
  scope: MemberScope,
  input: { readonly choices: readonly NotificationChoice[] },
) => Promise<UseCaseResult<{ readonly saved: number }, "panel-is-always-on">>;

/** The instance's email (instance admin only), refused while settings lock it. */
export type SaveEmailSettingsInput =
  | { readonly provider: "off" }
  | { readonly provider: "resend"; readonly fromAddress: string; readonly fromName: string; readonly apiKey: string | null }
  | {
      readonly provider: "smtp";
      readonly fromAddress: string;
      readonly fromName: string;
      readonly host: string;
      readonly port: number;
      readonly secure: "starttls" | "tls" | "none";
      readonly user: string | null;
      /** `null` keeps the stored one. Stored through the secret store; never logged. */
      readonly password: string | null;
    };
export type SaveEmailSettings = (
  deps: M3Deps,
  actor: { readonly userId: UserId; readonly instanceAdmin: boolean },
  input: SaveEmailSettingsInput,
) => Promise<UseCaseResult<{ readonly provider: SaveEmailSettingsInput["provider"] }, "forbidden" | "locked-by-settings" | "invalid-input">>;

/** The channels a member's moment goes out on, for the settings page's grid. */
export type NotificationChannels = readonly NotificationChannel[];
export type { NotificationKind };

// ---------- the diff and its comments (F-027, F-072; ticket 22) ----------

/** Creates, edits or deletes a member's own draft, after checking the line exists in that head's diff. */
export type SaveDiffComment = (
  deps: M3Deps,
  scope: MemberScope,
  input:
    | {
        readonly action: "create";
        readonly taskRepoId: TaskRepoId;
        readonly path: string;
        readonly side: "old" | "new";
        readonly line: number;
        readonly headSha: GitSha;
        readonly body: string;
      }
    | { readonly action: "edit"; readonly commentId: DiffCommentId; readonly body: string }
    | { readonly action: "delete"; readonly commentId: DiffCommentId },
) => Promise<UseCaseResult<{ readonly commentId: DiffCommentId }, "not-found" | "not-yours" | "no-such-line" | "too-long" | "sent">>;

/** "Send N comments to the agent": the member's drafts to `sent` and one member message, as the composer sends. */
export type SendDiffComments = (
  deps: M3Deps,
  scope: MemberScope,
  input: { readonly taskId: TaskId },
) => Promise<UseCaseResult<{ readonly sent: number; readonly delivery: "steer" | "reopen" }, "not-found" | "no-drafts" | "take-over-to-send" | "too-many" | ReopenRefusal>>;

// ---------- checks, behind, update branch, @ostra (F-054, F-070, F-053; tickets 23 to 25) ----------

/** The `check.*` events of a turn stored as `CheckRun` rows. */
export type RecordChecksRun = (
  deps: M3Deps,
  tx: Tx,
  input: {
    readonly taskId: TaskId;
    readonly sessionId: SessionId;
    readonly turnOrdinal: number;
    readonly checks: readonly { readonly checkId: CheckId; readonly status: CheckStatus; readonly exitCode: number | null; readonly durationMs: number; readonly outputBlobId: BlobId | null }[];
  },
) => Promise<UseCaseResult<{ readonly failed: number }, "not-found">>;

/** "Update branch": a member message naming each repo that's behind (`intent: "update-branch"`), sent as the composer sends. */
export type RequestUpdateBranch = (
  deps: M3Deps,
  scope: MemberScope,
  input: { readonly taskId: TaskId },
) => Promise<UseCaseResult<{ readonly repos: number; readonly delivery: "steer" | "reopen" }, "not-found" | "nothing-behind" | "take-over-to-send" | ReopenRefusal>>;

/** A repo's `behind` recomputed from the compare (the reconcile and `push` webhooks). */
export type RecordBehind = (
  deps: M3Deps,
  input: { readonly taskRepoId: TaskRepoId; readonly behindBy: number; readonly baseSha: GitSha },
) => Promise<UseCaseResult<{ readonly changed: boolean }, "not-found">>;

/** An `@ostra` comment accepted: the 👀 reaction, `pr.comment_received` and a member message, or dropped by IDs. */
export type AcceptPrComment = (
  deps: M3Deps,
  input: {
    readonly repoId: RepoId;
    readonly prNumber: number;
    readonly commentId: string;
    readonly commenterGithubUserId: string;
    readonly commenterLogin: string;
    readonly text: string;
    readonly url: string;
    readonly path: string | null;
    readonly line: number | null;
  },
) => Promise<UseCaseResult<{ readonly taskId: TaskId; readonly delivery: "queued" | "reopen" }, "no-task" | "not-a-member" | "no-access" | ReopenRefusal>>;

// ---------- the verified link, after a merge, a closed ticket (F-119, F-066; tickets 24, 25, 39) ----------

/** Keeps the verified GitHub ID and login on the account: unique per install. */
export type LinkGitHubUser = (
  deps: M3Deps,
  input: { readonly userId: UserId; readonly githubUserId: string; readonly githubLogin: string },
) => Promise<UseCaseResult<{ readonly githubLogin: string }, "linked-to-someone-else">>;

export type UnlinkGitHubUser = (deps: M3Deps, input: { readonly userId: UserId }) => Promise<UseCaseResult<{ readonly unlinked: true }, "not-linked">>;

/** A reopen of a merged task: each merged repo gets `<old branch>-N` from the base's head, and keeps its PR in `TaskPullRequest`. */
export type ReopenAfterMerge = (
  deps: M3Deps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly text: string },
) => Promise<UseCaseResult<{ readonly freshBranches: readonly { readonly taskRepoId: TaskRepoId; readonly branchName: string }[] }, "not-found" | "not-merged">>;

/** The ticket closed while the task ran: interrupt, `ticket_closed`, needs you, a fan-out. */
export type RecordTicketClosed = (
  deps: M3Deps,
  input: { readonly taskId: TaskId; readonly status: string; readonly category: "done" | "cancelled" },
) => Promise<UseCaseResult<{ readonly interrupted: boolean }, "not-found" | "not-running">>;

// ---------- snapshots (F-051; ticket 26) ----------

export type ScheduleSnapshot = (
  deps: M3Deps,
  input: { readonly projectId: ProjectId; readonly reason: "environment-changed" | "lockfile-changed" | "nightly" },
) => Promise<UseCaseResult<{ readonly snapshotId: SnapshotId | null }, "no-docker-runner" | "not-found">>;

export type RecordSnapshotResult = (
  deps: M3Deps,
  input:
    | { readonly snapshotId: SnapshotId; readonly outcome: "built"; readonly imageDigest: string; readonly durationMs: number; readonly runnerId: string }
    | { readonly snapshotId: SnapshotId; readonly outcome: "failed"; readonly reason: SnapshotFailureReason; readonly detail: string },
) => Promise<UseCaseResult<{ readonly snapshotId: SnapshotId }, "not-found" | "not-building">>;

// ---------- CLI sessions (F-103; ticket 39) ----------

/** A device code approved with purpose `cli`: a session whose token is shown once and stored hashed. */
export type StartCliSession = (
  deps: M3Deps,
  input: { readonly userId: UserId; readonly memberId: MemberId; readonly machineName: string },
) => Promise<UseCaseResult<{ readonly sessionId: CliSessionId; readonly token: string; readonly expiresAt: number }, never>>;

export type RevokeCliSession = (
  deps: M3Deps,
  actor: { readonly userId: UserId },
  input: { readonly sessionId: CliSessionId },
) => Promise<UseCaseResult<{ readonly sessionId: CliSessionId }, "not-found" | "not-yours">>;

/** IDs a few of these use cases take, kept together so a router imports them from one place. */
export type M3Ids = {
  readonly taskApprovalRuleId: TaskApprovalRuleId;
  readonly notificationId: NotificationId;
};
