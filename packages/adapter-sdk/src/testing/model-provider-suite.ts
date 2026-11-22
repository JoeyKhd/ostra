import type { ApiFormat, AuthScheme } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import type { CatalogEntry, ModelProviderAdapter } from "../model-provider/base.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";

// The cases every model provider adapter passes (ADR 0033): against stub endpoints in both API
// formats (ticket 12), and, gated on `model.env`, against the real endpoint. No case assumes a
// particular provider (Q106).

export type StubEndpoint = {
  readonly baseUrl: string;
  readonly token: string;
  readonly apiFormat: ApiFormat;
  readonly authScheme: AuthScheme;
  /** The model IDs the endpoint lists. */
  readonly models: readonly string[];
};

export type ModelProviderFixture = {
  /** One endpoint per API format the adapter declares. */
  readonly endpoints: readonly StubEndpoint[];
  /** A token every endpoint refuses. */
  readonly wrongToken: string;
  readonly catalog: readonly CatalogEntry[];
  /** A model ID the catalog knows, and one it doesn't. */
  readonly knownModelId: string;
  readonly unknownModelId: string;
};

/** Where the suite's matches are served from: the fixture's first endpoint. */
const servedFrom = (fixture: ModelProviderFixture): { readonly baseUrl: string } => ({ baseUrl: fixture.endpoints[0]?.baseUrl ?? "https://models.invalid/v1" });

export const defineModelProviderContractSuite = (
  options: ContractSuiteOptions<ModelProviderAdapter, ModelProviderFixture>,
): void => {
  describe(`model provider contract: ${options.name}`, () => {
    const subject = useSubject(options);

    defineCommonCases(subject, "model-provider", { apiFormats: "array", modelList: "boolean", usageInStream: "boolean" });

    it("has an endpoint fixture for every format it declares", () => {
      const { adapter, fixture } = subject();
      const formats = new Set(fixture.endpoints.map((endpoint) => endpoint.apiFormat));
      for (const format of adapter.capabilities.apiFormats) {
        expect(formats.has(format), `an endpoint in ${format}`).toBe(true);
      }
    });

    it("detects each endpoint's format and auth scheme, and lists its models", async () => {
      const { adapter, fixture } = subject();
      for (const endpoint of fixture.endpoints) {
        const tested = await adapter.testConnection({ baseUrl: endpoint.baseUrl, token: endpoint.token });
        expect(tested).toMatchObject({ ok: true, value: { apiFormat: endpoint.apiFormat, authScheme: endpoint.authScheme } });
        if (tested.ok) {
          expect(tested.value.models.map((model) => model.endpointModelId).sort()).toEqual([...endpoint.models].sort());
        }
      }
    });

    it("refuses a wrong token as unauthorized", async () => {
      const { adapter, fixture } = subject();
      for (const endpoint of fixture.endpoints) {
        const tested = await adapter.testConnection({ baseUrl: endpoint.baseUrl, token: fixture.wrongToken });
        expect(tested).toMatchObject({ ok: false, error: { code: "unauthorized" } });
      }
    });

    it("lists models in the given format", async () => {
      const { adapter, fixture } = subject();
      for (const endpoint of fixture.endpoints) {
        const listed = await adapter.listModels(endpoint);
        expect(listed.ok && listed.value.length).toBe(endpoint.models.length);
      }
    });

    it("matches a known model to the catalog and marks an unknown one custom", () => {
      const { adapter, fixture } = subject();
      const matches = adapter.matchCatalog(
        [
          { endpointModelId: fixture.knownModelId, displayName: null, contextWindow: null },
          { endpointModelId: fixture.unknownModelId, displayName: null, contextWindow: null },
        ],
        fixture.catalog,
        servedFrom(fixture),
      );
      expect(matches.map((match) => [match.endpointModelId, match.match.kind])).toEqual([
        [fixture.knownModelId, "catalog"],
        [fixture.unknownModelId, "custom"],
      ]);
    });

    it("F-037: a catalog match carries all four prices per million tokens, each null where the catalog has none", () => {
      const { adapter, fixture } = subject();
      const known = fixture.catalog.find((entry) => entry.catalogId === fixture.knownModelId || entry.aliases.includes(fixture.knownModelId));
      if (known === undefined) throw new Error("the fixture's catalog lacks its known model");
      const priced: CatalogEntry = { ...known, inputPricePerMTok: 3, outputPricePerMTok: 15, cacheReadPricePerMTok: 0.3, cacheWritePricePerMTok: 3.75 };
      const unpriced: CatalogEntry = {
        ...known,
        catalogId: "ostra-suite-unpriced",
        aliases: ["ostra-suite-unpriced"],
        inputPricePerMTok: null,
        outputPricePerMTok: null,
        cacheReadPricePerMTok: null,
        cacheWritePricePerMTok: null,
      };
      const matches = adapter.matchCatalog(
        [
          { endpointModelId: fixture.knownModelId, displayName: null, contextWindow: null },
          { endpointModelId: "ostra-suite-unpriced", displayName: null, contextWindow: null },
        ],
        [priced, unpriced],
        servedFrom(fixture),
      );
      const prices = matches.map((match) =>
        match.match.kind === "catalog"
          ? [match.match.entry.inputPricePerMTok, match.match.entry.outputPricePerMTok, match.match.entry.cacheReadPricePerMTok, match.match.entry.cacheWritePricePerMTok]
          : "custom",
      );
      expect(prices).toEqual([
        [3, 15, 0.3, 3.75],
        [null, null, null, null],
      ]);
    });

    it("F-137: a catalog match carries the entry's reasoning controls and whether its reasoning price differs", () => {
      const { adapter, fixture } = subject();
      const known = fixture.catalog.find((entry) => entry.catalogId === fixture.knownModelId || entry.aliases.includes(fixture.knownModelId));
      if (known === undefined) throw new Error("the fixture's catalog lacks its known model");
      const reasons: CatalogEntry = { ...known, reasoning: { supported: true, toggle: true, effort: ["low", "high", "max"] }, reasoningPriceDiffers: true };
      const plain: CatalogEntry = { ...known, catalogId: "ostra-suite-plain", aliases: ["ostra-suite-plain"], reasoning: { supported: false }, reasoningPriceDiffers: false };
      const matches = adapter.matchCatalog(
        [
          { endpointModelId: fixture.knownModelId, displayName: null, contextWindow: null },
          { endpointModelId: "ostra-suite-plain", displayName: null, contextWindow: null },
        ],
        [reasons, plain],
        servedFrom(fixture),
      );
      expect(matches.map((match) => (match.match.kind === "catalog" ? [match.match.entry.reasoning, match.match.entry.reasoningPriceDiffers] : "custom"))).toEqual([
        [{ supported: true, toggle: true, effort: ["low", "high", "max"] }, true],
        [{ supported: false }, false],
      ]);
    });
  });
};
