// `pnpm db:dev`: the development database. Starts an embedded Postgres in `.ostra-dev/pg` at the
// repo root, on OSTRA_DEV_PG_PORT (default 54329), prints the DATABASE_URL it serves, and runs
// until Ctrl-C or SIGTERM, when it stops Postgres cleanly. With DATABASE_URL set, it does nothing.
// Ported from spikes/auth-foundation/src/db/provision-database.ts and
// spikes/durable-queue-choice/src/cluster.ts.

import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

import {
  DEV_DATABASE_NAME,
  devDatabaseUrl,
  devPgCredentials,
  devPgDir,
  devPgPort,
  embeddedInitdbFlags,
} from "@ostra/db/dev";

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

const ensureDatabase = async (port: number): Promise<void> => {
  const client = new pg.Client({ connectionString: devDatabaseUrl(port, "postgres") });
  await client.connect();
  try {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [DEV_DATABASE_NAME]);
    if (found.rowCount === 0) {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(DEV_DATABASE_NAME)}`);
    }
    // A cluster made before initdb was given UTF-8 (on Windows, WIN1252) refuses emoji and more.
    const encoding = await client.query("SELECT pg_encoding_to_char(encoding) AS name FROM pg_database WHERE datname = $1", [DEV_DATABASE_NAME]);
    const name: unknown = Reflect.get(Object(encoding.rows[0]), "name");
    if (name !== "UTF8") {
      console.warn(`The dev database is ${String(name)}, not UTF8: text outside that code page fails. Run \`pnpm dev:reset --yes\` to start again with UTF-8.`);
    }
  } finally {
    await client.end();
  }
};

const main = async (): Promise<void> => {
  if (process.env["DATABASE_URL"] !== undefined && process.env["DATABASE_URL"] !== "") {
    console.log("DATABASE_URL is set, so the dev database is not started. ostra uses that server.");
    return;
  }
  const port = devPgPort(process.env);
  const recentLog: string[] = [];
  const remember = (line: unknown): void => {
    recentLog.push(typeof line === "string" ? line : line instanceof Error ? line.message : "postgres error");
    if (recentLog.length > 30) {
      recentLog.shift();
    }
  };
  const server = new EmbeddedPostgres({
    databaseDir: devPgDir,
    port,
    user: devPgCredentials.user,
    password: devPgCredentials.password,
    authMethod: "scram-sha-256",
    initdbFlags: [...embeddedInitdbFlags],
    persistent: true,
    onLog: remember,
    onError: remember,
  });

  try {
    if (!(await exists(path.join(devPgDir, "PG_VERSION")))) {
      await mkdir(path.dirname(devPgDir), { recursive: true });
      await server.initialise();
    }
    await server.start();
    await ensureDatabase(port);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    console.error(`The dev database did not start: ${reason}`);
    console.error(recentLog.join("\n"));
    console.error(
      "If another `pnpm db:dev` is running, stop it first. If one crashed and left Postgres behind, " +
        "`pnpm dev:reset --yes` stops it (and deletes the dev data).",
    );
    await server.stop().catch(() => undefined);
    process.exitCode = 1;
    return;
  }

  console.log(`Dev database running in ${devPgDir}`);
  console.log(`DATABASE_URL=${devDatabaseUrl(port)}`);
  console.log("Press Ctrl-C to stop it.");

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`\n${signal}: stopping the dev database...`);
    server.stop().then(
      () => {
        console.log("Stopped.");
        process.exit(0);
      },
      (error: unknown) => {
        console.error(`Could not stop it cleanly: ${error instanceof Error ? error.message : "unknown error"}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => {
    stop("SIGINT");
  });
  process.on("SIGTERM", () => {
    stop("SIGTERM");
  });
  process.on("SIGHUP", () => {
    stop("SIGHUP");
  });
  // `pnpm dev` runs this with an IPC channel and asks it to stop with a message, since Windows has
  // no signal one process can send another (scripts/dev.ts).
  process.on("message", (message: unknown) => {
    if (Reflect.get(Object(message), "type") === "stop") {
      stop("stop");
    }
  });
  // And if `pnpm dev` itself goes away without a word, Postgres doesn't outlive it.
  process.on("disconnect", () => {
    stop("pnpm dev went away");
  });
  // Stay alive until a signal arrives, and leave if Postgres went away on its own (killed, or
  // stopped by `pnpm dev:reset`): its lock file goes with it.
  setInterval(() => {
    if (stopping) {
      return;
    }
    void exists(path.join(devPgDir, "postmaster.pid")).then((running) => {
      if (!running && !stopping) {
        console.log("The dev database stopped.");
        process.exit(1);
      }
    });
  }, 2_000);
};

await main();
