import { expect, test } from "@playwright/test";

import { checklistSteps, readStack, signIn, watchOrigins } from "./helpers.ts";
import { startRunner } from "./runner.ts";
import type { E2eRunner } from "./runner.ts";
import { e2eCoreUrl, e2eRepo, e2eRunnerName } from "./settings.ts";

// Ticket 37: the rest of the first-run checklist, from "Connect GitHub" to a runner approved. The
// first admin and the model provider (against the stub endpoint) are the two specs before this
// one, in the same stack. GitHub is a fake (`@ostra/adapter-github/testing`) that the panel and
// core reach through OSTRA_GITHUB_API_URL; the runner is the real `ostra runner` on the host
// executor, signing in with a device code. The last test starts the first task from a prompt,
// which finishes the checklist. Desktop only: the steps run once, so the phone project leaves
// this file out (playwright.config.ts).

test.describe.configure({ mode: "serial" });

let runner: E2eRunner | undefined;
test.afterAll(async () => {
  await runner?.stop();
});

test("Connect GitHub with an existing App, create a project from its repo, and the checklist ticks", async ({ page }) => {
  const origins = watchOrigins(page);
  const { github } = await readStack();
  await signIn(page);

  await page.goto("/organization/github");
  await page.getByLabel("App ID").fill(github.appId);
  await page.getByLabel("Private key", { exact: true }).fill(github.privateKey);
  await page.getByLabel("Webhook secret").fill(github.webhookSecret);
  await page.getByRole("button", { name: "Connect the App" }).click();
  // F-136: the connected App shows as its own section, by its slug.
  const connection = page.getByTestId("github-app").first();
  await expect(connection).toBeVisible();
  await expect(connection).toContainText(github.slug);
  // The key and the secret are never shown back.
  const shown = await page.content();
  expect(shown).not.toContain("BEGIN RSA PRIVATE KEY");
  expect(shown).not.toContain(github.webhookSecret);

  await page.goto("/projects/new");
  await page.getByRole("checkbox", { name: new RegExp(`${e2eRepo.owner}/${e2eRepo.name}`) }).check();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(e2eRepo.name);
  await page.getByRole("button", { name: "Create the project" }).click();

  // The environment draft, with its reasons, then Save.
  await page.waitForURL(/\/projects\/[^/]+\/environment/);
  await expect(page.getByText(`Found in ${e2eRepo.owner}/${e2eRepo.name}`)).toBeVisible();
  await page.getByRole("button", { name: "Save environment" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  await page.goto("/");
  for (const step of ["admin", "model-provider", "github", "project"]) {
    await expect(page.locator(`[data-step="${step}"]`)).toHaveAttribute("data-done", "true");
  }
  await expect(page.locator('[data-step="runner"]')).toHaveAttribute("data-done", "false");
  expect(origins.foreign()).toEqual([]);
});

test("Connect a runner: the command, the device approval, the runner online and not isolated", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);

  await page.goto("/organization/runners");
  await expect(page.getByText(`pnpm ostra runner --server ${e2eCoreUrl}`)).toBeVisible();
  await expect(page.getByTestId("my-runners")).not.toContainText(e2eRunnerName);

  // The runner prints a code; the admin approves it in the panel.
  runner = await startRunner();
  const code = await runner.deviceCode;
  await page.goto("/device");
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("device-confirm")).toContainText("Personal, not isolated");
  await page.getByRole("button", { name: "Approve" }).click();
  // The device page's own status line: the shell's toast region is a status too.
  await expect(page.getByTestId("device-confirm").getByRole("status")).toContainText("Approved");
  await runner.signedIn;

  // It shows online, labelled "personal, not isolated".
  await page.goto("/organization/runners");
  const row = page.getByTestId("my-runners").locator(`[data-runner="${e2eRunnerName}"]`);
  await expect(row).toContainText("online", { timeout: 30_000 });
  await expect(row).toContainText("personal");
  await expect(row).toContainText("host");
  await expect(row).toContainText("not isolated");

  await page.goto("/");
  await expect(page.locator('[data-step="runner"]')).toHaveAttribute("data-done", "true");
  // Every step but the first task ticks: that one needs a model.
  await expect(page.locator('[data-step="first-task"]')).toHaveAttribute("data-done", "false");
});

test("F-076: with the runner online, the checklist's last step starts the first task from a prompt, and setup is done without Linear", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  const checklist = page.getByTestId("setup-checklist");
  await expect(checklist).toBeVisible();
  expect(await checklistSteps(page)).toEqual(["admin", "model-provider", "github", "linear", "project", "runner", "first-task"]);
  await expect(page.getByText("5 of 7", { exact: true })).toBeVisible();
  for (const step of ["admin", "model-provider", "github", "project", "runner"]) {
    await expect(page.locator(`[data-step="${step}"]`)).toHaveAttribute("data-done", "true");
    // A step that's done has nothing left to click but its page in the docs.
    await expect(page.locator(`[data-step="${step}"] a:not([data-docs])`)).toHaveCount(0);
  }
  // Linear is neither connected nor skipped: it's the next step, and the first task is still open.
  await expect(page.locator('[data-step="linear"]')).toHaveAttribute("data-next", "true");
  const firstTask = page.locator('[data-step="first-task"]');
  await expect(firstTask).toHaveAttribute("data-done", "false");

  // The checklist's button opens New task; a prompt starts the task on the admin's runner.
  await firstTask.getByRole("link", { name: "New task" }).click();
  await page.waitForURL((url) => url.pathname === "/tasks/new");
  await expect(page.getByTestId("run-on")).toContainText(e2eRunnerName);
  await page.getByLabel("Prompt").fill("Add a short CONTRIBUTING.md that explains how to run the tests");
  await page.getByRole("button", { name: "Start task" }).click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);

  // Every step but the optional Linear is done (F-076, ticket 24): Home drops the checklist for Needs you. The right panel shows only once
  // setup.status has loaded as done, so the page is past its loading state when Needs you is checked.
  await page.goto("/");
  await expect(page.getByTestId("home-panel").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs you", level: 2 })).toBeVisible();
  await expect(page.getByTestId("setup-checklist")).toHaveCount(0);
  await expect(page.locator("[data-step]")).toHaveCount(0);
});
