import { expect, test } from "@playwright/test";

import { expectNoHorizontalScroll, signIn } from "./helpers.ts";
import { signedInPage } from "./m4.ts";
import { seedFleet, seedPersonal, seedTake, shootM5 } from "./m5.ts";

// Milestone 5, ticket 30 (F-092, F-091, F-067): the Runners page, a pool's page, a new pool and its
// join token in the panel on the e2e stack. Pools, runners, boxes and queued tasks are seeded rows (`seed-m5.ts`); every count, state
// and action goes through the panel's real API. Tests that change state run once, at desktop width.

const MEMBER = "e2e-fleet-member";
const MEMBER_RUNNER = "e2e-laptop";

test.beforeAll(async () => {
  await seedFleet();
});

test("F-091: an admin makes a pool and sees its join token once; a reload doesn't show it again", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  await page.goto("/organization/runners");
  await page.getByRole("button", { name: "New pool" }).click();
  await shootM5(page, "pool-new");
  const name = `e2e-made-${String(Date.now()).slice(-5)}`;
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create pool" }).click();
  const shown = page.getByTestId("join-token");
  await expect(shown).toBeVisible();
  const token = (await shown.textContent())?.trim() ?? "";
  expect(token.length).toBeGreaterThan(20);
  // Each install path's command reads the token from a variable or a file, never pasted into the line.
  await expect(page.getByTestId("join-command")).not.toContainText(token);
  await shootM5(page, "pool-join");
  await page.getByRole("button", { name: "Done" }).click();

  await page.reload();
  await expect(page.getByRole("link", { name })).toBeVisible();
  await expect(page.getByTestId("join-token")).toHaveCount(0);
  expect(await page.content()).not.toContain(token);
  // The pool's own page lists its first token by label, and never the token.
  await page.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  expect(await page.content()).not.toContain(token);
});

test("F-092: the fleet's counts change as a seeded runner takes a task", { tag: "@desktop-only" }, async ({ page }) => {
  const { fleetPoolId } = await seedFleet();
  await signIn(page);
  await page.goto(`/organization/runners/pools/${fleetPoolId}`);
  const row = page.locator('[data-runner="e2e-fleet-01"]');
  await expect(row).toContainText("0 / 3 busy");
  // Four runners: 3 + 4 + 2 + 2 slots, 4 boxes busy (two on the runner to drain, two on the one to revoke).
  await expect(page.getByText(/^4 runners, 4 of 11 boxes busy, nothing waiting\.$/)).toBeVisible();
  await seedTake();
  // The live refresh, no reload.
  await expect(row).toContainText("1 / 3 busy", { timeout: 15_000 });
  await expect(page.getByText(/^4 runners, 5 of 11 boxes busy, nothing waiting\.$/)).toBeVisible();
  await expect(page.locator('[data-project="e2e-fleet-app"]')).toContainText("5 / 8");
});

test("F-067: the pool's queue is in priority order, and Cancel takes a task out of it", { tag: "@desktop-only" }, async ({ page }) => {
  const { queuePoolId } = await seedFleet();
  await signIn(page);
  await page.goto(`/organization/runners/pools/${queuePoolId}`);
  const queue = page.getByRole("region", { name: "Queue" });
  const rows = queue.locator("[data-queued]");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Checkout fails on an empty cart");
  await expect(rows.nth(0)).toContainText("Urgent");
  await expect(rows.nth(1)).toContainText("Add a size filter to search");
  await expect(rows.nth(2)).toContainText("Tidy the footer links");
  await expect(page.getByText("No runner yet", { exact: false })).toHaveCount(0);

  await rows.nth(1).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("This prompt task stops as cancelled before it starts.");
  await page.getByRole("button", { name: "Cancel task" }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Tidy the footer links");
  await expect(rows.nth(1).locator("td").first()).toHaveText("2");
});

test("F-092, F-014: a member sees Your machine and not the pools' details", async ({ browser }) => {
  const { fleetPoolId } = await seedFleet();
  await seedPersonal(MEMBER, MEMBER_RUNNER);
  const page = await signedInPage(browser, MEMBER);
  await page.goto("/organization/runners");
  await expect(page.getByTestId("my-runners").locator(`[data-runner="${MEMBER_RUNNER}"]`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pools" })).toHaveCount(0);
  await expect(page.getByText("e2e-fleet-01")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await page.goto(`/organization/runners/pools/${fleetPoolId}`);
  await expect(page.getByText("e2e-fleet-01")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Queue" })).toHaveCount(0);
  await page.context().close();
});

test("F-092: at phone width the Runners page and a pool's page never scroll sideways; their tables scroll inside", async ({ page }) => {
  const { fleetPoolId } = await seedFleet();
  await signIn(page);
  await page.goto("/organization/runners");
  await expect(page.getByRole("table").getByRole("link", { name: "e2e-fleet", exact: true })).toBeVisible();
  // A pool on the host executor is labelled "not isolated".
  await expect(page.getByRole("table").getByRole("row").filter({ hasText: "e2e-host" })).toContainText("not isolated");
  await expectNoHorizontalScroll(page);
  await page.goto(`/organization/runners/pools/${fleetPoolId}`);
  await expect(page.locator('[data-runner="e2e-fleet-01"]')).toBeVisible();
  await expectNoHorizontalScroll(page);
  const runners = page.getByRole("region", { name: "Runners" });
  const scrolls = await runners.evaluate((node) => node.scrollWidth > node.clientWidth || getComputedStyle(node).overflowX === "auto");
  expect(scrolls).toBe(true);
  await shootM5(page, "pool");
});
