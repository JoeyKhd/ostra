import { createHmac } from "node:crypto";

import { expect, test } from "@playwright/test";

import { expectNoHorizontalScroll, signIn } from "./helpers.ts";
import { chooseTheme, seedAutomationsWorld, shootM6 } from "./m6.ts";

// F-139 (ADR 0056 amended 2026-11-21): a webhook automation through the panel's editor, its API and
// core's webhook address, against the stack's database: the trigger, the address with its copy
// button, the secret shown once, the sample curl, a real signed request that starts a task, a
// repeat and a filtered one, "New secret", the history and the list, in both themes.

const viewer = "e2e-auto-viewer";

const sign = (secret: string, body: string): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const send = async (url: string, secret: string, payload: object): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> => {
  const body = JSON.stringify(payload);
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-ostra-signature": sign(secret, body) }, body });
  const json: unknown = await response.json();
  return { status: response.status, body: typeof json === "object" && json !== null ? Object.fromEntries(Object.entries(json)) : {} };
};

test("F-139/c9: an admin makes a webhook in the editor, copies its address, sees its secret once and a sample curl, and a signed request starts a task", { tag: "@desktop-only" }, async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const world = await seedAutomationsWorld(viewer);
  await signIn(page);
  await page.goto(`/projects/${world.projectId}/automations`);
  await page.getByRole("link", { name: "New webhook" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "New webhook" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "On a webhook" })).toHaveAttribute("data-state", "on");
  const section = page.getByTestId("editor-webhook");
  await expect(section).toContainText("The address and its secret are made when you create it.");
  await expect(page.getByTestId("webhook-column")).toContainText("Create the webhook to get its address");

  const name = `Pager alerts ${String(Date.now()).slice(-6)}`;
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Add a condition" }).click();
  await page.getByRole("textbox", { name: "Condition 1: body field" }).fill("body.status");
  await page.getByRole("textbox", { name: "Condition 1: value" }).fill("firing");
  await page.getByLabel("Idempotency key's field").fill("body.alert.id");
  await page.getByLabel("Title", { exact: true }).fill("Alert: {{ticket.title}}");
  await expect(page.getByTestId("template-problem")).toHaveText("{{ticket.title}} on line 1 isn't a field of the request.");
  await expect(page.getByRole("button", { name: "Create webhook" })).toBeDisabled();
  await page.getByLabel("Title", { exact: true }).fill("Alert: {{body.alert.title}}");
  await page.getByLabel("Prompt", { exact: true }).fill("Find why {{body.alert.title}} fired, and fix it.\n\nThe whole alert:\n{{body}}");
  await page.getByRole("button", { name: "Create webhook" }).click();
  await page.waitForURL(/\/automations\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  // The address, with its copy button.
  const urlText = page.getByTestId("webhook-url");
  await expect(urlText).toHaveText(/^http:\/\/127\.0\.0\.1:\d+\/webhooks\/automations\/[A-Za-z0-9_-]{32}$/);
  const url = (await urlText.textContent()) ?? "";
  await section.getByRole("button", { name: "Copy" }).and(section.locator(`[data-copy="${url}"]`)).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  // The secret, shown this once.
  const secretText = page.getByTestId("webhook-secret");
  await expect(secretText).toHaveText(/^ostra_whsec_[A-Za-z0-9_-]{43}$/);
  const secret = (await secretText.textContent()) ?? "";
  await expect(section).toContainText("Shown once.");
  // The sample curl reads the secret from a variable, and never holds it.
  const curl = page.getByTestId("webhook-curl");
  await expect(curl).toContainText(url);
  await expect(curl).toContainText('openssl dgst -sha256 -hmac "$OSTRA_WEBHOOK_SECRET"');
  await expect(curl).toContainText('-H "x-ostra-signature: sha256=$sig"');
  await expect(curl).toContainText('"status":"firing"');
  await expect(curl).not.toContainText(secret);
  await shootM6(page, "automation-webhook");

  // A signed request starts a task; its repeat answers with it; one the filter doesn't take starts nothing.
  const started = await send(url, secret, { status: "firing", alert: { id: "a-1", title: "Disk full on db-1" } });
  expect([started.status, started.body["status"]]).toEqual([202, "started"]);
  const repeat = await send(url, secret, { status: "firing", alert: { id: "a-1", title: "Disk full on db-1" } });
  expect([repeat.status, repeat.body["status"], repeat.body["taskId"]]).toEqual([200, "duplicate", started.body["taskId"]]);
  const resolved = await send(url, secret, { status: "resolved", alert: { id: "a-2", title: "Disk full on db-1" } });
  expect([resolved.status, resolved.body["reason"]]).toEqual([200, "filtered"]);

  // Read again, the secret isn't there: "New secret" makes another, shown once, and the old one stops working.
  await page.reload();
  await expect(page.getByTestId("webhook-secret")).toHaveCount(0);
  await expect(page.getByTestId("webhook-secret-field")).toContainText("Set");
  await page.getByRole("button", { name: "New secret" }).click();
  await page.getByRole("button", { name: "Make a new secret" }).click();
  await expect(page.getByTestId("webhook-secret")).toHaveText(/^ostra_whsec_/);
  const rotated = (await page.getByTestId("webhook-secret").textContent()) ?? "";
  expect(rotated).not.toBe(secret);
  expect((await send(url, secret, { status: "firing", alert: { id: "a-3" } })).status).toBe(401);

  // The history lists each request with what it started, or why it skipped.
  await page.goto(`/projects/${world.projectId}/automations`);
  const row = page.locator(`[data-automation="${name}"]`);
  await expect(row).toContainText("Webhook");
  await expect(row).toContainText("on a request where body.status is firing");
  await expect(row.getByTestId("automation-next")).toHaveText("on a request");
  await row.click();
  await expect(page.getByTestId("automation-started")).toHaveText("1 task");
  await page.getByRole("link", { name: "Open history" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByTestId("history-run-outcome")).toHaveText(["Skipped", "Skipped", "Started"]);
  await expect(page.getByTestId("history-table")).toContainText("The filter didn't match");
  await expect(page.getByTestId("history-table")).toContainText("A repeat of the key that started");
  await expect(page.getByTestId("history-table")).toContainText("Alert: Disk full on db-1");
  await shootM6(page, "automation-webhook-history");

  // The editor in the other theme too.
  await chooseTheme(page, "Light");
  await page.goto(`/projects/${world.projectId}/automations`);
  await page.locator(`[data-automation="${name}"]`).click();
  await page.getByRole("link", { name: "Edit webhook" }).click();
  await expect(page.getByTestId("webhook-url")).toHaveText(url);
  await expect(page.getByTestId("webhook-curl")).toBeVisible();
  await shootM6(page, "light-automation-webhook");
  await chooseTheme(page, "Dark");
});

test.describe("at phone width", () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

  test("F-139: the webhook editor fits a phone", async ({ page }) => {
    const world = await seedAutomationsWorld(viewer);
    await signIn(page);
    await page.goto(`/projects/${world.projectId}/automations/new?starts=webhook`);
    await expect(page.getByTestId("editor-webhook")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
