import type { AgentSessionEvent, CiResults } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import type {
  AgentActivityId,
  AgentProfileId,
  AgentSessionId,
  AutomationId,
  BoardId,
  BulkStartId,
  BulkStartItemId,
  ConnectionId,
  DraftId,
  EnvironmentId,
  EnvironmentProposal,
  EnvironmentProposalId,
  FindingId,
  OrganizationId,
  ProjectId,
  RefineDraft,
  RepoId,
  ReviewRunId,
  RunnerId,
  SessionId,
  SubmitReviewInput,
  TaskId,
  TaskKind,
  TaskRepoId,
  TicketId,
  TicketKey,
  TicketWriteId,
} from "@ostra/protocol";

import type { MemberScope } from "../access.ts";
import type { IntakeFilter } from "../automations/intake-filter.ts";
import type { AgentSessionMoment } from "../linear/agent-session-copy.ts";
import type { AutomationSkipReason, RoundVerdict } from "../lifecycles/m6.ts";
import type { Ports } from "../ports.ts";
import type { CiVerdict } from "../review-loop/ci-verdict.ts";
import type { TaskRoundKind } from "../review-loop/rounds.ts";
import type { Leaves, OneActiveTaskError, StartOrigin, StartRule } from "../starts/start-task.ts";
import type { UseCaseResult } from "./common.ts";
import type { AgentModeCapabilities } from "./linear-connection.ts";

// Milestone 6's use cases (spec section 5.4; ADR 0056, ADR 0057, ADR 0058): each one's input, result
// and signature, with its ports. The signature is the contract the routers, core's workers and the
// tests are written against; the bodies come with tickets 10 to 21. The pure parts have their bodies
// in `../automations/`, `../starts/`, `../review-loop/`, `../linear/` and `../prompts/m6.ts`. Every
// write is one transaction with its change notice, its audit entry and the jobs it enqueues
// (ADR 0011, ADR 0037). No input carries text a log could take: prompts, drafts, findings and logs
// are stored as data and never logged.

/** What a milestone 6 use case takes: the database and the ports. */
export type M6Deps = { readonly db: Db } & Ports;

/** A use case that runs inside the caller's transaction. */
export type M6TxDeps = { readonly tx: Tx } & Pick<Ports, "clock" | "notices" | "jobs" | "audit">;

// ---------- automations: rules and schedules (F-011, F-106; tickets 10, 11, 24) ----------

/** An automation as a project admin saves it: an intake rule, or a schedule of a filter or a prompt. */
export type AutomationSettings = {
  readonly name: string;
  readonly taskKind: TaskKind;
  readonly agentProfileId: AgentProfileId | null;
  readonly poolLabels: readonly string[];
  readonly requireApproval: boolean;
} & (
  | { readonly kind: "intake_rule"; readonly filter: IntakeFilter }
  | {
      readonly kind: "schedule";
      /** Five fields, at least `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES` apart. */
      readonly schedule: string;
      readonly timeZone: string;
      readonly skipWhileOpen: boolean;
      /** The rule's filter it checks, or the one prompt task it starts. */
      readonly does: { readonly kind: "filter"; readonly filter: IntakeFilter } | { readonly kind: "prompt"; readonly title: string; /** Never logged. */ readonly prompt: string };
    }
);

export type SaveAutomation = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly automationId: AutomationId | null; readonly settings: AutomationSettings },
) => Promise<
  UseCaseResult<{ readonly automationId: AutomationId; readonly nextOccurrenceAt: number | null }, "forbidden" | "not-found" | "invalid-input" | "schedule-too-often" | "name-taken">
>;

export type PauseAutomation = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly automationId: AutomationId; readonly paused: boolean },
) => Promise<UseCaseResult<{ readonly pausedAt: number | null }, "forbidden" | "not-found" | "not-allowed-in-state">>;

/** Deleted at the next tick; its tasks keep running. */
export type DeleteAutomation = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly automationId: AutomationId },
) => Promise<UseCaseResult<{ readonly deletedAt: number }, "forbidden" | "not-found">>;

/** What a start would do for one ticket, as the dry run lists it. */
export type DryRunRow = {
  readonly ticketId: TicketId;
  readonly key: TicketKey;
  readonly outcome: { readonly kind: "would-start"; readonly rule: StartRule } | { readonly kind: "would-skip"; readonly reason: AutomationSkipReason | "has-task" | "matched-before" };
};

export type DryRunAutomation = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly filter: IntakeFilter; readonly automationId: AutomationId | null },
) => Promise<UseCaseResult<{ readonly rows: readonly DryRunRow[]; readonly total: number }, "forbidden" | "not-found">>;

/** On a ticket's ingest: every enabled rule the ticket starts to match, once per ticket per rule. */
export type MatchIntakeRules = (
  deps: M6TxDeps,
  input: { readonly organizationId: OrganizationId; readonly ticketId: TicketId; readonly trackerUpdatedAt: number },
) => Promise<{ readonly started: readonly AutomationId[]; readonly skipped: readonly { readonly automationId: AutomationId; readonly reason: AutomationSkipReason }[] }>;

/** `scheduler.tick`: the due occurrences, each inserted once with its job, in one transaction. */
export type TickScheduler = (deps: M6Deps) => Promise<{ readonly occurrences: number; readonly missed: number }>;

/** `automation.occurrence`: an occurrence's start through `startTask`, or its skip. */
export type RunOccurrence = (
  deps: M6Deps,
  input: { readonly organizationId: OrganizationId; readonly automationId: AutomationId; readonly occurrenceAt: number },
) => Promise<UseCaseResult<{ readonly state: "started" | "skipped" | "missed"; readonly taskId: TaskId | null }, "not-found">>;

// ---------- starting many (F-107, F-010; tickets 11, 25) ----------

export type StartMany = (
  deps: M6Deps,
  scope: MemberScope,
  input: {
    readonly projectId: ProjectId;
    readonly ticketIds: readonly TicketId[];
    readonly taskKind: TaskKind;
    readonly agentProfileId: AgentProfileId | null;
    /** The member's request's key: a retried request starts nothing twice. */
    readonly requestKey: string;
    readonly source: "inbox" | "dry_run";
    readonly automationId: AutomationId | null;
  },
) => Promise<UseCaseResult<{ readonly bulkStartId: BulkStartId }, "forbidden" | "not-found" | "invalid-input" | "too-many">>;

/** `bulk.start-item`: one ticket, in its own transaction. */
export type StartBulkItem = (
  deps: M6Deps,
  input: { readonly organizationId: OrganizationId; readonly bulkStartItemId: BulkStartItemId },
) => Promise<{ readonly state: "started" | "skipped" | "failed"; readonly taskId: TaskId | null; readonly reason: string | null }>;

// ---------- the one start (every origin; tickets 11 to 14, 21) ----------

export type StartTaskInput = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly origin: StartOrigin;
  readonly kind: TaskKind;
  readonly ticketId: TicketId | null;
  /** Never logged. A ticket's task takes its prompt from the ticket. */
  readonly prompt: string | null;
  readonly title: string | null;
  readonly agentProfileId: AgentProfileId | null;
  readonly poolLabels: readonly string[];
  /** Ticket 11: the member's own personal runner, or unset to pick from the project's pools. Refused for a pool-only task. */
  readonly runnerId?: RunnerId | null;
};

export type StartTaskError =
  | "forbidden"
  | "not-found"
  | "invalid-input"
  | "no-default-profile"
  | OneActiveTaskError["code"]
  // Ticket 11: the refusals milestones 1 to 4's starts already had, which now come from here.
  | "no-agent-profile"
  | "no-repo"
  | "runner-not-yours"
  | "provider-not-allowed-on-personal-runners"
  | "no-provider-for-model"
  | "repo-unsupported"
  // Ticket 12 (F-077): a code start on a ticket with open sub-issues; its leaves start instead (`startSubIssues`).
  | "has-sub-issues";

/** What a start may add to its ports (ticket 11): each optional, so a caller with only the ports starts a task. */
export type StartTaskOptions = {
  /** The member's scope, for a member's own start: the profile they chose must be one they may use (ADR 0049). */
  readonly scope?: MemberScope;
  /** The panel's address: the link to the task that goes on the ticket. */
  readonly publicUrl?: string;
  /** A prompt task's branch naming; a test fakes it to force two tasks onto one name. */
  readonly branchNameFor?: (taskId: TaskId, title: string, digits: number) => string;
};

export type StartTaskResult =
  | UseCaseResult<
      { readonly taskId: TaskId; readonly rule: StartRule; readonly sessionId: SessionId; readonly branchName: string },
      Exclude<StartTaskError, OneActiveTaskError["code"]>
    >
  /** The one-active-task rule (F-010): the ticket's active code task. */
  | { readonly ok: false; readonly error: OneActiveTaskError["code"]; readonly message: string; readonly taskId: TaskId };

/** Every start goes through here: the outside rule, the one-active-task rule, then the queue. */
export type StartTask = (deps: M6TxDeps & StartTaskOptions, input: StartTaskInput) => Promise<StartTaskResult>;

/** A code start on a parent ticket: its leaves, as a bulk start; the parent never runs (F-077). */
export type StartSubIssues = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly ticketId: TicketId; readonly agentProfileId: AgentProfileId | null; readonly requestKey: string },
) => Promise<UseCaseResult<{ readonly bulkStartId: BulkStartId | null; readonly leaves: Leaves }, "forbidden" | "not-found">>;

// ---------- Linear agent mode and outside tasks (F-012, F-040; tickets 13, 14, 26) ----------

/** An organization admin turns agent mode on for the Linear connection, after the app's Authorize. */
export type EnableAgentMode = (
  /** `tracker`: what the connection's tracker declares about agent sessions (`LinearAppKit.capabilities`). */
  deps: M6Deps & { readonly tracker: AgentModeCapabilities },
  scope: MemberScope,
  input: { readonly connectionId: ConnectionId },
) => Promise<UseCaseResult<{ readonly agentModeAt: number }, "forbidden" | "not-found" | "missing-scopes" | "unsupported">>;

/** "Start from Linear" on a board: at most one board per team per organization. */
export type SetBoardAgentMode = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly boardId: BoardId; readonly on: boolean },
) => Promise<UseCaseResult<{ readonly on: boolean }, "forbidden" | "not-found" | "team-taken" | "agent-mode-off">>;

/** `linear.agent-event`: a session's created, prompted or stop event, claimed before the 200. */
export type HandleAgentSessionEvent = (
  deps: M6Deps,
  input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId; readonly deliveryId: string; readonly event: AgentSessionEvent },
) => Promise<{ readonly agentSessionId: AgentSessionId; readonly taskId: TaskId | null; readonly posted: readonly AgentSessionMoment["kind"][] }>;

/** Writes an activity to the outbox, keyed, and moves the heartbeat on. */
export type PostAgentActivity = (
  deps: M6TxDeps,
  input: { readonly organizationId: OrganizationId; readonly agentSessionId: AgentSessionId; readonly moment: AgentSessionMoment; readonly idempotencyKey: string },
) => Promise<{ readonly agentActivityId: AgentActivityId; readonly created: boolean }>;

/** `linear.heartbeat`: a post for each active session whose heartbeat is due. */
export type SendHeartbeats = (deps: M6Deps) => Promise<{ readonly sent: number }>;

/** The panel's address, for the task links an agent session's posts carry (ticket 14). */
export type M6LinkDeps = M6Deps & { readonly publicUrl: string };

export type ApproveOutsideTask = (
  deps: M6LinkDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId },
) => Promise<UseCaseResult<{ readonly approvedAt: number }, "forbidden" | "not-found" | "not-awaiting-approval">>;

export type RejectOutsideTask = (
  deps: M6LinkDeps,
  scope: MemberScope,
  /** The reason is shown to the project's members, never logged. */
  input: { readonly taskId: TaskId; readonly reason: string | null },
) => Promise<UseCaseResult<{ readonly stoppedAt: number }, "forbidden" | "not-found" | "not-awaiting-approval">>;

/** Only an organization admin switches it off (ADR 0057). */
export type SetOutsideApproval = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly on: boolean },
) => Promise<UseCaseResult<{ readonly on: boolean }, "forbidden" | "not-found">>;

// ---------- refine drafts (F-099; tickets 15, 27) ----------

export type SaveDraft = (
  deps: M6TxDeps,
  input: { readonly organizationId: OrganizationId; readonly taskId: TaskId; readonly draft: RefineDraft },
) => Promise<UseCaseResult<{ readonly draftId: DraftId; readonly version: number }, "wrong-kind" | "invalid" | "limit-reached">>;

export type EditDraft = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly baseVersion: number; readonly draft: RefineDraft },
) => Promise<UseCaseResult<{ readonly draftId: DraftId; readonly version: number }, "forbidden" | "not-found" | "conflict" | "invalid-input" | "task-done">>;

/** "Update ticket": the version, through the ticket outbox; sub-tickets as sub-issues. */
export type ApplyDraft = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly version: number },
) => Promise<UseCaseResult<{ readonly appliedAt: number }, "forbidden" | "not-found" | "stale-version" | "no-ticket" | "task-done">>;

export type MarkTicketReady = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly taskId: TaskId },
) => Promise<UseCaseResult<{ readonly readyAt: number }, "forbidden" | "not-found" | "not-applied" | "no-ready-status" | "task-done">>;

export type CreateTicketFromDraft = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly version: number; readonly boardId: BoardId; readonly publicUrl: string },
) => Promise<UseCaseResult<{ readonly ticketWriteId: TicketWriteId }, "forbidden" | "not-found" | "stale-version" | "has-ticket" | "task-done">>;

// ---------- the review loop (F-035, F-100, F-101, F-102, F-105, F-111; tickets 16 to 20) ----------

/** `ci.evaluate`: the head's verdict, and what follows from it. */
export type EvaluateCi = (
  deps: M6Deps,
  input: { readonly organizationId: OrganizationId; readonly taskRepoId: TaskRepoId; readonly headSha: string; readonly results: CiResults | null },
) => Promise<{ readonly verdict: CiVerdict; readonly roundStarted: boolean }>;

/** `round.start`: a round, if its caps allow, through the budget gate as an automatic turn. */
export type StartRound = (
  deps: M6Deps,
  input: { readonly organizationId: OrganizationId; readonly taskId: TaskId; readonly kind: TaskRoundKind; readonly causeRef: string },
) => Promise<UseCaseResult<{ readonly verdict: RoundVerdict; readonly held: boolean }, "not-found" | "already-started">>;

/** `review.start`: the code task's review task, made at its first review and reopened per round. */
export type StartReview = (
  deps: M6Deps,
  input: { readonly organizationId: OrganizationId; readonly codeTaskId: TaskId; readonly round: number },
) => Promise<UseCaseResult<{ readonly reviewRunId: ReviewRunId; readonly reviewTaskId: TaskId }, "not-found" | "ai-review-off" | "already-started">>;

/** The `submit_review` endpoint's use case: the findings, typed and stored. */
export type SubmitReview = (
  deps: M6TxDeps,
  input: { readonly organizationId: OrganizationId; readonly reviewTaskId: TaskId; readonly review: SubmitReviewInput },
) => Promise<UseCaseResult<{ readonly reviewRunId: ReviewRunId }, "wrong-kind" | "invalid" | "limit-reached" | "not-in-review">>;

/** `review.post`: one comment-type review per PR. */
export type PostReview = (
  deps: M6Deps,
  input: { readonly organizationId: OrganizationId; readonly reviewRunId: ReviewRunId; readonly repoId: RepoId },
) => Promise<UseCaseResult<{ readonly url: string; readonly lineComments: number; readonly inBody: number }, "not-found" | "already-posted">>;

/** `reviewers.refresh`: requested reviewers and CODEOWNERS, matched through the GitHub link. */
export type RefreshReviewers = (
  deps: M6Deps,
  input: { readonly organizationId: OrganizationId; readonly taskRepoId: TaskRepoId },
) => Promise<{ readonly matched: number; readonly unmatched: number; readonly teams: number }>;

/** `changes.reopen`: a linked member's "changes requested" reopens the task after the running turn. */
export type ReopenOnChangesRequested = (
  deps: M6Deps,
  input: { readonly organizationId: OrganizationId; readonly taskRepoId: TaskRepoId; readonly reviewId: string; readonly reviewerUserId: string },
) => Promise<UseCaseResult<{ readonly reopened: boolean }, "not-found" | "not-a-member" | "ignored">>;

/** "Remember this" on a finding (F-111): a memory proposal from it. */
export type RememberFinding = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly findingId: FindingId },
) => Promise<UseCaseResult<{ readonly proposalId: string }, "forbidden" | "not-found">>;

// ---------- onboarding (F-113; tickets 21, 29) ----------

export type StartOnboarding = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly environmentId: EnvironmentId },
) => Promise<UseCaseResult<{ readonly taskId: TaskId }, "forbidden" | "not-found" | "already-running">>;

/** The `propose_environment` endpoint's use case: scanned for secrets, then stored. */
export type ProposeEnvironment = (
  deps: M6TxDeps,
  input: { readonly organizationId: OrganizationId; readonly taskId: TaskId; readonly proposal: EnvironmentProposal },
) => Promise<UseCaseResult<{ readonly proposalId: EnvironmentProposalId }, "wrong-kind" | "invalid" | "secret-found">>;

export type DecideEnvironmentProposal = (
  deps: M6Deps,
  scope: MemberScope,
  input: { readonly proposalId: EnvironmentProposalId; readonly decision: { readonly kind: "accept"; readonly edited: EnvironmentProposal | null } | { readonly kind: "reject" } },
) => Promise<UseCaseResult<{ readonly resultVersion: number | null }, "forbidden" | "not-found" | "already-decided" | "invalid-input">>;

// ---------- the built-in profiles (spec section 5.3) ----------

/** `profiles.seed-built-in`: the built-in Refine and Review profiles, once per organization. */
export type SeedBuiltInProfiles = (
  deps: M6TxDeps,
  input: { readonly organizationId: OrganizationId },
) => Promise<{ readonly refine: AgentProfileId; readonly review: AgentProfileId; readonly created: number }>;
