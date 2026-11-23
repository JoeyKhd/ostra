import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { ensureGitHub, expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";
import { e2eChangesHeads, e2eRepo } from "./settings.ts";

// Milestone 3's ticket 46 (F-027, F-072, F-070): the Changes tab on the fake GitHub. The project is
// made through New project on `test1`; the task's pushed branch is seeded (`seed-changes.ts`) at a
// head the fake GitHub's compare scripts (`fakes.ts`), and core's `diff.fetch` reads the diff from
// it as on any install. Everything after goes through the page: comments on two lines sent as one
// message, a new head that makes one of them outdated, and Update branch.

const run = promisify(execFile);
const seededSchema = z.object({ taskId: z.string(), taskRepoId: z.string(), repo: z.string() });
let projectId: string | null = null;

const seeder = async (input: Record<string, string>): Promise<unknown> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-changes.ts"), JSON.stringify({ databaseUrl, ...input })], { cwd: path.resolve(import.meta.dirname, "..") });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
};

/** A task with its branch pushed at one of the fake's heads, in a project on test1 made through New project (once per run). */
const seedTask = async (page: Page, head: "first" | "long" = "first"): Promise<z.infer<typeof seededSchema>> => {
  if (projectId === null) {
    await ensureGitHub(page);
    await page.goto("/projects/new");
    await page.getByRole("checkbox", { name: new RegExp(`${e2eRepo.owner}/test1`) }).check();
    await page.getByLabel("Name", { exact: true }).fill(`calc-changes-${Date.now().toString(36)}`);
    await page.getByRole("button", { name: "Create the project" }).click();
    await page.waitForURL(/\/projects\/[^/]+\/environment/);
    projectId = new URL(page.url()).pathname.split("/")[2] ?? "";
  }
  return seededSchema.parse(await seeder({ action: "seed", projectId, head }));
};

/** How far the diff has scrolled, and every box around it up to the page itself. */
const scrolled = (page: Page): Promise<{ readonly diff: number; readonly page: number }> =>
  page.getByRole("grid", { name: "The diff" }).evaluate((grid) => {
    let around = 0;
    for (let box = grid.parentElement; box !== null; box = box.parentElement) around += box.scrollTop;
    return { diff: grid.scrollTop, page: around };
  });

const intents = async (taskId: string): Promise<readonly string[]> => z.object({ intents: z.array(z.string()) }).parse(await seeder({ action: "messages", taskId })).intents;

/** Opens the comment field on the diff's row that holds `text`, and saves a draft. */
const comment = async (page: Page, text: string, line: number, body: string): Promise<void> => {
  const row = page.locator("[role='row']", { hasText: text });
  await row.hover();
  await row.getByRole("button", { name: `Comment on line ${String(line)}` }).click();
  await page.getByLabel(`Comment on line ${String(line)}…`).fill(body);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator("[data-comment][data-state='draft']", { hasText: body })).toBeVisible();
};

test("F-027/c1: the Changes tab draws the branch's diff against its base from the code host, with a rename and a binary file", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  const task = await seedTask(page);
  await page.goto(`/tasks/${task.taskId}?tab=changes`);

  // The diff core fetched from the fake GitHub: the rename names both paths, the binary file has a note.
  const renamed = page.locator("[data-file]", { hasText: "src/calc.ts" });
  await expect(renamed).toBeVisible({ timeout: 30_000 });
  await expect(renamed).toContainText("← src/calculator.ts");
  await expect(page.locator("[data-file]", { hasText: "assets/logo.png" })).toBeVisible();
  await expect(page.getByText("Binary file, not shown").first()).toBeVisible();
  await expect(page.locator("[role='row']", { hasText: "A calculator." })).toBeVisible();
  await expect(page.getByText(task.repo, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("F-072/c1,c2: comments on two lines go to the agent as one message, and a new head marks outdated the one whose line changed", { tag: "@desktop-only" }, async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const task = await seedTask(page);
  await page.goto(`/tasks/${task.taskId}?tab=changes`);
  await expect(page.locator("[role='row']", { hasText: "A calculator." })).toBeVisible({ timeout: 30_000 });

  // Two comments on two files, sent together.
  await comment(page, 'name = "calc";', 2, "Keep the old name exported for a release.");
  await comment(page, "A calculator.", 3, "Say what it calculates.");
  await page.getByRole("button", { name: "Send 2 comments to the agent" }).click();
  await expect(page.getByText("Sent 2 comments as one message.")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-comment][data-state='sent']")).toHaveCount(2);
  expect(await intents(task.taskId)).toEqual(["message", "diff-comments"]);

  // The thread draws that message from the comments it carried, never the fenced prompt the agent reads.
  await page.getByRole("button", { name: "See it in Activity" }).click();
  const sent = page.locator("[data-role='user']", { has: page.locator("[data-intent='diff-comments']") });
  await expect(sent).toContainText("2 comments on the diff", { timeout: 10_000 });
  await expect(sent.locator("[data-diff-comment]")).toHaveCount(2);
  await expect(sent).toContainText("Keep the old name exported for a release.");
  await expect(sent).toContainText("README.md:3");
  await expect(sent).not.toContainText("ostra-data");
  await page.goto(`/tasks/${task.taskId}?tab=changes`);

  // The agent pushes a new head that rewrites the README's last line. Core's `diff.fetch` reads it and
  // its notice reaches the open tab: that comment is outdated, still readable; the other still holds.
  await seeder({ action: "new-head", taskId: task.taskId });
  await page.reload();
  await expect(page.locator("[role='row']", { hasText: "A small calculator, with a name." })).toBeVisible({ timeout: 30_000 });
  const outdated = page.locator("[data-comment][data-state='outdated']");
  await expect(outdated).toHaveCount(1, { timeout: 30_000 });
  await expect(outdated).toContainText("Say what it calculates.");
  await expect(outdated).toContainText(`line 3 · ${e2eChangesHeads.first.slice(0, 7)}`);
  await expect(page.locator("[data-comment][data-state='sent']", { hasText: "Keep the old name exported for a release." })).toBeVisible();
});

test("F-070/c1: a branch behind its base shows Update branch, which sends the agent one message", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  const task = await seedTask(page);
  await page.goto(`/tasks/${task.taskId}?tab=changes`);
  const behind = page.locator("[data-behind]");
  await expect(behind).toContainText(`${task.repo} is 2 commits behind main`, { timeout: 30_000 });
  await behind.getByRole("button", { name: "Update branch" }).click();
  await expect(behind).toContainText(/asked .+ to merge it/, { timeout: 10_000 });
  await expect(behind.getByRole("button", { name: "Update branch" })).toHaveCount(0);
  expect(await intents(task.taskId)).toEqual(["message", "update-branch"]);
});

// The maintainer, 2026-11-23: the wheel did nothing over the diff. Its box grew to every row's
// height, so it never scrolled, drew every row, and its `overscroll-contain` kept the wheel from the page.
test("the wheel over a long diff scrolls it, drawing its rows as they come", async ({ page }) => {
  await signIn(page);
  const task = await seedTask(page, "long");
  await page.goto(`/tasks/${task.taskId}?tab=changes`);
  const grid = page.getByRole("grid", { name: "The diff" });
  await expect(grid.locator("[role='row']", { hasText: "row1 = 1;" })).toBeVisible({ timeout: 30_000 });

  // The box holds about a screenful of the 300 lines, never all of them.
  expect(await grid.locator("[data-index]").count()).toBeLessThan(120);
  await grid.locator("[role='row']", { hasText: "row2 = 2;" }).hover();
  const before = await scrolled(page);
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await scrolled(page)).diff).toBeGreaterThan(before.diff);

  // On down to the last line, drawn once it scrolls in.
  for (let i = 0; i < 16; i++) await page.mouse.wheel(0, 600);
  await expect(grid.locator("[role='row']", { hasText: "row300 = 300;" })).toBeInViewport();
});

test("the wheel over a diff shorter than its box scrolls the page", async ({ page }) => {
  // A short window, so the page has somewhere to scroll.
  await page.setViewportSize({ width: page.viewportSize()?.width ?? 1440, height: 480 });
  await signIn(page);
  const task = await seedTask(page);
  await page.goto(`/tasks/${task.taskId}?tab=changes`);
  const calc = page.locator("[data-file]", { hasText: "src/calc.ts" });
  await expect(calc).toBeVisible({ timeout: 30_000 });
  // Folded, the first file leaves the diff a few rows, well inside its 320px box.
  await calc.click();
  await expect(calc).toHaveAttribute("aria-expanded", "false");
  await calc.hover();
  const before = await scrolled(page);
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await scrolled(page)).page).toBeGreaterThan(before.page);
  expect((await scrolled(page)).diff).toBe(0);
});
