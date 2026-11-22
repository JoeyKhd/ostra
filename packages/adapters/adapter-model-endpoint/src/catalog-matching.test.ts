import http from "node:http";
import type { AddressInfo } from "node:net";

import type { CatalogMatch, EndpointModel } from "@ostra/adapter-sdk";
import { afterAll, describe, expect, it } from "vitest";

import { catalogEntries, matchModelsToCatalog, servingProviders } from "./catalog.ts";
import type { ModelsDevCatalog } from "./catalog.ts";
import { ModelEndpointAdapter } from "./model-endpoint-adapter.ts";

// 2026-11-22 (ADR 0033, F-148): a model matches its serving provider's own catalog entry. The live
// instance's OpenRouter model `deepseek/deepseek-v4.1-flash-1017` was matched to ambient's entry,
// the first of ~120 in the catalog's order, which says text only, where OpenRouter's own entry and
// nearly every other says it reads images. Small catalogs in models.dev's shape, as the live API
// spells them: OpenRouter's entry with no `api`, as in the bundled copy.

const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";
const OPENROUTER = "https://openrouter.ai/api/v1";
const UNKNOWN_HOST = "https://llm-gateway.internal.example/v1";

type Inputs = readonly string[];

/** One model as models.dev lists it, with the inputs, prices and limits a test names. */
const model = (id: string, inputs: Inputs | null, extra: Record<string, unknown> = {}) => ({
  id,
  name: "DeepSeek V4.1 Flash 1017",
  tool_call: true,
  limit: { context: 1_048_576, output: 384_000 },
  cost: { input: 0.1, output: 0.4 },
  ...(inputs === null ? {} : { modalities: { input: inputs, output: ["text"] } }),
  ...extra,
});

/** A provider of one model, with an `api` when given. */
const provider = (models: readonly ReturnType<typeof model>[], api?: string) => ({
  ...(api === undefined ? {} : { api }),
  models: Object.fromEntries(models.map((entry) => [entry.id, entry])),
});

const listed = (endpointModelId: string, inputModalities?: EndpointModel["inputModalities"]): EndpointModel => ({
  endpointModelId,
  displayName: null,
  contextWindow: null,
  ...(inputModalities === undefined ? {} : { inputModalities }),
});

/** The live catalog's spread for the model, cut down: a handful text only, OpenRouter's and most others with images. */
const deepseekCatalog: ModelsDevCatalog = {
  ambient: provider(
    [
      model(DEEPSEEK, ["text"], {
        cost: { input: 0.045, output: 0.25 },
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
      }),
    ],
    "https://api.ambient.xyz/v1",
  ),
  // With images, and ahead of OpenRouter in the catalog's order: what most entries agree on lands here, not on OpenRouter's.
  kilo: provider([model(DEEPSEEK, ["text", "image"], { cost: { input: 0.2, output: 0.8 } })]),
  nearai: provider([model(DEEPSEEK, ["text"])], "https://cloud-api.near.ai/v1"),
  wally: provider([model("deepseek-v4.1-flash-1017", ["text"])], "https://inference.runanywhere.ai/v1"),
  openrouter: provider([
    model(DEEPSEEK, ["text", "image"], {
      limit: { context: 1_048_576, output: 393_216 },
      cost: { input: 0.15, output: 0.6 },
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["none", "low", "high", "max"] }],
    }),
  ]),
  zenmux: provider([model(DEEPSEEK, ["text", "image"], { cost: { input: 0.14, output: 0.55 } })], "https://zenmux.ai/api/v1"),
  requesty: provider([model(DEEPSEEK, ["text", "image"])], "https://router.requesty.ai/v1"),
  vercel: provider([model(DEEPSEEK, ["text", "image"])]),
  // The lab is first-party, but its own list doesn't have this one.
  deepseek: provider([model("deepseek-v4-flash", ["text"])], "https://api.deepseek.com"),
};

const matchOne = (catalog: ModelsDevCatalog, baseUrl: string, model: EndpointModel): CatalogMatch["match"] => {
  const [match] = matchModelsToCatalog([model], catalogEntries(catalog), { baseUrl });
  if (match === undefined) throw new Error("no match came back");
  return match.match;
};

const catalogMatch = (match: CatalogMatch["match"]) => {
  if (match.kind !== "catalog") throw new Error(`expected a catalog match, got ${match.kind}`);
  return match.entry;
};

describe("which provider serves an endpoint", () => {
  it("knows a provider by its models.dev `api`, path by path, and by the well-known hosts, and not an unknown host", () => {
    const entries = catalogEntries({
      zai: provider([model("glm-5", ["text"])], "https://api.z.ai/api/paas/v4"),
      "zai-coding-plan": provider([model("glm-5", ["text"])], "https://api.z.ai/api/coding/paas/v4"),
      "aki-io": provider([model("m", ["text"])], "https://aki.io/openai/v1"),
      openrouter: provider([model("m", ["text"])]),
    });
    expect(servingProviders("https://api.z.ai/api/coding/paas/v4/", entries)).toEqual(["zai-coding-plan", "zai"]);
    expect(servingProviders("https://api.z.ai/api/paas/v4", entries)).toEqual(["zai", "zai-coding-plan"]);
    // A base URL within the provider's `api`, or holding it, on the same host.
    expect(servingProviders("https://AKI.io/openai", entries)).toEqual(["aki-io"]);
    // OpenRouter's entry gives no `api`: its host is a well-known one.
    expect(servingProviders(OPENROUTER, entries)).toEqual(["openrouter"]);
    expect(servingProviders("https://www.openrouter.ai/api/v1", entries)).toEqual(["openrouter"]);
    expect(servingProviders(UNKNOWN_HOST, entries)).toEqual([]);
    expect(servingProviders("not a url", entries)).toEqual([]);
  });
});

describe("matching a model to its serving provider's own entry", () => {
  it("F-148/c5: OpenRouter's deepseek/deepseek-v4.1-flash-1017 reads images, from openrouter's own entry, though ambient's text-only one sorts first", () => {
    const entries = catalogEntries(deepseekCatalog);
    // The catalog's order puts ambient's entry ahead of OpenRouter's: what the old match took.
    const order = entries.filter((entry) => entry.aliases.includes(DEEPSEEK)).map((entry) => entry.catalogId);
    expect(order[0]).toBe(`ambient/${DEEPSEEK}`);
    expect(order.indexOf(`openrouter/${DEEPSEEK}`)).toBeGreaterThan(0);

    const entry = catalogMatch(matchOne(deepseekCatalog, OPENROUTER, listed(DEEPSEEK)));
    expect(entry).toMatchObject({
      catalogId: `openrouter/${DEEPSEEK}`,
      inputModalities: ["text", "image"],
      // OpenRouter's own prices and limits, never ambient's.
      inputPricePerMTok: 0.15,
      outputPricePerMTok: 0.6,
      maxOutputTokens: 393_216,
      // An aggregator's `vendor/model` shows its lab's logo.
      logoPath: "/model-logos/deepseek.svg",
    });
    // A `:free` variant on OpenRouter is the same entry.
    expect(catalogMatch(matchOne(deepseekCatalog, OPENROUTER, listed(`${DEEPSEEK}:free`))).catalogId).toBe(`openrouter/${DEEPSEEK}`);
  });

  it("F-137/c1: an OpenRouter model's levels are the effort values models.dev lists for it on openrouter, not another provider's", () => {
    const entry = catalogMatch(matchOne(deepseekCatalog, OPENROUTER, listed(DEEPSEEK)));
    expect(entry.reasoning).toEqual({ supported: true, effort: ["none", "low", "high", "max"] });
  });

  it("F-148/c5: a provider known by its models.dev `api` gets its own entry too: text only where that provider says so", () => {
    expect(catalogMatch(matchOne(deepseekCatalog, "https://api.ambient.xyz/v1", listed(DEEPSEEK)))).toMatchObject({
      catalogId: `ambient/${DEEPSEEK}`,
      inputModalities: ["text"],
      inputPricePerMTok: 0.045,
    });
    expect(catalogMatch(matchOne(deepseekCatalog, "https://zenmux.ai/api/v1", listed(DEEPSEEK)))).toMatchObject({ catalogId: `zenmux/${DEEPSEEK}`, inputPricePerMTok: 0.14 });
  });
});

describe("what the endpoint's own list says", () => {
  it("F-148/c5: the endpoint's list gives a model's inputs when its provider has no entry for it, and its provider's own entry still comes first", () => {
    const catalog: ModelsDevCatalog = {
      // OpenRouter's entries don't have this one; ambient's, first in the catalog's order, say text only.
      ambient: provider([model("acme/vision-1", ["text"])]),
      openrouter: provider([model(DEEPSEEK, ["text", "image"])]),
    };
    expect(catalogMatch(matchOne(catalog, OPENROUTER, listed("acme/vision-1", ["text", "image"]))).inputModalities).toEqual(["text", "image"]);
    // Nothing from the list: the entry the match chose says.
    expect(catalogMatch(matchOne(catalog, OPENROUTER, listed("acme/vision-1"))).inputModalities).toEqual(["text"]);
    // The provider's own entry wins over its list.
    expect(catalogMatch(matchOne(catalog, OPENROUTER, listed(DEEPSEEK, ["text"]))).inputModalities).toEqual(["text", "image"]);
    // A model models.dev doesn't know at all keeps what the list says, as a custom model.
    expect(matchOne(catalog, OPENROUTER, listed("acme/brand-new", ["text", "image", "audio"]))).toEqual({ kind: "custom", inputModalities: ["text", "image", "audio"] });
    expect(matchOne(catalog, OPENROUTER, listed("acme/brand-new"))).toEqual({ kind: "custom" });
  });

  describe("an OpenRouter-shaped /models", () => {
    const servers: { close: () => Promise<void> }[] = [];
    afterAll(async () => {
      await Promise.all(servers.map((server) => server.close()));
    });

    const serve = async (body: unknown): Promise<string> => {
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      servers.push({
        close: () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => {
              resolve();
            });
          }),
      });
      const address: AddressInfo | string | null = server.address();
      return `http://127.0.0.1:${String(typeof address === "object" && address !== null ? address.port : 0)}/api/v1`;
    };

    it("F-148/c5: reads each model's architecture.input_modalities, its older `modality`, and skips what it can't read", async () => {
      const baseUrl = await serve({
        data: [
          { id: DEEPSEEK, name: "DeepSeek: V4.1 Flash", context_length: 1_048_576, architecture: { modality: "text+image->text", input_modalities: ["image", "text", "file"], output_modalities: ["text"], tokenizer: "DeepSeek" }, pricing: { prompt: "0.00000015" } },
          { id: "old/modality-only", architecture: { modality: "text+image+audio->text" } },
          { id: "top/level", input_modalities: ["text", "video"] },
          { id: "says/nothing", architecture: { tokenizer: "Other" } },
          { id: "says/garbage", architecture: { input_modalities: "text,image", modality: 7 } },
          { id: "says/none-ostra-names", architecture: { input_modalities: ["file"] } },
        ],
      });
      const adapter = new ModelEndpointAdapter({ allowPrivateNetwork: true, timeoutMs: 2000 });
      const models = await adapter.listModels({ baseUrl, token: "t", apiFormat: "openai-compatible" });
      expect(models.ok && models.value.map((entry) => [entry.endpointModelId, entry.inputModalities])).toEqual([
        [DEEPSEEK, ["text", "image"]],
        ["old/modality-only", ["text", "image", "audio"]],
        ["top/level", ["text", "video"]],
        ["says/nothing", undefined],
        ["says/garbage", undefined],
        ["says/none-ostra-names", undefined],
      ]);
      // An endpoint whose list says nothing leaves the field out, as before.
      expect(models.ok && Object.keys(models.value[3] ?? {})).toEqual(["endpointModelId", "displayName", "contextWindow"]);
    });
  });
});

describe("an unknown host: the lab's own entry, else what most entries agree on", () => {
  it("F-148/c5: an unknown host gets what most entries for the model agree on, never merely the first in the catalog's order", () => {
    const entry = catalogMatch(matchOne(deepseekCatalog, UNKNOWN_HOST, listed(DEEPSEEK)));
    // Five say text and image, three text only (ambient's first): the agreeing group's first in the catalog's order.
    expect(entry).toMatchObject({ catalogId: `kilo/${DEEPSEEK}`, inputModalities: ["text", "image"], inputPricePerMTok: 0.2 });
    // The bare ID names wally's text-only entry alone, but every entry for the same model votes.
    expect(catalogMatch(matchOne(deepseekCatalog, UNKNOWN_HOST, listed("deepseek-v4.1-flash-1017")))).toMatchObject({ catalogId: `kilo/${DEEPSEEK}`, inputModalities: ["text", "image"] });
    // A self-hosted server's own spelling of it.
    expect(catalogMatch(matchOne(deepseekCatalog, UNKNOWN_HOST, listed("deepseek-ai/DeepSeek-V4.1-Flash-1017"))).inputModalities).toEqual(["text", "image"]);
  });

  it("F-148/c5: the lab's own first-party entry comes first, whatever most others say", () => {
    const catalog: ModelsDevCatalog = {
      deepseek: provider([model("deepseek-v4-flash", ["text"])]),
      aaa: provider([model("deepseek/deepseek-v4-flash", ["text", "image"])]),
      bbb: provider([model("deepseek/deepseek-v4-flash", ["text", "image"])]),
    };
    expect(catalogMatch(matchOne(catalog, UNKNOWN_HOST, listed("deepseek/deepseek-v4-flash")))).toMatchObject({ catalogId: "deepseek/deepseek-v4-flash", inputModalities: ["text"] });
    // A bare ID from a first-party provider is the lab's.
    expect(catalogMatch(matchOne(catalog, UNKNOWN_HOST, listed("deepseek-v4-flash"))).catalogId).toBe("deepseek/deepseek-v4-flash");
    // An aggregator's prefix that isn't the provider ID still names the lab.
    const grok: ModelsDevCatalog = { aaa: provider([model("x-ai/grok-5", ["text"])]), xai: provider([model("grok-5", ["text", "image"])]) };
    expect(catalogMatch(matchOne(grok, UNKNOWN_HOST, listed("x-ai/grok-5")))).toMatchObject({ catalogId: "xai/grok-5", logoPath: "/model-logos/xai.svg" });
  });

  it("F-148/c5: a tie goes to the group holding a first-party entry, then to the catalog's order; entries that say nothing don't vote", () => {
    // A first-party provider that isn't the model's lab: not the lab's entry, but first in a tie.
    const tied: ModelsDevCatalog = {
      aaa: provider([model("deepseek/x-1", ["text", "image"])]),
      alibaba: provider([model("deepseek/x-1", ["text"])]),
    };
    expect(catalogMatch(matchOne(tied, UNKNOWN_HOST, listed("deepseek/x-1")))).toMatchObject({ catalogId: "alibaba/deepseek/x-1", inputModalities: ["text"] });
    // No first-party entry: the catalog's order, by provider ID.
    const plain: ModelsDevCatalog = {
      zzz: provider([model("acme/x-2", ["text"])]),
      bbb: provider([model("acme/x-2", ["text", "image"])]),
      aaa: provider([model("acme/x-2", null)]),
      ccc: provider([model("acme/x-2", null)]),
    };
    expect(catalogMatch(matchOne(plain, UNKNOWN_HOST, listed("acme/x-2")))).toMatchObject({ catalogId: "bbb/acme/x-2", inputModalities: ["text", "image"] });
    // Nobody says: the catalog's order, and nothing said.
    const silent: ModelsDevCatalog = { bbb: provider([model("acme/x-3", null)]), aaa: provider([model("acme/x-3", null)]) };
    expect(catalogMatch(matchOne(silent, UNKNOWN_HOST, listed("acme/x-3")))).toMatchObject({ catalogId: "aaa/acme/x-3", inputModalities: null });
  });
});
