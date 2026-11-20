import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDb } from "@ostra/db";
import { devDatabaseUrl, devDataDir } from "@ostra/db/dev";
import { demoGitHub } from "@ostra/e2e-m1/github";
import { createProject, loadState, say, signInAsAdmin } from "@ostra/e2e-m1/setup";
import { repoRoot } from "@ostra/e2e-m1/settings";
import { linearTool } from "@ostra/e2e-m2/linear";
import { seedLinear } from "@ostra/e2e-m2/seed-linear";
import type { M2Settings } from "@ostra/e2e-m2/settings";
import { panelApi } from "@ostra/e2e-m2-failures/api";
import { killAll } from "@ostra/e2e-m2-failures/procs";
import { resetDevData } from "@ostra/e2e-m2-failures/stack";
import { STUB_KEY, STUB_MODEL_ID, startStubModel } from "@ostra/e2e-m2-failures/stub-model";
import { attachBoard } from "@ostra/e2e-m2-failures/world";
import type { Db } from "@ostra/db";
import { organizationIdSchema, projectIdSchema } from "@ostra/protocol";
import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

import { recordCheck, screenshotTo } from "./context.ts";
import type { CheckResult, Demo, Project } from "./context.ts";
import { installCli } from "./runners.ts";
import type { M5Settings } from "./settings.ts";
import { startDevTool, startStack, stackEnv } from "./stack.ts";
import type { DevTool, Stack } from "./stack.ts";

// The demo's "Before" (spec section 3): an empty data folder, the stub model, three core replicas
// and the panel, ticket 36's dev tools, the CLI packed and installed from its tarball, and milestones
// 1 to 4's setup by their own helpers: the first admin, the model provider, the test App, the
// projects `test1` and `test2`, Linear's `OST` on `test1`, and Sam as a second member.

/** The label of the demo's Linear webhook: never the failure suite's or milestone 2's. */
export const DEMO_WEBHOOK_LABEL = "ostra e2e m5 demo";

const runToEnd = (script: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, script), ...args], { cwd: repoRoot, env, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with ${String(code)}`));
    });
  });

/** A second project, on `repo`: milestone 1's helper makes only the first one (it skips once the checklist's step is done). */
const createSecondProject = async (page: Page, settings: M2Settings, repo: string): Promise<string> => {
  say(`setup: create the project ${repo}`);
  await page.goto("/projects/new");
  await page.locator(`li[data-repo="${settings.githubOrg}/${repo}"]`).getByRole("checkbox").check({ timeout: 60_000 });
  await page.locator("#project-name").fill(repo);
  await page.getByRole("button", { name: "Create the project" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/environment/, { timeout: 60_000 });
  await page.getByRole("button", { name: "Save environment" }).click();
  await page.getByText("Saved.").first().waitFor({ timeout: 30_000 });
  await page.goto("/");
  const href = await page.locator('a[href^="/projects/"]').filter({ hasText: repo }).first().getAttribute("href");
  if (href === null) throw new Error(`the project ${repo} isn't in the sidebar`);
  return href;
};

/**
 * Step 3 of milestone 1's demo, on milestone 4's Models page: the stub as the organization's
 * provider, allowed on personal runners, its model the built-in profile's. Milestone 1's helper
 * reads the page as it was before milestone 4's lists.
 */
const addProvider = async (page: Page, settings: M2Settings, db: Db): Promise<void> => {
  say("setup: the stub model as the organization's provider");
  await page.goto("/organization/models");
  await page.getByLabel("Name", { exact: true }).fill("dev endpoint");
  await page.getByLabel("API base URL").fill(settings.modelBaseUrl);
  await page.getByLabel("Token", { exact: true }).fill(settings.modelApiKey);
  await page.getByRole("button", { name: "Test connection" }).click();
  await page.getByTestId("test-result").waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Save provider" }).click();
  const model = await (async () => {
    for (let tries = 0; tries < 60; tries += 1) {
      const row = await db.model.findFirst({ where: { endpointModelId: settings.modelId }, select: { id: true, providerId: true } });
      if (row !== null) return row;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("the provider's model never appeared");
  })();
  const api = panelApi(page.context().request, settings.panelUrl);
  await api.mutate("providers.update", { providerId: model.providerId, allowOnPersonalRunners: true });
  await api.mutate("agentProfiles.setDefaultModel", { modelId: model.id });
};

/** Step 4 of milestone 1's demo, on milestone 4's GitHub page: the test App, with its installation on the test org listed. */
const connectApp = async (page: Page, settings: M2Settings): Promise<void> => {
  say("setup: connect the existing GitHub App");
  await page.goto("/organization/github");
  await page.locator("#app-id").fill(settings.githubAppId);
  await page.locator("#private-key").fill(await readFile(settings.githubPrivateKeyPath, "utf8"));
  await page.locator("#webhook-secret").fill(settings.githubWebhookSecret);
  await page.getByRole("button", { name: "Connect the App" }).click();
  await page.getByTestId("github-app").waitFor({ timeout: 60_000 });
  await page.getByTestId("installation").filter({ hasText: settings.githubOrg }).first().waitFor({ timeout: 60_000 });
};

const signInAs = async (page: Page, username: string, password: string): Promise<void> => {
  await page.goto("/sign-in");
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/sign-in", { timeout: 30_000 });
};

export type Opened = { readonly demo: Demo; readonly close: () => Promise<void> };

export const openDemo = async (settings: M5Settings): Promise<Opened> => {
  const startedAt = Date.now();
  // What the stack reads, and nothing of the demo's own: the server refuses an OSTRA_* it doesn't know.
  const baseEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("OSTRA_E2E_") && !name.startsWith("OSTRA_FS_") && !["DATABASE_URL", "OSTRA_PUBLIC_URL", "OSTRA_CORE_PUBLIC_URL", "OSTRA_DEV_PUBLIC_URL"].includes(name),
    ),
  );
  // The helpers shared with the earlier demos read the stack's database port from this process's environment.
  process.env["OSTRA_DEV_PG_PORT"] = String(settings.ports.pg);

  say("setup: an empty data folder");
  await resetDevData(baseEnv, settings.ports);
  await rm(settings.runnersDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  const logDir = path.join(settings.stateDir, "logs");
  await rm(logDir, { recursive: true, force: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(settings.screenshotDir, { recursive: true });

  // What has started so far, stopped in reverse when the setup fails half-way.
  const started: (() => Promise<void>)[] = [];
  const stopStarted = async (): Promise<void> => {
    for (const stop of started.reverse()) await stop().catch(() => undefined);
    await killAll();
  };
  try {
    return await setUp(settings, baseEnv, logDir, started, startedAt);
  } catch (error) {
    await stopStarted();
    throw error;
  }
};

const setUp = async (settings: M5Settings, baseEnv: NodeJS.ProcessEnv, logDir: string, started: (() => Promise<void>)[], startedAt: number): Promise<Opened> => {
  const stub = await startStubModel();
  started.push(() => stub.close());
  const toolEnv: NodeJS.ProcessEnv = {
    ...stackEnv(baseEnv, settings.ports),
    OSTRA_DEV_FAKE_KUBE_PORT: String(settings.tools.fakeKube),
    OSTRA_DEV_REGISTRY_PORT: String(settings.tools.registry),
    OSTRA_DEV_NPM_REGISTRY_PORT: String(settings.tools.npmRegistry),
    OSTRA_DEV_NET_PROXIES_PORT: String(settings.tools.netProxies),
  };
  say("setup: the stack (the database, three core replicas, the panel)");
  const stack: Stack = await startStack({
    ports: settings.ports,
    replicas: settings.replicas,
    baseEnv,
    serverEnv: {
      OSTRA_PUBLIC_URL: settings.panelUrl,
      OSTRA_CORE_PUBLIC_URL: settings.coreUrls[0] ?? settings.panelUrl,
      OSTRA_ALLOW_DEFAULT_PASSWORD: "true",
      OSTRA_DEV_HOST_POOL_SAME_USER: "true",
      OSTRA_BOX_IDLE_MINUTES: "1",
      OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE: "true",
      OSTRA_CATALOG_FETCH: "false",
      OSTRA_RECONCILE_MINUTES: "1",
    },
    logDir,
  });
  started.push(() => stack.stop());
  say("setup: ticket 36's dev tools");
  const tools: Record<"fakeKube" | "registry" | "npmRegistry" | "netProxies", DevTool> = {
    fakeKube: await startDevTool("e2e/m5-the-fleet/src/dev/fake-kube.ts", ["--process"], toolEnv),
    registry: await startDevTool("e2e/m5-the-fleet/src/dev/registry.ts", [], toolEnv),
    npmRegistry: await startDevTool("e2e/m5-the-fleet/src/dev/npm-registry.ts", [], toolEnv),
    netProxies: await startDevTool("e2e/m5-the-fleet/src/dev/net-proxies.ts", [], toolEnv),
  };
  for (const one of Object.values(tools)) started.push(() => one.stop());
  say("setup: pack the CLI and install it from its tarball");
  const cli = await installCli(path.join(settings.runnersDir, "cli"), true);

  const db = createDb(devDatabaseUrl(settings.ports.pg), { maxConnections: 4 });
  started.push(() => db.$disconnect());
  const m2 = { ...settings.m2, modelBaseUrl: stub.baseUrl, modelApiKey: STUB_KEY, modelId: STUB_MODEL_ID, coreUrl: stack.coreUrls[0] ?? "", panelUrl: settings.panelUrl };
  const browser: Browser = await chromium.launch();
  started.push(() => browser.close());
  const newPage = async (): Promise<Page> => {
    const context = await browser.newContext({ baseURL: settings.panelUrl, viewport: { width: 1440, height: 956 } });
    // The dev server's own indicator sits over the sheets' buttons: hidden, as in a production build.
    await context.addInitScript({
      content: "document.addEventListener('DOMContentLoaded', () => { const style = document.createElement('style'); style.textContent = 'nextjs-portal { display: none !important; }'; document.head.append(style); });",
    });
    return context.newPage();
  };
  const demoPage = await newPage();
  await signInAsAdmin(demoPage, m2, await loadState(path.join(settings.stateDir, "state.json")));
  await addProvider(demoPage, m2, db);
  await connectApp(demoPage, m2);
  const test1Href = await createProject(demoPage, m2);
  const test2Href = await createSecondProject(demoPage, m2, m2.githubOtherRepo);
  const tool = linearTool(m2.linearApiKey);
  const seeded = await seedLinear({
    db,
    tool,
    env: {},
    serverDataDir: path.join(devDataDir, "server"),
    apiKey: m2.linearApiKey,
    teamId: m2.linearTeamId,
    // No tunnel: the connection polls every minute (F-042).
    publicUrl: null,
    webhookLabel: DEMO_WEBHOOK_LABEL,
  });
  await attachBoard(demoPage, m2, test1Href);
  const test1: Project = { id: projectIdSchema.parse(test1Href.split("/").at(-1)), href: test1Href, repo: m2.githubRepo };
  const test2: Project = { id: projectIdSchema.parse(test2Href.split("/").at(-1)), href: test2Href, repo: m2.githubOtherRepo };
  const board = await db.board.findFirstOrThrow({ where: { projectId: test1.id }, select: { id: true } });

  say("setup: Sam, the second member");
  await runToEnd("packages/api/scripts/seed-member.ts", [settings.samUsername, "--password", settings.samPassword], { ...stackEnv(baseEnv, settings.ports) });
  const samPage = await newPage();
  await signInAs(samPage, settings.samUsername, settings.samPassword);

  const checks: CheckResult[] = [];
  const notes: { step: number; text: string }[] = [];
  const demo: Demo = {
    settings,
    stack,
    tools,
    toolEnv,
    db,
    organizationId: organizationIdSchema.parse(seeded.organizationId),
    demo: demoPage,
    api: panelApi(demoPage.context().request, settings.panelUrl),
    sam: samPage,
    samApi: panelApi(samPage.context().request, settings.panelUrl),
    tool,
    github: { test1: await demoGitHub(m2), test2: await demoGitHub({ ...m2, githubRepo: m2.githubOtherRepo }) },
    test1,
    test2,
    boardId: board.id,
    cli,
    logDir,
    runners: new Map(),
    stopLater: [],
    secrets: [],
    made: { tickets: [], taskIds: [] },
    facts: {},
    checks,
    timings: { setup: Math.round((Date.now() - startedAt) / 1000) },
    check: recordCheck(checks),
    notes,
    note: (step, text) => {
      notes.push({ step, text });
      say(`NOTE ${String(step)}. ${text}`);
    },
    shot: screenshotTo(settings.screenshotDir),
  };
  say(`setup: done in ${String(demo.timings["setup"] ?? 0)} s`);
  return {
    demo,
    close: async () => {
      await browser.close().catch(() => undefined);
      for (const runner of demo.runners.values()) await runner.stop().catch(() => undefined);
      for (const stop of demo.stopLater) await stop().catch(() => undefined);
      // The tools' output, kept with the run's logs: the registry's is left out, since it prints its credentials.
      for (const [name, one] of Object.entries(tools)) {
        if (name !== "registry") await writeFile(path.join(logDir, `tool-${name}.log`), `${one.lines.join("\n")}\n`).catch(() => undefined);
      }
      for (const one of Object.values(tools)) await one.stop().catch(() => undefined);
      await stack.stop().catch(() => undefined);
      await stub.close();
      await db.$disconnect();
    },
  };
};
