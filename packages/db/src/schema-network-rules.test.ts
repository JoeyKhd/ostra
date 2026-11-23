import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { runPrisma } from "./dev/prisma-cli.ts";
import { buildIsolationRows, isolationModelNames, isolationProjectModels } from "./testing/isolation-models.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Post-v1 (F-052, ADR 0073): the environment's network rules' migration. Additive: one table and
// its enum, nothing seeded, nothing dropped or renamed. It applies on a fresh database and over a
// milestone 11 install, and its row is on the isolation list, built in two organizations.

const networkRuleMigration = "20261205000000_environment_network_rule";
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
const migrationSql = (name: string): Promise<string> => readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");
const migrationNames = async (): Promise<string[]> =>
  (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const withClient = async <T,>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

type Row = Record<string, unknown>;
const rowsOf = async (client: pg.Client, sql: string, values: readonly unknown[] = []): Promise<Row[]> => (await client.query<Row>(sql, [...values])).rows;

const serverUrl = (): string => inject("ostraDbServerUrl");
const created: string[] = [];

const emptyDatabase = async (): Promise<string> => {
  const name = `ostra_network_rules_${randomBytes(6).toString("hex")}`;
  await withClient(serverUrl(), (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
  created.push(name);
  const url = new URL(serverUrl());
  url.pathname = `/${name}`;
  return url.toString();
};

const apply = async (url: string, names: readonly string[]): Promise<void> => {
  await withClient(url, async (client) => {
    for (const name of names) {
      await client.query(await migrationSql(name));
    }
  });
};

describe("the network rules migration (F-052/c1)", () => {
  it("F-052/c1: adds only: one enum and one table, with no DROP, no backfill and nothing renamed", async () => {
    const names = await migrationNames();
    expect(names).toContain(networkRuleMigration);
    expect(names.indexOf(networkRuleMigration)).toBeGreaterThan(names.indexOf("20261204100000_environment_repo_draft"));
    const sql = (await migrationSql(networkRuleMigration)).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bRENAME\b|ALTER COLUMN|DROP COLUMN|DROP TABLE|DROP TYPE|DROP CONSTRAINT|\bDELETE FROM\b|\bINSERT INTO\b/i);
    expect(sql).toContain(`CREATE TYPE "EnvironmentNetworkRuleKind" AS ENUM ('host', 'cidr')`);
    expect(sql).toContain(`CREATE TABLE "environment_network_rule"`);
    expect(sql).toContain(`CREATE UNIQUE INDEX "environment_network_rule_environmentId_kind_value_key" ON "environment_network_rule"("environmentId", "kind", "value")`);
    expect(sql).toContain(`CREATE INDEX "environment_network_rule_environmentId_idx" ON "environment_network_rule"("environmentId")`);
    // The composite keys: the project's on the row, the environment's from the project.
    expect(sql).toContain(`FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE`);
    expect(sql).toContain(`FOREIGN KEY ("environmentId", "projectId") REFERENCES "environment"("id", "projectId") ON DELETE CASCADE`);
  });

  it("F-052/c1: applies on a fresh database, and the schema then has nothing of it left to migrate", async () => {
    const url = await emptyDatabase();
    await apply(url, await migrationNames());
    await withClient(url, async (client) => {
      const columns = await rowsOf(
        client,
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'environment_network_rule' ORDER BY ordinal_position`,
      );
      expect(columns).toEqual([
        { column_name: "id", data_type: "text" },
        { column_name: "organizationId", data_type: "text" },
        { column_name: "projectId", data_type: "text" },
        { column_name: "environmentId", data_type: "text" },
        { column_name: "kind", data_type: "USER-DEFINED" },
        { column_name: "value", data_type: "text" },
        { column_name: "ports", data_type: "ARRAY" },
        { column_name: "createdAt", data_type: "timestamp without time zone" },
        { column_name: "updatedAt", data_type: "timestamp without time zone" },
      ]);
      expect(await rowsOf(client, `SELECT unnest(enum_range(NULL::"EnvironmentNetworkRuleKind"))::text AS value`)).toEqual([{ value: "host" }, { value: "cidr" }]);
    });
    // `prisma migrate diff` from the migrated database to the schema holds nothing of this migration.
    // Its only statements are three older partial indexes whose `IN` lists Postgres keeps as
    // `= ANY (ARRAY[...])` (the same noise `schema-m11.test.ts` records).
    const diff = await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script"], { databaseUrl: url });
    expect(diff.ok, diff.output).toBe(true);
    const statements = diff.output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(CREATE|DROP|ALTER)\b/.test(line));
    expect(statements.some((line) => /environment_network_rule|EnvironmentNetworkRuleKind/.test(line))).toBe(false);
  }, 120_000);

  it("F-052/c1: applies on the milestone 11 schema: an environment's rows are as they were, and a rule joins it", async () => {
    const names = await migrationNames();
    const url = await emptyDatabase();
    await apply(url, names.filter((name) => name < networkRuleMigration));
    const organizationId = randomUUID();
    const projectId = randomUUID();
    const environmentId = randomUUID();
    await withClient(url, async (client) => {
      await client.query(`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ($1, 'Calc', 'calc', now())`, [organizationId]);
      await client.query(`INSERT INTO "project" ("id", "organizationId", "name", "slug", "updatedAt") VALUES ($1, $2, 'Calc', 'calc', now())`, [projectId, organizationId]);
      await client.query(`INSERT INTO "environment" ("id", "organizationId", "projectId", "setupScript", "updatedAt") VALUES ($1, $2, $3, 'pnpm install', now())`, [
        environmentId,
        organizationId,
        projectId,
      ]);
    });

    await apply(url, names.filter((name) => name >= networkRuleMigration));

    await withClient(url, async (client) => {
      // The milestone-11 environment is untouched.
      expect(await rowsOf(client, `SELECT "id", "setupScript", "status" FROM "environment" ORDER BY "id"`)).toEqual([
        { id: environmentId, setupScript: "pnpm install", status: "draft" },
      ]);
      // A rule joins it, with its ports, and a repeated (environment, kind, value) is refused.
      const ruleId = randomUUID();
      await client.query(`INSERT INTO "environment_network_rule" ("id", "organizationId", "projectId", "environmentId", "kind", "value", "ports", "updatedAt") VALUES ($1, $2, $3, $4, 'host', 'registry.npmjs.org', ARRAY[80, 443], now())`, [
        ruleId,
        organizationId,
        projectId,
        environmentId,
      ]);
      expect(await rowsOf(client, `SELECT "kind"::text, "value", "ports" FROM "environment_network_rule"`)).toEqual([{ kind: "host", value: "registry.npmjs.org", ports: [80, 443] }]);
      await expect(
        client.query(`INSERT INTO "environment_network_rule" ("id", "organizationId", "projectId", "environmentId", "kind", "value", "ports", "updatedAt") VALUES ($1, $2, $3, $4, 'host', 'registry.npmjs.org', ARRAY[443], now())`, [
          randomUUID(),
          organizationId,
          projectId,
          environmentId,
        ]),
      ).rejects.toThrow(/environment_network_rule_environmentId_kind_value_key/);
      // The environment's composite key cascades: deleting it deletes its rules.
      await client.query(`DELETE FROM "environment" WHERE "id" = $1`, [environmentId]);
      expect(await rowsOf(client, `SELECT count(*)::int AS n FROM "environment_network_rule"`)).toEqual([{ n: 0 }]);
    });
  }, 120_000);
});

describe("the isolation list's new row (F-052/c1, F-049)", () => {
  let test: TestDatabase;
  let fixture: IsolationFixture;

  beforeAll(async () => {
    test = await createTestDatabase();
    fixture = await seedIsolationFixture(test.db);
  }, 120_000);

  afterAll(async () => {
    await test.dispose();
    for (const name of created) {
      await withClient(serverUrl(), (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
    }
  });

  it("F-052/c1: environment_network_rule is on the isolation list, and its builder makes a row in two organizations", async () => {
    expect(isolationModelNames()).toContain("EnvironmentNetworkRule");
    expect(isolationProjectModels.has("EnvironmentNetworkRule")).toBe(true);
    const { a, b } = fixture;
    const rowsA = await buildIsolationRows(test.db, { organizationId: a.organization.id, memberId: a.admin.id, userId: a.admin.userId }, [a.openProject.id]);
    const rowsB = await buildIsolationRows(test.db, { organizationId: b.organization.id, memberId: b.admin.id, userId: b.admin.userId }, [b.project.id]);
    const ruleA = rowsA.get(a.openProject.id)?.get("EnvironmentNetworkRule");
    const ruleB = rowsB.get(b.project.id)?.get("EnvironmentNetworkRule");
    expect(ruleA).toBeDefined();
    expect(ruleB).toBeDefined();
    const rows = await test.db.environmentNetworkRule.findMany({
      where: { id: { in: [ruleA ?? "", ruleB ?? ""] } },
      select: { organizationId: true, projectId: true, kind: true, value: true, ports: true },
      orderBy: { organizationId: "asc" },
    });
    expect(rows).toHaveLength(2);
    const byOrganization = new Map(rows.map((row) => [row.organizationId, row]));
    const rowA = byOrganization.get(a.organization.id);
    expect(rowA).toMatchObject({ organizationId: a.organization.id, projectId: a.openProject.id, kind: "host", ports: [443] });
    expect(rowA?.value).toMatch(/^registry-[0-9a-f]{8}\.example\.com$/);
    expect(byOrganization.get(b.organization.id)?.projectId).toBe(b.project.id);
  });
});
