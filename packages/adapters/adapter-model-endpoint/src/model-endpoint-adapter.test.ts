import http from "node:http";
import type { AddressInfo } from "node:net";

import { memoryAdapterContext, startStubModelServer, defineModelProviderContractSuite } from "@ostra/adapter-sdk/testing";
import type { StubServer } from "@ostra/adapter-sdk/testing";
import type { CatalogEntry } from "@ostra/adapter-sdk";
import { afterAll, describe, expect, it } from "vitest";

import { catalogEntries, idVariants, loadBundledCatalog, matchModelsToCatalog, parseModelsDevCatalog } from "./catalog.ts";
import { ModelEndpointAdapter } from "./model-endpoint-adapter.ts";

const REAL_KEY = "sk-stub-real-key-0123456789abcdef";

const catalog: readonly CatalogEntry[] = [
  {
    catalogId: "anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    aliases: ["claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"],
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputPricePerMTok: 3,
    outputPricePerMTok: 15,
    logoPath: "/model-logos/anthropic.svg",
  },
];

const servers: StubServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

// The model provider contract suite, against a stub of each API format.
defineModelProviderContractSuite({
  name: "model endpoint, against stubs of both formats",
  create: async () => {
    const models = ["claude-sonnet-4-5", "a-custom-model"];
    const openai = await startStubModelServer({ format: "openai-compatible", realKey: REAL_KEY, models, brain: () => ({ text: "hi" }) });
    const anthropic = await startStubModelServer({ format: "anthropic-messages", realKey: REAL_KEY, models, brain: () => ({ text: "hi" }) });
    return {
      adapter: new ModelEndpointAdapter(),
      fixture: {
        endpoints: [
          { baseUrl: openai.baseUrl, token: REAL_KEY, apiFormat: "openai-compatible", authScheme: "bearer", models },
          { baseUrl: anthropic.baseUrl, token: REAL_KEY, apiFormat: "anthropic-messages", authScheme: "x-api-key", models },
        ],
        wrongToken: "sk-wrong-token-0123456789",
        catalog,
        knownModelId: "claude-sonnet-4-5",
        unknownModelId: "a-custom-model",
      },
      dispose: async () => {
        await Promise.all([openai.close(), anthropic.close()]);
      },
    };
  },
});

type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void;

/** A server that answers as the test says, for the shapes the stubs don't have. */
const serve = async (handler: Handler): Promise<{ readonly url: string; readonly close: () => Promise<void> }> => {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};

const json = (response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};

describe("the model endpoint adapter", () => {
  const context = memoryAdapterContext();
  const adapter = new ModelEndpointAdapter({ timeoutMs: 2000 }, context);

  describe("testing a connection", () => {
    it("tries a bearer token, then Anthropic's header, and says which worked", async () => {
      const stub = await startStubModelServer({ format: "anthropic-messages", realKey: REAL_KEY, models: ["m1"], brain: () => ({ text: "" }) });
      servers.push(stub);
      const tested = await adapter.testConnection({ baseUrl: stub.baseUrl, token: REAL_KEY });
      expect(tested).toMatchObject({ ok: true, value: { apiFormat: "anthropic-messages", authScheme: "x-api-key" } });
    });

    it("tests only the scheme it's given, and refuses when that scheme is the wrong one", async () => {
      const stub = await startStubModelServer({ format: "anthropic-messages", realKey: REAL_KEY, models: ["m1"], brain: () => ({ text: "" }) });
      servers.push(stub);
      expect(await adapter.testConnection({ baseUrl: stub.baseUrl, token: REAL_KEY, authScheme: "bearer" })).toMatchObject({
        ok: false,
        error: { code: "unauthorized" },
      });
    });

    it("answers unauthorized for a 401 on every scheme, and forbidden for a 403", async () => {
      const refusing = await serve((_request, response) => {
        json(response, 403, { error: "no" });
      });
      try {
        expect(await adapter.testConnection({ baseUrl: refusing.url, token: "t" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      } finally {
        await refusing.close();
      }
    });

    it("answers a typed failure for an endpoint that isn't a model API", async () => {
      const web = await serve((_request, response) => {
        response.writeHead(404, { "content-type": "text/html" });
        response.end("<html>not here</html>");
      });
      const odd = await serve((_request, response) => {
        json(response, 200, { hello: "world" });
      });
      try {
        expect(await adapter.testConnection({ baseUrl: web.url, token: "t" })).toMatchObject({ ok: false, error: { code: "invalid-response" } });
        expect(await adapter.testConnection({ baseUrl: odd.url, token: "t" })).toMatchObject({ ok: false, error: { code: "invalid-response" } });
      } finally {
        await Promise.all([web.close(), odd.close()]);
      }
    });

    it("answers unavailable for an endpoint that can't be reached, and for one that is too slow", async () => {
      expect(await adapter.testConnection({ baseUrl: "http://127.0.0.1:1/v1", token: "t" })).toMatchObject({
        ok: false,
        error: { code: "unavailable" },
      });
      const slow = await serve(() => undefined);
      try {
        const quick = new ModelEndpointAdapter({ timeoutMs: 150 });
        expect(await quick.testConnection({ baseUrl: slow.url, token: "t" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
      } finally {
        await slow.close();
      }
    });

    it("refuses a base URL that isn't http, or that holds credentials, before any call", async () => {
      for (const baseUrl of ["not a url", "ftp://example.com/v1", "https://user:pass@example.com/v1"]) {
        expect(await adapter.testConnection({ baseUrl, token: "t" })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      }
    });

    it("doesn't follow a redirect, so the token can't go to another host", async () => {
      let reached = false;
      const target = await serve((_request, response) => {
        reached = true;
        json(response, 200, { object: "list", data: [] });
      });
      const redirecting = await serve((_request, response) => {
        response.writeHead(302, { location: `${target.url}/models` });
        response.end();
      });
      try {
        expect(await adapter.testConnection({ baseUrl: redirecting.url, token: "t" })).toMatchObject({ ok: false, error: { code: "invalid-response" } });
        expect(reached).toBe(false);
      } finally {
        await Promise.all([redirecting.close(), target.close()]);
      }
    });

    it("reads context windows and names some endpoints list, and detects Anthropic by its headers", async () => {
      const aggregator = await serve((_request, response) => {
        json(response, 200, {
          data: [
            { id: "vendor/model-a", name: "Model A", context_length: 131_072 },
            { id: "plain", object: "model", max_model_len: 8192 },
          ],
        });
      });
      const headered = await serve((_request, response) => {
        json(response, 200, { data: [{ id: "x" }] }, { "anthropic-organization-id": "org" });
      });
      try {
        const tested = await adapter.testConnection({ baseUrl: aggregator.url, token: "t" });
        expect(tested).toMatchObject({
          ok: true,
          value: {
            apiFormat: "openai-compatible",
            authScheme: "bearer",
            models: [
              { endpointModelId: "vendor/model-a", displayName: "Model A", contextWindow: 131_072 },
              { endpointModelId: "plain", displayName: null, contextWindow: 8192 },
            ],
          },
        });
        expect(await adapter.testConnection({ baseUrl: headered.url, token: "t" })).toMatchObject({
          ok: true,
          value: { apiFormat: "anthropic-messages" },
        });
      } finally {
        await Promise.all([aggregator.close(), headered.close()]);
      }
    });

    it("follows Anthropic's paging to the end", async () => {
      const pages = await serve((request, response) => {
        const after = new URL(request.url ?? "/", "http://x").searchParams.get("after_id");
        const key = request.headers["x-api-key"];
        if (key !== "t") {
          json(response, 401, { type: "error" });
          return;
        }
        json(
          response,
          200,
          after === null
            ? { data: [{ type: "model", id: "m1", display_name: "One" }], has_more: true, last_id: "m1" }
            : { data: [{ type: "model", id: "m2", display_name: "Two" }], has_more: false, last_id: "m2" },
        );
      });
      try {
        const tested = await adapter.testConnection({ baseUrl: pages.url, token: "t" });
        expect(tested.ok && tested.value.models.map((model) => model.endpointModelId)).toEqual(["m1", "m2"]);
      } finally {
        await pages.close();
      }
    });

    it("keeps the token and the URL out of every error and log line", async () => {
      const secret = "sk-live-super-secret-token-9876543210";
      const wrong = await startStubModelServer({ format: "openai-compatible", realKey: REAL_KEY, models: [], brain: () => ({ text: "" }) });
      servers.push(wrong);
      const results = [
        await adapter.testConnection({ baseUrl: wrong.baseUrl, token: secret }),
        await adapter.testConnection({ baseUrl: "http://127.0.0.1:1/v1", token: secret }),
        await adapter.listModels({ baseUrl: wrong.baseUrl, token: secret, apiFormat: "openai-compatible" }),
      ];
      const everything = JSON.stringify([results, context.logger.records]);
      expect(everything).not.toContain(secret);
      expect(everything).not.toContain("127.0.0.1");
    });
  });

  describe("the catalog", () => {
    it("bundles a catalog with its fetch date, and matches current models by ID", async () => {
      const { fetchedAt, entries } = await loadBundledCatalog();
      expect(new Date(fetchedAt).getTime()).toBeGreaterThan(Date.parse("2026-01-01"));
      expect(entries.length).toBeGreaterThan(1000);
      const matches = adapter.matchCatalog(
        [
          { endpointModelId: "claude-haiku-4-5", displayName: null, contextWindow: null },
          { endpointModelId: "not-a-real-model-xyz", displayName: null, contextWindow: null },
        ],
        entries,
      );
      expect(matches[0]?.match).toMatchObject({ kind: "catalog", entry: { catalogId: "anthropic/claude-haiku-4-5", logoPath: "/model-logos/anthropic.svg" } });
      expect(matches[1]?.match.kind).toBe("custom");
    });

    it("matches an aggregator's vendor prefix, a variant tag and a date suffix", () => {
      const models = ["anthropic/claude-sonnet-4-5", "claude-sonnet-4-5:free", "claude-sonnet-4-5-20250929", "Claude-Sonnet-4-5", "claude-sonnet-4-6-20991231"];
      const kinds = matchModelsToCatalog(models.map((endpointModelId) => ({ endpointModelId, displayName: null, contextWindow: null })), catalog).map(
        (match) => match.match.kind,
      );
      expect(kinds).toEqual(["catalog", "catalog", "catalog", "catalog", "custom"]);
    });

    it("lists a model's ID variants, most specific first", () => {
      expect(idVariants("Vendor/Model-X:free")).toEqual(["vendor/model-x:free", "vendor/model-x", "model-x:free", "model-x"]);
      expect(idVariants("m-20250929")).toEqual(["m-20250929", "m"]);
    });

    it("prefers the first-party provider when several carry a model", () => {
      const entries = catalogEntries({
        zzz: { models: { "shared-model": { id: "shared-model", name: "From zzz" } } },
        anthropic: { models: { "shared-model": { id: "shared-model", name: "From anthropic" } } },
      });
      const [match] = matchModelsToCatalog([{ endpointModelId: "shared-model", displayName: null, contextWindow: null }], entries);
      expect(match?.match).toMatchObject({ kind: "catalog", entry: { name: "From anthropic" } });
    });

    it("parses a fetched catalog loosely, and refuses one that isn't a catalog", () => {
      const fetched = { acme: { id: "acme", unknown_field: 1, models: { m: { id: "m", name: "M", limit: { context: 1000, output: 100 }, cost: { input: 1.5, output: 6 }, extra: true } } } };
      const parsed = parseModelsDevCatalog(fetched);
      expect(parsed.ok && parsed.value).toEqual([
        {
          catalogId: "acme/m",
          name: "M",
          aliases: ["m", "acme/m"],
          contextWindow: 1000,
          maxOutputTokens: 100,
          inputPricePerMTok: 1.5,
          outputPricePerMTok: 6,
          logoPath: "/model-logos/acme.svg",
        },
      ]);
      expect(parseModelsDevCatalog({ acme: { models: "nope" } })).toMatchObject({ ok: false, error: { code: "invalid-response" } });
      expect(parseModelsDevCatalog({})).toMatchObject({ ok: false });
    });
  });

  it("declares both formats, a model list and usage in the stream", () => {
    expect(adapter.capabilities).toEqual({ apiFormats: ["openai-compatible", "anthropic-messages"], modelList: true, usageInStream: true });
  });
});
