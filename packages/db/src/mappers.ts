import {
  agentProfileIdSchema,
  agentProfileSkillIdSchema,
  approvalIdSchema,
  approvalRulesSchema,
  blobIdSchema,
  checkIdSchema,
  checkRunIdSchema,
  cliSessionIdSchema,
  diffCommentIdSchema,
  boardIdSchema,
  boxIdSchema,
  budgetIdSchema,
  heldTurnIdSchema,
  invitationIdSchema,
  noteIdSchema,
  proposalIdSchema,
  resetLinkGrantIdSchema,
  reviewCheckIdSchema,
  searchEntryIdSchema,
  commandIdSchema,
  commandSchema,
  connectionIdSchema,
  environmentIdSchema,
  externalTicketIdSchema,
  joinTokenIdSchema,
  leaseIdSchema,
  memberIdSchema,
  modelIdSchema,
  needsYouItemIdSchema,
  notificationDeliveryIdSchema,
  notificationIdSchema,
  oauthStateIdSchema,
  organizationIdSchema,
  poolIdSchema,
  projectIdSchema,
  providerIdSchema,
  questionIdSchema,
  repoIdSchema,
  repoRelativePathSchema,
  runnerIdSchema,
  sessionIdSchema,
  snapshotIdSchema,
  storedEventSchema,
  taskApprovalRuleIdSchema,
  taskIdSchema,
  taskPullRequestIdSchema,
  taskRepoIdSchema,
  ticketIdSchema,
  ticketKeySchema,
  ticketWriteIdSchema,
  turnIdSchema,
  uploadIdSchema,
  userIdSchema,
} from "@ostra/protocol";
import type { Command as ProtocolCommand, StoredEvent } from "@ostra/protocol";
import { z } from "zod";

import {
  apiFormatFromDb,
  approvalSubjectKindFromDb,
  approvalToolFromDb,
  authSchemeFromDb,
  boxReleaseReasonFromDb,
  checkRunStatusFromDb,
  commandKindFromDb,
  sessionLimitFromDb,
  turnOriginFromDb,
} from "./enums.ts";
import type {
  AgentProfile,
  AgentProfileMember,
  AgentProfileSkill,
  Approval,
  Blob,
  BlobChunk,
  BlobUpload,
  Board,
  Box,
  Budget,
  CodeHostInstallation,
  BudgetNotice,
  HeldTurn,
  InsightDaily,
  InsightRun,
  Invitation,
  MemoryNote,
  MemoryNoteVersion,
  MemoryProposal,
  MemoryUse,
  ModelChoice,
  ProviderListEntry,
  ResetLinkGrant,
  ReviewCheck,
  SearchEntry,
  SpendDaily,
  TaskMetric,
  Check,
  CheckRun,
  CliSession,
  Command,
  Connection,
  DiffCache,
  DiffComment,
  EmailSettings,
  Environment,
  EnvironmentEntry,
  Event,
  IdempotencyRecord,
  JoinToken,
  Lease,
  Member,
  Model,
  ModelProvider,
  NeedsYouItem,
  Notification,
  NotificationDelivery,
  NotificationPreference,
  OAuthState,
  Organization,
  OrganizationSetting,
  Project,
  RateBudget,
  Repo,
  Runner,
  RunnerPool,
  Session,
  Snapshot,
  Task,
  TaskApprovalRule,
  TaskCoAuthor,
  TaskPullRequest,
  TaskRepo,
  Ticket,
  TicketWrite,
  Turn,
} from "./generated/prisma/client.ts";

// Row mappers (ticket 06): each turns a Prisma row into the same row with its ID columns parsed
// into their branded types from `@ostra/protocol`, so nothing past this file handles a bare ID
// string. Every other field keeps the type Prisma generated: nothing is typed again by hand.
//
// A mapper throws if a column holds a value its schema refuses. That's a bug or a corrupt row,
// never an expected failure.

// Typed by the schema's output, so a nullable ID keeps its brand.
const optional = <Schema extends z.ZodType>(schema: Schema, value: string | null): z.output<Schema> | null =>
  value === null ? null : schema.parse(value);

export const mapOrganization = (row: Organization) => ({ ...row, id: organizationIdSchema.parse(row.id) });

export const mapMember = (row: Member) => ({
  ...row,
  id: memberIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  userId: userIdSchema.parse(row.userId),
});

export const mapConnection = (row: Connection) => ({
  ...row,
  id: connectionIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  createdByMemberId: optional(memberIdSchema, row.createdByMemberId),
});

export const mapModelProvider = (row: ModelProvider) => ({
  ...row,
  id: providerIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  apiFormat: apiFormatFromDb[row.apiFormat],
  authScheme: authSchemeFromDb[row.authScheme],
});

export const mapModel = (row: Model) => ({
  ...row,
  id: modelIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  providerId: providerIdSchema.parse(row.providerId),
});

export const mapRunnerPool = (row: RunnerPool) => ({
  ...row,
  id: poolIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
});

export const mapJoinToken = (row: JoinToken) => ({
  ...row,
  id: joinTokenIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  poolId: poolIdSchema.parse(row.poolId),
  createdByMemberId: optional(memberIdSchema, row.createdByMemberId),
});

export const mapRunner = (row: Runner) => ({
  ...row,
  id: runnerIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  poolId: optional(poolIdSchema, row.poolId),
  ownerMemberId: optional(memberIdSchema, row.ownerMemberId),
});

export const mapAgentProfile = (row: AgentProfile) => ({
  ...row,
  id: agentProfileIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  modelId: optional(modelIdSchema, row.modelId),
  // Milestone 3: the rules, as the protocol's schema parses them (ADR 0049).
  approvalRules: approvalRulesSchema.parse(row.approvalRules),
});

export const mapProject = (row: Project) => ({
  ...row,
  id: projectIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  defaultRefineProfileId: optional(agentProfileIdSchema, row.defaultRefineProfileId),
  defaultCodeProfileId: optional(agentProfileIdSchema, row.defaultCodeProfileId),
  defaultReviewProfileId: optional(agentProfileIdSchema, row.defaultReviewProfileId),
});

export const mapRepo = (row: Repo) => ({
  ...row,
  id: repoIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  connectionId: connectionIdSchema.parse(row.connectionId),
});

export const mapEnvironment = (row: Environment) => ({
  ...row,
  id: environmentIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  savedByMemberId: optional(memberIdSchema, row.savedByMemberId),
});

export const mapEnvironmentEntry = (row: EnvironmentEntry) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  environmentId: environmentIdSchema.parse(row.environmentId),
  repoId: repoIdSchema.parse(row.repoId),
});

export const mapTask = (row: Task) => ({
  ...row,
  id: taskIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  driverMemberId: optional(memberIdSchema, row.driverMemberId),
  creatorMemberId: optional(memberIdSchema, row.creatorMemberId),
  runnerId: optional(runnerIdSchema, row.runnerId),
  reviewOfTaskId: optional(taskIdSchema, row.reviewOfTaskId),
  ticketKey: optional(ticketKeySchema, row.ticketKey),
  ticketId: optional(ticketIdSchema, row.ticketId),
  boardId: optional(boardIdSchema, row.boardId),
  agentProfileId: optional(agentProfileIdSchema, row.agentProfileId),
});

export const mapTaskRepo = (row: TaskRepo) => ({
  ...row,
  id: taskRepoIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  repoId: repoIdSchema.parse(row.repoId),
});

export const mapTaskCoAuthor = (row: TaskCoAuthor) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  memberId: optional(memberIdSchema, row.memberId),
});

export const mapBox = (row: Box) => ({
  ...row,
  id: boxIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  runnerId: optional(runnerIdSchema, row.runnerId),
  releaseReason: row.releaseReason === null ? null : boxReleaseReasonFromDb[row.releaseReason],
});

export const mapLease = (row: Lease) => ({
  ...row,
  id: leaseIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  runnerId: runnerIdSchema.parse(row.runnerId),
  boxId: boxIdSchema.parse(row.boxId),
});

export const mapSession = (row: Session) => ({
  ...row,
  id: sessionIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  agentProfileId: optional(agentProfileIdSchema, row.agentProfileId),
  boxId: optional(boxIdSchema, row.boxId),
  archiveBlobId: optional(blobIdSchema, row.archiveBlobId),
  limitReached: row.limitReached === null ? null : sessionLimitFromDb[row.limitReached],
  providerId: optional(providerIdSchema, row.providerId),
  modelId: optional(modelIdSchema, row.modelId),
});

export const mapTurn = (row: Turn) => ({
  ...row,
  id: turnIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  sessionId: sessionIdSchema.parse(row.sessionId),
});

export const mapApproval = (row: Approval) => ({
  ...row,
  id: approvalIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  sessionId: sessionIdSchema.parse(row.sessionId),
  answeredByMemberId: optional(memberIdSchema, row.answeredByMemberId),
  subjectKind: row.subjectKind === null ? null : approvalSubjectKindFromDb[row.subjectKind],
});

export const mapNeedsYouItem = (row: NeedsYouItem) => ({
  ...row,
  id: needsYouItemIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  approvalId: optional(approvalIdSchema, row.approvalId),
  resolvedByMemberId: optional(memberIdSchema, row.resolvedByMemberId),
  questionId: optional(questionIdSchema, row.questionId),
  planTurnId: optional(turnIdSchema, row.planTurnId),
});

// ---- milestone 2 ----

export const mapBoard = (row: Board) => ({
  ...row,
  id: boardIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  connectionId: connectionIdSchema.parse(row.connectionId),
});

export const mapTicket = (row: Ticket) => ({
  ...row,
  id: ticketIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  boardId: boardIdSchema.parse(row.boardId),
  connectionId: connectionIdSchema.parse(row.connectionId),
  externalId: externalTicketIdSchema.parse(row.externalId),
  key: ticketKeySchema.parse(row.key),
  parentExternalId: optional(externalTicketIdSchema, row.parentExternalId),
});

export const mapTicketWrite = (row: TicketWrite) => ({
  ...row,
  id: ticketWriteIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  boardId: boardIdSchema.parse(row.boardId),
  ticketId: optional(ticketIdSchema, row.ticketId),
});

export const mapIdempotencyRecord = (row: IdempotencyRecord) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
});

export const mapRateBudget = (row: RateBudget) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
});

export const mapBlob = (row: Blob) => ({
  ...row,
  id: blobIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: optional(projectIdSchema, row.projectId),
  taskId: optional(taskIdSchema, row.taskId),
});

export const mapBlobUpload = (row: BlobUpload) => ({
  ...row,
  id: uploadIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: optional(projectIdSchema, row.projectId),
  taskId: optional(taskIdSchema, row.taskId),
  blobId: optional(blobIdSchema, row.blobId),
});

export const mapBlobChunk = (row: BlobChunk) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  uploadId: optional(uploadIdSchema, row.uploadId),
  blobId: optional(blobIdSchema, row.blobId),
});

export const mapOAuthState = (row: OAuthState) => ({
  ...row,
  id: oauthStateIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  connectionId: connectionIdSchema.parse(row.connectionId),
  memberId: memberIdSchema.parse(row.memberId),
});

export const mapOrganizationSetting = (row: OrganizationSetting) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  linearSkippedByMemberId: optional(memberIdSchema, row.linearSkippedByMemberId),
});

/** An event row as the panel reads it: both numbers, and the payload parsed by the read schema. */
export const mapEventToStored = (row: Event): StoredEvent =>
  storedEventSchema.parse({
    taskId: row.taskId,
    seq: row.seq,
    sessionId: row.sessionId,
    sessionSeq: row.sessionSeq,
    at: row.occurredAt.getTime(),
    event: row.payload,
  });

/** A command row as the frame the gateway sends. */
export const mapCommandToFrame = (row: Command): ProtocolCommand =>
  commandSchema.parse({
    type: "command",
    seq: row.seq,
    id: commandIdSchema.parse(row.id),
    notAfter: row.notAfter.getTime(),
    kind: commandKindFromDb[row.kind],
    body: row.body,
  });

// ---- milestone 3 ----

/** A skill's files, as `AgentProfileSkill.files` holds them. */
export const skillFilesSchema = z.array(z.strictObject({ path: repoRelativePathSchema, blobId: blobIdSchema }));

export const mapAgentProfileMember = (row: AgentProfileMember) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  profileId: agentProfileIdSchema.parse(row.profileId),
  memberId: memberIdSchema.parse(row.memberId),
});

export const mapAgentProfileSkill = (row: AgentProfileSkill) => ({
  ...row,
  id: agentProfileSkillIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  profileId: agentProfileIdSchema.parse(row.profileId),
  files: skillFilesSchema.parse(row.files),
});

export const mapTaskApprovalRule = (row: TaskApprovalRule) => ({
  ...row,
  id: taskApprovalRuleIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  tool: approvalToolFromDb[row.tool],
  approvalId: optional(approvalIdSchema, row.approvalId),
  createdByMemberId: memberIdSchema.parse(row.createdByMemberId),
});

export const mapDiffComment = (row: DiffComment) => ({
  ...row,
  id: diffCommentIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  taskRepoId: taskRepoIdSchema.parse(row.taskRepoId),
  memberId: memberIdSchema.parse(row.memberId),
});

export const mapDiffCache = (row: DiffCache) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  repoId: repoIdSchema.parse(row.repoId),
});

export const mapTaskPullRequest = (row: TaskPullRequest) => ({
  ...row,
  id: taskPullRequestIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskRepoId: taskRepoIdSchema.parse(row.taskRepoId),
});

export const mapCheck = (row: Check) => ({
  ...row,
  id: checkIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  environmentId: environmentIdSchema.parse(row.environmentId),
  repoId: optional(repoIdSchema, row.repoId),
});

export const mapCheckRun = (row: CheckRun) => ({
  ...row,
  id: checkRunIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  sessionId: sessionIdSchema.parse(row.sessionId),
  checkId: checkIdSchema.parse(row.checkId),
  repoId: optional(repoIdSchema, row.repoId),
  status: checkRunStatusFromDb[row.status],
  outputBlobId: optional(blobIdSchema, row.outputBlobId),
});

export const mapSnapshot = (row: Snapshot) => ({
  ...row,
  id: snapshotIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  environmentId: environmentIdSchema.parse(row.environmentId),
  runnerId: optional(runnerIdSchema, row.runnerId),
});

export const mapNotification = (row: Notification) => ({
  ...row,
  id: notificationIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  memberId: memberIdSchema.parse(row.memberId),
  projectId: optional(projectIdSchema, row.projectId),
  taskId: optional(taskIdSchema, row.taskId),
  needsYouItemId: optional(needsYouItemIdSchema, row.needsYouItemId),
});

export const mapNotificationDelivery = (row: NotificationDelivery) => ({
  ...row,
  id: notificationDeliveryIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  notificationId: notificationIdSchema.parse(row.notificationId),
});

export const mapNotificationPreference = (row: NotificationPreference) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  memberId: memberIdSchema.parse(row.memberId),
});

/** The install's email settings. The secret references stay references: the values are the secret store's. */
export const mapEmailSettings = (row: EmailSettings) => ({ ...row });

export const mapCliSession = (row: CliSession) => ({
  ...row,
  id: cliSessionIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  memberId: memberIdSchema.parse(row.memberId),
  userId: userIdSchema.parse(row.userId),
});

// ---------- milestone 4 ----------

/** An invitation. Its `projectGrants` stay JSON here: the domain's schema parses them. */
export const mapInvitation = (row: Invitation) => ({
  ...row,
  id: invitationIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  inviterId: userIdSchema.parse(row.inviterId),
  acceptedUserId: optional(userIdSchema, row.acceptedUserId),
  revokedByMemberId: optional(memberIdSchema, row.revokedByMemberId),
});

/** A reset link. Its token's hash stays in the row and is never logged. */
export const mapResetLinkGrant = (row: ResetLinkGrant) => ({
  ...row,
  id: resetLinkGrantIdSchema.parse(row.id),
  userId: userIdSchema.parse(row.userId),
  createdByUserId: optional(userIdSchema, row.createdByUserId),
});

/** A search entry. Its text is never logged. */
export const mapSearchEntry = (row: SearchEntry) => ({
  ...row,
  id: searchEntryIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  repoId: optional(repoIdSchema, row.repoId),
  authorMemberId: optional(memberIdSchema, row.authorMemberId),
});

export const mapSpendDaily = (row: SpendDaily) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  modelId: modelIdSchema.parse(row.modelId),
});

export const mapBudget = (row: Budget) => ({
  ...row,
  id: budgetIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: optional(projectIdSchema, row.projectId),
  updatedByMemberId: optional(memberIdSchema, row.updatedByMemberId),
});

export const mapBudgetNotice = (row: BudgetNotice) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  budgetId: budgetIdSchema.parse(row.budgetId),
});

export const mapHeldTurn = (row: HeldTurn) => ({
  ...row,
  id: heldTurnIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  budgetId: budgetIdSchema.parse(row.budgetId),
  origin: turnOriginFromDb[row.origin],
});

export const mapTaskMetric = (row: TaskMetric) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
});

export const mapInsightDaily = (row: InsightDaily) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: optional(projectIdSchema, row.projectId),
});

export const mapInsightRun = (row: InsightRun) => ({ ...row, organizationId: organizationIdSchema.parse(row.organizationId) });

/** A memory note. Its title and body are never logged. */
export const mapMemoryNote = (row: MemoryNote) => ({
  ...row,
  id: noteIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: optional(projectIdSchema, row.projectId),
  sourceTaskId: optional(taskIdSchema, row.sourceTaskId),
  authorMemberId: optional(memberIdSchema, row.authorMemberId),
});

export const mapMemoryNoteVersion = (row: MemoryNoteVersion) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  noteId: noteIdSchema.parse(row.noteId),
  editedByMemberId: optional(memberIdSchema, row.editedByMemberId),
  proposalId: optional(proposalIdSchema, row.proposalId),
});

/** A proposed note. Its title and body are never logged. */
export const mapMemoryProposal = (row: MemoryProposal) => ({
  ...row,
  id: proposalIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: optional(projectIdSchema, row.projectId),
  taskId: optional(taskIdSchema, row.taskId),
  sessionId: optional(sessionIdSchema, row.sessionId),
  proposedByMemberId: optional(memberIdSchema, row.proposedByMemberId),
  relatesToNoteId: optional(noteIdSchema, row.relatesToNoteId),
  decidedByMemberId: optional(memberIdSchema, row.decidedByMemberId),
  resultNoteId: optional(noteIdSchema, row.resultNoteId),
});

export const mapMemoryUse = (row: MemoryUse) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  sessionId: sessionIdSchema.parse(row.sessionId),
  noteId: noteIdSchema.parse(row.noteId),
});

export const mapReviewCheck = (row: ReviewCheck) => ({
  ...row,
  id: reviewCheckIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskRepoId: taskRepoIdSchema.parse(row.taskRepoId),
  approverMemberId: optional(memberIdSchema, row.approverMemberId),
});

// ---------- milestone 4, keys per project (ticket 45) ----------

export const mapProviderListEntry = (row: ProviderListEntry) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: optional(projectIdSchema, row.projectId),
  providerId: providerIdSchema.parse(row.providerId),
  addedByMemberId: optional(memberIdSchema, row.addedByMemberId),
});

export const mapModelChoice = (row: ModelChoice) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: optional(projectIdSchema, row.projectId),
  modelId: modelIdSchema.parse(row.modelId),
  chosenByMemberId: optional(memberIdSchema, row.chosenByMemberId),
});

// ---------- milestone 4, linked installations (ticket 46) ----------

export const mapCodeHostInstallation = (row: CodeHostInstallation) => ({
  ...row,
  organizationId: organizationIdSchema.parse(row.organizationId),
  connectionId: connectionIdSchema.parse(row.connectionId),
  linkedByMemberId: optional(memberIdSchema, row.linkedByMemberId),
  removedByMemberId: optional(memberIdSchema, row.removedByMemberId),
});
