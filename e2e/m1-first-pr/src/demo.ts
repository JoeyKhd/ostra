// `pnpm e2e:m1` (ticket 39): milestone 1's demo (spec section 3), on this machine, against a
// running dev stack (`pnpm dev`) and the test org. It drives the panel in Chromium: the first
// admin, the model provider, the GitHub App, the project and its environment, the runner's device
// approval and the prompt. It starts `ostra runner` on the host executor, waits for the PR, and
// keeps screenshots under the spec folder. Every step that already happened is skipped, so a run
// can pick up where the last one stopped.
//
// Secrets come from the environment (loaded from ~/.config/ostra-dev/) and are typed into forms
// only: never printed. Run it with model.env, github.env and github-test.env loaded.

import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "@playwright/test";
import { taskIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import type { Browser, BrowserContext, Page } from "@playwright/test";

import {
  checkAgentTokenCount,
  checkGitProxy,
  checkNoCredential,
  checkNoEmptyPr,
  checkNoTaskFolderLeft,
  checkPullRequest,
  checkStoppedMidTurn,
  checkStoppedRefs,
  checkTaskFolder,
  checkTokens,
  taskCheckout,
} from "./checks.ts";
import type { CheckResult } from "./checks.ts";
import { cleanUp, demoGitHub } from "./github.ts";
import type { DemoGitHub } from "./github.ts";
import { demoSettings, repoRoot } from "./settings.ts";
import type { DemoSettings } from "./settings.ts";
import { startRunner } from "./runner.ts";
import type { RunningRunner } from "./runner.ts";

const say = (line: string): void => {
  process.stdout.write(`[demo] ${line}\n`);
};

type DemoState = { readonly password: string };

const loadState = async (file: string): Promise<DemoState> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const password: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "password") : undefined;
    if (typeof password === "string") return { password };
  } catch {
    // No state yet: a fresh stack.
  }
  const state = { password: randomBytes(18).toString("base64url") };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state), { mode: 0o600 });
  return state;
};

let shot = 0;
const screenshot = async (page: Page, settings: DemoSettings, name: string): Promise<void> => {
  shot += 1;
  const file = path.join(settings.screenshotDir, `${String(shot).padStart(2, "0")}-${name}.png`);
  // The screenshots are committed: the dev endpoint's address and this machine's folders are masked.
  const mask = [
    page.locator("#identifier"),
    page.locator("#email"),
    page.getByLabel("API base URL"),
    page.getByText(settings.modelBaseUrl),
    page.getByText(/[A-Za-z]:\\Users\\|\/home\/|\/Users\//),
  ];
  await page.screenshot({ path: file, fullPage: false, mask });
  say(`screenshot ${path.relative(repoRoot, file)}`);
};

/** Signs in with one password; whether the panel let the browser past the sign-in page. */
const trySignIn = async (page: Page, settings: DemoSettings, password: string): Promise<boolean> => {
  await page.goto("/sign-in");
  await page.getByLabel("Username or email").fill(settings.adminUsername);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  return page.waitForURL((url) => url.pathname !== "/sign-in", { timeout: 15_000 }).then(
    () => true,
    () => false,
  );
};

/**
 * Step 2: the first admin, which the server seeded at its first start (F-001). With
 * OSTRA_ADMIN_PASSWORD set, it signs in with that. Otherwise a fresh stack's admin still has the
 * default password, demo: it signs in with it and chooses the demo's own password, kept in the
 * state file for the next run.
 */
const signInAsAdmin = async (page: Page, settings: DemoSettings, state: DemoState): Promise<void> => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  if (new URL(page.url()).pathname !== "/sign-in") return;
  if (settings.adminPassword !== null) {
    say("signing in");
    if (!(await trySignIn(page, settings, settings.adminPassword))) throw new Error("the admin's sign-in failed: check OSTRA_ADMIN_USERNAME and OSTRA_ADMIN_PASSWORD");
    return;
  }
  if (await trySignIn(page, settings, "demo")) {
    say("step 2: the seeded admin chooses its own password");
    // The panel sends it there itself; going there directly also covers OSTRA_ALLOW_DEFAULT_PASSWORD.
    await page.goto("/change-password");
    await page.getByLabel("New password", { exact: true }).fill(state.password);
    await page.getByLabel("Confirm the new password").fill(state.password);
    await screenshot(page, settings, "change-password");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.waitForURL((url) => url.pathname === "/");
    // A fresh stack: a runner identity from an earlier one would be refused.
    await rm(settings.runnerDataDir, { recursive: true, force: true });
    return;
  }
  say("signing in");
  if (!(await trySignIn(page, settings, state.password))) throw new Error("the admin's sign-in failed: the stack's admin isn't the one this demo set up");
};

const stepDone = async (page: Page, step: string): Promise<boolean> => {
  await page.goto("/");
  const item = page.locator(`[data-step="${step}"]`);
  await item.waitFor();
  return (await item.getAttribute("data-done")) === "true";
};

const addModelProvider = async (page: Page, settings: DemoSettings): Promise<void> => {
  if (await stepDone(page, "model-provider")) {
    say("step 3: the model provider is there");
  } else {
    say("step 3: add the model provider");
    await page.goto("/organization/models");
    await page.getByLabel("Name", { exact: true }).fill(providerName);
    await page.getByLabel("API base URL").fill(settings.modelBaseUrl);
    await page.getByLabel("Token", { exact: true }).fill(settings.modelApiKey);
    await page.getByRole("button", { name: "Test connection" }).click();
    await page.getByTestId("test-result").waitFor({ timeout: 60_000 });
    await screenshot(page, settings, "provider-tested");
    await page.getByRole("button", { name: "Save provider" }).click();
    await page.getByTestId("provider-settings").waitFor({ timeout: 30_000 });
  }
  // The only runner is personal: the provider must allow it (off by default).
  const allow = await openProvider(page).then(() => page.getByLabel("Allow on personal runners"));
  if ((await allow.getAttribute("data-state")) !== "checked") {
    say("step 3: allow the provider on personal runners");
    await allow.click();
    await page.waitForResponse((response) => response.url().includes("providers.update"));
    await openProvider(page);
    await page.locator('#settings-personal[data-state="checked"]').waitFor();
  }
  const row = page.locator(`tr[data-model="${settings.modelId}"]`);
  await row.waitFor({ timeout: 30_000 });
  if (!(await row.innerText()).includes("default")) {
    say("step 3: make the dev model the built-in OpenCode profile's model");
    await row.click();
    await page.getByRole("button", { name: "Use as default model" }).click();
    await page.waitForResponse((response) => response.url().includes("agentProfiles.setDefaultModel"));
    await openProvider(page);
    await page.locator(`tr[data-model="${settings.modelId}"]`).getByText("default", { exact: true }).waitFor();
  }
  await screenshot(page, settings, "provider-saved");
};

const providerName = "dev endpoint";

const openProvider = async (page: Page): Promise<void> => {
  await page.goto("/organization/models");
  await page.getByRole("button", { name: new RegExp(providerName) }).first().click();
  await page.getByTestId("provider-settings").waitFor();
};

const connectGitHub = async (page: Page, settings: DemoSettings): Promise<void> => {
  if (await stepDone(page, "github")) {
    say("step 4: GitHub is connected");
    return;
  }
  say("step 4: connect the existing GitHub App");
  await page.goto("/organization/github");
  await page.locator("#app-id").fill(settings.githubAppId);
  await page.locator("#private-key").fill(await readFile(settings.githubPrivateKeyPath, "utf8"));
  await page.locator("#webhook-secret").fill(settings.githubWebhookSecret);
  await page.getByRole("button", { name: "Connect the App" }).click();
  await page.getByTestId("github-connection").waitFor({ timeout: 60_000 });
  // The installations load after the connection: the test org's row, not the sidebar's org name.
  await page.locator("ul.rows li", { hasText: settings.githubOrg }).first().waitFor({ timeout: 30_000 });
  await screenshot(page, settings, "github-connected");
};

const createProject = async (page: Page, settings: DemoSettings): Promise<string> => {
  if (!(await stepDone(page, "project"))) {
    say("step 5: create the project");
    await page.goto("/projects/new");
    await page.locator(`input[name="repo"][value="${settings.githubOrg}/${settings.githubRepo}"]`).check({ timeout: 60_000 });
    await page.locator("#project-name").fill(settings.githubRepo);
    await screenshot(page, settings, "project-new");
    await page.getByRole("button", { name: "Create the project" }).click();
    await page.waitForURL(/\/projects\/[^/]+\/environment/, { timeout: 60_000 });
    await page.getByRole("button", { name: "Save environment" }).waitFor();
    await screenshot(page, settings, "environment-draft");
    await page.getByRole("button", { name: "Save environment" }).click();
    await page.getByText("Saved.").first().waitFor({ timeout: 30_000 });
    await screenshot(page, settings, "environment-saved");
  } else {
    say("step 5: the project is there");
  }
  await page.goto("/");
  const link = page.locator('a[href^="/projects/"]').filter({ hasText: settings.githubRepo }).first();
  const href = await link.getAttribute("href");
  if (href === null) throw new Error("the project isn't in the sidebar");
  return href;
};

const connectRunner = async (page: Page, settings: DemoSettings): Promise<RunningRunner> => {
  say("step 6: start the runner");
  const runner = await startRunner(settings);
  const code = await runner.deviceCode;
  if (code !== null) {
    say("step 6: approve the runner's code in the panel");
    await page.goto("/device");
    await page.locator("#user-code").fill(code);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("device-confirm").waitFor();
    await screenshot(page, settings, "device-approve");
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByText(/^Approved\./).waitFor();
  } else {
    say("step 6: the runner is already signed in");
  }
  await runner.online;
  await page.goto("/organization/runners");
  await page.getByTestId("my-runners").getByText(settings.runnerName).waitFor({ timeout: 60_000 });
  await screenshot(page, settings, "runner-online");
  return runner;
};

const startTask = async (page: Page, settings: DemoSettings, projectHref: string, prompt: string): Promise<TaskId> => {
  await page.goto(projectHref);
  const form = page.getByTestId("new-task");
  await form.locator("textarea").fill(prompt);
  // "Run on" lists the member's personal runners once they load; the demo's is the only runner.
  await form.getByRole("combobox", { name: "Run on" }).click();
  await page.getByRole("option", { name: new RegExp(settings.runnerName) }).click({ timeout: 30_000 });
  await screenshot(page, settings, "prompt");
  await form.getByRole("button", { name: /Start/ }).click();
  await page.waitForURL(/\/tasks\/[^/]+$/, { timeout: 30_000 });
  const taskId = taskIdSchema.parse(new URL(page.url()).pathname.split("/").at(-1));
  say(`task ${taskId} started`);
  return taskId;
};

/** Step 8: a second tab shows the same thread, and a reload mid-turn brings the history back. */
const secondViewer = async (context: BrowserContext, page: Page, settings: DemoSettings): Promise<void> => {
  const second = await context.newPage();
  await second.goto(page.url());
  await second.locator('[data-part="tool"]').first().waitFor({ state: "attached", timeout: 60_000 });
  await screenshot(second, settings, "second-tab");
  await second.close();
  await page.reload();
  await page.locator('[data-part="tool"]').first().waitFor({ state: "attached", timeout: 60_000 });
  await screenshot(page, settings, "after-reload");
};

const watchUntilPullRequest = async (context: BrowserContext, page: Page, settings: DemoSettings, timeoutMs: number): Promise<string> => {
  const started = Date.now();
  let next = 0;
  let viewed = false;
  while (Date.now() - started < timeoutMs) {
    const link = page.getByTestId("pr-link").first();
    if ((await link.count()) > 0) {
      const href = await link.getAttribute("href");
      if (href !== null) {
        await screenshot(page, settings, "pull-request");
        return href;
      }
    }
    if (!viewed && (await page.locator('[data-part="tool"]').count()) > 0) {
      viewed = true;
      await secondViewer(context, page, settings);
    }
    if (Date.now() >= next) {
      await screenshot(page, settings, "watching");
      next = Date.now() + 30_000;
    }
    await page.waitForTimeout(2000);
  }
  await screenshot(page, settings, "timed-out");
  throw new Error("no pull request in time");
};

/** A task whose prompt asks only for an explanation: it ends without changes and lands in needs you. */
const emptyTask = async (page: Page, settings: DemoSettings, projectHref: string): Promise<TaskId> => {
  const taskId = await startTask(page, settings, projectHref, "In two sentences, explain what this repository is for. Only answer: do not create, change or commit any file.");
  await page.getByTestId("needs-you").waitFor({ timeout: 15 * 60_000 });
  await screenshot(page, settings, "needs-you");
  return taskId;
};

/** A task stopped mid-turn; while it runs, the git proxy is tried from its checkout, and its folders, its agent's environment and its token count are checked. */
const stoppedTask = async (
  page: Page,
  settings: DemoSettings,
  github: DemoGitHub,
  runner: RunningRunner,
  projectHref: string,
): Promise<{ readonly taskId: TaskId; readonly live: readonly CheckResult[] }> => {
  const taskId = await startTask(
    page,
    settings,
    projectHref,
    `Create docs/numbers.md listing the numbers one to ten as words, one per line. Then run this shell command in the foreground and wait for it to finish; it waits ten minutes. Don't move it to the background. node -e "setTimeout(() => {}, 600000)"`,
  );
  // The git proxy lives as long as the task: tried as soon as the agent is at work.
  await page.locator('[data-part="tool"]').first().waitFor({ state: "attached", timeout: 10 * 60_000 });
  await waitForPath(taskCheckout(settings, taskId), 60_000);
  const proxy = await checkGitProxy(github, settings, taskId);
  // Stopped while the agent's command waits, after it wrote the file: the unfinished work the hidden ref keeps.
  await page.locator('[data-part="tool"]', { hasText: "setTimeout" }).first().waitFor({ timeout: 10 * 60_000 });
  // Every model call is done: the agent waits on its command. Its folders and environment still exist.
  const folder = await checkTaskFolder(settings, taskId, runner.pid);
  const tokens = await checkAgentTokenCount(settings, taskId);
  await screenshot(page, settings, "before-stop");
  await page.locator('[data-action="stop"]').click();
  await page.getByText("Stopped").first().waitFor({ timeout: 5 * 60_000 });
  // The hidden ref is pushed as the run ends.
  await page.waitForTimeout(10_000);
  await screenshot(page, settings, "stopped");
  return { taskId, live: [...proxy, ...folder, tokens] };
};

const waitForPath = async (target: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(target);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("the task's checkout never appeared");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};

const pullNumber = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? Number.NaN);

const main = async (): Promise<void> => {
  const settings = demoSettings(process.env);
  await mkdir(settings.screenshotDir, { recursive: true });
  const state = await loadState(path.join(settings.dataDir, "e2e-m1", "state.json"));
  const github = await demoGitHub(settings);
  let browser: Browser | null = null;
  let runner: RunningRunner | null = null;
  const checks: CheckResult[] = [];
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ baseURL: settings.panelUrl, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await signInAsAdmin(page, settings, state);
    await screenshot(page, settings, "checklist");
    await addModelProvider(page, settings);
    await connectGitHub(page, settings);
    const projectHref = await createProject(page, settings);
    runner = await connectRunner(page, settings);

    const taskId = await startTask(page, settings, projectHref, settings.prompt);
    const pr = await watchUntilPullRequest(context, page, settings, 20 * 60_000);
    say(`pull request: ${pr}`);
    const prNumber = pullNumber(pr);
    if (!Number.isInteger(prNumber)) throw new Error("the PR link has no number");
    checks.push(
      await checkPullRequest(github, prNumber, { botLogin: github.botLogin, adminUsername: settings.adminUsername, publicUrl: settings.publicUrl, taskId, prompt: settings.prompt }),
    );
    checks.push(await checkTokens(taskId));

    if (process.argv.includes("--checks")) {
      const empty = await emptyTask(page, settings, projectHref);
      checks.push(await checkNoEmptyPr(github, empty));
      const stopped = await stoppedTask(page, settings, github, runner, projectHref);
      checks.push(...stopped.live, await checkStoppedMidTurn(github, stopped.taskId), await checkStoppedRefs(github, stopped.taskId));
      checks.push(await checkNoCredential(settings, settings.logFiles), await checkNoTaskFolderLeft(settings));
    }
    for (const check of checks) say(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    await writeFile(path.join(settings.dataDir, "e2e-m1", "result.json"), JSON.stringify({ taskId, pullRequest: pr, checks }, null, 2));
    if (process.argv.includes("--clean-up")) {
      const cleaned = await cleanUp(github, new Set([prNumber]));
      say(`clean-up: closed ${String(cleaned.closed)} PRs, deleted ${String(cleaned.deleted)} refs; kept ${pr}`);
    }
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  } finally {
    await browser?.close();
    await runner?.stop();
  }
};

await main();

