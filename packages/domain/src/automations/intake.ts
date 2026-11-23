import type { Tx } from "@ostra/db";
import { agentProfileIdSchema, automationIdSchema, boardIdSchema, projectIdSchema, ticketIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { AutomationId, OrganizationId, ProjectId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { AutomationSkipReason } from "../lifecycles/m6.ts";
import { attachedBoardWhere, isBoardAttached } from "../lifecycles/m11-trackers.ts";
import { startTask } from "../starts/start-task-body.ts";
import type { StartPorts } from "../starts/start-task-body.ts";
import { startRuleFor } from "../starts/start-task.ts";
import { budgetAudienceInTx } from "../use-cases/budget-notices.ts";
import type { DryRunAutomation, DryRunRow, M6TxDeps, MatchIntakeRules, StartTaskOptions } from "../use-cases/m6-signatures.ts";
import { activeRulesWhere } from "./intake-enqueue.ts";
import { matchesFilter, parseIntakeFilter } from "./intake-filter.ts";
import type { FilterContext, FilterTicket } from "./intake-filter.ts";

// Intake rules (F-011, ADR 0056, Q210; milestone 6's ticket 11). Milestone 2's ticket ingest
// (webhook or poll) upserts a ticket and, in the same transaction, enqueues `intake.match` for it
// when its project has an enabled rule without a schedule. The job evaluates each such rule against
// the cached ticket and, for a match, inserts the `ticket_match` run with `ON CONFLICT DO NOTHING`
// (Prisma's `skipDuplicates`): only an inserted row starts a task, so a ticket starts at most one
// task per rule, ever, however many webhooks, polls and workers race. The rule's hourly count is
// taken under a lock on the rule; the start over `OSTRA_INTAKE_STARTS_PER_HOUR` pauses it.

const HOUR_MS = 3_600_000;

/** `OSTRA_INTAKE_STARTS_PER_HOUR`'s default. */
export const INTAKE_STARTS_PER_HOUR_DEFAULT = 20;

/** The cache's labels column (external data: storage). */
const labelsSchema = z.array(z.string()).catch([]);

/** What a filter reads of a cached ticket. The cache has no column for the tracker's own project yet. */
export const filterTicketOf = (row: {
  readonly boardId: string;
  readonly labels: unknown;
  readonly statusId: string | null;
  readonly statusCategory: FilterTicket["statusCategory"];
  readonly assigneeId: string | null;
  readonly trackerProjectId: string | null;
  readonly trackerProjectName: string | null;
  readonly open: boolean;
  readonly removedAt: Date | null;
}): FilterTicket => ({
  boardId: boardIdSchema.parse(row.boardId),
  labels: labelsSchema.parse(row.labels),
  statusId: row.statusId,
  statusCategory: row.statusCategory,
  assigneeId: row.assigneeId,
  trackerProjectId: row.trackerProjectId,
  trackerProjectName: row.trackerProjectName,
  open: row.open && row.removedAt === null,
});

/** The rule's limits and the start's options. */
export type IntakeOptions = StartTaskOptions & {
  /** `OSTRA_INTAKE_STARTS_PER_HOUR`. */
  readonly intakeStartsPerHour?: number;
};

/**
 * Pauses a rule for its hourly limit (or a member), in the caller's transaction, with its audit
 * entry and, for the limit, an `automation_paused` notification for each of the project's admins.
 * A notification and not a needs-you item: an item belongs to a task, and a paused rule has none.
 */
export const pauseAutomationInTx = async (
  deps: Pick<M6TxDeps, "tx" | "audit" | "notices" | "clock">,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly automationId: AutomationId; readonly reason: "member" | "hourly_limit"; readonly memberId: string | null },
): Promise<{ readonly paused: boolean; readonly notified: number }> => {
  const { tx } = deps;
  const at = new Date(deps.clock.now());
  const paused = await tx.automation.updateMany({
    where: { id: input.automationId, organizationId: input.organizationId, pausedAt: null, deletedAt: null },
    data: { pausedAt: at, pausedReason: input.reason, ...(input.memberId === null ? {} : { updatedByMemberId: input.memberId }) },
  });
  if (paused.count === 0) {
    return { paused: false, notified: 0 };
  }
  await deps.audit.recordInTx(tx, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    actor: input.memberId === null ? { kind: "system", id: null } : { kind: "member", id: input.memberId },
    action: "automation.paused",
    entity: "automation",
    entityId: input.automationId,
    data: { reason: input.reason },
  });
  let notified = 0;
  if (input.reason === "hourly_limit") {
    for (const memberId of await budgetAudienceInTx(tx, input.organizationId, input.projectId)) {
      await tx.notification.create({ data: { organizationId: input.organizationId, memberId, projectId: input.projectId, kind: "automation_paused", state: "open" } });
      await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: null, entity: "member", entityId: memberId });
      notified += 1;
    }
  }
  await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: input.projectId, entity: "project", entityId: input.projectId });
  return { paused: true, notified };
};

/** The rule's starts in the hour before `now`, besides the run being decided. */
const startsInLastHourInTx = (tx: Tx, automationId: string, now: number, besides: string): Promise<number> =>
  tx.automationRun.count({ where: { automationId, state: "started", taskId: { not: null }, id: { not: besides }, createdAt: { gte: new Date(now - HOUR_MS) } } });

export const matchIntakeRules = async (deps: Parameters<MatchIntakeRules>[0] & IntakeOptions, input: Parameters<MatchIntakeRules>[1]): ReturnType<MatchIntakeRules> => {
  const { tx } = deps;
  const started: AutomationId[] = [];
  const skipped: { readonly automationId: AutomationId; readonly reason: AutomationSkipReason }[] = [];
  const ticket = await tx.ticket.findFirst({
    where: { id: input.ticketId, organizationId: input.organizationId },
    include: { connection: { select: { appUserId: true } }, board: { select: { detachedAt: true, connection: { select: { state: true } } } } },
  });
  if (ticket?.removedAt !== null) {
    return { started, skipped };
  }
  // A paused or detached board starts nothing (ADR 0071); its ticket's next change after a resume matches again.
  if (!isBoardAttached(ticket.board, ticket.board.connection)) {
    return { started, skipped };
  }
  const rules = await tx.automation.findMany({ where: activeRulesWhere(input.organizationId, [ticket.projectId]), orderBy: { createdAt: "asc" } });
  const context: FilterContext = { appUserId: ticket.connection.appUserId };
  const projectId = projectIdSchema.parse(ticket.projectId);
  const limit = deps.intakeStartsPerHour ?? INTAKE_STARTS_PER_HOUR_DEFAULT;
  for (const rule of rules) {
    const filter = parseIntakeFilter(rule.filter);
    if (!filter.ok || !matchesFilter(filterTicketOf(ticket), filter.filter, context)) {
      continue;
    }
    const automationId = automationIdSchema.parse(rule.id);
    const now = deps.clock.now();
    // Once per ticket per rule, ever: the partial unique index decides, and only an inserted row starts.
    const [run] = await tx.automationRun.createManyAndReturn({
      data: [{ organizationId: input.organizationId, projectId, automationId, kind: "ticket_match", ticketId: ticket.id, state: "started", createdAt: new Date(now) }],
      skipDuplicates: true,
      select: { id: true },
    });
    if (run === undefined) {
      continue;
    }
    // The hourly limit, under the rule's lock: two matches of one rule at once count one after the other.
    const locked = await tx.$queryRaw<readonly { readonly pausedAt: Date | null; readonly deletedAt: Date | null }[]>`
      SELECT "pausedAt", "deletedAt" FROM "automation" WHERE "id" = ${rule.id} FOR UPDATE`;
    const state = locked[0];
    if (state?.deletedAt !== null || state.pausedAt !== null) {
      await tx.automationRun.update({ where: { id: run.id }, data: { state: "skipped", skipReason: "paused" } });
      skipped.push({ automationId, reason: "paused" });
      continue;
    }
    if ((await startsInLastHourInTx(tx, rule.id, now, run.id)) >= limit) {
      await tx.automationRun.update({ where: { id: run.id }, data: { state: "skipped", skipReason: "hourly_limit" } });
      await pauseAutomationInTx(deps, { organizationId: input.organizationId, projectId, automationId, reason: "hourly_limit", memberId: null });
      skipped.push({ automationId, reason: "hourly_limit" });
      continue;
    }
    const result = await startTask(deps, {
      organizationId: input.organizationId,
      projectId,
      origin: { kind: "intake-rule", automationId, requireApproval: rule.requireApproval },
      kind: rule.taskKind,
      ticketId: ticketIdSchema.parse(ticket.id),
      prompt: null,
      title: null,
      agentProfileId: rule.agentProfileId === null ? null : agentProfileIdSchema.parse(rule.agentProfileId),
      poolLabels: rule.poolLabels,
    });
    if (result.ok) {
      await tx.automationRun.update({ where: { id: run.id }, data: { taskId: result.taskId } });
      started.push(automationId);
    } else if (result.error === "ticket-has-active-task") {
      await tx.automationRun.update({ where: { id: run.id }, data: { state: "skipped", skipReason: "has_task" } });
      skipped.push({ automationId, reason: "has_task" });
    } else {
      // The project's setup refused it (no repo, no profile with a model): no match is kept, so the
      // ticket's next change tries again once the setup is fixed. A model no provider on the
      // project's list serves isn't a refusal: the task is made and waits queued with the reason (F-135).
      await tx.automationRun.delete({ where: { id: run.id } });
    }
  }
  return { started, skipped };
};

// ---------- the tickets a rule's dry run and a filter schedule read ----------

/**
 * The project's open tickets on its attached boards, each with its own connection's app user (what
 * the filter's "ostra" assignee means on that board): what a rule's dry run and a filter
 * schedule's occurrence read. A paused board's tickets start nothing (ADR 0071), nor a detached one's.
 */
export const openAttachedTicketsInTx = (
  tx: Pick<Tx, "ticket">,
  input: { readonly organizationId: string; readonly projectId: string; readonly order: "asc" | "desc" },
) =>
  tx.ticket.findMany({
    where: { organizationId: input.organizationId, projectId: input.projectId, open: true, removedAt: null, board: attachedBoardWhere },
    include: { connection: { select: { appUserId: true } } },
    orderBy: [{ trackerUpdatedAt: input.order }, { id: "asc" }],
  });

// ---------- the dry run (F-011) ----------

/** The most tickets a dry run lists. */
export const DRY_RUN_MAX = 500;

/**
 * What a rule would do over the board's cached open tickets: start, or skip because the ticket has
 * an active code task or the rule matched it before. Reads only; starts nothing.
 */
export const dryRunAutomation = async (deps: Pick<StartPorts, "db">, scope: Parameters<DryRunAutomation>[1], input: Parameters<DryRunAutomation>[2]): ReturnType<DryRunAutomation> => {
  const project = await deps.db.project.findFirst({ where: { id: input.projectId, organizationId: scope.organizationId }, select: { id: true, access: true, outsideApproval: true } });
  if (project === null) {
    return { ok: false, error: "not-found", message: "No such project" };
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId: scope.organizationId, access: project.access }, "read");
  if (!access.ok) {
    return access.code === "not-found" ? { ok: false, error: "not-found", message: "No such project" } : { ok: false, error: "forbidden", message: "You may not see this project's automations" };
  }
  let requireApproval = false;
  if (input.automationId !== null) {
    const automation = await deps.db.automation.findFirst({ where: { id: input.automationId, projectId: project.id, organizationId: scope.organizationId, deletedAt: null }, select: { requireApproval: true } });
    if (automation === null) {
      return { ok: false, error: "not-found", message: "No such automation" };
    }
    requireApproval = automation.requireApproval;
  }
  const tickets = await openAttachedTicketsInTx(deps.db, { organizationId: scope.organizationId, projectId: project.id, order: "desc" });
  const matching = tickets.filter((ticket) => matchesFilter(filterTicketOf(ticket), input.filter, { appUserId: ticket.connection.appUserId }));
  const ids = matching.map((ticket) => ticket.id);
  const [active, matched] = await Promise.all([
    deps.db.task.findMany({ where: { ticketId: { in: ids }, kind: "code", state: { notIn: ["stopped", "merged", "done"] } }, select: { ticketId: true } }),
    input.automationId === null
      ? Promise.resolve([])
      : deps.db.automationRun.findMany({ where: { automationId: input.automationId, kind: "ticket_match", ticketId: { in: ids } }, select: { ticketId: true } }),
  ]);
  const hasTask = new Set(active.map((row) => row.ticketId));
  const before = new Set(matched.map((row) => row.ticketId));
  const rule = startRuleFor(
    input.automationId === null ? { kind: "intake-rule", automationId: automationIdSchema.parse("dry-run"), requireApproval } : { kind: "intake-rule", automationId: input.automationId, requireApproval },
    { outsideApproval: project.outsideApproval },
  );
  const rows: DryRunRow[] = matching.slice(0, DRY_RUN_MAX).map((ticket) => ({
    ticketId: ticketIdSchema.parse(ticket.id),
    key: ticketKeySchema.parse(ticket.key),
    outcome: hasTask.has(ticket.id)
      ? { kind: "would-skip", reason: "has-task" }
      : before.has(ticket.id)
        ? { kind: "would-skip", reason: "matched-before" }
        : { kind: "would-start", rule },
  }));
  return { ok: true, rows, total: matching.length };
};

