import { expect, test } from "@playwright/test";

import { readStack, signIn, watchOrigins } from "./helpers.ts";
import { startRunner } from "./runner.ts";
import type { E2eRunner } from "./runner.ts";
import { e2eCoreUrl, e2eRepo, e2eRunnerName } from "./settings.ts";

// Ticket 37: the rest of the first-run checklist, from "Connect GitHub" to a runner approved. The
// first admin and the model provider (against the stub endpoint) are the two specs before this
// one, in the same stack. GitHub is a fake (`@ostra/adapter-github/testing`) that the panel and
// core reach through OSTRA_GITHUB_API_URL; the runner is the real `ostra runner` on the host
// executor, signing in with a device code. No agent runs: the first task needs a model.

test.describe.configure({ mode: "serial" });
test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "the setup steps run once, at desktop width");

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
  const connection = page.getByTestId("github-connection");
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
  await expect(page.getByRole("status")).toContainText("Approved");
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
