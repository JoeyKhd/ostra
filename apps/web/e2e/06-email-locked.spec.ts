import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { hydrated } from "./helpers.ts";
import { e2eAdmin, e2eLockedEmail } from "./settings.ts";

// Milestone 3, ticket 45 (F-115): an install whose settings set its email (the second stack,
// `stack.ts` with OSTRA_E2E_EMAIL_LOCKED=1: SMTP by `e2eLockedEmail`). The email page names the
// settings that lock it and shows their values in fields nobody can change, with nothing to save.

/**
 * Signs the admin in on this stack, which allows the default password (F-001), so there's no forced
 * change: with the chosen password once `06-default-password` changed it, else with the default.
 */
const signInHere = async (page: Page): Promise<void> => {
  for (const password of [e2eAdmin.password, e2eAdmin.defaultPassword]) {
    await page.goto("/sign-in");
    const field = page.getByLabel("Username or email");
    await hydrated(field);
    await field.fill(e2eAdmin.username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    const outcome = await Promise.race([
      page.waitForURL((url) => url.pathname === "/").then(() => "in" as const),
      page.getByText("That username or email and password don't match.").waitFor().then(() => "refused" as const),
    ]);
    if (outcome === "in") return;
  }
  throw new Error("the admin couldn't sign in on the second stack");
};

test("F-115/c2: a locked install shows its email read-only, naming the settings that lock it", async ({ page }) => {
  await signInHere(page);
  await page.goto("/organization/email");
  await expect(page.getByText(/^Set by .* on this install\. Change them there and restart ostra\.$/)).toContainText("OSTRA_EMAIL_PROVIDER");
  await expect(page.getByText(/^Set by /)).toContainText("OSTRA_SMTP_HOST");

  // The settings' values, in fields that can't be changed.
  await expect(page.getByRole("radio", { name: /^SMTP/ })).toBeChecked();
  for (const radio of await page.getByRole("radio").all()) await expect(radio).toBeDisabled();
  for (const [label, value] of [
    ["Host", e2eLockedEmail.OSTRA_SMTP_HOST],
    ["Port", e2eLockedEmail.OSTRA_SMTP_PORT],
    ["Username", e2eLockedEmail.OSTRA_SMTP_USER],
    ["From address", e2eLockedEmail.OSTRA_EMAIL_FROM],
    ["From name", e2eLockedEmail.OSTRA_EMAIL_FROM_NAME],
  ] as const) {
    await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
    await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
  }
  // Nothing to save.
  await expect(page.locator('[data-action="save-email"]')).toHaveCount(0);
});
