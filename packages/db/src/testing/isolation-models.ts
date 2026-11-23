import { randomBytes, randomUUID } from "node:crypto";

import type { Db } from "../client.ts";

// The isolation model list (milestone 4, ticket 09; F-049, F-087, ADR 0053, ADR 0026): every
// Prisma model that carries `organizationId`, each with a fixture builder that makes a valid row of
// it, with its parents, in a given organization and, for a record inside a project, a given
// project. And the short allowlist of the models without the column, each with its reason. The
// generated isolation suite (`packages/api/src/isolation/`) builds every listed model in two
// organizations and in a restricted project, and a guard there fails on a model that is on neither
// list, or on both. A new model with `organizationId` needs its builder here before any test passes.

export const isolationModelList = [
  "Member",
  "Invitation",
  "OrganizationSetting",
  "AuditEntry",
  "ChangeNotice",
  "Connection",
  "CodeHostInstallation",
  "ModelProvider",
  "Model",
  "RunnerPool",
  "JoinToken",
  "Runner",
  "RunnerPresence",
  "AgentProfile",
  "AgentProfileMember",
  "AgentProfileSkill",
  "Secret",
  "Project",
  "ProjectMember",
  "ProjectPool",
  "Repo",
  "Board",
  "Ticket",
  "TicketWrite",
  "Environment",
  "EnvironmentEntry",
  "Service",
  "Check",
  "Snapshot",
  "Automation",
  "Task",
  "TaskRepo",
  "TaskCoAuthor",
  "Box",
  "SidecarCommand",
  "Lease",
  "Session",
  "Turn",
  "Event",
  "Command",
  "Approval",
  "NeedsYouItem",
  "WebhookDelivery",
  "IdempotencyRecord",
  "RateBudget",
  "Blob",
  "BlobUpload",
  "BlobChunk",
  "OAuthState",
  "TaskApprovalRule",
  "DiffComment",
  "DiffCache",
  "TaskPullRequest",
  "CheckRun",
  "Notification",
  "NotificationDelivery",
  "NotificationPreference",
  "AccountMailDelivery",
  "CliSession",
  "DeviceCode",
  "SearchEntry",
  "SpendDaily",
  "Budget",
  "BudgetNotice",
  "HeldTurn",
  "TaskMetric",
  "InsightDaily",
  "InsightRun",
  "MemoryNote",
  "MemoryNoteVersion",
  "MemoryProposal",
  "MemoryUse",
  "ReviewCheck",
  "ProviderListEntry",
  "ModelChoice",
  // Milestone 5 (its ticket 04).
  "BoxSize",
  "Registry",
  // Milestone 6 (its ticket 05).
  "AutomationRun",
  "BulkStart",
  "BulkStartItem",
  "AgentSession",
  "AgentActivity",
  "RefineDraft",
  "RefineDraftImage",
  "CiRun",
  "TaskRound",
  "ReviewRun",
  "Finding",
  "TaskReviewer",
  "EnvironmentProposal",
  // Milestone 8 (its ticket 04).
  "AppProcess",
  "TaskAttachment",
  "TaskPreview",
  "PreviewAccess",
  "PreviewAccessMember",
  "PreviewLink",
  "PreviewView",
  "PreviewCode",
  "LibraryItem",
  "LibraryItemVersion",
  "AgentProfileLibraryItem",
  "LibrarySource",
  "LibrarySuggestion",
  // Milestone 9 (its ticket 04).
  "MessageFile",
  "TaskTicketRead",
  // 2026-11-23 (F-112/c1, Q345 option (b)).
  "EnvironmentRepoDraft",
] as const;

export type IsolationModelName = (typeof isolationModelList)[number];

/** Where a builder makes its row: the organization, a project in it, and a member and account of it. */
export type FixturePlace = {
  readonly db: Db;
  readonly organizationId: string;
  /** The project a project record goes in. */
  readonly projectId: string;
  /** A member of the organization, for rows that name one (never added to a project here). */
  readonly memberId: string;
  readonly userId: string;
};

/** Makes, or returns the one already made in this place, a row of another model: its ID. */
export type Ensure = (model: IsolationModelName) => Promise<string>;

export type FixtureBuilder = (place: FixturePlace, ensure: Ensure) => Promise<string>;

const tag = (): string => randomBytes(4).toString("hex");
const id = (): string => randomUUID();
let seqCounter = 0;
/** A runner's command numbers are its own: each fixture command takes the next. */
const nextSeq = (): number => {
  seqCounter += 1;
  return seqCounter;
};

/** A Linear connection, beside the GitHub one `Connection` makes: a board's and a ticket's. */
const linearConnection = new WeakMap<object, Map<string, Promise<string>>>();
const linearOf = (place: FixturePlace): Promise<string> => {
  const byOrganization = linearConnection.get(place.db) ?? new Map<string, Promise<string>>();
  linearConnection.set(place.db, byOrganization);
  const known = byOrganization.get(place.organizationId);
  if (known !== undefined) {
    return known;
  }
  const made = place.db.connection.create({ data: { organizationId: place.organizationId, kind: "linear", appId: `linear-${tag()}` }, select: { id: true } }).then((row) => row.id);
  byOrganization.set(place.organizationId, made);
  return made;
};

/**
 * Every model with `organizationId`, and how to make one. Project records go in `place.projectId`;
 * the others belong to the organization alone, and one is made per organization.
 */
export const isolationModels: Readonly<Record<IsolationModelName, FixtureBuilder>> = {
  Member: async ({ db, organizationId }) => {
    const user = await db.user.create({ data: { id: id(), name: `Fixture ${tag()}`, email: `fixture-${tag()}@example.com`, username: `fixture-${tag()}` } });
    return (await db.member.create({ data: { id: id(), organizationId, userId: user.id, role: "member", createdAt: new Date() } })).id;
  },
  Invitation: async ({ db, organizationId, userId }) =>
    (await db.invitation.create({ data: { id: id(), organizationId, email: `invitee-${tag()}@example.com`, role: "member", status: "pending", expiresAt: new Date(Date.now() + 86_400_000), inviterId: userId } })).id,
  OrganizationSetting: async ({ db, organizationId }) => (await db.organizationSetting.create({ data: { organizationId } })).organizationId,
  AuditEntry: async ({ db, organizationId, projectId }) => (await db.auditEntry.create({ data: { organizationId, projectId, actorKind: "system", action: "task.created" } })).id,
  ChangeNotice: async ({ db, organizationId, projectId }) => String((await db.changeNotice.create({ data: { organizationId, projectId, entity: "task", entityId: id() } })).seq),
  Connection: async ({ db, organizationId }) => (await db.connection.create({ data: { organizationId, kind: "github", appId: `app-${tag()}`, slug: `app-${tag()}` } })).id,
  CodeHostInstallation: async ({ db, organizationId }, ensure) =>
    (
      await db.codeHostInstallation.create({
        data: { organizationId, connectionId: await ensure("Connection"), installationId: "1", accountLogin: `account-${tag()}`, accountKind: "organization" },
      })
    ).id,
  ModelProvider: async ({ db, organizationId }) =>
    (
      await db.modelProvider.create({
        data: { organizationId, name: `Provider ${tag()}`, baseUrl: "https://models.example.com/v1", apiFormat: "openai_compatible", authScheme: "bearer", tokenSecretRef: `secret:${id()}` },
      })
    ).id,
  Model: async ({ db, organizationId }, ensure) => (await db.model.create({ data: { organizationId, providerId: await ensure("ModelProvider"), endpointModelId: `model-${tag()}` } })).id,
  RunnerPool: async ({ db, organizationId }) => (await db.runnerPool.create({ data: { organizationId, name: `pool-${tag()}` } })).id,
  JoinToken: async ({ db, organizationId }, ensure) => (await db.joinToken.create({ data: { organizationId, poolId: await ensure("RunnerPool"), tokenHash: randomBytes(32).toString("hex") } })).id,
  Runner: async ({ db, organizationId, memberId }) =>
    (
      await db.runner.create({
        data: { organizationId, kind: "personal", ownerMemberId: memberId, name: `runner-${tag()}`, publicKey: randomBytes(32).toString("base64url"), executor: "host", capacity: 1, version: "0.0.0", state: "online" },
      })
    ).id,
  RunnerPresence: async ({ db, organizationId }, ensure) =>
    (await db.runnerPresence.create({ data: { organizationId, runnerId: await ensure("Runner"), replicaId: `replica-${tag()}`, connectionEpoch: 1, carrier: "ws", minor: 3 } })).runnerId,
  AgentProfile: async ({ db, organizationId }) => (await db.agentProfile.create({ data: { organizationId, name: `Profile ${tag()}`, adapter: "opencode" } })).id,
  AgentProfileMember: async ({ db, organizationId, memberId }, ensure) => (await db.agentProfileMember.create({ data: { organizationId, profileId: await ensure("AgentProfile"), memberId } })).id,
  AgentProfileSkill: async ({ db, organizationId }, ensure) => (await db.agentProfileSkill.create({ data: { organizationId, profileId: await ensure("AgentProfile"), name: `skill-${tag()}`, body: "A skill." } })).id,
  Secret: async ({ db, organizationId }) =>
    (await db.secret.create({ data: { organizationId, purpose: "fixture", ciphertext: Buffer.from(randomBytes(16)), nonce: Buffer.from(randomBytes(12)), keyVersion: 1 } })).id,
  Project: async ({ db, organizationId }) => (await db.project.create({ data: { organizationId, name: `project-${tag()}`, slug: `project-${tag()}`, access: "open" } })).id,
  // A member of its own, never `place.memberId`: listing that one would open a restricted project to it.
  ProjectMember: async ({ db, organizationId, projectId }, ensure) => (await db.projectMember.create({ data: { organizationId, projectId, memberId: await ensure("Member"), role: "member" } })).id,
  ProjectPool: async ({ db, organizationId, projectId }, ensure) => (await db.projectPool.create({ data: { organizationId, projectId, poolId: await ensure("RunnerPool") } })).poolId,
  Repo: async ({ db, organizationId, projectId }, ensure) => {
    const connectionId = await ensure("Connection");
    await ensure("CodeHostInstallation");
    const name = `repo-${tag()}`;
    return (await db.repo.create({ data: { organizationId, projectId, connectionId, installationId: "1", hostRepoId: name, fullName: `fixture/${name}`, defaultBranch: "main", checkoutDir: name } })).id;
  },
  Board: async (place) =>
    (await place.db.board.create({ data: { organizationId: place.organizationId, projectId: place.projectId, connectionId: await linearOf(place), externalId: `team-${tag()}`, name: "Board", statusMap: {}, key: "FIX" } })).id,
  Ticket: async (place, ensure) => {
    const boardId = await ensure("Board");
    return (
      await place.db.ticket.create({
        data: {
          organizationId: place.organizationId,
          projectId: place.projectId,
          boardId,
          connectionId: await linearOf(place),
          externalId: `ticket-${tag()}`,
          key: `FIX-${String(Math.floor(Math.random() * 100_000))}`,
          title: "A fixture ticket",
          url: "https://linear.example/FIX",
          trackerUpdatedAt: new Date(),
        },
      })
    ).id;
  },
  TicketWrite: async ({ db, organizationId, projectId }, ensure) =>
    (
      await db.ticketWrite.create({
        data: { organizationId, projectId, taskId: await ensure("Task"), boardId: await ensure("Board"), ticketId: await ensure("Ticket"), kind: "comment", payload: {}, idempotencyKey: `write-${tag()}` },
      })
    ).id,
  Environment: async ({ db, organizationId, projectId }) => (await db.environment.create({ data: { organizationId, projectId } })).id,
  EnvironmentEntry: async ({ db, organizationId, projectId }, ensure) =>
    (await db.environmentEntry.create({ data: { organizationId, projectId, environmentId: await ensure("Environment"), repoId: await ensure("Repo"), kind: "variable", name: "FIXTURE", value: "1" } })).id,
  Service: async ({ db, organizationId, projectId }, ensure) =>
    (await db.service.create({ data: { organizationId, projectId, environmentId: await ensure("Environment"), name: `svc-${tag()}`, image: "postgres:17", variables: [] } })).id,
  Check: async ({ db, organizationId, projectId }, ensure) =>
    (await db.check.create({ data: { organizationId, projectId, environmentId: await ensure("Environment"), name: `check-${tag()}`, command: "true" } })).id,
  Snapshot: async ({ db, organizationId, projectId }, ensure) => (await db.snapshot.create({ data: { organizationId, projectId, environmentId: await ensure("Environment"), reason: "rebuild" } })).id,
  Automation: async ({ db, organizationId, projectId }) => (await db.automation.create({ data: { organizationId, projectId, kind: "schedule", name: `auto-${tag()}`, taskKind: "code", schedule: "0 9 * * 1" } })).id,
  Task: async ({ db, organizationId, projectId, memberId }) =>
    (
      await db.task.create({
        data: { organizationId, projectId, kind: "code", source: "prompt", title: "A fixture task", prompt: "A fixture prompt", branchName: `ostra/${tag()}-fixture`, state: "running", creatorMemberId: memberId, driverMemberId: memberId },
      })
    ).id,
  TaskRepo: async ({ db, organizationId, projectId }, ensure) =>
    (await db.taskRepo.create({ data: { organizationId, projectId, taskId: await ensure("Task"), repoId: await ensure("Repo"), branchName: `ostra/${tag()}-fixture`, baseBranch: "main" } })).id,
  TaskCoAuthor: async ({ db, organizationId, projectId, memberId }, ensure) =>
    (await db.taskCoAuthor.create({ data: { organizationId, projectId, taskId: await ensure("Task"), memberId, name: "Fixture", email: `coauthor-${tag()}@example.com` } })).id,
  Box: async ({ db, organizationId, projectId }, ensure) =>
    (await db.box.create({ data: { organizationId, projectId, taskId: await ensure("Task"), runnerId: await ensure("Runner"), executor: "host", state: "ready" } })).id,
  SidecarCommand: async ({ db, organizationId, projectId }, ensure) =>
    (await db.sidecarCommand.create({ data: { organizationId, projectId, taskId: await ensure("Task"), boxId: await ensure("Box"), seq: 1, kind: "steer", body: {}, notAfter: new Date(Date.now() + 60_000) } })).id,
  Lease: async ({ db, organizationId, projectId }, ensure) =>
    (await db.lease.create({ data: { organizationId, projectId, taskId: await ensure("Task"), epoch: 1, runnerId: await ensure("Runner"), boxId: await ensure("Box"), state: "active" } })).id,
  Session: async ({ db, organizationId, projectId }, ensure) => (await db.session.create({ data: { organizationId, projectId, taskId: await ensure("Task"), origin: "new", state: "running" } })).id,
  Turn: async ({ db, organizationId, projectId }, ensure) =>
    (await db.turn.create({ data: { organizationId, projectId, taskId: await ensure("Task"), sessionId: await ensure("Session"), ordinal: 1, startSeq: 1 } })).id,
  Event: async ({ db, organizationId, projectId }, ensure) => {
    const taskId = await ensure("Task");
    const counter = await db.task.update({ where: { id: taskId }, data: { eventSeq: { increment: 1 } }, select: { eventSeq: true } });
    return (
      await db.event.create({
        data: {
          organizationId,
          projectId,
          taskId,
          seq: counter.eventSeq,
          sessionId: await ensure("Session"),
          kind: "agent.message",
          payload: { kind: "agent.message", turnId: "turn-1", segmentId: `seg-${tag()}`, text: "A fixture message." },
          occurredAt: new Date(),
        },
      })
    ).taskId;
  },
  Command: async ({ db, organizationId, projectId }, ensure) =>
    (await db.command.create({ data: { organizationId, projectId, taskId: await ensure("Task"), runnerId: await ensure("Runner"), seq: nextSeq(), kind: "steer", body: {}, notAfter: new Date(Date.now() + 60_000) } })).id,
  Approval: async ({ db, organizationId, projectId }, ensure) =>
    (await db.approval.create({ data: { organizationId, projectId, taskId: await ensure("Task"), sessionId: await ensure("Session"), toolCallId: `tool-${tag()}`, options: [] } })).id,
  NeedsYouItem: async ({ db, organizationId, projectId }, ensure) =>
    (await db.needsYouItem.create({ data: { organizationId, projectId, taskId: await ensure("Task"), reason: "approval", audience: "project_members", approvalId: await ensure("Approval") } })).id,
  WebhookDelivery: async ({ db, organizationId }, ensure) => (await db.webhookDelivery.create({ data: { organizationId, connectionId: await ensure("Connection"), deliveryId: `delivery-${tag()}`, event: "ping" } })).id,
  IdempotencyRecord: async ({ db, organizationId }) => (await db.idempotencyRecord.create({ data: { organizationId, key: `key-${tag()}`, state: "done", claimedAt: new Date() } })).id,
  RateBudget: async ({ db, organizationId }) => (await db.rateBudget.create({ data: { organizationId, key: `budget-${tag()}`, remaining: 10, resetAt: new Date() } })).id,
  Blob: async ({ db, organizationId, projectId }) =>
    (await db.blob.create({ data: { organizationId, projectId, store: "postgres", key: `blob-${id()}`, purpose: "fixture", contentType: "text/plain", size: 1, sha256: "0".repeat(64) } })).id,
  BlobUpload: async ({ db, organizationId, projectId }) =>
    (await db.blobUpload.create({ data: { organizationId, projectId, store: "postgres", purpose: "fixture", contentType: "text/plain", expectedSha256: "0".repeat(64), size: 1 } })).id,
  BlobChunk: async ({ db, organizationId }, ensure) => (await db.blobChunk.create({ data: { organizationId, blobId: await ensure("Blob"), ordinal: 0, offset: 0, bytes: Buffer.from("x") } })).id,
  OAuthState: async ({ db, organizationId, memberId }, ensure) =>
    (
      await db.oAuthState.create({
        data: { organizationId, connectionId: await ensure("Connection"), stateHash: randomBytes(32).toString("hex"), codeVerifierSecretRef: `secret:${id()}`, memberId, authSessionId: id(), expiresAt: new Date(Date.now() + 600_000) },
      })
    ).id,
  TaskApprovalRule: async ({ db, organizationId, projectId, memberId }, ensure) =>
    (await db.taskApprovalRule.create({ data: { organizationId, projectId, taskId: await ensure("Task"), tool: "execute", pattern: "pnpm test", createdByMemberId: memberId } })).id,
  DiffComment: async ({ db, organizationId, projectId, memberId }, ensure) =>
    (
      await db.diffComment.create({
        data: { organizationId, projectId, taskId: await ensure("Task"), taskRepoId: await ensure("TaskRepo"), memberId, path: "src/a.ts", side: "new", line: 1, headSha: "a".repeat(40), body: "A fixture comment." },
      })
    ).id,
  DiffCache: async ({ db, organizationId, projectId }, ensure) =>
    (await db.diffCache.create({ data: { organizationId, projectId, repoId: await ensure("Repo"), baseSha: randomBytes(20).toString("hex"), headSha: randomBytes(20).toString("hex"), result: {} } })).id,
  TaskPullRequest: async ({ db, organizationId, projectId }, ensure) =>
    (await db.taskPullRequest.create({ data: { organizationId, projectId, taskRepoId: await ensure("TaskRepo"), number: 1, url: "https://github.example/fixture/pull/1", branchName: "ostra/fixture" } })).id,
  CheckRun: async ({ db, organizationId, projectId }, ensure) =>
    (await db.checkRun.create({ data: { organizationId, projectId, taskId: await ensure("Task"), sessionId: await ensure("Session"), turnOrdinal: 1, checkId: await ensure("Check"), name: "test" } })).id,
  Notification: async ({ db, organizationId, projectId, memberId }, ensure) =>
    (await db.notification.create({ data: { organizationId, projectId, taskId: await ensure("Task"), memberId, kind: "approval" } })).id,
  NotificationDelivery: async ({ db, organizationId }, ensure) =>
    (await db.notificationDelivery.create({ data: { organizationId, notificationId: await ensure("Notification"), channel: "panel", adapter: "panel", idempotencyKey: `delivery-${tag()}` } })).id,
  NotificationPreference: async ({ db, organizationId, memberId }) => (await db.notificationPreference.create({ data: { organizationId, memberId, kind: "approval", channel: "email", enabled: false } })).id,
  AccountMailDelivery: async ({ db, organizationId }, ensure) => (await db.accountMailDelivery.create({ data: { organizationId, purpose: "invitation", recordId: await ensure("Invitation") } })).id,
  CliSession: async ({ db, organizationId, memberId, userId }) =>
    (await db.cliSession.create({ data: { organizationId, memberId, userId, tokenHash: randomBytes(32).toString("hex"), name: "fixture laptop", expiresAt: new Date(Date.now() + 86_400_000) } })).id,
  // An approved `ostra` CLI sign-in names the organization it was approved in (F-103); before approval it names none.
  DeviceCode: async ({ db, organizationId, userId }) =>
    (
      await db.deviceCode.create({
        data: { id: id(), deviceCode: `device-${tag()}`, userCode: `CODE${tag().toUpperCase()}`, userId, organizationId, status: "approved", purpose: "cli", machineName: "fixture laptop", expiresAt: new Date(Date.now() + 600_000) },
      })
    ).id,
  SearchEntry: async ({ db, organizationId, projectId }, ensure) => (await db.searchEntry.create({ data: { organizationId, projectId, taskId: await ensure("Task"), eventSeq: 1, kind: "agent_message", text: "A fixture entry." } })).id,
  SpendDaily: async ({ db, organizationId, projectId }, ensure) => (await db.spendDaily.create({ data: { organizationId, projectId, day: new Date("2026-11-01T00:00:00Z"), modelId: await ensure("Model") } })).id,
  Budget: async ({ db, organizationId, projectId }) => (await db.budget.create({ data: { organizationId, projectId, monthlyMicroUsd: 1_000_000n } })).id,
  BudgetNotice: async ({ db, organizationId }, ensure) => (await db.budgetNotice.create({ data: { organizationId, budgetId: await ensure("Budget"), month: "2026-11", threshold: "warn" } })).id,
  HeldTurn: async ({ db, organizationId, projectId }, ensure) => (await db.heldTurn.create({ data: { organizationId, projectId, taskId: await ensure("Task"), origin: "dispatch", budgetId: await ensure("Budget") } })).id,
  TaskMetric: async ({ db, organizationId, projectId }, ensure) => (await db.taskMetric.create({ data: { organizationId, projectId, taskId: await ensure("Task"), createdAt: new Date() } })).id,
  InsightDaily: async ({ db, organizationId, projectId }) => (await db.insightDaily.create({ data: { organizationId, projectId, day: new Date("2026-11-01T00:00:00Z") } })).id,
  InsightRun: async ({ db, organizationId }) => (await db.insightRun.create({ data: { organizationId } })).organizationId,
  MemoryNote: async ({ db, organizationId, projectId }) =>
    (await db.memoryNote.create({ data: { organizationId, projectId, scope: "project", title: "A fixture note", body: "Run pnpm test.", kind: "command", sourceKind: "member" } })).id,
  MemoryNoteVersion: async ({ db, organizationId }, ensure) =>
    (await db.memoryNoteVersion.create({ data: { organizationId, noteId: await ensure("MemoryNote"), version: 1, title: "A fixture note", body: "Run pnpm test.", kind: "command", always: false } })).id,
  MemoryProposal: async ({ db, organizationId, projectId }, ensure) =>
    (await db.memoryProposal.create({ data: { organizationId, projectId, scope: "project", title: "A fixture proposal", body: "Use pnpm.", kind: "convention", sourceKind: "agent", taskId: await ensure("Task") } })).id,
  MemoryUse: async ({ db, organizationId, projectId }, ensure) =>
    (await db.memoryUse.create({ data: { organizationId, projectId, taskId: await ensure("Task"), sessionId: await ensure("Session"), noteId: await ensure("MemoryNote"), via: "index" } })).id,
  ReviewCheck: async ({ db, organizationId, projectId }, ensure) => (await db.reviewCheck.create({ data: { organizationId, projectId, taskRepoId: await ensure("TaskRepo"), prNumber: 1, headSha: "b".repeat(40) } })).id,
  ProviderListEntry: async ({ db, organizationId, projectId }, ensure) => (await db.providerListEntry.create({ data: { organizationId, projectId, providerId: await ensure("ModelProvider") } })).id,
  ModelChoice: async ({ db, organizationId, projectId }, ensure) => {
    const catalogId = `fixture/model-${tag()}`;
    return (await db.modelChoice.create({ data: { organizationId, projectId, modelKey: `catalog:${catalogId}`, modelCatalogId: catalogId, modelId: await ensure("Model"), reason: "admin" } })).id;
  },
  // Milestone 5: organization records, one per organization (a size per name, a registry each).
  BoxSize: async ({ db, organizationId }) => (await db.boxSize.create({ data: { organizationId, name: "small", cpuMillis: 2000, memoryMiB: 4096 } })).id,
  Registry: async ({ db, organizationId }) =>
    (await db.registry.create({ data: { organizationId, url: "registry.example.com", repositoryPrefix: `ostra-${tag()}`, auth: "basic", pushSecretId: `secret:${id()}`, pullSecretId: `secret:${id()}` } })).id,
  // Milestone 6 (its ticket 05).
  AutomationRun: async ({ db, organizationId, projectId }, ensure) =>
    (await db.automationRun.create({ data: { organizationId, projectId, automationId: await ensure("Automation"), kind: "occurrence", occurrenceAt: new Date(), state: "started", taskId: await ensure("Task") } })).id,
  BulkStart: async ({ db, organizationId, projectId, memberId }) =>
    (await db.bulkStart.create({ data: { organizationId, projectId, memberId, source: "inbox", requestKey: `bulk-${tag()}`, taskKind: "code", requested: 1 } })).id,
  BulkStartItem: async ({ db, organizationId, projectId }, ensure) =>
    (await db.bulkStartItem.create({ data: { organizationId, projectId, bulkStartId: await ensure("BulkStart"), ticketId: await ensure("Ticket"), state: "started", taskId: await ensure("Task") } })).id,
  AgentSession: async (place, ensure) =>
    (
      await place.db.agentSession.create({
        data: {
          organizationId: place.organizationId,
          connectionId: await linearOf(place),
          externalSessionId: `session-${tag()}`,
          projectId: place.projectId,
          ticketId: await ensure("Ticket"),
          taskId: await ensure("Task"),
          boardId: await ensure("Board"),
          creatorExternalId: `user-${tag()}`,
          creatorName: "Fixture Person",
          heartbeatDueAt: new Date(Date.now() + 20 * 60_000),
        },
      })
    ).id,
  AgentActivity: async ({ db, organizationId }, ensure) =>
    (await db.agentActivity.create({ data: { organizationId, agentSessionId: await ensure("AgentSession"), kind: "thought", body: "Received. Working on it in ostra.", idempotencyKey: `activity-${tag()}` } })).id,
  RefineDraft: async ({ db, organizationId, projectId }, ensure) =>
    (await db.refineDraft.create({ data: { organizationId, projectId, taskId: await ensure("Task"), version: 1, description: "A fixture draft.", source: "agent" } })).id,
  RefineDraftImage: async ({ db, organizationId, projectId }, ensure) =>
    (await db.refineDraftImage.create({ data: { organizationId, projectId, draftId: await ensure("RefineDraft"), blobId: await ensure("Blob"), name: "mock.png", contentType: "image/png", size: 1 } })).id,
  CiRun: async ({ db, organizationId, projectId }, ensure) =>
    (await db.ciRun.create({ data: { organizationId, projectId, taskRepoId: await ensure("TaskRepo"), headSha: randomBytes(20).toString("hex"), state: "passed" } })).id,
  TaskRound: async ({ db, organizationId, projectId }, ensure) =>
    (await db.taskRound.create({ data: { organizationId, projectId, taskId: await ensure("Task"), kind: "ci", number: 1, automatic: true, causeRef: randomBytes(20).toString("hex"), state: "started" } })).id,
  ReviewRun: async ({ db, organizationId, projectId }, ensure) =>
    (await db.reviewRun.create({ data: { organizationId, projectId, codeTaskId: await ensure("Task"), round: 1, state: "submitted" } })).id,
  Finding: async ({ db, organizationId, projectId }, ensure) =>
    (
      await db.finding.create({
        data: { organizationId, projectId, reviewRunId: await ensure("ReviewRun"), taskRepoId: await ensure("TaskRepo"), path: "src/a.ts", line: 1, side: "new", severity: "nit", title: "A fixture finding", body: "A fixture body." },
      })
    ).id,
  TaskReviewer: async ({ db, organizationId, projectId, memberId }, ensure) =>
    (await db.taskReviewer.create({ data: { organizationId, projectId, taskRepoId: await ensure("TaskRepo"), githubUserId: String(Math.floor(Math.random() * 1_000_000)), login: `reviewer-${tag()}`, memberId, source: "requested" } })).id,
  EnvironmentProposal: async ({ db, organizationId, projectId }, ensure) =>
    (await db.environmentProposal.create({ data: { organizationId, projectId, environmentId: await ensure("Environment"), taskId: await ensure("Task"), body: { repos: [], services: [], notes: "" } } })).id,
  // Milestone 8 (its ticket 04).
  AppProcess: async ({ db, organizationId, projectId }, ensure) =>
    (
      await db.appProcess.create({
        data: { organizationId, projectId, environmentId: await ensure("Environment"), repoId: await ensure("Repo"), name: `web-${tag()}`, command: "pnpm dev", port: 5173, readyKind: "http", readyValue: "/", label: "Web", primary: true },
      })
    ).id,
  TaskAttachment: async ({ db, organizationId, projectId }, ensure) =>
    (
      await db.taskAttachment.create({
        data: {
          organizationId,
          projectId,
          taskId: await ensure("Task"),
          attachmentId: `att-${tag()}`,
          kind: "screenshot",
          blobId: await ensure("Blob"),
          source: "agent",
          targetKind: "process",
          targetName: "web",
          path: "/",
          width: 1440,
          height: 900,
          caption: "A fixture caption.",
          browserName: "Chromium",
          browserVersion: "131.0.6778.85",
        },
      })
    ).id,
  TaskPreview: async ({ db, organizationId, projectId }, ensure) =>
    (await db.taskPreview.create({ data: { organizationId, projectId, taskId: await ensure("Task"), key: "port-4100", port: 4100, label: "Docs" } })).id,
  PreviewAccess: async ({ db, organizationId, projectId, memberId }, ensure) =>
    (await db.previewAccess.create({ data: { organizationId, projectId, taskId: await ensure("Task"), key: "app-web", level: "named", setByMemberId: memberId } })).id,
  PreviewAccessMember: async ({ db, organizationId, projectId, memberId }, ensure) =>
    (await db.previewAccessMember.create({ data: { organizationId, projectId, previewAccessId: await ensure("PreviewAccess"), memberId } })).id,
  PreviewLink: async ({ db, organizationId, projectId, memberId }, ensure) =>
    (
      await db.previewLink.create({
        data: { organizationId, projectId, taskId: await ensure("Task"), key: "app-web", kind: "expiring", tokenHash: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 3_600_000), createdByMemberId: memberId },
      })
    ).id,
  PreviewView: async ({ db, organizationId, projectId, memberId }, ensure) =>
    (await db.previewView.create({ data: { organizationId, projectId, taskId: await ensure("Task"), key: "app-web", mode: "stream", openedByMemberId: memberId, leaseEpoch: 1, state: "open" } })).id,
  PreviewCode: async ({ db, organizationId, projectId, memberId }, ensure) =>
    (
      await db.previewCode.create({
        data: { organizationId, projectId, kind: "enter", codeHash: randomBytes(32).toString("hex"), taskId: await ensure("Task"), key: "app-web", port: 5173, memberId, leaseEpoch: 1, expiresAt: new Date(Date.now() + 60_000) },
      })
    ).id,
  LibraryItem: async ({ db, organizationId, memberId }) =>
    (
      await db.libraryItem.create({
        data: { organizationId, kind: "skill", name: `skill-${tag()}`, sourceKind: "github", source: { kind: "github", owner: "ostra-test-skills", repo: "demo-skills", path: "release-notes" }, installedByMemberId: memberId },
      })
    ).id,
  LibraryItemVersion: async ({ db, organizationId }, ensure) =>
    (
      await db.libraryItemVersion.create({
        data: { organizationId, itemId: await ensure("LibraryItem"), number: 1, state: "current", ref: "main", commitSha: randomBytes(20).toString("hex"), computedHash: randomBytes(32).toString("hex") },
      })
    ).id,
  AgentProfileLibraryItem: async ({ db, organizationId, memberId }, ensure) =>
    (await db.agentProfileLibraryItem.create({ data: { organizationId, profileId: await ensure("AgentProfile"), itemId: await ensure("LibraryItem"), attachedByMemberId: memberId } })).id,
  LibrarySource: async ({ db, organizationId, memberId }) =>
    (await db.librarySource.create({ data: { organizationId, kind: "github_owner", value: `owner-${tag()}`, addedByMemberId: memberId } })).id,
  LibrarySuggestion: async ({ db, organizationId, memberId }) =>
    (await db.librarySuggestion.create({ data: { organizationId, memberId, reference: "ostra-test-skills/demo-skills@changelog", note: "A fixture note." } })).id,
  // Milestone 9 (its ticket 04): a member's file sent with a message of the task, its text beside it.
  MessageFile: async ({ db, organizationId, projectId, memberId }, ensure) =>
    (
      await db.messageFile.create({
        data: {
          organizationId,
          projectId,
          taskId: await ensure("Task"),
          memberId,
          origin: "member",
          state: "sent",
          sessionId: await ensure("Session"),
          clientMessageId: `client-${tag()}`,
          eventSeq: 1,
          position: 0,
          name: "_(rm -rf _) spec.docx",
          kind: "document",
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size: 1,
          sha256: randomBytes(32).toString("hex"),
          blobId: await ensure("Blob"),
          boxPath: `attachments/1/spec-${tag()}.docx`,
          textState: "ready",
          textBlobId: await ensure("Blob"),
          textWords: 3,
          sentAt: new Date(),
        },
      })
    ).id,
  TaskTicketRead: async ({ db, organizationId, projectId }, ensure) =>
    (await db.taskTicketRead.create({ data: { organizationId, projectId, taskId: await ensure("Task"), round: 1, reason: "start", descriptionSha256: randomBytes(32).toString("hex"), comments: [], fileKeys: [] } })).id,
  EnvironmentRepoDraft: async ({ db, organizationId, projectId, memberId }, ensure) => {
    // A draft waits only beside a saved environment: saved, with a plain script the draft would
    // change, so its readers return it and a leak check would see it cross.
    const environmentId = await ensure("Environment");
    await db.environment.update({ where: { id: environmentId }, data: { status: "saved", setupScript: "corepack enable\npnpm install\n", savedAt: new Date() } });
    return (
      await db.environmentRepoDraft.create({
        data: {
          organizationId,
          projectId,
          environmentId,
          repoId: await ensure("Repo"),
          createdByMemberId: memberId,
          detection: { baseImage: null, setupLines: ["uv sync --frozen"], setupScript: "set -euo pipefail\nuv sync --frozen\n", variables: [], tools: [], services: [], appProcesses: [], reasons: [{ file: "uv.lock", finding: "uv" }] },
        },
      })
    ).id;
  },
};

/** The models without `organizationId`, each with why it has none (reviewed: ADR 0053). */
export const isolationAllowlist = {
  User: "an account is the install's, and may belong to several organizations (ADR 0053)",
  AuthSession: "better-auth's sign-in session, an account's; it names its active organization",
  Account: "better-auth's credentials of an account, the install's",
  Verification: "better-auth's tokens (reset, verification), keyed by identifier; never read by an organization's procedures",
  Organization: "the organization itself: its ID is what every other row carries",
  InstanceSetting: "the install's own settings, one row",
  EmailSettings: "the install's mail settings, one row (F-115)",
  SecretsKeyCheck: "the install's check of its secrets key, one row",
  ResetLinkGrant: "an account's reset link, the install's (ADR 0053); its audit entries go to each of the account's organizations",
} as const;

/** Every model whose rows sit inside a project: the builders put them in `place.projectId`. */
export const isolationProjectModels: ReadonlySet<IsolationModelName> = new Set<IsolationModelName>([
  "AuditEntry",
  "ChangeNotice",
  "ProjectMember",
  "ProjectPool",
  "Repo",
  "Board",
  "Ticket",
  "TicketWrite",
  "Environment",
  "EnvironmentEntry",
  "Service",
  "Check",
  "Snapshot",
  "Automation",
  "Task",
  "TaskRepo",
  "TaskCoAuthor",
  "Box",
  "SidecarCommand",
  "Lease",
  "Session",
  "Turn",
  "Event",
  "Command",
  "Approval",
  "NeedsYouItem",
  "Blob",
  "BlobUpload",
  "TaskApprovalRule",
  "DiffComment",
  "DiffCache",
  "TaskPullRequest",
  "CheckRun",
  "Notification",
  "SearchEntry",
  "SpendDaily",
  "Budget",
  "HeldTurn",
  "TaskMetric",
  "InsightDaily",
  "MemoryNote",
  "MemoryProposal",
  "MemoryUse",
  "ReviewCheck",
  "ProviderListEntry",
  "ModelChoice",
  // Milestone 6.
  "AutomationRun",
  "BulkStart",
  "BulkStartItem",
  "AgentSession",
  "RefineDraft",
  "RefineDraftImage",
  "CiRun",
  "TaskRound",
  "ReviewRun",
  "Finding",
  "TaskReviewer",
  "EnvironmentProposal",
  // Milestone 8.
  "AppProcess",
  "TaskAttachment",
  "TaskPreview",
  "PreviewAccess",
  "PreviewAccessMember",
  "PreviewLink",
  "PreviewView",
  "PreviewCode",
  // Milestone 9.
  "MessageFile",
  "TaskTicketRead",
  "EnvironmentRepoDraft",
]);

export const isolationModelNames = (): readonly IsolationModelName[] => isolationModelList;

/**
 * Builds every listed model in one organization: its organization records once, and its project
 * records in each project given. Answers each project's rows: every model's row ID.
 */
export const buildIsolationRows = async (
  db: Db,
  organization: { readonly organizationId: string; readonly memberId: string; readonly userId: string },
  projectIds: readonly string[],
): Promise<ReadonlyMap<string, ReadonlyMap<IsolationModelName, string>>> => {
  const organizationRows = new Map<IsolationModelName, Promise<string>>();
  const byProject = new Map<string, ReadonlyMap<IsolationModelName, string>>();
  for (const projectId of projectIds) {
    const place: FixturePlace = { db, organizationId: organization.organizationId, projectId, memberId: organization.memberId, userId: organization.userId };
    const projectRows = new Map<IsolationModelName, Promise<string>>();
    const ensure: Ensure = (model) => {
      const memo = isolationProjectModels.has(model) ? projectRows : organizationRows;
      const known = memo.get(model);
      if (known !== undefined) {
        return known;
      }
      const builder: FixtureBuilder = isolationModels[model];
      const made = builder(place, ensure);
      memo.set(model, made);
      return made;
    };
    const rows = new Map<IsolationModelName, string>();
    for (const model of isolationModelNames()) {
      rows.set(model, await ensure(model));
    }
    byProject.set(projectId, rows);
  }
  return byProject;
};
