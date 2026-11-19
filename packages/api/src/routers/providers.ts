import { syncProviderModels, addModelProvider } from "@ostra/domain";
import {
  addModelProviderInputSchema,
  apiFormatSchema,
  authSchemeSchema,
  httpUrlSchema,
  modelIdSchema,
  providerIdSchema,
} from "@ostra/protocol";
import { apiFormatFromDb, mapModel, mapModelProvider } from "@ostra/db";
import type { CatalogEntry, ModelEndpoint } from "@ostra/adapter-sdk";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { adminProcedure, memberProcedure, router, unwrap } from "../trpc/init.ts";

// F-088, F-014 (allow on personal runners), ticket 31: model providers. Admin only, organization
// scoped, with an audit entry for each change. No procedure returns a token or its secret
// reference: every output is built field by field, then parsed by its output schema.

/** An endpoint's URL, without credentials in it: the token has its own field and the secret store. */
const endpointUrlSchema = httpUrlSchema.refine((value) => {
  const url = new URL(value);
  return url.username === "" && url.password === "";
}, "put the token in its own field, not in the URL");

const createProviderInputSchema = addModelProviderInputSchema.extend({ baseUrl: endpointUrlSchema });

const catalogMatchViewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("catalog"),
    catalogId: z.string(),
    name: z.string(),
    contextWindow: z.number().nullable(),
    maxOutputTokens: z.number().nullable(),
    inputPricePerMTok: z.number().nullable(),
    outputPricePerMTok: z.number().nullable(),
    /** A path on ostra's own server, never the vendor's (ADR 0021). */
    logoPath: z.string().nullable(),
  }),
  z.object({ kind: z.literal("custom") }),
]);

const testedModelSchema = z.object({
  endpointModelId: z.string(),
  displayName: z.string().nullable(),
  contextWindow: z.number().nullable(),
  match: catalogMatchViewSchema,
});

const testConnectionResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    apiFormat: apiFormatSchema,
    authScheme: authSchemeSchema,
    models: z.array(testedModelSchema),
  }),
  z.object({ ok: z.literal(false), reason: z.string(), message: z.string() }),
]);

const providerViewSchema = z.object({
  id: providerIdSchema,
  name: z.string(),
  baseUrl: z.string(),
  apiFormat: apiFormatSchema,
  authScheme: authSchemeSchema,
  sessionsAtOnce: z.number().int().nullable(),
  allowOnPersonalRunners: z.boolean(),
  /** Epoch ms. */
  modelsRefreshedAt: z.number().int().nullable(),
  modelCount: z.number().int(),
  createdAt: z.number().int(),
});

const modelViewSchema = z.object({
  id: modelIdSchema,
  endpointModelId: z.string(),
  displayName: z.string().nullable(),
  /** The models.dev entry it matched, or `null` for a custom model (editable). */
  catalogId: z.string().nullable(),
  custom: z.boolean(),
  listed: z.boolean(),
  contextWindow: z.number().int().nullable(),
  maxOutputTokens: z.number().int().nullable(),
  inputPricePerMTok: z.number().nullable(),
  outputPricePerMTok: z.number().nullable(),
  logoPath: z.string().nullable(),
});

const toCatalogView = (entry: CatalogEntry) => ({
  kind: "catalog" as const,
  catalogId: entry.catalogId,
  name: entry.name,
  contextWindow: entry.contextWindow,
  maxOutputTokens: entry.maxOutputTokens,
  inputPricePerMTok: entry.inputPricePerMTok,
  outputPricePerMTok: entry.outputPricePerMTok,
  logoPath: entry.logoPath,
});

const MAX_PRICE = 1_000_000;

export const providersRouter = router({
  /**
   * "Test connection": lists the endpoint's models, detects its API format and auth scheme, and
   * matches each model to the catalog. The token is used for this call and returned nowhere.
   */
  testConnection: adminProcedure
    .input(
      z.strictObject({
        baseUrl: endpointUrlSchema,
        token: z.string().min(1).max(65_536),
        /** Unset: both are tried. */
        authScheme: authSchemeSchema.optional(),
        apiFormat: apiFormatSchema.optional(),
      }),
    )
    .output(testConnectionResultSchema)
    .mutation(async ({ ctx, input }) => {
      const { ports, logger } = ctx.deps;
      const endpoint: ModelEndpoint = {
        baseUrl: input.baseUrl,
        token: input.token,
        ...(input.authScheme === undefined ? {} : { authScheme: input.authScheme }),
        ...(input.apiFormat === undefined ? {} : { apiFormat: input.apiFormat }),
      };
      const tested = await ports.adapters.modelProvider.testConnection(endpoint);
      // The endpoint's address can carry a hostname someone chose to keep private: log the outcome only.
      logger.info("provider.test_connection", { organizationId: ctx.scope.organizationId, ok: tested.ok });
      if (!tested.ok) {
        return { ok: false as const, reason: tested.error.code, message: tested.error.message };
      }
      const catalog = await ctx.deps.catalog.entries();
      const matches = ports.adapters.modelProvider.matchCatalog(tested.value.models, catalog);
      const matchById = new Map(matches.map((match) => [match.endpointModelId, match.match] as const));
      return {
        ok: true as const,
        apiFormat: tested.value.apiFormat,
        authScheme: tested.value.authScheme,
        models: tested.value.models.map((model) => {
          const match = matchById.get(model.endpointModelId);
          return {
            endpointModelId: model.endpointModelId,
            displayName: model.displayName,
            contextWindow: model.contextWindow,
            match: match?.kind === "catalog" ? toCatalogView(match.entry) : { kind: "custom" as const },
          };
        }),
      };
    }),

  /** Adds a provider: the token goes to the secret store, the form's format may override the detected one. */
  create: adminProcedure
    .input(createProviderInputSchema)
    .output(z.object({ providerId: providerIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      // The endpoint is tried inside the transaction, which can take a while: a longer timeout.
      const added = await db.$transaction(
        (tx) => addModelProvider({ tx, scope: ctx.scope, ...ports }, input),
        { timeout: 60_000, maxWait: 10_000 },
      );
      const result = unwrap(added, { forbidden: "FORBIDDEN", "name-taken": "CONFLICT", "connection-failed": "BAD_REQUEST" });
      // Match the models to the catalog now, so the admin sees them at once. The refresh job retries it.
      const synced = await syncProviderModels(
        { db, notices: ports.notices, clock: ports.clock, adapters: ports.adapters, catalog: () => ctx.deps.catalog.entries() },
        { organizationId: ctx.scope.organizationId, providerId: result.providerId },
      );
      if (!synced.ok) {
        ctx.deps.logger.warn("provider.initial_sync_failed", { providerId: result.providerId, error: synced.error });
      }
      return { providerId: result.providerId };
    }),

  list: adminProcedure.output(z.array(providerViewSchema)).query(async ({ ctx }) => {
    const rows = await ctx.deps.db.modelProvider.findMany({
      where: { organizationId: ctx.scope.organizationId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { models: { where: { listed: true } } } } },
    });
    return rows.map((row) => {
      const provider = mapModelProvider(row);
      return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiFormat: provider.apiFormat,
        authScheme: provider.authScheme,
        sessionsAtOnce: provider.sessionsAtOnce,
        allowOnPersonalRunners: provider.allowOnPersonalRunners,
        modelsRefreshedAt: provider.modelsRefreshedAt === null ? null : provider.modelsRefreshedAt.getTime(),
        modelCount: row._count.models,
        createdAt: provider.createdAt.getTime(),
      };
    });
  }),

  /** The sessions-at-once cap and "allow on personal runners" (off by default, F-014, Q47). */
  update: adminProcedure
    .input(
      z.strictObject({
        providerId: providerIdSchema,
        name: z.string().trim().min(1).max(128).optional(),
        sessionsAtOnce: z.number().int().positive().max(100_000).nullable().optional(),
        allowOnPersonalRunners: z.boolean().optional(),
      }),
    )
    .output(providerViewSchema.pick({ id: true, name: true, sessionsAtOnce: true, allowOnPersonalRunners: true }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      return db.$transaction(async (tx) => {
        const current = await tx.modelProvider.findFirst({ where: { id: input.providerId, organizationId }, select: { id: true } });
        if (current === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "No such model provider" });
        }
        if (input.name !== undefined) {
          const taken = await tx.modelProvider.findFirst({
            where: { organizationId, name: input.name, NOT: { id: input.providerId } },
            select: { id: true },
          });
          if (taken !== null) {
            throw new TRPCError({ code: "CONFLICT", message: "A model provider with that name exists" });
          }
        }
        const updated = await tx.modelProvider.update({
          where: { id: input.providerId },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.sessionsAtOnce === undefined ? {} : { sessionsAtOnce: input.sessionsAtOnce }),
            ...(input.allowOnPersonalRunners === undefined ? {} : { allowOnPersonalRunners: input.allowOnPersonalRunners }),
          },
        });
        await ports.audit.recordInTx(tx, {
          organizationId,
          projectId: null,
          actor: { kind: "member", id: ctx.scope.memberId },
          action: "provider.updated",
          entity: "model-provider",
          entityId: input.providerId,
          data: {
            ...(input.name === undefined ? {} : { renamed: true }),
            ...(input.sessionsAtOnce === undefined ? {} : { sessionsAtOnce: input.sessionsAtOnce }),
            ...(input.allowOnPersonalRunners === undefined ? {} : { allowOnPersonalRunners: input.allowOnPersonalRunners }),
          },
        });
        await ports.notices.emitInTx(tx, { organizationId, projectId: null, entity: "model-provider", entityId: input.providerId });
        const provider = mapModelProvider(updated);
        return {
          id: provider.id,
          name: provider.name,
          sessionsAtOnce: provider.sessionsAtOnce,
          allowOnPersonalRunners: provider.allowOnPersonalRunners,
        };
      });
    }),

  /** Lists the endpoint's models again and matches them to the catalog (the job does the same, daily). */
  refresh: adminProcedure
    .input(z.strictObject({ providerId: providerIdSchema }))
    .output(z.object({ listed: z.number().int(), matched: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const { ports } = ctx.deps;
      const synced = await syncProviderModels(
        {
          db: ctx.deps.db,
          notices: ports.notices,
          clock: ports.clock,
          adapters: ports.adapters,
          catalog: () => ctx.deps.catalog.entries(),
        },
        { organizationId: ctx.scope.organizationId, providerId: input.providerId },
      );
      const result = unwrap(synced, { "not-found": "NOT_FOUND", "secret-unreadable": "INTERNAL_SERVER_ERROR", "endpoint-failed": "BAD_GATEWAY" });
      return { listed: result.listed, matched: result.matched };
    }),

  /** A provider's models, matched to the catalog (with its logo path) or custom (editable). */
  models: adminProcedure
    .input(z.strictObject({ providerId: providerIdSchema }))
    .output(z.array(modelViewSchema))
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.scope.organizationId;
      const provider = await ctx.deps.db.modelProvider.findFirst({ where: { id: input.providerId, organizationId }, select: { id: true } });
      if (provider === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such model provider" });
      }
      const [rows, catalog] = await Promise.all([
        ctx.deps.db.model.findMany({ where: { providerId: input.providerId, organizationId }, orderBy: { endpointModelId: "asc" } }),
        ctx.deps.catalog.entries(),
      ]);
      const logos = new Map(catalog.map((entry) => [entry.catalogId, entry.logoPath] as const));
      return rows.map((row) => {
        const model = mapModel(row);
        return {
          id: model.id,
          endpointModelId: model.endpointModelId,
          displayName: model.displayName,
          catalogId: model.catalogId,
          custom: model.catalogId === null,
          listed: model.listed,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          inputPricePerMTok: model.inputPricePerMTok === null ? null : model.inputPricePerMTok.toNumber(),
          outputPricePerMTok: model.outputPricePerMTok === null ? null : model.outputPricePerMTok.toNumber(),
          logoPath: model.catalogId === null ? null : (logos.get(model.catalogId) ?? null),
        };
      });
    }),

  /** Edits a custom model: its name, limits and prices. A catalog model takes the catalog's values. */
  updateModel: adminProcedure
    .input(
      z.strictObject({
        modelId: modelIdSchema,
        displayName: z.string().trim().min(1).max(200).nullable().optional(),
        contextWindow: z.number().int().positive().max(100_000_000).nullable().optional(),
        maxOutputTokens: z.number().int().positive().max(100_000_000).nullable().optional(),
        inputPricePerMTok: z.number().min(0).max(MAX_PRICE).nullable().optional(),
        outputPricePerMTok: z.number().min(0).max(MAX_PRICE).nullable().optional(),
      }),
    )
    .output(z.object({ id: modelIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      return db.$transaction(async (tx) => {
        const model = await tx.model.findFirst({ where: { id: input.modelId, organizationId }, select: { id: true, catalogId: true, providerId: true } });
        if (model === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "No such model" });
        }
        if (model.catalogId !== null) {
          throw new TRPCError({ code: "CONFLICT", message: "A catalog model takes the catalog's values: only a custom model is edited" });
        }
        await tx.model.update({
          where: { id: model.id },
          data: {
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
            ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
            ...(input.inputPricePerMTok === undefined ? {} : { inputPricePerMTok: input.inputPricePerMTok }),
            ...(input.outputPricePerMTok === undefined ? {} : { outputPricePerMTok: input.outputPricePerMTok }),
          },
        });
        await ports.audit.recordInTx(tx, {
          organizationId,
          projectId: null,
          actor: { kind: "member", id: ctx.scope.memberId },
          action: "model.updated",
          entity: "model",
          entityId: input.modelId,
        });
        await ports.notices.emitInTx(tx, { organizationId, projectId: null, entity: "model-provider", entityId: providerIdSchema.parse(model.providerId) });
        return { id: input.modelId };
      });
    }),
});

const agentProfileViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  adapter: z.string(),
  builtIn: z.boolean(),
  model: z
    .object({
      id: modelIdSchema,
      endpointModelId: z.string(),
      displayName: z.string().nullable(),
      providerId: providerIdSchema,
      providerName: z.string(),
      apiFormat: apiFormatSchema,
    })
    .nullable(),
});

export const agentProfilesRouter = router({
  /** The organization's agent profiles with their models: any member may see what a task would run. */
  list: memberProcedure.output(z.array(agentProfileViewSchema)).query(async ({ ctx }) => {
    const rows = await ctx.deps.db.agentProfile.findMany({
      where: { organizationId: ctx.scope.organizationId },
      orderBy: [{ builtIn: "desc" }, { name: "asc" }],
      include: { model: { include: { provider: { select: { id: true, name: true, apiFormat: true } } } } },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      adapter: row.adapter,
      builtIn: row.builtIn,
      model:
        row.model === null
          ? null
          : {
              id: modelIdSchema.parse(row.model.id),
              endpointModelId: row.model.endpointModelId,
              displayName: row.model.displayName,
              providerId: providerIdSchema.parse(row.model.provider.id),
              providerName: row.model.provider.name,
              apiFormat: apiFormatFromDb[row.model.provider.apiFormat],
            },
    }));
  }),

  /** The model of the built-in OpenCode profile: one of the providers' listed models (F-088). */
  setDefaultModel: adminProcedure
    .input(z.strictObject({ modelId: modelIdSchema }))
    .output(z.object({ profileId: z.string(), modelId: modelIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      return db.$transaction(async (tx) => {
        const model = await tx.model.findFirst({ where: { id: input.modelId, organizationId }, select: { id: true, listed: true, providerId: true } });
        if (model === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "No such model" });
        }
        if (!model.listed) {
          throw new TRPCError({ code: "CONFLICT", message: "The endpoint no longer lists that model" });
        }
        const profile = await tx.agentProfile.findFirst({ where: { organizationId, builtIn: true, adapter: "opencode" }, select: { id: true } });
        if (profile === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "This organization has no built-in OpenCode profile" });
        }
        const profileId = agentProfileIdSchema.parse(profile.id);
        await tx.agentProfile.update({ where: { id: profile.id }, data: { modelId: model.id } });
        await ports.audit.recordInTx(tx, {
          organizationId,
          projectId: null,
          actor: { kind: "member", id: ctx.scope.memberId },
          action: "agent-profile.model-set",
          entity: "agent-profile",
          entityId: profileId,
          data: { modelId: model.id, providerId: model.providerId },
        });
        await ports.notices.emitInTx(tx, { organizationId, projectId: null, entity: "agent-profile", entityId: profileId });
        return { profileId, modelId: input.modelId };
      });
    }),
});
