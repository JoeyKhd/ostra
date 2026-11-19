import {
  agentProfileIdSchema,
  approvalIdSchema,
  blobIdSchema,
  boardIdSchema,
  boxIdSchema,
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
  oauthStateIdSchema,
  organizationIdSchema,
  poolIdSchema,
  projectIdSchema,
  providerIdSchema,
  repoIdSchema,
  runnerIdSchema,
  sessionIdSchema,
  storedEventSchema,
  taskIdSchema,
  taskRepoIdSchema,
  ticketIdSchema,
  ticketKeySchema,
  ticketWriteIdSchema,
  turnIdSchema,
  uploadIdSchema,
  userIdSchema,
} from "@ostra/protocol";
import type { Command as ProtocolCommand, StoredEvent } from "@ostra/protocol";
import type { z } from "zod";

import {
  apiFormatFromDb,
  authSchemeFromDb,
  boxReleaseReasonFromDb,
  commandKindFromDb,
  sessionLimitFromDb,
} from "./enums.ts";
import type {
  AgentProfile,
  Approval,
  Blob,
  BlobChunk,
  BlobUpload,
  Board,
  Box,
  Command,
  Connection,
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
  OAuthState,
  Organization,
  OrganizationSetting,
  Project,
  RateBudget,
  Repo,
  Runner,
  RunnerPool,
  Session,
  Task,
  TaskCoAuthor,
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
});

export const mapNeedsYouItem = (row: NeedsYouItem) => ({
  ...row,
  id: needsYouItemIdSchema.parse(row.id),
  organizationId: organizationIdSchema.parse(row.organizationId),
  projectId: projectIdSchema.parse(row.projectId),
  taskId: taskIdSchema.parse(row.taskId),
  approvalId: optional(approvalIdSchema, row.approvalId),
  resolvedByMemberId: optional(memberIdSchema, row.resolvedByMemberId),
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
