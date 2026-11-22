import { readFile } from "node:fs/promises";

import { adapterError, ok, parseVendor, silentLogger } from "@ostra/adapter-sdk";
import type { AdapterResult, CatalogEntry, CatalogMatch, CatalogMatchEndpoint, EndpointModel, Logger } from "@ostra/adapter-sdk";
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
  // 2026-11-22: the provider's own base URL, which tells which provider serves an endpoint. Read
  // loosely: anything but a string is ignored, never the catalog.
  api: z.unknown().optional(),
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

/** The catalog's order: first-party providers first, then by provider ID. */
const byCatalogOrder = (a: string, b: string): number => providerRank(a) - providerRank(b) || a.localeCompare(b);

/**
 * Vendor prefixes aggregators put on a lab's model IDs (`x-ai/grok-4`) that aren't the lab's
 * models.dev provider ID (`xai`). Any other prefix is read as the provider ID itself.
 */
const LAB_PREFIXES: ReadonlyMap<string, string> = new Map([
  ["x-ai", "xai"],
  ["z-ai", "zai"],
  ["zai-org", "zai"],
  ["deepseek-ai", "deepseek"],
  ["mistralai", "mistral"],
  ["meta-llama", "meta"],
  ["qwen", "alibaba"],
]);

/** The lab a model ID names by its vendor prefix (`deepseek/x` → `deepseek`), or `null` for a bare ID. */
const labOf = (modelId: string): string | null => {
  const slash = modelId.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const prefix = modelId.slice(0, slash).trim().toLowerCase();
  return LAB_PREFIXES.get(prefix) ?? prefix;
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

/** A provider's `api` when it's an http(s) URL; anything else says nothing. */
const providerApiOf = (api: unknown): string | null => {
  if (typeof api !== "string") {
    return null;
  }
  try {
    const url = new URL(api);
    return url.protocol === "https:" || url.protocol === "http:" ? api : null;
  } catch {
    return null;
  }
};

/** Every model of the catalog as an entry, first-party providers first, then by provider ID. */
export const catalogEntries = (catalog: ModelsDevCatalog, options: CatalogEntriesOptions = {}): readonly CatalogEntry[] => {
  const entries: CatalogEntry[] = [];
  let refused = 0;
  const providerIds = Object.keys(catalog).sort(byCatalogOrder);
  for (const providerId of providerIds) {
    const provider = catalog[providerId];
    if (provider === undefined) {
      continue;
    }
    const api = providerApiOf(provider.api);
    for (const model of Object.values(provider.models)) {
      // An aggregator's `vendor/model` shows its lab's logo when the catalog has that lab (2026-11-22).
      const lab = labOf(model.id);
      const logoProvider = lab !== null && Object.hasOwn(catalog, lab) ? lab : providerId;
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
        logoPath: logoPathFor(logoProvider),
        reasoning: reasoning ?? noReasoning,
        reasoningPriceDiffers: reasoningPriceDiffers(model.cost),
        inputModalities: inputModalitiesFromCatalog(model),
        ...(api === null ? {} : { providerApi: api }),
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

// ---------- which provider serves an endpoint (2026-11-22, ADR 0033) ----------

/**
 * API hosts of models.dev providers, by host name: the providers whose entry gives no `api`
 * (Anthropic's, OpenAI's and the others with an SDK of their own), and the busiest of those that
 * do, for the bundled copy, which kept no `api` before 2026-11-22. Any other host is known only by
 * its provider's `api`.
 */
const KNOWN_HOSTS: ReadonlyMap<string, string> = new Map([
  ["openrouter.ai", "openrouter"],
  ["api.anthropic.com", "anthropic"],
  ["api.openai.com", "openai"],
  ["generativelanguage.googleapis.com", "google"],
  ["api.deepseek.com", "deepseek"],
  ["api.mistral.ai", "mistral"],
  ["api.x.ai", "xai"],
  ["api.moonshot.ai", "moonshotai"],
  ["api.z.ai", "zai"],
  ["api.groq.com", "groq"],
  ["api.together.xyz", "togetherai"],
  ["api.deepinfra.com", "deepinfra"],
  ["api.fireworks.ai", "fireworks-ai"],
  ["api.cerebras.ai", "cerebras"],
  ["api.perplexity.ai", "perplexity"],
  ["api.cohere.com", "cohere"],
  ["api.cohere.ai", "cohere"],
  ["ai-gateway.vercel.sh", "vercel"],
]);

/** A URL's host name and path as matching compares them: lowercase, no `www.`, no trailing slash. */
const placeOf = (url: string): { readonly host: string; readonly path: string } | null => {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, ""),
      path: parsed.pathname.toLowerCase().replace(/\/+$/, ""),
    };
  } catch {
    return null;
  }
};

/** Whether one path holds the other, segment by segment (`/api` holds `/api/v1`). */
const pathsMeet = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** The models.dev provider an entry is listed under: its catalog ID's first segment. */
const providerIdOf = (entry: CatalogEntry): string => {
  const slash = entry.catalogId.indexOf("/");
  return slash <= 0 ? "" : entry.catalogId.slice(0, slash);
};

/** The model ID an entry's provider lists it under: its catalog ID after the provider. */
const modelIdOf = (entry: CatalogEntry): string => {
  const providerId = providerIdOf(entry);
  return providerId === "" ? entry.catalogId : entry.catalogId.slice(providerId.length + 1);
};

/**
 * The models.dev providers that may be serving a base URL, most likely first: the one whose `api`
 * is that URL, one whose `api` holds it or sits within it on the same host, the provider of a
 * well-known host, then any other provider on the same host. Empty for a host the catalog doesn't
 * know: a self-hosted server, a proxy, a gateway of the organization's own.
 */
export const servingProviders = (baseUrl: string, catalog: readonly CatalogEntry[]): readonly string[] => {
  const endpoint = placeOf(baseUrl);
  if (endpoint === null || endpoint.host === "") {
    return [];
  }
  const tiers = new Map<string, number>();
  const offer = (providerId: string, tier: number): void => {
    const known = tiers.get(providerId);
    if (providerId !== "" && (known === undefined || tier < known)) {
      tiers.set(providerId, tier);
    }
  };
  const apis = new Map<string, string>();
  for (const entry of catalog) {
    if (entry.providerApi !== undefined && !apis.has(providerIdOf(entry))) {
      apis.set(providerIdOf(entry), entry.providerApi);
    }
  }
  for (const [providerId, api] of apis) {
    const place = placeOf(api);
    if (place?.host === endpoint.host) {
      offer(providerId, place.path === endpoint.path ? 0 : pathsMeet(place.path, endpoint.path) ? 1 : 3);
    }
  }
  const known = KNOWN_HOSTS.get(endpoint.host);
  if (known !== undefined) {
    offer(known, 2);
  }
  return [...tiers.entries()].sort(([a, x], [b, y]) => x - y || byCatalogOrder(a, b)).map(([providerId]) => providerId);
};

// ---------- matching an endpoint's model IDs to the catalog ----------

/**
 * An entry one of a model's ID variants names, and how specific that variant is (0: the ID
 * itself); or, one level past the last, an entry for the same model under another spelling.
 */
type Candidate = { readonly entry: CatalogEntry; readonly providerId: string; readonly level: number };

/** A model ID with every variant stripped (`deepseek/x-20250101:free` → `x`): the same model, however a provider spells it. */
const normalizedId = (modelId: string): string => idVariants(modelId).at(-1) ?? modelId.trim().toLowerCase();

/** Appends to the list under a key. */
const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const listed = map.get(key);
  if (listed === undefined) {
    map.set(key, [value]);
  } else {
    listed.push(value);
  }
};

/** The most specific variant first, then the catalog's order: first-party providers, then by provider ID. */
const byPreference = (a: Candidate, b: Candidate): number => a.level - b.level || byCatalogOrder(a.providerId, b.providerId);

/**
 * Among candidates in preference order, the best of those whose `inputModalities` most of them
 * agree on; a tie goes to the group holding the most preferred candidate. Entries that say nothing
 * don't vote. `undefined` when none says.
 */
const agreedOf = (candidates: readonly Candidate[]): Candidate | undefined => {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const inputs = candidate.entry.inputModalities;
    if (inputs !== null) {
      const key = inputs.join("+");
      groups.set(key, [...(groups.get(key) ?? []), candidate]);
    }
  }
  // Groups are in the order of their best candidate, so a later group must outnumber to win.
  let agreed: readonly Candidate[] = [];
  for (const group of groups.values()) {
    if (group.length > agreed.length) {
      agreed = group;
    }
  }
  return agreed[0];
};

/**
 * Matches each model to a catalog entry, or marks it custom. Pure: no call. 2026-11-22 (ADR 0033):
 * the entry is, in order,
 * 1. the serving provider's own (`servingProviders` of the endpoint's base URL), when it lists the model;
 * 2. else the lab's own: the provider the ID's vendor prefix names (`deepseek/…`), or, for a bare ID,
 *    a first-party provider's;
 * 3. else the one most of the catalog's entries for the model (by its ID with every variant
 *    stripped) agree with on its inputs, a tie going to the catalog's order (first-party providers,
 *    then by provider ID). Never merely the first.
 *
 * A model none of its ID variants names is custom, as before. The match's inputs are the serving
 * provider's entry's, then the endpoint's own list's, then the chosen entry's, then what most
 * entries agree on. A custom model keeps the endpoint's list's.
 */
export const matchModelsToCatalog = (
  models: readonly EndpointModel[],
  catalog: readonly CatalogEntry[],
  endpoint: CatalogMatchEndpoint,
): readonly CatalogMatch[] => {
  const byAlias = new Map<string, CatalogEntry[]>();
  const byModel = new Map<string, CatalogEntry[]>();
  for (const entry of catalog) {
    for (const alias of new Set([entry.catalogId, ...entry.aliases].map((id) => id.toLowerCase()))) {
      push(byAlias, alias, entry);
    }
    push(byModel, normalizedId(modelIdOf(entry)), entry);
  }
  const serving = servingProviders(endpoint.baseUrl, catalog);
  return models.map((model): CatalogMatch => {
    const listed = model.inputModalities ?? null;
    const seen = new Set<CatalogEntry>();
    const candidates: Candidate[] = [];
    const offer = (entry: CatalogEntry, level: number): void => {
      if (!seen.has(entry)) {
        seen.add(entry);
        candidates.push({ entry, providerId: providerIdOf(entry), level });
      }
    };
    const variants = idVariants(model.endpointModelId);
    variants.forEach((variant, level) => {
      for (const entry of byAlias.get(variant) ?? []) {
        offer(entry, level);
      }
    });
    if (candidates.length === 0) {
      return { endpointModelId: model.endpointModelId, match: listed === null ? { kind: "custom" } : { kind: "custom", inputModalities: listed } };
    }
    for (const entry of byModel.get(normalizedId(model.endpointModelId)) ?? []) {
      offer(entry, variants.length);
    }
    candidates.sort(byPreference);
    const [first] = candidates;
    if (first === undefined) {
      return { endpointModelId: model.endpointModelId, match: { kind: "custom" } };
    }
    const own = serving.map((providerId) => candidates.find((candidate) => candidate.providerId === providerId)).find((candidate) => candidate !== undefined);
    const lab = labOf(model.endpointModelId);
    // A bare ID's lab is a first-party provider that lists the ID itself, never another spelling's.
    const labs =
      lab === null
        ? candidates.find((candidate) => candidate.level < variants.length && providerRank(candidate.providerId) < FIRST_PARTY.length)
        : candidates.find((candidate) => candidate.providerId === lab);
    const agreed = agreedOf(candidates);
    const chosen = own ?? labs ?? agreed ?? first;
    const inputs =
      own === undefined
        ? (listed ?? chosen.entry.inputModalities ?? agreed?.entry.inputModalities ?? null)
        : (own.entry.inputModalities ?? listed ?? agreed?.entry.inputModalities ?? null);
    return { endpointModelId: model.endpointModelId, match: { kind: "catalog", entry: { ...chosen.entry, inputModalities: inputs } } };
  });
};
