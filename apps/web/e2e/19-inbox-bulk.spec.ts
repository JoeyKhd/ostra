import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { expectNoHorizontalScroll, signIn } from "./helpers.ts";
import { chooseTheme, seedBulkWorld, shootM6 } from "./m6.ts";

// F-107, F-077, F-010 (milestone 6's ticket 32): the Inbox's bulk start, the parent ticket's page,
// and a parent's "This starts N tasks", through the panel, the API, core's `bulk.start-item` worker,
// the stack's fake Linear (the parent's sub-issues are read from it) and the database. It runs
// after the setup specs, as the automations spec does.

const tick = (page: Page, key: string) => page.getByRole("checkbox", { name: `Select ${key}` }).click();

test("F-107, F-010: a member ticks four tickets and starts them in one action, and the one that has a task is skipped with its reason", { tag: "@desktop-only" }, async ({ page }) => {
  const { projectId, keys } = await seedBulkWorld();
  await signIn(page);
  await page.goto(`/projects/${projectId}/inbox`);
  await expect(page.locator(`[data-ticket="${keys.one}"]`)).toBeVisible();
  for (const key of [keys.two, keys.three, keys.four, keys.held]) await tick(page, key);

  // The bar replaces the filters; the panel says what each one does before anything starts.
  const bar = page.getByRole("toolbar", { name: "4 tickets selected" });
  await expect(bar.getByTestId("selection-count")).toHaveText("4 selected");
  await expect(page.getByTestId("bulk-head")).toHaveText("4 tickets, 3 tasks");
  const panel = page.getByTestId("bulk-start");
  await expect(panel.locator(`[data-key="${keys.two}"]`)).toContainText("Starts a task");
  await expect(panel.locator(`[data-key="${keys.held}"]`)).toContainText(/Skipped\s*It already has a task, [0-9a-f]{8}/);
  await shootM6(page, "inbox-bulk-start");

  // One press: three start, each through the same start as one; the fourth is skipped, with why.
  await bar.getByRole("button", { name: "Start 3 tasks" }).click();
  await expect(page.getByTestId("bulk-head")).toHaveText("Started 3 tasks from 3 tickets. 1 skipped.", { timeout: 30_000 });
  for (const key of [keys.two, keys.three, keys.four]) await expect(panel.locator(`[data-key="${key}"]`).getByTestId("bulk-outcome")).toHaveText(/^Started[0-9a-f]{8}$/);
  await expect(panel.locator(`[data-key="${keys.held}"]`).getByTestId("bulk-outcome")).toHaveText("Skippedit already has a task");
  await shootM6(page, "inbox-bulk-results");

  // "Done" returns the Inbox, where the started tickets now show their tasks.
  await panel.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("inbox-filters")).toBeVisible();
  for (const key of [keys.two, keys.three, keys.four]) await expect(page.locator(`[data-ticket="${key}"]`)).toContainText(/Queued|Preparing|Running/);
});

test("F-077: a parent starts one task per sub-issue, and its page follows its children as they move", { tag: "@desktop-only" }, async ({ page }) => {
  const { projectId, parentTicketId, keys } = await seedBulkWorld();
  await signIn(page);
  await page.goto(`/projects/${projectId}/inbox?ticket=${keys.parent}`);
  const parentRow = page.locator(`[data-ticket="${keys.parent}"]`);
  await expect(parentRow).toContainText("2 sub-issues");
  // Its start sheet says what a code start does: one task per sub-issue, none for the parent.
  await expect(page.getByTestId("starts-sub-issues")).toContainText("This starts 2 tasks, one for each sub-issue.");
  // Ticked, its row and the bulk panel say the same.
  await tick(page, keys.parent);
  await expect(parentRow).toContainText("starts 2 tasks");
  await expect(page.getByTestId("bulk-start").locator(`[data-key="${keys.parent}"]`)).toContainText("Starts 2 tasks");
  await page.getByTestId("selection-bar").getByRole("button", { name: "Clear" }).click();

  await parentRow.getByTestId("parent-link").click();
  await page.waitForURL(`**/projects/${projectId}/tickets/${parentTicketId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Show the app's version" })).toBeVisible();
  await expect(page.getByTestId("parent-merged")).toHaveText("0 of 2 merged");
  await expect(page.getByTestId("sub-issue")).toHaveCount(2);
  await expect(page.getByTestId("sub-issue-task")).toHaveText([/No task/, /No task/]);
  await shootM6(page, "ticket-parent");

  // Start them: each child gets its task, in place; the parent gets none.
  await page.getByTestId("start-sub-issues").click();
  await expect(page.getByTestId("sub-issue-task")).toHaveText([/Queued|Preparing|Running/, /Queued|Preparing|Running/], { timeout: 30_000 });
  await expect(page.getByTestId("panel-tasks")).toHaveText("2");
  await expect(page.getByTestId("parent-progress-sentence")).toHaveText(/2 (queued|in review or running)/);
  await expect(page.getByTestId("start-sub-issues")).toHaveCount(0);
  await shootM6(page, "ticket-parent-started");
});

test("ticket 32: the bulk start and the parent's page in light, for the by-eye check", { tag: "@desktop-only" }, async ({ page }) => {
  test.skip(process.env["OSTRA_E2E_SHOTS"] === undefined, "screenshots only");
  const { projectId, parentTicketId, keys } = await seedBulkWorld();
  await signIn(page);
  await chooseTheme(page, "Light");
  await page.goto(`/projects/${projectId}/inbox`);
  await tick(page, keys.one);
  await tick(page, keys.parent);
  await expect(page.getByTestId("bulk-head")).toBeVisible();
  await shootM6(page, "light-inbox-bulk-start");
  await page.goto(`/projects/${projectId}/tickets/${parentTicketId}`);
  await expect(page.getByTestId("sub-issue").first()).toBeVisible();
  await shootM6(page, "light-ticket-parent");
  await chooseTheme(page, "Dark");
});

// At phone width (F-075), in the desktop project too.
test.describe("at phone width", () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

  test("F-107, F-077: the selection and the parent's page fit a phone", async ({ page }) => {
    const { projectId, parentTicketId, keys } = await seedBulkWorld();
    await signIn(page);
    await page.goto(`/projects/${projectId}/inbox`);
    await tick(page, keys.one);
    await expect(page.getByTestId("selection-bar")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shootM6(page, "inbox-bulk-start");
    await page.goto(`/projects/${projectId}/tickets/${parentTicketId}`);
    await expect(page.getByTestId("sub-issue").first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shootM6(page, "ticket-parent");
  });
});
