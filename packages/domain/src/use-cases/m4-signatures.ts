import type { Db, Tx } from "@ostra/db";
import type {
  BudgetId,
  InvitationId,
  MemberId,
  MemoryKind,
  MemoryScope,
  MemoryUseVia,
  ModelId,
  NoteId,
  OrganizationId,
  ProjectId,
  ProposalId,
  RepoId,
  ResetLinkGrantId,
  SessionId,
  TaskId,
  TaskRepoId,
  TaskSpecMemory,
  TurnOrigin,
  UserId,
  GitSha,
  RepoFullName,
  SearchEntryId,
} from "@ostra/protocol";

import type { AccountScope, MemberScope, OrganizationRole, ProjectRole } from "../access.ts";
import type { AuditAction } from "../audit/actions.ts";
import type { GateResult } from "../budget/gate.ts";
import type { InsightPeriod } from "../insights/figures.ts";
import type { RememberThisSource } from "../memory/remember-this.ts";
import type { AuditInput, Ports } from "../ports.ts";
import type { IndependentReviewVerdict } from "../review/independent-review.ts";
import type { UseCaseResult } from "./common.ts";

// Milestone 4's use cases (spec section 5.4): each one's input, result and signature, with its
// ports. The signature is the contract the routers, core's workers and the tests are written
// against; the body comes with the ticket each names. Every write is one transaction with its
// change notice, its audit entry (ADR 0054) and the jobs it enqueues (ADR 0011). Organization
// creation and the switcher are after v1 (F-134): `createOrganization` and `switchOrganization`
// have no signature here until then.

/** What a milestone 4 use case takes: the database and the ports. */
export type M4Deps = { readonly db: Db } & Ports;

// ---------- members, invitations and reset links (F-002, F-003, ADR 0053; tickets 22, 23, 43) ----------

/** A restricted project an invitation grants, with its role. */
export type ProjectGrant = { readonly projectId: ProjectId; readonly role: ProjectRole };

export type InviteMember = (
  deps: M4Deps,
  scope: MemberScope,
  input: {
    readonly email: string;
    readonly role: OrganizationRole;
    readonly projectGrants: readonly ProjectGrant[];
    /** The install's email is set up: the invitation is also mailed (`account-mail.send`). */
    readonly emailOn: boolean;
    /** How long it works (`OSTRA_INVITATION_DAYS`). */
    readonly days: number;
  },
) => Promise<
  UseCaseResult<
    { readonly invitationId: InvitationId; readonly expiresAt: number },
    "forbidden" | "already-member" | "already-invited" | "not-found" | "invalid-input"
  >
>;

export type RevokeInvitation = (
  deps: M4Deps,
  scope: MemberScope,
  input: { readonly invitationId: InvitationId },
) => Promise<UseCaseResult<{ readonly revokedAt: number }, "forbidden" | "not-found" | "not-pending">>;

/** Better-auth's sign-up hook and a signed-in account both accept through this: once, before expiry. */
export type AcceptInvitation = (
  deps: M4Deps,
  tx: Tx,
  input: { readonly invitationId: InvitationId; readonly userId: UserId; readonly email: string; readonly emailOn: boolean },
) => Promise<
  UseCaseResult<
    { readonly memberId: MemberId; readonly state: "active" | "pending_verification" },
    "not-found" | "expired" | "revoked" | "used" | "address-mismatch" | "already-member"
  >
>;

export type VerifyMembership = (
  deps: M4Deps,
  input: { readonly token: string },
) => Promise<UseCaseResult<{ readonly memberId: MemberId; readonly organizationId: OrganizationId }, "invalid" | "expired" | "used">>;

/**
 * Removes a membership (Q191): marked removed and kept. Its project roles, personal runners, CLI
 * sessions, driving, drafts and invitations end in the same transaction. The last admin is refused.
 */
export type RemoveMember = (
  deps: M4Deps,
  scope: MemberScope,
  input: { readonly memberId: MemberId },
) => Promise<UseCaseResult<{ readonly removedAt: number }, "forbidden" | "not-found" | "last-admin" | "self">>;

export type SetProjectAccess = (
  deps: M4Deps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly access: "open" | "restricted" },
) => Promise<UseCaseResult<{ readonly access: "open" | "restricted" }, "forbidden" | "not-found">>;

/** A project admin adds, changes or removes an existing member on a restricted project; never invites (Q192). */
export type SetProjectMember = (
  deps: M4Deps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly memberId: MemberId; readonly role: ProjectRole | null },
) => Promise<UseCaseResult<{ readonly role: ProjectRole | null }, "forbidden" | "not-found" | "not-a-member">>;

export type GrantInstanceAdmin = (
  deps: M4Deps,
  account: AccountScope,
  input: { readonly userId: UserId; readonly grant: boolean },
) => Promise<UseCaseResult<{ readonly instanceAdmin: boolean }, "forbidden" | "not-found" | "last-instance-admin">>;

/** An instance admin's reset link (without email), or a self-service one by mail. Only its hash is stored. */
export type CreateResetLink = (
  deps: M4Deps,
  actor: { readonly kind: "admin"; readonly account: AccountScope } | { readonly kind: "self_service"; readonly email: string },
  input: { readonly userId: UserId | null },
) => Promise<UseCaseResult<{ readonly resetLinkId: ResetLinkGrantId; readonly expiresAt: number; readonly link: string | null }, "forbidden" | "not-found" | "email-off">>;

// ---------- the audit log (F-073, ADR 0054; tickets 10, 25) ----------

/** The one port every action writes through, in the action's own transaction. */
export type RecordAudit = (tx: Tx, entry: AuditInput & { readonly actorName?: string | null }) => Promise<void>;

export type AuditFilter = {
  readonly projectId: ProjectId | null;
  readonly actorId: string | null;
  readonly action: AuditAction | null;
  readonly from: number | null;
  readonly to: number | null;
};

/** The CSV export: one quoted field per column, organization admins all of it, project admins their project's. */
export type ExportAudit = (deps: M4Deps, scope: MemberScope, filter: AuditFilter) => Promise<UseCaseResult<{ readonly csv: string }, "forbidden">>;

// ---------- search (F-080, ADR 0054; tickets 11, 26) ----------

export type SearchEntryInput = {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly repoId: RepoId | null;
  readonly eventSeq: number | null;
  readonly kind: "title" | "prompt" | "ticket" | "member_message" | "agent_message" | "tool_input" | "pr";
  readonly authorMemberId: MemberId | null;
  /** Cut to `OSTRA_SEARCH_ENTRY_MAX_KIB`. Never logged. */
  readonly text: string;
};

/** At ingest, in the events' transaction; idempotent per `(taskId, eventSeq, kind)`. */
export type WriteSearchEntries = (tx: Tx, organizationId: OrganizationId, entries: readonly SearchEntryInput[]) => Promise<{ readonly written: number }>;

export type SearchTasksInput = {
  /** The text, as a bound parameter only. Never logged. */
  readonly text: string | null;
  readonly ticketKey: string | null;
  readonly repoId: RepoId | null;
  readonly memberId: MemberId | null;
  readonly state: string | null;
  readonly limit: number;
};

/** Results are tasks, with access in the query: a project the member can't open never matches. */
export type SearchTasks = (
  db: Db,
  scope: MemberScope,
  input: SearchTasksInput,
) => Promise<readonly { readonly taskId: TaskId; readonly projectId: ProjectId; readonly matched: readonly SearchEntryId[] }[]>;

// ---------- spend and budgets (F-037, ADR 0055; tickets 12, 13, 27) ----------

/** At ingest, in the `usage.recorded` transaction: adds to `SpendDaily`. */
export type RecordSpend = (
  tx: Tx,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly modelId: ModelId;
    readonly at: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    /** `null` for an unpriced model: counted in `unpricedTokens`. */
    readonly spentMicroUsd: number | null;
  },
) => Promise<void>;

export type SetBudget = (
  deps: M4Deps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId | null; readonly monthlyMicroUsd: bigint | null },
) => Promise<UseCaseResult<{ readonly budgetId: BudgetId | null }, "forbidden" | "not-found" | "invalid-input">>;

/** The one gate every turn start calls (`budgetGate`), with the rows it reads. */
export type CheckBudget = (
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly modelId: ModelId | null; readonly origin: TurnOrigin },
) => Promise<GateResult>;

/** On a raise or a new month: held turns and waiting tasks go, in the order they were held. */
export type ReleaseHeldTurns = (deps: M4Deps, input: { readonly organizationId: OrganizationId; readonly budgetId: BudgetId }) => Promise<{ readonly released: number }>;

/** An admin's price for a custom model: the four prices in micro-USD per million tokens, each `null` when unknown. */
export type SetModelPrice = (
  deps: M4Deps,
  scope: MemberScope,
  input: {
    readonly modelId: ModelId;
    readonly inputPerMTok: number | null;
    readonly outputPerMTok: number | null;
    readonly cacheReadPerMTok: number | null;
    readonly cacheWritePerMTok: number | null;
  },
) => Promise<UseCaseResult<{ readonly priceChangedAt: number }, "forbidden" | "not-found" | "invalid-input">>;

// ---------- Insights (F-108, ADR 0055; tickets 14, 28) ----------

/** The scheduled pass: an organization's last two days and any day whose sources changed. Idempotent. */
export type ComputeInsights = (deps: M4Deps, input: { readonly organizationId: OrganizationId; readonly period: InsightPeriod }) => Promise<{ readonly days: number }>;

// ---------- memory (F-109, F-110, F-111, ADR 0044; tickets 15, 16, 29) ----------

export type SaveNoteInput = {
  /** `null` writes a new note. */
  readonly noteId: NoteId | null;
  /** The version the member opened; a stale one is a conflict (Q91). `null` for a new note. */
  readonly expectedVersion: number | null;
  readonly scope: MemoryScope;
  readonly projectId: ProjectId | null;
  readonly title: string;
  readonly body: string;
  readonly kind: MemoryKind;
  readonly always: boolean;
};

export type SaveNote = (
  deps: M4Deps,
  scope: MemberScope,
  input: SaveNoteInput,
) => Promise<
  UseCaseResult<
    { readonly noteId: NoteId; readonly version: number },
    "forbidden" | "not-found" | "secret-found" | "conflict" | "invalid-input"
  >
>;

export type ArchiveNote = (
  deps: M4Deps,
  scope: MemberScope,
  input: { readonly noteId: NoteId },
) => Promise<UseCaseResult<{ readonly archivedAt: number }, "forbidden" | "not-found">>;

/** Full-text search over the notes the task's organization and project hold, by bound parameter. */
export type SearchNotes = (
  db: Db,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId | null; readonly query: string; readonly limit: number },
) => Promise<readonly { readonly noteId: NoteId; readonly title: string; readonly line: string; readonly kind: MemoryKind; readonly scope: MemoryScope }[]>;

/** The session's memory, rendered for its spec (`buildMemoryIndex`, `renderMemoryBlock`). */
export type BuildMemoryBlock = (
  db: Db,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly tools: boolean },
) => Promise<TaskSpecMemory | null>;

/** From `memory.used`: one row per session, note and way; only `read` and `search` move a note's last use. */
export type RecordMemoryUse = (
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly taskId: TaskId; readonly sessionId: SessionId; readonly noteIds: readonly NoteId[]; readonly via: MemoryUseVia; readonly at: number },
) => Promise<void>;

export type ProposeNote = (
  deps: M4Deps,
  input: {
    readonly organizationId: OrganizationId;
    readonly taskId: TaskId;
    readonly sessionId: SessionId | null;
    readonly title: string;
    readonly body: string;
    readonly kind: MemoryKind;
    readonly scope: MemoryScope;
    readonly relatesTo: NoteId | null;
    readonly relation: "contradicts" | "refines" | null;
    readonly source: "agent" | "closing_turn";
  },
) => Promise<UseCaseResult<{ readonly proposalId: ProposalId }, "secret-found" | "limit-reached" | "invalid" | "not-found">>;

export type RememberThis = (
  deps: M4Deps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly source: RememberThisSource; readonly title: string; readonly body: string; readonly kind: MemoryKind },
) => Promise<UseCaseResult<{ readonly proposalId: ProposalId }, "forbidden" | "not-found" | "secret-found" | "invalid-input">>;

export type DecideProposal = (
  deps: M4Deps,
  scope: MemberScope,
  input:
    | { readonly proposalId: ProposalId; readonly decision: "approve" }
    | { readonly proposalId: ProposalId; readonly decision: "approve_and_archive"; readonly archiveNoteId: NoteId }
    | { readonly proposalId: ProposalId; readonly decision: "reject" }
    | {
        readonly proposalId: ProposalId;
        readonly decision: "merge";
        readonly intoNoteId: NoteId;
        readonly expectedVersion: number;
        readonly title: string;
        readonly body: string;
      },
) => Promise<UseCaseResult<{ readonly noteId: NoteId | null }, "forbidden" | "not-found" | "not-proposed" | "conflict" | "secret-found">>;

// ---------- several repos (F-098, ADR 0027; tickets 17, 30) ----------

export type AddProjectRepo = (
  deps: M4Deps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly fullName: RepoFullName },
) => Promise<UseCaseResult<{ readonly repoId: RepoId; readonly checkoutDir: string; readonly position: number }, "forbidden" | "not-found" | "limit-reached" | "already-added" | "no-access">>;

export type RemoveProjectRepo = (
  deps: M4Deps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly repoId: RepoId },
) => Promise<UseCaseResult<{ readonly removed: true }, "forbidden" | "not-found" | "in-use" | "last-repo">>;

export type LinkRelatedPullRequests = (deps: M4Deps, input: { readonly organizationId: OrganizationId; readonly taskId: TaskId }) => Promise<{ readonly updated: number }>;

// ---------- the independent-review check (F-104, ADR 0040; ticket 18) ----------

export type EvaluateReviewCheck = (
  deps: M4Deps,
  input: { readonly organizationId: OrganizationId; readonly taskRepoId: TaskRepoId; readonly prNumber: number; readonly headSha: GitSha },
) => Promise<UseCaseResult<{ readonly verdict: IndependentReviewVerdict }, "not-found" | "not-a-task-pr">>;
