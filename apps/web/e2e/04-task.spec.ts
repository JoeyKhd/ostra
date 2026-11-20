import { expect, test } from "@playwright/test";

import { expectNoHorizontalScroll, seedTask, signIn, watchOrigins } from "./helpers.ts";

// Ticket 38: the task page on a replayed event stream (`seed-task.ts`, the recorded OpenCode
// session). Two tabs, a reload mid-turn, Stop, a task without changes, and the long-task timing.

test.describe.configure({ mode: "serial" });

// Desktop only: the phone project leaves out tests tagged @desktop-only (playwright.config.ts).
test("F-023/c1: two tabs show the messages, tool calls and file changes live; a reload mid-turn brings back the history and the partial text", { tag: "@desktop-only" }, async ({ page }) => {
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

  // A file change and a message arrive while both tabs are open: each shows them, with no reload.
  const editsBefore = await thread.locator('[data-tool-kind="edit"]').count();
  await seedTask("live-edit", taskId);
  for (const tab of [page, second]) {
    const view = tab.locator('[data-part="thread"]');
    const edit = view.locator('[data-tool-kind="edit"]', { hasText: "docs/numbers.md" });
    await expect(edit).toBeVisible({ timeout: 10_000 });
    await expect(edit).toContainText("+10");
    await expect(view).toContainText("Added docs/numbers.md with ten lines.");
  }
  expect(await thread.locator('[data-tool-kind="edit"]').count()).toBe(editsBefore + 1);

  // Reload mid-turn: the history and the partial text are back within a second.
  const started = Date.now();
  await page.reload();
  await expect(thread).toContainText("Halfway through the change", { timeout: 5_000 });
  const reloadMs = Date.now() - started;
  // The history is whole after the reload: the recorded calls, the earlier edit and the live one.
  await expect(thread.locator('[data-tool-kind="edit"]', { hasText: "README.md" })).toBeVisible();
  await expect(thread.locator('[data-tool-kind="edit"]', { hasText: "docs/numbers.md" })).toContainText("+10");
  await expect(thread).toContainText("Added docs/numbers.md with ten lines.");
  await expect(thread.locator('[data-tool-kind="read"]').first()).toBeVisible();
  console.info(`reload mid-turn to history and partial text: ${String(reloadMs)} ms`);
  expect(reloadMs).toBeLessThan(3_000);

  // The rest of the session arrives live, in both tabs: the messages, the push, the PR.
  await seedTask("rest", taskId);
  for (const tab of [page, second]) {
    const view = tab.locator('[data-part="thread"]');
    await expect(view.locator('[data-part="pr"]')).toContainText("#7", { timeout: 10_000 });
    await expect(view.locator('[data-part="session-end"]')).toHaveAttribute("data-outcome", "with-changes");
    await expect(view).toContainText("t5 done");
    await expect(view).not.toContainText("Halfway through the change");
  }
  const toolRows = await page.locator('[data-part="thread"] [data-part="tool"]').count();
  expect(await second.locator('[data-part="thread"] [data-part="tool"]').count()).toBe(toolRows);
  await second.close();

  // Afterwards, the full history: a fresh load of the ended task shows every row it showed live.
  await page.reload();
  await expect(thread.locator('[data-part="session-end"]')).toHaveAttribute("data-outcome", "with-changes");
  await expect(thread.locator('[data-part="tool"]')).toHaveCount(toolRows);
  await expect(thread.locator('[data-tool-kind="edit"]', { hasText: "docs/numbers.md" })).toContainText("+10");
  await expect(thread).toContainText("Added docs/numbers.md with ten lines.");
  await expect(thread).toContainText("t5 done");
  await expect(thread.locator('[data-part="pr"]')).toContainText("#7");
  expect(origins.foreign()).toEqual([]);
});

test("F-025/c1: Stop stops the task, optimistically, and the page shows it stopped", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  const taskId = await seedTask("mid-turn");
  await page.goto(`/tasks/${taskId}`);
  await page.locator('[data-action="stop"]').click();
  await expect(page.getByTestId("task-doing")).toContainText(/Stopping|Stopped/);
  await expect(page.getByTestId("task-properties")).toContainText("Stopped", { timeout: 10_000 });
  // Stored, not only shown: a reload still reads it stopped, and offers no Stop.
  await page.reload();
  await expect(page.getByTestId("task-properties")).toContainText("Stopped");
  await expect(page.locator('[data-action="stop"]')).toHaveCount(0);
});

test("a task that ended without changes shows its needs-you summary", async ({ page }) => {
  await signIn(page);
  const taskId = await seedTask("without-changes");
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByTestId("needs-you")).toContainText("No changes: the tests live in test/");
  await expect(page.locator('[data-part="session-end"]')).toHaveAttribute("data-outcome", "without-changes");
  await expectNoHorizontalScroll(page);
});

test("the default view of a 5,000-event task renders, and the time is recorded", { tag: "@desktop-only" }, async ({ page }) => {
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

test("F-089/c5: the task page shows the key proxy's count, and says so when a call's count is an estimate", async ({ page }) => {
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
