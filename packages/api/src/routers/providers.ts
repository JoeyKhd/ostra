import { BUILT_IN_PROFILE_ADAPTER, syncProviderModels, addModelProvider, setModelPrice, setModelReasoningInTx } from "@ostra/domain";
import {
  addModelProviderInputSchema,
  apiFormatSchema,
  authSchemeSchema,
  httpUrlSchema,
  modelIdSchema,
  providerIdSchema,
  reasoningControlsSchema,
} from "@ostra/protocol";
import { mapModel, mapModelProvider } from "@ostra/db";
import type { CatalogEntry, ModelEndpoint } from "@ostra/adapter-sdk";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { loadProviderUses, noUse, providerListProcedures, providerUseSchema } from "./provider-lists.ts";
import { hostOf } from "./project-providers.ts";
import { effortLevelViewSchema, levelsOfModel, reasoningOf, reasoningSourceSchema, toLevelViews } from "../services/agent-effort.ts";
import { adminProcedure, router, unwrap } from "../trpc/init.ts";

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
  /** F-135 (ticket 50): the base URL's host, as the Models page shows a key. */
  host: z.string(),
  apiFormat: apiFormatSchema,
  authScheme: authSchemeSchema,
  sessionsAtOnce: z.number().int().nullable(),
  allowOnPersonalRunners: z.boolean(),
  /** Epoch ms. */
  modelsRefreshedAt: z.number().int().nullable(),
  modelCount: z.number().int(),
  createdAt: z.number().int(),
  // F-135 (ticket 50, ADR 0065): the lists it's on, the projects that use it, its month's spend.
  ...providerUseSchema.shape,
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
  /** Ticket 36 (F-037): the cache prices, where the four came from (`null`: none yet), and when they changed. */
  cacheReadPricePerMTok: z.number().nullable(),
  cacheWritePricePerMTok: z.number().nullable(),
  priceSource: z.enum(["endpoint", "catalog", "admin"]).nullable(),
  priceChangedAt: z.number().nullable(),
  logoPath: z.string().nullable(),
  /**
   * F-137 (ADR 0066): the controls the model runs with (an admin's, else the catalog's, else none),
   * where they came from (`null`: nobody said, so a custom model doesn't reason), the catalog's own
   * beside an override, the levels the agent offers on it, and whether the catalog prices reasoning
   * apart from output (v1 prices it as output).
   */
  reasoning: z.object({
    controls: reasoningControlsSchema,
    source: reasoningSourceSchema,
    catalog: reasoningControlsSchema.nullable(),
    levels: z.array(effortLevelViewSchema),
    reasoningPriceDiffers: z.boolean(),
  }),
});

/** The catalog lists a reasoning price apart from output (ticket 58); a custom model has none. */
const reasoningPriceDiffersOf = (entry: CatalogEntry | undefined): boolean => entry?.reasoningPriceDiffers ?? false;

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
/** An admin's price in dollars per million tokens: the column holds `Decimal(12, 6)`. */
const priceInputSchema = z.number().min(0).max(999_999).nullable();

export const providersRouter = router({
  // F-135 (ticket 50): the default list, its preview, a model's provider on it, the upgrade's choices.
  ...providerListProcedures,

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
    const uses = await loadProviderUses(ctx.deps.db, ctx.scope.organizationId, ctx.deps.ports.clock.now());
    return rows.map((row) => {
      const provider = mapModelProvider(row);
      return {
        ...(uses.get(row.id) ?? noUse),
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        host: hostOf(provider.baseUrl),
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
    .input(
      z.strictObject({
        providerId: providerIdSchema,
        /** F-137: the agent whose levels each model offers. Default: the built-in profile's, OpenCode. */
        adapter: z.string().max(100).optional(),
      }),
    )
    .output(z.array(modelViewSchema))
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.scope.organizationId;
      const provider = await ctx.deps.db.modelProvider.findFirst({ where: { id: input.providerId, organizationId }, select: { id: true, apiFormat: true } });
      if (provider === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such model provider" });
      }
      const [rows, catalog] = await Promise.all([
        ctx.deps.db.model.findMany({ where: { providerId: input.providerId, organizationId }, orderBy: { endpointModelId: "asc" } }),
        ctx.deps.catalog.entries(),
      ]);
      const entries = new Map(catalog.map((entry) => [entry.catalogId, entry] as const));
      const adapter = input.adapter ?? BUILT_IN_PROFILE_ADAPTER;
      return rows.map((row) => {
        const model = mapModel(row);
        const reasoning = reasoningOf(row);
        const entry = model.catalogId === null ? undefined : entries.get(model.catalogId);
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
          cacheReadPricePerMTok: row.cacheReadPricePerMTok === null ? null : row.cacheReadPricePerMTok.toNumber(),
          cacheWritePricePerMTok: row.cacheWritePricePerMTok === null ? null : row.cacheWritePricePerMTok.toNumber(),
          priceSource: row.priceSource,
          priceChangedAt: row.priceChangedAt?.getTime() ?? null,
          logoPath: entry?.logoPath ?? null,
          reasoning: {
            controls: reasoning.controls,
            source: reasoning.source,
            catalog: reasoning.catalog,
            levels: toLevelViews(levelsOfModel(ctx.deps.agentEffort, adapter, { ...row, provider: { apiFormat: provider.apiFormat } })),
            reasoningPriceDiffers: reasoningPriceDiffersOf(entry),
          },
        };
      });
    }),

  /**
   * Edits a custom model: its name, limits and prices. A catalog model takes the catalog's values,
   * except its reasoning (F-137, ADR 0066, Q286): on any model an organization admin sets the
   * controls its endpoint takes, or `null` to go back to the catalog's (none, for a custom model).
   * A catalog refresh never touches them. Each change is an audit entry.
   */
  updateModel: adminProcedure
    .input(
      z.strictObject({
        modelId: modelIdSchema,
        displayName: z.string().trim().min(1).max(200).nullable().optional(),
        contextWindow: z.number().int().positive().max(100_000_000).nullable().optional(),
        maxOutputTokens: z.number().int().positive().max(100_000_000).nullable().optional(),
        inputPricePerMTok: z.number().min(0).max(MAX_PRICE).nullable().optional(),
        outputPricePerMTok: z.number().min(0).max(MAX_PRICE).nullable().optional(),
        reasoning: reasoningControlsSchema.nullable().optional(),
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
        const { reasoning } = input;
        const editsFields = [input.displayName, input.contextWindow, input.maxOutputTokens, input.inputPricePerMTok, input.outputPricePerMTok].some(
          (value) => value !== undefined,
        );
        if (model.catalogId !== null && editsFields) {
          throw new TRPCError({ code: "CONFLICT", message: "A catalog model takes the catalog's values: only its reasoning is edited" });
        }
        if (reasoning !== undefined) {
          const set = await setModelReasoningInTx(ports, tx, ctx.scope, { modelId: input.modelId, controls: reasoning });
          unwrap(set, { "not-found": "NOT_FOUND", forbidden: "FORBIDDEN" });
        }
        if (!editsFields) {
          return { id: input.modelId };
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

  /**
   * F-037 (ticket 27; ADR 0055): an organization admin's four prices for a model, in dollars per
   * million tokens, each `null` when unknown. They apply from now on: spend already counted keeps
   * its price. The source is then `admin`.
   */
  setModelPrice: adminProcedure
    .input(
      z.strictObject({
        modelId: modelIdSchema,
        inputPerMTok: priceInputSchema,
        outputPerMTok: priceInputSchema,
        cacheReadPerMTok: priceInputSchema,
        cacheWritePerMTok: priceInputSchema,
      }),
    )
    .output(z.object({ priceChangedAt: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const micro = (dollars: number | null): number | null => (dollars === null ? null : Math.round(dollars * 1_000_000));
      const saved = await setModelPrice({ db, audit: ports.audit, clock: ports.clock, notices: ports.notices }, ctx.scope, {
        modelId: input.modelId,
        inputPerMTok: micro(input.inputPerMTok),
        outputPerMTok: micro(input.outputPerMTok),
        cacheReadPerMTok: micro(input.cacheReadPerMTok),
        cacheWritePerMTok: micro(input.cacheWritePerMTok),
      });
      const result = unwrap(saved, { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "invalid-input": "BAD_REQUEST" });
      return { priceChangedAt: result.priceChangedAt };
    }),
});
