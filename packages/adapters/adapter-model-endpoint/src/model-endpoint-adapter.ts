import { adapterError, modelAuthHeaders, ModelProviderAdapter, ok, parseVendor } from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterError,
  AdapterResult,
  CatalogEntry,
  CatalogMatch,
  ConnectionTest,
  EndpointModel,
  HealthReport,
  ModelEndpoint,
  ModelProviderCapabilities,
} from "@ostra/adapter-sdk";
import type { ApiFormat, AuthScheme } from "@ostra/protocol";
import { z } from "zod";

import { matchModelsToCatalog } from "./catalog.ts";

// The model provider adapter (ADR 0033, F-088): any base URL and token, in one of two API formats.
// "Test connection" calls `GET <base URL>/models`, finds the format from the answer's shape and
// the auth scheme from what the endpoint accepts, and lists the models. No test, default or code
// path assumes a provider (Q106). Ported from spikes/how-should-the-runner-drive-opencode/src/
// harness/catalog.ts and the probes of its T3.
//
// The token goes in one request header and nowhere else: never in a log line, an error message or
// a URL. Redirects aren't followed, so a token can't be sent on to another host.

export type ModelEndpointAdapterOptions = {
  /** How long one call to the endpoint may take. Default 15 s. */
  readonly timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 10;

const modelItemSchema = z.looseObject({
  id: z.string().min(1),
  object: z.string().optional(),
  type: z.string().optional(),
  display_name: z.string().nullish(),
  name: z.string().nullish(),
  created_at: z.string().optional(),
  context_window: z.number().nullish(),
  context_length: z.number().nullish(),
  max_model_len: z.number().nullish(),
  max_context_length: z.number().nullish(),
});
type ModelItem = z.infer<typeof modelItemSchema>;

const modelListSchema = z.looseObject({
  object: z.string().optional(),
  data: z.array(z.unknown()),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish(),
});

const isPositive = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const toEndpointModel = (item: ModelItem): EndpointModel => {
  const name = item.display_name ?? item.name ?? null;
  const context = [item.context_window, item.context_length, item.max_model_len, item.max_context_length].find(isPositive);
  return {
    endpointModelId: item.id,
    displayName: name !== null && name !== item.id ? name : null,
    contextWindow: context ?? null,
  };
};

/** What the shape of a model list says about the API format, or `undefined` when it says nothing. */
const formatFromShape = (list: z.infer<typeof modelListSchema>): ApiFormat | undefined => {
  const first = list.data.map((item) => modelItemSchema.safeParse(item)).find((parsed) => parsed.success)?.data;
  if (first?.type === "model" || typeof first?.display_name === "string" || typeof first?.created_at === "string") {
    return "anthropic-messages";
  }
  if (list.object === "list" || first?.object === "model") {
    return "openai-compatible";
  }
  return undefined;
};

/** Anthropic's API names itself in its response headers; an OpenAI-compatible one has no such mark. */
const formatFromHeaders = (headers: Headers): ApiFormat | undefined =>
  [...headers.keys()].some((name) => name.startsWith("anthropic-")) ? "anthropic-messages" : undefined;

/** The scheme each format's own API uses: the one tried first when the format is known. */
const defaultScheme = (format: ApiFormat): AuthScheme => (format === "anthropic-messages" ? "x-api-key" : "bearer");

type Probe =
  | { readonly kind: "answer"; readonly status: number; readonly headers: Headers; readonly json: unknown }
  | { readonly kind: "failed"; readonly error: AdapterError };

export class ModelEndpointAdapter extends ModelProviderAdapter {
  readonly name = "model-endpoint";
  readonly capabilities: ModelProviderCapabilities = {
    apiFormats: ["openai-compatible", "anthropic-messages"],
    modelList: true,
    // Both formats report usage in the stream. The key proxy asks OpenAI-compatible endpoints to.
    usageInStream: true,
  };

  readonly #timeoutMs: number;

  constructor(options: ModelEndpointAdapterOptions = {}, context?: AdapterContext) {
    super(context);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  health(): Promise<HealthReport> {
    // No endpoint of its own: each provider's is tested when it's added.
    return Promise.resolve({ status: "ok" });
  }

  async testConnection(endpoint: ModelEndpoint): Promise<AdapterResult<ConnectionTest>> {
    const base = this.#modelsUrl(endpoint.baseUrl);
    if (!base.ok) {
      return base;
    }
    // Unknown scheme: try a bearer token first (OpenAI-compatible), then Anthropic's header.
    const schemes: readonly AuthScheme[] =
      endpoint.authScheme !== undefined
        ? [endpoint.authScheme]
        : endpoint.apiFormat !== undefined
          ? [defaultScheme(endpoint.apiFormat), endpoint.apiFormat === "anthropic-messages" ? "bearer" : "x-api-key"]
          : ["bearer", "x-api-key"];
    let refused: AdapterError | undefined;
    let notAnApi: AdapterError | undefined;
    for (const scheme of schemes) {
      const listed = await this.#list(base.value, scheme, endpoint.token, endpoint.apiFormat);
      if (listed.ok) {
        this.plumbing.logger.info("model-provider.tested", {
          apiFormat: listed.value.apiFormat,
          authScheme: scheme,
          modelCount: listed.value.models.length,
        });
        return ok({ apiFormat: listed.value.apiFormat, authScheme: scheme, models: listed.value.models });
      }
      const { code } = listed.error;
      if (code === "unauthorized" || code === "forbidden") {
        // Another scheme may be the one it wants.
        refused ??= listed.error;
      } else if (code === "invalid-response") {
        notAnApi ??= listed.error;
      } else {
        return listed;
      }
    }
    return { ok: false, error: refused ?? notAnApi ?? { code: "invalid-response", message: "the endpoint did not answer like a model API" } };
  }

  async listModels(
    endpoint: ModelEndpoint & { readonly apiFormat: ApiFormat },
  ): Promise<AdapterResult<readonly EndpointModel[]>> {
    const base = this.#modelsUrl(endpoint.baseUrl);
    if (!base.ok) {
      return base;
    }
    const listed = await this.#list(base.value, endpoint.authScheme ?? defaultScheme(endpoint.apiFormat), endpoint.token, endpoint.apiFormat);
    return listed.ok ? ok(listed.value.models) : listed;
  }

  matchCatalog(models: readonly EndpointModel[], catalog: readonly CatalogEntry[]): readonly CatalogMatch[] {
    return matchModelsToCatalog(models, catalog);
  }

  // ---------- internals ----------

  #modelsUrl(baseUrl: string): AdapterResult<URL> {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return adapterError("invalid-input", "the base URL is not a URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return adapterError("invalid-input", "the base URL must be http or https");
    }
    if (url.username !== "" || url.password !== "") {
      return adapterError("invalid-input", "the base URL must not hold a username or password: the token goes in its own field");
    }
    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
    return ok(url);
  }

  /** The models of an endpoint, in whichever format it speaks, paged. */
  async #list(
    url: URL,
    scheme: AuthScheme,
    token: string,
    given: ApiFormat | undefined,
  ): Promise<AdapterResult<{ readonly apiFormat: ApiFormat; readonly models: readonly EndpointModel[] }>> {
    let apiFormat = given;
    const models: EndpointModel[] = [];
    let pageUrl = url;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const probe = await this.#get(pageUrl, scheme, token);
      if (probe.kind === "failed") {
        return { ok: false, error: probe.error };
      }
      const failure = this.#statusError(probe.status);
      if (failure !== undefined) {
        return failure;
      }
      const list = parseVendor(modelListSchema, probe.json, "the endpoint's model list");
      if (!list.ok) {
        return adapterError("invalid-response", "the endpoint did not answer like a model API: its model list is not a list");
      }
      apiFormat ??=
        formatFromShape(list.value) ?? formatFromHeaders(probe.headers) ?? (scheme === "x-api-key" ? "anthropic-messages" : "openai-compatible");
      for (const raw of list.value.data) {
        const item = modelItemSchema.safeParse(raw);
        if (item.success) {
          models.push(toEndpointModel(item.data));
        }
      }
      // Only Anthropic's list pages, by the last ID it returned.
      const lastId = list.value.last_id;
      if (apiFormat !== "anthropic-messages" || list.value.has_more !== true || typeof lastId !== "string") {
        break;
      }
      pageUrl = new URL(url);
      pageUrl.searchParams.set("limit", "1000");
      pageUrl.searchParams.set("after_id", lastId);
    }
    return ok({ apiFormat: apiFormat ?? "openai-compatible", models });
  }

  #statusError(status: number): AdapterResult<never> | undefined {
    if (status >= 200 && status < 300) {
      return undefined;
    }
    if (status === 401) {
      return adapterError("unauthorized", "the endpoint refused the token");
    }
    if (status === 403) {
      return adapterError("forbidden", "the endpoint refused the token: it may lack a permission");
    }
    if (status === 429) {
      return adapterError("rate-limited", "the endpoint's rate limit was reached");
    }
    if (status >= 300 && status < 400) {
      return adapterError("invalid-response", "the endpoint redirected: redirects aren't followed, so give its final base URL");
    }
    if (status >= 500) {
      return adapterError("unavailable", `the endpoint is failing (HTTP ${String(status)})`);
    }
    return adapterError("invalid-response", `the endpoint did not answer like a model API (HTTP ${String(status)})`);
  }

  async #get(url: URL, scheme: AuthScheme, token: string): Promise<Probe> {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "ostra-model-endpoint", ...modelAuthHeaders(scheme, token) },
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
        await response.body?.cancel();
        return { kind: "failed", error: { code: "invalid-response", message: "the endpoint's answer is too large to be a model list" } };
      }
      const text = await response.text();
      let json: unknown;
      try {
        json = text === "" ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { kind: "answer", status: response.status, headers: response.headers, json };
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      this.plumbing.logger.warn("model-provider.unreachable", { timedOut });
      return {
        kind: "failed",
        error: {
          code: "unavailable",
          message: timedOut ? "the endpoint did not answer in time" : "the endpoint could not be reached",
        },
      };
    }
  }
}
