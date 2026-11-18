import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import * as z from "zod";
import type { SpikeEnv } from "../env.ts";
import { dataDir } from "../paths.ts";
import { commandLineOf, killTree, processIsAlive } from "../proc.ts";

export type ProvisionedDatabase = {
  /** Connection string of an empty database. Holds credentials: never log it. */
  readonly url: string;
  readonly dispose: () => Promise<void>;
};

export type DatabaseServer = {
  /** `embedded`: a cluster started here. `external`: the server named by DATABASE_URL. */
  readonly kind: "embedded" | "external";
  /** The Postgres server version, for the report. */
  readonly serverVersion: string;
  /** Creates an empty database on the server. Several can exist side by side. */
  readonly createDatabase: () => Promise<ProvisionedDatabase>;
  readonly stop: () => Promise<void>;
};

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

const serverVersionRowsSchema = z.array(z.object({ server_version: z.string() }));

const readServerVersion = async (url: string): Promise<string> => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query("SHOW server_version");
    return serverVersionRowsSchema.parse(result.rows)[0]?.server_version ?? "unknown";
  } finally {
    await client.end();
  }
};

const removeDir = async (dir: string): Promise<void> => {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    // Left behind for the next run's reaper; a stuck handle is not a failure of the spike.
  }
};

/** The run that started a cluster, from its directory name `pg-<pid>-<hex>`. */
export const clusterOwnerPid = (clusterName: string): number | undefined => {
  const match = /^pg-(\d+)-/.exec(clusterName);
  const pid = Number.parseInt(match?.[1] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};

/** Case and slash style differ between what we built and what the OS reports. */
const normalisedPath = (value: string): string => value.replaceAll("/", "\\").toLowerCase();

/** Where the throwaway password file of `initdb` goes: inside the spike, not in the system's temp. */
export const tempDir: string = path.join(dataDir, "tmp");

/**
 * A crashed earlier run can leave its postgres behind. Clusters of this spike
 * live in `.data/pg-<owner pid>-<hex>`. A cluster is stale only when the run that
 * made it is gone; one whose owner is alive belongs to a run in progress (a
 * `pnpm test` beside a `pnpm spike`, or another session in this checkout) and is
 * left alone. A stale cluster's postmaster is killed only when its own command
 * line names the cluster's directory, so a recycled PID that now belongs to some
 * other program is never touched. Returns how many postmasters were killed.
 */
export const reapStaleClusters = async (): Promise<number> => {
  let entries: string[];
  try {
    entries = await fs.readdir(dataDir);
  } catch {
    return 0;
  }
  let reaped = 0;
  for (const entry of entries) {
    if (!entry.startsWith("pg-")) {
      continue;
    }
    const owner = clusterOwnerPid(entry);
    if (owner !== undefined && processIsAlive(owner)) {
      continue;
    }
    const clusterDir = path.join(dataDir, entry);
    let postmasterAlive = false;
    try {
      const pidFile = await fs.readFile(path.join(clusterDir, "postmaster.pid"), "utf8");
      const pid = Number.parseInt(pidFile.split("\n")[0] ?? "", 10);
      if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) {
        const commandLine = await commandLineOf(pid, dataDir);
        if (commandLine !== null && commandLine !== undefined && normalisedPath(commandLine).includes(normalisedPath(clusterDir))) {
          await killTree(pid);
          reaped += 1;
        } else {
          // Alive, and not provably ours: do not kill it, and do not pull its directory away.
          postmasterAlive = true;
        }
      }
    } catch {
      // No pid file: the cluster never started, or already stopped cleanly.
    }
    if (!postmasterAlive) {
      await removeDir(clusterDir);
    }
  }
  await removeStalePasswordFiles();
  return reaped;
};

/** A crash between `initdb` writing its password file and deleting it leaves one in `.data/tmp`. */
const removeStalePasswordFiles = async (): Promise<void> => {
  const TEN_MINUTES = 10 * 60 * 1000;
  let names: string[];
  try {
    names = await fs.readdir(tempDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("pg-password-")) {
      continue;
    }
    const file = path.join(tempDir, name);
    try {
      const { mtimeMs } = await fs.stat(file);
      if (Date.now() - mtimeMs > TEN_MINUTES) {
        await fs.rm(file, { force: true });
      }
    } catch {
      // Gone already.
    }
  }
};

/**
 * embedded-postgres writes the cluster password to a file in `os.tmpdir()` for the length of
 * `initialise()`. Pointing the temp variables into `.data/tmp` for that call keeps the file
 * inside the spike, so even a hard kill leaves nothing in the system's temp directory.
 */
const withTempInsideSpike = async <T>(work: () => Promise<T>): Promise<T> => {
  const names = ["TMP", "TEMP", "TMPDIR"] as const;
  const before = names.map((name) => [name, process.env[name]] as const);
  await fs.mkdir(tempDir, { recursive: true });
  for (const name of names) {
    process.env[name] = tempDir;
  }
  try {
    return await work();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  }
};

/** A throwaway database on a server we can already reach as `serverUrl`. */
const createThrowawayDatabase = async (serverUrl: string): Promise<ProvisionedDatabase> => {
  const name = `ostra_spike_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`);
  } finally {
    await admin.end();
  }
  const target = new URL(serverUrl);
  target.pathname = `/${name}`;
  return {
    url: target.toString(),
    dispose: async () => {
      const dropper = new pg.Client({ connectionString: serverUrl });
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${dropper.escapeIdentifier(name)} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
};

const startEmbedded = async (): Promise<DatabaseServer> => {
  await reapStaleClusters();
  const port = await freePort();
  const password = randomBytes(18).toString("base64url");
  const user = "ostra";
  const clusterDir = path.join(dataDir, `pg-${String(process.pid)}-${randomBytes(3).toString("hex")}`);
  const logTail: string[] = [];
  const remember = (line: string): void => {
    logTail.push(line);
    if (logTail.length > 40) {
      logTail.shift();
    }
  };

  const server = new EmbeddedPostgres({
    databaseDir: clusterDir,
    port,
    user,
    password,
    persistent: true,
    // Windows' default locale would pick SQL_ASCII; usernames and names are UTF-8.
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--no-sync"],
    postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "fsync=off", "-c", "full_page_writes=off"],
    onLog: remember,
    onError: (error) => {
      remember(error instanceof Error ? error.message : "postgres error");
    },
  });

  const stop = async (): Promise<void> => {
    try {
      await server.stop();
    } finally {
      await removeDir(clusterDir);
    }
  };

  try {
    await withTempInsideSpike(() => server.initialise());
    await server.start();
  } catch (error) {
    await stop();
    const reason = error instanceof Error ? error.message : "unknown error";
    const hint =
      process.platform === "win32" && `${reason} ${logTail.join(" ")}`.includes("does not exist")
        ? " (On Windows, Postgres' tools cannot open paths over 260 characters. If the checkout path is long, move it somewhere shorter.)"
        : "";
    throw new Error(`embedded postgres did not start: ${reason}.${hint} Last log lines: ${logTail.join(" | ")}`, {
      cause: error,
    });
  }

  const serverUrl = `postgresql://${user}:${password}@127.0.0.1:${String(port)}/postgres`;
  return {
    kind: "embedded",
    serverVersion: await readServerVersion(serverUrl),
    createDatabase: () => createThrowawayDatabase(serverUrl),
    stop,
  };
};

const connectExternal = async (serverUrl: string): Promise<DatabaseServer> => ({
  kind: "external",
  serverVersion: await readServerVersion(serverUrl),
  // `DATABASE_URL` names a server, not a database to fill: the spike makes its own and drops it.
  createDatabase: () => createThrowawayDatabase(serverUrl),
  stop: () => Promise.resolve(),
});

/** DATABASE_URL set: use that server. Unset: start an embedded Postgres on this machine. */
export const startDatabaseServer = (env: SpikeEnv): Promise<DatabaseServer> =>
  env.DATABASE_URL === undefined ? startEmbedded() : connectExternal(env.DATABASE_URL);
