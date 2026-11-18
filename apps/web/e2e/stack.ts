// The panel's end-to-end stack, for Playwright's `webServer`: a throwaway embedded Postgres,
// migrated, and the production build of the panel on it (`next start`). Nothing of the dev
// database is touched. It stops Postgres and removes its folder on SIGTERM, SIGINT or when the
// panel exits; a folder left by a run that was killed is removed by the next run.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { createScenarioBrain, startAnthropicStub } from "@ostra/adapter-sdk/testing";
import { devDataDir, migrateDeploy } from "@ostra/db/dev";
import { createJobs } from "@ostra/jobs";
import EmbeddedPostgres from "embedded-postgres";

import { e2eModelToken, e2ePort, e2eStubModels, e2eStubPort, e2eSetupToken } from "./settings.ts";

const clustersDir = path.join(devDataDir, "test");
const webDir = path.resolve(import.meta.dirname, "..");

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === "object") resolve(address.port);
        else reject(new Error("no free port"));
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

const removeStale = async (): Promise<void> => {
  const entries = await readdir(clustersDir).catch(() => []);
  for (const entry of entries) {
    const owner = Number.parseInt(/^web-e2e-(\d+)-/.exec(entry)?.[1] ?? "", 10);
    if (Number.isInteger(owner) && owner > 0 && !isAlive(owner)) {
      await rm(path.join(clustersDir, entry), { recursive: true, force: true }).catch(() => undefined);
    }
  }
};

const main = async (): Promise<void> => {
  await removeStale();
  const id = `web-e2e-${String(process.pid)}-${randomBytes(3).toString("hex")}`;
  const clusterDir = path.join(clustersDir, id);
  const dataDir = path.join(clustersDir, `${id}-data`);
  await mkdir(clusterDir, { recursive: true });
  const port = await freePort();
  const password = randomBytes(18).toString("base64url");
  const server = new EmbeddedPostgres({
    databaseDir: clusterDir,
    port,
    user: "ostra",
    password,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();
  await server.createDatabase("ostra");
  const databaseUrl = `postgresql://ostra:${password}@127.0.0.1:${String(port)}/ostra`;
  const migrated = await migrateDeploy(databaseUrl);
  if (!migrated.ok) throw new Error(`the migrations failed:\n${migrated.output}`);

  // Core installs pg-boss's schema and its queues at start (ADR 0037); core doesn't run here.
  const jobs = createJobs({ databaseUrl, role: "worker" });
  await jobs.start();
  await jobs.stop();

  // A stub model endpoint in Anthropic's format, for "Add a model provider" (spec section 8).
  const stub = await startAnthropicStub({
    realKey: e2eModelToken,
    models: e2eStubModels,
    brain: createScenarioBrain({}),
    host: "127.0.0.1",
    port: e2eStubPort,
  });

  const panelUrl = `http://localhost:${String(e2ePort)}`;
  const nextBin = path.join(webDir, "node_modules", "next", "dist", "bin", "next");
  const panel = spawn(process.execPath, [nextBin, "start", "--port", String(e2ePort)], {
    cwd: webDir,
    stdio: "inherit",
    env: {
      PATH: process.env["PATH"] ?? "",
      SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      OSTRA_DATA_DIR: dataDir,
      OSTRA_PUBLIC_URL: panelUrl,
      OSTRA_SETUP_TOKEN: e2eSetupToken,
      OSTRA_CATALOG_FETCH: "false",
    },
  });

  let stopping = false;
  const stop = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    panel.kill();
    await stub.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    await rm(clusterDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    process.exit(code);
  };
  panel.once("exit", (code) => void stop(code ?? 1));
  process.on("SIGTERM", () => void stop(0));
  process.on("SIGINT", () => void stop(0));
};

await main();
