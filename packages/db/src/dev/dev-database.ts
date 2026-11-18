import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the development database lives and how to reach it (ticket 05, docs/development.md).
// `pnpm db:dev` starts an embedded Postgres here unless DATABASE_URL names another server.
//
// The dev database listens on 127.0.0.1 only, with a fixed local user and password. It's a
// development convenience, not a credential: nothing outside this machine can reach it.

/** The repo's root folder. */
export const repoRoot: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Everything the dev stack keeps on disk, gitignored. `pnpm dev:reset --yes` deletes it. */
export const devDataDir: string = path.join(repoRoot, ".ostra-dev");

/** The dev database's cluster. */
export const devPgDir: string = path.join(devDataDir, "pg");

/** The dev database's default port; `OSTRA_DEV_PG_PORT` overrides it. */
export const DEV_PG_PORT_DEFAULT = 54329;

const DEV_PG_USER = "ostra";
const DEV_PG_PASSWORD = "ostra";

/** The dev database's name inside the cluster. */
export const DEV_DATABASE_NAME = "ostra";

/** The dev database's port, from `OSTRA_DEV_PG_PORT` or the default. */
export const devPgPort = (env: Readonly<Record<string, string | undefined>>): number => {
  const raw = env["OSTRA_DEV_PG_PORT"];
  if (raw === undefined || raw === "") {
    return DEV_PG_PORT_DEFAULT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OSTRA_DEV_PG_PORT must be a port number from 1 to 65535");
  }
  return port;
};

export const devPgCredentials = { user: DEV_PG_USER, password: DEV_PG_PASSWORD } as const;

/** The URL of a database in the dev cluster. */
export const devDatabaseUrl = (port: number, database: string = DEV_DATABASE_NAME): string =>
  `postgresql://${DEV_PG_USER}:${DEV_PG_PASSWORD}@127.0.0.1:${String(port)}/${database}`;

/**
 * The database the dev stack uses: DATABASE_URL when it's set, otherwise the dev database.
 * Production requires DATABASE_URL (packages/domain's settings check that).
 */
export const resolveDatabaseUrl = (env: Readonly<Record<string, string | undefined>>): string => {
  const url = env["DATABASE_URL"];
  return url !== undefined && url !== "" ? url : devDatabaseUrl(devPgPort(env));
};
