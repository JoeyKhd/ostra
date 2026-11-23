import { visibleProjects, waitingFor } from "@ostra/domain";
import type { Waiting } from "@ostra/domain";
import type { Db, DbEnum } from "@ostra/db";
import { memberIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";
import type { MemberScope } from "@ostra/domain";
import type { TaskId } from "@ostra/protocol";
import { z } from "zod";

import { taskTicketConnectionsOf } from "../services/ticket-trackers.ts";
import type { TicketConnection } from "../services/ticket-trackers.ts";
import { ciJobsOf, sumCiJobs } from "./ci-jobs.ts";
import type { CiJobs } from "./ci-jobs.ts";
import { loadNeedsYouViews } from "./needs-you-view.ts";
import type { NeedsYouView } from "./needs-you-view.ts";
import { loadDoingByTask } from "./task-doing.ts";
import type { Doing } from "./task-doing.ts";

// F-062 (ticket 36; home-board.md): the organization's tasks as cards in five columns by lifecycle
// state, for the member's projects. Each card carries what its status line is made of, as data the
// panel words: the needs-you item's reason, the queue's pools or runner, the latest activity, the
// in-review sub-state with the PR numbers, how a finished task ended. Totals are apart from the page
// of cards, and each column pages with its own cursor.

const DAY_MS = 86_400_000;

export const boardColumns = ["needs-you", "queued", "running", "in-review", "finished"] as const;
export type BoardColumn = (typeof boardColumns)[number];
export const boardColumnSchema = z.enum(boardColumns);

/** Cards a column returns per page. */
export const BOARD_PAGE_SIZE = 20;
/** The finished column's window. */
export const FINISHED_WINDOW_DAYS = 7;

const statesOf = (column: BoardColumn): readonly DbEnum.TaskState[] => {
  switch (column) {
    case "needs-you":
      return ["needs_you"];
    case "queued":
      return ["queued"];
    case "running":
      return ["preparing", "running"];
    case "in-review":
      return ["in_review"];
    case "finished":
      return ["merged", "done", "stopped"];
    default:
      return column satisfies never;
  }
};

export type CardStatus =
  | { readonly kind: "needs-you"; readonly view: NeedsYouView | null; readonly reason: DbEnum.NeedsYouReason | null }
  | {
      readonly kind: "queued";
      /** A personal runner the member picked, or `null` when the project's pools take it. */
      readonly runner: { readonly name: string; readonly personal: boolean } | null;
      /** The project's pools it can go to, by name. */
      readonly pools: readonly string[];
      readonly waiting: Waiting;
    }
  | { readonly kind: "running"; readonly doing: Doing | null }
  | { readonly kind: "preparing"; readonly doing: Doing | null }
  | {
      readonly kind: "in-review";
      readonly subState: DbEnum.TaskSubState | null;
      readonly prNumbers: readonly number[];
      /**
       * Milestone 10 (F-151/c6, F-062): while its PRs are in CI (`ci_running`), the code host's
       * jobs on their heads, added up, for the sub-state's words (`CI running · 2 of 4 jobs`);
       * `null` in any other sub-state.
       */
      readonly ciJobs: CiJobs | null;
    }
  | {
      readonly kind: "finished";
      readonly outcome: "merged" | "done" | "stopped";
      readonly prNumbers: readonly number[];
      readonly stopReason: DbEnum.TaskStopReason | null;
      /** The member who stopped it, when one did. */
      readonly stoppedBy: { readonly memberId: ReturnType<typeof memberIdSchema.parse>; readonly name: string } | null;
    };

export type BoardCard = {
  readonly taskId: TaskId;
  readonly key: string | null;
  /** Milestone 11 (F-152/c4): the ticket's tracker (its board's connection), for the live list's mark; `null` without a ticket. */
  readonly connection: TicketConnection | null;
  readonly title: string;
  readonly kind: DbEnum.TaskKind;
  /**
   * 2026-11-21 (F-147, ADR 0059 amended): the code task a follow-up (its AI review) belongs to, so
   * a live list nests it under that task; `null` for any other task.
   */
  readonly reviewOf: { readonly taskId: TaskId; readonly key: string | null; readonly title: string } | null;
  readonly state: DbEnum.TaskState;
  readonly project: { readonly id: ReturnType<typeof projectIdSchema.parse>; readonly name: string };
  readonly driver: { readonly memberId: ReturnType<typeof memberIdSchema.parse>; readonly name: string } | null;
  /** Epoch ms: when the task entered its state, so the card's age. */
  readonly enteredAt: number;
  readonly status: CardStatus;
};

export type BoardColumnPage = {
  readonly column: BoardColumn;
  /** The column's full total, whatever page this is. */
  readonly total: number;
  readonly cards: readonly BoardCard[];
  /** Pass it back to load the next page of this column; `null` at the end. */
  readonly nextCursor: string | null;
};

const keyset = z.string().regex(/^k:\d+:.+$/);
const offset = z.string().regex(/^o:\d+$/);

const parseCursor = (cursor: string | undefined): { readonly at: Date; readonly id: string } | { readonly offset: number } | null => {
  if (cursor === undefined) return null;
  if (offset.safeParse(cursor).success) return { offset: Number(cursor.slice(2)) };
  if (keyset.safeParse(cursor).success) {
    const rest = cursor.slice(2);
    const split = rest.indexOf(":");
    return { at: new Date(Number(rest.slice(0, split))), id: rest.slice(split + 1) };
  }
  return null;
};

/** One page of one column, in the board's order. */
const pageOf = async (
  db: Db,
  input: { readonly organizationId: string; readonly projectIds: readonly string[]; readonly column: BoardColumn; readonly cursor: string | undefined; readonly now: number },
): Promise<{ readonly ids: readonly string[]; readonly nextCursor: string | null; readonly total: number }> => {
  const states = statesOf(input.column);
  const where = {
    organizationId: input.organizationId,
    projectId: { in: [...input.projectIds] },
    state: { in: [...states] },
    ...(input.column === "finished" ? { updatedAt: { gte: new Date(input.now - FINISHED_WINDOW_DAYS * DAY_MS) } } : {}),
  };
  const total = await db.task.count({ where });
  const parsed = parseCursor(input.cursor);

  if (input.column === "queued") {
    // The queue's own order: the ticket's priority (1 urgent … 4 low; none last), then age.
    const skip = parsed !== null && "offset" in parsed ? parsed.offset : 0;
    const rows: unknown = await db.$queryRaw`
      SELECT t."id" FROM "task" t
      LEFT JOIN "ticket" k ON k."id" = t."ticketId" AND k."projectId" = t."projectId"
      WHERE t."organizationId" = ${input.organizationId} AND t."projectId" = ANY(${[...input.projectIds]}::text[]) AND t."state" = 'queued'
      ORDER BY CASE WHEN k."priority" IS NULL OR k."priority" = 0 THEN 5 ELSE k."priority" END ASC, t."createdAt" ASC, t."id" ASC
      LIMIT ${BOARD_PAGE_SIZE + 1} OFFSET ${skip}`;
    const ids = z.array(z.object({ id: z.string() })).parse(rows).map((row) => row.id);
    return { ids: ids.slice(0, BOARD_PAGE_SIZE), nextCursor: ids.length > BOARD_PAGE_SIZE ? `o:${String(skip + BOARD_PAGE_SIZE)}` : null, total };
  }

  const after = parsed !== null && "at" in parsed ? parsed : null;
  const rows = await db.task.findMany({
    where: {
      ...where,
      ...(after === null ? {} : { OR: [{ updatedAt: { lt: after.at } }, { updatedAt: after.at, id: { lt: after.id } }] }),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: BOARD_PAGE_SIZE + 1,
    select: { id: true, updatedAt: true },
  });
  const page = rows.slice(0, BOARD_PAGE_SIZE);
  const last = page.at(-1);
  return { ids: page.map((row) => row.id), nextCursor: rows.length > BOARD_PAGE_SIZE && last !== undefined ? `k:${String(last.updatedAt.getTime())}:${last.id}` : null, total };
};

export const loadBoardColumn = async (
  deps: { readonly db: Db },
  scope: MemberScope,
  input: { readonly column: BoardColumn; readonly projectIds: readonly string[]; readonly cursor: string | undefined; readonly now: number },
): Promise<BoardColumnPage> => {
  const { db } = deps;
  const { organizationId } = scope;
  const page = await pageOf(db, { organizationId, projectIds: input.projectIds, column: input.column, cursor: input.cursor, now: input.now });
  if (page.ids.length === 0) {
    return { column: input.column, total: page.total, cards: [], nextCursor: page.nextCursor };
  }
  const tasks = await db.task.findMany({
    where: { organizationId, id: { in: [...page.ids] } },
    include: { repos: { select: { prNumber: true }, orderBy: { createdAt: "asc" } }, project: { select: { id: true, name: true } } },
  });
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const connections = await taskTicketConnectionsOf(deps, organizationId, tasks);
  const ordered = page.ids.flatMap((id) => {
    const task = byId.get(id);
    return task === undefined ? [] : [task];
  });

  const driverIds = ordered.flatMap((task) => (task.driverMemberId === null ? [] : [task.driverMemberId]));
  const liveIds = ordered.filter((task) => task.state === "running" || task.state === "preparing").map((task) => task.id);
  const queuedTasks = ordered.filter((task) => task.state === "queued");
  const stoppedIds = ordered.filter((task) => task.state === "stopped").map((task) => task.id);
  const needsIds = ordered.filter((task) => task.state === "needs_you").map((task) => task.id);
  const inCiIds = ordered.filter((task) => task.state === "in_review" && task.subState === "ci_running").map((task) => task.id);

  const [members, doing, runners, pools, leases, stops, items, ciRepos] = await Promise.all([
    db.member.findMany({ where: { organizationId, id: { in: driverIds } }, select: { id: true, user: { select: { name: true } } } }),
    loadDoingByTask(db, liveIds),
    db.runner.findMany({ where: { organizationId, id: { in: queuedTasks.flatMap((task) => (task.runnerId === null ? [] : [task.runnerId])) } }, select: { id: true, name: true, kind: true } }),
    queuedTasks.length === 0
      ? []
      : db.projectPool.findMany({ where: { organizationId, projectId: { in: [...new Set(queuedTasks.map((task) => task.projectId))] } }, select: { projectId: true, pool: { select: { name: true } } } }),
    queuedTasks.length === 0
      ? []
      : db.lease.findMany({ where: { organizationId, taskId: { in: queuedTasks.map((task) => task.id) }, state: "active" }, select: { taskId: true, acceptedAt: true, grantedAt: true, runner: { select: { id: true, name: true } } } }),
    stoppedIds.length === 0
      ? []
      : db.auditEntry.findMany({ where: { organizationId, action: "task.stopped", entityId: { in: stoppedIds }, actorKind: "member" }, orderBy: { createdAt: "desc" }, select: { entityId: true, actorId: true } }),
    needsIds.length === 0
      ? []
      : db.needsYouItem.findMany({
          where: { organizationId, taskId: { in: needsIds }, state: "open" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          include: { task: { select: { id: true, projectId: true, ticketKey: true, title: true, driverMemberId: true, agentProfileId: true, updatedAt: true, repos: { select: { prNumber: true } } } } },
        }),
    // Milestone 10 (F-151/c6): each PR's head's CI, as `tasks.get` reads it, for a task in CI.
    inCiIds.length === 0
      ? []
      : db.taskRepo.findMany({
          where: { organizationId, taskId: { in: inCiIds }, prNumber: { not: null } },
          select: { taskId: true, headSha: true, ciRuns: { orderBy: { firstSeenAt: "desc" }, take: 5, select: { headSha: true, checks: true } } },
        }),
  ]);
  const ciJobsOfTask = new Map(
    inCiIds.map((taskId) => [
      taskId,
      sumCiJobs(ciRepos.filter((repo) => repo.taskId === taskId).map((repo) => ciJobsOf(repo.ciRuns.find((run) => run.headSha === repo.headSha)?.checks).jobs)),
    ] as const),
  );
  const stopperIds = [...new Set(stops.flatMap((stop) => (stop.actorId === null ? [] : [stop.actorId])))];
  const stoppers = stopperIds.length === 0 ? [] : await db.member.findMany({ where: { organizationId, id: { in: stopperIds } }, select: { id: true, user: { select: { name: true } } } });
  // A follow-up's code task, for the live lists' nesting (2026-11-21).
  const parentIds = [...new Set(ordered.flatMap((task) => (task.kind === "review" && task.reviewOfTaskId !== null ? [task.reviewOfTaskId] : [])))];
  const parents = parentIds.length === 0 ? [] : await db.task.findMany({ where: { organizationId, id: { in: parentIds } }, select: { id: true, ticketKey: true, title: true } });
  const parentOf = new Map(parents.map((parent) => [parent.id, { taskId: taskIdSchema.parse(parent.id), key: parent.ticketKey, title: parent.title }] as const));

  // The newest open item of each needs-you task is its status line.
  const newestItem = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    if (!newestItem.has(item.taskId)) newestItem.set(item.taskId, item);
  }
  const views = await loadNeedsYouViews({ db }, scope, [...newestItem.values()], input.now);
  const viewOfTask = new Map(views.map((view) => [view.taskId, view] as const));

  const nameOf = new Map(members.map((member) => [member.id, member.user.name] as const));
  const runnerOf = new Map(runners.map((runner) => [runner.id, runner] as const));
  const stopperName = new Map(stoppers.map((member) => [member.id, member.user.name] as const));
  const stopperOfTask = new Map<string, string>();
  for (const stop of stops) {
    if (stop.entityId !== null && stop.actorId !== null && !stopperOfTask.has(stop.entityId)) stopperOfTask.set(stop.entityId, stop.actorId);
  }
  const leaseOf = new Map(leases.map((lease) => [lease.taskId, lease] as const));

  const statusOf = (task: (typeof ordered)[number]): CardStatus => {
    const prNumbers = task.repos.flatMap((repo) => (repo.prNumber === null ? [] : [repo.prNumber]));
    switch (task.state) {
      case "needs_you":
        return { kind: "needs-you", view: viewOfTask.get(taskIdSchema.parse(task.id)) ?? null, reason: task.needsYouReason };
      case "queued": {
        const runner = task.runnerId === null ? undefined : runnerOf.get(task.runnerId);
        const lease = leaseOf.get(task.id);
        return {
          kind: "queued",
          runner: runner === undefined ? null : { name: runner.name, personal: runner.kind === "personal" },
          pools: pools.filter((pool) => pool.projectId === task.projectId).map((pool) => pool.pool.name),
          waiting: waitingFor(task, lease === undefined ? null : { acceptedAt: lease.acceptedAt, grantedAt: lease.grantedAt, runner: lease.runner }),
        };
      }
      case "running":
        return { kind: "running", doing: doing.get(taskIdSchema.parse(task.id)) ?? null };
      case "preparing":
        return { kind: "preparing", doing: doing.get(taskIdSchema.parse(task.id)) ?? null };
      case "in_review":
        return { kind: "in-review", subState: task.subState, prNumbers, ciJobs: ciJobsOfTask.get(task.id) ?? null };
      case "merged":
        return { kind: "finished", outcome: "merged", prNumbers, stopReason: null, stoppedBy: null };
      case "done":
        return { kind: "finished", outcome: "done", prNumbers, stopReason: null, stoppedBy: null };
      case "stopped": {
        const actor = stopperOfTask.get(task.id);
        return {
          kind: "finished",
          outcome: "stopped",
          prNumbers,
          stopReason: task.stoppedReason,
          stoppedBy: actor === undefined ? null : { memberId: memberIdSchema.parse(actor), name: stopperName.get(actor) ?? "" },
        };
      }
      case "awaiting_approval":
        // F-040: not drawn until outside tasks ship; a card is never built for it.
        return { kind: "needs-you", view: null, reason: null };
      default:
        return task.state satisfies never;
    }
  };

  return {
    column: input.column,
    total: page.total,
    cards: ordered.map((task) => ({
      taskId: taskIdSchema.parse(task.id),
      key: task.ticketKey,
      connection: connections.get(task.id) ?? null,
      title: task.title,
      kind: task.kind,
      reviewOf: task.kind === "review" && task.reviewOfTaskId !== null ? (parentOf.get(task.reviewOfTaskId) ?? null) : null,
      state: task.state,
      project: { id: projectIdSchema.parse(task.project.id), name: task.project.name },
      driver: task.driverMemberId === null ? null : { memberId: memberIdSchema.parse(task.driverMemberId), name: nameOf.get(task.driverMemberId) ?? "" },
      enteredAt: task.updatedAt.getTime(),
      status: statusOf(task),
    })),
    nextCursor: page.nextCursor,
  };
};

/** The ids of the projects the member can open, optionally narrowed to one. `null`: that project isn't theirs. */
export const boardProjectIds = async (db: Db, scope: MemberScope, only: string | undefined): Promise<readonly string[] | null> => {
  const rows = await db.project.findMany({ where: { organizationId: scope.organizationId }, select: { id: true, access: true } });
  const visible = visibleProjects(
    scope,
    rows.map((row) => ({ id: projectIdSchema.parse(row.id), organizationId: scope.organizationId, access: row.access })),
  ).map((project) => String(project.id));
  if (only === undefined) {
    return visible;
  }
  return visible.includes(only) ? [only] : null;
};

