import { expect, test } from "@playwright/test";

import { checklistSteps, signIn, watchOrigins } from "./helpers.ts";
import { e2eModelToken, e2eStubBaseUrl } from "./settings.ts";

// Ticket 37: the setup screens against the stub model endpoint. Desktop only: the steps write data,
// so the phone project leaves this file out (playwright.config.ts).

test.describe.configure({ mode: "serial" });

test("F-076: a new organization's Home shows the checklist in its order, and its next step opens the model provider page", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  const checklist = page.getByTestId("setup-checklist");
  await expect(checklist).toBeVisible();
  const order = ["admin", "model-provider", "github", "linear", "project", "runner", "first-task"];
  expect(await checklistSteps(page)).toEqual(order);
  await expect(page.getByText("1 of 7", { exact: true })).toBeVisible();
  await expect(page.locator('[data-step="admin"]')).toHaveAttribute("data-done", "true");
  // The next step is the model provider, the one primary button; GitHub and the rest wait.
  await expect(checklist.locator('[data-next="true"]')).toHaveCount(1);
  await expect(page.locator('[data-step="model-provider"]')).toHaveAttribute("data-next", "true");
  for (const step of ["model-provider", "github", "project", "runner", "first-task"]) {
    await expect(page.locator(`[data-step="${step}"]`)).toHaveAttribute("data-done", "false");
  }
  // Linear is optional (milestone 2's step, live): offered with "Skip for now", and never what
  // holds setup back (03-first-run finishes setup without it).
  const linear = page.locator('[data-step="linear"]');
  await expect(linear).toContainText("Connect Linear");
  await expect(linear.getByRole("button", { name: "Skip for now" })).toBeVisible();
  await expect(linear.getByRole("link", { name: "Connect Linear", exact: true })).toHaveAttribute("href", "/organization/linear");
  // Milestone 7 (ticket 24): every step links to its page in the docs (OSTRA_DOCS_URL), in a new tab.
  for (const step of order) {
    const docs = page.locator(`[data-step="${step}"] a[data-docs]`);
    await expect(docs).toHaveAttribute("href", /^https:\/\/joeykhd\.github\.io\/ostra\/docs\/[a-z-]+\/[a-z-]+\/(#[a-z0-9-]+)?$/);
    await expect(docs).toHaveAttribute("target", "_blank");
  }

  // The checklist's own button opens the step's page, in the panel.
  await page.locator('[data-step="model-provider"]').getByRole("link", { name: "Add a provider" }).click();
  await page.waitForURL((url) => url.pathname === "/organization/models");
  await expect(page.getByRole("heading", { name: "Models", level: 1 })).toBeVisible();
});

test("Add a model provider: a wrong token is refused in words, the right one lists the models", async ({ page }) => {
  const origins = watchOrigins(page);
  await signIn(page);
  await page.goto("/organization/models");
  await expect(page.getByRole("heading", { name: "Models", level: 1 })).toBeVisible();

  await page.getByLabel("Name", { exact: true }).fill("stub");
  await page.getByLabel("API base URL").fill(e2eStubBaseUrl);
  await page.getByLabel("Token", { exact: true }).fill("not-the-right-token");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /./ })).toBeVisible();

  await page.getByLabel("Token", { exact: true }).fill(e2eModelToken);
  await page.getByRole("button", { name: "Test connection" }).click();
  const result = page.getByTestId("test-result");
  await expect(result).toContainText("Connected · Anthropic Messages");
  await expect(result).toContainText("found 2 models");
  await expect(result).toContainText("local-coder-7b");
  await expect(result).toContainText(/Claude Sonnet 4.5/);
  await expect(page.getByLabel("API format")).toHaveValue("anthropic-messages");
  await expect(page.getByLabel("Allow on personal runners")).toHaveAttribute("data-state", "unchecked");

  await page.getByRole("button", { name: "Save provider" }).click();
  const settings = page.getByTestId("provider-settings");
  await expect(settings).toBeVisible();
  await expect(page.locator("tr[data-model]")).toHaveCount(2);
  // The token is never shown back.
  expect(await page.content()).not.toContain(e2eModelToken);

  // The saved provider shows as a key (milestone 4's `models-keys` target): its settings, the
  // switch among them, open under "Edit provider".
  const personalRow = settings.getByText("Personal runners", { exact: true }).locator("xpath=..");
  await expect(personalRow).toContainText("Off");
  await settings.getByRole("button", { name: "Edit provider" }).click();

  // Allow on personal runners, optimistically, then confirmed.
  await page.getByLabel("Allow on personal runners").click();
  await expect(page.getByLabel("Allow on personal runners")).toHaveAttribute("data-state", "checked");
  await expect(personalRow).toContainText("On");
  await page.reload();
  await page.getByRole("button", { name: /stub/ }).click();
  await expect(personalRow).toContainText("On");
  await settings.getByRole("button", { name: "Edit provider" }).click();
  await expect(page.getByLabel("Allow on personal runners")).toHaveAttribute("data-state", "checked");

  // The custom model is editable, and becomes the default model.
  await page.locator('tr[data-model="local-coder-7b"]').click();
  await expect(page.getByTestId("model-editor")).toContainText("Custom model");
  await page.getByRole("button", { name: "Use as default model" }).click();
  await expect(page.locator('tr[data-model="local-coder-7b"]')).toContainText("default");

  await page.goto("/");
  await expect(page.locator('[data-step="model-provider"]')).toHaveAttribute("data-done", "true");
  expect(origins.foreign()).toEqual([]);
});

test("Connect GitHub refuses an App it can't read, in words", async ({ page }) => {
  await signIn(page);
  await page.goto("/organization/github");
  await page.getByLabel("App ID").fill("1");
  await page.getByLabel("Private key", { exact: true }).fill("-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----");
  await page.getByLabel("Webhook secret").fill("e2e-webhook-secret");
  await page.getByRole("button", { name: "Connect the App" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /./ })).toContainText("private key");
  await expect(page.locator('[data-testid="github-app"]')).toHaveCount(0);
});

test("F-006: Create a new App shows the manifest's permissions, leaves workflows out, and says it gets no webhook without a public address", async ({ page }) => {
  await signIn(page);
  await page.goto("/organization/github");
  await page.getByRole("tab", { name: "Create a new App" }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel).toContainText("This server's address isn't public, so the App is created without a webhook and receives no events.");
  await expect(panel).toContainText("OSTRA_CORE_PUBLIC_URL");
  await expect(panel.getByRole("button", { name: "Create the App on GitHub" })).toBeVisible();
  const request = page.getByTestId("github-request");
  for (const name of ["contents", "pull_requests", "checks", "actions", "issues", "statuses", "metadata", "workflows"]) {
    await expect(request).toContainText(name);
  }
  await expect(request).toContainText("A push that touches .github/workflows/ fails, and the task says why.");
  await expect(request).toContainText("Off until a public address");
  await expect(request).not.toContainText("email_addresses");
});
