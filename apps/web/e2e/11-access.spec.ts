import { expect, test } from "@playwright/test";

import { expectNoHorizontalScroll, pageStatus, signIn } from "./helpers.ts";
import { m4World, seedM4World, shoot, shootPhone, signedInPage } from "./m4.ts";
import { e2eAdmin } from "./settings.ts";
import { contextPanel, openSpace } from "./shell.ts";

// F-087, F-003 (ticket 33): a project's access in its settings, and the instance's Accounts page.

test("F-003/c2: the Accounts page and its Instance group render for the instance admin only, and the last instance admin's own row has no Remove", { tag: "@desktop-only" }, async ({ page, browser }) => {
  await seedM4World(m4World);
  await signIn(page);
  const nav = contextPanel(page);
  await page.goto("/instance/accounts");
  await expect(nav.getByText("Instance", { exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Accounts" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Accounts" })).toBeVisible();
  const self = page.getByTestId("instance-admin-row");
  await expect(self).toHaveCount(1);
  await expect(self).toContainText("demo");
  await expect(self.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await page.getByLabel("Search by username or address").fill(m4World.by);
  await page.getByRole("button", { name: new RegExp(m4World.by) }).first().click();
  await expect(page.getByRole("button", { name: "Create reset link" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shoot(page, "instance-settings-accounts");

  // A member who isn't the instance admin has no Instance group, and the page by URL says why.
  const member = await signedInPage(browser, m4World.by);
  await openSpace(member, "Organization");
  const memberNav = contextPanel(member);
  await expect(memberNav.getByRole("link", { name: "Members" })).toBeVisible();
  await expect(memberNav.getByText("Instance", { exact: true })).toHaveCount(0);
  await expect(memberNav.getByRole("link", { name: "Accounts" })).toHaveCount(0);
  await member.goto("/instance/accounts");
  await expect(member.getByText("Only an admin of this ostra instance can see this page.")).toBeVisible();
  await expect(member.getByLabel("Search by username or address")).toHaveCount(0);
  await member.context().close();
});

test("F-087/c4: a restricted project disappears from an unlisted member's sidebar at once", { tag: "@desktop-only" }, async ({ page, browser }) => {
  const world = await seedM4World(m4World);
  const member = await signedInPage(browser, m4World.by);
  // The Projects space with no project open lists every project the member can open (F-147).
  await member.goto("/projects/new");
  const memberNav = contextPanel(member);
  await expect(memberNav.getByRole("link", { name: "m4calc" })).toBeVisible();

  await signIn(page);
  await page.goto(`/projects/${world.projectId}/settings/access`);
  await expect(page.getByRole("heading", { level: 1, name: "Access" })).toBeVisible();
  await shoot(page, "project-access");
  await page.getByRole("radio", { name: /Restricted/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Restrict" }).click();
  await expect(pageStatus(page)).toContainText("restricted");

  // The member's open page drops it without a reload.
  await expect(memberNav.getByRole("link", { name: "m4calc" })).toHaveCount(0, { timeout: 15_000 });
  // And its pages are gone for them.
  await member.goto(`/projects/${world.projectId}/settings/access`);
  await expect(member.getByRole("heading", { level: 1, name: "Access" })).toHaveCount(0);
  await member.context().close();
});

test("F-087: the project's Access tab and the Accounts page fit a phone", async ({ page }) => {
  const world = await seedM4World(m4World);
  await signIn(page);
  await page.goto(`/projects/${world.projectId}/settings/access`);
  await expect(page.getByRole("heading", { level: 1, name: "Access" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shootPhone(page, "project-access");
  await page.goto("/instance/accounts");
  // The signed-in admin's own row; other specs' worlds may add instance admins of their own.
  await expect(page.getByTestId("instance-admin-row").filter({ hasText: e2eAdmin.email })).toHaveCount(1);
  await expectNoHorizontalScroll(page);
  await shootPhone(page, "instance-settings-accounts");
});
