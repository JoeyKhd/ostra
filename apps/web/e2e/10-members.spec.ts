import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

import { expectNoHorizontalScroll, signIn } from "./helpers.ts";
import { seedM4Member, shoot, shootPhone } from "./m4.ts";
import { e2eAdmin } from "./settings.ts";
import { rail } from "./shell.ts";

// F-002 (ticket 32): members, invitations, accepting one and resets, through the panel on the e2e stack.
// The install has no email, so links are shown once to the admin, and an invitee types their address.

const INVITEE = "e2e-invitee";
/** The reset's account, seeded on its own so that check stands alone. */
const RESETTER = "e2e-resetter";
const NEW_PASSWORD = "a brand new passphrase 9";

/** Opens the invite sheet, invites `email` as a member and returns the link it shows once. */
const invite = async (page: Page, email: string): Promise<string> => {
  await page.goto("/organization/members");
  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByLabel("Address").fill(email);
  await page.getByRole("button", { name: "Create invitation" }).click();
  const link = page.getByTestId("invitation-link");
  await expect(link).toContainText("/invite/");
  return (await link.textContent())?.trim() ?? "";
};

const freshPage = async (browser: Browser): Promise<Page> => (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

test("F-002/c3, F-115/c3: an admin invites, the invitee signs up through the link in a second context, and appears in the list", { tag: "@desktop-only" }, async ({ page, browser }) => {
  await signIn(page);
  const link = await invite(page, `${INVITEE}@example.com`);
  await expect(page.getByText("Mail is off on this install. Send the link yourself.")).toBeVisible();
  await shoot(page, "member-invite-link");
  await page.getByRole("button", { name: "Done" }).click();
  // The waiting invitation is listed, with its link while this tab made it.
  const row = page.getByTestId("invitation-row").filter({ hasText: `${INVITEE}@example.com` });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Copy link" })).toBeVisible();

  const invitee = await freshPage(browser);
  await invitee.goto(new URL(link).pathname);
  await expect(invitee.getByRole("heading", { level: 1 })).toContainText(e2eAdmin.organizationName);
  await shoot(invitee, "accept-invite");
  await invitee.getByLabel("Email").fill(`${INVITEE}@example.com`);
  await invitee.getByLabel("Username").fill(INVITEE);
  await invitee.getByLabel("Password", { exact: true }).fill(e2eAdmin.password);
  await invitee.getByRole("button", { name: `Join ${e2eAdmin.organizationName}` }).click();
  await invitee.waitForURL((url) => url.pathname === "/");

  await page.reload();
  await expect(page.getByTestId("member-row").filter({ hasText: INVITEE })).toBeVisible();
  // Accepted, it leaves the waiting list.
  await expect(page.getByTestId("invitation-row").filter({ hasText: `${INVITEE}@example.com` })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await shoot(page, "members");
  await invitee.context().close();
});

test("F-002/c3: a revoked link shows its state", { tag: "@desktop-only" }, async ({ page, browser }) => {
  await signIn(page);
  const link = await invite(page, "e2e-revoked@example.com");
  await page.getByRole("button", { name: "Done" }).click();
  const row = page.getByTestId("invitation-row").filter({ hasText: "e2e-revoked@example.com" });
  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await expect(row).toHaveCount(0);

  const stranger = await freshPage(browser);
  await stranger.goto(new URL(link).pathname);
  await expect(stranger.getByText("This invitation was revoked")).toBeVisible();
  await expect(stranger.getByLabel("Username")).toHaveCount(0);
  await stranger.context().close();
});

test("F-002/c7,c8, F-115/c3: a reset by link changes the password and signs the other context out", { tag: "@desktop-only" }, async ({ page, browser }) => {
  // The member is signed in elsewhere.
  await seedM4Member(RESETTER);
  const elsewhere = await freshPage(browser);
  await signIn(elsewhere, RESETTER);
  await expect(rail(elsewhere)).toBeVisible();

  // The instance admin makes a reset link for them (the install has no email).
  await signIn(page);
  await page.goto("/instance/accounts");
  await page.getByLabel("Search by username or address").fill(RESETTER);
  await page.getByRole("button", { name: new RegExp(RESETTER) }).first().click();
  await page.getByRole("button", { name: "Create reset link" }).click();
  const shown = page.getByTestId("reset-link");
  await expect(shown).toHaveAttribute("aria-label", /\/reset\/new\?token=/, { timeout: 20_000 });
  const link = (await shown.getAttribute("aria-label")) ?? "";

  const holder = await freshPage(browser);
  await holder.goto(`${new URL(link).pathname}${new URL(link).search}`);
  // The token leaves the address bar at once.
  await expect(holder).toHaveURL(/\/reset\/new$/);
  await holder.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await holder.getByLabel("Confirm the new password").fill(NEW_PASSWORD);
  await holder.getByRole("button", { name: "Save new password" }).click();
  await expect(holder.getByText("Password changed")).toBeVisible();

  // The other context is signed out.
  await elsewhere.reload();
  await expect(elsewhere).toHaveURL(/\/sign-in/);
  // And the new password signs in (the helper waits out the sign-in rate limit, which the two
  // sign-ins above can reach); the link works once.
  await signIn(holder, RESETTER, NEW_PASSWORD);
  const again = await freshPage(browser);
  await again.goto(`${new URL(link).pathname}${new URL(link).search}`);
  await expect(again.getByText("This reset link has been used")).toBeVisible();
  for (const context of [elsewhere, holder, again]) await context.context().close();
});

test("F-002: the members page, the invitation and reset pages fit a phone", async ({ page }) => {
  await signIn(page);
  await page.goto("/organization/members");
  await expect(page.getByTestId("member-row").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shootPhone(page, "members");
  await page.goto("/reset");
  await expect(page.getByText("Ask your instance admin")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shoot(page, "reset-password");
});
