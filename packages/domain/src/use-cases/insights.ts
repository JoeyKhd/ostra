import type { Db, Prisma, Tx } from "@ostra/db";
import { organizationIdSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId } from "@ostra/protocol";

import { prsClosedUnmerged, prsMerged, prsOpened, waitingDurationsByReason } from "../insights/figures.ts";
import type { InsightPeriod, InsightPullRequest, InsightWaitingItem, InsightWaitingByReason } from "../insights/figures.ts";
import type { Clock } from "../ports.ts";

// The Insights job (F-108, ADR 0055, ADR 0035; ticket 14). `insights.compute` runs on a schedule;
// per organization it finds the UTC days whose source rows changed since its last run (task PRs
// opened or closed, needs-you items ended, tasks created), always with today and yesterday, and
// recomputes those days' `InsightDaily` rows, the organization's and each project's, and the
// touched tasks' `TaskMetric`, from ticket 06's definitions. It reads only ostra's own tables, never
// a code host or a tracker, and stores facts: Insights takes the medians at read time (ticket 28).
// A run twice over the same data writes the same rows; two runs at once take a per-organization
// advisory lock, and `lastRunAt` is recorded in the same transaction.

const DAY_MS = 86_400_000;

/** The UTC day an instant falls in, as its first instant. */
export const insightDayOf = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** One day as a period: its first instant, inclusive, to the next day's, exclusive. */
export const insightDayPeriod = (day: number): InsightPeriod => ({ start: day, end: day + DAY_MS });

type DailyFacts = {
  readonly prsOpened: number;
  readonly prsMerged: number;
  readonly prsClosedUnmerged: number;
  readonly waitingMs: bigint;
  readonly waitingItems: number;
  readonly waitingByReason: InsightWaitingByReason;
};

/** One day's facts over rows, by the reference definitions. */
export const dailyFacts = (prs: readonly InsightPullRequest[], items: readonly InsightWaitingItem[], day: number): DailyFacts => {
  const period = insightDayPeriod(day);
  const byReason = waitingDurationsByReason(items, period);
  const durations = Object.values(byReason).flat();
  return {
    prsOpened: prsOpened(prs, period),
    prsMerged: prsMerged(prs, period),
    prsClosedUnmerged: prsClosedUnmerged(prs, period),
    waitingMs: BigInt(durations.reduce((sum, value) => sum + value, 0)),
    waitingItems: durations.length,
    waitingByReason: byReason,
  };
};

const sameJson = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);

/** A JSON object with its keys sorted, so the same durations always store the same value. */
const sortedByReason = (value: InsightWaitingByReason): Prisma.InputJsonObject =>
  Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)));

const isZero = (facts: DailyFacts): boolean =>
  facts.prsOpened === 0 && facts.prsMerged === 0 && facts.prsClosedUnmerged === 0 && facts.waitingItems === 0 && facts.waitingMs === 0n;

type PrRow = {
  readonly taskId: string;
  readonly projectId: string;
  readonly repoId: string;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly state: string;
};

const asInsightPr = (row: PrRow): InsightPullRequest & { readonly projectId: string } => ({
  taskId: taskIdSchema.parse(row.taskId),
  repoId: repoIdSchema.parse(row.repoId),
  projectId: row.projectId,
  openedAt: row.openedAt.getTime(),
  mergedAt: row.state === "merged" ? (row.closedAt?.getTime() ?? null) : null,
  closedUnmergedAt: row.state === "closed_unmerged" ? (row.closedAt?.getTime() ?? null) : null,
});

export type ComputeInsightsResult = { readonly days: number; readonly tasks: number; readonly written: number };

/**
 * One organization's pass, in the caller's transaction. `since` is the last run (`null` before the
 * first, when every day with a source row is computed). Returns how many days and tasks it
 * recomputed, and how many rows it wrote (a row whose facts didn't change isn't written).
 */
export const computeInsightsInTx = async (
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly now: number; readonly since: number | null },
): Promise<ComputeInsightsResult> => {
  const { organizationId, now } = input;
  const since = input.since === null ? null : new Date(input.since);

  // ---- what changed ----
  const changedPrs = await tx.taskPullRequest.findMany({
    where: { organizationId, ...(since === null ? {} : { updatedAt: { gt: since } }) },
    select: { openedAt: true, closedAt: true, taskRepo: { select: { taskId: true } } },
  });
  const endedItems = await tx.needsYouItem.findMany({
    where: { organizationId, resolvedAt: since === null ? { not: null } : { gt: since } },
    select: { taskId: true, resolvedAt: true },
  });
  const createdTasks = await tx.task.findMany({
    where: { organizationId, ...(since === null ? {} : { createdAt: { gt: since } }) },
    select: { id: true },
  });
  const days = new Set<number>([insightDayOf(now), insightDayOf(now) - DAY_MS]);
  const touched = new Set<string>();
  for (const pr of changedPrs) {
    days.add(insightDayOf(pr.openedAt.getTime()));
    if (pr.closedAt !== null) {
      days.add(insightDayOf(pr.closedAt.getTime()));
    }
    touched.add(pr.taskRepo.taskId);
  }
  for (const item of endedItems) {
    if (item.resolvedAt !== null) {
      days.add(insightDayOf(item.resolvedAt.getTime()));
    }
    touched.add(item.taskId);
  }
  for (const task of createdTasks) {
    touched.add(task.id);
  }

  // ---- the days ----
  const sortedDays = [...days].sort((x, y) => x - y);
  let written = 0;
  for (const day of sortedDays) {
    const start = new Date(day);
    const end = new Date(day + DAY_MS);
    const [prRows, itemRows, existing] = await Promise.all([
      tx.taskPullRequest.findMany({
        where: { organizationId, OR: [{ openedAt: { gte: start, lt: end } }, { closedAt: { gte: start, lt: end } }] },
        select: { projectId: true, openedAt: true, closedAt: true, state: true, taskRepo: { select: { taskId: true, repoId: true } } },
      }),
      tx.needsYouItem.findMany({ where: { organizationId, resolvedAt: { gte: start, lt: end } }, select: { projectId: true, reason: true, createdAt: true, resolvedAt: true } }),
      tx.insightDaily.findMany({ where: { organizationId, day: start } }),
    ]);
    const prs = prRows.map((row) => asInsightPr({ taskId: row.taskRepo.taskId, repoId: row.taskRepo.repoId, projectId: row.projectId, openedAt: row.openedAt, closedAt: row.closedAt, state: row.state }));
    const items = itemRows.map((row) => ({ projectId: row.projectId, reason: row.reason, createdAt: row.createdAt.getTime(), endedAt: row.resolvedAt?.getTime() ?? null }));
    const scopes = new Set<string | null>([null, ...prs.map((pr) => pr.projectId), ...items.map((item) => item.projectId), ...existing.map((row) => row.projectId)]);
    for (const projectId of scopes) {
      const facts = dailyFacts(
        projectId === null ? prs : prs.filter((pr) => pr.projectId === projectId),
        projectId === null ? items : items.filter((item) => item.projectId === projectId),
        day,
      );
      const row = existing.find((candidate) => candidate.projectId === projectId);
      const byReason = sortedByReason(facts.waitingByReason);
      if (row === undefined) {
        if (isZero(facts)) {
          continue;
        }
        await tx.insightDaily.create({
          data: { organizationId, projectId, day: start, ...facts, waitingByReason: byReason, computedAt: new Date(now) },
        });
        written += 1;
        continue;
      }
      const same =
        row.prsOpened === facts.prsOpened &&
        row.prsMerged === facts.prsMerged &&
        row.prsClosedUnmerged === facts.prsClosedUnmerged &&
        row.waitingMs === facts.waitingMs &&
        row.waitingItems === facts.waitingItems &&
        sameJson(row.waitingByReason, byReason);
      if (!same) {
        await tx.insightDaily.update({ where: { id: row.id }, data: { ...facts, waitingByReason: byReason, computedAt: new Date(now) } });
        written += 1;
      }
    }
  }

  // ---- the touched tasks ----
  const taskIds = [...touched].sort();
  for (const taskId of taskIds) {
    const task = await tx.task.findFirst({ where: { id: taskId, organizationId }, select: { id: true, projectId: true, kind: true, createdAt: true } });
    if (task === null) {
      continue;
    }
    const [prRows, itemRows, metric] = await Promise.all([
      tx.taskPullRequest.findMany({ where: { taskRepo: { taskId: task.id } }, select: { openedAt: true, closedAt: true, state: true } }),
      tx.needsYouItem.findMany({ where: { taskId: task.id, resolvedAt: { not: null } }, select: { createdAt: true, resolvedAt: true } }),
      tx.taskMetric.findUnique({ where: { taskId: task.id } }),
    ]);
    const firstPr = prRows.reduce<number | null>((first, row) => (first === null || row.openedAt.getTime() < first ? row.openedAt.getTime() : first), null);
    const facts = {
      projectId: task.projectId,
      createdAt: task.createdAt,
      // The time to a first PR is a code task's figure (ADR 0055).
      firstPrAt: task.kind === "code" && firstPr !== null ? new Date(firstPr) : null,
      prsOpened: prRows.length,
      prsMerged: prRows.filter((row) => row.state === "merged").length,
      prsClosedUnmerged: prRows.filter((row) => row.state === "closed_unmerged").length,
      waitingMs: BigInt(itemRows.reduce((sum, row) => sum + Math.max(0, (row.resolvedAt?.getTime() ?? 0) - row.createdAt.getTime()), 0)),
    };
    if (metric === null) {
      await tx.taskMetric.create({ data: { organizationId, taskId: task.id, ...facts, computedAt: new Date(now) } });
      written += 1;
      continue;
    }
    const same =
      metric.projectId === facts.projectId &&
      metric.createdAt.getTime() === facts.createdAt.getTime() &&
      (metric.firstPrAt?.getTime() ?? null) === (facts.firstPrAt?.getTime() ?? null) &&
      metric.prsOpened === facts.prsOpened &&
      metric.prsMerged === facts.prsMerged &&
      metric.prsClosedUnmerged === facts.prsClosedUnmerged &&
      metric.waitingMs === facts.waitingMs;
    if (!same) {
      await tx.taskMetric.update({ where: { id: metric.id }, data: { ...facts, computedAt: new Date(now) } });
      written += 1;
    }
  }
  return { days: sortedDays.length, tasks: taskIds.length, written };
};

/** The advisory lock's key for an organization's pass: two runs at once wait for each other. */
const lockKey = (organizationId: OrganizationId): string => `insights.compute:${organizationId}`;

/**
 * One organization's pass in its own transaction: the advisory lock, the days and tasks since the
 * last run, and `lastRunAt` (the time the pass read from) in the same transaction.
 */
export const computeInsights = async (deps: { readonly db: Db; readonly clock: Clock }, input: { readonly organizationId: OrganizationId }): Promise<ComputeInsightsResult> =>
  deps.db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(input.organizationId)}))`;
      const now = deps.clock.now();
      const run = await tx.insightRun.findUnique({ where: { organizationId: input.organizationId } });
      const result = await computeInsightsInTx(tx, { organizationId: input.organizationId, now, since: run?.lastRunAt?.getTime() ?? null });
      await tx.insightRun.upsert({
        where: { organizationId: input.organizationId },
        create: { organizationId: input.organizationId, lastRunAt: new Date(now), lastSourceChangeAt: result.written > 0 ? new Date(now) : null },
        update: { lastRunAt: new Date(now), ...(result.written > 0 ? { lastSourceChangeAt: new Date(now) } : {}) },
      });
      return result;
    },
    { timeout: 120_000 },
  );

/** `insights.compute`: every organization's pass, one transaction each. */
export const computeAllInsights = async (deps: { readonly db: Db; readonly clock: Clock }): Promise<readonly { readonly organizationId: OrganizationId; readonly result: ComputeInsightsResult }[]> => {
  const organizations = await deps.db.organization.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  const results: { readonly organizationId: OrganizationId; readonly result: ComputeInsightsResult }[] = [];
  for (const organization of organizations) {
    const organizationId = organizationIdSchema.parse(organization.id);
    results.push({ organizationId, result: await computeInsights(deps, { organizationId }) });
  }
  return results;
};
