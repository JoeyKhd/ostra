// Postgres for the harness. By default a real Postgres server (embedded-postgres, which ships the
// official binaries) on a free local port and a throwaway data directory. If SPIKE_DATABASE_URL is
// set, the harness uses that server instead: it needs rights to CREATE and DROP DATABASE.
//
// Each scenario gets its own database, cloned from a template that already holds ostra's Prisma
// tables. pg-boss installs its own schema into that database on the first replica's start.
//
// Every database this run creates carries the run's suffix (`spike_<run>_template`,
// `<scenario>_<run>`), and the cluster drops each one it created when it stops, on a failed start as
// well. On a shared server nothing of this run is left behind, and two runs never collide.

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { z } from "zod";
import { baseChildEnv } from "./child-env.ts";
import { killTree, pidIsAlive } from "./proc.ts";

const execFileAsync = promisify(execFile);

export type Db = {
  readonly url: string;
  readonly name: string;
  query: <S extends z.ZodType>(sql: string, params: readonly unknown[], schema: S) => Promise<z.output<S>[]>;
  exec: (sql: string, params?: readonly unknown[]) => Promise<void>;
  /** Sets the database's default time zone (new sessions only). */
  setTimezone: (zone: string) => Promise<void>;
  close: () => Promise<void>;
};

export type Cluster = {
  readonly kind: "embedded" | "external";
  readonly version: string;
  /** Creates a database from the template that holds ostra's tables, and returns a handle to it. */
  createScenarioDatabase: (name: string) => Promise<Db>;
  /**
   * Drops every database this run created, then stops the server if the cluster started it.
   * Resolves with the names of databases that could not be dropped (empty when all went).
   */
  stop: () => Promise<readonly string[]>;
};

/** A scenario's own name; the run's suffix is added to it. */
const SCENARIO_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const RUN_ID = /^[a-f0-9]{8}$/;

export const newRunId = (): string => randomBytes(4).toString("hex");

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });

export const withDatabase = (connectionString: string, database: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
};

/** The statement that sets a database's time zone. Both parts are escaped, though the callers pass constants. */
export const timezoneStatement = (database: string, zone: string): string =>
  `ALTER DATABASE ${pg.escapeIdentifier(database)} SET timezone TO ${pg.escapeLiteral(zone)}`;

export const connectDb = (url: string, name: string): Db => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  pool.on("error", () => {
    // An idle client lost its connection (for example when the cluster stops). Nothing to do.
  });
  return {
    url,
    name,
    query: async (sql, params, schema) => {
      const result = await pool.query(sql, [...params]);
      const rows: unknown = result.rows;
      return z.array(schema).parse(rows);
    },
    exec: async (sql, params = []) => {
      await pool.query(sql, [...params]);
    },
    setTimezone: async (zone) => {
      await pool.query(timezoneStatement(name, zone));
    },
    close: async () => {
      await pool.end();
    },
  };
};

/** Removes data directories (and postmasters) that an earlier, interrupted run left behind. */
export const cleanupStaleClusters = async (dataRoot: string): Promise<number> => {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dataRoot);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith("pg-")) {
      continue;
    }
    const dir = join(dataRoot, entry);
    try {
      const pidFile = await readFile(join(dir, "postmaster.pid"), "utf8");
      const pid = Number.parseInt(pidFile.split("\n")[0] ?? "", 10);
      if (Number.isInteger(pid) && pidIsAlive(pid)) {
        await killTree(pid);
      }
    } catch {
      // No postmaster.pid: the directory is just leftovers.
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    removed += 1;
  }
  return removed;
};

const runPrisma = async (projectRoot: string, args: readonly string[], databaseUrl: string | undefined): Promise<void> => {
  const prismaEntry = join(projectRoot, "node_modules", "prisma", "build", "index.js");
  await execFileAsync(process.execPath, [prismaEntry, ...args], {
    cwd: projectRoot,
    // An allowlist plus what prisma needs: the developer's shell may hold keys it has no use for.
    env: {
      ...baseChildEnv(),
      ...(databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl }),
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
    },
    timeout: 120_000,
  });
};

/** Generates the Prisma 7 client into src/generated (gitignored). Idempotent. */
export const prismaGenerate = (projectRoot: string): Promise<void> => runPrisma(projectRoot, ["generate"], undefined);

const prismaMigrateDeploy = (projectRoot: string, databaseUrl: string): Promise<void> =>
  runPrisma(projectRoot, ["migrate", "deploy"], databaseUrl);

export type ServerHandle = {
  /** A URL for the `postgres` database, as the server's superuser. It holds a password: never log it. */
  readonly adminUrl: string;
  readonly stop: () => Promise<void>;
};

/** Starts an embedded-postgres server on a free port in a new data directory under `dataRoot`. */
export const startEmbeddedServer = async (options: {
  readonly dataRoot: string;
  readonly onLog: (line: string) => void;
}): Promise<ServerHandle> => {
  await mkdir(options.dataRoot, { recursive: true });
  const port = await freePort();
  const user = "postgres";
  const password = randomBytes(12).toString("hex");
  const databaseDir = join(options.dataRoot, `pg-${String(Date.now())}`);
  const embedded = new EmbeddedPostgres({
    databaseDir,
    port,
    user,
    password,
    // The library would delete the data directory right after taskkill, while Windows still holds
    // files open (EBUSY). We delete it ourselves, with retries.
    persistent: true,
    // pnpm may skip the platform package's postinstall, which restores the symlinks in its share
    // directory. The library can restore them itself.
    autoRehydrateSymlinks: true,
    // An ephemeral test cluster: no need to fsync. Many connections: three replicas, a panel and the harness.
    postgresFlags: ["-c", "max_connections=400", "-c", "fsync=off", "-c", "full_page_writes=off"],
    onLog: (message) => {
      options.onLog(message.trimEnd());
    },
    onError: (message) => {
      options.onLog(`[stderr] ${message instanceof Error ? message.message : String(message)}`);
    },
  });
  // A leftover directory is removed by the next run's stale-cluster cleanup.
  const stop = async (): Promise<void> => {
    try {
      await embedded.stop();
    } finally {
      await rm(databaseDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }).catch(() => undefined);
    }
  };
  try {
    await embedded.initialise();
    await embedded.start();
  } catch (error) {
    // A server that half started must not outlive the failed start.
    await stop().catch(() => undefined);
    throw error;
  }
  return { adminUrl: `postgresql://${user}:${password}@127.0.0.1:${String(port)}/postgres`, stop };
};

export const startCluster = async (options: {
  readonly projectRoot: string;
  readonly dataRoot: string;
  readonly externalUrl: string | undefined;
  /** The suffix of every database this run creates: 8 hex digits. */
  readonly runId: string;
  readonly onLog: (line: string) => void;
}): Promise<Cluster> => {
  if (!RUN_ID.test(options.runId)) {
    throw new Error("the run id must be 8 hex digits");
  }
  const { runId } = options;
  const kind: Cluster["kind"] = options.externalUrl === undefined ? "embedded" : "external";
  const server: ServerHandle =
    options.externalUrl === undefined
      ? await startEmbeddedServer({ dataRoot: options.dataRoot, onLog: options.onLog })
      : { adminUrl: options.externalUrl, stop: () => Promise.resolve() };

  const admin = new pg.Client({ connectionString: server.adminUrl });
  admin.on("error", () => {
    // The admin connection was lost (the server went away). Teardown copes with a dead connection.
  });

  // Every database this run created, in creation order, template first.
  const created: string[] = [];
  const open: Db[] = [];
  const templateName = `spike_${runId}_template`;

  /** Drops what this run created, last first. Returns the names it could not drop. */
  const dropCreated = async (): Promise<string[]> => {
    const left: string[] = [];
    for (const name of [...created].reverse()) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
      } catch {
        left.push(name);
      }
    }
    return left;
  };

  /** Runs on every exit path, so an open admin connection or a running server never outlives the cluster. */
  const teardown = async (): Promise<string[]> => {
    let left: string[] = [];
    try {
      for (const db of open) {
        await db.close().catch(() => undefined);
      }
      left = await dropCreated();
    } finally {
      await admin.end().catch(() => undefined);
      await server.stop();
    }
    return left;
  };

  let version = "unknown";
  try {
    await admin.connect();
    const versionResult = await admin.query("SHOW server_version");
    const versionRows: unknown = versionResult.rows;
    version = z.array(z.object({ server_version: z.string() })).parse(versionRows)[0]?.server_version ?? "unknown";

    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(templateName)}`);
    created.push(templateName);
    await prismaMigrateDeploy(options.projectRoot, withDatabase(server.adminUrl, templateName));
  } catch (error) {
    // A failed start must not leave a connection, a server or a database behind: an open socket
    // alone would keep the harness's event loop alive forever.
    await teardown().catch(() => undefined);
    throw error;
  }

  return {
    kind,
    version,
    createScenarioDatabase: async (name) => {
      if (!SCENARIO_NAME.test(name)) {
        throw new Error("invalid database name");
      }
      const full = `${name}_${runId}`;
      await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(full)} TEMPLATE ${pg.escapeIdentifier(templateName)}`);
      created.push(full);
      // Prisma 7 with @prisma/adapter-pg writes a timestamptz as a zone-less string, so the instant is
      // shifted by the session's UTC offset unless the session runs in UTC (see the README, "Findings").
      // ostra's databases must run in UTC.
      await admin.query(timezoneStatement(full, "UTC"));
      const db = connectDb(withDatabase(server.adminUrl, full), full);
      open.push(db);
      return db;
    },
    stop: teardown,
  };
};
