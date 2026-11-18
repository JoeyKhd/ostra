import { randomBytes } from "node:crypto";
import { loginResponse, metricsResponse, type MetricsResponse } from "../shared/api.ts";
import { createRunnerClient, type RunnerClient } from "../producer/runner-client.ts";
import { createPool, exec, type Db } from "../server/db.ts";
import { createLogger } from "../server/log.ts";
import { migrate, seedMembers, seedTasks } from "../server/seed.ts";
import { createWakeSender, type WakeSender } from "../server/wake.ts";
import { cleanStaleRuns, installExitHandlers, startDevDb, startServerProc, type DevDb, type ServerProc } from "./infra.ts";
import { loadHarnessSettings } from "./settings.ts";

export const settings = loadHarnessSettings();

export const members = [
  { memberId: "alex", role: "member" },
  { memberId: "sam", role: "member" },
  { memberId: "val", role: "viewer" },
] as const;
export type MemberName = (typeof members)[number]["memberId"];

// A runner token for one run: random, and never written anywhere. The servers get it in their environment
// and the runner clients in their options.
export const newRunnerToken = (): string => randomBytes(24).toString("hex");

export type Ctx = {
  readonly dev: DevDb;
  readonly pool: Db;
  // Two replicas, each a process of its own (no module state shared). B's poll is 60 s, so what reaches B
  // reaches it by NOTIFY.
  readonly a: ServerProc;
  readonly b: ServerProc;
  readonly baseA: string;
  readonly baseB: string;
  readonly cookies: Record<MemberName, string>;
  readonly runnerToken: string;
  // sends the wake-up NOTIFY for a write the harness made straight in the database
  readonly wake: WakeSender;
  readonly stop: () => Promise<void>;
};

export const makeRunner = (ctx: Pick<Ctx, "runnerToken">, base: string, batchMs = 20): RunnerClient => {
  const client = createRunnerClient({ baseUrl: base, token: ctx.runnerToken, batchMs });
  client.start();
  return client;
};

export const login = async (base: string, memberId: string): Promise<string> => {
  const response = await fetch(`${base}/api/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ memberId }),
  });
  loginResponse.parse(await response.json());
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (cookie === undefined) throw new Error("no cookie");
  return cookie;
};

export type HttpResult = { status: number; json: unknown };

export const request = async (
  base: string,
  method: "GET" | "POST",
  path: string,
  cookie: string | null,
  body?: unknown,
): Promise<HttpResult> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cookie === null ? {} : { cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = await response.json().catch(() => null);
  return { status: response.status, json };
};

// A replica's counters. /metrics needs the runner token.
export const readMetrics = async (base: string, runnerToken: string): Promise<MetricsResponse> => {
  const response = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${runnerToken}` } });
  return metricsResponse.parse(await response.json());
};

// With OSTRA_SPIKE_DATABASE_URL set, the harness uses that Postgres in a fresh schema of its own (dropped on the
// way out). Without it, it starts embedded-postgres, a real Postgres on this machine with no Docker.
const databaseFor = async (): Promise<DevDb> => {
  const external = settings.OSTRA_SPIKE_DATABASE_URL;
  if (external === undefined) return startDevDb();
  const schema = `spike_${String(Date.now())}`;
  const admin = createPool(external, 1);
  await exec(admin, `CREATE SCHEMA ${schema}`);
  const url = new URL(external);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return {
    url: url.toString(),
    postmasterPid: settings.OSTRA_SPIKE_POSTMASTER_PID,
    stop: async () => {
      await exec(admin, `DROP SCHEMA ${schema} CASCADE`).catch(() => 0);
      await admin.end();
    },
  };
};

export type Database = { readonly dev: DevDb; readonly pool: Db; readonly stop: () => Promise<void> };

export const startDatabase = async (): Promise<Database> => {
  installExitHandlers();
  // what a hard-killed earlier run left behind
  await cleanStaleRuns();
  const dev = await databaseFor();
  try {
    const pool = createPool(dev.url, 8, 0);
    await migrate(pool);
    await seedMembers(pool, members);
    return {
      dev,
      pool,
      stop: async () => {
        await pool.end();
        await dev.stop();
      },
    };
  } catch (error) {
    await dev.stop();
    throw error;
  }
};

export const startContext = async (): Promise<Ctx> => {
  const database = await startDatabase();
  const { dev, pool } = database;
  const runnerToken = newRunnerToken();
  const started: ServerProc[] = [];
  try {
    const a = await startServerProc(dev.url, "replica-a", runnerToken);
    started.push(a);
    const b = await startServerProc(dev.url, "replica-b", runnerToken, { OSTRA_SPIKE_POLL_MS: "60000" });
    started.push(b);
    const cookies: Record<MemberName, string> = {
      alex: await login(a.baseUrl, "alex"),
      sam: await login(a.baseUrl, "sam"),
      val: await login(a.baseUrl, "val"),
    };
    return {
      dev,
      pool,
      a,
      b,
      baseA: a.baseUrl,
      baseB: b.baseUrl,
      cookies,
      runnerToken,
      wake: createWakeSender(pool, "harness", createLogger("harness", true)),
      stop: async () => {
        await a.stop();
        await b.stop();
        await database.stop();
      },
    };
  } catch (error) {
    for (const server of started) await server.stop();
    await database.stop();
    throw error;
  }
};

export const newTask = async (ctx: Ctx, taskId: string, driver: MemberName | null): Promise<void> => {
  await seedTasks(ctx.pool, [taskId], driver);
};

