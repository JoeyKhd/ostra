import { readFile } from "node:fs/promises";

import { adapterError, ok, parseVendor, silentLogger } from "@ostra/adapter-sdk";
import type { AdapterResult, CatalogEntry, CatalogMatch, EndpointModel, Logger } from "@ostra/adapter-sdk";
import { EFFORT_SCALE, effortScaleLevelSchema, inputModalitySchema, noReasoning, reasoningControlsSchema } from "@ostra/protocol";
import type { EffortScaleLevel, InputModality, ReasoningControls } from "@ostra/protocol";
import { z } from "zod";

// The models.dev catalog (ADR 0033): names, limits and prices for the models an endpoint lists.
// models.dev owns the format, so every object tolerates unknown fields. ostra keeps a bundled copy
// (`catalog/models-dev.json`, with its fetch date), the server fetches a fresh one daily, and one
// setting turns the fetch off. The agent never fetches it.

const number = z.number().nullish();

const modelsDevModelSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().nullish(),
  tool_call: z.boolean().nullish(),
  limit: z.looseObject({ context: number, output: number }).nullish(),
  // F-137: `cost.reasoning` is read loosely, so a malformed one costs the reasoning price alone.
  cost: z.looseObject({ input: number, output: number, cache_read: number, cache_write: number, reasoning: z.unknown().optional() }).nullish(),
  // F-137: `reasoning` and `reasoning_options` are read loosely here and parsed per model
  // (`reasoningOf`), so a malformed entry loses its reasoning alone, never the catalog.
  reasoning: z.unknown().optional(),
  reasoning_options: z.unknown().optional(),
  // F-148 (ADR 0070, Q335): `modalities` is read loosely too and parsed per model (`inputModalitiesFromCatalog`).
  modalities: z.unknown().optional(),
});

const modelsDevProviderSchema = z.looseObject({
  id: z.string().nullish(),
  name: z.string().nullish(),
  npm: z.string().nullish(),
  models: z.record(z.string(), modelsDevModelSchema),
});

/** `https://models.dev/api.json`: providers by ID, each with its models by ID. */
export const modelsDevCatalogSchema = z.record(z.string(), modelsDevProviderSchema);
export type ModelsDevCatalog = z.infer<typeof modelsDevCatalogSchema>;

/** The bundled copy: the same providers, trimmed, with where and when they came from. */
export const bundledCatalogSchema = z.strictObject({
  source: z.string().min(1),
  fetchedAt: z.iso.datetime(),
  providers: modelsDevCatalogSchema,
});
export type BundledCatalog = z.infer<typeof bundledCatalogSchema>;

/** Providers whose own listing of a model is the one to show when several providers carry it. */
const FIRST_PARTY = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "mistral",
  "xai",
  "moonshotai",
  "zai",
  "alibaba",
  "meta",
  "cohere",
  "perplexity",
] as const;

const providerRank = (providerId: string): number => {
  const index = FIRST_PARTY.findIndex((first) => first === providerId);
  return index === -1 ? FIRST_PARTY.length : index;
};

/** Where ostra's server serves a provider's logo from. The vendor's own server is never linked. */
export const logoPathFor = (providerId: string): string => `/model-logos/${encodeURIComponent(providerId)}.svg`;

const finite = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

// ---------- reasoning controls (F-137, ADR 0066; research `opencode-reasoning-effort.md`, 1.2 and 2.1) ----------

const KNOWN_CONTROLS: readonly string[] = ["toggle", "effort", "budget_tokens"];

/** models.dev's v1 `reasoning_options`: a list of controls. A control type ostra doesn't know is skipped. */
const reasoningOptionsSchema = z.array(
  z.union([
    z.looseObject({ type: z.literal("toggle") }),
    // `null`, `"null"` and `default` are values models.dev lists that send no effort: dropped.
    z.looseObject({ type: z.literal("effort"), values: z.array(z.union([effortScaleLevelSchema, z.literal("default"), z.literal("null"), z.null()])) }),
    z.looseObject({ type: z.literal("budget_tokens"), min: z.number().int().positive().nullish(), max: z.number().int().positive().nullish() }),
    z.looseObject({ type: z.string().refine((type) => !KNOWN_CONTROLS.includes(type)) }),
  ]),
);

/**
 * One model's controls in models.dev's v2 shape: the conversion OpenCode makes from v1 (research
 * section 1.2). `undefined` when they don't parse: the caller counts it and keeps the rest of the model.
 */
export const reasoningOf = (model: { readonly reasoning?: unknown; readonly reasoning_options?: unknown }): ReasoningControls | undefined => {
  if (model.reasoning !== true) {
    return model.reasoning === false || model.reasoning === undefined || model.reasoning === null ? noReasoning : undefined;
  }
  if (model.reasoning_options === undefined || model.reasoning_options === null) {
    return { supported: true };
  }
  const options = reasoningOptionsSchema.safeParse(model.reasoning_options);
  if (!options.success) {
    return undefined;
  }
  let toggle = false;
  const effort = new Set<EffortScaleLevel>();
  let budget: { min?: number; max?: number } | undefined;
  for (const option of options.data) {
    if (option.type === "toggle") {
      toggle = true;
    } else if (option.type === "effort") {
      const values: readonly unknown[] = "values" in option && Array.isArray(option.values) ? option.values : [];
      for (const value of values) {
        const level = effortScaleLevelSchema.safeParse(value);
        if (level.success) effort.add(level.data);
      }
    } else if (option.type === "budget_tokens") {
      const bounds = z.looseObject({ min: z.number().nullish(), max: z.number().nullish() }).parse(option);
      budget = { ...(typeof bounds.min === "number" ? { min: bounds.min } : {}), ...(typeof bounds.max === "number" ? { max: bounds.max } : {}) };
    }
  }
  const levels = EFFORT_SCALE.filter((level) => effort.has(level));
  const controls = reasoningControlsSchema.safeParse({
    supported: true,
    ...(toggle ? { toggle: true } : {}),
    ...(levels.length > 0 ? { effort: levels } : {}),
    ...(budget === undefined ? {} : { budget }),
  });
  return controls.success ? controls.data : undefined;
};

/** models.dev lists a reasoning price that isn't the output price (v1 prices reasoning as output). */
const reasoningPriceDiffers = (cost: { readonly output?: number | null | undefined; readonly reasoning?: unknown } | null | undefined): boolean => {
  const reasoning = finite(typeof cost?.reasoning === "number" ? cost.reasoning : null);
  return reasoning !== null && reasoning !== finite(cost?.output);
};

// ---------- input modalities (F-148, ADR 0070, Q335; research `attachments-for-agents.md` §1) ----------

const modalitiesSchema = z.looseObject({ input: z.array(z.unknown()) });

/**
 * What a model takes as input, from models.dev's `modalities.input`: the values ostra names, in
 * `inputModalitySchema`'s order, each once, anything else dropped. `null` when the entry has no
 * `modalities`, or no list in it: nobody said, which counts as text only.
 */
export const inputModalitiesFromCatalog = (model: { readonly modalities?: unknown }): readonly InputModality[] | null => {
  const parsed = modalitiesSchema.safeParse(model.modalities);
  if (!parsed.success) {
    return null;
  }
  const listed = new Set(parsed.data.input.flatMap((value) => {
    const modality = inputModalitySchema.safeParse(value);
    return modality.success ? [modality.data] : [];
  }));
  return inputModalitySchema.options.filter((modality) => listed.has(modality));
};

export type CatalogEntriesOptions = {
  /** Where the count of entries whose reasoning was refused goes. Never an entry's text. */
  readonly logger?: Logger;
};

/** Every model of the catalog as an entry, first-party providers first, then by provider ID. */
export const catalogEntries = (catalog: ModelsDevCatalog, options: CatalogEntriesOptions = {}): readonly CatalogEntry[] => {
  const entries: CatalogEntry[] = [];
  let refused = 0;
  const providerIds = Object.keys(catalog).sort((a, b) => providerRank(a) - providerRank(b) || a.localeCompare(b));
  for (const providerId of providerIds) {
    const provider = catalog[providerId];
    if (provider === undefined) {
      continue;
    }
    for (const model of Object.values(provider.models)) {
      const reasoning = reasoningOf(model);
      if (reasoning === undefined) {
        refused += 1;
      }
      entries.push({
        catalogId: `${providerId}/${model.id}`,
        name: model.name ?? model.id,
        aliases: [model.id, `${providerId}/${model.id}`],
        contextWindow: finite(model.limit?.context),
        maxOutputTokens: finite(model.limit?.output),
        inputPricePerMTok: finite(model.cost?.input),
        outputPricePerMTok: finite(model.cost?.output),
        cacheReadPricePerMTok: finite(model.cost?.cache_read),
        cacheWritePricePerMTok: finite(model.cost?.cache_write),
        logoPath: logoPathFor(providerId),
        reasoning: reasoning ?? noReasoning,
        reasoningPriceDiffers: reasoningPriceDiffers(model.cost),
        inputModalities: inputModalitiesFromCatalog(model),
      });
    }
  }
  if (refused > 0) {
    (options.logger ?? silentLogger).warn("catalog.reasoning-refused", { entries: refused });
  }
  return entries;
};

/** Parses a catalog the server fetched. A copy that doesn't match is refused, and the bundled one stays. */
export const parseModelsDevCatalog = (raw: unknown, options: CatalogEntriesOptions = {}): AdapterResult<readonly CatalogEntry[]> => {
  const parsed = parseVendor(modelsDevCatalogSchema, raw, "the models.dev catalog");
  if (!parsed.ok) {
    return parsed;
  }
  const entries = catalogEntries(parsed.value, options);
  return entries.length === 0 ? adapterError("invalid-response", "the models.dev catalog has no models") : ok(entries);
};

/** The copy bundled with the package, and the date it was fetched. */
export const loadBundledCatalog = async (
  options: CatalogEntriesOptions = {},
): Promise<{ readonly fetchedAt: string; readonly entries: readonly CatalogEntry[] }> => {
  const text = await readFile(new URL("../catalog/models-dev.json", import.meta.url), "utf8");
  const bundled = bundledCatalogSchema.parse(JSON.parse(text));
  return { fetchedAt: bundled.fetchedAt, entries: catalogEntries(bundled.providers, options) };
};

// ---------- matching an endpoint's model IDs to the catalog ----------

const DATE_SUFFIX = /[-@](?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * The IDs an endpoint's model ID may stand for, most specific first: the ID itself, without a
 * `:variant` tag (`:free`), without a `vendor/` prefix (aggregators), and without a date suffix
 * (`-20250929`). Everything is lowercase.
 */
export const idVariants = (endpointModelId: string): readonly string[] => {
  const variants: string[] = [];
  const add = (id: string): void => {
    const lower = id.trim().toLowerCase();
    if (lower !== "" && !variants.includes(lower)) {
      variants.push(lower);
    }
  };
  const base = endpointModelId.trim();
  const untagged = base.replace(/:[^/:]+$/, "");
  const unprefixed = (id: string): string => id.slice(id.lastIndexOf("/") + 1);
  for (const id of [base, untagged, unprefixed(base), unprefixed(untagged)]) {
    add(id);
  }
  for (const id of [...variants]) {
    add(id.replace(DATE_SUFFIX, ""));
  }
  return variants;
};

/** Matches each model to a catalog entry, or marks it custom. Pure: no call. */
export const matchModelsToCatalog = (
  models: readonly EndpointModel[],
  catalog: readonly CatalogEntry[],
): readonly CatalogMatch[] => {
  // The first entry to claim an alias keeps it: the catalog's order puts first-party providers first.
  const byAlias = new Map<string, CatalogEntry>();
  for (const entry of catalog) {
    for (const alias of [entry.catalogId, ...entry.aliases]) {
      const key = alias.toLowerCase();
      if (!byAlias.has(key)) {
        byAlias.set(key, entry);
      }
    }
  }
  return models.map((model): CatalogMatch => {
    for (const variant of idVariants(model.endpointModelId)) {
      const entry = byAlias.get(variant);
      if (entry !== undefined) {
        return { endpointModelId: model.endpointModelId, match: { kind: "catalog", entry } };
      }
    }
    return { endpointModelId: model.endpointModelId, match: { kind: "custom" } };
  });
};
