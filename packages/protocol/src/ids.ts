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
