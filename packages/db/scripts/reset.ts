// `pnpm dev:reset --yes`: stops the dev database if it's running and deletes `.ostra-dev/`, the dev
// stack's whole data folder. Without `--yes` it only says what it would delete.

import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";

import pg from "pg";

import { devDatabaseUrl, devDataDir, devPgDir } from "@ostra/db/dev";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), "code") === "EPERM";
  }
};

const killTree = (pid: number): Promise<void> =>
  new Promise((resolve) => {
    if (process.platform !== "win32") {
      try {
        // SIGINT is Postgres' fast shutdown.
        process.kill(pid, "SIGINT");
      } catch {
        // Already gone.
      }
      resolve();
      return;
    }
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => {
      resolve();
    });
    killer.on("close", () => {
      resolve();
    });
  });

const samePath = (a: string, b: string): boolean =>
  path.resolve(a).replaceAll("\\", "/").toLowerCase() === path.resolve(b).replaceAll("\\", "/").toLowerCase();

/**
 * Stops the dev cluster's postmaster. Its PID comes from `postmaster.pid`, and it's killed only
 * after the server on that file's port says its data directory is the dev cluster's, so a stale
 * file whose PID now belongs to another program is never acted on.
 */
const stopCluster = async (): Promise<void> => {
  let lines: string[];
  try {
    const text = await readFile(path.join(devPgDir, "postmaster.pid"), "utf8");
    lines = text.split(/\r?\n/);
  } catch {
    return;
  }
  const pid = Number.parseInt(lines[0] ?? "", 10);
  const port = Number.parseInt(lines[3] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || !isAlive(pid)) {
    return;
  }
  const client = new pg.Client({ connectionString: devDatabaseUrl(port, "postgres"), connectionTimeoutMillis: 3000 });
  let dataDirectory: unknown;
  try {
    await client.connect();
    const result = await client.query("SHOW data_directory");
    dataDirectory = Reflect.get(Object(result.rows[0]), "data_directory");
  } catch {
    return;
  } finally {
    await client.end().catch(() => undefined);
  }
  if (typeof dataDirectory !== "string" || !samePath(dataDirectory, devPgDir)) {
    return;
  }
  await killTree(pid);
  for (let waited = 0; waited < 10_000 && isAlive(pid); waited += 200) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

const main = async (): Promise<void> => {
  if (!process.argv.includes("--yes")) {
    console.log(`This deletes ${devDataDir}: the dev database and every dev data file.`);
    console.log("Run `pnpm dev:reset --yes` to do it.");
    return;
  }
  if (await exists(path.join(devPgDir, "postmaster.pid"))) {
    console.log("Stopping the dev database...");
    await stopCluster();
  }
  await rm(devDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  console.log(`Deleted ${devDataDir}.`);
};

await main();
