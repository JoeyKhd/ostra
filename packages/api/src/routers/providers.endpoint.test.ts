import { loadBundledCatalog, ModelEndpointAdapter } from "@ostra/adapter-model-endpoint";
import { startAnthropicStub, startOpenAiStub } from "@ostra/adapter-sdk/testing";
import type { StubServer } from "@ostra/adapter-sdk/testing";
import { addModelProvider, modelNameKey, modelNameSchema, resolveSessionModel } from "@ostra/domain";
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
  it("F-088/c1: an organization admin adds a provider as an API base URL and a token, in either API format", async () => {
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

  it("F-088/c2: Test connection checks the endpoint and detects its format; the admin's correction is what is saved", async () => {
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

  it("F-088/c3: the models are the endpoint's own list, with names, logos, limits and prices from the models.dev catalog", async () => {
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

// An endpoint may list each model twice, as `x` and `x:batch`, its asynchronous batch API. The
// catalog match gives both one name, so a picker showed it twice. Organization B, which the tests
// above leave without a provider.
describe("a batch variant beside its model", () => {
  const brain = () => ({ text: "hi" });
  /** A custom model the endpoint lists only later. */
  const LATER = "local-coder-13b";

  it("F-088: a provider's x:batch is kept unlisted beside x: at the add, when a refresh first finds it, and on every refresh after", async () => {
    const { b } = harness.fixture;
    const served = [CUSTOM, `${CUSTOM}:batch`];
    const stub = await startOpenAiStub({ realKey: TOKEN, models: served, brain });
    try {
      const scope = (await harness.contextOf(b.admin)).member?.scope;
      if (scope === undefined) {
        throw new Error("the fixture's admin has no scope");
      }
      // The add keeps the endpoint's rows at once, before any refresh matches them to the catalog.
      const added = await harness.test.db.$transaction((tx) =>
        addModelProvider({ tx, scope, ...harness.deps.ports }, form("batch-variants", stub.baseUrl, "openai-compatible", "bearer")),
      );
      if (!added.ok) {
        throw new Error(added.message);
      }
      const { providerId } = added;
      const listedOf = async () =>
        Object.fromEntries((await harness.test.db.model.findMany({ where: { providerId }, select: { endpointModelId: true, listed: true } })).map((row) => [row.endpointModelId, row.listed]));
      expect(await listedOf()).toEqual({ [CUSTOM]: true, [`${CUSTOM}:batch`]: false });

      // The endpoint starts listing a catalog model and a custom one twice: the refresh creates the rows.
      served.push(KNOWN, `${KNOWN}:batch`, LATER, `${LATER}:batch`);
      const admin = await harness.as(b.admin);
      await admin.providers.refresh({ providerId });
      const entry = harness.catalogEntries.find((candidate) => candidate.aliases.includes(KNOWN));
      const models = await admin.providers.models({ providerId });
      expect(models.find((model) => model.endpointModelId === `${KNOWN}:batch`)).toMatchObject({ catalogId: entry?.catalogId, displayName: entry?.name, listed: false });
      expect(models.find((model) => model.endpointModelId === KNOWN)).toMatchObject({ catalogId: entry?.catalogId, displayName: entry?.name, listed: true });
      const after = { [CUSTOM]: true, [`${CUSTOM}:batch`]: false, [KNOWN]: true, [`${KNOWN}:batch`]: false, [LATER]: true, [`${LATER}:batch`]: false };
      expect(await listedOf()).toEqual(after);
      // Every refresh after keeps it so.
      await admin.providers.refresh({ providerId });
      expect(await listedOf()).toEqual(after);
      // The profile's model picker offers each name once, from its plain row.
      const options = (await admin.agentProfiles.modelOptions()).filter((option) => option.providers.some((provider) => provider.providerId === providerId));
      expect(options.map((option) => [option.text, option.providers.map((provider) => provider.endpointModelId)])).toEqual([
        [entry?.catalogId, [KNOWN]],
        [LATER, [LATER]],
        [CUSTOM, [CUSTOM]],
      ]);
    } finally {
      await stub.close();
    }
  });

  it("F-088: a refresh hides a batch row an earlier version listed, and a choice on it moves to the plain row of the same provider", async () => {
    const { b } = harness.fixture;
    const stub = await startOpenAiStub({ realKey: TOKEN, models: [KNOWN, `${KNOWN}:batch`], brain });
    try {
      const admin = await harness.as(b.admin);
      const { providerId } = await admin.providers.create(form("batch-choice", stub.baseUrl, "openai-compatible", "bearer"));
      const rows = await harness.test.db.model.findMany({ where: { providerId }, select: { id: true, endpointModelId: true, catalogId: true } });
      const plain = rows.find((row) => row.endpointModelId === KNOWN);
      const batch = rows.find((row) => row.endpointModelId === `${KNOWN}:batch`);
      if (plain === undefined || batch === undefined || batch.catalogId === null) {
        throw new Error("expected both rows, matched to the catalog");
      }
      const name = modelNameSchema.parse({ kind: "catalog", catalogId: batch.catalogId });
      // An install from before the rule: the batch row listed, and a project's list serving the name
      // from it (the upgrade's choice copied a profile's row, which the old picker offered twice).
      await harness.test.db.model.update({ where: { id: batch.id }, data: { listed: true } });
      await harness.test.db.project.update({ where: { id: b.project.id }, data: { ownProviders: true } });
      await harness.test.db.providerListEntry.create({ data: { organizationId: b.organization.id, projectId: b.project.id, providerId } });
      await harness.test.db.modelChoice.create({
        data: { organizationId: b.organization.id, projectId: b.project.id, modelKey: modelNameKey(name), modelCatalogId: batch.catalogId, modelId: batch.id, reason: "upgrade" },
      });
      const target = { organizationId: b.organization.id, projectId: b.project.id, modelName: name };
      expect(await resolveSessionModel(harness.test.db, target)).toEqual({ ok: true, providerId, modelId: batch.id });

      await admin.providers.refresh({ providerId });
      expect(await harness.test.db.model.findUniqueOrThrow({ where: { id: batch.id }, select: { listed: true } })).toEqual({ listed: false });
      // The project keeps its key, now from the plain row, and the choice stays the upgrade's.
      expect(await resolveSessionModel(harness.test.db, target)).toEqual({ ok: true, providerId, modelId: plain.id });
      expect(await harness.test.db.modelChoice.findFirstOrThrow({ where: { projectId: b.project.id, modelKey: modelNameKey(name) }, select: { modelId: true, reason: true } })).toEqual({
        modelId: plain.id,
        reason: "upgrade",
      });
    } finally {
      await stub.close();
    }
  });
});
