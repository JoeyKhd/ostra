import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, POOL_IDLE_MS } from "./client.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";

// The pool's idle connections (`POOL_IDLE_MS`): a burst's connections are still there for the next
// burst a while later, so its transactions start on them instead of opening new ones. Opening one
// is what ran past Prisma's 2 s `maxWait` under load (`apps/core`'s `plans-questions.test.ts`).

let test: TestDatabase;

beforeAll(async () => {
  test = await createTestDatabase();
});

afterAll(async () => {
  await test.dispose();
});

/** Counts the connections `pg` opens while `work` runs. */
const opensDuring = async (work: () => Promise<unknown>): Promise<number> => {
  const connect: unknown = Reflect.get(pg.Client.prototype, "connect");
  if (typeof connect !== "function") throw new Error("pg.Client has no connect");
  let opened = 0;
  Reflect.set(pg.Client.prototype, "connect", function (this: pg.Client, ...args: unknown[]): unknown {
    opened += 1;
    const connecting: unknown = Reflect.apply(connect, this, args);
    return connecting;
  });
  try {
    await work();
  } finally {
    Reflect.set(pg.Client.prototype, "connect", connect);
  }
  return opened;
};

describe("the database client's pool", () => {
  it("keeps a burst's connections past pg's own 10 s, so the next burst opens none", async () => {
    expect(POOL_IDLE_MS).toBeGreaterThan(10_000);
    const db = createDb(test.url);
    try {
      const burst = () => Promise.all([0, 1, 2].map(() => db.$transaction(async (tx) => tx.$queryRaw`SELECT 1`)));
      expect(await opensDuring(burst)).toBe(3);
      // Idle for longer than pg's default would keep them.
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      expect(await opensDuring(burst)).toBe(0);
    } finally {
      await db.$disconnect();
    }
  }, 60_000);
});
