import fs from "node:fs/promises";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { startDatabaseServer } from "../src/db/provision-database.ts";
import { generateClient, migrateDeploy } from "../src/db/migrate.ts";
import { readSpikeEnv } from "../src/env.ts";
import { spikeRoot } from "../src/paths.ts";

// Vitest hands values to tests through `provide` / `inject`; declaring the key
// here types both ends. Module augmentation can only be written as an interface.
declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- declaration merging needs an interface; a type alias cannot extend vitest's
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const clientExists = (): Promise<boolean> =>
  fs.access(path.join(spikeRoot, "src", "generated", "prisma", "client.ts")).then(
    () => true,
    () => false,
  );

/** One Postgres for the whole run: an embedded one, or a throwaway database on DATABASE_URL's server. */
// eslint-disable-next-line no-restricted-exports -- vitest's globalSetup is loaded as the file's default export
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (!(await clientExists())) {
    const generated = await generateClient();
    if (!generated.ok) {
      throw new Error(`prisma generate failed: ${generated.detail}`);
    }
  }
  const server = await startDatabaseServer(readSpikeEnv(process.env));
  const database = await server.createDatabase();
  const migrated = await migrateDeploy(database.url);
  if (!migrated.ok) {
    await database.dispose();
    await server.stop();
    throw new Error(`migrations did not apply: ${migrated.detail}`);
  }
  project.provide("databaseUrl", database.url);
  return async () => {
    await database.dispose();
    await server.stop();
  };
}
