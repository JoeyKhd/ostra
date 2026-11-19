import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { seedInstallation } from "./testing/installations.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Linked installations' migration (milestone 4's ticket 46, spec section 5.5, ADR 0065): the
// installation rows, `Repo`'s composite key to them, and the backfill on a database at ticket 45's head.

let test: TestDatabase;
let fixture: IsolationFixture;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

const installationsMigration = "20261121020000_linked_installations";
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
const migrationSql = (name: string): Promise<string> => readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");

const repoData = (organizationId: string, projectId: string, connectionId: string, installationId: string) => ({
  organizationId,
  projectId,
  connectionId,
  installationId,
  hostRepoId: randomUUID(),
  fullName: "client-org/api",
  defaultBranch: "main",
  checkoutDir: `api-${randomUUID().slice(0, 6)}`,
});

describe("the linked-installations migration", () => {
  it("F-136: the Repo key refuses an installation with no row, and another organization's", async () => {
    const a = fixture.a.organization.id;
    const connection = await test.db.connection.create({ data: { organizationId: a, kind: "github", appId: `app-${randomUUID()}` } });
    await expect(test.db.repo.create({ data: repoData(a, fixture.a.openProject.id, connection.id, "77") })).rejects.toMatchObject({ code: "P2003" });
    // B's installation row on B's connection doesn't serve A's repo.
    const theirs = await test.db.connection.create({ data: { organizationId: fixture.b.organization.id, kind: "github", appId: `app-${randomUUID()}` } });
    await seedInstallation(test.db, { organizationId: fixture.b.organization.id, connectionId: theirs.id, installationId: "77" });
    await expect(test.db.repo.create({ data: repoData(a, fixture.a.openProject.id, theirs.id, "77") })).rejects.toMatchObject({ code: "P2003" });
    // With its own row, the repo is stored.
    await seedInstallation(test.db, { organizationId: a, connectionId: connection.id, installationId: "77" });
    const repo = await test.db.repo.create({ data: repoData(a, fixture.a.openProject.id, connection.id, "77") });
    expect(repo.installationId).toBe("77");
    // An installation is unique per connection.
    await expect(
      test.db.codeHostInstallation.create({ data: { organizationId: a, connectionId: connection.id, installationId: "77", accountLogin: "client-org" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    // A connection's owner columns start empty, filled on the next read.
    expect(await test.db.connection.findUniqueOrThrow({ where: { id: connection.id } })).toMatchObject({ ownerLogin: null, ownerAccountId: null });
  });
});

// ---------- the upgrade ----------

const withClient = async <T,>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

describe("upgrading a database at ticket 45's head", () => {
  const serverUrl = inject("ostraDbServerUrl");
  const name = `ostra_upgrade_inst_${randomUUID().slice(0, 8)}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const upgradeUrl = url.toString();

  afterAll(async () => {
    await withClient(serverUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
  });

  it("F-136: links every installation an existing repo uses, once, so the key holds for every repo", async () => {
    await withClient(serverUrl, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
    const all = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(all).toContain(installationsMigration);
    await withClient(upgradeUrl, async (client) => {
      for (const migration of all.filter((entry) => entry < installationsMigration)) {
        await client.query(await migrationSql(migration));
      }
      await client.query(`
        INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-a', 'A', 'a', now()), ('org-b', 'B', 'b', now());
        INSERT INTO "connection" (id, "organizationId", kind, "appId", "updatedAt") VALUES ('conn-a', 'org-a', 'github', '1', now()), ('conn-b', 'org-b', 'github', '2', now());
        INSERT INTO "project" (id, "organizationId", name, slug, "updatedAt") VALUES ('proj-a', 'org-a', 'A', 'a', now()), ('proj-b', 'org-b', 'B', 'b', now());
        INSERT INTO "repo" (id, "organizationId", "projectId", "connectionId", "installationId", "hostRepoId", "fullName", "defaultBranch", "checkoutDir", "updatedAt")
          VALUES ('repo-1', 'org-a', 'proj-a', 'conn-a', '9', '41', 'ostra-test/test1', 'main', 'test1', now()),
                 ('repo-2', 'org-a', 'proj-a', 'conn-a', '9', '42', 'ostra-test/test2', 'main', 'test2', now()),
                 ('repo-3', 'org-b', 'proj-b', 'conn-b', '12', '43', 'other-org/web', 'main', 'web', now());
      `);
      for (const migration of all.filter((entry) => entry >= installationsMigration)) {
        await client.query(await migrationSql(migration));
      }
      const rows = await client.query(`SELECT "organizationId", "connectionId", "installationId", "accountLogin", state::text AS state, "linkedByMemberId" FROM "code_host_installation" ORDER BY "installationId"`);
      expect(rows.rows).toEqual([
        { organizationId: "org-b", connectionId: "conn-b", installationId: "12", accountLogin: "other-org", state: "linked", linkedByMemberId: null },
        { organizationId: "org-a", connectionId: "conn-a", installationId: "9", accountLogin: "ostra-test", state: "linked", linkedByMemberId: null },
      ]);
      // The key is on: a repo on an installation with no row is refused after the upgrade.
      await expect(
        client.query(`INSERT INTO "repo" (id, "organizationId", "projectId", "connectionId", "installationId", "hostRepoId", "fullName", "defaultBranch", "checkoutDir", "updatedAt") VALUES ('repo-4', 'org-a', 'proj-a', 'conn-a', '99', '44', 'x/y', 'main', 'y', now())`),
      ).rejects.toThrow(/foreign key/);
    });
  });
});
