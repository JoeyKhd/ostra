import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { z } from "zod";

import { expectNoHorizontalScroll, signIn } from "./helpers.ts";
import { signedInPage } from "./m4.ts";
import { seedFleet, seedJoiner, seedPersonal, shootM5 } from "./m5.ts";

// Milestone 5, ticket 31 (F-092, F-091, F-061, F-014): a runner's page, approval from Needs you,
// drain, resume and revoke on the e2e stack. Runners and boxes are seeded rows (`seed-m5.ts`); every
// state and action goes through the panel's real API. Tests that change state run once, at desktop width.

const MEMBER = "e2e-fleet-member";
const MEMBER_RUNNER = "e2e-laptop";

/** The panel's own version, its package.json's, which a runner's fix names (the release stamps it). */
const serverVersion = async (): Promise<string> =>
  z.object({ version: z.string() }).parse(JSON.parse(await readFile(path.join(import.meta.dirname, "..", "package.json"), "utf8"))).version;

test.beforeAll(async () => {
  await seedFleet();
});

test("F-091/c6: an admin approves a joining seeded runner from its Needs you row", { tag: "@desktop-only" }, async ({ page }) => {
  const { runnerId } = await seedJoiner("e2e-joiner-01");
  await signIn(page);
  await page.goto("/needs-you");
  const row = page.locator('[data-runner-approval="e2e-joiner-01"]');
  await expect(row).toContainText("e2e-joiner-01 wants to join e2e-approve");
  await row.getByRole("button", { name: "Review" }).click();
  const panel = page.getByTestId("runner-approval");
  await expect(panel).toContainText("Needs you · runner approval");
  await expect(panel).toContainText("ci-bootstrap");
  await expect(panel.getByTestId("key-fingerprint")).toHaveText(/^SHA256:.{4}….{4}$/);
  await shootM5(page, "runner-approval");
  await panel.getByRole("button", { name: "Approve" }).click();
  await expect(panel.getByTestId("approval-receipt")).toContainText("Approved by you.");
  // The approval is the runner's own state: its page says who approved it, and it waits no more.
  await page.goto(`/organization/runners/${runnerId}`);
  await expect(page.getByTestId("runner-history")).toContainText("Approved by");
  await expect(page.getByTestId("runner-state")).not.toContainText("waiting for approval");
  await expect(page.getByTestId("runner-approval")).toHaveCount(0);
  // And Needs you lists it no more once the fleet has loaded.
  const fleet = page.waitForResponse((response) => response.url().includes("runners.list"));
  await page.goto("/needs-you");
  await fleet;
  await expect(page.locator('[data-runner-approval="e2e-joiner-01"]')).toHaveCount(0);
});

test("F-092/c4: an admin drains, then resumes, a seeded runner, and its state follows", { tag: "@desktop-only" }, async ({ page }) => {
  await seedFleet();
  await signIn(page);
  await page.goto("/organization/runners");
  await page.getByRole("link", { name: "e2e-drain-01" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("e2e-drain-01");
  await expect(page.getByTestId("runner-state")).toHaveText("online");
  await page.getByRole("button", { name: "Drain" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Its 2 running tasks finish.");
  await page.getByRole("alertdialog").getByRole("button", { name: "Drain" }).click();
  await expect(page.getByTestId("runner-state")).toHaveText("draining");
  await expect(page.getByTestId("runner-history")).toContainText("Drained by");
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("It takes tasks again as soon as it's connected.");
  await page.getByRole("alertdialog").getByRole("button", { name: "Resume" }).click();
  // Not connected, it resumes to offline, and goes online at its next hello.
  await expect(page.getByTestId("runner-state")).toHaveText("offline");
  await expect(page.getByRole("button", { name: "Drain" })).toBeVisible();
  await expect(page.getByTestId("runner-history")).toContainText("Resumed by");
});

test("F-092/c4, F-091/c5: an admin revokes a runner, and the confirm counts the tasks that stop", { tag: "@desktop-only" }, async ({ page }) => {
  await seedFleet();
  await signIn(page);
  await page.goto("/organization/runners");
  await page.getByRole("link", { name: "e2e-revoke-01" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("e2e-revoke-01");
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Its 2 running tasks stop at once");
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("runner-state")).toHaveText("revoked");
  await expect(page.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Drain", exact: true })).toHaveCount(0);
});

test("F-092/c4, F-014: a member's own runner page has Revoke and no Drain", async ({ browser }) => {
  const { runnerId } = await seedPersonal(MEMBER, MEMBER_RUNNER);
  const page = await signedInPage(browser, MEMBER);
  await page.goto(`/organization/runners/${runnerId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(MEMBER_RUNNER);
  await expect(page.getByRole("button", { name: "Revoke" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Drain" })).toHaveCount(0);
  await expect(page.getByTestId("runner-consequence")).toContainText("Revoking cuts your machine off");
  await expectNoHorizontalScroll(page);
  await page.context().close();
});

test("F-092/c2, F-061/c3: a runner's page shows its carrier, its version against the server's, and the fix", async ({ page }) => {
  await seedFleet();
  await signIn(page);
  await page.goto("/organization/runners");
  await page.getByRole("link", { name: "e2e-fleet-old" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("e2e-fleet-old");
  await expect(page.getByTestId("row-version")).toContainText("outdated");
  await expect(page.getByTestId("version-fix")).toContainText(`run the v${await serverVersion()} image and restart it`);
  await page.goto("/organization/runners");
  await page.getByRole("link", { name: "e2e-fleet-01" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("e2e-fleet-01");
  await expect(page.getByTestId("row-carrier")).toContainText("HTTP");
  await expect(page.getByTestId("row-connection")).toContainText("Connected");
  await expect(page.getByTestId("runner-labels")).toContainText("tier:fast");
  await expectNoHorizontalScroll(page);
  await shootM5(page, "runner");
});
