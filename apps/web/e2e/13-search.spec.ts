import { expect, test } from "@playwright/test";

import { expectNoHorizontalScroll, signIn } from "./helpers.ts";
import { m4World, seedM4World, shoot, shootPhone } from "./m4.ts";

// F-080 (ticket 35): the search palette and the search page, on the seeded m4calc world (seed-m4.ts):
// the admin's task on `fake-org/m4calc` whose agent message (seq 7) holds the word `zeppelinoid`.

const AGENT_SEQ = 7;

test("F-080/c1: the palette opens with the keys, finds a task by a word from its agent message, filters by repo:, and Enter opens the task at the matched event", { tag: "@desktop-only" }, async ({ page }) => {
  const world = await seedM4World(m4World);
  await signIn(page);
  await page.keyboard.press("Control+KeyK");
  const palette = page.getByTestId("search-palette");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Control+KeyK");
  await expect(palette).toHaveCount(0);
  await page.keyboard.press("Control+KeyK");
  await expect(palette).toBeVisible();

  const box = palette.getByRole("combobox");
  await box.pressSequentially(m4World.word);
  const hit = palette.getByTestId("search-palette-result").and(page.locator(`[data-task="${world.taskId}"]`));
  await expect(hit).toBeVisible();
  await expect(hit.getByTestId("search-snippet").and(page.locator('[data-kind="agent_message"]'))).toContainText(m4World.word);
  await expect(hit.locator("mark")).toHaveText(m4World.word);
  await expect(palette.getByTestId("search-palette-result").and(page.locator(`[data-task="${world.otherTaskId}"]`))).toHaveCount(0);

  // `repo:` becomes a chip; a repo the task isn't on finds nothing, its own finds it.
  await box.fill("");
  await box.pressSequentially(`repo:test1 ${m4World.word}`);
  await expect(palette.getByTestId("search-chip")).toHaveText("repo:test1");
  await expect(palette.getByText("No tasks match.")).toBeVisible();
  await box.press("Home");
  await box.press("Backspace");
  await expect(palette.getByTestId("search-chip")).toHaveCount(0);
  await box.fill("");
  await box.pressSequentially(`repo:m4calc ${m4World.word}`);
  await expect(palette.getByTestId("search-chip")).toHaveText("repo:m4calc");
  await expect(hit).toBeVisible();
  await expect(hit).toHaveAttribute("aria-selected", "true");
  await shoot(page, "search-palette");

  await box.press("Enter");
  await page.waitForURL(new RegExp(`/tasks/${world.taskId}\\?event=${String(AGENT_SEQ)}$`));
  const focused = page.locator('[data-event-focus="true"]');
  await expect(focused).toHaveCount(1);
  await expect(focused).toContainText(m4World.word);
  const first = Number(await focused.getAttribute("data-first-seq"));
  const last = Number(await focused.getAttribute("data-last-seq"));
  expect(first <= AGENT_SEQ && AGENT_SEQ <= last).toBe(true);
});

test("F-080/c1: the search page's filters round-trip through the URL", { tag: "@desktop-only" }, async ({ page }) => {
  const world = await seedM4World(m4World);
  await signIn(page);
  await page.goto(`/search?q=${m4World.word}&repo=m4calc&state=stopped&period=any`);
  await expect(page.getByTestId("search-query")).toHaveValue(m4World.word);
  await expect(page.getByTestId("search-filter-repo-value")).toHaveText("m4calc");
  await expect(page.getByTestId("search-filter-state-value")).toHaveText("stopped");
  await expect(page.getByTestId("search-filter-period-value")).toHaveText("Any time");
  const result = page.getByTestId("search-result").and(page.locator(`[data-result="${world.taskId}"]`));
  await expect(result).toBeVisible();
  await expect(page.getByTestId("search-count")).toHaveText("1 task");
  await expect(page.getByTestId("search-panel")).toContainText("Fix the history view");

  // A token typed in the query leaves the text and sets its control, in the URL too.
  await page.getByTestId("search-query").pressSequentially(" by:demo ");
  await expect(page).toHaveURL(/by=demo/);
  await expect(page.getByTestId("search-filter-member-value")).toHaveText("demo");
  await expect(page.getByTestId("search-query")).toHaveValue(m4World.word);
  await expect(result).toBeVisible();

  // The URL alone brings the same search back.
  await page.reload();
  await expect(page.getByTestId("search-filter-member-value")).toHaveText("demo");
  await expect(page.getByTestId("search-filter-repo-value")).toHaveText("m4calc");
  await expect(result).toBeVisible();
  await shoot(page, "search");

  // A state the task isn't in finds nothing; clearing it, in the URL too, finds it again.
  await page.goto(`/search?q=${m4World.word}&repo=m4calc&state=merged&period=any`);
  await expect(page.getByText(`No task matches ${m4World.word} with these filters.`)).toBeVisible();
  await page.getByRole("button", { name: "Clear State" }).click();
  await expect(page).not.toHaveURL(/state=/);
  await expect(result).toBeVisible();
  await expect(page).toHaveURL(/repo=m4calc/);
});

test("F-080: the palette and the search page fit a phone", async ({ page }) => {
  await seedM4World(m4World);
  await signIn(page);
  await page.goto("/search");
  await expect(page.getByText("Search every task")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shoot(page, "search-empty");
  await page.goto(`/search?q=${m4World.word}&period=any`);
  await expect(page.getByTestId("search-result").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shootPhone(page, "search");
  await page.getByTestId("topbar-search").click();
  await page.getByTestId("search-palette").getByRole("combobox").pressSequentially(m4World.word);
  await expect(page.getByTestId("search-palette-result").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shootPhone(page, "search-palette");
});
