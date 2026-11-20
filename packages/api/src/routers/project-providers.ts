import { createHash } from "node:crypto";

import {
  chooseModelProvider,
  loadProviderList,
  modelNameKey,
  modelNameOfModel,
  modelNameSchema,
  modelNameText,
  previewProviderChange,
  profileModelName,
  resolveProfileModel,
  setProjectProviders,
} from "@ostra/domain";
import type { MemberScope, ModelName, ProviderChangePlan, ProviderDeps, ProviderListState } from "@ostra/domain";
import type { Db, DbOrTx } from "@ostra/db";
import { mapModelProvider } from "@ostra/db";
import { apiFormatSchema, modelIdSchema, projectIdSchema, providerIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, ProviderId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../trpc/context.ts";
import { projectProcedure, unwrap } from "../trpc/init.ts";

// F-135 (ticket 50; ADR 0065): a project's providers. Anyone who can open the project reads which
// providers serve it, by name, and which serves each model its profiles use: never a token, nor a
// provider's address beyond its host. An organization admin previews and saves the list (its own,
// or the organization's default), and chooses the provider that serves a model there. A save applies
// only the plan the admin saw: when the list changed since the preview, it's a CONFLICT.

const providerLineSchema = z.object({
  providerId: providerIdSchema,
  name: z.string(),
  /** The base URL's host: where the key is used, never the key. */
  host: z.string(),
  apiFormat: apiFormatSchema,
});

const servedSchema = z.object({ providerId: providerIdSchema, providerName: z.string(), modelId: modelIdSchema }).nullable();

export const projectProvidersViewSchema = z.object({
  mode: z.enum(["default", "own"]),
  providers: z.array(providerLineSchema),
  /**
   * Each model a profile names, and the provider that serves it here; `null` is "no key". A model
   * that profiles on their own provider name is a row per provider, with `pinned` set (ADR 0065
   * amended 2026-11-20): that provider serves it, only while this project's list allows it.
   */
  models: z.array(
    z.object({
      name: modelNameSchema,
      text: z.string(),
      displayName: z.string(),
      logoPath: z.string().nullable(),
      served: servedSchema,
      needsConfirm: z.boolean(),
      pinned: z.object({ providerId: providerIdSchema, providerName: z.string() }).nullable(),
    }),
  ),
});
export type ProjectProvidersView = z.infer<typeof projectProvidersViewSchema>;

export const providerPlanViewSchema = z.object({
  lines: z.array(
    z.object({
      name: modelNameSchema,
      text: z.string(),
      /** The name people read ("Claude Sonnet 5.5"), else the text. */
      displayName: z.string(),
      /** The catalog's logo for the model, where it has one. */
      logoPath: z.string().nullable(),
      change: z.enum(["keeps", "moves", "loses", "gains"]),
      before: servedSchema,
      after: servedSchema,
    }),
  ),
  /**
   * "What happens" (ticket 50, the lead's item 7): the idle boxes released because their key leaves
   * the list, with those providers' names, and the unfinished tasks that would wait with no key,
   * with the models they run on.
   */
  whatHappens: z.object({
    released: z.object({ count: z.number().int(), providers: z.array(z.object({ providerId: providerIdSchema, name: z.string() })) }),
    waiting: z.object({ count: z.number().int(), models: z.array(z.object({ text: z.string(), displayName: z.string() })) }),
  }),
  /** What the save must be sent with: the list as the preview read it. */
  version: z.string(),
});
export type ProviderPlanView = z.infer<typeof providerPlanViewSchema>;

export const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
};

/** The list's state as a short fingerprint: a save compares it with the preview's. */
export const listVersion = (state: ProviderListState): string =>
  createHash("sha256")
    .update(JSON.stringify({ own: state.own, list: [...state.list].sort(), choices: [...state.choices].map((choice) => `${choice.modelKey}=${choice.modelId}`).sort() }))
    .digest("hex")
    .slice(0, 32);

const providerNames = async (db: DbOrTx, organizationId: OrganizationId): Promise<ReadonlyMap<string, string>> =>
  new Map((await db.modelProvider.findMany({ where: { organizationId }, select: { id: true, name: true } })).map((row) => [row.id, row.name] as const));

/** Each model name's display name: a listed row's, else any row's, by `modelNameKey`. */
export const modelDisplayNames = async (db: DbOrTx, organizationId: OrganizationId): Promise<ReadonlyMap<string, string>> => {
  const rows = await db.model.findMany({ where: { organizationId }, select: { catalogId: true, endpointModelId: true, displayName: true, listed: true }, orderBy: { id: "asc" } });
  const names = new Map<string, string>();
  for (const row of [...rows].sort((x, y) => Number(y.listed) - Number(x.listed))) {
    const key = modelNameKey(modelNameOfModel(row));
    if (!names.has(key) && row.displayName !== null) {
      names.set(key, row.displayName);
    }
  }
  return names;
};

/** A catalog model's logo, by its catalog ID: `null` for a custom model or one the catalog has none for. */
export type ModelLogos = ReadonlyMap<string, string>;

export const modelLogos = async (catalog: { readonly entries: () => Promise<readonly { readonly catalogId: string; readonly logoPath: string | null }[]> }): Promise<ModelLogos> =>
  new Map((await catalog.entries()).flatMap((entry) => (entry.logoPath === null ? [] : [[entry.catalogId, entry.logoPath] as const])));

export const logoOf = (logos: ModelLogos, name: ModelName): string | null => (name.kind === "catalog" ? (logos.get(name.catalogId) ?? null) : null);

/** The name people read: a row's display name, else the catalog ID or endpoint ID. */
export const displayNameOf = (names: ReadonlyMap<string, string>, name: ModelName): string => names.get(modelNameKey(name)) ?? modelNameText(name);

/** The box states that hold a key (as `providers.release-boxes` reads them). */
const HOLDING_STATES = ["ready", "idle", "stopped"] as const;
const FINISHED_TASK_STATES = ["stopped", "merged", "done"] as const;

/**
 * What a list change would do to the projects that use the list: the idle boxes holding a key that
 * leaves it, and the unfinished tasks whose model would have no provider.
 */
const whatHappensOf = async (
  db: DbOrTx,
  organizationId: OrganizationId,
  input: {
    readonly projectIds: readonly string[];
    readonly removed: ReadonlySet<string>;
    readonly plan: ProviderChangePlan;
    readonly displayNames: ReadonlyMap<string, string>;
    readonly providerNames: ReadonlyMap<string, string>;
  },
): Promise<ProviderPlanView["whatHappens"]> => {
  const losing = new Set(input.plan.lines.filter((line) => line.change === "loses").map((line) => modelNameKey(line.name)));
  const releasedProviders = new Set<string>();
  let released = 0;
  if (input.removed.size > 0 && input.projectIds.length > 0) {
    const boxes = await db.box.findMany({ where: { organizationId, projectId: { in: [...input.projectIds] }, state: { in: [...HOLDING_STATES] } }, select: { id: true } });
    for (const box of boxes) {
      const session = await db.session.findFirst({ where: { boxId: box.id, organizationId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { providerId: true, state: true } });
      const providerId = session?.providerId ?? null;
      if (session !== null && providerId !== null && session.state !== "running" && input.removed.has(providerId)) {
        released += 1;
        releasedProviders.add(providerId);
      }
    }
  }
  const waitingModels = new Map<string, ModelName>();
  let waiting = 0;
  if (losing.size > 0 && input.projectIds.length > 0) {
    const tasks = await db.task.findMany({
      where: { organizationId, projectId: { in: [...input.projectIds] }, state: { notIn: [...FINISHED_TASK_STATES] } },
      select: { sessions: { orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 1, select: { model: { select: { catalogId: true, endpointModelId: true } } } } },
    });
    for (const task of tasks) {
      const model = task.sessions[0]?.model ?? null;
      if (model === null) {
        continue;
      }
      const name = modelNameOfModel(model);
      const key = modelNameKey(name);
      if (losing.has(key)) {
        waiting += 1;
        waitingModels.set(key, name);
      }
    }
  }
  return {
    released: {
      count: released,
      providers: [...releasedProviders].sort().map((providerId) => ({ providerId: providerIdSchema.parse(providerId), name: input.providerNames.get(providerId) ?? "" })),
    },
    waiting: { count: waiting, models: [...waitingModels.values()].map((name) => ({ text: modelNameText(name), displayName: displayNameOf(input.displayNames, name) })) },
  };
};

/** A plan as the panel shows it: every model whose provider changes, by name, and what happens. */
export const planView = async (
  db: DbOrTx,
  organizationId: OrganizationId,
  plan: ProviderChangePlan,
  version: string,
  scope: { readonly projectIds: readonly string[]; readonly before: readonly ProviderId[]; readonly after: readonly ProviderId[]; readonly logos: ModelLogos },
): Promise<ProviderPlanView> => {
  const [names, displayNames] = await Promise.all([providerNames(db, organizationId), modelDisplayNames(db, organizationId)]);
  const served = (side: { readonly providerId: ProviderId; readonly modelId: string } | null) =>
    side === null ? null : { providerId: side.providerId, providerName: names.get(side.providerId) ?? "", modelId: modelIdSchema.parse(side.modelId) };
  const kept = new Set<string>(scope.after);
  return {
    lines: plan.lines.map((line) => ({
      name: line.name,
      text: modelNameText(line.name),
      displayName: displayNameOf(displayNames, line.name),
      logoPath: logoOf(scope.logos, line.name),
      change: line.change,
      before: served(line.before),
      after: served(line.after),
    })),
    whatHappens: await whatHappensOf(db, organizationId, {
      projectIds: scope.projectIds,
      removed: new Set(scope.before.filter((providerId) => !kept.has(providerId))),
      plan,
      displayNames,
      providerNames: names,
    }),
    version,
  };
};

/** A model the organization's live profiles use: by name (`pinned` null), or on one provider. */
export type ProfileModelUse = { readonly name: ModelName; readonly pinned: { readonly providerId: ProviderId; readonly providerName: string } | null };

/**
 * The models the organization's live profiles use, once each: by name for the profiles saved
 * before, and once per provider for those that name their provider (ADR 0065 amended 2026-11-20).
 */
export const profileModelUses = async (db: DbOrTx, organizationId: OrganizationId): Promise<readonly ProfileModelUse[]> => {
  const profiles = await db.agentProfile.findMany({
    where: { organizationId, archivedAt: null },
    select: { modelCatalogId: true, modelCustomName: true, model: { select: { catalogId: true, endpointModelId: true } }, provider: { select: { id: true, name: true } } },
  });
  const byKey = new Map<string, ProfileModelUse>();
  for (const profile of profiles) {
    const name = profileModelName(profile);
    if (name !== null) {
      const pinned = profile.provider === null ? null : { providerId: providerIdSchema.parse(profile.provider.id), providerName: profile.provider.name };
      byKey.set(`${modelNameKey(name)}|${pinned?.providerId ?? ""}`, { name, pinned });
    }
  }
  return [...byKey.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, use]) => use);
};

/** A project's providers and what serves each model, as anyone who can open it reads them. */
export const loadProjectProviders = async (db: Db, organizationId: OrganizationId, projectId: ProjectId, logos: ModelLogos): Promise<ProjectProvidersView> => {
  const state = await loadProviderList(db, organizationId, projectId);
  if (state === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such project" });
  }
  const [rows, names, confirms, displayNames] = await Promise.all([
    db.modelProvider.findMany({ where: { organizationId, id: { in: [...state.list] } }, orderBy: { name: "asc" } }),
    profileModelUses(db, organizationId),
    db.modelChoice.findMany({ where: { organizationId, projectId: state.listProjectId, needsConfirm: true }, select: { modelKey: true } }),
    modelDisplayNames(db, organizationId),
  ]);
  const providerName = new Map(rows.map((row) => [row.id, row.name] as const));
  const unconfirmed = new Set(confirms.map((row) => row.modelKey));
  return {
    mode: state.own ? "own" : "default",
    providers: rows.map((row) => {
      const provider = mapModelProvider(row);
      return { providerId: provider.id, name: provider.name, host: hostOf(provider.baseUrl), apiFormat: provider.apiFormat };
    }),
    models: names.map(({ name, pinned }) => {
      const resolved = resolveProfileModel(state.list, state.choices, state.models, name, pinned?.providerId ?? null);
      return {
        name,
        text: modelNameText(name),
        displayName: displayNameOf(displayNames, name),
        logoPath: logoOf(logos, name),
        served: resolved.ok ? { providerId: resolved.providerId, providerName: pinned?.providerName ?? providerName.get(resolved.providerId) ?? "", modelId: resolved.modelId } : null,
        // A model on a profile's own provider has no choice of this project's to confirm.
        needsConfirm: pinned === null && unconfirmed.has(modelNameKey(name)),
        pinned,
      };
    }),
  };
};

const providerDeps = (ctx: Pick<Context, "deps">): ProviderDeps => ({ db: ctx.deps.db, audit: ctx.deps.ports.audit, jobs: ctx.deps.ports.jobs, clock: ctx.deps.ports.clock });

const modeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("default") }),
  z.strictObject({ kind: z.literal("own"), providerIds: z.array(providerIdSchema).max(100) }),
]);

/** The list a mode would give the project: the default's, or the providers named. */
const listOfMode = async (db: Db, organizationId: OrganizationId, mode: z.infer<typeof modeSchema>): Promise<readonly ProviderId[]> => {
  if (mode.kind === "own") {
    return [...new Set(mode.providerIds)];
  }
  const fallback = await loadProviderList(db, organizationId, null);
  return fallback?.list ?? [];
};

const requireAdmin = (scope: MemberScope): void => {
  if (scope.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only an organization admin changes a project's providers" });
  }
};

export const projectProviderProcedures = {
  /** Which providers serve the project, and which serves each model: anyone who can open it. */
  providers: projectProcedure("read", z.strictObject({ projectId: projectIdSchema }))
    .output(projectProvidersViewSchema)
    .query(async ({ ctx, input }) => loadProjectProviders(ctx.deps.db, ctx.scope.organizationId, input.projectId, await modelLogos(ctx.deps.catalog))),

  /** What a save would do (organization admins): every model whose provider changes. Reads only. */
  previewProviders: projectProcedure("read", z.strictObject({ projectId: projectIdSchema, mode: modeSchema }))
    .output(providerPlanViewSchema)
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.scope);
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const state = await loadProviderList(db, organizationId, input.projectId);
      if (state === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such project" });
      }
      const after = await listOfMode(db, organizationId, input.mode);
      const preview = unwrap(await previewProviderChange(db, ctx.scope, { projectId: input.projectId, providerIds: after }), { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND" });
      return planView(db, organizationId, preview.plan, listVersion(state), { projectIds: [input.projectId], before: state.list, after, logos: await modelLogos(ctx.deps.catalog) });
    }),

  /** Saves the mode and the list, when the list is still as the preview read it (`version`). */
  setProviders: projectProcedure("read", z.strictObject({ projectId: projectIdSchema, mode: modeSchema, version: z.string().max(64) }))
    .output(providerPlanViewSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.scope);
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const state = await loadProviderList(db, organizationId, input.projectId);
      if (state === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such project" });
      }
      if (listVersion(state) !== input.version) {
        throw new TRPCError({ code: "CONFLICT", message: "The project's providers changed since the preview: preview again" });
      }
      const after = await listOfMode(db, organizationId, input.mode);
      const saved = unwrap(await setProjectProviders(providerDeps(ctx), ctx.scope, { projectId: input.projectId, mode: input.mode }), { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND" });
      const now = await loadProviderList(db, organizationId, input.projectId);
      return planView(db, organizationId, saved.plan, now === null ? "" : listVersion(now), { projectIds: [input.projectId], before: state.list, after, logos: await modelLogos(ctx.deps.catalog) });
    }),

  /** The provider that serves one model on the project's own list (organization admins). */
  chooseModelProvider: projectProcedure("read", z.strictObject({ projectId: projectIdSchema, modelId: modelIdSchema }))
    .output(z.object({ modelKey: z.string() }))
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.scope);
      const chosen = unwrap(await chooseModelProvider(providerDeps(ctx), ctx.scope, { projectId: input.projectId, modelId: input.modelId }), {
        forbidden: "FORBIDDEN",
        "not-found": "NOT_FOUND",
        "not-on-list": "BAD_REQUEST",
        "follows-default": "PRECONDITION_FAILED",
      });
      return { modelKey: chosen.modelKey };
    }),
};
