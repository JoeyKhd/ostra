import type { Task, Tx } from "@ostra/db";
import { connectionIdSchema, leaseEpochSchema, organizationIdSchema, projectIdSchema, sessionIdSchema, taskIdSchema, ticketWriteIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, ProjectId, TaskId } from "@ostra/protocol";

import { requireOrganizationAdmin, requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { AgentSessionMoment } from "../linear/agent-session-copy.ts";
import { ticketWriteKey } from "../tickets/contracts.ts";
import type { TicketWritePayload, TicketWriteStep } from "../tickets/contracts.ts";
import type { JobQueue } from "../ports.ts";
import { endAgentSessionInTx, moveAgentSessionInTx, momentActivityKey, openAgentSessionOfTaskInTx, postAgentActivity } from "./agent-sessions.ts";
import type { UseCaseResult } from "./common.ts";
import type { ApproveOutsideTask, M6Deps, M6LinkDeps, RejectOutsideTask, SetOutsideApproval } from "./m6-signatures.ts";
import { moveTaskInTx } from "./moves.ts";
import { resolveNeedsYouItemsInTx } from "./needs-you-items.ts";
import { appendServerEvent } from "./server-events.ts";

// Outside tasks (F-040, ADR 0057, ADR 0031; milestone 6's ticket 14): a task a tracker user who
// matched no member started waits in "Needs approval" while its project's switch is on. Any member
// who can open the project approves or rejects it; the first answer wins, under the task row's
// lock. Approval queues it (its ticket's "started" writes and its first prompt follow, as any
// ticket task's start); a rejection stops it with `rejected`. Its agent session, if Linear started
// it, hears either in ostra's own words. Only an organization admin switches the approval off for
// a project, since that widens who can spend the organization's money on its pools.

/** The panel's address, for the links ostra posts (a task's page). */
export type TaskLinks = { readonly publicUrl: string };

/** A task's page in the panel. */
export const taskPageUrl = (publicUrl: string, taskId: TaskId): string => `${publicUrl.replace(/\/+$/, "")}/tasks/${taskId}`;

export type OutsideDecisionDeps = M6LinkDeps;

type Decision = "approve" | "reject";

type DecisionError = "forbidden" | "not-found" | "not-awaiting-approval";

/** The task, locked, and the scope's right to answer it: any member who can open its project. */
const lockAnswerableInTx = async (
  tx: Tx,
  scope: MemberScope,
  taskId: TaskId,
): Promise<
  | { readonly ok: true; readonly task: Task }
  | { readonly ok: false; readonly error: DecisionError; readonly message: string }
> => {
  const organizationId = scope.organizationId;
  // Two members answering at once queue up on the row: the second finds it answered.
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT "id" FROM "task" WHERE "id" = ${taskId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  const task = locked.length === 0 ? null : await tx.task.findUnique({ where: { id: taskId } });
  if (task === null) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  const project = await tx.project.findFirst({ where: { id: task.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read");
  if (!access.ok) {
    return access.code === "not-found"
      ? { ok: false, error: "not-found", message: "No such task" }
      : { ok: false, error: "forbidden", message: "You may not answer this task" };
  }
  if (task.state !== "awaiting_approval") {
    return { ok: false, error: "not-awaiting-approval", message: "The task isn't waiting for approval: someone answered it already" };
  }
  return { ok: true, task };
};

/**
 * A ticket task's "started" writes, in the caller's transaction, as a member's start writes them
 * (milestone 2's `startTicketTask`): the move to the mapped status, one comment with the task's link
 * and a link attachment. Each is keyed by the task and the step, so a replay writes none twice.
 */
export const writeTicketStartedInTx = async (
  deps: { readonly jobs: JobQueue },
  tx: Tx,
  at: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly taskId: TaskId;
    readonly boardId: string;
    readonly ticketId: string;
    readonly connectionId: ConnectionId;
    readonly taskUrl: string;
    readonly title: string;
  },
): Promise<void> => {
  const write = async (step: TicketWriteStep, payload: TicketWritePayload): Promise<void> => {
    const created = await tx.ticketWrite.createManyAndReturn({
      data: [
        {
          organizationId: at.organizationId,
          projectId: at.projectId,
          taskId: at.taskId,
          boardId: at.boardId,
          ticketId: at.ticketId,
          kind: payload.kind,
          payload,
          idempotencyKey: ticketWriteKey(at.taskId, step),
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    for (const row of created) {
      await deps.jobs.enqueueInTx(tx, "ticket.sync", { organizationId: at.organizationId, ticketWriteId: ticketWriteIdSchema.parse(row.id) }, { group: { id: at.connectionId } });
    }
  };
  await write({ kind: "move", target: "started" }, { kind: "move", target: "started" });
  await write({ kind: "comment" }, { kind: "comment", markdown: `ostra is working on this: ${at.taskUrl}` });
  await write({ kind: "link_task" }, { kind: "link_task", url: at.taskUrl, title: `ostra task: ${at.title}`.slice(0, 256), subtitle: null });
};

/**
 * What makes a queued task run, in the caller's transaction: a ticket task's prompt is rendered by
 * `ticket.fetch-context` from the ticket (which then dispatches), after its "started" writes; a task
 * with its prompt already dispatches at once.
 */
export const releaseQueuedTaskInTx = async (
  deps: { readonly jobs: JobQueue },
  tx: Tx,
  task: {
    readonly id: TaskId;
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly ticketId: string | null;
    readonly boardId: string | null;
    readonly prompt: string | null;
    readonly leaseEpoch: number;
  },
  links: TaskLinks,
): Promise<void> => {
  const session = await tx.session.findFirst({ where: { taskId: task.id, state: "starting" }, orderBy: { startedAt: "desc" }, select: { id: true } });
  if (session === null) {
    return;
  }
  const sessionId = sessionIdSchema.parse(session.id);
  if (task.ticketId !== null && task.boardId !== null) {
    const board = await tx.board.findFirst({ where: { id: task.boardId, organizationId: task.organizationId }, select: { connectionId: true } });
    if (board !== null) {
      await writeTicketStartedInTx(deps, tx, {
        organizationId: task.organizationId,
        projectId: task.projectId,
        taskId: task.id,
        boardId: task.boardId,
        ticketId: task.ticketId,
        connectionId: connectionIdSchema.parse(board.connectionId),
        taskUrl: taskPageUrl(links.publicUrl, task.id),
        title: task.title,
      });
    }
    if (task.prompt === null) {
      await deps.jobs.enqueueInTx(tx, "ticket.fetch-context", { organizationId: task.organizationId, taskId: task.id, sessionId });
      return;
    }
  }
  await deps.jobs.enqueueInTx(tx, "task.dispatch", {
    organizationId: task.organizationId,
    taskId: task.id,
    sessionId,
    leaseEpoch: leaseEpochSchema.parse(task.leaseEpoch + 1),
  });
};

/** Tells the task's agent session, if Linear started it: the moment, once, under its key. */
const tellSessionInTx = async (deps: M6Deps & { readonly tx: Tx }, organizationId: OrganizationId, taskId: TaskId, moment: AgentSessionMoment): Promise<void> => {
  const session = await openAgentSessionOfTaskInTx(deps.tx, organizationId, taskId);
  if (session === null) {
    return;
  }
  await postAgentActivity(deps, { organizationId, agentSessionId: session.agentSessionId, moment, idempotencyKey: momentActivityKey(session.agentSessionId, moment.kind) });
  const now = deps.clock.now();
  if (moment.kind === "approved") {
    await moveAgentSessionInTx(deps.tx, session.agentSessionId, { type: "approved" });
  } else {
    await endAgentSessionInTx(deps.tx, session.agentSessionId, "rejected", now);
  }
};

const decide = async (
  deps: OutsideDecisionDeps,
  scope: MemberScope,
  taskId: TaskId,
  decision: Decision,
  reason: string | null,
): Promise<UseCaseResult<{ readonly at: number }, DecisionError>> =>
  deps.db.$transaction(async (tx) => {
    const answerable = await lockAnswerableInTx(tx, scope, taskId);
    if (!answerable.ok) {
      return answerable;
    }
    const { task } = answerable;
    const organizationId = organizationIdSchema.parse(task.organizationId);
    const projectId = projectIdSchema.parse(task.projectId);
    const id = taskIdSchema.parse(task.id);
    const now = deps.clock.now();
    const at = new Date(now);
    // The item is answered by this member before the move, which would only dismiss it.
    await resolveNeedsYouItemsInTx(deps, tx, { taskId: id, reason: "awaiting_approval" }, { state: "answered", at, byMemberId: scope.memberId });
    const moved = await moveTaskInTx({ tx, notices: deps.notices, jobs: deps.jobs }, { ...task, id, organizationId, projectId }, { type: decision });
    if (!moved) {
      return { ok: false, error: "not-awaiting-approval", message: "The task isn't waiting for approval" };
    }
    const session = await tx.session.findFirst({ where: { taskId: id, state: "starting" }, orderBy: { startedAt: "desc" }, select: { id: true } });
    const txDeps = { ...deps, tx };
    if (decision === "approve") {
      await tx.task.update({ where: { id }, data: { approvedByMemberId: scope.memberId, approvedAt: at, lastPersonActionAt: at } });
      if (session !== null) {
        await appendServerEvent(tx, { organizationId, projectId, taskId: id, sessionId: sessionIdSchema.parse(session.id), at: now, event: { kind: "task.approved", memberId: scope.memberId } });
      }
      await deps.audit.recordInTx(tx, { organizationId, projectId, actor: { kind: "member", id: scope.memberId }, action: "task.approved", entity: "task", entityId: id });
      await tellSessionInTx(txDeps, organizationId, id, { kind: "approved", taskUrl: taskPageUrl(deps.publicUrl, id) });
      await releaseQueuedTaskInTx(deps, tx, { id, organizationId, projectId, title: task.title, ticketId: task.ticketId, boardId: task.boardId, prompt: task.prompt, leaseEpoch: task.leaseEpoch }, deps);
    } else {
      await tx.task.update({ where: { id }, data: { rejectedReason: reason, lastPersonActionAt: at } });
      if (session !== null) {
        // Never dispatched: nothing but this ends its session.
        await tx.session.update({ where: { id: session.id }, data: { state: "stopped", endedAt: at } });
        await appendServerEvent(tx, {
          organizationId,
          projectId,
          taskId: id,
          sessionId: sessionIdSchema.parse(session.id),
          at: now,
          event: { kind: "task.rejected", memberId: scope.memberId, reason: reason ?? "" },
        });
      }
      // The reason is the members' to read in the panel: the audit entry says only that there was one.
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId,
        actor: { kind: "member", id: scope.memberId },
        action: "task.rejected",
        entity: "task",
        entityId: id,
        data: { withReason: reason !== null && reason.trim() !== "" },
      });
      await tellSessionInTx(txDeps, organizationId, id, { kind: "rejected" });
    }
    return { ok: true, at: now };
  });

/** "Approve": the task is queued, then runs on one of the project's pools. */
export const approveOutsideTask: ApproveOutsideTask = async (deps, scope, input) => {
  const result = await decide(deps, scope, input.taskId, "approve", null);
  return result.ok ? { ok: true, approvedAt: result.at } : result;
};

/** "Reject", with an optional reason for the project's members: the task stops with `rejected`. */
export const rejectOutsideTask: RejectOutsideTask = async (deps, scope, input) => {
  const reason = input.reason === null ? null : input.reason.trim().slice(0, 2000) || null;
  const result = await decide(deps, scope, input.taskId, "reject", reason);
  return result.ok ? { ok: true, stoppedAt: result.at } : result;
};

/** "Outside tasks need approval", per project: an organization admin's switch only (ADR 0057). */
export const setOutsideApproval: SetOutsideApproval = (deps, scope, input) =>
  deps.db.$transaction(async (tx) => {
    const admin = requireOrganizationAdmin(scope, scope.organizationId);
    if (!admin.ok) {
      return { ok: false, error: "forbidden", message: "Only an organization admin changes who needs approval" };
    }
    const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId: scope.organizationId }, select: { id: true, outsideApproval: true } });
    if (project === null) {
      return { ok: false, error: "not-found", message: "No such project" };
    }
    if (project.outsideApproval !== input.on) {
      await tx.project.update({ where: { id: project.id }, data: { outsideApproval: input.on, outsideApprovalChangedByMemberId: scope.memberId } });
      await deps.audit.recordInTx(tx, {
        organizationId: scope.organizationId,
        projectId: input.projectId,
        actor: { kind: "member", id: scope.memberId },
        action: "project.outside-approval-changed",
        entity: "project",
        entityId: input.projectId,
        data: { on: input.on },
      });
      await deps.notices.emitInTx(tx, { organizationId: scope.organizationId, projectId: input.projectId, entity: "project", entityId: input.projectId });
    }
    return { ok: true, on: input.on };
  });
