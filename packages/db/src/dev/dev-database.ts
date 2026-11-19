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

/**
 * initdb's flags for every embedded cluster: UTF-8, whatever the machine's locale. Without them
 * Windows makes a WIN1252 cluster, which refuses any character outside that code page, such as an
 * emoji in an agent's message (SQLSTATE 22P05).
 */
export const embeddedInitdbFlags: readonly string[] = ["--encoding=UTF8", "--locale=C"];

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

/**
 * A checkout path longer than this on Windows is likely to stop the embedded Postgres: it unpacks
 * deep inside `node_modules/.pnpm`, and initdb failed at 123 characters and worked at 27.
 */
export const WINDOWS_LONG_CHECKOUT_PATH = 100;

/**
 * What to tell a developer whose embedded Postgres failed to start on a long Windows path, or null
 * when the path isn't the likely cause. Windows' 260-character limit (MAX_PATH) stops initdb with
 * exit code 3221225734 (`STATUS_NAME_TOO_LONG`); the fix is a shorter checkout path.
 */
export const longPathHint = (checkoutPath: string, platform: NodeJS.Platform = process.platform): string | null =>
  platform === "win32" && checkoutPath.length > WINDOWS_LONG_CHECKOUT_PATH
    ? `This checkout is at ${checkoutPath} (${String(checkoutPath.length)} characters), and the embedded Postgres unpacks deep inside it: Windows stops paths at 260 characters. Clone ostra to a shorter folder, such as C:\\src\\ostra, and run \`pnpm install\` there.`
    : null;
