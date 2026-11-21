import { z } from "zod";

// One distinct type per ID, so a TaskId can never be passed where a SessionId is wanted
// (AGENTS.md, Code; context/domain-model.md, "Branded IDs"). The only way to get an ID is to
// parse it with its schema. No ID format is fixed yet, so an ID is any non-empty string
// without whitespace.

const idBase = z.string().min(1).regex(/^\S+$/, "an ID has no whitespace");

/** The ID of an organization: the owner of every other record. */
export const organizationIdSchema = idBase.brand<"OrganizationId">();
export type OrganizationId = z.infer<typeof organizationIdSchema>;

/** The ID of a member of an organization. */
export const memberIdSchema = idBase.brand<"MemberId">();
export type MemberId = z.infer<typeof memberIdSchema>;

/** The ID of an organization's GitHub App or Linear app. */
export const connectionIdSchema = idBase.brand<"ConnectionId">();
export type ConnectionId = z.infer<typeof connectionIdSchema>;

/** The ID of a model provider. */
export const providerIdSchema = idBase.brand<"ProviderId">();
export type ProviderId = z.infer<typeof providerIdSchema>;

/** The ID of a model listed by a model provider. */
export const modelIdSchema = idBase.brand<"ModelId">();
export type ModelId = z.infer<typeof modelIdSchema>;

/** The ID of a runner pool. */
export const poolIdSchema = idBase.brand<"PoolId">();
export type PoolId = z.infer<typeof poolIdSchema>;

/** The ID of a runner pool's join token. */
export const joinTokenIdSchema = idBase.brand<"JoinTokenId">();
export type JoinTokenId = z.infer<typeof joinTokenIdSchema>;

/** The ID of a runner. */
export const runnerIdSchema = idBase.brand<"RunnerId">();
export type RunnerId = z.infer<typeof runnerIdSchema>;

/** The ID of an agent profile. */
export const agentProfileIdSchema = idBase.brand<"AgentProfileId">();
export type AgentProfileId = z.infer<typeof agentProfileIdSchema>;

/** The ID of a memory note. */
export const noteIdSchema = idBase.brand<"NoteId">();
export type NoteId = z.infer<typeof noteIdSchema>;

/** The ID of a change of a task's reasoning level (F-137): the runner applies each once. */
export const effortChangeIdSchema = idBase.brand<"EffortChangeId">();
export type EffortChangeId = z.infer<typeof effortChangeIdSchema>;

/** The ID of a budget. */
export const budgetIdSchema = idBase.brand<"BudgetId">();
export type BudgetId = z.infer<typeof budgetIdSchema>;

/** The ID of an audit entry. */
export const auditEntryIdSchema = idBase.brand<"AuditEntryId">();
export type AuditEntryId = z.infer<typeof auditEntryIdSchema>;

/** The ID of a project. */
export const projectIdSchema = idBase.brand<"ProjectId">();
export type ProjectId = z.infer<typeof projectIdSchema>;

/** The ID of a repo linked to a project. */
export const repoIdSchema = idBase.brand<"RepoId">();
export type RepoId = z.infer<typeof repoIdSchema>;

/** The ID of a project's board. */
export const boardIdSchema = idBase.brand<"BoardId">();
export type BoardId = z.infer<typeof boardIdSchema>;

/** The ID of a project's environment. */
export const environmentIdSchema = idBase.brand<"EnvironmentId">();
export type EnvironmentId = z.infer<typeof environmentIdSchema>;

/** The ID of an environment snapshot. */
export const snapshotIdSchema = idBase.brand<"SnapshotId">();
export type SnapshotId = z.infer<typeof snapshotIdSchema>;

/** The ID of an automation. */
export const automationIdSchema = idBase.brand<"AutomationId">();
export type AutomationId = z.infer<typeof automationIdSchema>;

/** The ID of a proposed memory note. */
export const proposalIdSchema = idBase.brand<"ProposalId">();
export type ProposalId = z.infer<typeof proposalIdSchema>;

/** The ID of a task. */
export const taskIdSchema = idBase.brand<"TaskId">();
export type TaskId = z.infer<typeof taskIdSchema>;

/** The ID of a task's branch and PR in one repo. */
export const taskRepoIdSchema = idBase.brand<"TaskRepoId">();
export type TaskRepoId = z.infer<typeof taskRepoIdSchema>;

/** The ID of a box. */
export const boxIdSchema = idBase.brand<"BoxId">();
export type BoxId = z.infer<typeof boxIdSchema>;

/** The ID of a lease of a box to a task. */
export const leaseIdSchema = idBase.brand<"LeaseId">();
export type LeaseId = z.infer<typeof leaseIdSchema>;

/** The ID of a session. */
export const sessionIdSchema = idBase.brand<"SessionId">();
export type SessionId = z.infer<typeof sessionIdSchema>;

/** The ID of a turn of a session. */
export const turnIdSchema = idBase.brand<"TurnId">();
export type TurnId = z.infer<typeof turnIdSchema>;

/** The ID of an event of a session. */
export const eventIdSchema = idBase.brand<"EventId">();
export type EventId = z.infer<typeof eventIdSchema>;

/** The ID of a numbered command from the server to a runner or a sidecar. */
export const commandIdSchema = idBase.brand<"CommandId">();
export type CommandId = z.infer<typeof commandIdSchema>;

/** The ID of a needs-you item. */
export const needsYouItemIdSchema = idBase.brand<"NeedsYouItemId">();
export type NeedsYouItemId = z.infer<typeof needsYouItemIdSchema>;

/** The ID of an approval. */
export const approvalIdSchema = idBase.brand<"ApprovalId">();
export type ApprovalId = z.infer<typeof approvalIdSchema>;

/** The ID of the draft a refine task hands in. */
export const draftIdSchema = idBase.brand<"DraftId">();
export type DraftId = z.infer<typeof draftIdSchema>;

/** The ID of a finding of a review task. */
export const findingIdSchema = idBase.brand<"FindingId">();
export type FindingId = z.infer<typeof findingIdSchema>;

/**
 * A ticket's key in its tracker, such as `CALC-161`: the tracker's project key in capitals, a
 * hyphen and the ticket's number. The tracker owns the ticket and its key format, so this checks
 * only what every ID checks until the tracker adapters define the format. ostra stores this
 * reference (context/domain-model.md).
 */
export const ticketKeySchema = idBase.brand<"TicketKey">();
export type TicketKey = z.infer<typeof ticketKeySchema>;

/** The ID of an account (better-auth's user). A member is an account's membership in one organization. */
export const userIdSchema = idBase.brand<"UserId">();
export type UserId = z.infer<typeof userIdSchema>;

/** The ID of a turn's text segment: one message or one thought, streamed and then saved whole. */
export const segmentIdSchema = idBase.brand<"SegmentId">();
export type SegmentId = z.infer<typeof segmentIdSchema>;

/** The ID the agent gives a tool call (ACP's `toolCallId`). */
export const toolCallIdSchema = idBase.brand<"ToolCallId">();
export type ToolCallId = z.infer<typeof toolCallIdSchema>;

/**
 * The ID the agent gives a subagent it started (protocol minor 6, F-138): OpenCode's child
 * session ID. Unique within the session that started it, nested subagents included.
 */
export const subagentIdSchema = idBase.max(200).brand<"SubagentId">();
export type SubagentId = z.infer<typeof subagentIdSchema>;

/** The ID of a question the agent asked (an ACP elicitation). */
export const questionIdSchema = idBase.brand<"QuestionId">();
export type QuestionId = z.infer<typeof questionIdSchema>;

/** The ID the panel gives a member's message, so a resent steer is applied once. */
export const clientMessageIdSchema = idBase.brand<"ClientMessageId">();
export type ClientMessageId = z.infer<typeof clientMessageIdSchema>;

/** The ID of one option of an approval, as the agent offered it (ACP's `optionId`). */
export const optionIdSchema = idBase.brand<"OptionId">();
export type OptionId = z.infer<typeof optionIdSchema>;

/** The ID of one server process (a replica of core) that holds runner connections. */
export const replicaIdSchema = idBase.brand<"ReplicaId">();
export type ReplicaId = z.infer<typeof replicaIdSchema>;

/** The ID of a code host's or tracker's webhook delivery, as the vendor sent it. */
export const webhookDeliveryIdSchema = idBase.brand<"WebhookDeliveryId">();
export type WebhookDeliveryId = z.infer<typeof webhookDeliveryIdSchema>;

/** The ID of a chunked blob upload in flight, as a blob store gave it. */
export const uploadIdSchema = idBase.brand<"UploadId">();
export type UploadId = z.infer<typeof uploadIdSchema>;

/** The ID of a ticket's cached copy on one board (milestone 2). The tracker's own ID is `ExternalTicketId`. */
export const ticketIdSchema = idBase.brand<"TicketId">();
export type TicketId = z.infer<typeof ticketIdSchema>;

/**
 * A tracker's stable ID of a ticket (milestone 2): Linear's issue ID, Jira's issue ID. Unlike the
 * key, it never changes when the ticket moves team or project.
 */
export const externalTicketIdSchema = idBase.brand<"ExternalTicketId">();
export type ExternalTicketId = z.infer<typeof externalTicketIdSchema>;

/** The ID of one write in the tracker writer's outbox (milestone 2). */
export const ticketWriteIdSchema = idBase.brand<"TicketWriteId">();
export type TicketWriteId = z.infer<typeof ticketWriteIdSchema>;

/** The ID of a pending OAuth authorization: its `state` and PKCE verifier (milestone 2). */
export const oauthStateIdSchema = idBase.brand<"OAuthStateId">();
export type OAuthStateId = z.infer<typeof oauthStateIdSchema>;

/** The ID of a stored blob, as a blob store gave it (the part of its key after the store's name). */
export const blobIdSchema = idBase.brand<"BlobId">();
export type BlobId = z.infer<typeof blobIdSchema>;

// ---------- milestone 3 (protocol minor 2) ----------

/** The ID of an approval rule inside an agent profile (ADR 0049). The profile stores its rules as JSON. */
export const approvalRuleIdSchema = idBase.brand<"ApprovalRuleId">();
export type ApprovalRuleId = z.infer<typeof approvalRuleIdSchema>;

/** The ID of a "for this task" rule: a `TaskApprovalRule` row (ADR 0049). */
export const taskApprovalRuleIdSchema = idBase.brand<"TaskApprovalRuleId">();
export type TaskApprovalRuleId = z.infer<typeof taskApprovalRuleIdSchema>;

/** The ID of a check of an environment (F-054, ADR 0052). */
export const checkIdSchema = idBase.brand<"CheckId">();
export type CheckId = z.infer<typeof checkIdSchema>;

/** The ID of a service of an environment (F-094, ADR 0038): a `Service` row. */
export const serviceIdSchema = idBase.brand<"ServiceId">();
export type ServiceId = z.infer<typeof serviceIdSchema>;
/** The ID of one check's run after one turn: a `CheckRun` row. */
export const checkRunIdSchema = idBase.brand<"CheckRunId">();
export type CheckRunId = z.infer<typeof checkRunIdSchema>;

/** The ID of a member's comment on a task's diff (F-072, ADR 0051). */
export const diffCommentIdSchema = idBase.brand<"DiffCommentId">();
export type DiffCommentId = z.infer<typeof diffCommentIdSchema>;

/** The ID of one PR a task repo has had: a `TaskPullRequest` row (F-066). */
export const taskPullRequestIdSchema = idBase.brand<"TaskPullRequestId">();
export type TaskPullRequestId = z.infer<typeof taskPullRequestIdSchema>;

/** The ID of a member's notification of one moment (F-036, ADR 0050). */
export const notificationIdSchema = idBase.brand<"NotificationId">();
export type NotificationId = z.infer<typeof notificationIdSchema>;

/** The ID of one channel's delivery of a notification. */
export const notificationDeliveryIdSchema = idBase.brand<"NotificationDeliveryId">();
export type NotificationDeliveryId = z.infer<typeof notificationDeliveryIdSchema>;

/** The ID of a member's `ostra login` session (F-103, ADR 0051). */
export const cliSessionIdSchema = idBase.brand<"CliSessionId">();
export type CliSessionId = z.infer<typeof cliSessionIdSchema>;

/** The ID of a skill of an agent profile (F-021). */
export const agentProfileSkillIdSchema = idBase.brand<"AgentProfileSkillId">();
export type AgentProfileSkillId = z.infer<typeof agentProfileSkillIdSchema>;

// ---------- milestone 4 ----------

/** The ID of an invitation to join an organization (F-002, ADR 0053). */
export const invitationIdSchema = idBase.brand<"InvitationId">();
export type InvitationId = z.infer<typeof invitationIdSchema>;

/** The ID of a reset link an admin or a member made (F-002, ADR 0053). */
export const resetLinkGrantIdSchema = idBase.brand<"ResetLinkGrantId">();
export type ResetLinkGrantId = z.infer<typeof resetLinkGrantIdSchema>;

/** The ID of one row of the search table (F-080, ADR 0054). */
export const searchEntryIdSchema = idBase.brand<"SearchEntryId">();
export type SearchEntryId = z.infer<typeof searchEntryIdSchema>;

/** The ID of a turn the budget gate held (F-037, ADR 0055). */
export const heldTurnIdSchema = idBase.brand<"HeldTurnId">();
export type HeldTurnId = z.infer<typeof heldTurnIdSchema>;

/** The ID of a task PR's independent-review check (F-104, ADR 0040). */
export const reviewCheckIdSchema = idBase.brand<"ReviewCheckId">();
export type ReviewCheckId = z.infer<typeof reviewCheckIdSchema>;

// ---------- milestone 5 ----------

/** The ID of an organization's box size (F-095, ADR 0059). */
export const boxSizeIdSchema = idBase.brand<"BoxSizeId">();
export type BoxSizeId = z.infer<typeof boxSizeIdSchema>;

/** The ID of an organization's snapshot registry (F-120, ADR 0060). */
export const registryIdSchema = idBase.brand<"RegistryId">();
export type RegistryId = z.infer<typeof registryIdSchema>;

// ---------- milestone 6 ----------

/** The ID of one run of an automation: an occurrence of a schedule, or a rule's match of a ticket (F-011, F-106). */
export const automationRunIdSchema = idBase.brand<"AutomationRunId">();
export type AutomationRunId = z.infer<typeof automationRunIdSchema>;

/** The ID of a bulk start: many tickets started in one action (F-107). */
export const bulkStartIdSchema = idBase.brand<"BulkStartId">();
export type BulkStartId = z.infer<typeof bulkStartIdSchema>;

/** The ID of one ticket of a bulk start (F-107). */
export const bulkStartItemIdSchema = idBase.brand<"BulkStartItemId">();
export type BulkStartItemId = z.infer<typeof bulkStartItemIdSchema>;

/** The ID of ostra's row for a tracker's agent session (F-012, ADR 0013). */
export const agentSessionIdSchema = idBase.brand<"AgentSessionId">();
export type AgentSessionId = z.infer<typeof agentSessionIdSchema>;

/** The ID of one post to a tracker's agent session, in ostra's outbox (F-012). */
export const agentActivityIdSchema = idBase.brand<"AgentActivityId">();
export type AgentActivityId = z.infer<typeof agentActivityIdSchema>;

/** The ID of an image a member added to a refine draft (F-099). */
export const draftImageIdSchema = idBase.brand<"DraftImageId">();
export type DraftImageId = z.infer<typeof draftImageIdSchema>;

/** The ID of the CI result of one head of a task's PR (F-035). */
export const ciRunIdSchema = idBase.brand<"CiRunId">();
export type CiRunId = z.infer<typeof ciRunIdSchema>;

/** The ID of a fixing round of a task: CI, findings or "changes requested" (F-035, F-101, F-105). */
export const taskRoundIdSchema = idBase.brand<"TaskRoundId">();
export type TaskRoundId = z.infer<typeof taskRoundIdSchema>;

/** The ID of one AI review of a code task's PRs (F-100). */
export const reviewRunIdSchema = idBase.brand<"ReviewRunId">();
export type ReviewRunId = z.infer<typeof reviewRunIdSchema>;

/** The ID of a reviewer of a task's PR (F-102). */
export const taskReviewerIdSchema = idBase.brand<"TaskReviewerId">();
export type TaskReviewerId = z.infer<typeof taskReviewerIdSchema>;

/** The ID of an environment an onboarding task proposed (F-113, ADR 0038). */
export const environmentProposalIdSchema = idBase.brand<"EnvironmentProposalId">();
export type EnvironmentProposalId = z.infer<typeof environmentProposalIdSchema>;

// ---------- milestone 8 (protocol minor 7, ADR 0068) ----------

/** An app process of an environment (F-140): an `AppProcess` row. */
export const appProcessIdSchema = idBase.brand<"AppProcessId">();
export type AppProcessId = z.infer<typeof appProcessIdSchema>;

/**
 * A screenshot's or a recording's ID (F-121), which the runner picks and `attachment.added`
 * carries: unique within its task, so a resent event stores it once.
 */
export const attachmentIdSchema = idBase.max(64).brand<"AttachmentId">();
export type AttachmentId = z.infer<typeof attachmentIdSchema>;

/** A member's screenshot request from the pane (`screenshot.take`), echoed by its `attachment.added`. */
export const screenshotRequestIdSchema = idBase.max(64).brand<"ScreenshotRequestId">();
export type ScreenshotRequestId = z.infer<typeof screenshotRequestIdSchema>;

/** One opening of a preview (F-141): a `PreviewView` row, in the stream, tunnel, native or CLI mode. */
export const previewViewIdSchema = idBase.max(64).brand<"PreviewViewId">();
export type PreviewViewId = z.infer<typeof previewViewIdSchema>;

/** An announced preview of a task (F-140): a `TaskPreview` row. */
export const taskPreviewIdSchema = idBase.brand<"TaskPreviewId">();
export type TaskPreviewId = z.infer<typeof taskPreviewIdSchema>;

/** A preview's access level row (F-142): a `PreviewAccess` row. */
export const previewAccessIdSchema = idBase.brand<"PreviewAccessId">();
export type PreviewAccessId = z.infer<typeof previewAccessIdSchema>;

/** A link to a preview (F-142): a `PreviewLink` row. Not the link's token, which is a secret. */
export const previewLinkIdSchema = idBase.brand<"PreviewLinkId">();
export type PreviewLinkId = z.infer<typeof previewLinkIdSchema>;

/** A one-time code or a CLI ticket's row (F-143, F-144): a `PreviewCode` row. Not the code itself. */
export const previewCodeIdSchema = idBase.brand<"PreviewCodeId">();
export type PreviewCodeId = z.infer<typeof previewCodeIdSchema>;

/**
 * A task's preview ID (F-144, ADR 0068): 128 random bits in lower-case base32, 26 characters,
 * the second half of a preview host's one label (`<port>-<previewId>.<domain>`). It belongs to the
 * task, not the box, so the host survives a reopen. It isn't a secret: a host never decides
 * access, a row and a cookie do.
 */
export const previewIdSchema = z.string().regex(/^[a-z2-7]{26}$/, "26 lower-case base32 characters").brand<"PreviewId">();
export type PreviewId = z.infer<typeof previewIdSchema>;

// ---- milestone 8 (F-145, F-146, ADR 0069): the library ----

/** The ID of an item of an organization's library: a skill or an MCP server. */
export const libraryItemIdSchema = idBase.brand<"LibraryItemId">();
export type LibraryItemId = z.infer<typeof libraryItemIdSchema>;

/** The ID of one version of a library item: its pin, current, available, superseded or dismissed. */
export const libraryItemVersionIdSchema = idBase.brand<"LibraryItemVersionId">();
export type LibraryItemVersionId = z.infer<typeof libraryItemVersionIdSchema>;

/** The ID of an entry of an organization's allowlist of library sources. */
export const librarySourceIdSchema = idBase.brand<"LibrarySourceId">();
export type LibrarySourceId = z.infer<typeof librarySourceIdSchema>;

/** The ID of a member's suggestion of a library item. */
export const librarySuggestionIdSchema = idBase.brand<"LibrarySuggestionId">();
export type LibrarySuggestionId = z.infer<typeof librarySuggestionIdSchema>;
