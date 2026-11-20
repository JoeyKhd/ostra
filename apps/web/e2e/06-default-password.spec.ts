import { expect, test } from "@playwright/test";

import { expectNoHorizontalScroll, hydrated } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// F-001: an install started with OSTRA_ALLOW_DEFAULT_PASSWORD=true (the second stack in
// playwright.config.ts, the `default-password` project) lets the seeded admin in with the default
// password, and shows the warning banner across the panel until the password changes.

test.describe.configure({ mode: "serial" });

const panelPages = ["/", "/organization/models", "/organization/github", "/organization/runners", "/projects/new", "/tasks/new"] as const;

test("F-001: with OSTRA_ALLOW_DEFAULT_PASSWORD the default password opens the panel, with a banner on every page until it changes", async ({ page }) => {
  await page.goto("/sign-in");
  // Text filled in before React hydrates the form never reaches it (`hydrated`).
  await hydrated(page.getByLabel("Username or email"));
  await page.getByLabel("Username or email").fill(e2eAdmin.email);
  await page.getByLabel("Password").fill(e2eAdmin.defaultPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  // No forced change: the panel opens.
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(e2eAdmin.organizationName);

  const banner = page.getByTestId("default-password-banner");
  for (const path of panelPages) {
    await page.goto(path);
    await expect(page).toHaveURL((url) => url.pathname === path);
    await expect(banner, path).toBeVisible();
    await expect(banner, path).toContainText("The default password is still in use.");
  }
  await expectNoHorizontalScroll(page);

  // The banner's link changes it, and brings the admin back to the page it was on.
  await page.goto("/organization/models");
  await banner.getByRole("link", { name: "Change it" }).click();
  await page.waitForURL((url) => url.pathname === "/change-password");
  await page.getByLabel("New password", { exact: true }).fill(e2eAdmin.password);
  await page.getByLabel("Confirm the new password").fill(e2eAdmin.password);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.waitForURL((url) => url.pathname === "/organization/models");

  for (const path of panelPages) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(banner, path).toHaveCount(0);
  }
});
