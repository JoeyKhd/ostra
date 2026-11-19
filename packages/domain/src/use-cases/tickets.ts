import type { Ticket as TrackerTicket, TrackerWebhookHint } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import {
  agentProfileIdSchema,
  boardIdSchema,
  organizationIdSchema,
  projectIdSchema,
  runnerIdSchema,
  sessionIdSchema,
  taskIdSchema,
  ticketIdSchema,
  ticketWriteIdSchema,
} from "@ostra/protocol";
import type { BoardId, ExternalTicketId, SessionId, TaskId, TicketId, TicketWriteId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { branchSlugFor } from "../branch-name.ts";
import { taskToColumns } from "../lifecycles/mapping.ts";
import { newTask } from "../lifecycles/task.ts";
import type { Ports } from "../ports.ts";
import { ingestTicketHintBody } from "../tickets/ticket-cache.ts";
import { ticketWriteKey } from "../tickets/contracts.ts";
import type { TicketWritePayload, TicketWriteStep } from "../tickets/contracts.ts";
import type { UseCaseResult } from "./common.ts";
import { claimBranchNameInTx } from "./create-prompt-task.ts";
import type { ConnectionTracker } from "./linear-connection.ts";
import { signedCommitRefusal, unsupportedRepos } from "./repo-checks.ts";

// Tickets in (F-010, F-042, F-064, F-097, spec section 4, "A ticket change" and "A ticket becomes a
// task"). A ticket's text is untrusted throughout: it's data in the cache and the prompt, never a
// log line, never a shell argument.

// ---------- ingest (ticket 14) ----------

/** What `ingestTicketHint` was handed: a webhook's hint, or a poll's ticket. */
export type TicketChange =
  | { readonly source: "webhook"; readonly hint: TrackerWebhookHint }
  | { readonly source: "poll"; readonly boardId: BoardId; readonly ticket: TrackerTicket };

export type IngestTicketHintResult = UseCaseResult<
  {
    readonly outcome:
      | "upserted"
      /** The connection's own app user made the change: recorded, not acted on. */
      | "own-echo"
      /** The ticket is on no board of this organization. */
      | "not-on-a-board"
      /** The tracker says the ticket is gone, or left the board: `removedAt` set. */
      | "removed";
    readonly ticketIds: readonly TicketId[];
    readonly externalId: ExternalTicketId | null;
  },
  "tracker-failed" | "rate-limited"
>;

export type IngestTicketHintDeps = Pick<Ports, "notices" | "clock"> & {
  readonly db: Db;
  readonly tracker: ConnectionTracker;
};

/**
 * Reads the ticket a hint names through the adapter (the hint is never trusted for content), and
 * upserts its cache row on every board of the connection that holds it, by the board and the
 * stable ID, never by the key.
 */
export type IngestTicketHint = (deps: IngestTicketHintDeps, change: TicketChange) => Promise<IngestTicketHintResult>;

export const ingestTicketHint: IngestTicketHint = (deps, change) => ingestTicketHintBody(deps, change);

// ---------- start a task from a ticket (ticket 29) ----------

export const startTicketTaskInputSchema = z.strictObject({
  projectId: projectIdSchema,
  ticketId: ticketIdSchema,
  /** Defaults to `code`. */
  kind: z.enum(["code"]).optional(),
  /** Defaults to the project's default profile for the kind. */
  agentProfileId: agentProfileIdSchema.optional(),
  /** The member's own personal runner, or unset to pick from the project's pools. */
  runnerId: runnerIdSchema.optional(),
});
export type StartTicketTaskInput = z.infer<typeof startTicketTaskInputSchema>;

export type StartTicketTaskResult =
  | UseCaseResult<
      { readonly taskId: TaskId; readonly sessionId: SessionId; readonly branchName: string },
      | "not-found"
      | "forbidden"
      | "no-agent-profile"
      | "no-repo"
      | "runner-not-yours"
      | "provider-not-allowed-on-personal-runners"
      /** A repo's default branch requires signed commits (F-055). */
      | "repo-unsupported"
    >
  /** One active code task per ticket per project: the one there is (spec section 11, item 12). */
  | { readonly ok: false; readonly error: "ticket-has-task"; readonly message: string; readonly taskId: TaskId };

export type StartTicketTaskDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
  /** The panel's address: the link to the task that goes on the ticket. */
  readonly publicUrl: string;
};

const TERMINAL_TASK_STATES = ["stopped", "merged", "done"] as const;

/**
 * Writes one `TicketWrite` and sends its `ticket.sync` job in the caller's transaction (F-031,
 * F-046). The idempotency key is fixed by the task and the step, so a replay finds the row.
 */
const writeTicket = async (
  deps: Pick<StartTicketTaskDeps, "tx" | "jobs">,
  at: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly taskId: TaskId;
    readonly boardId: string;
    readonly ticketId: string | null;
    readonly connectionId: string;
  },
  step: TicketWriteStep,
  payload: TicketWritePayload,
): Promise<TicketWriteId> => {
  const row = await deps.tx.ticketWrite.create({
    data: {
      organizationId: at.organizationId,
      projectId: at.projectId,
      taskId: at.taskId,
      boardId: at.boardId,
      ticketId: at.ticketId,
      kind: payload.kind,
      payload,
      idempotencyKey: ticketWriteKey(at.taskId, step),
    },
    select: { id: true },
  });
  const ticketWriteId = ticketWriteIdSchema.parse(row.id);
  // Throttled per connection: a tracker's rate limit is the connection's (ADR 0037).
  await deps.jobs.enqueueInTx(
    deps.tx,
    "ticket.sync",
    { organizationId: organizationIdSchema.parse(at.organizationId), ticketWriteId },
    { group: { id: at.connectionId } },
  );
  return ticketWriteId;
};

/**
 * Creates the task (source `ticket`, the ticket's ID and key, the branch with the key) under the
 * partial unique index, writes the ticket's "started" writes to the outbox, and enqueues
 * `ticket.fetch-context`, which renders the prompt and dispatches.
 */
export type StartTicketTask = (deps: StartTicketTaskDeps, input: StartTicketTaskInput) => Promise<StartTicketTaskResult>;

type StartRefusal = Exclude<Extract<StartTicketTaskResult, { readonly ok: false }>["error"], "ticket-has-task">;

const refuseStart = (error: StartRefusal, message: string): StartTicketTaskResult => ({ ok: false, error, message });

/** A ticket task's branch: the ticket's key, the last digits of the task's ID, the title's slug (spec section 11, item 5). */
const ticketBranchWith = (key: string) => (taskId: TaskId, title: string, digits: number) =>
  `ostra/${key.toLowerCase()}-${taskId.replaceAll("-", "").slice(-digits)}-${branchSlugFor(title)}`;

export const startTicketTask: StartTicketTask = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId } });
  if (project === null) {
    return refuseStart("not-found", "No such project");
  }
  // Anyone who can open the project may start a task in it.
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read");
  if (!access.ok) {
    return access.code === "not-found" ? refuseStart("not-found", "No such project") : refuseStart("forbidden", "You may not start a task in this project");
  }

  // The ticket row is locked for this transaction: two members starting the same ticket at once
  // queue up here, and the second one finds the first one's task (the partial unique index is the backstop).
  const locked: unknown = await tx.$queryRaw`
    SELECT "id" FROM "ticket" WHERE "id" = ${input.ticketId} AND "projectId" = ${project.id} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (!Array.isArray(locked) || locked.length === 0) {
    return refuseStart("not-found", "No such ticket in this project");
  }
  const ticket = await tx.ticket.findUniqueOrThrow({ where: { id: input.ticketId } });
  const board = await tx.board.findFirst({ where: { id: ticket.boardId, projectId: project.id, organizationId }, include: { connection: { select: { state: true } } } });
  if (ticket.removedAt !== null || board?.detachedAt !== null || board.connection.state === "revoked") {
    return refuseStart("not-found", "That ticket's board is detached, or the ticket left it: no new task starts from it");
  }

  const existing = await tx.task.findFirst({
    where: { projectId: project.id, organizationId, ticketId: ticket.id, kind: "code", state: { notIn: [...TERMINAL_TASK_STATES] } },
    select: { id: true },
  });
  if (existing !== null) {
    const taskId = taskIdSchema.parse(existing.id);
    return { ok: false, error: "ticket-has-task", message: `This ticket already has an active task, ${taskId}.`, taskId };
  }

  const profileId = input.agentProfileId ?? project.defaultCodeProfileId;
  const profile =
    profileId === null
      ? null
      : await tx.agentProfile.findFirst({
          where: { id: profileId, organizationId },
          include: { model: { include: { provider: { select: { allowOnPersonalRunners: true } } } } },
        });
  const noModel = "The project's default code profile has no model yet: an admin picks one under Models";
  if (profile?.model === null || profile === null) {
    return refuseStart("no-agent-profile", noModel);
  }
  const { model } = profile;
  const repos = await tx.repo.findMany({ where: { projectId: project.id, organizationId }, orderBy: { createdAt: "asc" } });
  if (repos.length === 0) {
    return refuseStart("no-repo", "The project has no repo");
  }
  // F-055: the router refreshed the stored check just before this transaction; `unknown` never refuses.
  const unsupported = await unsupportedRepos(tx, organizationId, projectIdSchema.parse(project.id));
  if (unsupported.length > 0) {
    return refuseStart("repo-unsupported", signedCommitRefusal(unsupported));
  }
  if (input.runnerId !== undefined) {
    const runner = await tx.runner.findFirst({
      where: { id: input.runnerId, organizationId, kind: "personal", ownerMemberId: scope.memberId, state: { not: "revoked" } },
      select: { id: true },
    });
    if (runner === null) {
      return refuseStart("runner-not-yours", "That isn't one of your personal runners");
    }
    if (!model.provider.allowOnPersonalRunners) {
      return refuseStart(
        "provider-not-allowed-on-personal-runners",
        "The project's model provider isn't allowed on personal runners: an admin turns it on under Models",
      );
    }
  }

  const title = ticket.title.replace(/\s+/g, " ").trim().slice(0, 512) || ticket.key;
  const created = await tx.task.create({
    data: {
      organizationId,
      projectId: project.id,
      source: "ticket",
      title,
      // The prompt is the rendered ticket: `ticket.fetch-context` writes it, with the first message.
      branchName: "pending",
      ticketId: ticket.id,
      ticketKey: ticket.key,
      boardId: board.id,
      driverMemberId: scope.memberId,
      creatorMemberId: scope.memberId,
      runnerId: input.runnerId ?? null,
      ...taskToColumns(newTask("code", false)),
    },
    select: { id: true },
  });
  const taskId = taskIdSchema.parse(created.id);
  const branchName = await claimBranchNameInTx(tx, { id: taskId, title }, ticketBranchWith(ticket.key));
  await tx.taskRepo.createMany({
    data: repos.map((repo) => ({ organizationId, projectId: project.id, taskId, repoId: repo.id, branchName, baseBranch: repo.defaultBranch })),
  });
  const member = await tx.member.findFirstOrThrow({ where: { id: scope.memberId, organizationId }, select: { user: { select: { name: true, email: true } } } });
  await tx.taskCoAuthor.create({
    data: { organizationId, projectId: project.id, taskId, memberId: scope.memberId, name: member.user.name, email: member.user.email },
  });
  const session = await tx.session.create({
    data: { organizationId, projectId: project.id, taskId, agentProfileId: profile.id, origin: "new", state: "starting" },
    select: { id: true },
  });
  const sessionId = sessionIdSchema.parse(session.id);

  // The ticket's "started" writes (spec section 3, step 4), in the same transaction: the move to the
  // mapped status, one comment from the app with a link to the task, and a link attachment to it.
  const at = { organizationId, projectId: project.id, taskId, boardId: board.id, ticketId: ticket.id, connectionId: board.connectionId };
  const taskUrl = `${deps.publicUrl.replace(/\/+$/, "")}/tasks/${taskId}`;
  await writeTicket(deps, at, { kind: "move", target: "started" }, { kind: "move", target: "started" });
  await writeTicket(deps, at, { kind: "comment" }, { kind: "comment", markdown: `ostra is working on this: ${taskUrl}` });
  await writeTicket(deps, at, { kind: "link_task" }, { kind: "link_task", url: taskUrl, title: `ostra task: ${title}`.slice(0, 256), subtitle: null });

  // The prompt is rendered from the ticket's full context, which the job reads: it then dispatches.
  await deps.jobs.enqueueInTx(tx, "ticket.fetch-context", { organizationId: organizationIdSchema.parse(organizationId), taskId, sessionId });
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: projectIdSchema.parse(project.id),
    actor: { kind: "member", id: scope.memberId },
    action: "task.created",
    entity: "task",
    entityId: taskId,
    data: { kind: "code", source: "ticket", onPersonalRunner: input.runnerId !== undefined },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId: projectIdSchema.parse(project.id), entity: "task", entityId: taskId });
  return { ok: true, taskId, sessionId, branchName };
};

// ---------- "Create ticket" (F-097, ticket 29) ----------

export const createTicketForTaskInputSchema = z.strictObject({
  taskId: taskIdSchema,
  boardId: boardIdSchema,
  /** Defaults to the task's title. */
  title: z.string().trim().min(1).max(512).optional(),
  /** Defaults to the task's prompt. Untrusted text, never logged. */
  description: z.string().max(262_144).optional(),
});
export type CreateTicketForTaskInput = z.infer<typeof createTicketForTaskInputSchema>;

export type CreateTicketForTaskResult = UseCaseResult<
  { readonly ticketWriteId: TicketWriteId },
  "not-found" | "forbidden" | "already-has-ticket" | "not-a-prompt-task"
>;

/** Writes a `create` ticket write; `ticket.sync` makes the ticket and links the task to it. */
export type CreateTicketForTask = (deps: StartTicketTaskDeps, input: CreateTicketForTaskInput) => Promise<CreateTicketForTaskResult>;

export const retryTicketWritesInputSchema = z.strictObject({ taskId: taskIdSchema });
export type RetryTicketWritesInput = z.infer<typeof retryTicketWritesInputSchema>;

export type RetryTicketWritesResult = UseCaseResult<{ readonly retried: number }, "not-found" | "forbidden">;

/**
 * Sets the task's failed ticket writes back to pending and sends each one's `ticket.sync` job
 * again (F-031): "Retry sync" on the task page. A write keeps its idempotency key, so a retry
 * after a write that did reach the tracker finds it instead of making a second one (F-046).
 */
export const retryTicketWrites = async (
  deps: Pick<Ports, "jobs" | "notices" | "audit" | "clock"> & { readonly tx: Tx; readonly scope: MemberScope },
  input: RetryTicketWritesInput,
): Promise<RetryTicketWritesResult> => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const refuse = (error: "not-found" | "forbidden", message: string): RetryTicketWritesResult => ({ ok: false, error, message });
  const task = await tx.task.findFirst({ where: { id: input.taskId, organizationId }, select: { id: true, projectId: true } });
  const project = task === null ? null : await tx.project.findFirst({ where: { id: task.projectId, organizationId }, select: { id: true, access: true } });
  if (task === null || project === null) {
    return refuse("not-found", "No such task");
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read");
  if (!access.ok) {
    return access.code === "not-found" ? refuse("not-found", "No such task") : refuse("forbidden", "You may not change this task");
  }
  const failed = await tx.ticketWrite.findMany({ where: { taskId: task.id, organizationId, state: "failed" }, include: { board: { select: { connectionId: true } } } });
  for (const write of failed) {
    await tx.ticketWrite.update({ where: { id: write.id }, data: { state: "pending", error: null } });
    await deps.jobs.enqueueInTx(
      tx,
      "ticket.sync",
      { organizationId: organizationIdSchema.parse(organizationId), ticketWriteId: ticketWriteIdSchema.parse(write.id) },
      { group: { id: write.board.connectionId } },
    );
  }
  if (failed.length > 0) {
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: projectIdSchema.parse(project.id),
      actor: { kind: "member", id: scope.memberId },
      action: "task.ticket-sync-retried",
      entity: "task",
      entityId: taskIdSchema.parse(task.id),
      data: { writes: failed.length },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: projectIdSchema.parse(project.id), entity: "task", entityId: taskIdSchema.parse(task.id) });
  }
  return { ok: true, retried: failed.length };
};

export const createTicketForTask: CreateTicketForTask = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const refuse = (error: Exclude<CreateTicketForTaskResult, { readonly ok: true }>["error"], message: string): CreateTicketForTaskResult => ({ ok: false, error, message });
  // The task row is locked: two presses of "Create ticket" queue up here and the second finds the first.
  const locked: unknown = await tx.$queryRaw`
    SELECT "id" FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (!Array.isArray(locked) || locked.length === 0) {
    return refuse("not-found", "No such task");
  }
  const task = await tx.task.findUniqueOrThrow({ where: { id: input.taskId } });
  const project = await tx.project.findFirst({ where: { id: task.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return refuse("not-found", "No such task");
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read");
  if (!access.ok) {
    return access.code === "not-found" ? refuse("not-found", "No such task") : refuse("forbidden", "You may not change this task");
  }
  if (task.source !== "prompt") {
    return refuse("not-a-prompt-task", "Only a task started from a prompt gets a ticket made for it");
  }
  const made = await tx.ticketWrite.findFirst({ where: { taskId: task.id, kind: "create" }, select: { id: true } });
  if (task.ticketId !== null || made !== null) {
    return refuse("already-has-ticket", "This task already has a ticket, or one is being made for it");
  }
  const board = await tx.board.findFirst({ where: { id: input.boardId, projectId: project.id, organizationId }, include: { connection: { select: { state: true } } } });
  if (board?.detachedAt !== null || board.connection.state !== "active") {
    return refuse("not-found", "No such board on this project, or its connection isn't active");
  }

  const title = (input.title ?? task.title).replace(/\s+/g, " ").trim().slice(0, 512);
  const description = input.description ?? task.prompt;
  const ticketWriteId = await writeTicket(
    deps,
    { organizationId, projectId: project.id, taskId: taskIdSchema.parse(task.id), boardId: board.id, ticketId: null, connectionId: board.connectionId },
    { kind: "create" },
    { kind: "create", title: title === "" ? task.title.slice(0, 512) : title, description: description === null ? null : description.slice(0, 262_144) },
  );
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: projectIdSchema.parse(project.id),
    actor: { kind: "member", id: scope.memberId },
    action: "task.ticket-requested",
    entity: "task",
    entityId: taskIdSchema.parse(task.id),
    data: { boardId: input.boardId },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId: projectIdSchema.parse(project.id), entity: "task", entityId: taskIdSchema.parse(task.id) });
  return { ok: true, ticketWriteId };
};
