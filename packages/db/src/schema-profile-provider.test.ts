import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";

import "./testing/provided-context.ts";

// The profile's provider (F-135, F-021, ADR 0065 amended 2026-11-20): the migration that adds
// `AgentProfile.providerId`, and its backfill on a database as the release before left it. Each
// profile gets the provider that serves its model today when exactly one does, on the default list
// and every project's own list by F-135's rule; several or none leave it `null`.

const profileProviderMigration = "20261125000000_profile_provider";
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
const migrationSql = (name: string): Promise<string> => readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");

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

describe("upgrading to the profile's provider", () => {
  const serverUrl = inject("ostraDbServerUrl");
  const name = `ostra_upgrade_profile_provider_${randomUUID().slice(0, 8)}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const upgradeUrl = url.toString();

  afterAll(async () => {
    await withClient(serverUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
  });

  it("F-135, F-021: gives each profile the provider that serves its model today when exactly one does, and leaves it null where several or none do", async () => {
    await withClient(serverUrl, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
    const all = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(all).toContain(profileProviderMigration);
    await withClient(upgradeUrl, async (client) => {
      for (const migration of all.filter((entry) => entry < profileProviderMigration)) {
        await client.query(await migrationSql(migration));
      }
      // Organization A: keys a1 and a2 on the default list, which `follows` uses; `own` has its own
      // list of a2 alone; a3 is on no list. Organization B: one key, b1.
      //   sonnet: listed by a1 and a2; the default list chose a1, and `own` serves it from a2: several.
      //   in-house-7b (custom): listed by a2 alone: a2 on both lists.
      //   opus: listed by a1 and a2; the default list chose a1, and a2's row is unlisted: a1 alone.
      //   gpt: listed by a3 alone, which no list holds: none.
      //   haiku: a legacy profile with only its model row; a1 lists it alone: a1.
      //   kimi: listed by a1 and a2 with no choice, so the default list serves it from neither, and
      //   `own` serves it from a2: a2 alone.
      //   B's model: b1, never one of A's.
      await client.query(`
        INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-a', 'A', 'a', now()), ('org-b', 'B', 'b', now());
        INSERT INTO "model_provider" (id, "organizationId", name, "baseUrl", "apiFormat", "authScheme", "tokenSecretRef", "updatedAt")
          VALUES ('prov-a1', 'org-a', 'Client one', 'https://one.example.com', 'anthropic_messages', 'x_api_key', 'ref', now()),
                 ('prov-a2', 'org-a', 'Client two', 'https://two.example.com', 'anthropic_messages', 'x_api_key', 'ref', now()),
                 ('prov-a3', 'org-a', 'Spare', 'https://three.example.com', 'openai_compatible', 'bearer', 'ref', now()),
                 ('prov-b1', 'org-b', 'B key', 'https://b.example.com', 'openai_compatible', 'bearer', 'ref', now());
        INSERT INTO "model" (id, "organizationId", "providerId", "endpointModelId", "catalogId", listed, "updatedAt")
          VALUES ('m-a1-sonnet', 'org-a', 'prov-a1', 'claude-sonnet', 'anthropic/claude-sonnet', true, now()),
                 ('m-a2-sonnet', 'org-a', 'prov-a2', 'sonnet-latest', 'anthropic/claude-sonnet', true, now()),
                 ('m-a2-custom', 'org-a', 'prov-a2', 'in-house-7b', NULL, true, now()),
                 ('m-a1-opus', 'org-a', 'prov-a1', 'claude-opus', 'anthropic/claude-opus', true, now()),
                 ('m-a2-opus', 'org-a', 'prov-a2', 'opus-old', 'anthropic/claude-opus', false, now()),
                 ('m-a3-gpt', 'org-a', 'prov-a3', 'gpt-x', 'openai/gpt-x', true, now()),
                 ('m-a1-haiku', 'org-a', 'prov-a1', 'claude-haiku', 'anthropic/claude-haiku', true, now()),
                 ('m-a1-kimi', 'org-a', 'prov-a1', 'kimi-k3', 'moonshot/kimi-k3', true, now()),
                 ('m-a2-kimi', 'org-a', 'prov-a2', 'kimi-k3', 'moonshot/kimi-k3', true, now()),
                 ('m-b1-sonnet', 'org-b', 'prov-b1', 'claude-sonnet', 'anthropic/claude-sonnet', true, now());
        INSERT INTO "project" (id, "organizationId", name, slug, "ownProviders", "updatedAt")
          VALUES ('proj-follows', 'org-a', 'follows', 'follows', false, now()),
                 ('proj-own', 'org-a', 'own', 'own', true, now()),
                 ('proj-b', 'org-b', 'b', 'b', false, now());
        INSERT INTO "provider_list_entry" (id, "organizationId", "projectId", "providerId")
          VALUES ('e-a1', 'org-a', NULL, 'prov-a1'), ('e-a2', 'org-a', NULL, 'prov-a2'),
                 ('e-own-a2', 'org-a', 'proj-own', 'prov-a2'),
                 ('e-b1', 'org-b', NULL, 'prov-b1');
        INSERT INTO "model_choice" (id, "organizationId", "projectId", "modelKey", "modelCatalogId", "modelId", reason, "updatedAt")
          VALUES ('c-sonnet', 'org-a', NULL, 'catalog:anthropic/claude-sonnet', 'anthropic/claude-sonnet', 'm-a1-sonnet', 'upgrade', now()),
                 ('c-opus', 'org-a', NULL, 'catalog:anthropic/claude-opus', 'anthropic/claude-opus', 'm-a1-opus', 'upgrade', now());
        INSERT INTO "agent_profile" (id, "organizationId", name, adapter, "modelId", "modelCatalogId", "modelCustomName", "updatedAt")
          VALUES ('prof-sonnet', 'org-a', 'Sonnet', 'opencode', 'm-a1-sonnet', 'anthropic/claude-sonnet', NULL, now()),
                 ('prof-custom', 'org-a', 'Custom', 'opencode', 'm-a2-custom', NULL, 'in-house-7b', now()),
                 ('prof-opus', 'org-a', 'Opus', 'opencode', 'm-a1-opus', 'anthropic/claude-opus', NULL, now()),
                 ('prof-gpt', 'org-a', 'Gpt', 'opencode', 'm-a3-gpt', 'openai/gpt-x', NULL, now()),
                 ('prof-haiku', 'org-a', 'Haiku', 'opencode', 'm-a1-haiku', NULL, NULL, now()),
                 ('prof-kimi', 'org-a', 'Kimi', 'opencode', 'm-a1-kimi', 'moonshot/kimi-k3', NULL, now()),
                 ('prof-none', 'org-a', 'None', 'opencode', NULL, NULL, NULL, now()),
                 ('prof-b', 'org-b', 'B', 'opencode', 'm-b1-sonnet', 'anthropic/claude-sonnet', NULL, now());
      `);
      for (const migration of all.filter((entry) => entry >= profileProviderMigration)) {
        await client.query(await migrationSql(migration));
      }

      const expected = [
        { id: "prof-b", providerId: "prov-b1" },
        { id: "prof-custom", providerId: "prov-a2" },
        { id: "prof-gpt", providerId: null },
        { id: "prof-haiku", providerId: "prov-a1" },
        { id: "prof-kimi", providerId: "prov-a2" },
        { id: "prof-none", providerId: null },
        { id: "prof-opus", providerId: "prov-a1" },
        { id: "prof-sonnet", providerId: null },
      ];
      expect(await rowsOf(client, `SELECT id, "providerId" FROM "agent_profile" ORDER BY id`)).toEqual(expected);

      // A provider of another organization is refused by the key.
      await expect(client.query(`UPDATE "agent_profile" SET "providerId" = 'prov-b1' WHERE id = 'prof-none'`)).rejects.toThrow(/agent_profile_providerId_organizationId_fkey/);

      // Running the backfill again changes nothing, and never moves a profile that has a provider.
      await client.query(`UPDATE "agent_profile" SET "providerId" = 'prov-a3' WHERE id = 'prof-gpt'`);
      const sql = await migrationSql(profileProviderMigration);
      const start = sql.indexOf("-- backfill: the profile's provider (begin)");
      const end = sql.indexOf("-- backfill: the profile's provider (end)");
      expect(start).toBeGreaterThan(0);
      await client.query(sql.slice(start, end));
      expect(await rowsOf(client, `SELECT id, "providerId" FROM "agent_profile" ORDER BY id`)).toEqual(
        expected.map((row) => (row.id === "prof-gpt" ? { id: "prof-gpt", providerId: "prov-a3" } : row)),
      );
    });
  });
});
