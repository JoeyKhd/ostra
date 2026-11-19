import { insightWaitingByReasonSchema, median, waitingFromDurations } from "@ostra/domain";
import type { InsightPeriod } from "@ostra/domain";
import { modelIdSchema, projectIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { loadProjectAccess, memberProcedure, router } from "../trpc/init.ts";
import { foldByLine, loadProjectFolding, projectLineSchema } from "./project-folding.ts";
import type { ProjectLine } from "./project-folding.ts";

// F-108 (ticket 28; ADR 0055, ADR 0035): Insights for an organization or one project, over a period
// of UTC days. Nothing here reads tasks, PRs, needs-you items or events: only the rows
// `insights.compute` keeps (`InsightDaily`, `TaskMetric`, `InsightRun`) and the spend rollup
// (`SpendDaily`). The medians are computed here, each with the count it's over. An organization's
// Insights are for every member, with a project the member can't open folded into "Other projects".

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;

const utcDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a UTC date as YYYY-MM-DD");

export const insightPeriodInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preset"), days: z.union([z.literal(7), z.literal(30), z.literal(90)]) }),
  /** Two UTC dates, both days included. */
  z.strictObject({ kind: z.literal("range"), from: utcDateSchema, to: utcDateSchema }),
]);
export type InsightPeriodInput = z.infer<typeof insightPeriodInputSchema>;

const dayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

const parseDay = (text: string): number => {
  const ms = Date.parse(`${text}T00:00:00.000Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${text} isn't a date` });
  }
  return ms;
};

/** The period as UTC instants: `start` inclusive, `end` exclusive. A preset ends with today. */
export const resolveInsightPeriod = (period: InsightPeriodInput, now: number): InsightPeriod => {
  switch (period.kind) {
    case "preset": {
      const end = dayStart(now) + DAY_MS;
      return { start: end - period.days * DAY_MS, end };
    }
    case "range": {
      const start = parseDay(period.from);
      const end = parseDay(period.to) + DAY_MS;
      if (end <= start) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The period ends before it starts" });
      }
      if (end - start > MAX_RANGE_DAYS * DAY_MS) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `A period is at most ${String(MAX_RANGE_DAYS)} days` });
      }
      return { start, end };
    }
    default:
      return period satisfies never;
  }
};

const dayText = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const tokenFiguresSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  unpricedTokens: z.number(),
  spentMicroUsd: z.number(),
});
type TokenFigures = z.infer<typeof tokenFiguresSchema>;

const zeroFigures: TokenFigures = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unpricedTokens: 0, spentMicroUsd: 0 };

const addFigures = (x: TokenFigures, y: TokenFigures): TokenFigures => ({
  inputTokens: x.inputTokens + y.inputTokens,
  outputTokens: x.outputTokens + y.outputTokens,
  cacheReadTokens: x.cacheReadTokens + y.cacheReadTokens,
  cacheWriteTokens: x.cacheWriteTokens + y.cacheWriteTokens,
  unpricedTokens: x.unpricedTokens + y.unpricedTokens,
  spentMicroUsd: x.spentMicroUsd + y.spentMicroUsd,
});

const waitingFigureSchema = z.object({ totalMs: z.number(), medianMs: z.number().nullable(), count: z.number().int() });

export const insightsViewSchema = z.object({
  scope: z.discriminatedUnion("kind", [z.object({ kind: z.literal("organization") }), z.object({ kind: z.literal("project"), projectId: projectIdSchema })]),
  /** Epoch ms: `start` inclusive, `end` exclusive, UTC days. */
  period: z.object({ start: z.number(), end: z.number() }),
  prsOpened: z.number().int(),
  prsMerged: z.number().int(),
  prsClosedUnmerged: z.number().int(),
  /** `null` when no PR closed in the period: the page shows "—". */
  mergeRate: z.number().nullable(),
  timeToFirstPr: z.object({ medianMs: z.number().nullable(), count: z.number().int() }),
  waiting: waitingFigureSchema.extend({ byReason: z.array(waitingFigureSchema.extend({ reason: z.string() })) }),
  /** One row per UTC day of the period, oldest first. */
  series: z.array(z.object({ day: z.string(), prsOpened: z.number().int(), prsMerged: z.number().int() })),
  tokens: z.object({
    total: tokenFiguresSchema,
    byProject: z.array(tokenFiguresSchema.extend({ line: projectLineSchema })),
    byModel: z.array(tokenFiguresSchema.extend({ modelId: modelIdSchema, name: z.string(), providerName: z.string() })),
  }),
  /** When `insights.compute` last ran for the organization; `null` before its first run. */
  computedAt: z.number().nullable(),
});
export type InsightsView = z.infer<typeof insightsViewSchema>;

const figuresOfRow = (row: {
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  readonly cacheReadTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly unpricedTokens: bigint;
  readonly spentMicroUsd: bigint;
}): TokenFigures => ({
  inputTokens: Number(row.inputTokens),
  outputTokens: Number(row.outputTokens),
  cacheReadTokens: Number(row.cacheReadTokens),
  cacheWriteTokens: Number(row.cacheWriteTokens),
  unpricedTokens: Number(row.unpricedTokens),
  spentMicroUsd: Number(row.spentMicroUsd),
});

export const insightsRouter = router({
  get: memberProcedure
    .input(z.strictObject({ projectId: projectIdSchema.nullable(), period: insightPeriodInputSchema }))
    .output(insightsViewSchema)
    .query(async ({ ctx, input }): Promise<InsightsView> => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      let projectId: ProjectId | null = null;
      if (input.projectId !== null) {
        projectId = (await loadProjectAccess(db, ctx.scope, input.projectId, "read")).projectId;
      }
      const period = resolveInsightPeriod(input.period, ports.clock.now());
      const days = { gte: new Date(period.start), lt: new Date(period.end) };

      const [daily, metrics, spend, run, folding] = await Promise.all([
        db.insightDaily.findMany({ where: { organizationId, projectId, day: days }, orderBy: { day: "asc" } }),
        db.taskMetric.findMany({
          where: { organizationId, firstPrAt: { gte: days.gte, lt: days.lt }, ...(projectId === null ? {} : { projectId }) },
          select: { createdAt: true, firstPrAt: true },
        }),
        db.spendDaily.findMany({
          where: { organizationId, day: days, ...(projectId === null ? {} : { projectId }) },
          include: { model: { select: { displayName: true, endpointModelId: true, provider: { select: { name: true } } } } },
        }),
        db.insightRun.findUnique({ where: { organizationId }, select: { lastRunAt: true } }),
        loadProjectFolding(db, ctx.scope),
      ]);

      let prsOpened = 0;
      let prsMerged = 0;
      let prsClosedUnmerged = 0;
      const durations: Record<string, number[]> = {};
      const byDay = new Map<string, { prsOpened: number; prsMerged: number }>();
      for (const row of daily) {
        prsOpened += row.prsOpened;
        prsMerged += row.prsMerged;
        prsClosedUnmerged += row.prsClosedUnmerged;
        byDay.set(dayText(row.day.getTime()), { prsOpened: row.prsOpened, prsMerged: row.prsMerged });
        const parsed = insightWaitingByReasonSchema.safeParse(row.waitingByReason);
        if (!parsed.success) {
          ctx.deps.logger.warn("insights.waiting_unreadable", { organizationId, insightDailyId: row.id });
          continue;
        }
        for (const [reason, list] of Object.entries(parsed.data)) {
          (durations[reason] ??= []).push(...list);
        }
      }
      const closed = prsMerged + prsClosedUnmerged;
      const waiting = waitingFromDurations(durations);

      const firstPr: number[] = [];
      for (const metric of metrics) {
        if (metric.firstPrAt !== null) {
          firstPr.push(Math.max(0, metric.firstPrAt.getTime() - metric.createdAt.getTime()));
        }
      }

      const series: { day: string; prsOpened: number; prsMerged: number }[] = [];
      for (let day = period.start; day < period.end; day += DAY_MS) {
        const text = dayText(day);
        series.push({ day: text, ...(byDay.get(text) ?? { prsOpened: 0, prsMerged: 0 }) });
      }

      let total = zeroFigures;
      const perProject: { line: ProjectLine; value: TokenFigures }[] = [];
      const perModel = new Map<string, { name: string; providerName: string; value: TokenFigures }>();
      for (const row of spend) {
        const figures = figuresOfRow(row);
        total = addFigures(total, figures);
        perProject.push({ line: folding.lineOf(row.projectId), value: figures });
        const seen = perModel.get(row.modelId);
        perModel.set(row.modelId, {
          name: row.model.displayName ?? row.model.endpointModelId,
          providerName: row.model.provider.name,
          value: seen === undefined ? figures : addFigures(seen.value, figures),
        });
      }

      return {
        scope: projectId === null ? { kind: "organization" } : { kind: "project", projectId },
        period,
        prsOpened,
        prsMerged,
        prsClosedUnmerged,
        mergeRate: closed === 0 ? null : prsMerged / closed,
        timeToFirstPr: { medianMs: median(firstPr), count: firstPr.length },
        waiting: {
          totalMs: waiting.totalMs,
          medianMs: waiting.medianMs,
          count: waiting.count,
          byReason: [...waiting.byReason].map(([reason, figure]) => ({ reason, ...figure })).sort((x, y) => y.totalMs - x.totalMs || x.reason.localeCompare(y.reason)),
        },
        series,
        tokens: {
          total,
          byProject: foldByLine(perProject, addFigures).map(({ line, value }) => ({ line, ...value })),
          byModel: [...perModel]
            .map(([modelId, entry]) => ({ modelId: modelIdSchema.parse(modelId), name: entry.name, providerName: entry.providerName, ...entry.value }))
            .sort((x, y) => y.spentMicroUsd - x.spentMicroUsd || x.name.localeCompare(y.name)),
        },
        computedAt: run?.lastRunAt?.getTime() ?? null,
      };
    }),
});
