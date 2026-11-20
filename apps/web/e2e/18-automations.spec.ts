import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { expectNoHorizontalScroll, signIn } from "./helpers.ts";
import { signedInPage } from "./m4.ts";
import { chooseTheme, seedAutomationsWorld, seedPausedRule, shootM6 } from "./m6.ts";

// F-011, F-106, F-107 (milestone 6's ticket 31): a project's Automations, the rule and schedule
// editor with its dry run and "Start all", a schedule's preview and pause, and a rule's history,
// through the panel, its API, core's bulk-start worker and the database. It runs after the setup
// specs, which give the organization a model and its built-in profile, so a started task starts.

const viewer = "e2e-auto-viewer";

/** The inline `+ label` combobox of a condition row: open it, type a value, press Enter. */
const addValue = async (page: Page, n: number, value: string): Promise<void> => {
  await page.getByRole("button", { name: `Condition ${String(n)}: add a value` }).click();
  const input = page.getByRole("textbox", { name: `Condition ${String(n)}: add a value` });
  await input.fill(value);
  await input.press("Enter");
};

test("F-011, F-107: an admin creates a rule, sees its dry run, starts all of it, and sees its history", { tag: "@desktop-only" }, async ({ page }) => {
  const world = await seedAutomationsWorld(viewer);
  await signIn(page);
  await page.goto(`/projects/${world.projectId}/automations`);
  await expect(page.getByRole("heading", { level: 1, name: "Automations" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Navigation" }).getByRole("link", { name: "Automations" })).toBeVisible();
  await expect(page.getByTestId("automations-empty")).toContainText("No automations yet");
  await shootM6(page, "automations-empty");

  await page.getByTestId("automations-empty").getByRole("link", { name: "New rule" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New rule" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Triage bugs");
  await expect(page.getByTestId("dry-run")).toContainText("Add a condition to see the tickets that match.");
  await addValue(page, 1, "bug");

  // The dry run lists what starting each match would do, before anything is saved; nothing starts.
  const dry = page.getByTestId("dry-run");
  await expect(dry.getByTestId("dry-count")).toHaveText("3 tickets match now");
  await expect(dry.getByTestId("dry-row")).toHaveCount(3);
  await expect(dry.locator('[data-key="AUTO-1"]')).toContainText("Starts a code task");
  await expect(dry.getByRole("button", { name: "Save the rule first" })).toBeDisabled();

  await page.getByRole("button", { name: "Create rule" }).click();
  await page.waitForURL(/\/automations\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Triage bugs" })).toBeVisible();
  const startAll = dry.getByRole("button", { name: "Start all 3" });
  await expect(startAll).toBeEnabled();
  await expect(dry).toContainText("3 tasks from 3 tickets.");
  await shootM6(page, "automation-edit");

  // "Start all": one bulk start, each ticket's result streamed into its row.
  await startAll.click();
  await expect(dry.getByTestId("dry-count")).toHaveText("Started 3 tasks just now", { timeout: 30_000 });
  await expect(dry.getByTestId("dry-result")).toHaveText([/^Started [0-9a-f]{8}$/, /^Started [0-9a-f]{8}$/, /^Started [0-9a-f]{8}$/]);
  await expect(dry.getByRole("button", { name: "Started 3 tasks" })).toBeDisabled();
  // The dry run, read again, now skips them: each has its task.
  await page.reload();
  await expect(dry.getByTestId("dry-count")).toHaveText("3 tickets match now");
  await expect(dry.getByTestId("dry-outcome")).toHaveText([/^Skipped: it has a task, [0-9a-f]{8}$/, /^Skipped: it has a task, [0-9a-f]{8}$/, /^Skipped: it has a task, [0-9a-f]{8}$/]);

  // The list: the rule with its filter in words, its next ("on a match"), and its panel's counts.
  await page.goto(`/projects/${world.projectId}/automations`);
  const row = page.locator('[data-automation="Triage bugs"]');
  await expect(row).toContainText("label bug, any status");
  await expect(row.getByTestId("automation-next")).toHaveText("on a match");
  await expect(page.getByTestId("automation-started")).toHaveText("3 tasks");
  await expect(page.getByTestId("automation-limit")).toHaveText("3 of 20 this hour");
  await shootM6(page, "automations");

  // The history: the press's band, and each ticket started with its task.
  await page.getByRole("link", { name: "Open history" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Triage bugs" })).toBeVisible();
  await expect(page.getByTestId("history-band").first()).toContainText(/Started by hand, .* · 3 matches/);
  await expect(page.getByTestId("history-run-outcome")).toHaveText(["Started", "Started", "Started"]);
  await expect(page.getByTestId("history-table")).toContainText("AUTO-1");
  await expect(page.getByTestId("run-panel")).toContainText("Start all");
  await shootM6(page, "automation-history");
});

test("F-106: an admin creates a schedule from a preset in a zone, sees its next occurrences, and pauses it", { tag: "@desktop-only" }, async ({ page }) => {
  const world = await seedAutomationsWorld(viewer);
  await signIn(page);
  await page.goto(`/projects/${world.projectId}/automations/new?starts=schedule`);
  await expect(page.getByRole("heading", { level: 1, name: "New schedule" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Weekday dependency update");
  await page.getByRole("radio", { name: "Weekdays" }).click();
  await expect(page.getByLabel("Cron")).toHaveValue("0 9 * * 1-5");
  await page.getByTestId("zone-picker").click();
  await page.getByRole("textbox", { name: "Search time zones" }).fill("Amsterdam");
  await page.getByRole("option", { name: "Europe/Amsterdam" }).click();
  await expect(page.getByTestId("cron-sentence")).toHaveText("Every weekday at 09:00, Amsterdam time");
  await expect(page.getByTestId("next-occurrence")).toHaveCount(3);
  await expect(page.getByTestId("next-occurrence").first()).toHaveText(/^(Mon|Tue|Wed|Thu|Fri) \d{1,2} [A-Z][a-z]{2}, 09:00$/);

  // Under the install's minimum interval: refused in words, nothing to save.
  await page.getByLabel("Cron").fill("*/30 * * * *");
  await expect(page.getByTestId("cron-refusal")).toHaveText("Occurrences must be at least 60 minutes apart.");
  await expect(page.getByTestId("next-occurrence")).toHaveCount(0);
  await page.getByLabel("Cron").fill("0 9 * * 1-5");
  await expect(page.getByTestId("next-occurrence")).toHaveCount(3);

  await page.getByRole("radio", { name: "Start one prompt task" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Update the dependencies");
  await page.getByLabel("Prompt", { exact: true }).fill("Update every dependency to its latest minor version.");
  await expect(page.getByTestId("occurrences")).toContainText('Starts "Update the dependencies"');
  await page.getByRole("button", { name: "Create schedule" }).click();
  await page.waitForURL(/\/automations\/[0-9a-f-]{36}$/);
  await expect(page.getByText("saved just now")).toBeVisible();

  // The list says when it runs next, in its zone; the switch pauses it at once, and it stays paused.
  await page.goto(`/projects/${world.projectId}/automations`);
  const row = page.locator('[data-automation="Weekday dependency update"]');
  await expect(row).toContainText("Every weekday at 09:00, Amsterdam time");
  await expect(row.getByTestId("automation-next")).toHaveText(/^(Mon|Tue|Wed|Thu|Fri) \d{1,2} [A-Z][a-z]{2}, 09:00$/);
  const toggle = row.getByRole("switch", { name: "Weekday dependency update is on" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(row.getByTestId("automation-next")).toHaveText(/^Paused by /);
  await page.reload();
  await expect(page.locator('[data-automation="Weekday dependency update"]').getByRole("switch")).not.toBeChecked();
  await expect(page.locator('[data-automation="Weekday dependency update"]').getByTestId("automation-next")).toHaveText(/^Paused by /);
  // Paused rows sort after the enabled ones.
  const names = await page.locator("[data-automation]").evaluateAll((rows) => rows.map((one) => one.getAttribute("data-automation")));
  expect(names.indexOf("Weekday dependency update")).toBe(names.length - 1);

  // Its history says it's paused, with "Resume".
  await page.locator('[data-automation="Weekday dependency update"]').click();
  await page.getByRole("link", { name: "Open history" }).click();
  await expect(page.getByTestId("pause-notice")).toContainText("Occurrences while it's paused are skipped, and none catch up when it resumes.");
  await expect(page.getByText(/^Nothing yet\./)).toBeVisible();
  await page.getByTestId("pause-notice").getByRole("button", { name: "Resume" }).click();
  await expect(page.getByTestId("pause-notice")).toHaveCount(0);
});

test("F-011: a member reads the automations, with no switch to flip and nothing to edit", { tag: "@desktop-only" }, async ({ browser }) => {
  const world = await seedAutomationsWorld(viewer);
  const page = await signedInPage(browser, viewer);
  await page.goto(`/projects/${world.projectId}/automations`);
  const row = page.locator('[data-automation="Triage bugs"]');
  await expect(row).toBeVisible();
  await expect(row.getByRole("switch")).toBeDisabled();
  await expect(page.getByRole("link", { name: "New rule" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Edit rule" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open history" })).toBeVisible();
  await page.context().close();
});

test("F-011: a rule its hourly limit paused waits on Home for the project's admins until it's resumed", { tag: "@desktop-only" }, async ({ page }) => {
  const paused = await seedPausedRule("Docs fixes");
  await signIn(page);
  const homeRow = page.getByTestId("paused-rule").filter({ hasText: "Docs fixes paused after 20 starts in an hour" });
  await expect(homeRow).toBeVisible();
  await homeRow.getByRole("link", { name: "Review" }).click();
  await page.waitForURL(`**/projects/${paused.projectId}/automations?automation=${paused.automationId}`);
  const row = page.locator('[data-automation="Docs fixes"]');
  await expect(row.getByTestId("automation-next")).toHaveText("Paused: 20 starts in an hour");
  await row.getByRole("switch").click();
  await expect(row.getByTestId("automation-next")).toHaveText("on a match");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("paused-rule")).toHaveCount(0);
});

test("ticket 31: the automations screens in light, for the by-eye check", { tag: "@desktop-only" }, async ({ page }) => {
  test.skip(process.env["OSTRA_E2E_SHOTS"] === undefined, "screenshots only");
  const world = await seedAutomationsWorld(viewer);
  await signIn(page);
  await chooseTheme(page, "Light");
  await page.goto(`/projects/${world.projectId}/automations`);
  await page.locator('[data-automation="Triage bugs"]').click();
  await expect(page.getByTestId("automation-panel")).toBeVisible();
  await shootM6(page, "light-automations");
  await page.getByRole("link", { name: "Edit rule" }).click();
  await expect(page.getByTestId("dry-run").getByTestId("dry-count")).toBeVisible();
  await shootM6(page, "light-automation-edit");
  await page.goto(`/projects/${world.projectId}/automations`);
  await page.locator('[data-automation="Triage bugs"]').click();
  await page.getByRole("link", { name: "Open history" }).click();
  await expect(page.getByTestId("history-table")).toBeVisible();
  await shootM6(page, "light-automation-history");
  await chooseTheme(page, "Dark");
});

// At phone width (F-075), in the desktop project too: the phone project waits on every desktop spec.
test.describe("at phone width", () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

  test("F-011, F-106: Automations, the editor and the history fit a phone", async ({ page }) => {
    const world = await seedAutomationsWorld(viewer);
    await signIn(page);
    await page.goto(`/projects/${world.projectId}/automations`);
    await expect(page.locator('[data-automation="Triage bugs"]')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shootM6(page, "automations");
    await page.goto(`/projects/${world.projectId}/automations/new?starts=schedule`);
    await expect(page.getByTestId("cron-sentence")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shootM6(page, "automation-edit");
    await page.goto(`/projects/${world.projectId}/automations`);
    await page.locator('[data-automation="Triage bugs"]').click();
    await page.getByRole("link", { name: "Open history" }).click();
    await expect(page.getByTestId("history-table")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shootM6(page, "automation-history");
  });
});
