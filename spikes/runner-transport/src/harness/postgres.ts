import { randomBytes } from "node:crypto";
import net from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { schemaSql } from "../server/schema.ts";
import { SPIKE_SCHEMA, pgConfig } from "../shared/db.ts";

// A real Postgres for the run: SPIKE_DATABASE_URL if it's set, or
// embedded-postgres on this machine. The spike's tables live in their own
// schema (SPIKE_SCHEMA), and that schema is all the harness ever drops. It never
// reads DATABASE_URL, the variable ostra's own apps use.

export type Db = {
  readonly url: string;
  readonly pool: pg.Pool;
  readonly embedded: boolean;
  readonly stop: () => Promise<void>;
};

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      s.close(() => {
        resolve(port);
      });
    });
  });

const resetSql = `
DROP SCHEMA IF EXISTS ${SPIKE_SCHEMA} CASCADE;
CREATE SCHEMA ${SPIKE_SCHEMA};
`;

export const startDb = async (dataDir: string): Promise<Db> => {
  const external = process.env["SPIKE_DATABASE_URL"];
  let url: string;
  let stopEmbedded: () => Promise<void> = () => Promise.resolve();
  if (external !== undefined && external.length > 0) {
    url = external;
  } else {
    const port = await freePort();
    const password = randomBytes(12).toString("hex");
    const epg = new EmbeddedPostgres({
      databaseDir: dataDir,
      port,
      user: "postgres",
      password,
      persistent: false,
      postgresFlags: ["-c", "max_connections=400", "-c", "shared_buffers=256MB", "-c", "synchronous_commit=on"],
      onLog: () => undefined,
      onError: () => undefined,
    });
    await epg.initialise();
    await epg.start();
    await epg.createDatabase("spike");
    url = `postgres://postgres:${password}@127.0.0.1:${String(port)}/spike`;
    stopEmbedded = () => epg.stop();
  }
  const pool = new pg.Pool({ ...pgConfig(url), max: 12 });
  await pool.query(resetSql);
  await pool.query(schemaSql);
  return {
    url,
    pool,
    embedded: external === undefined || external.length === 0,
    stop: async () => {
      await pool.end().catch(() => undefined);
      await stopEmbedded().catch(() => undefined);
    },
  };
};
