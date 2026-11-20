import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Milestone 7's migration (ticket 04, spec section 5.3): a member's theme. It applies on an empty
// database and on one at the head before it, with rows in the table it alters and the others a
// member's demo leaves, and changes none of them: every account starts dark.

const m7Migration = "20261127000000_milestone_7";
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

const serverUrl = (): string => inject("ostraDbServerUrl");
const created: string[] = [];

/** A database of its own, empty, and its URL. */
const emptyDatabase = async (): Promise<string> => {
  const name = `ostra_upgrade_m7_${randomBytes(6).toString("hex")}`;
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

/** Every row of the tables a member's demo leaves, as JSON, in a stable order. */
type Row = Record<string, unknown>;

const snapshot = async (url: string): Promise<Record<string, Row[]>> =>
  withClient(url, async (client) => {
    const tables = ["user", "organization", "member", "audit_entry", "project", "task"];
    const rows: Record<string, Row[]> = {};
    for (const table of tables) {
      const result = await client.query<{ row: Row }>(`SELECT row_to_json(t) AS row FROM ${client.escapeIdentifier(table)} t ORDER BY id`);
      rows[table] = result.rows.map((found) => found.row);
    }
    return rows;
  });

let test: TestDatabase;

beforeAll(async () => {
  test = await createTestDatabase();
});

afterAll(async () => {
  await test.dispose();
  for (const name of created) {
    await withClient(serverUrl(), (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
  }
});

describe("the milestone 7 migration", () => {
  it("is additive: no DROP, no RENAME, no column changed", async () => {
    const names = await migrationNames();
    expect(names).toContain(m7Migration);
    const sql = (await migrationSql(m7Migration)).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN/i);
    expect(sql).toMatch(/CREATE TYPE "ThemePreference" AS ENUM \('dark', 'light', 'system'\)/);
  });

  it("applies on an empty database", async () => {
    const url = await emptyDatabase();
    await apply(url, await migrationNames());
    const column = await withClient(url, (client) =>
      client.query(`SELECT udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'user' AND column_name = 'theme'`),
    );
    expect(column.rows).toEqual([{ udt_name: "ThemePreference", is_nullable: "NO", column_default: "'dark'::\"ThemePreference\"" }]);
  });

  it("F-082: applies on a database at the head before it, and changes no existing row: every account starts dark", async () => {
    const names = await migrationNames();
    const url = await emptyDatabase();
    await apply(url, names.filter((name) => name < m7Migration));
    await withClient(url, (client) =>
      client.query(`
        INSERT INTO "user" (id, name, email, username, "updatedAt") VALUES ('user-1', 'Admin', 'admin@example.com', 'admin', now()), ('user-2', 'Ada', 'ada@example.com', 'ada', now());
        INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-1', 'Demo', 'demo', now());
        INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ('mem-1', 'org-1', 'user-1', 'admin', now()), ('mem-2', 'org-1', 'user-2', 'member', now());
        INSERT INTO "audit_entry" (id, "organizationId", "actorKind", "actorId", action) VALUES ('audit-1', 'org-1', 'member', 'mem-1', 'project.created');
        INSERT INTO "project" (id, "organizationId", name, slug, "updatedAt") VALUES ('proj-1', 'org-1', 'Demo', 'demo', now());
        INSERT INTO "task" (id, "organizationId", "projectId", kind, source, title, prompt, "branchName", "updatedAt")
          VALUES ('task-1', 'org-1', 'proj-1', 'code', 'prompt', 'Add CONTRIBUTING.md', 'x', 'ostra/m7-upgrade', now());
      `),
    );
    const before = await snapshot(url);
    await apply(url, names.filter((name) => name >= m7Migration));
    const after = await snapshot(url);
    // The accounts gained their theme, dark, and nothing else of any row changed.
    expect((after["user"] ?? []).map((row) => row["theme"])).toEqual(["dark", "dark"]);
    const withoutTheme = (after["user"] ?? []).map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "theme")));
    expect({ ...after, user: withoutTheme }).toEqual(before);
  });

  it("F-082: a new account's theme is dark, and only the three themes are taken", async () => {
    const id = randomUUID();
    const user = await test.db.user.create({ data: { id, name: "New", email: `new-${id}@example.com`, username: `new-${id.slice(0, 8)}` } });
    expect(user.theme).toBe("dark");
    expect((await test.db.user.update({ where: { id }, data: { theme: "light" } })).theme).toBe("light");
    expect((await test.db.user.update({ where: { id }, data: { theme: "system" } })).theme).toBe("system");
    await expect(test.db.$executeRaw`UPDATE "user" SET theme = 'sepia' WHERE id = ${id}`).rejects.toThrow();
  });
});
