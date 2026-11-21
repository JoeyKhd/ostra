// The panel's end-to-end stack, for Playwright's `webServer`: a throwaway embedded Postgres,
// migrated, and the production build of the panel on it (`next start`). Nothing of the dev
// database is touched. It stops Postgres and removes its folder on SIGTERM, SIGINT or when the
// panel exits; a folder left by a run that was killed is removed by the next run.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { devDataDir, embeddedInitdbFlags, longPathHint, migrateDeploy } from "@ostra/db/dev";
import { createJobs } from "@ostra/jobs";
import { errnoCode } from "@ostra/protocol";
import EmbeddedPostgres from "embedded-postgres";

import { startFakes, writeStackFile } from "./fakes.ts";
import { e2eCorePort, e2eLockedEmail, e2ePort, e2ePreviewDomain } from "./settings.ts";

const clustersDir = path.join(devDataDir, "test");
/** F-001: the second stack runs with the default password allowed (`06-default-password.spec.ts`). */
const allowDefaultPassword = process.env["OSTRA_ALLOW_DEFAULT_PASSWORD"] === "true";
/** F-083: the pseudo-locale stack serves the `.next-pseudo` build (`playwright.pseudo.config.ts`). */
const pseudoLocale = process.env["OSTRA_PSEUDO_LOCALE"] === "1";
/** F-115 (ticket 45): OSTRA_E2E_EMAIL_LOCKED=1 sets the install's email by its settings (`e2eLockedEmail`). */
const emailSettings = process.env["OSTRA_E2E_EMAIL_LOCKED"] === "1" ? e2eLockedEmail : {};
/**
 * Milestone 8 (ticket 31): OSTRA_E2E_DEV=1 serves the panel with `next dev` instead of the
 * production build, for working on a screen against the stack. The specs always run on the build.
 */
const devPanel = process.env["OSTRA_E2E_DEV"] === "1";
/**
 * Milestone 8 (ticket 26, F-144): the install's preview domain. `preview.localhost` by default,
 * which needs no DNS record and no certificate (browsers send every `*.localhost` name to the
 * machine), so the native preview runs against core's real proxy; OSTRA_E2E_PREVIEW_DOMAIN names
 * another (the second stack's, a name that never resolves), and `none` turns it off. It's set
 * explicitly, never left to a one-machine install's own `preview.localhost` (2026-11-21), so the
 * specs' first check is the settings page's, not core's at its start; `none` is `off`, since
 * unset on loopback would be that default.
 */
const previewDomain = process.env["OSTRA_E2E_PREVIEW_DOMAIN"] ?? e2ePreviewDomain;
const previewSettings = { OSTRA_PREVIEW_DOMAIN: previewDomain === "none" ? "off" : previewDomain };
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
  const { github, linear, resend } = fakes;

  // The specs read the database's address and the fake GitHub's Apps from here (gitignored).
  // The second stack (OSTRA_ALLOW_DEFAULT_PASSWORD, playwright.config.ts) keeps its own.
  await writeStackFile(
    path.join(webDir, "e2e", allowDefaultPassword ? ".stack-default-password.json" : pseudoLocale ? ".stack-pseudo.json" : ".stack.json"),
    databaseUrl,
    github,
    linear,
    resend,
    dataDir,
  );

  const panelUrl = `http://localhost:${String(e2ePort)}`;
  const coreUrl = `http://127.0.0.1:${String(e2eCorePort)}`;
  const nextBin = path.join(webDir, "node_modules", "next", "dist", "bin", "next");
  const panel = spawn(process.execPath, [nextBin, devPanel ? "dev" : "start", "--port", String(e2ePort)], {
    cwd: webDir,
    stdio: "inherit",
    env: {
      PATH: process.env["PATH"] ?? "",
      SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
      NODE_ENV: devPanel ? "development" : "production",
      // F-145 (ticket 31): the library's calls out (a registry, an MCP server's test call, a site's
      // index, the skills search) reach the API's in-memory fakes, never a real host (`library-fetch.ts`).
      NODE_OPTIONS: `--import ${pathToFileURL(path.join(webDir, "e2e", "library-fetch.ts")).href}`,
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
      OSTRA_RESEND_API_URL: resend.url,
      ...emailSettings,
      // The stub model endpoint above listens on loopback, which the server refuses unless told.
      OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE: "true",
      // Core as the panel reaches it: the panel hands core the files a member uploads (a skill's files, ticket 42).
      OSTRA_CORE_INTERNAL_URL: coreUrl,
      ...previewSettings,
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
      OSTRA_RESEND_API_URL: resend.url,
      ...emailSettings,
      OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE: "true",
      ...previewSettings,
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
