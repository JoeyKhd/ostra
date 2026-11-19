import { readFile } from "node:fs/promises";
import path from "node:path";

import { devDatabaseUrl, devPgPort } from "@ostra/db/dev";

// The database the demo's checks read: the one the stack it drives writes to. The demo reaches
// the stack through its panel and core URLs, but its checks read Postgres directly, so the two
// can disagree: a stack on other ports, with OSTRA_DEV_PG_PORT unset in the demo's shell, left the
// checks reading the default port's database, another stack's, where the task isn't. A check then
// read zero model calls, or found no credential in an event log that wasn't the task's.

/** Where the demo's database is, and what said so. `address` is host, port and name: never the URL's password. */
export type DemoDatabase = {
  readonly url: string;
  readonly address: string;
  readonly source: "DATABASE_URL" | "OSTRA_DEV_PG_PORT" | "the running dev cluster" | "the default port";
};

/**
 * The port of the dev cluster running in `pgDir`, from its `postmaster.pid` (Postgres writes the
 * port on the file's fourth line while the server runs, and removes the file when it stops).
 * `null` when no cluster runs there, or the file can't be read as one.
 */
export const runningClusterPort = async (pgDir: string): Promise<number | null> => {
  let text: string;
  try {
    text = await readFile(path.join(pgDir, "postmaster.pid"), "utf8");
  } catch {
    return null;
  }
  const line = text.split(/\r?\n/)[3]?.trim() ?? "";
  if (!/^\d+$/.test(line)) return null;
  const port = Number(line);
  return port >= 1 && port <= 65_535 ? port : null;
};

const addressOf = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname}`;
};

/**
 * DATABASE_URL, then OSTRA_DEV_PG_PORT, as the stack reads them; then the dev cluster running in
 * this checkout's data folder, which is the stack the demo drives (the demo keeps its own state in
 * that folder too); and only then the default port.
 */
export const demoDatabase = async (env: Readonly<Record<string, string | undefined>>, pgDir: string): Promise<DemoDatabase> => {
  const named = env["DATABASE_URL"];
  if (named !== undefined && named !== "") return { url: named, address: addressOf(named), source: "DATABASE_URL" };
  const port = env["OSTRA_DEV_PG_PORT"];
  if (port !== undefined && port !== "") {
    const url = devDatabaseUrl(devPgPort(env));
    return { url, address: addressOf(url), source: "OSTRA_DEV_PG_PORT" };
  }
  const running = await runningClusterPort(pgDir);
  const url = devDatabaseUrl(running ?? devPgPort({}));
  return { url, address: addressOf(url), source: running === null ? "the default port" : "the running dev cluster" };
};

/**
 * Whether the database holds the task the panel just started. When it doesn't, every check that
 * reads it would judge another stack's rows, so the demo stops: the error says where it looked.
 */
export const judgeTaskInDatabase = (taskId: string, rows: number, database: DemoDatabase): void => {
  if (rows === 1) return;
  throw new Error(
    `task ${taskId} isn't in the database at ${database.address} (from ${database.source}), so it isn't the stack's: ` +
      "set OSTRA_DEV_PG_PORT, or DATABASE_URL, as the stack has them",
  );
};
