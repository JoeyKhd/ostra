import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
import { loadBundledCatalog } from "@ostra/adapter-model-endpoint";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { parseServerSettings, postgresChangeNotices, systemClock } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { organizationIdSchema, providerIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { PROVIDER_TOKEN, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { CATALOG_FILE, catalogRefreshHandler, catalogSource, ensureSchedules, LOGO_DIR, providerRefreshHandler, refreshCatalog } from "./catalog.ts";
import type { CatalogDeps } from "./catalog.ts";

// Ticket 28's cases, with a fake catalog server that counts what it's asked.

const catalog = {
  acme: {
    id: "acme",
    name: "Acme",
    models: { "acme-1": { id: "acme-1", name: "Acme One", limit: { context: 8000, output: 800 }, cost: { input: 1, output: 2 } } },
  },
};
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>';

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let server: Server;
let baseUrl: string;
let dataDir: string;
let mode: "ok" | "fail" | "garbage" = "ok";
const requests: { readonly path: string; readonly headers: Readonly<Record<string, string | string[] | undefined>> }[] = [];
const modelProvider = new FakeModelProvider();
const fakes = { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() };

const deps = (catalogFetch = true): CatalogDeps => ({
  db: test.db,
  dataDir,
  catalogFetch,
  logger: silentLogger,
  catalogUrl: `${baseUrl}/api.json`,
  logosUrl: `${baseUrl}/logos`,
});

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, fakes, fixture.a.organization.id, fixture.a.openProject.id);
  modelProvider.endpoints.set("https://models.example/v1", {
    token: PROVIDER_TOKEN,
    models: [
      { endpointModelId: "acme-1", displayName: null, contextWindow: null },
      { endpointModelId: "our-own-finetune", displayName: null, contextWindow: null },
    ],
  });
  server = createServer((request, response) => {
    requests.push({ path: request.url ?? "", headers: request.headers });
    if (mode === "fail") {
      response.writeHead(500).end();
      return;
    }
    if (request.url === "/api.json") {
      response.writeHead(200, { "content-type": "application/json" }).end(mode === "garbage" ? '{"not":"a catalog"}' : JSON.stringify(catalog));
      return;
    }
    if (request.url === "/logos/acme.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml" }).end(LOGO);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${String(typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : 0)}`;
});

beforeEach(async () => {
  requests.length = 0;
  mode = "ok";
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-catalog-"));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const refreshModels = (organizationId: string, providerId: string) =>
  providerRefreshHandler({
    db: test.db,
    jobs,
    notices: postgresChangeNotices,
    clock: systemClock,
    adapters: { ...fakes, modelProvider },
    catalog: catalogSource(deps()),
  })({
    job: "provider.refresh-models",
    jobId: jobIdSchema.parse(randomUUID()),
    key: null,
    retryCount: 0,
    payload: { organizationId: organizationIdSchema.parse(organizationId), providerId: providerIdSchema.parse(providerId) },
    logger: silentLogger,
  });

describe("catalog.refresh", () => {
  it("stores the fetched copy with a plain GET, and the provider refresh matches against it; the logos follow", async () => {
    expect(await refreshCatalog(deps())).toBe("stored");
    expect(requests[0]?.path).toBe("/api.json");
    expect(Object.keys(requests[0]?.headers ?? {}).filter((name) => !["host", "connection", "accept-encoding", "user-agent", "sec-fetch-mode", "accept-language"].includes(name))).toEqual(["accept"]);
    const stored: unknown = JSON.parse(await readFile(path.join(dataDir, CATALOG_FILE), "utf8"));
    expect(Reflect.get(Object(stored), "providers")).toEqual(catalog);

    await refreshModels(world.organizationId, world.providerId);
    const models = await test.db.model.findMany({ where: { providerId: world.providerId }, orderBy: { endpointModelId: "asc" } });
    expect(models.map((model) => [model.endpointModelId, model.catalogId])).toEqual([
      ["acme-1", "acme/acme-1"],
      ["dev-model-1", null],
      ["our-own-finetune", null],
    ]);

    // With a model matched to acme, the next refresh keeps acme's logo for the panel to serve.
    expect(await refreshCatalog(deps())).toBe("stored");
    expect(await readFile(path.join(dataDir, LOGO_DIR, "acme.svg"), "utf8")).toBe(LOGO);
  });

  it("keeps the last good copy when a fetch fails or brings garbage", async () => {
    expect(await refreshCatalog(deps())).toBe("stored");
    const file = path.join(dataDir, CATALOG_FILE);
    const before = await stat(file);
    mode = "fail";
    expect(await refreshCatalog(deps())).toBe("failed");
    mode = "garbage";
    expect(await refreshCatalog(deps())).toBe("failed");
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    const entries = await catalogSource(deps())();
    expect(entries.map((entry) => entry.catalogId)).toEqual(["acme/acme-1"]);
  });

  it("with the fetch off makes no request, and the bundled copy is served", async () => {
    expect(await refreshCatalog(deps(false))).toBe("off");
    expect(requests).toEqual([]);
    const entries = await catalogSource(deps(false))();
    expect(entries.length).toBe((await loadBundledCatalog()).entries.length);
    expect(entries.length).toBeGreaterThan(0);
    // No schedule either.
    await ensureSchedules({ db: test.db, jobs, catalogFetch: false });
    expect(await test.db.$queryRaw<readonly unknown[]>`SELECT 1 FROM pgboss.schedule WHERE name = 'catalog.refresh'`).toEqual([]);
  });
});

describe("F-088: the catalog on the server", () => {
  const scheduleOf = async (name: string) =>
    z
      .array(z.object({ key: z.string(), cron: z.string() }))
      .parse(await test.db.$queryRaw<readonly unknown[]>`SELECT key, cron FROM pgboss.schedule WHERE name = ${name}`);
  const refreshJob = () => ({ job: "catalog.refresh" as const, jobId: jobIdSchema.parse(randomUUID()), key: "daily", retryCount: 0, payload: {}, logger: silentLogger });

  it("F-088: the server fetches the catalog on a daily schedule, keeps it, and keeps the logos of the providers its models matched", async () => {
    // The schedule core sets at start: one `catalog.refresh`, every day at one fixed time.
    await ensureSchedules({ db: test.db, jobs, catalogFetch: true });
    const [schedule] = await scheduleOf("catalog.refresh");
    expect(schedule?.key).toBe("daily");
    expect(schedule?.cron).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);

    // The scheduled job's handler: it fetches models.dev and keeps the copy, which the routers then read.
    const handle = catalogRefreshHandler(deps());
    await handle(refreshJob());
    expect(requests.map((request) => request.path)).toContain("/api.json");
    expect((await catalogSource(deps())()).map((entry) => entry.catalogId)).toEqual(["acme/acme-1"]);

    // A model matched to acme: the next run keeps acme's logo where the panel's /model-logos/ route reads.
    await refreshModels(world.organizationId, world.providerId);
    await handle(refreshJob());
    expect(requests.map((request) => request.path)).toContain("/logos/acme.svg");
    expect(await readFile(path.join(dataDir, LOGO_DIR, "acme.svg"), "utf8")).toBe(LOGO);
    // And the catalog points every logo at ostra's own server, never the vendor's.
    expect((await catalogSource(deps())()).map((entry) => entry.logoPath)).toEqual(["/model-logos/acme.svg"]);
  });

  it("F-088: one setting, OSTRA_CATALOG_FETCH=false, turns the fetch off: no request, no schedule, and the bundled copy is served", async () => {
    const parsed = parseServerSettings({ OSTRA_CATALOG_FETCH: "false" });
    if (!parsed.ok) {
      throw new Error(parsed.errors.join("\n"));
    }
    const off = { ...deps(), catalogFetch: parsed.settings.catalogFetch };
    await ensureSchedules({ db: test.db, jobs, catalogFetch: true });
    await ensureSchedules({ db: test.db, jobs, catalogFetch: off.catalogFetch });
    expect(await scheduleOf("catalog.refresh")).toEqual([]);
    await catalogRefreshHandler(off)(refreshJob());
    expect(requests).toEqual([]);
    // The copy that ships with ostra, dated, with the whole catalog in it.
    const bundled = await loadBundledCatalog();
    expect(Date.parse(bundled.fetchedAt)).toBeGreaterThan(Date.parse("2026-01-01"));
    expect(bundled.entries.length).toBeGreaterThan(1000);
    expect((await catalogSource(off)()).map((entry) => entry.catalogId)).toEqual(bundled.entries.map((entry) => entry.catalogId));
    // Unset, the fetch is on.
    const unset = parseServerSettings({});
    expect(unset.ok && unset.settings.catalogFetch).toBe(true);
  });
});

describe("provider.refresh-models", () => {
  it("is scheduled daily per provider, and another organization's provider is out of reach", async () => {
    await ensureSchedules({ db: test.db, jobs, catalogFetch: true });
    const rows = z
      .array(z.object({ name: z.string(), key: z.string() }))
      .parse(await test.db.$queryRaw<readonly unknown[]>`SELECT name, key FROM pgboss.schedule ORDER BY name, key`);
    expect(rows).toContainEqual({ name: "catalog.refresh", key: "daily" });
    expect(rows).toContainEqual({ name: "provider.refresh-models", key: world.providerId });

    const other = await test.db.modelProvider.create({
      data: { organizationId: fixture.b.organization.id, name: "theirs", baseUrl: "https://models.example/v1", apiFormat: "openai_compatible", authScheme: "bearer", tokenSecretRef: "fake:none" },
    });
    // Named under our organization, their provider is not found: nothing of theirs changes.
    await refreshModels(world.organizationId, other.id);
    expect(await test.db.model.count({ where: { providerId: other.id } })).toBe(0);
  });
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
