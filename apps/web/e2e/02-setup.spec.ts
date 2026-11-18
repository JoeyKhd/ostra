import { expect, test } from "@playwright/test";

import { signIn, watchOrigins } from "./helpers.ts";
import { e2eModelToken, e2eStubBaseUrl } from "./settings.ts";

// Ticket 37: the setup screens against the stub model endpoint. Desktop only: the steps write data.

test.describe.configure({ mode: "serial" });
test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "the setup steps run once, at desktop width");

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
  await expect(page.getByTestId("provider-settings")).toBeVisible();
  await expect(page.locator("tr[data-model]")).toHaveCount(2);
  // The token is never shown back.
  expect(await page.content()).not.toContain(e2eModelToken);

  // Allow on personal runners, optimistically, then confirmed.
  await page.getByLabel("Allow on personal runners").click();
  await expect(page.getByLabel("Allow on personal runners")).toHaveAttribute("data-state", "checked");
  await page.reload();
  await page.getByRole("button", { name: /stub/ }).click();
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
  await expect(page.locator('[data-testid="github-connection"]')).toHaveCount(0);
});
