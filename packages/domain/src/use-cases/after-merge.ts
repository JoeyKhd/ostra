import { mapTask } from "@ostra/db";
import { clientMessageIdSchema, organizationIdSchema, projectIdSchema, runnerIdSchema, runnerLimits, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, TaskId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { KEEP_WORKING_AFTER_CAP_PROMPT, KEEP_WORKING_PROMPT } from "../prompts/index.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import type { M3Deps, RecordTicketClosed, ReopenAfterMerge } from "./m3-signatures.ts";
import { sendMemberMessageInTx } from "./member-message.ts";
import type { MemberMessageDelivery, SendMemberMessageDeps, SendMemberMessageResult } from "./member-message.ts";
import { moveTaskInTx } from "./moves.ts";
import { createNeedsYouItemInTx, resolveNeedsYouItemsInTx } from "./needs-you-items.ts";
import { reopenTask } from "./reopen.ts";
export { freshBranchName, freshBranchesInTx } from "./fresh-branch.ts";
export type { FreshBranch } from "./fresh-branch.ts";
import { appendServerEvent } from "./server-events.ts";

// After the merge, and a ticket closed while its task runs (F-066, ADR 0052; ticket 24).
//
// A reopen of a task with a merged repo gives that repo a fresh branch from its base's current head:
// the old name with `-2`, then `-3`, by the repo's `generation`. Its merged PR stays in
// `TaskPullRequest`, its state goes back to `no_branch`, and its hidden ref is forgotten, so the
// restore starts it from the base. The first push opens its new PR, linked on the same ticket. Its
// other repos keep their branches and PRs (Q107: a PR closed unmerged keeps its branch too).
//
// A ticket moved to a `done` or `cancelled` category, not by ostra's own write, while its task runs
// interrupts the turn and asks whether to stop: "Stop the task" is milestone 1's stop, "Keep
// working" sends "Carry on where you stopped.".

/**
 * A reopen of a task whose PR merged (F-066): milestone 2's reopen, which gives each merged repo
 * its fresh branch. A task with no merged repo is refused.
 */
export const reopenAfterMergeWith = (
  deps: M3Deps,
  extras: Pick<SendMemberMessageDeps, "spendCap" | "timers">,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly text: string; readonly clientMessageId?: string },
): ReturnType<ReopenAfterMerge> =>
  deps.db.$transaction(
    async (tx) => {
      const merged = await tx.taskRepo.count({ where: { taskId: input.taskId, organizationId: scope.organizationId, state: "merged" } });
      if (merged === 0) {
        const exists = await tx.task.findFirst({ where: { id: input.taskId, organizationId: scope.organizationId }, select: { id: true } });
        return exists === null ? { ok: false, error: "not-found", message: "No such task" } : { ok: false, error: "not-merged", message: "No repo of the task has a merged PR" };
      }
      const reopened = await reopenTask(
        { tx, scope, jobs: deps.jobs, notices: deps.notices, audit: deps.audit, clock: deps.clock, spendCap: extras.spendCap, timers: extras.timers },
        { taskId: input.taskId, clientMessageId: clientMessageIdSchema.parse(input.clientMessageId ?? `reopen:${String(deps.clock.now())}`), text: input.text },
      );
      if (!reopened.ok) {
        return { ok: false, error: "not-found", message: reopened.message };
      }
      return { ok: true, freshBranches: reopened.freshBranches ?? [] };
    },
    { timeout: 20_000 },
  );

export const reopenAfterMerge: ReopenAfterMerge = (deps, scope, input) => reopenAfterMergeWith(deps, {}, scope, input);

// ---------- a ticket closed while its task runs ----------

export type TicketClosedDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "audit" | "clock"> & { readonly db: M3Deps["db"] };

/**
 * The ticket closed while the task ran (F-066, Q181): `ticket.closed`, the turn interrupted (an
 * `interrupt` command to the runner holding the lease), the task to needs you with a
 * `ticket_closed` item for its driver (or its project's members), which fans out. A task that isn't
 * running is refused, so a ticket closed after the merge, or closed twice, does nothing.
 */
export const recordTicketClosedWith = (deps: TicketClosedDeps, input: Parameters<RecordTicketClosed>[1]): ReturnType<RecordTicketClosed> =>
  deps.db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<readonly unknown[]>`SELECT 1 FROM "task" WHERE "id" = ${input.taskId} FOR UPDATE`;
      if (locked.length === 0) {
        return { ok: false, error: "not-found", message: "no such task" };
      }
      const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.taskId } }));
      if (task.state !== "running") {
        return { ok: false, error: "not-running", message: "the task isn't running" };
      }
      const organizationId = organizationIdSchema.parse(task.organizationId);
      const projectId = projectIdSchema.parse(task.projectId);
      const now = deps.clock.now();
      const [lease, session] = await Promise.all([
        tx.lease.findFirst({ where: { taskId: task.id, state: "active" }, select: { runnerId: true } }),
        tx.session.findFirst({ where: { taskId: task.id, state: { in: ["starting", "running", "waiting", "idle"] } }, orderBy: { startedAt: "desc" }, select: { id: true } }),
      ]);
      const sessionId = session === null ? null : sessionIdSchema.parse(session.id);
      if (sessionId !== null) {
        await appendServerEvent(tx, { organizationId, projectId, taskId: task.id, sessionId, at: now, event: { kind: "ticket.closed", status: input.status.slice(0, 200), category: input.category } });
      }
      // The turn stops here; its work is saved as after any turn (Q181).
      const interrupted = lease !== null && sessionId !== null;
      if (interrupted) {
        await deps.outbox.enqueueInTx(tx, organizationId, runnerIdSchema.parse(lease.runnerId), {
          kind: "interrupt",
          body: { sessionId },
          notAfter: now + runnerLimits.offerTimeoutMs,
          task: { taskId: task.id, projectId },
        });
      }
      await moveTaskInTx({ tx, notices: deps.notices, jobs: deps.jobs }, task, { type: "ticket_closed" });
      const word = input.category === "cancelled" ? "cancelled" : "done";
      await createNeedsYouItemInTx(deps, tx, {
        organizationId,
        projectId,
        taskId: task.id,
        reason: "ticket_closed",
        audience: task.driverMemberId === null ? "project_members" : "driver",
        summary: `The ticket moved to ${word} while the task ran, so the turn was stopped. Stop the task, or keep working.`,
      });
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId,
        actor: { kind: "system", id: null },
        action: "task.ticket-closed",
        entity: "task",
        entityId: task.id,
        data: { category: input.category, interrupted },
      });
      await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
      return { ok: true, interrupted };
    },
    { timeout: 20_000 },
  );

export const recordTicketClosed: RecordTicketClosed = (deps, input) => recordTicketClosedWith(deps, input);

/**
 * The tickets a tracker read moved to `done` or `cancelled`: each running code task on one of them
 * hears it. Another organization's tasks are never touched: the tickets are this organization's.
 */
export const recordTicketsClosed = async (
  deps: TicketClosedDeps,
  input: { readonly organizationId: OrganizationId; readonly ticketIds: readonly string[] },
): Promise<{ readonly interrupted: number; readonly raised: number }> => {
  if (input.ticketIds.length === 0) {
    return { interrupted: 0, raised: 0 };
  }
  const tickets = await deps.db.ticket.findMany({
    where: { id: { in: [...input.ticketIds] }, organizationId: input.organizationId },
    select: { id: true, statusName: true, statusCategory: true },
  });
  let interrupted = 0;
  let raised = 0;
  for (const ticket of tickets) {
    const category = ticket.statusCategory;
    if (category !== "done" && category !== "cancelled") {
      continue;
    }
    const tasks = await deps.db.task.findMany({ where: { organizationId: input.organizationId, ticketId: ticket.id, kind: "code", state: "running" }, select: { id: true } });
    for (const task of tasks) {
      const result = await recordTicketClosedWith(deps, { taskId: taskIdSchema.parse(task.id), status: ticket.statusName ?? category, category });
      if (result.ok) {
        raised += 1;
        interrupted += result.interrupted ? 1 : 0;
      }
    }
  }
  return { interrupted, raised };
};

// ---------- "Keep working" ----------

export type KeepWorkingResult = UseCaseResult<
  { readonly delivery: MemberMessageDelivery },
  "not-found" | "not-waiting" | Exclude<SendMemberMessageResult, { readonly ok: true }>["error"]
>;

/** "Keep working" (Q181): the item is dismissed, and "Carry on where you stopped." goes to the agent. */
export const keepWorking = (
  deps: M3Deps,
  extras: Pick<SendMemberMessageDeps, "spendCap" | "timers">,
  scope: MemberScope,
  input: { readonly taskId: TaskId },
): Promise<KeepWorkingResult> => {
  // A refused send throws to roll the dismissal back; this holds its answer.
  let refused: Exclude<KeepWorkingResult, { readonly ok: true }> | null = null;
  return deps.db.$transaction(
    async (tx): Promise<KeepWorkingResult> => {
      const task = await tx.task.findFirst({ where: { id: input.taskId, organizationId: scope.organizationId }, select: { id: true, projectId: true, state: true, needsYouReason: true, project: { select: { access: true } } } });
      if (task === null || !requireProjectAccess(scope, { id: projectIdSchema.parse(task.projectId), organizationId: scope.organizationId, access: task.project.access }, "read").ok) {
        return { ok: false, error: "not-found", message: "No such task" };
      }
      // Milestone 6 (F-101, ticket 35): a round cap's "Keep working" is the same answer, a person's
      // action that resets the round counters (the message records it), with the cap's own words.
      const reason = task.needsYouReason === "round_cap" ? "round_cap" : "ticket_closed";
      const item = await tx.needsYouItem.findFirst({ where: { taskId: task.id, reason, state: "open" }, select: { id: true } });
      if (task.state !== "needs_you" || task.needsYouReason !== reason || item === null) {
        return { ok: false, error: "not-waiting", message: "The task isn't waiting on its closed ticket or a round limit" };
      }
      // Dismissed before the message goes, which would otherwise answer it as the next turn's item.
      await resolveNeedsYouItemsInTx(deps, tx, { id: item.id }, { state: "dismissed", at: new Date(deps.clock.now()), byMemberId: scope.memberId });
      const sent = await sendMemberMessageInTx({ ...deps, ...extras }, tx, scope, {
        taskId: input.taskId,
        clientMessageId: clientMessageIdSchema.parse(`keep-working:${item.id}`),
        text: reason === "round_cap" ? KEEP_WORKING_AFTER_CAP_PROMPT : KEEP_WORKING_PROMPT,
        intent: "keep-working",
        sender: "driver",
      });
      if (!sent.ok) {
        refused = sent;
        throw new Error("keep working's message was refused");
      }
      return { ok: true, delivery: sent.delivery };
    },
    { timeout: 20_000 },
  ).catch((error: unknown) => {
    if (refused !== null) {
      return refused;
    }
    throw error;
  });
};
