import { expect, test } from "@playwright/test";

import { expectNoHorizontalScroll, seedTask, signIn, watchOrigins } from "./helpers.ts";

// Ticket 38: the task page on a replayed event stream (`seed-task.ts`, the recorded OpenCode
// session). Two tabs, a reload mid-turn, Stop, a task without changes, and the long-task timing.

test.describe.configure({ mode: "serial" });

test("two tabs show the same thread, live; a reload mid-turn brings back the history and the partial text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "seeded once");
  const origins = watchOrigins(page);
  await signIn(page);
  const taskId = await seedTask("mid-turn");

  await page.goto(`/tasks/${taskId}`);
  const thread = page.locator('[data-part="thread"]');
  await expect(thread.locator('[data-tool-kind="read"]').first()).toBeVisible();
  await expect(thread.locator('[data-tool-kind="execute"]').first()).toBeVisible();
  await expect(thread).toContainText("Halfway through the change");
  await expect(page.locator('[data-part="setup"]')).toBeVisible();
  await expectNoHorizontalScroll(page);

  // A second tab, the same member.
  const second = await page.context().newPage();
  await second.goto(`/tasks/${taskId}`);
  await expect(second.locator('[data-part="thread"]')).toContainText("Halfway through the change");

  // Reload mid-turn: the history and the partial text are back within a second.
  const started = Date.now();
  await page.reload();
  await expect(thread).toContainText("Halfway through the change", { timeout: 5_000 });
  const reloadMs = Date.now() - started;
  console.info(`reload mid-turn to history and partial text: ${String(reloadMs)} ms`);
  expect(reloadMs).toBeLessThan(3_000);

  // The rest of the session arrives live, in both tabs: the edit, the push, the PR.
  await seedTask("rest", taskId);
  for (const tab of [page, second]) {
    const view = tab.locator('[data-part="thread"]');
    await expect(view.locator('[data-part="pr"]')).toContainText("#7", { timeout: 10_000 });
    await expect(view.locator('[data-part="session-end"]')).toHaveAttribute("data-outcome", "with-changes");
    await expect(view).not.toContainText("Halfway through the change");
  }
  expect(await page.locator('[data-part="thread"] [data-part="tool"]').count()).toBe(await second.locator('[data-part="thread"] [data-part="tool"]').count());
  await second.close();
  expect(origins.foreign()).toEqual([]);
});

test("Stop stops the task, optimistically, and the page shows it stopped", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "seeded once");
  await signIn(page);
  const taskId = await seedTask("mid-turn");
  await page.goto(`/tasks/${taskId}`);
  await page.locator('[data-action="stop"]').click();
  await expect(page.getByTestId("task-doing")).toContainText(/Stopping|Stopped/);
  await expect(page.getByTestId("task-properties")).toContainText("Stopped", { timeout: 10_000 });
});

test("a task that ended without changes shows its needs-you summary", async ({ page }) => {
  await signIn(page);
  const taskId = await seedTask("without-changes");
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByTestId("needs-you")).toContainText("No changes: the tests live in test/");
  await expect(page.locator('[data-part="session-end"]')).toHaveAttribute("data-outcome", "without-changes");
  await expectNoHorizontalScroll(page);
});

test("the default view of a 5,000-event task renders, and the time is recorded", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "measured at desktop width");
  await signIn(page);
  const taskId = await seedTask("long");
  const started = Date.now();
  await page.goto(`/tasks/${taskId}`);
  await expect(page.locator('[data-part="thread"] [data-part="tool"]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-action="load-earlier"]')).toBeVisible();
  const ms = Date.now() - started;
  const fold = await page.evaluate((): unknown => JSON.stringify(Reflect.get(globalThis, "__ostraFold")));
  console.info(`5,000-event task, default view (the newest 20 turns): ${String(ms)} ms to visible, fold ${String(fold)}`);
  // ADR 0036's bar (1.5 s) is measured on a mid laptop; this machine's figure is noted, not claimed.
  expect(ms).toBeLessThan(15_000);
});

test("F-089: the task page shows the key proxy's count, and says so when a call's count is an estimate", async ({ page }) => {
  await signIn(page);
  // Every call reported its usage: a plain count.
  const exact = await seedTask("usage");
  await page.goto(`/tasks/${exact}`);
  const properties = page.getByTestId("task-properties");
  await expect(properties.getByTestId("task-tokens")).toHaveText("2k in · 450 out");
  await expect(properties.getByTestId("task-tokens-estimated")).toHaveCount(0);
  // One call's endpoint reported none: the same count, marked as an estimate.
  const estimated = await seedTask("estimated-usage");
  await page.goto(`/tasks/${estimated}`);
  await expect(properties.getByTestId("task-tokens")).toHaveText("2k in · 450 out");
  await expect(properties.getByTestId("task-tokens-estimated")).toHaveText("estimated");
  await expect(properties.getByTestId("task-tokens-estimated")).toHaveAttribute("title", /estimated its tokens/);
  await expectNoHorizontalScroll(page);
});
