import { loadBundledCatalog, ModelEndpointAdapter } from "@ostra/adapter-model-endpoint";
import { startAnthropicStub, startOpenAiStub } from "@ostra/adapter-sdk/testing";
import type { StubServer } from "@ostra/adapter-sdk/testing";
import type { ApiFormat, AuthScheme } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// F-088's "done when", through the routers the panel calls, with the real model endpoint adapter
// against a stub endpoint of each API format (the only fake is the endpoint itself) and the
// models.dev catalog bundled with ostra.

const TOKEN = "sk-f088-endpoint-token-0123456789abcdef";
/** One model the bundled catalog knows, and one it doesn't. */
const KNOWN = "claude-sonnet-4-5";
const CUSTOM = "local-coder-7b";

let harness: ApiHarness;
let openai: StubServer;
let anthropic: StubServer;

const endpoints = (): readonly { readonly format: ApiFormat; readonly scheme: AuthScheme; readonly stub: StubServer }[] => [
  { format: "openai-compatible", scheme: "bearer", stub: openai },
  { format: "anthropic-messages", scheme: "x-api-key", stub: anthropic },
];

beforeAll(async () => {
  const brain = () => ({ text: "hi" });
  openai = await startOpenAiStub({ realKey: TOKEN, models: [KNOWN, CUSTOM], brain });
  anthropic = await startAnthropicStub({ realKey: TOKEN, models: [KNOWN, CUSTOM], brain });
  // The stubs listen on loopback, which the adapter refuses unless told (OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE).
  harness = await createApiHarness({ modelProvider: new ModelEndpointAdapter({ allowPrivateNetwork: true, timeoutMs: 5_000 }) });
  harness.catalogEntries.push(...(await loadBundledCatalog()).entries);
});

afterAll(async () => {
  await harness.dispose();
  await openai.close();
  await anthropic.close();
});

const form = (name: string, baseUrl: string, apiFormat: ApiFormat, authScheme: AuthScheme) => ({
  name,
  baseUrl,
  token: TOKEN,
  apiFormat,
  authScheme,
  sessionsAtOnce: null,
  allowOnPersonalRunners: false,
});

describe("model providers, against a real endpoint of each format", () => {
  it("F-088: an organization admin adds a provider as an API base URL and a token, in either API format", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    for (const { format, scheme, stub } of endpoints()) {
      const { providerId } = await admin.providers.create(form(`added-${format}`, stub.baseUrl, format, scheme));
      const row = await harness.test.db.modelProvider.findUniqueOrThrow({ where: { id: providerId } });
      expect(row).toMatchObject({ organizationId: a.organization.id, baseUrl: stub.baseUrl, apiFormat: format === "anthropic-messages" ? "anthropic_messages" : "openai_compatible" });
      // The token is in the secret store, under the organization; the row holds only its reference.
      expect(harness.fakes.secretStore.entries.get(row.tokenSecretRef)).toMatchObject({ organizationId: a.organization.id, value: TOKEN });
      expect(JSON.stringify(row)).not.toContain(TOKEN);
    }
    expect((await admin.providers.list()).map((provider) => provider.apiFormat).sort()).toEqual(["anthropic-messages", "openai-compatible"]);
    // A member is not an admin: refused, and nothing is stored.
    const member = await harness.as(a.member);
    await expect(member.providers.create(form("by-a-member", openai.baseUrl, "openai-compatible", "bearer"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await harness.test.db.modelProvider.count({ where: { name: "by-a-member" } })).toBe(0);
  });

  it("F-088: Test connection checks the endpoint and detects its format; the admin's correction is what is saved", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    for (const { format, scheme, stub } of endpoints()) {
      expect(await admin.providers.testConnection({ baseUrl: stub.baseUrl, token: TOKEN })).toMatchObject({ ok: true, apiFormat: format, authScheme: scheme });
      // A wrong token is refused by the endpoint itself, and said so.
      expect(await admin.providers.testConnection({ baseUrl: stub.baseUrl, token: "sk-not-the-token-000000" })).toMatchObject({ ok: false, reason: "unauthorized" });
    }
    // The admin corrects the Anthropic endpoint's detected format to OpenAI-compatible (the
    // detected auth scheme stays, as in the form): the endpoint is tried with the correction, which is saved.
    const { providerId } = await admin.providers.create(form("corrected", anthropic.baseUrl, "openai-compatible", "x-api-key"));
    const row = await harness.test.db.modelProvider.findUniqueOrThrow({ where: { id: providerId } });
    expect(row).toMatchObject({ apiFormat: "openai_compatible", authScheme: "x_api_key" });
    // A correction the endpoint refuses is not saved.
    await expect(admin.providers.create({ ...form("refused", openai.baseUrl, "openai-compatible", "bearer"), token: "sk-not-the-token-000000" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(await harness.test.db.modelProvider.count({ where: { name: "refused" } })).toBe(0);
  });

  it("F-088: the models are the endpoint's own list, with names, logos, limits and prices from the models.dev catalog", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const entry = harness.catalogEntries.find((candidate) => candidate.aliases.includes(KNOWN));
    if (entry === undefined) {
      throw new Error(`the bundled catalog has no ${KNOWN}`);
    }
    for (const { format, scheme, stub } of endpoints()) {
      const { providerId } = await admin.providers.create(form(`listed-${format}`, stub.baseUrl, format, scheme));
      const models = await admin.providers.models({ providerId });
      // Exactly what the endpoint lists: nothing from the catalog that the endpoint doesn't serve.
      expect(models.map((model) => model.endpointModelId)).toEqual([KNOWN, CUSTOM]);
      expect(models.find((model) => model.endpointModelId === KNOWN)).toMatchObject({
        custom: false,
        catalogId: entry.catalogId,
        displayName: entry.name,
        contextWindow: entry.contextWindow,
        maxOutputTokens: entry.maxOutputTokens,
        inputPricePerMTok: entry.inputPricePerMTok,
        outputPricePerMTok: entry.outputPricePerMTok,
        logoPath: entry.logoPath,
      });
      expect(entry.logoPath).toMatch(/^\/model-logos\/[a-z0-9._-]+\.svg$/);
      expect(entry.contextWindow).toBeGreaterThan(0);
      expect(entry.inputPricePerMTok).toBeGreaterThan(0);
      expect(models.find((model) => model.endpointModelId === CUSTOM)).toMatchObject({ custom: true, catalogId: null, logoPath: null });
    }
    // "Test connection" shows the same match before anything is saved.
    const tested = await admin.providers.testConnection({ baseUrl: openai.baseUrl, token: TOKEN });
    expect(tested.ok && tested.models.map((model) => [model.endpointModelId, model.match.kind])).toEqual([
      [KNOWN, "catalog"],
      [CUSTOM, "custom"],
    ]);
  });
});
