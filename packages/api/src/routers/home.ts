import { median, visibleProjects } from "@ostra/domain";
import { poolIdSchema, projectIdSchema, runnerIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { memberProcedure, router } from "../trpc/init.ts";
import { boardColumnSchema, boardColumns, boardProjectIds, FINISHED_WINDOW_DAYS, loadBoardColumn } from "./home-board.ts";
import { listOpenNeedsYou } from "./needs-you-view.ts";

// F-062, F-076, home.md: the organization's Home, in one read. What waits on the member (Needs you),
// how each project is doing, what just happened, and the right panel's PRs, spend and runners. It
// covers every project the member can open (Q30, ADR 0026), never another organization's.

const DAY_MS = 86_400_000;
/** The most rows of each Home section; the rest is one click away. */
export const homeLimits = { needsYou: 5, projects: 8, activity: 6 } as const;

/** The audit actions Home words as recent activity; the others stay in the audit log. */
const activityActions = [
  "pr.opened",
  "task.stopped",
  "runner.registered",
  "project.created",
  "provider.added",
  "github.connected",
  // Milestone 3 (ticket 36): what members do to a running task.
  "approval.answered",
  "plan.answered",
  "task.driver-changed",
  "pr.comment-accepted",
] as const;
type ActivityAction = (typeof activityActions)[number];

const isActivityAction = (action: string): action is ActivityAction => activityActions.some((known) => known === action);

/** Midnight UTC of the day `now` is in, as epoch ms: the PR chart's days are UTC days. */
export const startOfDay = (now: number): number => now - (now % DAY_MS);

/** The first instant of `now`'s month, UTC. */
export const startOfMonth = (now: number): number => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

/**
 * A month's spend in US dollars, from the sum of its `SpendDaily` rows: the key proxy's count of
 * each call, priced on its four kinds at the serving provider's own model row (F-089, F-135, ADR
 * 0055), as the Spend page and the budgets read it. `null` when nothing was counted, or only calls
 * whose model has no price.
 */
export const monthSpend = (sum: { readonly spentMicroUsd: bigint; readonly unpricedTokens: bigint } | undefined): number | null =>
  sum === undefined || (sum.spentMicroUsd === 0n && sum.unpricedTokens > 0n) ? null : Number(sum.spentMicroUsd) / 1_000_000;

/** Counts per day for the last `days` UTC days, oldest first, today last. */
export const countByDay = (times: readonly number[], now: number, days: number): { readonly day: number; readonly count: number }[] => {
  const today = startOfDay(now);
  return Array.from({ length: days }, (_, i) => {
    const day = today - (days - 1 - i) * DAY_MS;
    return { day, count: times.filter((time) => time >= day && time < day + DAY_MS).length };
  });
};

const prData = z.object({ number: z.number().int(), reused: z.boolean().optional() });
const stopData = z.object({ reason: z.string().optional() });
const approvalData = z.object({ decision: z.enum(["allow_once", "allow_task", "deny"]) });

export const homeRouter = router({
  /** Home, for the member: every section's rows and the right panel's figures. */
  overview: memberProcedure.query(async ({ ctx }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const now = Date.now();
    const weekAgo = new Date(startOfDay(now) - 6 * DAY_MS);

    const projectRows = await db.project.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      include: { repos: { orderBy: { createdAt: "asc" }, select: { fullName: true } } },
    });
    const visible = visibleProjects(
      ctx.scope,
      projectRows.map((row) => ({ id: projectIdSchema.parse(row.id), organizationId, access: row.access, row })),
    );
    const ids: ProjectId[] = visible.map((project) => project.id);
    const nameOf = new Map(visible.map(({ row }) => [row.id, row.name] as const));

    const [counts, prEntries, spendRows, auditRows, needsYou, mergedRows, firstPrRows, budget] = await Promise.all([
      db.task.groupBy({
        by: ["projectId", "state"],
        where: { organizationId, projectId: { in: ids }, state: { in: ["queued", "preparing", "running", "needs_you"] } },
        _count: { _all: true },
      }),
      db.auditEntry.findMany({
        where: { organizationId, projectId: { in: ids }, action: "pr.opened", createdAt: { gte: weekAgo } },
        select: { projectId: true, data: true, createdAt: true },
      }),
      // This month's spend per project, from the one rollup the Spend page and the budgets read (F-037).
      db.spendDaily.groupBy({
        by: ["projectId"],
        where: { organizationId, projectId: { in: ids }, day: { gte: new Date(startOfMonth(now)) } },
        _sum: { spentMicroUsd: true, unpricedTokens: true },
      }),
      db.auditEntry.findMany({
        where: { organizationId, action: { in: [...activityActions] }, OR: [{ projectId: null }, { projectId: { in: ids } }] },
        orderBy: { createdAt: "desc" },
        take: 40,
        select: { id: true, projectId: true, action: true, actorId: true, entityId: true, data: true, createdAt: true },
      }),
      listOpenNeedsYou({ db }, ctx.scope, { projectIds: ids, limit: homeLimits.needsYou, now }),
      // The right panel's PRs merged this week (home.md): a merged PR's `closedAt` is when it merged.
      db.taskPullRequest.findMany({
        where: { organizationId, projectId: { in: ids }, state: "merged", closedAt: { gte: weekAgo } },
        select: { closedAt: true },
      }),
      // The median time from a task's start to its first PR, over the tasks whose first PR came this week.
      db.taskMetric.findMany({
        where: { organizationId, projectId: { in: ids }, firstPrAt: { gte: weekAgo } },
        select: { createdAt: true, firstPrAt: true },
      }),
      // The organization's monthly budget, the spend figure's cap (F-037); `null` without one.
      db.budget.findFirst({ where: { organizationId, projectId: null }, select: { monthlyMicroUsd: true } }),
    ]);

    const countOf = (projectId: string | null, states: readonly string[]): number =>
      counts
        .filter((row) => (projectId === null || row.projectId === projectId) && states.includes(row.state))
        .reduce((sum, row) => sum + row._count._all, 0);

    // ---- spend: this month's `SpendDaily`, the key proxy's counts as ingest priced them (F-084, F-089, F-135) ----
    const spendOf = (projectId: string | null): number | null => {
      const rows = spendRows.filter((row) => projectId === null || row.projectId === projectId);
      return rows.length === 0
        ? null
        : monthSpend({
            spentMicroUsd: rows.reduce((sum, row) => sum + (row._sum.spentMicroUsd ?? 0n), 0n),
            unpricedTokens: rows.reduce((sum, row) => sum + (row._sum.unpricedTokens ?? 0n), 0n),
          });
    };

    // ---- PRs opened: the `pr.opened` audit entries, a reused PR not counted twice ----
    const opened = prEntries.filter((entry) => prData.safeParse(entry.data).data?.reused !== true);
    const prsOf = (projectId: string): number => opened.filter((entry) => entry.projectId === projectId).length;

    // ---- projects ----
    const projects = visible
      .map(({ row }) => ({
        id: projectIdSchema.parse(row.id),
        name: row.name,
        repos: row.repos.map((repo) => repo.fullName),
        running: countOf(row.id, ["running", "preparing"]),
        queued: countOf(row.id, ["queued"]),
        needsYou: countOf(row.id, ["needs_you"]),
        prsThisWeek: prsOf(row.id),
        spendMonth: spendOf(row.id),
      }))
      .sort((a, b) => b.needsYou - a.needsYou || b.running - a.running);

    // ---- recent activity: the audit log's entries Home words, newest first ----
    const entries = auditRows.flatMap((row) => (isActivityAction(row.action) ? [{ ...row, action: row.action }] : []));
    const entityIds = (action: ActivityAction) => entries.flatMap((entry) => (entry.action === action && entry.entityId !== null ? [entry.entityId] : []));
    // An answered approval names the approval; the task it asked on is the one the line is about.
    const answeredApprovals = await db.approval.findMany({ where: { organizationId, id: { in: entityIds("approval.answered") } }, select: { id: true, taskId: true } });
    const approvalTask = new Map(answeredApprovals.map((approval) => [approval.id, approval.taskId] as const));
    const actorIds = entries.flatMap((entry) => (entry.actorId === null ? [] : [entry.actorId]));
    const [activityTasks, activityRunners, activityProviders, actors] = await Promise.all([
      db.task.findMany({
        where: {
          organizationId,
          id: {
            in: [
              ...entityIds("pr.opened"),
              ...entityIds("task.stopped"),
              ...entityIds("plan.answered"),
              ...entityIds("task.driver-changed"),
              ...entityIds("pr.comment-accepted"),
              ...answeredApprovals.map((approval) => approval.taskId),
            ],
          },
        },
        select: { id: true, ticketKey: true, title: true },
      }),
      db.runner.findMany({ where: { organizationId, id: { in: entityIds("runner.registered") } }, select: { id: true, name: true, kind: true, pool: { select: { name: true } } } }),
      db.modelProvider.findMany({ where: { organizationId, id: { in: entityIds("provider.added") } }, select: { id: true, name: true } }),
      db.member.findMany({ where: { organizationId, id: { in: actorIds } }, select: { id: true, user: { select: { name: true } } } }),
    ]);
    const actorName = new Map(actors.map((actor) => [actor.id, actor.user.name] as const));
    const taskOf = new Map(activityTasks.map((task) => [task.id, task] as const));
    const runnerOf = new Map(activityRunners.map((runner) => [runner.id, runner] as const));
    const providerOf = new Map(activityProviders.map((provider) => [provider.id, provider] as const));

    const eventOf = (entry: (typeof entries)[number]) => {
      const id = entry.entityId ?? "";
      switch (entry.action) {
        case "pr.opened": {
          const task = taskOf.get(id);
          const pr = prData.safeParse(entry.data);
          if (task === undefined || !pr.success || pr.data.reused === true) return null;
          return { kind: entry.action, prNumber: pr.data.number, title: task.title, taskId: taskIdSchema.parse(task.id) };
        }
        case "task.stopped": {
          const task = taskOf.get(id);
          if (task === undefined) return null;
          return { kind: entry.action, key: task.ticketKey ?? task.id.slice(0, 8), reason: stopData.safeParse(entry.data).data?.reason ?? null, taskId: taskIdSchema.parse(task.id) };
        }
        case "runner.registered": {
          const runner = runnerOf.get(id);
          if (runner === undefined) return null;
          return { kind: entry.action, runner: runner.name, pool: runner.pool?.name ?? null };
        }
        case "project.created":
          return entry.projectId === null ? null : { kind: entry.action, project: nameOf.get(entry.projectId) ?? "" };
        case "provider.added": {
          const provider = providerOf.get(id);
          return provider === undefined ? null : { kind: entry.action, provider: provider.name };
        }
        case "github.connected":
          return { kind: entry.action };
        case "approval.answered": {
          const task = taskOf.get(approvalTask.get(id) ?? "");
          if (task === undefined) return null;
          return {
            kind: entry.action,
            decision: approvalData.safeParse(entry.data).data?.decision ?? null,
            key: task.ticketKey ?? task.id.slice(0, 8),
            title: task.title,
            taskId: taskIdSchema.parse(task.id),
            by: entry.actorId === null ? null : (actorName.get(entry.actorId) ?? null),
          };
        }
        case "plan.answered":
        case "task.driver-changed":
        case "pr.comment-accepted": {
          const task = taskOf.get(id);
          if (task === undefined) return null;
          return {
            kind: entry.action,
            key: task.ticketKey ?? task.id.slice(0, 8),
            title: task.title,
            taskId: taskIdSchema.parse(task.id),
            by: entry.actorId === null ? null : (actorName.get(entry.actorId) ?? null),
          };
        }
        default:
          return entry.action satisfies never;
      }
    };
    const activity = entries
      .flatMap((entry) => {
        const event = eventOf(entry);
        return event === null
          ? []
          : [{
              id: entry.id,
              event,
              project: entry.projectId === null ? null : { id: projectIdSchema.parse(entry.projectId), name: nameOf.get(entry.projectId) ?? "" },
              at: entry.createdAt.getTime(),
            }];
      })
      .slice(0, homeLimits.activity);

    // ---- runners: the pools' runners and the member's own; an admin sees every personal one ----
    const runnerRows = await db.runner.findMany({
      where: {
        organizationId,
        state: { not: "revoked" },
        ...(ctx.scope.role === "admin" ? {} : { OR: [{ kind: "pool" as const }, { ownerMemberId: ctx.scope.memberId }] }),
      },
      orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, kind: true, state: true, capacity: true, pool: { select: { id: true, name: true } }, _count: { select: { leases: { where: { state: "active" } } } } },
    });
    // The pools (home.md, "Runner pools"): each pool's busy boxes against its online runners' slots.
    const pools = new Map<string, { id: string; name: string; busy: number; slots: number; online: number; runners: number }>();
    for (const runner of runnerRows) {
      if (runner.pool === null) continue;
      const pool = pools.get(runner.pool.id) ?? { id: runner.pool.id, name: runner.pool.name, busy: 0, slots: 0, online: 0, runners: 0 };
      pool.busy += runner._count.leases;
      pool.runners += 1;
      if (runner.state === "online") {
        pool.online += 1;
        pool.slots += runner.capacity;
      }
      pools.set(runner.pool.id, pool);
    }
    const firstPrMs = firstPrRows.flatMap((row) => (row.firstPrAt === null ? [] : [Math.max(0, row.firstPrAt.getTime() - row.createdAt.getTime())]));

    const running = countOf(null, ["running", "preparing"]);
    const queued = countOf(null, ["queued"]);
    const prDays = countByDay(opened.map((entry) => entry.createdAt.getTime()), now, 7);
    const mergedDays = countByDay(mergedRows.flatMap((row) => (row.closedAt === null ? [] : [row.closedAt.getTime()])), now, 7);
    return {
      summary: { projects: visible.length, running, queued, prsToday: prDays.at(-1)?.count ?? 0, mergedToday: mergedDays.at(-1)?.count ?? 0 },
      /** The open items the member is the audience of or can answer, newest first (ticket 36). */
      needsYou: { total: needsYou.total, rows: needsYou.rows },
      projects: { total: projects.length, rows: projects.slice(0, homeLimits.projects) },
      activity,
      prsOpened: { total: opened.length, days: prDays },
      prsMerged: { total: mergedDays.reduce((sum, day) => sum + day.count, 0), days: mergedDays, firstPrMedianMs: median(firstPrMs) },
      spendMonth: spendOf(null),
      /** The organization's monthly budget in US dollars, `null` without one (F-037). */
      spendCap: budget === null ? null : Number(budget.monthlyMicroUsd) / 1_000_000,
      pools: [...pools.values()].map((pool) => ({ ...pool, id: poolIdSchema.parse(pool.id) })),
      runners: runnerRows.map((runner) => ({
        id: runnerIdSchema.parse(runner.id),
        name: runner.name,
        kind: runner.kind,
        online: runner.state === "online",
        running: runner._count.leases,
        capacity: runner.capacity,
      })),
    };
  }),

  /**
   * "Open all" (ticket 36): the member's whole needs-you list, newest first, a page at a time. The
   * same rows Home shows five of, with what an inline answer needs; a project the member can't open
   * contributes nothing.
   */
  needsYou: memberProcedure
    .input(z.strictObject({ cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      const projectIds = (await boardProjectIds(ctx.deps.db, ctx.scope, undefined)) ?? [];
      return listOpenNeedsYou({ db: ctx.deps.db }, ctx.scope, { projectIds, limit: input.limit, cursor: input.cursor, now: Date.now() });
    }),

  /**
   * The board (ticket 36; home-board.md): the organization's tasks the member can open as five
   * columns by lifecycle state, each with its full total, its first page of cards and a cursor.
   * `column` and `cursor` ask for one column's next page; `projectId` narrows to one project.
   */
  board: memberProcedure
    .input(z.strictObject({ projectId: projectIdSchema.optional(), column: boardColumnSchema.optional(), cursor: z.string().max(200).optional() }))
    .query(async ({ ctx, input }) => {
      const projectIds = await boardProjectIds(ctx.deps.db, ctx.scope, input.projectId);
      if (projectIds === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such project" });
      }
      const now = Date.now();
      const columns = input.column === undefined ? boardColumns : ([input.column] as const);
      const pages = await Promise.all(columns.map((column) => loadBoardColumn({ db: ctx.deps.db }, ctx.scope, { column, projectIds, cursor: column === input.column ? input.cursor : undefined, now })));
      return { columns: pages, finishedWindowDays: FINISHED_WINDOW_DAYS };
    }),
});
