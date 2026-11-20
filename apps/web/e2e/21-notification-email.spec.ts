import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { hydrated, readStack, signIn } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// Milestone 3, ticket 45 (F-115, F-036): the email settings and a member's notification choices.
// The instance admin sets Resend up against the stack's fake Resend API (OSTRA_RESEND_API_URL,
// `fakes.ts`), sends the test mail and reads its result, then switches to SMTP; a member turns plans
// off for email. Each leaves the install's email off again, as the specs after it expect. The page
// locked by the install's settings is the second stack's (`06-email-locked.spec.ts`).

const run = promisify(execFile);

test.describe.configure({ mode: "serial" });

test("F-115/c2: the instance admin sets Resend on the fake, sends a test mail and sees the result, then switches to SMTP", { tag: "@desktop-only" }, async ({ page }) => {
  const stackFile = await readStack();
  await signIn(page);
  await page.goto("/organization/email");
  const resend = page.getByRole("radio", { name: /^Resend/ });
  await hydrated(resend);
  await resend.click();
  await page.getByLabel("API key", { exact: true }).fill(stackFile.resend.apiKey);
  await page.getByLabel("From address", { exact: true }).fill("ostra@example.com");
  await page.getByLabel("From name", { exact: true }).fill("ostra e2e");
  await page.locator('[data-action="save-email"]').click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(page.getByText("On, through Resend")).toBeVisible();

  // The test mail goes through the fake Resend, and the page says it was accepted.
  await page.getByRole("button", { name: "Send a test mail" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Accepted by Resend" })).toContainText(`Check ${e2eAdmin.email} for it.`);

  // SMTP: its server and the same sender, saved and read back after a reload.
  await page.getByRole("radio", { name: /^SMTP/ }).click();
  await page.getByLabel("Host", { exact: true }).fill("smtp.e2e.example");
  await page.getByLabel("Port", { exact: true }).fill("587");
  await page.locator('[data-action="save-email"]').click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("radio", { name: /^SMTP/ })).toBeChecked();
  await expect(page.getByLabel("Host", { exact: true })).toHaveValue("smtp.e2e.example");
  await expect(page.getByText("On, through SMTP")).toBeVisible();

  // Off again, so the specs after this one meet the install's email as they expect.
  await page.getByRole("radio", { name: /^Off/ }).click();
  await page.locator('[data-action="save-email"]').click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
});

test("F-115/c1: a member turns plans off for email, and the choice is saved", { tag: "@desktop-only" }, async ({ page }) => {
  const { databaseUrl } = await readStack();
  const username = `notify-${Date.now().toString(36)}`;
  await run(process.execPath, [path.join(import.meta.dirname, "seed-member.ts"), JSON.stringify({ databaseUrl, username, password: e2eAdmin.password })], { cwd: path.resolve(import.meta.dirname, "..") });
  await signIn(page, username);
  await page.goto("/account/notifications");
  const plans = page.getByRole("checkbox", { name: "Email for Plans" });
  await hydrated(plans);
  // ADR 0050's default: plans reach the member by email.
  await expect(plans).toBeChecked();
  await plans.click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(plans).not.toBeChecked();
  // Saved, not only drawn: a reload reads it back, and the panel's box and the ticket's stay as they were.
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Email for Plans" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Ticket for Plans" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Email for Approvals" })).toBeChecked();
});
