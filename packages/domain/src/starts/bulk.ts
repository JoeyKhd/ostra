import type { Tx } from "@ostra/db";
import { agentProfileIdSchema, automationIdSchema, bulkStartIdSchema, bulkStartItemIdSchema, memberIdSchema, organizationIdSchema, projectIdSchema, taskIdSchema, ticketIdSchema } from "@ostra/protocol";
import type { BulkStartId, MemberId, OrganizationId, ProjectId } from "@ostra/protocol";

import { requireProjectAccess, scopeForMembership } from "../access.ts";
import type { MemberScope, ProjectRole } from "../access.ts";
import type { M6Deps, StartBulkItem, StartMany, StartTaskOptions } from "../use-cases/m6-signatures.ts";
import { startTask } from "./start-task-body.ts";
import type { StartPorts } from "./start-task-body.ts";

// Starting many (F-107, F-010, ADR 0056, Q212; milestone 6's ticket 11): the Inbox's bulk start and
// a dry run's "Start all". `startMany` writes the `BulkStart` and one item per ticket in one
// transaction, idempotent by the member's request key, refuses more than `OSTRA_BULK_START_MAX`,
// and enqueues `bulk.start-item` per item. Each item runs the one start in its own transaction and
// records its outcome. Admission, a project's cap on a pool and the budget act on each started task
// at its dispatch, as on any other: a task that can't run yet is queued with its reason, never refused.

/** `OSTRA_BULK_START_MAX`'s default. */
export const BULK_START_MAX_DEFAULT = 50;

/** A request key's bounds: the client's own, opaque. */
const REQUEST_KEY_MAX = 200;

export type BulkOptions = StartTaskOptions & {
  /** `OSTRA_BULK_START_MAX`. */
  readonly bulkStartMax?: number;
};

/** A member's scope as a request would make it, or `null` when they're no longer an active member. */
export const loadMemberScopeInTx = async (tx: Tx, organizationId: OrganizationId, memberId: MemberId): Promise<MemberScope | null> => {
  const member = await tx.member.findFirst({ where: { id: memberId, organizationId }, select: { role: true, state: true } });
  if (member === null) {
    return null;
  }
  const listed = await tx.projectMember.findMany({ where: { organizationId, memberId }, select: { projectId: true, role: true } });
  const roles = new Map<ProjectId, ProjectRole>(listed.map((row) => [projectIdSchema.parse(row.projectId), row.role]));
  // better-auth keeps a member's roles as one comma-separated column; an admin among them makes an admin.
  const role = member.role.split(",").some((part) => part.trim() === "admin") ? "admin" : "member";
  return scopeForMembership({ organizationId, memberId, role, state: member.state }, roles);
};

export const startMany = async (deps: StartPorts & BulkOptions, scope: Parameters<StartMany>[1], input: Parameters<StartMany>[2]): ReturnType<StartMany> => {
  const max = deps.bulkStartMax ?? BULK_START_MAX_DEFAULT;
  const ticketIds = [...new Set(input.ticketIds)];
  if (ticketIds.length > max) {
    return { ok: false, error: "too-many", message: `At most ${String(max)} tickets start at once` };
  }
  if (ticketIds.length === 0 || input.requestKey.trim() === "" || input.requestKey.length > REQUEST_KEY_MAX) {
    return { ok: false, error: "invalid-input", message: "A bulk start names at least one ticket and its request's key" };
  }
  const organizationId = scope.organizationId;
  return deps.db.$transaction(async (tx): ReturnType<StartMany> => {
    const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId }, select: { id: true, access: true } });
    if (project === null) {
      return { ok: false, error: "not-found", message: "No such project" };
    }
    const projectId = projectIdSchema.parse(project.id);
    const access = requireProjectAccess(scope, { id: projectId, organizationId, access: project.access }, "read");
    if (!access.ok) {
      return access.code === "not-found" ? { ok: false, error: "not-found", message: "No such project" } : { ok: false, error: "forbidden", message: "You may not start tasks in this project" };
    }
    // The same request again (a retry, a double click) answers the first one: nothing starts twice.
    const existing = await tx.bulkStart.findUnique({ where: { memberId_requestKey: { memberId: scope.memberId, requestKey: input.requestKey } }, select: { id: true } });
    if (existing !== null) {
      return { ok: true, bulkStartId: bulkStartIdSchema.parse(existing.id) };
    }
    const tickets = await tx.ticket.findMany({ where: { id: { in: ticketIds }, projectId, organizationId }, select: { id: true } });
    if (tickets.length !== ticketIds.length) {
      return { ok: false, error: "not-found", message: "A ticket isn't on this project's boards" };
    }
    if (input.automationId !== null) {
      const automation = await tx.automation.findFirst({ where: { id: input.automationId, projectId, organizationId, deletedAt: null }, select: { id: true } });
      if (automation === null) {
        return { ok: false, error: "not-found", message: "No such automation" };
      }
    }
    const [made] = await tx.bulkStart.createManyAndReturn({
      data: [
        {
          organizationId,
          projectId,
          memberId: scope.memberId,
          source: input.source,
          automationId: input.automationId,
          requestKey: input.requestKey,
          taskKind: input.taskKind,
          agentProfileId: input.agentProfileId,
          requested: ticketIds.length,
          createdAt: new Date(deps.clock.now()),
        },
      ],
      // Two copies of one request at once: the second finds the first's row once it commits.
      skipDuplicates: true,
      select: { id: true },
    });
    if (made === undefined) {
      const first = await tx.bulkStart.findUniqueOrThrow({ where: { memberId_requestKey: { memberId: scope.memberId, requestKey: input.requestKey } }, select: { id: true } });
      return { ok: true, bulkStartId: bulkStartIdSchema.parse(first.id) };
    }
    const bulkStartId = bulkStartIdSchema.parse(made.id);
    const items = await tx.bulkStartItem.createManyAndReturn({
      data: ticketIds.map((ticketId) => ({ organizationId, projectId, bulkStartId, ticketId })),
      select: { id: true },
    });
    if (input.automationId !== null) {
      // A dry run's "Start all": the rule's run that started them, for its history.
      await tx.automationRun.create({ data: { organizationId, projectId, automationId: input.automationId, kind: "start_all", state: "started", bulkStartId, createdAt: new Date(deps.clock.now()) } });
    }
    for (const item of items) {
      await deps.jobs.enqueueInTx(tx, "bulk.start-item", { organizationId, bulkStartItemId: bulkStartItemIdSchema.parse(item.id) });
    }
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "bulk-start.created",
      entity: "bulk-start",
      entityId: bulkStartId,
      data: { source: input.source, tickets: ticketIds.length, kind: input.taskKind },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "project", entityId: projectId });
    return { ok: true, bulkStartId };
  });
};

/** An item's outcome, as the panel shows it and the row stores it: a code, never content. */
type ItemOutcome = Awaited<ReturnType<StartBulkItem>>;

export const startBulkItem = async (deps: StartPorts & BulkOptions, input: Parameters<StartBulkItem>[1]): ReturnType<StartBulkItem> =>
  deps.db.$transaction(async (tx): Promise<ItemOutcome> => {
    // The item's lock: a replayed job waits here, then finds it decided.
    const locked = await tx.$queryRaw<readonly unknown[]>`
      SELECT 1 FROM "bulk_start_item" WHERE "id" = ${input.bulkStartItemId} AND "organizationId" = ${input.organizationId} FOR UPDATE`;
    const item = locked.length === 0 ? null : await tx.bulkStartItem.findUnique({ where: { id: input.bulkStartItemId }, include: { bulkStart: true } });
    if (item === null) {
      return { state: "failed", taskId: null, reason: "not-found" };
    }
    if (item.state !== "pending") {
      return { state: item.state, taskId: item.taskId === null ? null : taskIdSchema.parse(item.taskId), reason: item.reason };
    }
    const decide = async (outcome: ItemOutcome): Promise<ItemOutcome> => {
      await tx.bulkStartItem.update({ where: { id: item.id }, data: { state: outcome.state, reason: outcome.reason, taskId: outcome.taskId } });
      await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: projectIdSchema.parse(item.projectId), entity: "project", entityId: projectIdSchema.parse(item.projectId) });
      return outcome;
    };
    const bulk = item.bulkStart;
    const memberId = memberIdSchema.parse(bulk.memberId);
    const scope = await loadMemberScopeInTx(tx, input.organizationId, memberId);
    const project = await tx.project.findUniqueOrThrow({ where: { id: item.projectId }, select: { id: true, access: true } });
    if (scope === null || !requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId: input.organizationId, access: project.access }, "read").ok) {
      return decide({ state: "skipped", taskId: null, reason: "no-access" });
    }
    const automation =
      bulk.automationId === null
        ? null
        : await tx.automation.findFirst({ where: { id: bulk.automationId, deletedAt: null }, select: { id: true, poolLabels: true, taskKind: true, agentProfileId: true } });
    if (bulk.automationId !== null) {
      if (automation === null) {
        return decide({ state: "skipped", taskId: null, reason: "automation-deleted" });
      }
      // The rule's one match of this ticket, ever: a ticket it matched before isn't started again.
      const [run] = await tx.automationRun.createManyAndReturn({
        data: [{ organizationId: input.organizationId, projectId: item.projectId, automationId: automation.id, kind: "ticket_match", ticketId: item.ticketId, state: "started", bulkStartId: bulk.id, createdAt: new Date(deps.clock.now()) }],
        skipDuplicates: true,
        select: { id: true },
      });
      if (run === undefined) {
        return decide({ state: "skipped", taskId: null, reason: "matched-before" });
      }
    }
    const result = await startTask(
      { tx, jobs: deps.jobs, notices: deps.notices, audit: deps.audit, clock: deps.clock, scope, ...startOptionsOf(deps) },
      {
        organizationId: organizationIdSchema.parse(input.organizationId),
        projectId: projectIdSchema.parse(item.projectId),
        origin: {
          kind: "bulk-item",
          memberId,
          bulkStartId: bulkStartIdSchema.parse(bulk.id),
          bulkStartItemId: bulkStartItemIdSchema.parse(item.id),
          automationId: automation === null ? null : automationIdSchema.parse(automation.id),
        },
        // A dry run's "Start all" starts what the rule would: its kind and profile, unless the member chose one.
        kind: automation?.taskKind ?? bulk.taskKind,
        ticketId: ticketIdSchema.parse(item.ticketId),
        prompt: null,
        title: null,
        agentProfileId: profileOf(bulk.agentProfileId ?? automation?.agentProfileId ?? null),
        poolLabels: automation?.poolLabels ?? [],
      },
    );
    if (result.ok) {
      if (automation !== null) {
        await tx.automationRun.updateMany({ where: { automationId: automation.id, kind: "ticket_match", ticketId: item.ticketId }, data: { taskId: result.taskId } });
      }
      return decide({ state: "started", taskId: result.taskId, reason: null });
    }
    if (result.error === "ticket-has-active-task") {
      if (automation !== null) {
        await tx.automationRun.updateMany({ where: { automationId: automation.id, kind: "ticket_match", ticketId: item.ticketId }, data: { state: "skipped", skipReason: "has_task" } });
      }
      return decide({ state: "skipped", taskId: null, reason: "has-task" });
    }
    if (automation !== null) {
      // Not started for the project's setup or the ticket's place: no match is kept, so it can start later.
      await tx.automationRun.deleteMany({ where: { automationId: automation.id, kind: "ticket_match", ticketId: item.ticketId, taskId: null } });
    }
    switch (result.error) {
      case "not-found":
        return decide({ state: "skipped", taskId: null, reason: "not-on-a-board" });
      case "forbidden":
        return decide({ state: "skipped", taskId: null, reason: "no-access" });
      case "invalid-input":
      case "no-default-profile":
      case "no-agent-profile":
      case "no-repo":
      case "runner-not-yours":
      case "provider-not-allowed-on-personal-runners":
      case "no-provider-for-model":
      case "repo-unsupported":
        return decide({ state: "failed", taskId: null, reason: result.error });
      default:
        return result satisfies never;
    }
  });

const profileOf = (id: string | null) => (id === null ? null : agentProfileIdSchema.parse(id));

/** The start's options a bulk start passes on: the panel's address for the ticket's link. */
const startOptionsOf = (deps: BulkOptions): StartTaskOptions => (deps.publicUrl === undefined ? {} : { publicUrl: deps.publicUrl });

/** A bulk start's items, as its outcome view reads them (ticket 25 streams them). */
export const bulkStartOutcomes = async (
  deps: Pick<M6Deps, "db">,
  input: { readonly organizationId: OrganizationId; readonly bulkStartId: BulkStartId },
): Promise<readonly { readonly ticketId: string; readonly state: string; readonly reason: string | null; readonly taskId: string | null }[]> =>
  deps.db.bulkStartItem.findMany({
    where: { organizationId: input.organizationId, bulkStartId: input.bulkStartId },
    orderBy: { id: "asc" },
    select: { ticketId: true, state: true, reason: true, taskId: true },
  });
