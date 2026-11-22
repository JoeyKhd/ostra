import type { ApiFormat, AuthScheme, InputModality, ReasoningControls } from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import type { ModelProviderCapabilities } from "./capabilities.ts";

// The model provider kind (ADR 0025, ADR 0033): any base URL and token, in one of two formats,
// with the models.dev catalog for names, limits and prices. No test, default or spike assumes a
// provider (Q106).

/** An endpoint and its token. The token is never logged. */
export type ModelEndpoint = {
  readonly baseUrl: string;
  readonly token: string;
  /** Unset: "Test connection" tries both. */
  readonly authScheme?: AuthScheme;
  /** Unset: "Test connection" detects it. */
  readonly apiFormat?: ApiFormat;
};

/** A model as the endpoint lists it. */
export type EndpointModel = {
  readonly endpointModelId: string;
  readonly displayName: string | null;
  readonly contextWindow: number | null;
  /**
   * 2026-11-22 (F-148, ADR 0070): what the model takes as input, when the endpoint's own list says
   * (OpenRouter's `architecture.input_modalities`), in `inputModalitySchema`'s order. Left out when
   * it says nothing.
   */
  readonly inputModalities?: readonly InputModality[];
};

/** What "Test connection" found (F-088). */
export type ConnectionTest = {
  readonly apiFormat: ApiFormat;
  readonly authScheme: AuthScheme;
  readonly models: readonly EndpointModel[];
};

/** One models.dev catalog entry (vendor-owned, parsed loosely by the adapter). */
export type CatalogEntry = {
  readonly catalogId: string;
  readonly name: string;
  /** The IDs and aliases endpoints list it under. */
  readonly aliases: readonly string[];
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  /** US dollars per million tokens. */
  readonly inputPricePerMTok: number | null;
  readonly outputPricePerMTok: number | null;
  /**
   * Milestone 2 (Q163) added the cache-read and cache-write prices; milestone 4 (F-037, ADR 0055)
   * makes all four always present, each `null` when the catalog has none, so spend prices every
   * kind of token the same way.
   */
  readonly cacheReadPricePerMTok: number | null;
  readonly cacheWritePricePerMTok: number | null;
  /** The logo's path on ostra's own server, never the vendor's (F-088). */
  readonly logoPath: string | null;
  /**
   * Milestone 4 (F-137, ADR 0066): the model's reasoning controls in models.dev's v2 shape, from
   * its `reasoning` and `reasoning_options`. `{ supported: false }` when it doesn't reason, or
   * when its entry's controls don't parse.
   */
  readonly reasoning: ReasoningControls;
  /** models.dev lists a `cost.reasoning` that isn't its output price. v1 prices reasoning as output. */
  readonly reasoningPriceDiffers: boolean;
  /**
   * Milestone 9 (F-148, ADR 0070, Q335): what the model takes as input, from models.dev's
   * `modalities.input`, in `inputModalitySchema`'s order, any value ostra doesn't name dropped. `null`
   * when the entry says nothing, which counts as text only.
   */
  readonly inputModalities: readonly InputModality[] | null;
  /**
   * 2026-11-22 (ADR 0033): the base URL models.dev gives for the entry's provider (its `api`), so a
   * match can tell which provider serves an endpoint. Left out when models.dev gives none.
   */
  readonly providerApi?: string;
};

/** Where the models being matched are served from: whose catalog entries are the endpoint's own. */
export type CatalogMatchEndpoint = Pick<ModelEndpoint, "baseUrl">;

export type CatalogMatch = {
  readonly endpointModelId: string;
  /**
   * A catalog match carries the entry as it applies to this endpoint: its `inputModalities` are
   * the best source's (2026-11-22, ADR 0070). A custom model carries the endpoint's own list's,
   * when it says.
   */
  readonly match:
    | { readonly kind: "catalog"; readonly entry: CatalogEntry }
    | { readonly kind: "custom"; readonly inputModalities?: readonly InputModality[] };
};

export abstract class ModelProviderAdapter {
  readonly kind = "model-provider" as const;
  abstract readonly name: string;
  abstract readonly capabilities: ModelProviderCapabilities;

  readonly #context: AdapterContext;
  #plumbing: Plumbing | undefined;

  constructor(context: AdapterContext = defaultAdapterContext) {
    this.#context = context;
  }

  /** Retries, rate budgets, idempotency and the logger, shared by every adapter (ADR 0025). */
  protected get plumbing(): Plumbing {
    this.#plumbing ??= createPlumbing(this.#context, { kind: this.kind, name: this.name });
    return this.#plumbing;
  }

  abstract health(): Promise<HealthReport>;

  /** Lists the endpoint's models and detects its API format and auth scheme. */
  abstract testConnection(endpoint: ModelEndpoint): Promise<AdapterResult<ConnectionTest>>;

  abstract listModels(endpoint: ModelEndpoint & { readonly apiFormat: ApiFormat }): Promise<AdapterResult<readonly EndpointModel[]>>;

  /**
   * Matches each model to a catalog entry, or marks it custom. Pure: no call. A match carries the
   * entry's four prices per million tokens (fresh input, output, cache read, cache write) as the
   * catalog has them, each `null` where it has none (milestone 4, F-037). 2026-11-22: `endpoint`
   * says which provider serves the models, so its own entry for a model is the one matched, with
   * that provider's prices, limits, reasoning and inputs (ADR 0033).
   */
  abstract matchCatalog(models: readonly EndpointModel[], catalog: readonly CatalogEntry[], endpoint: CatalogMatchEndpoint): readonly CatalogMatch[];
}
