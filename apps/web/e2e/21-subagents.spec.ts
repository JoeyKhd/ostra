import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";

// F-138 (milestone 7, ticket 39): an agent's subagents on the task page, against the approved
// targets (`context/brand/app-targets/m7/task-subagents-badge` and `task-subagents-tree`). Three
// seeded tasks (`seed-subagents.ts`), each a turn with four subagents, one nested: one still runs,
// one failed, one waits on an approval. At 900px and wider the badge opens a dialog with the tree;
// on a phone, a full-height sheet with an indented list. `OSTRA_E2E_SHOTS` names a folder for the
// screenshots compared with the targets.

test.describe.configure({ mode: "serial" });

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const seededSchema = z.object({ running: z.string(), failed: z.string(), approval: z.string() });
let seeded: z.infer<typeof seededSchema> | null = null;

const seed = async (): Promise<z.infer<typeof seededSchema>> => {
  if (seeded !== null) return seeded;
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-subagents.ts"), JSON.stringify({ databaseUrl })], { cwd: path.resolve(import.meta.dirname, "..") });
  seeded = seededSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
  return seeded;
};

const phone = (page: Page): boolean => (page.viewportSize()?.width ?? 1440) < 900;

const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, `m7-subagents-${name}${phone(page) ? "-phone" : ""}-final.png`) });
};

const openTask = async (page: Page, taskId: string): Promise<void> => {
  await signIn(page);
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByTestId("subagents-badge")).toBeVisible({ timeout: 30_000 });
};

const thread = (page: Page) => page.locator('[data-part="thread"]');
const window = (page: Page) => page.getByTestId("subagents-window");

/** Opens the turn's run: the live step's line while the turn still runs, else the run's own line. */
const openRun = async (page: Page): Promise<void> => {
  const live = thread(page).locator("[data-part='live-line']");
  if ((await live.count()) > 0) await live.first().click();
  else await thread(page).locator("[data-nav='run-line']").first().click();
};

test("F-138/c1,c2: the agent's turn carries the badge, 4 subagents · 1 running, and the opened run holds its own Subagent steps and none of the subagents' calls or answers", async ({ page }) => {
  const { running } = await seed();
  await openTask(page, running);
  const badge = page.getByTestId("subagents-badge");
  await expect(badge).toHaveAccessibleName("4 subagents, 1 running");
  await expect(badge).toContainText("4 subagents");
  await expect(badge).toContainText("1 running");
  await expect(badge).toHaveAttribute("aria-haspopup", "dialog");
  // Milestone 10 (tickets 10 and 17): the badge sits on the run's line; opened, one step per subagent.
  await openRun(page);
  const rows = thread(page).locator("[data-part='run-steps'] li[data-step='subagent']");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("explore");
  await expect(rows.nth(0)).toContainText("Find the version source");
  await expect(rows.nth(0)).toContainText("14 calls · 1 min 12 s");
  await expect(rows.nth(2)).toContainText("general");
  await expect(rows.nth(2)).toHaveAttribute("data-state", "running");
  // Nothing of the subagents' own: no answer, no call, in the thread.
  await expect(thread(page)).not.toContainText("Six settings tests live");
  await expect(thread(page)).not.toContainText("test/render.tsx");
  await expect(thread(page)).toContainText("I'll have subagents find where the build info is read");
  await expectNoHorizontalScroll(page);
  await shoot(page, "badge");
});

test("F-138/c2,c3: the badge opens the window: the tree under OpenCode, the running subagent selected with what it was asked, its calls and no answer yet, the nested one under its parent", async ({ page }) => {
  const { running } = await seed();
  await openTask(page, running);
  await page.getByTestId("subagents-badge").click();
  await expect(window(page)).toBeVisible();
  if (phone(page)) {
    // The sheet, full height: the tree as an indented list; a row opens its details, and back.
    await expect(window(page)).toHaveAttribute("data-layout", "sheet");
    const list = window(page).getByTestId("subagent-list-row");
    await expect(list).toHaveCount(4);
    await expect(window(page).locator('[data-list-row="ses_test_helpers"]')).toHaveAttribute("aria-level", "3");
    await expectNoHorizontalScroll(page);
    await shoot(page, "tree-list");
    await window(page).locator('[data-list-row="ses_version_row"]').click();
    await expect(window(page).getByTestId("subagent-detail")).toContainText("Write version row test");
    await expect(window(page).getByTestId("subagent-detail")).toContainText("Still working. Its answer shows here when it's done.");
    await shoot(page, "tree-detail");
    await window(page).locator('[data-action="subagents-back"]').click();
    await expect(list).toHaveCount(4);
    await page.keyboard.press("Escape");
    await expect(window(page)).toBeHidden();
    return;
  }
  await expect(window(page)).toHaveAttribute("data-layout", "dialog");
  await expect(window(page).getByRole("heading", { name: "Subagents" })).toBeVisible();
  await expect(window(page)).toContainText("4 in OpenCode's turn at");
  await expect(window(page)).toContainText("1 running");
  const tree = window(page).getByRole("tree");
  await expect(tree.getByRole("treeitem")).toHaveCount(5);
  // It opens on the running one, focused.
  const general = tree.locator('[data-tree-card="ses_version_row"]');
  await expect(general).toHaveAttribute("aria-selected", "true");
  await expect(general).toBeFocused();
  await expect(tree.locator('[data-tree-card="ses_test_helpers"]')).toHaveAttribute("aria-level", "3");
  await expect(tree.locator('[data-tree-card="ses_version_source"]')).toHaveAccessibleName("explore subagent, Find the version source, done, 1 minute 12 seconds, 14 calls");
  const detail = window(page).getByTestId("subagent-detail");
  await expect(detail).toHaveAttribute("data-subagent", "ses_version_row");
  await expect(detail).toContainText("Asked by OpenCode");
  await expect(detail).toContainText("Add a test for the version row");
  await expect(detail).toContainText("test/render.tsx");
  await expect(detail).toContainText("Still working. Its answer shows here when it's done.");
  // No tokens line on a card or in the details: nothing gives them per subagent yet. The footer says the task's spend holds them.
  await expect(tree).not.toContainText("tokens");
  await expect(detail).not.toContainText("tokens");
  await expect(window(page)).toContainText("Their tokens are in the task's spend.");
  await shoot(page, "tree");

  // The keyboard: up and down through the tree depth first, right to a child, left to the parent,
  // Home and End; the details follow the selection; Escape closes and gives the focus back.
  await page.keyboard.press("ArrowUp");
  await expect(tree.locator('[data-tree-card="ses_settings_tests"]')).toBeFocused();
  await expect(detail).toHaveAttribute("data-subagent", "ses_settings_tests");
  await expect(detail).toContainText("Six settings tests live in");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(tree.locator('[data-tree-card="ses_test_helpers"]')).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(general).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tree.locator('[data-tree-card="root"]')).toBeFocused();
  await expect(detail).toHaveAttribute("data-subagent", "root");
  await expect(detail).toContainText("Asked by");
  await page.keyboard.press("End");
  await expect(tree.locator('[data-tree-card="ses_test_helpers"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(window(page)).toBeHidden();
  await expect(page.getByTestId("subagents-badge")).toBeFocused();

  // In the light theme, the same window (the panel's light tokens, F-082).
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "light"); });
  await page.getByTestId("subagents-badge").press("Enter");
  await expect(window(page)).toBeVisible();
  await shoot(page, "tree-light");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
});

test("F-138: a Subagent step opens the window on its own subagent, from the keyboard too", async ({ page }) => {
  const { running } = await seed();
  await openTask(page, running);
  await openRun(page);
  const row = thread(page).locator("[data-step='subagent'][data-subagent='ses_settings_tests']");
  await row.getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(window(page)).toBeVisible();
  if (phone(page)) {
    await expect(window(page).locator('[data-list-row="ses_settings_tests"]')).toHaveAttribute("aria-selected", "true");
  } else {
    await expect(window(page).locator('[data-tree-card="ses_settings_tests"]')).toBeFocused();
    await expect(window(page).getByTestId("subagent-detail")).toContainText("Six settings tests live in");
  }
  await page.keyboard.press("Escape");
  await expect(window(page)).toBeHidden();
  await expect(row.getByRole("button")).toBeFocused();
});

test("F-138: a failed subagent: the badge reads 1 failed, its node is red, and its detail gives the error", async ({ page }) => {
  const { failed } = await seed();
  await openTask(page, failed);
  const badge = page.getByTestId("subagents-badge");
  await expect(badge).toHaveAccessibleName("4 subagents, 1 failed");
  await openRun(page);
  await expect(thread(page).locator("[data-step='subagent'][data-subagent='ses_version_row']")).toHaveAttribute("data-state", "failed");
  await badge.click();
  if (!phone(page)) {
    await expect(window(page).locator('[data-tree-card="ses_version_row"]')).toHaveAttribute("data-state", "failed");
    await window(page).locator('[data-tree-card="ses_version_row"]').click();
  } else {
    await window(page).locator('[data-list-row="ses_version_row"]').click();
  }
  const detail = window(page).getByTestId("subagent-detail");
  await expect(detail).toContainText("failed");
  await expect(detail).toContainText("The model endpoint returned 500 after 3 retries.");
  await expect(detail).toContainText("It stopped before it answered.");
  await shoot(page, "failed");
  await page.keyboard.press("Escape");
});

test("F-138/c4: a subagent's call that waits on an approval asks in the thread, naming the subagent; the badge reads 1 needs approval", async ({ page }) => {
  const { approval } = await seed();
  await openTask(page, approval);
  const badge = page.getByTestId("subagents-badge");
  await expect(badge).toHaveAccessibleName("4 subagents, 1 needs approval");
  const card = thread(page).getByTestId("approval");
  await expect(card).toContainText("general · Write version row test asks before running this command:");
  await expect(card).toContainText("pnpm test settings");
  await expect(card.locator('[data-action="approve-once"]')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shoot(page, "approval");
  await badge.click();
  if (!phone(page)) {
    await expect(window(page).locator('[data-tree-card="ses_version_row"]')).toHaveAttribute("data-state", "needs-approval");
    // In the window too, under the call, the same block: one answer from either place closes both.
    await expect(window(page).getByTestId("subagent-detail").getByTestId("approval")).toContainText("general · Write version row test asks before running this command:");
  }
  await page.keyboard.press("Escape");
});
