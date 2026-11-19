import { readFile } from "node:fs/promises";

import { adapterError, ok, parseVendor } from "@ostra/adapter-sdk";
import type { AdapterResult, CatalogEntry, CatalogMatch, EndpointModel } from "@ostra/adapter-sdk";
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
  cost: z.looseObject({ input: number, output: number, cache_read: number, cache_write: number }).nullish(),
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

/** Every model of the catalog as an entry, first-party providers first, then by provider ID. */
export const catalogEntries = (catalog: ModelsDevCatalog): readonly CatalogEntry[] => {
  const entries: CatalogEntry[] = [];
  const providerIds = Object.keys(catalog).sort((a, b) => providerRank(a) - providerRank(b) || a.localeCompare(b));
  for (const providerId of providerIds) {
    const provider = catalog[providerId];
    if (provider === undefined) {
      continue;
    }
    for (const model of Object.values(provider.models)) {
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
      });
    }
  }
  return entries;
};

/** Parses a catalog the server fetched. A copy that doesn't match is refused, and the bundled one stays. */
export const parseModelsDevCatalog = (raw: unknown): AdapterResult<readonly CatalogEntry[]> => {
  const parsed = parseVendor(modelsDevCatalogSchema, raw, "the models.dev catalog");
  if (!parsed.ok) {
    return parsed;
  }
  const entries = catalogEntries(parsed.value);
  return entries.length === 0 ? adapterError("invalid-response", "the models.dev catalog has no models") : ok(entries);
};

/** The copy bundled with the package, and the date it was fetched. */
export const loadBundledCatalog = async (): Promise<{ readonly fetchedAt: string; readonly entries: readonly CatalogEntry[] }> => {
  const text = await readFile(new URL("../catalog/models-dev.json", import.meta.url), "utf8");
  const bundled = bundledCatalogSchema.parse(JSON.parse(text));
  return { fetchedAt: bundled.fetchedAt, entries: catalogEntries(bundled.providers) };
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
