import {
  budgetMonthBounds,
  budgetMonthOf,
  chooseModelProvider,
  confirmUpgradeChoice,
  loadProviderList,
  modelNameKey,
  modelNameSchema,
  modelNameText,
  previewProviderChange,
  setDefaultProviders,
} from "@ostra/domain";
import type { ProviderDeps } from "@ostra/domain";
import type { Db } from "@ostra/db";
import { modelIdSchema, projectIdSchema, providerIdSchema } from "@ostra/protocol";
import type { ModelId, OrganizationId, ProviderId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../trpc/context.ts";
import { adminProcedure, unwrap } from "../trpc/init.ts";
import { displayNameOf, listVersion, modelDisplayNames, modelLogos, planView, providerPlanViewSchema } from "./project-providers.ts";

// F-135 (ticket 50; ADR 0065): the organization's default provider list, the upgrade's choices to
// confirm, and, for `providers.list`, each provider's projects and its month's spend. Organization
// admins only; a token is never in any answer.

const providerDeps = (ctx: Pick<Context, "deps">): ProviderDeps => ({ db: ctx.deps.db, audit: ctx.deps.ports.audit, jobs: ctx.deps.ports.jobs, clock: ctx.deps.ports.clock });

export const providerUseSchema = z.object({
  /** On the organization's default list. */
  onDefaultList: z.boolean(),
  /** The projects that use it: through the default list, or their own. */
  projects: z.array(z.object({ projectId: projectIdSchema, name: z.string(), via: z.enum(["default", "own"]) })),
  /** This month's spend on its key, in micro-USD: the sum of its models' `SpendDaily` rows. */
  monthSpentMicroUsd: z.number(),
  /** This month's tasks on its key: the tasks with a session it served that started this month. */
  monthTaskCount: z.number().int(),
});
export type ProviderUse = z.infer<typeof providerUseSchema>;

/** Each provider's lists, projects and month's spend, for `providers.list`. */
export const loadProviderUses = async (db: Db, organizationId: OrganizationId, now: number): Promise<ReadonlyMap<string, ProviderUse>> => {
  const bounds = budgetMonthBounds(budgetMonthOf(now));
  const [entries, projects, spend, sessions] = await Promise.all([
    db.providerListEntry.findMany({ where: { organizationId }, select: { providerId: true, projectId: true } }),
    db.project.findMany({ where: { organizationId }, select: { id: true, name: true, ownProviders: true }, orderBy: { name: "asc" } }),
    db.spendDaily.findMany({
      where: { organizationId, day: { gte: new Date(bounds.start), lt: new Date(bounds.end) } },
      select: { spentMicroUsd: true, model: { select: { providerId: true } } },
    }),
    db.session.findMany({
      where: { organizationId, providerId: { not: null }, startedAt: { gte: new Date(bounds.start), lt: new Date(bounds.end) } },
      select: { providerId: true, taskId: true },
      distinct: ["providerId", "taskId"],
    }),
  ]);
  const tasks = new Map<string, number>();
  for (const session of sessions) {
    if (session.providerId !== null) {
      tasks.set(session.providerId, (tasks.get(session.providerId) ?? 0) + 1);
    }
  }
  const onDefault = new Set(entries.filter((entry) => entry.projectId === null).map((entry) => entry.providerId));
  const ownLists = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.projectId !== null) {
      const list = ownLists.get(entry.projectId) ?? new Set<string>();
      list.add(entry.providerId);
      ownLists.set(entry.projectId, list);
    }
  }
  const spent = new Map<string, bigint>();
  for (const row of spend) {
    spent.set(row.model.providerId, (spent.get(row.model.providerId) ?? 0n) + row.spentMicroUsd);
  }
  const providerIds = new Set([...entries.map((entry) => entry.providerId), ...spent.keys(), ...tasks.keys()]);
  const uses = new Map<string, ProviderUse>();
  for (const providerId of providerIds) {
    uses.set(providerId, {
      onDefaultList: onDefault.has(providerId),
      projects: projects.flatMap((project): ProviderUse["projects"] => {
        if (project.ownProviders) {
          return ownLists.get(project.id)?.has(providerId) === true ? [{ projectId: projectIdSchema.parse(project.id), name: project.name, via: "own" as const }] : [];
        }
        return onDefault.has(providerId) ? [{ projectId: projectIdSchema.parse(project.id), name: project.name, via: "default" as const }] : [];
      }),
      monthSpentMicroUsd: Number(spent.get(providerId) ?? 0n),
      monthTaskCount: tasks.get(providerId) ?? 0,
    });
  }
  return uses;
};

/** The projects that follow the default list: what a change to it touches. */
const followingProjects = async (db: Db, organizationId: OrganizationId): Promise<readonly string[]> =>
  (await db.project.findMany({ where: { organizationId, ownProviders: false }, select: { id: true } })).map((project) => project.id);

export const noUse: ProviderUse = { onDefaultList: false, projects: [], monthSpentMicroUsd: 0, monthTaskCount: 0 };

const choiceToConfirmSchema = z.object({
  /** `null`: the organization's default list. */
  project: z.object({ projectId: projectIdSchema, name: z.string() }).nullable(),
  modelName: modelNameSchema,
  text: z.string(),
  displayName: z.string(),
  /** The provider the upgrade kept serving it. */
  kept: z.object({ providerId: providerIdSchema, name: z.string(), modelId: modelIdSchema }),
  /** The other providers on that list that list the model: what "Change" offers. */
  alternatives: z.array(z.object({ providerId: providerIdSchema, name: z.string(), modelId: modelIdSchema })),
});

/** The upgrade's choices still to confirm, on the default list and on each project's own (ADR 0065). */
const loadChoicesToConfirm = async (db: Db, organizationId: OrganizationId): Promise<z.infer<typeof choiceToConfirmSchema>[]> => {
  const [choices, providers, displayNames] = await Promise.all([
    db.modelChoice.findMany({
      where: { organizationId, needsConfirm: true },
      select: { projectId: true, modelId: true, project: { select: { name: true } } },
      orderBy: [{ projectId: "asc" }, { modelKey: "asc" }],
    }),
    db.modelProvider.findMany({ where: { organizationId }, select: { id: true, name: true } }),
    modelDisplayNames(db, organizationId),
  ]);
  const providerName = new Map(providers.map((provider) => [provider.id, provider.name] as const));
  const rows: z.infer<typeof choiceToConfirmSchema>[] = [];
  for (const choice of choices) {
    const projectId = choice.projectId === null ? null : projectIdSchema.parse(choice.projectId);
    const state = await loadProviderList(db, organizationId, projectId);
    const kept = state?.models.find((model) => model.modelId === choice.modelId);
    if (state === null || kept === undefined) {
      continue;
    }
    const key = modelNameKey(kept.name);
    const onList = new Set<string>(state.list);
    const alternatives = new Map<string, { providerId: ProviderId; name: string; modelId: ModelId }>();
    for (const model of state.models) {
      if (model.listed && model.providerId !== kept.providerId && onList.has(model.providerId) && modelNameKey(model.name) === key && !alternatives.has(model.providerId)) {
        alternatives.set(model.providerId, { providerId: model.providerId, name: providerName.get(model.providerId) ?? "", modelId: model.modelId });
      }
    }
    rows.push({
      project: projectId === null ? null : { projectId, name: choice.project?.name ?? "" },
      modelName: kept.name,
      text: modelNameText(kept.name),
      displayName: displayNameOf(displayNames, kept.name),
      kept: { providerId: kept.providerId, name: providerName.get(kept.providerId) ?? "", modelId: kept.modelId },
      alternatives: [...alternatives.values()].sort((x, y) => x.name.localeCompare(y.name)),
    });
  }
  return rows;
};

export const providerListProcedures = {
  /** The upgrade's choices to confirm ("To confirm" on Models): `confirmChoice` answers each. */
  choicesToConfirm: adminProcedure.output(z.array(choiceToConfirmSchema)).query(async ({ ctx }) => loadChoicesToConfirm(ctx.deps.db, ctx.scope.organizationId)),

  /** What a change to the default list would do: every model whose provider changes. Reads only. */
  previewDefaultList: adminProcedure
    .input(z.strictObject({ providerIds: z.array(providerIdSchema).max(100) }))
    .output(providerPlanViewSchema)
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const state = await loadProviderList(db, organizationId, null);
      if (state === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such organization" });
      }
      const preview = unwrap(await previewProviderChange(db, ctx.scope, { projectId: null, providerIds: input.providerIds }), { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND" });
      return planView(db, organizationId, preview.plan, listVersion(state), { projectIds: await followingProjects(db, organizationId), before: state.list, after: input.providerIds, logos: await modelLogos(ctx.deps.catalog) });
    }),

  /** Sets the default list, when it's still as the preview read it (`version`); it may be empty. */
  setDefaultList: adminProcedure
    .input(z.strictObject({ providerIds: z.array(providerIdSchema).max(100), version: z.string().max(64) }))
    .output(providerPlanViewSchema)
    .mutation(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const state = await loadProviderList(db, organizationId, null);
      if (state === null || listVersion(state) !== input.version) {
        throw new TRPCError({ code: "CONFLICT", message: "The default list changed since the preview: preview again" });
      }
      const projectIds = await followingProjects(db, organizationId);
      const saved = unwrap(await setDefaultProviders(providerDeps(ctx), ctx.scope, { providerIds: input.providerIds }), { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND" });
      const now = await loadProviderList(db, organizationId, null);
      return planView(db, organizationId, saved.plan, now === null ? "" : listVersion(now), { projectIds, before: state.list, after: input.providerIds, logos: await modelLogos(ctx.deps.catalog) });
    }),

  /**
   * An upgrade's marked choice: confirms the provider it kept, or (`modelId`) changes it to another
   * provider's row on the same list first. `projectId` null is the default list's.
   */
  confirmChoice: adminProcedure
    .input(z.strictObject({ projectId: projectIdSchema.nullable(), modelName: modelNameSchema, modelId: modelIdSchema.optional() }))
    .output(z.object({ confirmed: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      if (input.modelId !== undefined) {
        unwrap(await chooseModelProvider(providerDeps(ctx), ctx.scope, { projectId: input.projectId, modelId: input.modelId }), {
          forbidden: "FORBIDDEN",
          "not-found": "NOT_FOUND",
          "not-on-list": "BAD_REQUEST",
          "follows-default": "PRECONDITION_FAILED",
        });
      }
      unwrap(await confirmUpgradeChoice(providerDeps(ctx), ctx.scope, { projectId: input.projectId, modelName: input.modelName }), { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND" });
      return { confirmed: true as const };
    }),

  /** The provider that serves a model on the default list. */
  chooseDefaultModelProvider: adminProcedure
    .input(z.strictObject({ modelId: modelIdSchema }))
    .output(z.object({ modelKey: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const chosen = unwrap(await chooseModelProvider(providerDeps(ctx), ctx.scope, { projectId: null, modelId: input.modelId }), {
        forbidden: "FORBIDDEN",
        "not-found": "NOT_FOUND",
        "not-on-list": "BAD_REQUEST",
        "follows-default": "PRECONDITION_FAILED",
      });
      return { modelKey: chosen.modelKey };
    }),
};
