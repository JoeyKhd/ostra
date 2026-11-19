import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { taskIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import type { Page } from "@playwright/test";

import { assertTaskInDatabase } from "./checks.ts";
import { repoRoot } from "./settings.ts";
import type { DemoSettings } from "./settings.ts";
import { startRunner } from "./runner.ts";
import type { RunningRunner } from "./runner.ts";

// Milestone 1's demo steps that later milestones' demos start from (spec section 3, steps 2 to 6):
// the first admin, the model provider, the GitHub App, the project and a personal runner, each
// skipped when it already happened. Secrets are typed into forms only, never printed.

export const say = (line: string): void => {
  process.stdout.write(`[demo] ${line}\n`);
};

export type DemoState = { readonly password: string };

export const loadState = async (file: string): Promise<DemoState> => {
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
export const screenshot = async (page: Page, settings: DemoSettings, name: string): Promise<void> => {
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
export const trySignIn = async (page: Page, settings: DemoSettings, password: string): Promise<boolean> => {
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
export const signInAsAdmin = async (page: Page, settings: DemoSettings, state: DemoState): Promise<void> => {
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

export const stepDone = async (page: Page, step: string): Promise<boolean> => {
  await page.goto("/");
  const item = page.locator(`[data-step="${step}"]`);
  await item.waitFor();
  return (await item.getAttribute("data-done")) === "true";
};

export const addModelProvider = async (page: Page, settings: DemoSettings): Promise<void> => {
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

export const providerName = "dev endpoint";

export const openProvider = async (page: Page): Promise<void> => {
  await page.goto("/organization/models");
  await page.getByRole("button", { name: new RegExp(providerName) }).first().click();
  await page.getByTestId("provider-settings").waitFor();
};

export const connectGitHub = async (page: Page, settings: DemoSettings): Promise<void> => {
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

export const createProject = async (page: Page, settings: DemoSettings): Promise<string> => {
  if (!(await stepDone(page, "project"))) {
    say("step 5: create the project");
    await page.goto("/projects/new");
    await page.locator(`li[data-repo="${settings.githubOrg}/${settings.githubRepo}"]`).getByRole("checkbox").check({ timeout: 60_000 });
    await page.locator("#project-name").fill(settings.githubRepo);
    await screenshot(page, settings, "project-new");
    await page.getByRole("button", { name: "Create the project" }).click();
    await page.waitForURL(/\/projects\/[^/]+\/environment/, { timeout: 60_000 });
    await page.getByRole("button", { name: "Save environment" }).waitFor();
    if (settings.setupScript !== null) {
      await page.getByRole("textbox", { name: "Setup script" }).fill(settings.setupScript);
    }
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

export const connectRunner = async (page: Page, settings: DemoSettings, logFile?: string): Promise<RunningRunner> => {
  say(`step 6: start the runner ${settings.runnerName}`);
  const runner = await startRunner(settings, logFile);
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

export const startTask = async (page: Page, settings: DemoSettings, projectHref: string, prompt: string): Promise<TaskId> => {
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
  // The checks read Postgres directly: stop now, not after the run, if it isn't this stack's.
  await assertTaskInDatabase(taskId);
  say(`task ${taskId} started`);
  return taskId;
};


export const waitForPath = async (target: string, timeoutMs: number): Promise<void> => {
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
