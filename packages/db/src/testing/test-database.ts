import { randomBytes } from "node:crypto";

import pg from "pg";
import { inject } from "vitest";

import { createDb } from "../client.ts";
import type { Db } from "../client.ts";
import "./provided-context.ts";

// A fresh, migrated database for one test file (ticket 05), copied from the run's template. Call
// it in `beforeAll` and dispose it in `afterAll`:
//
//   let test: TestDatabase;
//   beforeAll(async () => { test = await createTestDatabase(); });
//   afterAll(() => test.dispose());

export type TestDatabase = {
  /** The database's URL. Holds credentials: never log it. */
  readonly url: string;
  readonly db: Db;
  /** Disconnects and drops the database. */
  readonly dispose: () => Promise<void>;
};

const withAdmin = async <T>(serverUrl: string, work: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

export const createTestDatabase = async (): Promise<TestDatabase> => {
  const serverUrl = inject("ostraDbServerUrl");
  const template = inject("ostraDbTemplate");
  const name = `ostra_test_${randomBytes(6).toString("hex")}`;
  // Two files copying the template at the same moment can get "source database is being
  // accessed by other users" (55006). It clears in a moment, so retry with jitter.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await withAdmin(serverUrl, (client) =>
        client.query(`CREATE DATABASE ${client.escapeIdentifier(name)} TEMPLATE ${client.escapeIdentifier(template)}`),
      );
      break;
    } catch (error) {
      if (attempt >= 30 || Reflect.get(Object(error), "code") !== "55006") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 200));
    }
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const db = createDb(url.toString());
  return {
    url: url.toString(),
    db,
    dispose: async () => {
      await db.$disconnect();
      await withAdmin(serverUrl, (client) =>
        client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`),
      );
    },
  };
};
