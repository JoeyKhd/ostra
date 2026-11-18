import { expect, test } from "@playwright/test";

import { expectNoHorizontalScroll, signIn, watchOrigins } from "./helpers.ts";
import { e2eAdmin, e2eSetupToken } from "./settings.ts";

// Ticket 35 (the shell) and the first step of ticket 37: the first admin, sign-in and sign-out,
// at desktop and phone width, with no request to another origin.

test.describe.configure({ mode: "serial" });

test("a fresh install opens on 'Create the first admin', and a wrong token creates nothing", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the admin is created once");
  const origins = watchOrigins(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Create the first admin" })).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByLabel("Setup token").fill("ostra-setup-this-is-the-wrong-token");
  await page.getByLabel("Organization name").fill(e2eAdmin.organizationName);
  await page.getByLabel("Username").fill(e2eAdmin.username);
  await page.getByLabel("Email").fill(e2eAdmin.email);
  await page.getByLabel("Password").fill(e2eAdmin.password);
  await page.getByRole("button", { name: "Create the admin" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /./ })).toHaveText("That setup token isn't right. Copy it again from the server's log.");
  await page.reload();
  await expect(page).toHaveURL(/\/setup$/);

  await page.getByLabel("Setup token").fill(e2eSetupToken);
  await page.getByLabel("Organization name").fill(e2eAdmin.organizationName);
  await page.getByLabel("Username").fill(e2eAdmin.username);
  await page.getByLabel("Email").fill(e2eAdmin.email);
  await page.getByLabel("Password").fill(e2eAdmin.password);
  await page.getByRole("button", { name: "Create the admin" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.getByTestId("setup-checklist")).toBeVisible();
  await expect(page.locator('[data-step="admin"]')).toHaveAttribute("data-done", "true");
  await expect(page.locator('[data-step="linear"]')).toContainText("milestone 2");
  expect(origins.foreign()).toEqual([]);
});

test("the setup page is closed once an admin exists", async ({ page }) => {
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("sign in by username and by email reaches Home; sign out returns to sign-in", async ({ page }) => {
  const origins = watchOrigins(page);
  await signIn(page, e2eAdmin.username);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(e2eAdmin.organizationName);
  await expectNoHorizontalScroll(page);

  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await page.getByRole("button", { name: "Sign out" }).last().click();
  await page.waitForURL(/\/sign-in$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);

  await signIn(page, e2eAdmin.email);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(e2eAdmin.organizationName);
  expect(origins.foreign()).toEqual([]);
});

test("a wrong password gets one line", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Username or email").fill(e2eAdmin.username);
  await page.getByLabel("Password").fill("not the password at all");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /./ })).toHaveText("That username or email and password don't match.");
});
