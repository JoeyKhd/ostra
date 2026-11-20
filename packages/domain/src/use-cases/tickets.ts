import type { Ticket as TrackerTicket, TrackerWebhookHint } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import {
  agentProfileIdSchema,
  boardIdSchema,
  organizationIdSchema,
  projectIdSchema,
  runnerIdSchema,
  taskIdSchema,
  ticketIdSchema,
  ticketWriteIdSchema,
} from "@ostra/protocol";
import type { BoardId, ExternalTicketId, SessionId, TaskId, TicketId, TicketWriteId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { startTask } from "../starts/start-task-body.ts";
import { ingestTicketHintBody } from "../tickets/ticket-cache.ts";
import type { TicketWritePayload, TicketWriteStep } from "../tickets/contracts.ts";
import { writeTicketOutboxInTx } from "../tickets/ticket-outbox.ts";
import type { TicketWriteTarget } from "../tickets/ticket-outbox.ts";
import type { UseCaseResult } from "./common.ts";
import type { ConnectionTracker } from "./linear-connection.ts";

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
    /** Milestone 3 (F-066): the rows this read moved from an open category to `done` or `cancelled`. */
    readonly closedTicketIds?: readonly TicketId[];
  },
  "tracker-failed" | "rate-limited"
>;

export type IngestTicketHintDeps = Pick<Ports, "notices" | "clock"> & {
  readonly db: Db;
  readonly tracker: ConnectionTracker;
  /** Milestone 6 (F-011): the queue for `intake.match`, sent with the upsert. Without it, no rule sees the change. */
  readonly jobs?: Ports["jobs"];
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
      /** Milestone 4 (F-135): no provider on the project's list serves the profile's model. */
      | "no-provider-for-model"
      /** A repo's default branch requires signed commits (F-055). */
      | "repo-unsupported"
      /** Milestone 6 (F-077): the ticket has open sub-issues; `startSubIssues` starts its leaves instead. */
      | "has-sub-issues"
    >
  /** One active code task per ticket per project: the one there is (spec section 11, item 12). */
  | { readonly ok: false; readonly error: "ticket-has-task"; readonly message: string; readonly taskId: TaskId };

export type StartTicketTaskDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
  /** The panel's address: the link to the task that goes on the ticket. */
  readonly publicUrl: string;
};

/**
 * Writes one `TicketWrite` and sends its `ticket.sync` job in the caller's transaction (F-031,
 * F-046). The idempotency key is fixed by the task and the step, so a replay finds the row.
 */
const writeTicket = (
  deps: Pick<StartTicketTaskDeps, "tx" | "jobs">,
  at: TicketWriteTarget,
  step: TicketWriteStep,
  payload: TicketWritePayload,
): Promise<TicketWriteId> => writeTicketOutboxInTx(deps, at, step, payload);

/**
 * Creates the task (source `ticket`, the ticket's ID and key, the branch with the key) under the
 * partial unique index, writes the ticket's "started" writes to the outbox, and enqueues
 * `ticket.fetch-context`, which renders the prompt and dispatches. Milestone 6's ticket 11 moved
 * the body onto the one start (`starts/start-task-body.ts`): this checks the member's access and
 * hands it over.
 */
export type StartTicketTask = (deps: StartTicketTaskDeps, input: StartTicketTaskInput) => Promise<StartTicketTaskResult>;

type StartRefusal = Exclude<Extract<StartTicketTaskResult, { readonly ok: false }>["error"], "ticket-has-task">;

const refuseStart = (error: StartRefusal, message: string): StartTicketTaskResult => ({ ok: false, error, message });

export const startTicketTask: StartTicketTask = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return refuseStart("not-found", "No such project");
  }
  // Anyone who can open the project may start a task in it.
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read");
  if (!access.ok) {
    return access.code === "not-found" ? refuseStart("not-found", "No such project") : refuseStart("forbidden", "You may not start a task in this project");
  }
  const started = await startTask(
    { tx, jobs: deps.jobs, notices: deps.notices, audit: deps.audit, clock: deps.clock, scope, publicUrl: deps.publicUrl },
    {
      organizationId,
      projectId: projectIdSchema.parse(project.id),
      origin: { kind: "member", memberId: scope.memberId },
      kind: input.kind ?? "code",
      ticketId: input.ticketId,
      prompt: null,
      title: null,
      agentProfileId: input.agentProfileId ?? null,
      poolLabels: [],
      runnerId: input.runnerId ?? null,
    },
  );
  if (started.ok) {
    return { ok: true, taskId: started.taskId, sessionId: started.sessionId, branchName: started.branchName };
  }
  switch (started.error) {
    case "ticket-has-active-task":
      return { ok: false, error: "ticket-has-task", message: `This ticket already has an active task, ${started.taskId}.`, taskId: started.taskId };
    case "not-found":
    case "forbidden":
    case "runner-not-yours":
    case "provider-not-allowed-on-personal-runners":
    case "no-provider-for-model":
    case "no-agent-profile":
    case "no-repo":
    case "repo-unsupported":
    case "has-sub-issues":
      return refuseStart(started.error, started.message);
    // A member's ticket start has its ticket and its own profile choice: neither comes back for it.
    case "invalid-input":
    case "no-default-profile":
      return refuseStart("not-found", started.message);
    default:
      return started satisfies never;
  }
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
