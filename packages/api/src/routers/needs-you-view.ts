import { agentDisplayName, dispatchWaitFromDb } from "@ostra/domain";
import type { Db, DbEnum } from "@ostra/db";
import {
  approvalIdSchema,
  approvalOptionSchema,
  approvalRuleRefSchema,
  approvalSubjectSchema,
  memberIdSchema,
  needsYouItemIdSchema,
  planEntrySchema,
  projectIdSchema,
  questionFieldSchema,
  questionIdSchema,
  taskIdSchema,
  turnIdSchema,
} from "@ostra/protocol";
import type { ApprovalSubject, MemberId, NeedsYouItemId, OrganizationId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import { loadDoingByTask } from "./task-doing.ts";
import type { Doing } from "./task-doing.ts";
import { taskRulePreviewOf } from "./task-m3.ts";

// F-036, F-062, F-026, F-063, F-024 (ticket 36): a needs-you item as the panel shows it, on Home, on
// the Needs you page and in the notification list: its reason and the one line about it, its task
// and project, and what an inline answer needs (an approval's options and pattern, a plan's entries,
// a question's fields). Everything is read in bulk for a page of items, from rows in the caller's
// organization; a request's subject, a plan and a question are data for members who can open the
// task, and never logged.

const QUESTION_MAX = 200;
const TITLE_MAX = 200;

const firstLine = (text: string): string => (text.split(/\r?\n/, 1)[0] ?? "").trim().slice(0, QUESTION_MAX);

/** An item row with its task, as the readers load it. */
export type ItemRow = {
  readonly id: string | null;
  readonly reason: DbEnum.NeedsYouReason;
  readonly state: "open" | "answered" | "dismissed";
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolvedByMemberId: string | null;
  readonly approvalId: string | null;
  readonly questionId: string | null;
  readonly planTurnId: string | null;
  readonly summary: string | null;
  readonly task: {
    readonly id: string;
    readonly projectId: string;
    readonly ticketKey: string | null;
    readonly title: string;
    readonly driverMemberId: string | null;
    readonly agentProfileId: string | null;
    readonly updatedAt: Date;
    readonly repos: readonly { readonly prNumber: number | null }[];
    /** Why a queued task waits (`Task.dispatchWait`): a no-key item reads its profile's provider from it. */
    readonly dispatchWait?: unknown;
  };
};

/** The one line about the moment (Home's reason table), as data. */
export type ReasonDetail =
  | { readonly reason: "question"; readonly question: string | null }
  | { readonly reason: "approval"; readonly command: string | null; readonly subject: ApprovalSubject | null; readonly ruleName: string | null }
  | { readonly reason: "plan"; readonly steps: number | null }
  | { readonly reason: "draft_ready"; readonly prNumber: number | null }
  | { readonly reason: "setup_failed"; readonly exitCode: number | null }
  | { readonly reason: "stalled"; readonly minutes: number }
  | { readonly reason: "ticket_closed"; readonly status: string | null }
  /** F-135 (ticket 50): the model no provider on the project's list serves, as its text ("No key for {model}"). */
  | {
      readonly reason: "no_provider_for_model";
      readonly modelName: string | null;
      /** ADR 0065 amended 2026-11-20: the profile's own provider, which the project doesn't allow or which no longer lists the model. */
      readonly provider: { readonly name: string; readonly reason: "not-allowed" | "not-listed" } | null;
    }
  | { readonly reason: Exclude<DbEnum.NeedsYouReason, "question" | "approval" | "plan" | "draft_ready" | "setup_failed" | "stalled" | "ticket_closed" | "no_provider_for_model"> };

/** What an inline answer needs, and whether this member can give it. */
export type AnswerView =
  | {
      readonly kind: "approval";
      readonly approvalId: ReturnType<typeof approvalIdSchema.parse>;
      readonly state: "open" | "answered" | "answered_by_rule" | "closed";
      readonly options: readonly z.infer<typeof approvalOptionSchema>[];
      readonly subject: ApprovalSubject | null;
      /** The rule "Approve for this task" would add; `null` when the subject gives none. */
      readonly forThisTask: { readonly tool: string; readonly pattern: string } | null;
      readonly rule: z.infer<typeof approvalRuleRefSchema> | null;
      /** The agent that asked, by its display name. */
      readonly agentName: string;
      /** Any member who can open the project answers an approval. */
      readonly canAnswer: true;
    }
  | {
      readonly kind: "plan";
      readonly entries: readonly z.infer<typeof planEntrySchema>[];
      readonly message: string;
      readonly canAnswer: boolean;
      readonly driver: { readonly memberId: MemberId; readonly name: string } | null;
    }
  | {
      readonly kind: "question";
      readonly questionId: ReturnType<typeof questionIdSchema.parse>;
      readonly message: string;
      readonly fields: readonly z.infer<typeof questionFieldSchema>[];
      readonly canAnswer: boolean;
      readonly driver: { readonly memberId: MemberId; readonly name: string } | null;
    };

/** How an item closed, for the Done tab and the receipt. */
export type Outcome = {
  readonly kind: "approved-once" | "approved-task" | "denied" | "approved-by-rule" | "plan-approved" | "plan-revised" | "answered" | "expired" | "cancelled" | "closed";
  readonly by: { readonly memberId: MemberId; readonly name: string } | null;
};

export type NeedsYouView = {
  /** `null` for a task in `needs_you` with no item row (a task from before items). */
  readonly itemId: NeedsYouItemId | null;
  readonly reason: DbEnum.NeedsYouReason;
  readonly state: "open" | "answered" | "dismissed";
  readonly taskId: TaskId;
  readonly key: string;
  readonly title: string;
  readonly project: { readonly id: ReturnType<typeof projectIdSchema.parse>; readonly name: string };
  /** Epoch ms: when the moment came. */
  readonly since: number;
  readonly detail: ReasonDetail;
  readonly driver: { readonly memberId: MemberId; readonly name: string } | null;
  readonly answer: AnswerView | null;
  readonly outcome: Outcome | null;
};

const requestedPayload = z.looseObject({ approvalId: z.string(), rule: approvalRuleRefSchema.nullable().optional(), subject: approvalSubjectSchema.optional() });
const askedPayload = z.looseObject({ questionId: z.string(), message: z.string(), fields: z.array(questionFieldSchema) });
const proposedPayload = z.looseObject({ turnId: turnIdSchema, entries: z.array(planEntrySchema), message: z.string() });
const planAnsweredPayload = z.looseObject({ decision: z.enum(["approve", "revise"]) });
const setupFinishedPayload = z.looseObject({ exitCode: z.number().int().nullable() });
const ticketClosedPayload = z.looseObject({ status: z.string() });

const keyOf = (task: ItemRow["task"]): string => task.ticketKey ?? task.id.replaceAll("-", "").slice(-8);

type Loaded = {
  readonly requested: Map<string, z.infer<typeof requestedPayload>>;
  readonly asked: Map<string, z.infer<typeof askedPayload>>;
  /** The newest question of each task, for an item that names none (a task from before items). */
  readonly askedByTask: Map<string, z.infer<typeof askedPayload>>;
  readonly proposed: Map<string, z.infer<typeof proposedPayload> & { readonly taskId: string }>;
  readonly lastPlanAnswer: Map<string, "approve" | "revise">;
  readonly setupExit: Map<string, number | null>;
  readonly ticketStatus: Map<string, string>;
  readonly lastEventAt: Map<string, number>;
};

/** The events a page of items reads, in four queries by task and kind (never by a payload scan). */
const loadEvents = async (db: Db, taskIds: readonly string[], kinds: readonly string[]) => {
  if (taskIds.length === 0 || kinds.length === 0) {
    return [];
  }
  const rows: unknown = await db.$queryRaw`
    SELECT "taskId", "kind", "payload" FROM "event"
    WHERE "taskId" = ANY(${[...taskIds]}::text[]) AND "kind" = ANY(${[...kinds]}::text[])
    ORDER BY "seq" DESC LIMIT 5000`;
  return z.array(z.object({ taskId: z.string(), kind: z.string(), payload: z.unknown() })).parse(rows);
};

export const loadNeedsYouViews = async (
  deps: { readonly db: Db },
  scope: { readonly organizationId: OrganizationId; readonly memberId: MemberId },
  items: readonly ItemRow[],
  now: number,
): Promise<readonly NeedsYouView[]> => {
  const { db } = deps;
  const { organizationId } = scope;
  if (items.length === 0) {
    return [];
  }
  const taskIds = [...new Set(items.map((item) => item.task.id))];
  const projectIds = [...new Set(items.map((item) => item.task.projectId))];
  const approvalIds = items.flatMap((item) => (item.approvalId === null ? [] : [item.approvalId]));
  const memberIds = new Set<string>();
  for (const item of items) {
    if (item.task.driverMemberId !== null) memberIds.add(item.task.driverMemberId);
    if (item.resolvedByMemberId !== null) memberIds.add(item.resolvedByMemberId);
  }
  const profileIds = [...new Set(items.flatMap((item) => (item.task.agentProfileId === null ? [] : [item.task.agentProfileId])))];

  const needs = (reason: string) => items.some((item) => item.reason === reason);
  const kinds = [
    ...(needs("approval") ? ["approval.requested"] : []),
    ...(needs("question") ? ["question.asked"] : []),
    ...(needs("plan") ? ["plan.proposed", "plan.answered"] : []),
    ...(needs("setup_failed") ? ["environment.setup_finished"] : []),
    ...(needs("ticket_closed") ? ["ticket.closed"] : []),
  ];
  const stalledTaskIds = items.filter((item) => item.reason === "stalled").map((item) => item.task.id);

  const [projects, members, profiles, approvals, events, lastEvents] = await Promise.all([
    db.project.findMany({ where: { organizationId, id: { in: projectIds } }, select: { id: true, name: true } }),
    db.member.findMany({ where: { organizationId, id: { in: [...memberIds] } }, select: { id: true, user: { select: { name: true } } } }),
    db.agentProfile.findMany({ where: { organizationId, id: { in: profileIds } }, select: { id: true, adapter: true } }),
    approvalIds.length === 0 ? [] : db.approval.findMany({ where: { organizationId, id: { in: approvalIds } } }),
    loadEvents(db, taskIds, kinds),
    stalledTaskIds.length === 0 ? [] : db.event.groupBy({ by: ["taskId"], where: { taskId: { in: stalledTaskIds } }, _max: { occurredAt: true } }),
  ]);

  const loaded: Loaded = {
    requested: new Map(),
    asked: new Map(),
    askedByTask: new Map(),
    proposed: new Map(),
    lastPlanAnswer: new Map(),
    setupExit: new Map(),
    ticketStatus: new Map(),
    lastEventAt: new Map(lastEvents.flatMap((row) => (row._max.occurredAt === null ? [] : [[row.taskId, row._max.occurredAt.getTime()] as const]))),
  };
  // Newest first: the first seen of a key wins.
  for (const row of events) {
    switch (row.kind) {
      case "approval.requested": {
        const parsed = requestedPayload.safeParse(row.payload);
        if (parsed.success && !loaded.requested.has(parsed.data.approvalId)) loaded.requested.set(parsed.data.approvalId, parsed.data);
        break;
      }
      case "question.asked": {
        const parsed = askedPayload.safeParse(row.payload);
        if (parsed.success && !loaded.asked.has(parsed.data.questionId)) loaded.asked.set(parsed.data.questionId, parsed.data);
        if (parsed.success && !loaded.askedByTask.has(row.taskId)) loaded.askedByTask.set(row.taskId, parsed.data);
        break;
      }
      case "plan.proposed": {
        const parsed = proposedPayload.safeParse(row.payload);
        if (parsed.success && !loaded.proposed.has(`${row.taskId}:${parsed.data.turnId}`)) loaded.proposed.set(`${row.taskId}:${parsed.data.turnId}`, { ...parsed.data, taskId: row.taskId });
        break;
      }
      case "plan.answered": {
        const parsed = planAnsweredPayload.safeParse(row.payload);
        if (parsed.success && !loaded.lastPlanAnswer.has(row.taskId)) loaded.lastPlanAnswer.set(row.taskId, parsed.data.decision);
        break;
      }
      case "environment.setup_finished": {
        const parsed = setupFinishedPayload.safeParse(row.payload);
        if (parsed.success && !loaded.setupExit.has(row.taskId)) loaded.setupExit.set(row.taskId, parsed.data.exitCode);
        break;
      }
      case "ticket.closed": {
        const parsed = ticketClosedPayload.safeParse(row.payload);
        if (parsed.success && !loaded.ticketStatus.has(row.taskId)) loaded.ticketStatus.set(row.taskId, parsed.data.status);
        break;
      }
      default:
        break;
    }
  }

  // An approval from before milestone 3 has no stored subject: its tool call's command is the line.
  const missingSubject = approvals.filter((approval) => approval.subjectKind === null && !loaded.requested.get(approval.id)?.subject).map((approval) => approval.taskId);
  const doing: ReadonlyMap<TaskId, Doing> = missingSubject.length === 0 ? new Map() : await loadDoingByTask(db, missingSubject);

  const projectName = new Map(projects.map((project) => [project.id, project.name] as const));
  const memberName = new Map(members.map((member) => [member.id, member.user.name] as const));
  const adapterOf = new Map(profiles.map((profile) => [profile.id, profile.adapter] as const));
  const approvalById = new Map(approvals.map((approval) => [approval.id, approval] as const));
  const person = (memberId: string | null) => (memberId === null ? null : { memberId: memberIdSchema.parse(memberId), name: memberName.get(memberId) ?? "" });

  return items.map((item): NeedsYouView => {
    const task = item.task;
    const approval = item.approvalId === null ? undefined : approvalById.get(item.approvalId);
    const requested = approval === undefined ? undefined : loaded.requested.get(approval.id);
    const subject: ApprovalSubject | null =
      approval?.subjectKind !== undefined && approval.subjectKind !== null && approval.subjectValue !== null ? { kind: approval.subjectKind, value: approval.subjectValue } : (requested?.subject ?? null);
    const asked = item.questionId === null ? loaded.askedByTask.get(task.id) : loaded.asked.get(item.questionId);
    const proposed = item.planTurnId === null ? undefined : loaded.proposed.get(`${task.id}:${item.planTurnId}`);
    const driver = person(task.driverMemberId);

    const detail = ((): ReasonDetail => {
      switch (item.reason) {
        case "question":
          return { reason: "question", question: asked === undefined ? null : firstLine(asked.message) };
        case "approval":
          return {
            reason: "approval",
            command: subject !== null ? subject.value.slice(0, TITLE_MAX) : (doing.get(taskIdSchema.parse(task.id))?.detail ?? null),
            subject,
            ruleName: requested?.rule?.name ?? null,
          };
        case "plan":
          return { reason: "plan", steps: proposed === undefined ? null : proposed.entries.length };
        case "draft_ready":
          return { reason: "draft_ready", prNumber: task.repos.find((repo) => repo.prNumber !== null)?.prNumber ?? null };
        case "setup_failed":
          return { reason: "setup_failed", exitCode: loaded.setupExit.get(task.id) ?? null };
        case "stalled": {
          const last = loaded.lastEventAt.get(task.id) ?? task.updatedAt.getTime();
          return { reason: "stalled", minutes: Math.max(1, Math.round((now - last) / 60_000)) };
        }
        case "ticket_closed":
          return { reason: "ticket_closed", status: loaded.ticketStatus.get(task.id) ?? null };
        case "no_provider_for_model": {
          const wait = dispatchWaitFromDb(task.dispatchWait);
          return {
            reason: "no_provider_for_model",
            modelName: item.summary === null || item.summary === "" ? null : item.summary,
            provider: wait?.code === "no-provider-for-model" && wait.provider !== undefined ? wait.provider : null,
          };
        }
        case "no_changes":
        case "spend_cap":
        case "crashed":
        case "round_cap":
        case "waiting_for_reviewer":
        case "environment_proposal":
        case "restore_conflict":
        case "unstorable_event":
        case "files_outside_repos":
        case "runner_awaiting_approval":
        case "awaiting_approval":
          return { reason: item.reason };
        default:
          return item.reason satisfies never;
      }
    })();

    const answer = ((): AnswerView | null => {
      if (item.reason === "approval" && approval !== undefined) {
        const options = z.array(approvalOptionSchema).safeParse(approval.options);
        return {
          kind: "approval",
          approvalId: approvalIdSchema.parse(approval.id),
          state: approval.state,
          options: options.success ? options.data : [],
          subject,
          forThisTask: taskRulePreviewOf(subject),
          rule: requested?.rule ?? null,
          agentName: agentDisplayName(task.agentProfileId === null ? "opencode" : (adapterOf.get(task.agentProfileId) ?? "opencode")),
          canAnswer: true,
        };
      }
      if (item.reason === "plan" && proposed !== undefined) {
        return { kind: "plan", entries: proposed.entries, message: proposed.message, canAnswer: driver?.memberId === scope.memberId, driver };
      }
      if (item.reason === "question" && asked !== undefined) {
        return { kind: "question", questionId: questionIdSchema.parse(asked.questionId), message: asked.message, fields: asked.fields, canAnswer: driver?.memberId === scope.memberId, driver };
      }
      return null;
    })();

    const outcome = ((): Outcome | null => {
      if (item.state === "open") {
        return null;
      }
      const by = person(item.resolvedByMemberId);
      if (item.state === "dismissed") {
        return { kind: "closed", by };
      }
      if (item.reason === "approval") {
        if (approval === undefined) return { kind: "closed", by };
        if (approval.state === "answered_by_rule") return { kind: "approved-by-rule", by: null };
        if (approval.state === "closed") return { kind: approval.closedReason === "expired" ? "expired" : "cancelled", by: null };
        if (approval.state === "answered") {
          const answeredBy = person(approval.answeredByMemberId) ?? by;
          return { kind: approval.decision === "deny" ? "denied" : approval.decision === "allow_task" ? "approved-task" : "approved-once", by: answeredBy };
        }
        return { kind: "closed", by };
      }
      if (item.reason === "plan") {
        return { kind: loaded.lastPlanAnswer.get(task.id) === "revise" ? "plan-revised" : "plan-approved", by };
      }
      return { kind: "answered", by };
    })();

    return {
      itemId: item.id === null ? null : needsYouItemIdSchema.parse(item.id),
      reason: item.reason,
      state: item.state,
      taskId: taskIdSchema.parse(task.id),
      key: keyOf(task),
      title: task.title,
      project: { id: projectIdSchema.parse(task.projectId), name: projectName.get(task.projectId) ?? "" },
      since: item.createdAt.getTime(),
      detail,
      driver,
      answer,
      outcome,
    };
  });
};

// ---------- the member's open list ----------

const cursorSchema = z.string().regex(/^\d+:.+$/);

const parseCursor = (cursor: string | undefined): { readonly at: Date; readonly key: string } | null => {
  if (cursor === undefined || !cursorSchema.safeParse(cursor).success) {
    return null;
  }
  const split = cursor.indexOf(":");
  return { at: new Date(Number(cursor.slice(0, split))), key: cursor.slice(split + 1) };
};

const taskSelect = {
  id: true,
  projectId: true,
  ticketKey: true,
  title: true,
  driverMemberId: true,
  agentProfileId: true,
  updatedAt: true,
  repos: { select: { prNumber: true } },
  dispatchWait: true,
} as const;

/** Who reads what waits: the member, with their role for the admins' items. */
export type OpenNeedsYouScope = { readonly organizationId: OrganizationId; readonly memberId: MemberId; readonly role?: "admin" | "member" | undefined };

/**
 * The one rule for what waits on a member (F-062, F-036). An open item of a project they can open
 * that they are the audience of (a driver's item is the driver's, or every member's when the task
 * has none; a project-wide item is every member's; an admins' item is an admin's; a reviewer's item
 * is each matched reviewer's until their review is in, or the driver's when nobody matched) or can answer
 * (every approval: any member answers one). And a task in `needs_you` with no open item (one from
 * before items), so nothing that waits is hidden. Home's section and its total, the Needs you page's
 * Open tab and its count, and the sidebar's count all read this, so they never disagree. An item
 * lives as long as its reason: the writers close it when its task moves on (domain-model.md).
 */
export const openNeedsYouWhere = (scope: OpenNeedsYouScope, projectIds: readonly string[]) => {
  const { organizationId, memberId } = scope;
  const items = {
    organizationId,
    projectId: { in: [...projectIds] },
    state: "open" as const,
    OR: [
      { audience: "project_members" as const },
      { reason: "approval" as const },
      { audience: "driver" as const, task: { OR: [{ driverMemberId: memberId }, { driverMemberId: null }] } },
      // Milestone 6 (F-102, F-036): a task waiting for a reviewer is each matched reviewer's until their review is in,
      { audience: "reviewer" as const, task: { repos: { some: { taskReviewers: { some: { memberId } } } } }, notifications: { none: { memberId, state: { not: "open" as const } } } },
      // and the driver's when nobody is matched.
      {
        audience: "reviewer" as const,
        task: { OR: [{ driverMemberId: memberId }, { driverMemberId: null }], repos: { none: { taskReviewers: { some: { memberId: { not: null } } } } } },
      },
      // Milestone 4 (F-135): what only an organization admin can fix (no provider serves a model) is theirs alone.
      ...(scope.role === "admin" ? [{ audience: "organization_admins" as const }] : []),
    ],
  };
  const legacyTasks = { organizationId, projectId: { in: [...projectIds] }, state: "needs_you" as const, needsYouItems: { none: { state: "open" as const } } };
  return { items, legacyTasks };
};

/** How many things wait on the member, by the one rule: the sidebar's count, and every total beside it. */
export const countOpenNeedsYou = async (deps: { readonly db: Db }, scope: OpenNeedsYouScope, projectIds: readonly string[]): Promise<number> => {
  const where = openNeedsYouWhere(scope, projectIds);
  const [items, legacy] = await Promise.all([deps.db.needsYouItem.count({ where: where.items }), deps.db.task.count({ where: where.legacyTasks })]);
  return items + legacy;
};

/**
 * What waits on a member (`openNeedsYouWhere`), newest first, a page at a time, with its total.
 * `scope` is the member; `projectIds` the projects they can open.
 */
export const listOpenNeedsYou = async (
  deps: { readonly db: Db },
  scope: OpenNeedsYouScope,
  input: { readonly projectIds: readonly string[]; readonly limit: number; readonly cursor?: string | undefined; readonly now: number },
): Promise<{ readonly total: number; readonly rows: readonly NeedsYouView[]; readonly nextCursor: string | null }> => {
  const { db } = deps;
  const { items: itemWhere, legacyTasks: legacyWhere } = openNeedsYouWhere(scope, input.projectIds);
  const after = parseCursor(input.cursor);

  const [total, items, legacy] = await Promise.all([
    countOpenNeedsYou(deps, scope, input.projectIds),
    db.needsYouItem.findMany({
      where: {
        ...itemWhere,
        ...(after === null ? {} : { AND: [{ OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.key } }] }] }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      include: { task: { select: taskSelect } },
    }),
    db.task.findMany({
      where: {
        ...legacyWhere,
        ...(after === null ? {} : { OR: [{ updatedAt: { lt: after.at } }, { updatedAt: after.at, id: { lt: after.key } }] }),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: { ...taskSelect, needsYouReason: true },
    }),
  ]);

  type Entry = { readonly key: string; readonly at: number; readonly row: ItemRow };
  const entries: Entry[] = [
    ...items.map((item): Entry => ({ key: item.id, at: item.createdAt.getTime(), row: item })),
    ...legacy.map(
      (task): Entry => ({
        key: task.id,
        at: task.updatedAt.getTime(),
        row: {
          id: null,
          reason: task.needsYouReason ?? "stalled",
          state: "open",
          createdAt: task.updatedAt,
          resolvedAt: null,
          resolvedByMemberId: null,
          approvalId: null,
          questionId: null,
          planTurnId: null,
          summary: null,
          task,
        },
      }),
    ),
  ].sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const page = entries.slice(0, input.limit);
  const last = page.at(-1);
  const rows = await loadNeedsYouViews(deps, scope, page.map((entry) => entry.row), input.now);
  return {
    total,
    rows,
    nextCursor: entries.length > input.limit && last !== undefined ? `${String(last.at)}:${last.key}` : null,
  };
};
