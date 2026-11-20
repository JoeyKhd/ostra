// The panel's end-to-end stack, for Playwright's `webServer`: a throwaway embedded Postgres,
// migrated, and the production build of the panel on it (`next start`). Nothing of the dev
// database is touched. It stops Postgres and removes its folder on SIGTERM, SIGINT or when the
// panel exits; a folder left by a run that was killed is removed by the next run.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { createFakeGitHub } from "@ostra/adapter-github/testing";
import { createScenarioBrain, startAnthropicStub, startOpenAiStub } from "@ostra/adapter-sdk/testing";
import { devDataDir, embeddedInitdbFlags, longPathHint, migrateDeploy } from "@ostra/db/dev";
import { createJobs } from "@ostra/jobs";
import { errnoCode } from "@ostra/protocol";
import EmbeddedPostgres from "embedded-postgres";

import { e2eCorePort, e2eGitHubOrgB, e2eModelToken, e2eOpenAiStubPort, e2ePort, e2eRepo, e2eStubModels, e2eStubPort } from "./settings.ts";

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

  // A stub model endpoint in Anthropic's format, for "Add a model provider" (spec section 8).
  const stub = await startAnthropicStub({
    realKey: e2eModelToken,
    models: e2eStubModels,
    brain: createScenarioBrain({}),
    host: "127.0.0.1",
    port: e2eStubPort,
  });
  // And one in the OpenAI-compatible format, so a provider is added in each format the form offers (F-088).
  const openAiStub = await startOpenAiStub({
    realKey: e2eModelToken,
    models: e2eStubModels,
    brain: createScenarioBrain({}),
    host: "127.0.0.1",
    port: e2eOpenAiStubPort,
  });

  // A fake GitHub the panel and core talk to through OSTRA_GITHUB_API_URL (ticket 37): one org with
  // one repo, and an App whose key and webhook secret the setup spec types into the panel.
  const github = await createFakeGitHub({
    // F-136: a second account with the App installed, waiting to be linked, and a second App another account owns.
    otherAccounts: [{ login: e2eGitHubOrgB.login, id: e2eGitHubOrgB.id, type: "Organization", installationId: e2eGitHubOrgB.installationId }],
    secondApp: { slug: "client-c-ostra", owner: { login: "client-c", id: 6_003, type: "Organization", installationId: 9 } },
    repos: [
      { id: 4_002, owner: e2eGitHubOrgB.login, name: e2eGitHubOrgB.repo, defaultBranch: "main", branches: ["main"], files: { "README.md": "# billing\n" } },
      {
        id: 4_001,
        owner: e2eRepo.owner,
        name: e2eRepo.name,
        defaultBranch: "main",
        branches: ["main"],
        files: {
          "package.json": JSON.stringify({ name: "test1", scripts: { test: "vitest run" }, packageManager: "pnpm@11.0.0" }),
          "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
          ".nvmrc": "24\n",
          "README.md": "# test1\n",
        },
      },
      // F-098 (ticket 39): a second repo of the same installation, for a project with several repos.
      { id: 4_003, owner: e2eRepo.owner, name: "test2", defaultBranch: "main", branches: ["main"], files: { "README.md": "# test2\n" } },
    ],
  });

  // The specs read the database's address, the data folder and the fake GitHub's App from here (gitignored).
  // The second stack (OSTRA_ALLOW_DEFAULT_PASSWORD, playwright.config.ts) keeps its own.
  await writeFile(
    path.join(webDir, "e2e", allowDefaultPassword ? ".stack-default-password.json" : pseudoLocale ? ".stack-pseudo.json" : ".stack.json"),
    JSON.stringify({
      databaseUrl,
      github: { appId: github.appId, privateKey: github.privateKey, webhookSecret: github.webhookSecret, slug: github.appSlug },
      githubB: {
        login: e2eGitHubOrgB.login,
        repo: e2eGitHubOrgB.repo,
        appId: github.secondApp?.appId ?? "",
        privateKey: github.secondApp?.privateKey ?? "",
        slug: github.secondApp?.appSlug ?? "",
      },
    }),
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
      OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE: "true",
    },
  });

  let stopping = false;
  const stop = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    panel.kill();
    core.kill();
    await github.close().catch(() => undefined);
    await stub.close().catch(() => undefined);
    await openAiStub.close().catch(() => undefined);
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
