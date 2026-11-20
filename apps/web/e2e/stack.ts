// The panel's end-to-end stack, for Playwright's `webServer`: a throwaway embedded Postgres,
// migrated, and the production build of the panel on it (`next start`). Nothing of the dev
// database is touched. It stops Postgres and removes its folder on SIGTERM, SIGINT or when the
// panel exits; a folder left by a run that was killed is removed by the next run.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { devDataDir, embeddedInitdbFlags, longPathHint, migrateDeploy } from "@ostra/db/dev";
import { createJobs } from "@ostra/jobs";
import { errnoCode } from "@ostra/protocol";
import EmbeddedPostgres from "embedded-postgres";

import { startFakes, writeStackFile } from "./fakes.ts";
import { e2eCorePort, e2ePort } from "./settings.ts";

const clustersDir = path.join(devDataDir, "test");
/** F-001: the second stack runs with the default password allowed (`06-default-password.spec.ts`). */
const allowDefaultPassword = process.env["OSTRA_ALLOW_DEFAULT_PASSWORD"] === "true";
/** F-083: the pseudo-locale stack serves the `.next-pseudo` build (`playwright.pseudo.config.ts`). */
const pseudoLocale = process.env["OSTRA_PSEUDO_LOCALE"] === "1";
const webDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(webDir, "..", "..");

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
    return errnoCode(error) === "EPERM";
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
    initdbFlags: [...embeddedInitdbFlags],
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  try {
    await server.initialise();
    await server.start();
  } catch (error) {
    const hint = longPathHint(repoRoot);
    throw hint === null ? error : new Error(`the e2e Postgres did not start. ${hint}`, { cause: error });
  }
  await server.createDatabase("ostra");
  const databaseUrl = `postgresql://ostra:${password}@127.0.0.1:${String(port)}/ostra`;
  const migrated = await migrateDeploy(databaseUrl);
  if (!migrated.ok) throw new Error(`the migrations failed:\n${migrated.output}`);

  // Core installs pg-boss's schema and its queues at start (ADR 0037); core doesn't run here.
  const jobs = createJobs({ databaseUrl, role: "worker" });
  await jobs.start();
  await jobs.stop();

  // The stub model endpoints and the fake GitHub the panel and core talk to through
  // OSTRA_GITHUB_API_URL (ticket 37), shared with an outside stack's run (`fakes.ts`).
  const fakes = await startFakes();
  const { github, linear } = fakes;

  // The specs read the database's address and the fake GitHub's Apps from here (gitignored).
  // The second stack (OSTRA_ALLOW_DEFAULT_PASSWORD, playwright.config.ts) keeps its own.
  await writeStackFile(
    path.join(webDir, "e2e", allowDefaultPassword ? ".stack-default-password.json" : pseudoLocale ? ".stack-pseudo.json" : ".stack.json"),
    databaseUrl,
    github,
    linear,
    dataDir,
  );

  const panelUrl = `http://localhost:${String(e2ePort)}`;
  const coreUrl = `http://127.0.0.1:${String(e2eCorePort)}`;
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
      // No OSTRA_ADMIN_*: the panel seeds demo@demo.com / demo, as a fresh install does (F-001).
      ...(allowDefaultPassword ? { OSTRA_ALLOW_DEFAULT_PASSWORD: "true" } : {}),
      ...(pseudoLocale ? { OSTRA_PSEUDO_LOCALE: "1" } : {}),
      OSTRA_CORE_PUBLIC_URL: coreUrl,
      OSTRA_CATALOG_FETCH: "false",
      OSTRA_GITHUB_API_URL: github.apiUrl,
      OSTRA_LINEAR_API_URL: linear.apiUrl,
      // The stub model endpoint above listens on loopback, which the server refuses unless told.
      OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE: "true",
      // Core as the panel reaches it: the panel hands core the files a member uploads (a skill's files, ticket 42).
      OSTRA_CORE_INTERNAL_URL: coreUrl,
    },
  });

  // Core, for the runner the setup spec starts: the same database and data folder, the same fake GitHub.
  const core = spawn(process.execPath, [path.join(repoRoot, "apps", "core", "src", "main.ts")], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      PATH: process.env["PATH"] ?? "",
      SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      OSTRA_DATA_DIR: dataDir,
      OSTRA_PUBLIC_URL: panelUrl,
      OSTRA_CORE_PUBLIC_URL: coreUrl,
      OSTRA_CORE_PORT: String(e2eCorePort),
      OSTRA_CATALOG_FETCH: "false",
      OSTRA_GITHUB_API_URL: github.apiUrl,
      OSTRA_LINEAR_API_URL: linear.apiUrl,
      OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE: "true",
    },
  });

  let stopping = false;
  const stop = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    panel.kill();
    core.kill();
    await fakes.close();
    await server.stop().catch(() => undefined);
    await rm(clusterDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    process.exit(code);
  };
  panel.once("exit", (code) => void stop(code ?? 1));
  core.once("exit", (code) => void stop(code ?? 1));
  process.on("SIGTERM", () => void stop(0));
  process.on("SIGINT", () => void stop(0));
};

await main();
