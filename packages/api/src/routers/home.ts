import { visibleProjects } from "@ostra/domain";
import { projectIdSchema, runnerIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { z } from "zod";

import { memberProcedure, router } from "../trpc/init.ts";

// F-062, F-076, home.md: the organization's Home, in one read. What waits on the member (Needs you),
// how each project is doing, what just happened, and the right panel's PRs, spend and runners. It
// covers every project the member can open (Q30, ADR 0026), never another organization's.

const DAY_MS = 86_400_000;
/** The most rows of each Home section; the rest is one click away. */
export const homeLimits = { needsYou: 5, projects: 8, activity: 6 } as const;
const QUESTION_MAX = 200;
const TITLE_MAX = 200;

/** The audit actions Home words as recent activity; the others stay in the audit log. */
const activityActions = ["pr.opened", "task.stopped", "runner.registered", "project.created", "provider.added", "github.connected"] as const;
type ActivityAction = (typeof activityActions)[number];

const isActivityAction = (action: string): action is ActivityAction => activityActions.some((known) => known === action);

/** Midnight UTC of the day `now` is in, as epoch ms: the PR chart's days are UTC days. */
export const startOfDay = (now: number): number => now - (now % DAY_MS);

/** The first instant of `now`'s month, UTC. */
export const startOfMonth = (now: number): number => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

/** A model's price for a session's tokens, in US dollars. `null` when the model has no price. */
export const sessionCost = (
  tokens: { readonly inputTokens: number; readonly outputTokens: number },
  price: { readonly input: number | null; readonly output: number | null } | undefined,
): number | null => {
  if (price === undefined || price.input === null || price.output === null) return null;
  return (tokens.inputTokens * price.input + tokens.outputTokens * price.output) / 1_000_000;
};

/** Counts per day for the last `days` UTC days, oldest first, today last. */
export const countByDay = (times: readonly number[], now: number, days: number): { readonly day: number; readonly count: number }[] => {
  const today = startOfDay(now);
  return Array.from({ length: days }, (_, i) => {
    const day = today - (days - 1 - i) * DAY_MS;
    return { day, count: times.filter((time) => time >= day && time < day + DAY_MS).length };
  });
};

const firstLine = (text: string): string => (text.split(/\r?\n/, 1)[0] ?? "").trim().slice(0, QUESTION_MAX);

const latestRow = z.object({ taskId: z.string(), kind: z.string(), payload: z.unknown(), occurredAt: z.date() });
const questionPayload = z.object({ message: z.string() });
const setupPayload = z.object({ exitCode: z.number().int().nullable() });
const toolPayload = z.object({ title: z.string() });
const prData = z.object({ number: z.number().int(), reused: z.boolean().optional() });
const stopData = z.object({ reason: z.string().optional() });

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

    const [counts, waiting, prEntries, sessions, auditRows] = await Promise.all([
      db.task.groupBy({
        by: ["projectId", "state"],
        where: { organizationId, projectId: { in: ids }, state: { in: ["queued", "preparing", "running", "needs_you"] } },
        _count: { _all: true },
      }),
      db.task.findMany({
        where: { organizationId, projectId: { in: ids }, state: "needs_you" },
        select: {
          id: true,
          ticketKey: true,
          title: true,
          projectId: true,
          needsYouReason: true,
          updatedAt: true,
          needsYouItems: { where: { state: "open" }, orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
          repos: { where: { prNumber: { not: null } }, orderBy: { createdAt: "asc" }, take: 1, select: { prNumber: true } },
        },
      }),
      db.auditEntry.findMany({
        where: { organizationId, projectId: { in: ids }, action: "pr.opened", createdAt: { gte: weekAgo } },
        select: { projectId: true, data: true, createdAt: true },
      }),
      db.session.findMany({
        where: { organizationId, projectId: { in: ids }, startedAt: { gte: new Date(startOfMonth(now)) } },
        select: { projectId: true, inputTokens: true, outputTokens: true, agentProfileId: true },
      }),
      db.auditEntry.findMany({
        where: { organizationId, action: { in: [...activityActions] }, OR: [{ projectId: null }, { projectId: { in: ids } }] },
        orderBy: { createdAt: "desc" },
        take: 40,
        select: { id: true, projectId: true, action: true, entityId: true, data: true, createdAt: true },
      }),
    ]);

    const countOf = (projectId: string | null, states: readonly string[]): number =>
      counts
        .filter((row) => (projectId === null || row.projectId === projectId) && states.includes(row.state))
        .reduce((sum, row) => sum + row._count._all, 0);

    // ---- spend: the key proxy's token counts at the model's catalog price (F-084, F-089) ----
    const profileIds = [...new Set(sessions.flatMap((session) => (session.agentProfileId === null ? [] : [session.agentProfileId])))];
    const profiles = await db.agentProfile.findMany({
      where: { organizationId, id: { in: profileIds } },
      select: { id: true, model: { select: { inputPricePerMTok: true, outputPricePerMTok: true } } },
    });
    const toPrice = (value: { toNumber: () => number } | null | undefined): number | null => (value === null || value === undefined ? null : value.toNumber());
    const priceOf = new Map(
      profiles.map((profile) => [profile.id, { input: toPrice(profile.model?.inputPricePerMTok), output: toPrice(profile.model?.outputPricePerMTok) }] as const),
    );
    const spendOf = (projectId: string | null): number | null => {
      let total: number | null = null;
      for (const session of sessions) {
        if (projectId !== null && session.projectId !== projectId) continue;
        const cost = sessionCost(session, session.agentProfileId === null ? undefined : priceOf.get(session.agentProfileId));
        if (cost !== null) total = (total ?? 0) + cost;
      }
      return total;
    };

    // ---- PRs opened: the `pr.opened` audit entries, a reused PR not counted twice ----
    const opened = prEntries.filter((entry) => prData.safeParse(entry.data).data?.reused !== true);
    const prsOf = (projectId: string): number => opened.filter((entry) => entry.projectId === projectId).length;

    // ---- needs you: what the agent asked or why it stopped, from the latest events ----
    const waitingIds = waiting.map((task) => task.id);
    const latest =
      waitingIds.length === 0
        ? []
        : z.array(latestRow).parse(
            await db.$queryRaw`
              SELECT DISTINCT ON ("taskId", "kind") "taskId", "kind", "payload", "occurredAt" FROM "event"
              WHERE "taskId" = ANY(${waitingIds}::text[]) AND "kind" = ANY(${["question.asked", "environment.setup_finished", "tool.called"]}::text[])
              ORDER BY "taskId", "kind", "seq" DESC`,
          );
    const lastEvent = waitingIds.length === 0
      ? []
      : await db.event.groupBy({ by: ["taskId"], where: { taskId: { in: waitingIds } }, _max: { occurredAt: true } });
    const latestOf = (taskId: string, kind: string) => latest.find((row) => row.taskId === taskId && row.kind === kind);

    const detailOf = (task: (typeof waiting)[number]) => {
      const reason = task.needsYouReason ?? "stalled";
      switch (reason) {
        case "question": {
          const parsed = questionPayload.safeParse(latestOf(task.id, "question.asked")?.payload);
          return { reason, question: parsed.success ? firstLine(parsed.data.message) : null };
        }
        case "approval": {
          const parsed = toolPayload.safeParse(latestOf(task.id, "tool.called")?.payload);
          return { reason, command: parsed.success ? parsed.data.title.slice(0, TITLE_MAX) : null };
        }
        case "draft_ready":
          return { reason, prNumber: task.repos[0]?.prNumber ?? null };
        case "setup_failed": {
          const parsed = setupPayload.safeParse(latestOf(task.id, "environment.setup_finished")?.payload);
          return { reason, exitCode: parsed.success ? parsed.data.exitCode : null };
        }
        case "stalled": {
          const last = lastEvent.find((row) => row.taskId === task.id)?._max.occurredAt ?? task.updatedAt;
          return { reason, minutes: Math.max(1, Math.round((now - last.getTime()) / 60_000)) };
        }
        case "plan":
        case "no_changes":
        case "spend_cap":
        case "crashed":
        case "ticket_closed":
        case "round_cap":
        case "waiting_for_reviewer":
        case "environment_proposal":
        // Milestone 2: needs-you items rather than task states, listed for completeness (ticket 06).
        case "restore_conflict":
        case "unstorable_event":
        // Q133, ticket 44: the item names the files; the row says what it is.
        case "files_outside_repos":
          return { reason };
        default:
          return reason satisfies never;
      }
    };

    const needsYou = waiting
      .map((task) => ({
        taskId: taskIdSchema.parse(task.id),
        key: task.ticketKey ?? task.id.slice(0, 8),
        title: task.title,
        project: { id: projectIdSchema.parse(task.projectId), name: nameOf.get(task.projectId) ?? "" },
        detail: detailOf(task),
        /** Epoch ms: since when it has waited. */
        since: (task.needsYouItems[0]?.createdAt ?? task.updatedAt).getTime(),
      }))
      .sort((a, b) => b.since - a.since);

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
    const [activityTasks, activityRunners, activityProviders] = await Promise.all([
      db.task.findMany({
        where: { organizationId, id: { in: [...entityIds("pr.opened"), ...entityIds("task.stopped")] } },
        select: { id: true, ticketKey: true, title: true },
      }),
      db.runner.findMany({ where: { organizationId, id: { in: entityIds("runner.registered") } }, select: { id: true, name: true, kind: true, pool: { select: { name: true } } } }),
      db.modelProvider.findMany({ where: { organizationId, id: { in: entityIds("provider.added") } }, select: { id: true, name: true } }),
    ]);
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
      select: { id: true, name: true, kind: true, state: true, capacity: true, _count: { select: { leases: { where: { state: "active" } } } } },
    });

    const running = countOf(null, ["running", "preparing"]);
    const queued = countOf(null, ["queued"]);
    const prDays = countByDay(opened.map((entry) => entry.createdAt.getTime()), now, 7);
    return {
      summary: { projects: visible.length, running, queued, prsToday: prDays.at(-1)?.count ?? 0 },
      needsYou: { total: needsYou.length, rows: needsYou.slice(0, homeLimits.needsYou) },
      projects: { total: projects.length, rows: projects.slice(0, homeLimits.projects) },
      activity,
      prsOpened: { total: opened.length, days: prDays },
      spendMonth: spendOf(null),
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
});
