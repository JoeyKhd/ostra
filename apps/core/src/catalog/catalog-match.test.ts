import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { ModelEndpointAdapter } from "@ostra/adapter-model-endpoint";
import { silentLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { modelImageInput, modelNameKey, modelNameSchema, postgresChangeNotices, resolveProfileModelInTx, systemClock } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { organizationIdSchema, projectIdSchema, providerIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProviderId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { catalogSource, enqueueStaleProviderRefreshes, providerRefreshHandler, refreshCatalog } from "./catalog.ts";
import type { CatalogDeps } from "./catalog.ts";

// 2026-11-22 (ADR 0033, F-148): an install an older release matched to the wrong provider's
// catalog entry heals at its next refresh. The live instance's OpenRouter model
// `deepseek/deepseek-v4.1-flash-1017` had ambient's entry, the first in the catalog's order, which
// says text only. The real model endpoint adapter lists a stand-in for OpenRouter's `/models`
// (its host resolved to this machine) and matches against a small catalog the refresh stored; the
// real sync writes Postgres.

const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";
const CODER = "acme/coder-2";
const UNKNOWN = "acme/brand-new";
const TOKEN = `sk-or-${randomUUID()}`;

const entry = (id: string, inputs: readonly string[], extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  tool_call: true,
  limit: { context: 1_048_576, output: 384_000 },
  cost: { input: 0.1, output: 0.4 },
  modalities: { input: inputs, output: ["text"] },
  ...extra,
});

/** models.dev, cut down: ambient's text-only entries first in the catalog's order, OpenRouter's own with images, its prices and levels. */
const modelsDev = {
  ambient: {
    id: "ambient",
    api: "https://api.ambient.xyz/v1",
    models: {
      [DEEPSEEK]: entry(DEEPSEEK, ["text"], { cost: { input: 0.045, output: 0.25 }, reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }] }),
      [CODER]: entry(CODER, ["text"]),
    },
  },
  openrouter: {
    id: "openrouter",
    models: {
      [DEEPSEEK]: entry(DEEPSEEK, ["text", "image"], {
        limit: { context: 1_048_576, output: 393_216 },
        cost: { input: 0.15, output: 0.6 },
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "low", "high", "max"] }],
      }),
      [CODER]: entry(CODER, ["text", "image"]),
    },
  },
};

/** OpenRouter's `/models` as it answers: each model's `architecture.input_modalities`. */
const openRouterModels = {
  data: [DEEPSEEK, CODER, UNKNOWN].map((id) => ({
    id,
    name: id,
    context_length: 1_048_576,
    architecture: { modality: "text+image->text", input_modalities: ["text", "image"], output_modalities: ["text"] },
  })),
};

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let server: Server;
let port = 0;
let dataDir: string;
const fakes = { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() };
// Every host resolves to the stand-in, which a private address reaches only with the opt-in.
const modelProvider = new ModelEndpointAdapter({ allowPrivateNetwork: true, timeoutMs: 5_000, resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]) });

const deps = (): CatalogDeps => ({
  db: test.db,
  dataDir,
  catalogFetch: true,
  logger: silentLogger,
  catalogUrl: `http://127.0.0.1:${String(port)}/api.json`,
  logosUrl: `http://127.0.0.1:${String(port)}/logos`,
});

const refresh = (organizationId: OrganizationId, providerId: ProviderId) =>
  providerRefreshHandler({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, adapters: { ...fakes, modelProvider }, catalog: catalogSource(deps()) })({
    job: "provider.refresh-models",
    jobId: jobIdSchema.parse(randomUUID()),
    key: null,
    retryCount: 0,
    payload: { organizationId, providerId },
    logger: silentLogger,
  });

/** An OpenRouter key, on the organization's default list, with its token in the secret store. */
const seedOpenRouter = async (organizationId: OrganizationId): Promise<ProviderId> => {
  const ref = await fakes.secretStore.put({ organizationId, purpose: "model-provider.token" }, TOKEN);
  if (!ref.ok) throw new Error("the fake secret store refused");
  const provider = await test.db.modelProvider.create({
    data: { organizationId, name: `OpenRouter ${randomUUID().slice(0, 6)}`, baseUrl: `http://openrouter.ai:${String(port)}/api/v1`, apiFormat: "openai_compatible", authScheme: "bearer", tokenSecretRef: ref.value },
  });
  await test.db.providerListEntry.create({ data: { organizationId, projectId: null, providerId: provider.id } });
  return providerIdSchema.parse(provider.id);
};

/** A model row as a release before 2026-11-22 left it: ambient's entry, its inputs, prices and levels. */
const seedWrongMatch = (organizationId: OrganizationId, providerId: string, endpointModelId: string, extra: { readonly adminImageInput?: boolean } = {}) =>
  test.db.model.create({
    data: {
      organizationId,
      providerId,
      endpointModelId,
      catalogId: `ambient/${endpointModelId}`,
      displayName: endpointModelId,
      contextWindow: 1_048_576,
      maxOutputTokens: 384_000,
      inputPricePerMTok: 0.045,
      outputPricePerMTok: 0.25,
      catalogReasoning: { supported: true, toggle: true, effort: ["low", "high", "max"] },
      catalogInputModalities: ["text"],
      ...extra,
    },
  });

const catalogKey = (catalogId: string): string => modelNameKey(modelNameSchema.parse({ kind: "catalog", catalogId }));

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  server = createServer((request, response) => {
    if (request.url === "/api.json") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(modelsDev));
      return;
    }
    if (request.url === "/api/v1/models") {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(openRouterModels));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : 0;
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-catalog-match-"));
  expect(await refreshCatalog(deps())).toBe("stored");
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
  await rm(dataDir, { recursive: true, force: true });
});

describe("a refresh heals a model matched to another provider's entry", () => {
  it("F-148/c5: OpenRouter's model gets OpenRouter's own entry: it reads images, at OpenRouter's prices and levels; an admin's word stays and wins, and what named the old entry follows", async () => {
    const organizationId = organizationIdSchema.parse(fixture.a.organization.id);
    const projectId = projectIdSchema.parse(fixture.a.openProject.id);
    const providerId = await seedOpenRouter(organizationId);
    const deepseek = await seedWrongMatch(organizationId, providerId, DEEPSEEK);
    // An admin said this one doesn't read images, over the catalog's word.
    const coder = await seedWrongMatch(organizationId, providerId, CODER, { adminImageInput: false });
    // A profile on this key, and the default list's choice, by the old name.
    const profile = await test.db.agentProfile.create({ data: { organizationId, name: "On OpenRouter", adapter: "opencode", providerId, modelCatalogId: `ambient/${DEEPSEEK}` } });
    await test.db.modelChoice.create({
      data: { organizationId, projectId: null, modelKey: catalogKey(`ambient/${DEEPSEEK}`), modelCatalogId: `ambient/${DEEPSEEK}`, modelId: deepseek.id, reason: "admin" },
    });
    expect(modelImageInput(deepseek)).toBe("no");

    await refresh(organizationId, providerId);

    const healed = await test.db.model.findUniqueOrThrow({ where: { id: deepseek.id } });
    expect({
      catalogId: healed.catalogId,
      inputs: healed.catalogInputModalities,
      prices: [healed.inputPricePerMTok?.toNumber(), healed.outputPricePerMTok?.toNumber()],
      priceSource: healed.priceSource,
      maxOutputTokens: healed.maxOutputTokens,
      reasoning: healed.catalogReasoning,
    }).toEqual({
      catalogId: `openrouter/${DEEPSEEK}`,
      inputs: ["text", "image"],
      prices: [0.15, 0.6],
      priceSource: "catalog",
      maxOutputTokens: 393_216,
      reasoning: { supported: true, effort: ["none", "low", "high", "max"] },
    });
    expect(modelImageInput(healed)).toBe("yes");

    // The admin's "Reads images" is never written: the catalog's word changes beside it, and it still wins.
    const overridden = await test.db.model.findUniqueOrThrow({ where: { id: coder.id } });
    expect([overridden.catalogId, overridden.catalogInputModalities, overridden.adminImageInput, modelImageInput(overridden)]).toEqual([`openrouter/${CODER}`, ["text", "image"], false, "no"]);

    // A model models.dev doesn't know takes what OpenRouter's own list says.
    const custom = await test.db.model.findFirstOrThrow({ where: { providerId, endpointModelId: UNKNOWN } });
    expect([custom.catalogId, custom.catalogInputModalities, modelImageInput(custom)]).toEqual([null, ["text", "image"], "yes"]);

    // The profile and the choice name the model by its new entry, and the profile still runs on its row.
    expect((await test.db.agentProfile.findUniqueOrThrow({ where: { id: profile.id } })).modelCatalogId).toBe(`openrouter/${DEEPSEEK}`);
    expect(await test.db.modelChoice.findMany({ where: { organizationId }, select: { modelKey: true, modelCatalogId: true, modelId: true } })).toEqual([
      { modelKey: catalogKey(`openrouter/${DEEPSEEK}`), modelCatalogId: `openrouter/${DEEPSEEK}`, modelId: deepseek.id },
    ]);
    expect(await resolveProfileModelInTx(test.db, { organizationId, projectId, profileId: profile.id })).toMatchObject({ ok: true, providerId, modelId: deepseek.id });

    // A second refresh keeps it all as it is.
    await refresh(organizationId, providerId);
    expect((await test.db.model.findUniqueOrThrow({ where: { id: deepseek.id } })).catalogId).toBe(`openrouter/${DEEPSEEK}`);
    expect((await test.db.agentProfile.findUniqueOrThrow({ where: { id: profile.id } })).modelCatalogId).toBe(`openrouter/${DEEPSEEK}`);
    expect(await test.db.modelChoice.count({ where: { organizationId, modelKey: catalogKey(`openrouter/${DEEPSEEK}`) } })).toBe(1);
  });

  it("F-135/c6: a refresh that renames a model moves nothing to another provider: a name another key still serves keeps its profiles and its choice", async () => {
    const organizationId = organizationIdSchema.parse(fixture.b.organization.id);
    const projectId = projectIdSchema.parse(fixture.b.project.id);
    const openRouter = await seedOpenRouter(organizationId);
    // Ambient's own endpoint, which still serves the old name, chosen for it on the default list.
    const ambient = await test.db.modelProvider.create({
      data: { organizationId, name: "Ambient", baseUrl: `http://api.ambient.xyz:${String(port)}/v1`, apiFormat: "openai_compatible", authScheme: "bearer", tokenSecretRef: "fake:none" },
    });
    await test.db.providerListEntry.create({ data: { organizationId, projectId: null, providerId: ambient.id } });
    const onOpenRouter = await seedWrongMatch(organizationId, openRouter, DEEPSEEK);
    const onAmbient = await seedWrongMatch(organizationId, ambient.id, DEEPSEEK);
    await test.db.modelChoice.create({
      data: { organizationId, projectId: null, modelKey: catalogKey(`ambient/${DEEPSEEK}`), modelCatalogId: `ambient/${DEEPSEEK}`, modelId: onAmbient.id, reason: "admin" },
    });
    const pinned = await test.db.agentProfile.create({ data: { organizationId, name: "Pinned", adapter: "opencode", providerId: openRouter, modelCatalogId: `ambient/${DEEPSEEK}` } });
    const byName = await test.db.agentProfile.create({ data: { organizationId, name: "By name", adapter: "opencode", modelCatalogId: `ambient/${DEEPSEEK}` } });
    expect(await resolveProfileModelInTx(test.db, { organizationId, projectId, profileId: byName.id })).toMatchObject({ ok: true, modelId: onAmbient.id });

    await refresh(organizationId, openRouter);

    expect((await test.db.model.findUniqueOrThrow({ where: { id: onOpenRouter.id } })).catalogId).toBe(`openrouter/${DEEPSEEK}`);
    // The profile on OpenRouter follows its row; the one by name stays on the key that serves it.
    expect((await test.db.agentProfile.findUniqueOrThrow({ where: { id: pinned.id } })).modelCatalogId).toBe(`openrouter/${DEEPSEEK}`);
    expect((await test.db.agentProfile.findUniqueOrThrow({ where: { id: byName.id } })).modelCatalogId).toBe(`ambient/${DEEPSEEK}`);
    expect(await resolveProfileModelInTx(test.db, { organizationId, projectId, profileId: pinned.id })).toMatchObject({ ok: true, providerId: openRouter, modelId: onOpenRouter.id });
    expect(await resolveProfileModelInTx(test.db, { organizationId, projectId, profileId: byName.id })).toMatchObject({ ok: true, modelId: onAmbient.id });
    expect(await test.db.modelChoice.findMany({ where: { organizationId }, select: { modelKey: true, modelId: true } })).toEqual([{ modelKey: catalogKey(`ambient/${DEEPSEEK}`), modelId: onAmbient.id }]);
  });
});

describe("core's start: a refresh for a provider an upgrade left stale", () => {
  const sweep = (queue: Pick<Jobs, "enqueueInTx">) => enqueueStaleProviderRefreshes({ db: test.db, jobs: queue, adapters: { modelProvider }, catalog: catalogSource(deps()), logger: silentLogger });

  it("F-148/c5: an upgraded install's empty inputs fill without a press: one refresh across two replicas, and an admin's word untouched", async () => {
    const organizationId = organizationIdSchema.parse(fixture.a.organization.id);
    const upgraded = await seedOpenRouter(organizationId);
    // As an install upgraded past milestone 9's ticket 11 has them: the right entries, no inputs yet.
    const plain = await test.db.model.create({ data: { organizationId, providerId: upgraded, endpointModelId: DEEPSEEK, catalogId: `openrouter/${DEEPSEEK}` } });
    const overridden = await test.db.model.create({ data: { organizationId, providerId: upgraded, endpointModelId: CODER, catalogId: `openrouter/${CODER}`, adminImageInput: false } });
    // An older release's match to another provider's entry is stale too.
    const misMatched = await seedOpenRouter(organizationId);
    await seedWrongMatch(organizationId, misMatched, DEEPSEEK);
    // Up to date: nothing to do.
    const current = await seedOpenRouter(organizationId);
    await test.db.model.create({ data: { organizationId, providerId: current, endpointModelId: DEEPSEEK, catalogId: `openrouter/${DEEPSEEK}`, catalogInputModalities: ["text", "image"] } });
    expect([modelImageInput(plain), modelImageInput(overridden)]).toEqual(["unknown", "no"]);

    // Two replicas start at once: each queues the refresh, and the provider's key keeps one.
    const replica = createJobs({ databaseUrl: test.url, role: "enqueue-only" });
    await replica.start();
    try {
      await Promise.all([sweep(jobs), sweep(replica)]);
    } finally {
      await replica.stop({ graceful: false, timeoutMs: 2_000 });
    }
    const payload = (providerId: ProviderId) => ({ organizationId, providerId });
    expect((await jobs.find("provider.refresh-models", payload(upgraded))).length).toBe(1);
    expect((await jobs.find("provider.refresh-models", payload(misMatched))).length).toBe(1);
    expect(await jobs.find("provider.refresh-models", payload(current))).toEqual([]);

    // The worker runs the real refresh; nobody pressed anything.
    await jobs.work(
      "provider.refresh-models",
      providerRefreshHandler({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, adapters: { ...fakes, modelProvider }, catalog: catalogSource(deps()) }),
      { localConcurrency: 1 },
    );
    await vi.waitFor(
      async () => {
        expect((await test.db.model.findUniqueOrThrow({ where: { id: plain.id } })).catalogInputModalities).toEqual(["text", "image"]);
        expect((await jobs.find("provider.refresh-models", payload(misMatched))).map((job) => job.state)).toEqual(["completed"]);
      },
      { timeout: 20_000, interval: 250 },
    );
    const filled = await test.db.model.findUniqueOrThrow({ where: { id: plain.id } });
    const kept = await test.db.model.findUniqueOrThrow({ where: { id: overridden.id } });
    expect([modelImageInput(filled), kept.catalogInputModalities, kept.adminImageInput, modelImageInput(kept)]).toEqual(["yes", ["text", "image"], false, "no"]);
    expect((await test.db.model.findFirstOrThrow({ where: { providerId: misMatched, endpointModelId: DEEPSEEK } })).catalogId).toBe(`openrouter/${DEEPSEEK}`);
    expect((await jobs.find("provider.refresh-models", payload(upgraded))).map((job) => job.state)).toEqual(["completed"]);

    // The next start finds nothing stale on them, and queues nothing again.
    await sweep(jobs);
    expect((await jobs.find("provider.refresh-models", payload(upgraded))).length).toBe(1);
    expect((await jobs.find("provider.refresh-models", payload(misMatched))).length).toBe(1);
    expect(await jobs.find("provider.refresh-models", payload(current))).toEqual([]);
  });
});
