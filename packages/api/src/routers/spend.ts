import {
  budgetLevel,
  budgetMonthBounds,
  budgetMonthOf,
  budgetOvershoot,
  setBudget,
} from "@ostra/domain";
import type { BudgetLevel } from "@ostra/domain";
import type { DbOrTx } from "@ostra/db";
import { budgetIdSchema, modelIdSchema, projectIdSchema, providerIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId } from "@ostra/protocol";
import { z } from "zod";

import {
  adminProcedure,
  loadProjectAccess,
  memberProcedure,
  router,
  unwrap,
} from "../trpc/init.ts";
import type { Context } from "../trpc/context.ts";
import { foldByLine, loadProjectFolding, projectLineSchema } from "./project-folding.ts";
import type { ProjectFolding, ProjectLine } from "./project-folding.ts";

// F-037 (ticket 27; ADR 0055): a month's spend and the budgets, read from `SpendDaily` only, so the
// task's, the project's and the organization's figures can't disagree. Money is micro-USD. A project
// the member can't open is folded into "Other projects", and its budget isn't listed for them.

export const budgetMonthSchema = z
  .string()
  .regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, "a month as YYYY-MM");

const figuresSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  /** Tokens of calls whose model had no price: counted, not priced. */
  unpricedTokens: z.number(),
  spentMicroUsd: z.number(),
});
type Figures = z.infer<typeof figuresSchema>;

const zero: Figures = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  unpricedTokens: 0,
  spentMicroUsd: 0,
};
const add = (x: Figures, y: Figures): Figures => ({
  inputTokens: x.inputTokens + y.inputTokens,
  outputTokens: x.outputTokens + y.outputTokens,
  cacheReadTokens: x.cacheReadTokens + y.cacheReadTokens,
  cacheWriteTokens: x.cacheWriteTokens + y.cacheWriteTokens,
  unpricedTokens: x.unpricedTokens + y.unpricedTokens,
  spentMicroUsd: x.spentMicroUsd + y.spentMicroUsd,
});

const budgetStateSchema = z.enum(["under", "warn", "reached"]) satisfies z.ZodType<BudgetLevel>;

const budgetViewSchema = z.object({
  budgetId: budgetIdSchema,
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("organization") }),
    z.object({ kind: z.literal("project"), projectId: projectIdSchema, name: z.string() }),
  ]),
  monthlyMicroUsd: z.number(),
  spentMicroUsd: z.number(),
  /** Spent ÷ budget (1 is 100%); a budget of 0 with spend is `null`. */
  share: z.number().nullable(),
  state: budgetStateSchema,
  /** Spend past the budget, which the page shows. */
  overshootMicroUsd: z.number(),
  updatedAt: z.number(),
});
export type BudgetView = z.infer<typeof budgetViewSchema>;

const modelLineSchema = figuresSchema.extend({
  modelId: modelIdSchema,
  name: z.string(),
  providerId: providerIdSchema,
  providerName: z.string(),
});

const providerLineSchema = figuresSchema.extend({ providerId: providerIdSchema, name: z.string() });

export const spendMonthViewSchema = z.object({
  month: budgetMonthSchema,
  total: figuresSchema,
  byProject: z.array(figuresSchema.extend({ line: projectLineSchema })),
  byModel: z.array(modelLineSchema),
  /** Spend per model provider, each one client's key (F-135, ADR 0065): the sum of its model rows. */
  byProvider: z.array(providerLineSchema),
  /** The models whose calls had no price this month, with their tokens. */
  unpriced: z.array(
    z.object({ modelId: modelIdSchema, name: z.string(), unpricedTokens: z.number() }),
  ),
  budgets: z.array(budgetViewSchema),
});
export type SpendMonthView = z.infer<typeof spendMonthViewSchema>;

type SpendRow = {
  readonly projectId: string;
  readonly modelId: string;
  readonly figures: Figures;
  readonly modelName: string;
  readonly providerId: string;
  readonly providerName: string;
};

const loadRows = async (
  db: DbOrTx,
  organizationId: OrganizationId,
  projectId: ProjectId | null,
  month: string,
): Promise<readonly SpendRow[]> => {
  const bounds = budgetMonthBounds(month);
  const rows = await db.spendDaily.findMany({
    where: {
      organizationId,
      ...(projectId === null ? {} : { projectId }),
      day: { gte: new Date(bounds.start), lt: new Date(bounds.end) },
    },
    include: {
      model: {
        select: {
          displayName: true,
          endpointModelId: true,
          provider: { select: { id: true, name: true } },
        },
      },
    },
  });
  return rows.map((row) => ({
    projectId: row.projectId,
    modelId: row.modelId,
    modelName: row.model.displayName ?? row.model.endpointModelId,
    providerId: row.model.provider.id,
    providerName: row.model.provider.name,
    figures: {
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cacheReadTokens: Number(row.cacheReadTokens),
      cacheWriteTokens: Number(row.cacheWriteTokens),
      unpricedTokens: Number(row.unpricedTokens),
      spentMicroUsd: Number(row.spentMicroUsd),
    },
  }));
};

const budgetView = (
  row: {
    readonly id: string;
    readonly projectId: string | null;
    readonly monthlyMicroUsd: bigint;
    readonly updatedAt: Date;
  },
  spent: bigint,
  line: ProjectLine | null,
  warnPercent: number,
): BudgetView | null => {
  if (row.projectId !== null && line?.kind !== "project") {
    return null;
  }
  const monthly = row.monthlyMicroUsd;
  return {
    budgetId: budgetIdSchema.parse(row.id),
    scope:
      line?.kind === "project"
        ? { kind: "project", projectId: line.projectId, name: line.name }
        : { kind: "organization" },
    monthlyMicroUsd: Number(monthly),
    spentMicroUsd: Number(spent),
    share: monthly === 0n ? (spent === 0n ? 0 : null) : Number(spent) / Number(monthly),
    state: budgetLevel(spent, monthly, warnPercent),
    overshootMicroUsd: Number(budgetOvershoot(spent, monthly)),
    updatedAt: row.updatedAt.getTime(),
  };
};

const sumBy = <K extends string>(
  rows: readonly SpendRow[],
  key: (row: SpendRow) => K,
): Map<K, Figures> => {
  const out = new Map<K, Figures>();
  for (const row of rows) {
    out.set(key(row), add(out.get(key(row)) ?? zero, row.figures));
  }
  return out;
};

/** A month's view for an organization (`projectId` null) or one project. */
export const loadSpendMonth = async (
  ctx: Pick<Context, "deps"> & { readonly scope: Parameters<typeof loadProjectFolding>[1] },
  input: { readonly month: string; readonly projectId: ProjectId | null },
  folding: ProjectFolding,
): Promise<SpendMonthView> => {
  const { db, settings } = ctx.deps;
  const organizationId = ctx.scope.organizationId;
  const warnPercent = settings.budgetWarnPercent;
  const rows = await loadRows(db, organizationId, input.projectId, input.month);
  const budgetRows = await db.budget.findMany({
    where: {
      organizationId,
      ...(input.projectId === null
        ? {}
        : { OR: [{ projectId: null }, { projectId: input.projectId }] }),
    },
    select: { id: true, projectId: true, monthlyMicroUsd: true, updatedAt: true },
    orderBy: { createdAt: "asc" },
  });
  // A budget's spend is the whole organization's or the whole project's, whatever this view covers.
  const organizationRows =
    input.projectId === null ? rows : await loadRows(db, organizationId, null, input.month);
  const organizationSpent = BigInt(
    organizationRows.reduce((sum, row) => sum + row.figures.spentMicroUsd, 0),
  );
  const perProject = sumBy(organizationRows, (row) => row.projectId);

  let total = zero;
  for (const row of rows) {
    total = add(total, row.figures);
  }
  const models = new Map<string, SpendRow>(rows.map((row) => [row.modelId, row] as const));
  const providers = new Map<string, string>(
    rows.map((row) => [row.providerId, row.providerName] as const),
  );
  const byModel = [...sumBy(rows, (row) => row.modelId)].map(([modelId, figures]) => {
    const row = models.get(modelId);
    return {
      modelId: modelIdSchema.parse(modelId),
      name: row?.modelName ?? modelId,
      providerId: providerIdSchema.parse(row?.providerId),
      providerName: row?.providerName ?? "",
      ...figures,
    };
  });
  const byProvider = [...sumBy(rows, (row) => row.providerId)].map(([providerId, figures]) => ({
    providerId: providerIdSchema.parse(providerId),
    name: providers.get(providerId) ?? "",
    ...figures,
  }));
  const budgets: BudgetView[] = [];
  for (const row of budgetRows) {
    const line = row.projectId === null ? null : folding.lineOf(row.projectId);
    const spent =
      row.projectId === null
        ? organizationSpent
        : BigInt((perProject.get(row.projectId) ?? zero).spentMicroUsd);
    const view = budgetView(row, spent, line, warnPercent);
    if (view !== null) {
      budgets.push(view);
    }
  }
  return {
    month: input.month,
    total,
    byProject: foldByLine(
      rows.map((row) => ({ line: folding.lineOf(row.projectId), value: row.figures })),
      add,
    ).map(({ line, value }) => ({ line, ...value })),
    byModel: byModel.sort(
      (x, y) => y.spentMicroUsd - x.spentMicroUsd || x.name.localeCompare(y.name),
    ),
    byProvider: byProvider.sort(
      (x, y) => y.spentMicroUsd - x.spentMicroUsd || x.name.localeCompare(y.name),
    ),
    unpriced: byModel
      .filter((line) => line.unpricedTokens > 0)
      .map((line) => ({
        modelId: line.modelId,
        name: line.name,
        unpricedTokens: line.unpricedTokens,
      })),
    budgets: budgets.sort((x, y) => {
      if (x.scope.kind !== y.scope.kind) {
        return x.scope.kind === "organization" ? -1 : 1;
      }
      return x.scope.kind === "project" && y.scope.kind === "project"
        ? x.scope.name.localeCompare(y.scope.name)
        : 0;
    }),
  };
};

export const spendRouter = router({
  /** The organization's month: every member sees it, with the projects they can't open folded. */
  month: memberProcedure
    .input(z.strictObject({ month: budgetMonthSchema }))
    .output(spendMonthViewSchema)
    .query(async ({ ctx, input }) =>
      loadSpendMonth(
        ctx,
        { month: input.month, projectId: null },
        await loadProjectFolding(ctx.deps.db, ctx.scope),
      ),
    ),

  /** One project's month, for its page: anyone who can open the project. */
  project: memberProcedure
    .input(z.strictObject({ projectId: projectIdSchema, month: budgetMonthSchema }))
    .output(spendMonthViewSchema)
    .query(async ({ ctx, input }) => {
      const access = await loadProjectAccess(ctx.deps.db, ctx.scope, input.projectId, "read");
      return loadSpendMonth(
        ctx,
        { month: input.month, projectId: access.projectId },
        await loadProjectFolding(ctx.deps.db, ctx.scope),
      );
    }),

  /** The current month, in UTC, as the server's clock has it. */
  currentMonth: memberProcedure
    .output(budgetMonthSchema)
    .query(({ ctx }) => budgetMonthOf(ctx.deps.ports.clock.now())),
});

/** Dollars, as the form gives them, to micro-USD. */
const dollarsSchema = z.number().min(0).max(1_000_000).multipleOf(0.01);

const budgetErrors = { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "invalid-input": "BAD_REQUEST" } as const;

export const budgetsRouter = router({
  /**
   * An organization admin sets the organization's (`projectId` null) or a project's monthly budget,
   * in dollars (ADR 0055). Set below the month's spend, it warns or closes at once (`budget.check`).
   */
  set: adminProcedure
    .input(z.strictObject({ projectId: projectIdSchema.nullable(), monthlyUsd: dollarsSchema }))
    .output(z.object({ budgetId: budgetIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports, settings } = ctx.deps;
      const saved = unwrap(
        await setBudget({ db, ...ports, budgetWarnPercent: settings.budgetWarnPercent }, ctx.scope, {
          projectId: input.projectId,
          monthlyMicroUsd: BigInt(Math.round(input.monthlyUsd * 100)) * 10_000n,
        }),
        budgetErrors,
      );
      if (saved.budgetId === null) {
        throw new Error("a set budget has an ID");
      }
      return { budgetId: saved.budgetId };
    }),

  /** Clears a budget: the turns it held go through the gate without it. */
  clear: adminProcedure
    .input(z.strictObject({ projectId: projectIdSchema.nullable() }))
    .output(z.object({ cleared: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports, settings } = ctx.deps;
      unwrap(
        await setBudget({ db, ...ports, budgetWarnPercent: settings.budgetWarnPercent }, ctx.scope, {
          projectId: input.projectId,
          monthlyMicroUsd: null,
        }),
        budgetErrors,
      );
      return { cleared: true as const };
    }),
});
