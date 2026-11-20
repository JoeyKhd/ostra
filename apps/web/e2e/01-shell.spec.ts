import { expect, test } from "@playwright/test";

import { expectNoHorizontalScroll, expectSignInRefused, hydrated, signIn, watchOrigins } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// Ticket 35 (the shell) and the first step of ticket 37: the seeded first admin (F-001), its
// forced password change, sign-in and sign-out, at desktop and phone width, with no request to
// another origin.

test.describe.configure({ mode: "serial" });

// The default password is changed once, so these two run at desktop width only (the phone project
// leaves out `@desktop-only`, playwright.config.ts).
test("F-001/c6: a fresh install signs in as demo@demo.com / demo, and must choose a new password first", { tag: "@desktop-only" }, async ({ page }) => {
  const origins = watchOrigins(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  // Text filled in before React hydrates the form never reaches it (`hydrated`).
  await hydrated(page.getByLabel("Username or email"));
  await page.getByLabel("Username or email").fill(e2eAdmin.email);
  await page.getByLabel("Password").fill(e2eAdmin.defaultPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/change-password");
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Nothing else opens until it has one: a panel page sends it back here.
  await page.goto("/organization/models");
  await expect(page).toHaveURL(/\/change-password\?next=%2Forganization%2Fmodels$/);

  const next = page.getByLabel("New password", { exact: true });
  const again = page.getByLabel("Confirm the new password");
  const submit = page.getByRole("button", { name: "Save and continue" });
  await hydrated(next);
  // The normal policy: the default password, or anything short, can't be chosen. No current
  // password is asked for: the account still has the public default one.
  await next.fill(e2eAdmin.defaultPassword);
  await again.fill(e2eAdmin.defaultPassword);
  await expect(submit).toBeDisabled();
  await expect(next).toHaveAttribute("aria-invalid", "true");
  await next.fill(e2eAdmin.password);
  await again.fill(`${e2eAdmin.password}!`);
  await submit.click();
  await expect(page.getByRole("alert").filter({ hasText: /./ })).toHaveText("The two passwords don't match.");
  await expect(again).toBeFocused();

  await again.fill(e2eAdmin.password);
  await submit.click();
  await page.waitForURL((url) => url.pathname === "/organization/models");
  await expect(page.getByTestId("default-password-banner")).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByTestId("setup-checklist")).toBeVisible();
  await expect(page.locator('[data-step="admin"]')).toHaveAttribute("data-done", "true");
  // Linear is live since milestone 2, and optional: offered with "Skip for now".
  await expect(page.locator('[data-step="linear"]').getByRole("button", { name: "Skip for now" })).toBeVisible();
  expect(origins.foreign()).toEqual([]);
});

test("F-001/c6: the default password stops working once it is changed", { tag: "@desktop-only" }, async ({ page }) => {
  await expectSignInRefused(page, e2eAdmin.username, e2eAdmin.defaultPassword);
});

test("the old setup page sends a visitor to sign in", async ({ page }) => {
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("F-002/c2: sign in by username and by email reaches Home; sign out returns to sign-in", async ({ page }) => {
  const origins = watchOrigins(page);
  await signIn(page, e2eAdmin.username);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(e2eAdmin.organizationName);
  await expectNoHorizontalScroll(page);

  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  // The member's row at the foot of the sidebar opens a menu with Sign out.
  await page.getByTestId("user-menu").last().click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL(/\/sign-in$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);

  await signIn(page, e2eAdmin.email);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(e2eAdmin.organizationName);
  expect(origins.foreign()).toEqual([]);
});

test("a wrong password gets one line", async ({ page }) => {
  await expectSignInRefused(page, e2eAdmin.username, "not the password at all");
});
