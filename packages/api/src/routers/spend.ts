import {
  budgetLevel,
  budgetMonthBounds,
  budgetMonthOf,
  budgetOvershoot,
  dispatchWaitFromDb,
  requireOrganizationAdmin,
  setBudget,
} from "@ostra/domain";
import type { BudgetLevel } from "@ostra/domain";
import type { DbOrTx } from "@ostra/db";
import { budgetIdSchema, modelIdSchema, projectIdSchema, providerIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
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
  /** Ticket 36 (the Spend page): when this month's 80% and 100% notices went out, epoch ms. */
  warnedAt: z.number().nullable(),
  reachedAt: z.number().nullable(),
  /** The turns it holds now: tasks queued at dispatch, and every other origin's turns. */
  queuedTasks: z.number().int(),
  heldTurns: z.number().int(),
  /** Who last set it, and when. */
  setBy: z.object({ name: z.string(), at: z.number() }).nullable(),
});
export type BudgetView = z.infer<typeof budgetViewSchema>;

const modelLineSchema = figuresSchema.extend({
  modelId: modelIdSchema,
  name: z.string(),
  providerId: providerIdSchema,
  providerName: z.string(),
  /** Ticket 36: a model with no catalog entry, and the catalog's logo on ostra's own server. */
  custom: z.boolean(),
  logoPath: z.string().nullable(),
});

const providerLineSchema = figuresSchema.extend({
  providerId: providerIdSchema,
  name: z.string(),
  /**
   * The tasks with a session on this key that started in the month (spend-keys.md, the panel's
   * `Tasks`), in the projects the caller can open: a restricted project's tasks count only for its
   * members and the organization's admins.
   */
  taskCount: z.number().int(),
});

export const spendMonthViewSchema = z.object({
  month: budgetMonthSchema,
  total: figuresSchema,
  byProject: z.array(figuresSchema.extend({ line: projectLineSchema })),
  byModel: z.array(modelLineSchema),
  /**
   * Spend per model provider, each one client's key (F-135, ADR 0065): the sum of its model rows,
   * highest first and ties by name. For an organization admin, the organization's month lists every
   * provider it held by the month's end, one that spent nothing at zero (spend-keys.md, choice 8).
   * Anyone else's lists the providers that spent, as a project's month does: a key's name, often its
   * client's, never reaches a member through a key that spent nothing.
   */
  byProvider: z.array(providerLineSchema),
  /** The models whose calls had no price this month, with their tokens. */
  unpriced: z.array(
    z.object({ modelId: modelIdSchema, name: z.string(), unpricedTokens: z.number() }),
  ),
  budgets: z.array(budgetViewSchema),
});
export type SpendMonthView = z.infer<typeof spendMonthViewSchema>;

export const modelPriceViewSchema = z.object({
  modelId: modelIdSchema,
  name: z.string(),
  endpointModelId: z.string(),
  custom: z.boolean(),
  logoPath: z.string().nullable(),
  providerName: z.string(),
  /** `null`: nobody priced it yet. */
  priceSource: z.enum(["endpoint", "catalog", "admin"]).nullable(),
  priceChangedAt: z.number().nullable(),
  /** US dollars per million tokens; `null` where that kind has no price. */
  prices: z.object({
    inputPerMTok: z.number().nullable(),
    outputPerMTok: z.number().nullable(),
    cacheReadPerMTok: z.number().nullable(),
    cacheWritePerMTok: z.number().nullable(),
  }),
  /** Its tokens in the month that no price counted. */
  unpricedTokens: z.number(),
});
export type ModelPriceView = z.infer<typeof modelPriceViewSchema>;

type SpendRow = {
  readonly projectId: string;
  readonly modelId: string;
  readonly figures: Figures;
  readonly modelName: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly catalogId: string | null;
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
          catalogId: true,
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
    catalogId: row.model.catalogId,
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

/**
 * The tasks with a session on each key that started in the month, in every project of the
 * organization (`projectIds` null) or in those listed: a task counts once per key, however many
 * sessions it had on it.
 */
export const loadMonthTaskCounts = async (
  db: DbOrTx,
  organizationId: OrganizationId,
  projectIds: readonly ProjectId[] | null,
  month: string,
): Promise<ReadonlyMap<string, number>> => {
  const bounds = budgetMonthBounds(month);
  const sessions = await db.session.findMany({
    where: {
      organizationId,
      ...(projectIds === null ? {} : { projectId: { in: [...projectIds] } }),
      providerId: { not: null },
      startedAt: { gte: new Date(bounds.start), lt: new Date(bounds.end) },
    },
    select: { providerId: true, taskId: true },
    distinct: ["providerId", "taskId"],
  });
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (session.providerId !== null) {
      counts.set(session.providerId, (counts.get(session.providerId) ?? 0) + 1);
    }
  }
  return counts;
};

type BudgetExtras = Pick<BudgetView, "warnedAt" | "reachedAt" | "queuedTasks" | "heldTurns" | "setBy">;

/** This month's notices, the turns each budget holds now, and who set it (ticket 36). */
const loadBudgetExtras = async (
  db: DbOrTx,
  organizationId: OrganizationId,
  month: string,
  rows: readonly { readonly id: string; readonly projectId: string | null; readonly updatedByMemberId: string | null; readonly updatedAt: Date }[],
): Promise<ReadonlyMap<string, BudgetExtras>> => {
  const ids = rows.map((row) => row.id);
  const memberIds = [...new Set(rows.flatMap((row) => (row.updatedByMemberId === null ? [] : [row.updatedByMemberId])))];
  const [notices, held, members, waiting] = await Promise.all([
    db.budgetNotice.findMany({ where: { organizationId, budgetId: { in: ids }, month }, select: { budgetId: true, threshold: true, sentAt: true } }),
    db.heldTurn.findMany({ where: { organizationId, budgetId: { in: ids }, releasedAt: null }, select: { budgetId: true, origin: true, taskId: true } }),
    db.member.findMany({ where: { organizationId, id: { in: memberIds } }, select: { id: true, user: { select: { name: true } } } }),
    // A new task the gate keeps queued has no held turn: its dispatch note names the budget's scope.
    db.task.findMany({ where: { organizationId, state: "queued", dispatchWait: { path: ["code"], equals: "budget-reached" } }, select: { id: true, projectId: true, dispatchWait: true } }),
  ]);
  const names = new Map(members.map((member) => [member.id, member.user.name] as const));
  return new Map(
    rows.map((row) => {
      const own = held.filter((turn) => turn.budgetId === row.id);
      const at = (threshold: "warn" | "reached"): number | null =>
        notices.find((notice) => notice.budgetId === row.id && notice.threshold === threshold)?.sentAt.getTime() ?? null;
      const name = row.updatedByMemberId === null ? undefined : names.get(row.updatedByMemberId);
      return [
        row.id,
        {
          warnedAt: at("warn"),
          reachedAt: at("reached"),
          queuedTasks: new Set([
            ...own.filter((turn) => turn.origin === "dispatch").map((turn) => turn.taskId),
            ...waiting
              .filter((task) => {
                const wait = dispatchWaitFromDb(task.dispatchWait);
                return wait?.code === "budget-reached" && (row.projectId === null ? wait.scope === "organization" : wait.scope === "project" && task.projectId === row.projectId);
              })
              .map((task) => task.id),
          ]).size,
          heldTurns: own.filter((turn) => turn.origin !== "dispatch").length,
          setBy: name === undefined ? null : { name, at: row.updatedAt.getTime() },
        },
      ] as const;
    }),
  );
};

const noExtras: BudgetExtras = { warnedAt: null, reachedAt: null, queuedTasks: 0, heldTurns: 0, setBy: null };

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
  extras: BudgetExtras,
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
    ...extras,
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
    select: { id: true, projectId: true, monthlyMicroUsd: true, updatedAt: true, updatedByMemberId: true },
    orderBy: { createdAt: "asc" },
  });
  // A budget's spend is the whole organization's or the whole project's, whatever this view covers.
  const organizationRows =
    input.projectId === null ? rows : await loadRows(db, organizationId, null, input.month);
  const organizationSpent = BigInt(
    organizationRows.reduce((sum, row) => sum + row.figures.spentMicroUsd, 0),
  );
  const perProject = sumBy(organizationRows, (row) => row.projectId);
  // The Keys section is an organization admin's (spend-keys.md). Anyone else sees the keys that
  // spent, never one that sits only on a restricted project's list or on none, and counts the tasks
  // of the projects they can open: an organization admin can open every project.
  const admin = requireOrganizationAdmin(ctx.scope, organizationId).ok;
  let countedProjects: readonly ProjectId[] | null = null;
  if (input.projectId !== null) {
    countedProjects = [input.projectId];
  } else if (!admin) {
    countedProjects = [...folding.visible.keys()];
  }
  const [extras, catalog, taskCounts, keys] = await Promise.all([
    loadBudgetExtras(db, organizationId, input.month, budgetRows),
    ctx.deps.catalog.entries(),
    loadMonthTaskCounts(db, organizationId, countedProjects, input.month),
    // An admin's month lists every key the organization held then, one that spent nothing at zero
    // (spend-keys.md): a key added after the month wasn't one of its keys.
    input.projectId === null && admin
      ? db.modelProvider.findMany({
          where: { organizationId, createdAt: { lt: new Date(budgetMonthBounds(input.month).end) } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const logos = new Map(catalog.map((entry) => [entry.catalogId, entry.logoPath] as const));

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
    const catalogId = row?.catalogId ?? null;
    return {
      modelId: modelIdSchema.parse(modelId),
      name: row?.modelName ?? modelId,
      providerId: providerIdSchema.parse(row?.providerId),
      providerName: row?.providerName ?? "",
      custom: catalogId === null,
      logoPath: catalogId === null ? null : (logos.get(catalogId) ?? null),
      ...figures,
    };
  });
  const providerFigures = sumBy(rows, (row) => row.providerId);
  for (const key of keys) {
    providers.set(key.id, key.name);
    if (!providerFigures.has(key.id)) {
      providerFigures.set(key.id, zero);
    }
  }
  const byProvider = [...providerFigures].map(([providerId, figures]) => ({
    providerId: providerIdSchema.parse(providerId),
    name: providers.get(providerId) ?? "",
    taskCount: taskCounts.get(providerId) ?? 0,
    ...figures,
  }));
  const budgets: BudgetView[] = [];
  for (const row of budgetRows) {
    const line = row.projectId === null ? null : folding.lineOf(row.projectId);
    const spent =
      row.projectId === null
        ? organizationSpent
        : BigInt((perProject.get(row.projectId) ?? zero).spentMicroUsd);
    const view = budgetView(row, spent, line, warnPercent, extras.get(row.id) ?? noExtras);
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
  /**
   * The organization's month: every member sees it, with the projects they can't open folded. Only
   * an organization admin's lists the keys that spent nothing (`byProvider`).
   */
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

  /**
   * Ticket 36: one model's four prices for the Spend page's price form, where they came from, and
   * its tokens this month that no price counted. Organization admins, who set prices.
   */
  modelPrice: adminProcedure
    .input(z.strictObject({ modelId: modelIdSchema, month: budgetMonthSchema }))
    .output(modelPriceViewSchema)
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const model = await db.model.findFirst({
        where: { id: input.modelId, organizationId },
        select: {
          id: true,
          endpointModelId: true,
          displayName: true,
          catalogId: true,
          inputPricePerMTok: true,
          outputPricePerMTok: true,
          cacheReadPricePerMTok: true,
          cacheWritePricePerMTok: true,
          priceSource: true,
          priceChangedAt: true,
          provider: { select: { name: true } },
        },
      });
      if (model === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such model" });
      }
      const bounds = budgetMonthBounds(input.month);
      const [unpriced, catalog] = await Promise.all([
        db.spendDaily.aggregate({
          where: { organizationId, modelId: model.id, day: { gte: new Date(bounds.start), lt: new Date(bounds.end) } },
          _sum: { unpricedTokens: true },
        }),
        ctx.deps.catalog.entries(),
      ]);
      const price = (value: { toNumber: () => number } | null): number | null => (value === null ? null : value.toNumber());
      return {
        modelId: modelIdSchema.parse(model.id),
        name: model.displayName ?? model.endpointModelId,
        endpointModelId: model.endpointModelId,
        custom: model.catalogId === null,
        logoPath: model.catalogId === null ? null : (catalog.find((entry) => entry.catalogId === model.catalogId)?.logoPath ?? null),
        providerName: model.provider.name,
        priceSource: model.priceSource,
        priceChangedAt: model.priceChangedAt?.getTime() ?? null,
        prices: {
          inputPerMTok: price(model.inputPricePerMTok),
          outputPerMTok: price(model.outputPricePerMTok),
          cacheReadPerMTok: price(model.cacheReadPricePerMTok),
          cacheWritePerMTok: price(model.cacheWritePricePerMTok),
        },
        unpricedTokens: Number(unpriced._sum.unpricedTokens ?? 0n),
      };
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
        await setBudget({ db, ...ports, budgetWarnPercent: settings.budgetWarnPercent, spendCap: { capMicroUsd: settings.taskSpendCapMicroUsd, capTokens: settings.taskTokenCap } }, ctx.scope, {
          projectId: input.projectId,
          monthlyMicroUsd: null,
        }),
        budgetErrors,
      );
      return { cleared: true as const };
    }),
});
