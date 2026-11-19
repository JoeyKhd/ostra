import { ensureBuiltInAgentProfile, jobKey } from "@ostra/domain";
import { modelIdSchema, providerIdSchema } from "@ostra/protocol";
import type { CatalogEntry } from "@ostra/adapter-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 31: the model provider routers. Admin only, organization scoped, no secret in any output.

const TOKEN = "sk-test-provider-token-0123456789abcdef";
const BASE_URL = "https://models.example.com/v1";

const claude: CatalogEntry = {
  catalogId: "anthropic/claude-sonnet",
  name: "Claude Sonnet",
  aliases: ["claude-sonnet-5"],
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  inputPricePerMTok: 3,
  outputPricePerMTok: 15,
  logoPath: "/assets/models/anthropic.svg",
};

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
  harness.catalogEntries.push(claude);
  harness.fakes.modelProvider.endpoints.set(BASE_URL, {
    token: TOKEN,
    apiFormat: "anthropic-messages",
    authScheme: "x-api-key",
    models: [
      { endpointModelId: "claude-sonnet-5", displayName: null, contextWindow: null },
      { endpointModelId: "house-model", displayName: "House model", contextWindow: 32_000 },
    ],
  });
});

afterAll(async () => {
  await harness.dispose();
});

const form = (over: Record<string, unknown> = {}) => ({
  name: "Models",
  baseUrl: BASE_URL,
  apiFormat: "anthropic-messages" as const,
  authScheme: "x-api-key" as const,
  sessionsAtOnce: null,
  allowOnPersonalRunners: false,
  token: TOKEN,
  ...over,
});

describe("providers.testConnection", () => {
  it("detects the format and lists the models, matched to the catalog or custom, without the token", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const result = await admin.providers.testConnection({ baseUrl: BASE_URL, token: TOKEN });
    expect(result).toMatchObject({ ok: true, apiFormat: "anthropic-messages", authScheme: "x-api-key" });
    if (!result.ok) {
      return;
    }
    const byId = new Map(result.models.map((model) => [model.endpointModelId, model] as const));
    expect(byId.get("claude-sonnet-5")?.match).toMatchObject({ kind: "catalog", name: "Claude Sonnet", logoPath: "/assets/models/anthropic.svg" });
    expect(byId.get("house-model")?.match).toEqual({ kind: "custom" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("reports a refused token as a result, not an error", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const result = await admin.providers.testConnection({ baseUrl: BASE_URL, token: "sk-wrong-token-000000000" });
    expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("refuses a URL with credentials in it, and is for admins", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    await expect(admin.providers.testConnection({ baseUrl: "https://user:secret@models.example.com/v1", token: TOKEN })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const member = await harness.as(harness.fixture.a.member);
    await expect(member.providers.testConnection({ baseUrl: BASE_URL, token: TOKEN })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(harness.anonymous().providers.testConnection({ baseUrl: BASE_URL, token: TOKEN })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("providers.create", () => {
  it("is for admins: a member is FORBIDDEN and nothing is stored", async () => {
    const before = harness.fakes.secretStore.entries.size;
    await expect((await harness.as(harness.fixture.a.member)).providers.create(form())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(harness.fakes.secretStore.entries.size).toBe(before);
  });

  it("refuses an endpoint that rejects the settings, and stores nothing", async () => {
    const before = harness.fakes.secretStore.entries.size;
    const admin = await harness.as(harness.fixture.a.admin);
    await expect(admin.providers.create(form({ name: "Bad", token: "sk-wrong-token-000000000" }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(harness.fakes.secretStore.entries.size).toBe(before);
    expect(await harness.test.db.modelProvider.count({ where: { name: "Bad" } })).toBe(0);
  });

  it("stores the token through the secret store, keeps its reference, lists the models and enqueues a refresh", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const { providerId } = await admin.providers.create(form());

    const row = await harness.test.db.modelProvider.findUniqueOrThrow({ where: { id: providerId } });
    expect(row.organizationId).toBe(a.organization.id);
    expect(row.apiFormat).toBe("anthropic_messages");
    expect(row.authScheme).toBe("x_api_key");
    expect(row.allowOnPersonalRunners).toBe(false);
    // The row holds a reference to the store, never the token.
    expect(row.tokenSecretRef).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(harness.fakes.secretStore.entries.get(row.tokenSecretRef)).toMatchObject({ organizationId: a.organization.id, value: TOKEN });

    // The catalog match happened at once: the models are rows, one matched, one custom.
    const models = await admin.providers.models({ providerId });
    expect(models.map((model) => [model.endpointModelId, model.custom])).toEqual([
      ["claude-sonnet-5", false],
      ["house-model", true],
    ]);
    expect(models[0]).toMatchObject({ displayName: "Claude Sonnet", contextWindow: 200_000, inputPricePerMTok: 3, logoPath: "/assets/models/anthropic.svg" });
    expect(models[1]).toMatchObject({ displayName: "House model", contextWindow: 32_000, logoPath: null });

    // The refresh job, keyed by the provider (ADR 0037), an audit entry and a change notice.
    const payload = { organizationId: a.organization.id, providerId: providerIdSchema.parse(providerId) };
    expect(harness.fakes.jobs.jobs).toContainEqual(
      expect.objectContaining({ job: "provider.refresh-models", key: jobKey("provider.refresh-models", payload) }),
    );
    expect(await harness.test.db.auditEntry.count({ where: { organizationId: a.organization.id, action: "provider.added" } })).toBe(1);
    expect(await harness.test.db.changeNotice.count({ where: { organizationId: a.organization.id, entity: "model-provider" } })).toBeGreaterThan(0);
    expect(JSON.stringify(await harness.test.db.auditEntry.findMany())).not.toContain(TOKEN);
  });

  it("refuses a second provider of the same name", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    await expect(admin.providers.create(form())).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("lets the form's format override the one detected: the endpoint is tried with what the form says", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    harness.fakes.modelProvider.endpoints.set("https://other.example.com/v1", {
      token: TOKEN,
      apiFormat: "openai-compatible",
      authScheme: "bearer",
      models: [],
    });
    const { providerId } = await admin.providers.create(
      form({ name: "Other", baseUrl: "https://other.example.com/v1", apiFormat: "openai-compatible", authScheme: "bearer" }),
    );
    expect((await harness.test.db.modelProvider.findUniqueOrThrow({ where: { id: providerId } })).apiFormat).toBe("openai_compatible");
  });
});

describe("providers.list, update and the organization boundary", () => {
  it("lists only the caller's organization, and never a token or a reference", async () => {
    const { a, b } = harness.fixture;
    const forA = await (await harness.as(a.admin)).providers.list();
    expect(forA.map((provider) => provider.name).sort()).toEqual(["Models", "Other"]);
    expect(JSON.stringify(forA)).not.toContain(TOKEN);
    expect(JSON.stringify(forA)).not.toContain("fake:");
    expect(await (await harness.as(b.admin)).providers.list()).toEqual([]);
    await expect((await harness.as(a.member)).providers.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is invisible to another organization: models, update and refresh say NOT_FOUND", async () => {
    const { a, b } = harness.fixture;
    const [first] = await (await harness.as(a.admin)).providers.list();
    if (first === undefined) {
      throw new Error("no provider");
    }
    const other = await harness.as(b.admin);
    await expect(other.providers.models({ providerId: first.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.providers.update({ providerId: first.id, allowOnPersonalRunners: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.providers.refresh({ providerId: first.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await harness.test.db.modelProvider.findUniqueOrThrow({ where: { id: first.id } })).allowOnPersonalRunners).toBe(false);
  });

  it("F-088: an admin sets a provider's sessions-at-once cap and 'allow on personal runners' (off by default), with an audit entry", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const [first] = await admin.providers.list();
    if (first === undefined) {
      throw new Error("no provider");
    }
    expect(first.allowOnPersonalRunners).toBe(false);
    const updated = await admin.providers.update({ providerId: first.id, allowOnPersonalRunners: true, sessionsAtOnce: 4 });
    expect(updated).toMatchObject({ allowOnPersonalRunners: true, sessionsAtOnce: 4 });
    await expect((await harness.as(a.member)).providers.update({ providerId: first.id, allowOnPersonalRunners: false })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(admin.providers.update({ providerId: first.id, name: "Other" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await harness.test.db.auditEntry.count({ where: { action: "provider.updated" } })).toBe(1);
  });
});

describe("custom models and the built-in profile's model", () => {
  const providerOf = async () => {
    const [first] = await (await harness.as(harness.fixture.a.admin)).providers.list();
    if (first === undefined) {
      throw new Error("no provider");
    }
    return first;
  };

  it("edits a custom model's name, limits and prices, and not a catalog model's", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const provider = await providerOf();
    const models = await admin.providers.models({ providerId: provider.id });
    const custom = models.find((model) => model.custom);
    const catalog = models.find((model) => !model.custom);
    if (custom === undefined || catalog === undefined) {
      throw new Error("expected one custom and one catalog model");
    }
    await admin.providers.updateModel({ modelId: custom.id, displayName: "Our model", maxOutputTokens: 4096, inputPricePerMTok: 0.5, outputPricePerMTok: 1.5 });
    const after = (await admin.providers.models({ providerId: provider.id })).find((model) => model.id === custom.id);
    expect(after).toMatchObject({ displayName: "Our model", maxOutputTokens: 4096, inputPricePerMTok: 0.5, outputPricePerMTok: 1.5 });
    await expect(admin.providers.updateModel({ modelId: catalog.id, displayName: "Mine" })).rejects.toMatchObject({ code: "CONFLICT" });
    // Another organization's admin can't reach it.
    await expect(
      (await harness.as(harness.fixture.b.admin)).providers.updateModel({ modelId: custom.id, displayName: "Theirs" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps the admin's edits through a refresh, and marks a model the endpoint dropped as unlisted", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const provider = await providerOf();
    harness.fakes.modelProvider.endpoints.set(BASE_URL, {
      token: TOKEN,
      apiFormat: "anthropic-messages",
      authScheme: "x-api-key",
      models: [{ endpointModelId: "house-model", displayName: "House model", contextWindow: 32_000 }],
    });
    expect(await admin.providers.refresh({ providerId: provider.id })).toEqual({ listed: 1, matched: 0 });
    const models = await admin.providers.models({ providerId: provider.id });
    expect(models.find((model) => model.endpointModelId === "house-model")).toMatchObject({ displayName: "Our model", listed: true });
    expect(models.find((model) => model.endpointModelId === "claude-sonnet-5")).toMatchObject({ listed: false });
  });

  it("sets the built-in OpenCode profile's model to a listed model, for admins", async () => {
    const { a, b } = harness.fixture;
    const admin = await harness.as(a.admin);
    await harness.test.db.$transaction((tx) => ensureBuiltInAgentProfile(tx, a.organization.id));
    await harness.test.db.$transaction((tx) => ensureBuiltInAgentProfile(tx, b.organization.id));
    const provider = await providerOf();
    const models = await admin.providers.models({ providerId: provider.id });
    const listed = models.find((model) => model.listed);
    const unlisted = models.find((model) => !model.listed);
    if (listed === undefined || unlisted === undefined) {
      throw new Error("expected a listed and an unlisted model");
    }

    await expect((await harness.as(a.member)).agentProfiles.setDefaultModel({ modelId: listed.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.agentProfiles.setDefaultModel({ modelId: unlisted.id })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(admin.agentProfiles.setDefaultModel({ modelId: modelIdSchema.parse("no-such-model") })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Another organization's admin can't point their profile at A's model.
    await expect((await harness.as(b.admin)).agentProfiles.setDefaultModel({ modelId: listed.id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await admin.agentProfiles.setDefaultModel({ modelId: listed.id });
    const profiles = await (await harness.as(a.member)).agentProfiles.list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ name: "OpenCode", adapter: "opencode", builtIn: true, model: { id: listed.id, providerName: "Models" } });
    // Organization B's profile has no model, and B sees nothing of A's.
    expect((await (await harness.as(b.admin)).agentProfiles.list())[0]?.model).toBeNull();
  });
});
