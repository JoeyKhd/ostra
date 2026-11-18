import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase } from "./test-database.ts";
import type { TestDatabase } from "./test-database.ts";

let first: TestDatabase;
let second: TestDatabase;

beforeAll(async () => {
  [first, second] = await Promise.all([createTestDatabase(), createTestDatabase()]);
});

afterAll(async () => {
  await Promise.all([first.dispose(), second.dispose()]);
});

const tables = async (database: TestDatabase): Promise<string[]> => {
  const rows = await database.db.$queryRaw<{ name: string }[]>`
    SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  return rows.map((row) => row.name).sort();
};

describe("the test database", () => {
  it("gives each caller its own database, with the same tables", async () => {
    expect(first.url).not.toBe(second.url);
    expect(await tables(first)).toEqual(await tables(second));
  });

  it("starts empty", async () => {
    for (const table of await tables(first)) {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      const rows = await first.db.$queryRawUnsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM ${quoted}`);
      expect({ table, count: rows[0]?.count }).toEqual({ table, count: 0 });
    }
  });

  it("is a separate database: a row in one is not in the other", async () => {
    await first.db.$executeRaw`CREATE TABLE scratch (id int)`;
    await first.db.$executeRaw`INSERT INTO scratch VALUES (1)`;
    expect(await tables(second)).not.toContain("scratch");
  });
});
