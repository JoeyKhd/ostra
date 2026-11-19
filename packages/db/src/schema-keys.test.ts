import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { mapModelChoice, mapProviderListEntry, mapSession } from "./mappers.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Keys per project's migration (milestone 4's ticket 45, spec section 5.5, ADR 0065): the lists,
// the choices, the profile's model by name and the session's resolved provider, their keys and
// unique indexes, and the upgrade's backfill on a milestone 4 database.

let test: TestDatabase;
let fixture: IsolationFixture;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

const keysMigration = "20261121010000_keys_per_project";
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
const migrationSql = (name: string): Promise<string> => readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");

const providerOf = async (organizationId: string, name: string) => {
  const provider = await test.db.modelProvider.create({
    data: { organizationId, name: `${name}-${randomUUID().slice(0, 6)}`, baseUrl: "https://models.example.com", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "ref" },
  });
  const model = await test.db.model.create({ data: { organizationId, providerId: provider.id, endpointModelId: "claude-sonnet", catalogId: "anthropic/claude-sonnet" } });
  return { provider, model };
};

describe("the keys-per-project migration", () => {
  it("F-135: refuses a list or a choice naming another organization's provider or model", async () => {
    const a = fixture.a.organization.id;
    const theirs = await providerOf(fixture.b.organization.id, "client-b");
    const attempts: readonly (() => Promise<unknown>)[] = [
      // A's default list naming B's provider.
      () => test.db.providerListEntry.create({ data: { organizationId: a, projectId: null, providerId: theirs.provider.id } }),
      // A's project list naming B's provider.
      () => test.db.providerListEntry.create({ data: { organizationId: a, projectId: fixture.a.openProject.id, providerId: theirs.provider.id } }),
      // A's list on B's project.
      () => test.db.providerListEntry.create({ data: { organizationId: a, projectId: fixture.b.project.id, providerId: theirs.provider.id } }),
      // A choice in A of B's model row.
      () =>
        test.db.modelChoice.create({
          data: { organizationId: a, projectId: null, modelKey: "catalog:anthropic/claude-sonnet", modelCatalogId: "anthropic/claude-sonnet", modelId: theirs.model.id, reason: "admin" },
        }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ code: "P2003" });
    }
    // A session of A's that names B's provider or model is refused too.
    const task = await test.db.task.create({
      data: { organizationId: a, projectId: fixture.a.openProject.id, kind: "code", source: "prompt", title: "x", prompt: "x", branchName: `ostra/k-${randomUUID().slice(0, 8)}` },
    });
    await expect(
      test.db.session.create({ data: { organizationId: a, projectId: fixture.a.openProject.id, taskId: task.id, origin: "new", providerId: theirs.provider.id } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      test.db.session.create({ data: { organizationId: a, projectId: fixture.a.openProject.id, taskId: task.id, origin: "new", modelId: theirs.model.id } }),
    ).rejects.toMatchObject({ code: "P2003" });
    // The same rows with A's own provider are stored.
    const ours = await providerOf(a, "client-a");
    const entry = await test.db.providerListEntry.create({ data: { organizationId: a, projectId: fixture.a.openProject.id, providerId: ours.provider.id } });
    expect(mapProviderListEntry(entry).projectId).toBe(fixture.a.openProject.id);
    const session = await test.db.session.create({
      data: { organizationId: a, projectId: fixture.a.openProject.id, taskId: task.id, origin: "new", providerId: ours.provider.id, modelId: ours.model.id },
    });
    expect(mapSession(session)).toMatchObject({ providerId: ours.provider.id, modelId: ours.model.id });
  });

  it("F-135: each unique index refuses its duplicate, the default list's and default choice's where projectId is null", async () => {
    const a = fixture.a.organization.id;
    const { provider, model } = await providerOf(a, "dup");
    const twice = async (create: () => Promise<unknown>): Promise<void> => {
      await create();
      await expect(create()).rejects.toMatchObject({ code: "P2002" });
    };
    await twice(() => test.db.providerListEntry.create({ data: { organizationId: a, projectId: null, providerId: provider.id } }));
    await twice(() => test.db.providerListEntry.create({ data: { organizationId: a, projectId: fixture.a.restrictedProject.id, providerId: provider.id } }));
    const choice = { modelKey: "catalog:anthropic/claude-sonnet", modelCatalogId: "anthropic/claude-sonnet", modelId: model.id, reason: "admin" } as const;
    await twice(() => test.db.modelChoice.create({ data: { organizationId: a, projectId: null, ...choice } }));
    await twice(() => test.db.modelChoice.create({ data: { organizationId: a, projectId: fixture.a.restrictedProject.id, ...choice } }));
    const row = await test.db.modelChoice.findFirstOrThrow({ where: { organizationId: a, projectId: null, modelKey: choice.modelKey } });
    expect(mapModelChoice(row)).toMatchObject({ projectId: null, needsConfirm: false });
  });

  it("refuses a model name stored two ways, or a key that doesn't match it", async () => {
    const a = fixture.a.organization.id;
    const { model } = await providerOf(a, "checks");
    await expect(
      test.db.agentProfile.create({ data: { organizationId: a, name: `p-${randomUUID()}`, adapter: "opencode", modelCatalogId: "x/y", modelCustomName: "y" } }),
    ).rejects.toThrow();
    await expect(
      test.db.modelChoice.create({ data: { organizationId: a, projectId: fixture.a.openProject.id, modelKey: "catalog:other", modelCatalogId: "x/y", modelId: model.id, reason: "admin" } }),
    ).rejects.toThrow();
    await expect(
      test.db.modelChoice.create({ data: { organizationId: a, projectId: fixture.a.openProject.id, modelKey: "custom:y", modelCatalogId: "x/y", modelCustomName: "y", modelId: model.id, reason: "admin" } }),
    ).rejects.toThrow();
    const project = await test.db.project.findUniqueOrThrow({ where: { id: fixture.a.openProject.id } });
    expect(project.ownProviders).toBe(false);
  });
});

// ---------- the upgrade: a milestone 4 database with providers, profiles, projects and sessions ----------

const withClient = async <T,>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const rowsOf = async (client: pg.Client, sql: string): Promise<unknown> => (await client.query(sql)).rows;

describe("upgrading a milestone 4 database", () => {
  const serverUrl = inject("ostraDbServerUrl");
  const name = `ostra_upgrade_keys_${randomUUID().slice(0, 8)}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const upgradeUrl = url.toString();

  afterAll(async () => {
    await withClient(serverUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
  });

  it("F-135: puts every provider on its default list, names each profile's model, records each session's provider, and marks a model two profiles named on different providers", async () => {
    await withClient(serverUrl, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
    const all = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(all).toContain(keysMigration);
    await withClient(upgradeUrl, async (client) => {
      for (const migration of all.filter((entry) => entry < keysMigration)) {
        await client.query(await migrationSql(migration));
      }
      // Two organizations. A has two providers serving the same catalog model, and a custom model;
      // two profiles name the catalog model on different providers. B has one provider and profile.
      await client.query(`
        INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-a', 'A', 'a', now()), ('org-b', 'B', 'b', now());
        INSERT INTO "model_provider" (id, "organizationId", name, "baseUrl", "apiFormat", "authScheme", "tokenSecretRef", "updatedAt")
          VALUES ('prov-a1', 'org-a', 'Client one', 'https://one.example.com', 'anthropic_messages', 'x_api_key', 'ref', now()),
                 ('prov-a2', 'org-a', 'Client two', 'https://two.example.com', 'anthropic_messages', 'x_api_key', 'ref', now()),
                 ('prov-b1', 'org-b', 'B key', 'https://b.example.com', 'openai_compatible', 'bearer', 'ref', now());
        INSERT INTO "model" (id, "organizationId", "providerId", "endpointModelId", "catalogId", "updatedAt")
          VALUES ('m-a1-sonnet', 'org-a', 'prov-a1', 'claude-sonnet', 'anthropic/claude-sonnet', now()),
                 ('m-a2-sonnet', 'org-a', 'prov-a2', 'sonnet-latest', 'anthropic/claude-sonnet', now()),
                 ('m-a2-custom', 'org-a', 'prov-a2', 'in-house-7b', NULL, now()),
                 ('m-b1-gpt', 'org-b', 'prov-b1', 'gpt-x', 'openai/gpt-x', now());
        INSERT INTO "agent_profile" (id, "organizationId", name, adapter, "modelId", "createdAt", "updatedAt")
          VALUES ('prof-a-old', 'org-a', 'Old', 'opencode', 'm-a1-sonnet', now() - interval '2 days', now()),
                 ('prof-a-new', 'org-a', 'New', 'opencode', 'm-a2-sonnet', now() - interval '1 day', now()),
                 ('prof-a-custom', 'org-a', 'Custom', 'opencode', 'm-a2-custom', now(), now()),
                 ('prof-a-none', 'org-a', 'None', 'opencode', NULL, now(), now()),
                 ('prof-b', 'org-b', 'B', 'opencode', 'm-b1-gpt', now(), now());
        INSERT INTO "project" (id, "organizationId", name, slug, "updatedAt") VALUES ('proj-a', 'org-a', 'A', 'a', now()), ('proj-b', 'org-b', 'B', 'b', now());
        INSERT INTO "task" (id, "organizationId", "projectId", kind, source, title, prompt, "branchName", "agentProfileId", "updatedAt")
          VALUES ('task-a-old', 'org-a', 'proj-a', 'code', 'prompt', 'x', 'x', 'ostra/a-old', 'prof-a-old', now()),
                 ('task-a-custom', 'org-a', 'proj-a', 'code', 'prompt', 'x', 'x', 'ostra/a-custom', 'prof-a-custom', now()),
                 ('task-b', 'org-b', 'proj-b', 'code', 'prompt', 'x', 'x', 'ostra/b', 'prof-b', now());
        INSERT INTO "session" (id, "organizationId", "projectId", "taskId", "agentProfileId", origin, state, "updatedAt")
          VALUES ('sess-a-old', 'org-a', 'proj-a', 'task-a-old', 'prof-a-old', 'new', 'stopped', now()),
                 ('sess-a-custom', 'org-a', 'proj-a', 'task-a-custom', 'prof-a-custom', 'new', 'stopped', now()),
                 ('sess-b', 'org-b', 'proj-b', 'task-b', 'prof-b', 'new', 'starting', now()),
                 ('sess-none', 'org-a', 'proj-a', 'task-a-custom', NULL, 'new', 'stopped', now() - interval '1 hour');
      `);
      for (const migration of all.filter((entry) => entry >= keysMigration)) {
        await client.query(await migrationSql(migration));
      }

      expect(await rowsOf(client, `SELECT "organizationId", "projectId", "providerId" FROM "provider_list_entry" ORDER BY "providerId"`)).toEqual([
        { organizationId: "org-a", projectId: null, providerId: "prov-a1" },
        { organizationId: "org-a", projectId: null, providerId: "prov-a2" },
        { organizationId: "org-b", projectId: null, providerId: "prov-b1" },
      ]);
      expect(await rowsOf(client, `SELECT id, "modelCatalogId", "modelCustomName", "modelId" FROM "agent_profile" ORDER BY id`)).toEqual([
        { id: "prof-a-custom", modelCatalogId: null, modelCustomName: "in-house-7b", modelId: "m-a2-custom" },
        { id: "prof-a-new", modelCatalogId: "anthropic/claude-sonnet", modelCustomName: null, modelId: "m-a2-sonnet" },
        { id: "prof-a-none", modelCatalogId: null, modelCustomName: null, modelId: null },
        { id: "prof-a-old", modelCatalogId: "anthropic/claude-sonnet", modelCustomName: null, modelId: "m-a1-sonnet" },
        { id: "prof-b", modelCatalogId: "openai/gpt-x", modelCustomName: null, modelId: "m-b1-gpt" },
      ]);
      // The oldest profile's row is the default choice; the model two profiles named on two
      // providers is marked for an admin, and the others aren't.
      expect(await rowsOf(client, `SELECT "organizationId", "projectId", "modelKey", "modelId", reason::text AS reason, "needsConfirm" FROM "model_choice" ORDER BY "organizationId", "modelKey"`)).toEqual([
        { organizationId: "org-a", projectId: null, modelKey: "catalog:anthropic/claude-sonnet", modelId: "m-a1-sonnet", reason: "upgrade", needsConfirm: true },
        { organizationId: "org-a", projectId: null, modelKey: "custom:in-house-7b", modelId: "m-a2-custom", reason: "upgrade", needsConfirm: false },
        { organizationId: "org-b", projectId: null, modelKey: "catalog:openai/gpt-x", modelId: "m-b1-gpt", reason: "upgrade", needsConfirm: false },
      ]);
      expect(await rowsOf(client, `SELECT id, "providerId", "modelId" FROM "session" ORDER BY id`)).toEqual([
        { id: "sess-a-custom", providerId: "prov-a2", modelId: "m-a2-custom" },
        { id: "sess-a-old", providerId: "prov-a1", modelId: "m-a1-sonnet" },
        { id: "sess-b", providerId: "prov-b1", modelId: "m-b1-gpt" },
        { id: "sess-none", providerId: null, modelId: null },
      ]);
      expect(await rowsOf(client, `SELECT count(*)::int AS n FROM "project" WHERE "ownProviders"`)).toEqual([{ n: 0 }]);

      // Running the backfill again changes nothing.
      const sql = await migrationSql(keysMigration);
      const start = sql.indexOf("-- backfill: keys per project (begin)");
      const end = sql.indexOf("-- backfill: keys per project (end)");
      await client.query(sql.slice(start, end));
      expect(await rowsOf(client, `SELECT count(*)::int AS n FROM "provider_list_entry"`)).toEqual([{ n: 3 }]);
      expect(await rowsOf(client, `SELECT count(*)::int AS n FROM "model_choice"`)).toEqual([{ n: 3 }]);
    });
  });
});
