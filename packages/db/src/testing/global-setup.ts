import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import type { TestProject } from "vitest/node";

import { devDataDir, embeddedInitdbFlags, longPathHint, migrateDeploy, repoRoot } from "../dev/index.ts";
import "./provided-context.ts";
import { pgCtlPath, startCluster, stopCluster, watchCluster } from "./windows-cluster.ts";

// Vitest global setup (ticket 05): one Postgres server per test run, and one migrated template
// database that every test file copies (`createTestDatabase`). With DATABASE_URL set, the run uses
// that server instead of starting one, and still makes and drops its own databases on it.
//
// Use it from a package's vitest.config.ts:
//   globalSetup: [fileURLToPath(import.meta.resolve("@ostra/db/testing/global-setup"))]
//
// Ported from spikes/auth-foundation/src/db/provision-database.ts.

const testClustersDir = path.join(devDataDir, "test");

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("could not find a free port"));
        }
      });
    });
  });

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), "code") === "EPERM";
  }
};

/**
 * Removes the clusters of earlier runs whose process is gone. A live run's cluster is left alone.
 * On Windows a gone run's server may still be up (its watchdog didn't get to it): pg_ctl stops it
 * first, so its files can go.
 */
const removeStaleClusters = async (pgCtl: string | null): Promise<void> => {
  let entries: string[];
  try {
    entries = await readdir(testClustersDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const owner = Number.parseInt(/^pg-(\d+)-/.exec(entry)?.[1] ?? "", 10);
    if (Number.isInteger(owner) && owner > 0 && !isAlive(owner)) {
      const dir = path.join(testClustersDir, entry);
      if (pgCtl !== null) {
        await stopCluster(pgCtl, dir, "immediate").catch(() => false);
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => undefined);
    }
  }
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

const databaseUrl = (serverUrl: string, database: string): string => {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
};

let stopServer: (() => Promise<void>) | undefined;
let dropTemplate: (() => Promise<void>) | undefined;

export const setup = async (project: TestProject): Promise<void> => {
  const external = process.env["DATABASE_URL"];
  let serverUrl: string;
  if (external !== undefined && external !== "") {
    serverUrl = external;
  } else {
    // On Windows pg_ctl starts and stops the server, not embedded-postgres (windows-cluster.ts says why).
    const pgCtl = process.platform === "win32" ? await pgCtlPath() : null;
    await removeStaleClusters(pgCtl);
    await mkdir(testClustersDir, { recursive: true });
    const port = await freePort();
    const password = randomBytes(18).toString("base64url");
    const clusterDir = path.join(testClustersDir, `pg-${String(process.pid)}-${randomBytes(3).toString("hex")}`);
    // Every test file holds a client pool, a queue's pool and listeners at once, and a package's
    // files run side by side: Postgres's default of 100 connections runs out.
    const postgresFlags = ["-c", "max_connections=400"];
    const server = new EmbeddedPostgres({
      databaseDir: clusterDir,
      port,
      user: "ostra",
      password,
      authMethod: "scram-sha-256",
      initdbFlags: [...embeddedInitdbFlags],
      postgresFlags,
      // Kept on stop, and removed below with retries: on Windows the files can stay busy for a moment.
      persistent: true,
      onLog: () => undefined,
      onError: () => undefined,
    });
    try {
      await server.initialise();
      if (pgCtl === null) {
        await server.start();
      } else {
        await startCluster(pgCtl, clusterDir, port, postgresFlags);
        watchCluster(pgCtl, clusterDir);
      }
    } catch (error) {
      const hint = longPathHint(repoRoot);
      throw hint === null ? error : new Error(`the test Postgres did not start. ${hint}`, { cause: error });
    }
    stopServer = async () => {
      if (pgCtl === null) {
        await server.stop();
      } else if (!(await stopCluster(pgCtl, clusterDir, "fast"))) {
        await stopCluster(pgCtl, clusterDir, "immediate");
      }
      await rm(clusterDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => undefined);
    };
    serverUrl = `postgresql://ostra:${password}@127.0.0.1:${String(port)}/postgres`;
  }

  const template = `ostra_template_${randomBytes(4).toString("hex")}`;
  await withAdmin(serverUrl, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(template)}`));
  dropTemplate = () =>
    withAdmin(serverUrl, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(template)} WITH (FORCE)`);
    });
  const migrated = await migrateDeploy(databaseUrl(serverUrl, template));
  if (!migrated.ok) {
    throw new Error(`migrating the test template failed:\n${migrated.output}`);
  }

  project.provide("ostraDbServerUrl", serverUrl);
  project.provide("ostraDbTemplate", template);
};

export const teardown = async (): Promise<void> => {
  await dropTemplate?.().catch(() => undefined);
  await stopServer?.();
};
