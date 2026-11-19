import { z } from "zod";

import type { ModelId, ProjectId, RepoId, TaskId, TaskKind } from "@ostra/protocol";

// Insights' six figures (F-108, ADR 0055), as pure functions over rows: the reference definitions
// that the `insights.compute` job (ticket 14) and its test both use. A period is UTC instants,
// `start` inclusive and `end` exclusive; every time is ms since the epoch.

export type InsightPeriod = { readonly start: number; readonly end: number };

const within = (period: InsightPeriod, at: number | null): at is number => at !== null && at >= period.start && at < period.end;

/** The median of whole numbers: the middle one, or the floor of the mean of the two middles. `null` for none. */
export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[middle - 1] ?? upper;
  return Math.floor((lower + upper) / 2);
};

/** One PR a task opened (`TaskPullRequest`): each repo's PR is its own row. */
export type InsightPullRequest = {
  readonly taskId: TaskId;
  readonly repoId: RepoId;
  readonly openedAt: number;
  readonly mergedAt: number | null;
  /** When it closed without merging. */
  readonly closedUnmergedAt: number | null;
};

/** 1. PRs opened: every PR a task opened in the period, each repo's PR counted. */
export const prsOpened = (prs: readonly InsightPullRequest[], period: InsightPeriod): number =>
  prs.filter((pr) => within(period, pr.openedAt)).length;

/** 2. PRs merged: every task PR merged in the period. */
export const prsMerged = (prs: readonly InsightPullRequest[], period: InsightPeriod): number =>
  prs.filter((pr) => within(period, pr.mergedAt)).length;

/** PRs closed without merging in the period, for the merge rate. */
export const prsClosedUnmerged = (prs: readonly InsightPullRequest[], period: InsightPeriod): number =>
  prs.filter((pr) => within(period, pr.closedUnmergedAt)).length;

/**
 * 3. Merge rate: merged ÷ (merged + closed unmerged), over the PRs that closed in the period.
 * `null` when none closed (the page shows "—").
 */
export const mergeRate = (prs: readonly InsightPullRequest[], period: InsightPeriod): number | null => {
  const merged = prsMerged(prs, period);
  const closed = merged + prsClosedUnmerged(prs, period);
  return closed === 0 ? null : merged / closed;
};

export type InsightTask = { readonly taskId: TaskId; readonly kind: TaskKind; readonly createdAt: number };

/**
 * 4. Median time to a first PR: for each code task whose first PR opened in the period, from the
 * task's creation to that PR. The median, and the count it's over.
 */
export const medianTimeToFirstPr = (
  tasks: readonly InsightTask[],
  prs: readonly InsightPullRequest[],
  period: InsightPeriod,
): { readonly medianMs: number | null; readonly count: number } => {
  const first = new Map<TaskId, number>();
  for (const pr of prs) {
    const seen = first.get(pr.taskId);
    if (seen === undefined || pr.openedAt < seen) {
      first.set(pr.taskId, pr.openedAt);
    }
  }
  const durations: number[] = [];
  for (const task of tasks) {
    const openedAt = first.get(task.taskId);
    if (task.kind === "code" && openedAt !== undefined && within(period, openedAt)) {
      durations.push(Math.max(0, openedAt - task.createdAt));
    }
  }
  return { medianMs: median(durations), count: durations.length };
};

/** A needs-you item: its reason, when it was made, and when it was answered or dismissed. */
export type InsightWaitingItem = { readonly reason: string; readonly createdAt: number; readonly endedAt: number | null };

export type WaitingFigure = { readonly totalMs: number; readonly medianMs: number | null; readonly count: number };

/**
 * 5. Time waiting on people: for each needs-you item answered or dismissed in the period, from
 * its creation to its end. The total and the median per item, overall and per reason.
 */
export const timeWaiting = (
  items: readonly InsightWaitingItem[],
  period: InsightPeriod,
): WaitingFigure & { readonly byReason: ReadonlyMap<string, WaitingFigure> } => {
  const figure = (durations: readonly number[]): WaitingFigure => ({
    totalMs: durations.reduce((sum, value) => sum + value, 0),
    medianMs: median(durations),
    count: durations.length,
  });
  const all: number[] = [];
  const perReason = new Map<string, number[]>();
  for (const item of items) {
    if (!within(period, item.endedAt)) {
      continue;
    }
    const duration = Math.max(0, item.endedAt - item.createdAt);
    all.push(duration);
    const list = perReason.get(item.reason) ?? [];
    list.push(duration);
    perReason.set(item.reason, list);
  }
  return { ...figure(all), byReason: new Map([...perReason].map(([reason, durations]) => [reason, figure(durations)])) };
};

/** One `SpendDaily` row. */
export type InsightSpendRow = {
  readonly projectId: ProjectId;
  readonly modelId: ModelId;
  /** The UTC day's first instant. */
  readonly day: number;
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  readonly cacheReadTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly spentMicroUsd: bigint;
};

export type SpendTotals = {
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  readonly cacheReadTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly spentMicroUsd: bigint;
};

const zero: SpendTotals = { inputTokens: 0n, outputTokens: 0n, cacheReadTokens: 0n, cacheWriteTokens: 0n, spentMicroUsd: 0n };

const add = (sum: SpendTotals, row: SpendTotals): SpendTotals => ({
  inputTokens: sum.inputTokens + row.inputTokens,
  outputTokens: sum.outputTokens + row.outputTokens,
  cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
  cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
  spentMicroUsd: sum.spentMicroUsd + row.spentMicroUsd,
});

/** 6. Tokens and spend: from `SpendDaily`, the four token kinds and the money, in all, by project and by model. */
export const tokensAndSpend = (
  rows: readonly InsightSpendRow[],
  period: InsightPeriod,
): { readonly total: SpendTotals; readonly byProject: ReadonlyMap<ProjectId, SpendTotals>; readonly byModel: ReadonlyMap<ModelId, SpendTotals> } => {
  let total = zero;
  const byProject = new Map<ProjectId, SpendTotals>();
  const byModel = new Map<ModelId, SpendTotals>();
  for (const row of rows) {
    if (!within(period, row.day)) {
      continue;
    }
    total = add(total, row);
    byProject.set(row.projectId, add(byProject.get(row.projectId) ?? zero, row));
    byModel.set(row.modelId, add(byModel.get(row.modelId) ?? zero, row));
  }
  return { total, byProject, byModel };
};

/**
 * `InsightDaily.waitingByReason` (F-108): per reason, the duration in ms of each needs-you item that
 * ended on that day. `insights.compute` (ticket 14) writes it with `waitingDurationsByReason`;
 * Insights (ticket 28) reads it, so the total, the median per item and the count, overall and per
 * reason, are exact over any run of days, and equal `timeWaiting`'s.
 */
export const insightWaitingByReasonSchema = z.record(z.string().min(1).max(64), z.array(z.number().int().nonnegative()));
export type InsightWaitingByReason = z.infer<typeof insightWaitingByReasonSchema>;

/** The durations of the items that ended in `period`, by reason: what one day's row stores. */
export const waitingDurationsByReason = (items: readonly InsightWaitingItem[], period: InsightPeriod): InsightWaitingByReason => {
  const out: Record<string, number[]> = {};
  for (const item of items) {
    if (!within(period, item.endedAt)) {
      continue;
    }
    const list = out[item.reason] ?? [];
    list.push(Math.max(0, item.endedAt - item.createdAt));
    out[item.reason] = list;
  }
  return out;
};

/** `timeWaiting`'s figures from stored durations by reason (the days' rows merged). */
export const waitingFromDurations = (
  byReason: InsightWaitingByReason,
): WaitingFigure & { readonly byReason: ReadonlyMap<string, WaitingFigure> } => {
  const figure = (durations: readonly number[]): WaitingFigure => ({
    totalMs: durations.reduce((sum, value) => sum + value, 0),
    medianMs: median(durations),
    count: durations.length,
  });
  const all = Object.values(byReason).flat();
  return { ...figure(all), byReason: new Map(Object.entries(byReason).map(([reason, durations]) => [reason, figure(durations)])) };
};
