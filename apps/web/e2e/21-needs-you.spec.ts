import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";

import { readStack, signIn } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";
import { railSpace } from "./shell.ts";

// Milestone 3, ticket 44 (F-062, F-036): Sam, a member who isn't an admin, meets an approval the
// admin's task raised in one project: on Home first, then on Needs you, where Sam answers it inline
// and it moves to Done. The sidebar's count follows without a reload: up when a new approval is
// raised in the other project, down when Sam answers. And Home's board puts each task in the column
// of its state. The world is seeded (`seed-needs-you-world.ts`); core fans the answer out.

const run = promisify(execFile);
const cwd = path.resolve(import.meta.dirname, "..");
const tag = `ny-${Date.now().toString(36)}`;

const worldSchema = z.object({
  samUsername: z.string(),
  first: z.object({ id: z.string(), name: z.string() }),
  second: z.object({ id: z.string(), name: z.string() }),
  approval: z.object({ taskId: z.string(), approvalId: z.string() }),
  inReviewTaskId: z.string(),
  doneTaskId: z.string(),
});
const approvalSchema = z.object({ taskId: z.string(), approvalId: z.string() });

const seed = async (input: Record<string, string>): Promise<unknown> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-needs-you-world.ts"), JSON.stringify({ databaseUrl, tag, ...input })], { cwd });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
};

let world: z.infer<typeof worldSchema>;

test.beforeAll(async () => {
  world = worldSchema.parse(await seed({ step: "world", password: e2eAdmin.password }));
});

/** The sidebar's amber count: what waits on the member, 0 when the badge is gone. */
const sidebarCount = async (page: Page): Promise<number> => {
  const badge = page.getByRole("navigation").getByTestId("needs-you-count");
  return (await badge.count()) === 0 ? 0 : Number(await badge.textContent());
};

/** The Needs you page's row for a task. */
const needsYouRow = (page: Page, taskId: string): Locator => page.locator("li[data-notification]").filter({ has: page.locator(`a[href="/tasks/${taskId}"]`) });

test("F-062/c1,c2, F-036/c2: an approval in one project shows on Sam's Home and Needs you, is answered inline and moves to Done; the count follows without a reload", { tag: "@desktop-only" }, async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, world.samUsername);

  // Home leads with it: the approval of the admin's task, in its project.
  const homeRow = page.locator(`[data-testid="needs-you-row"][data-task="${world.approval.taskId}"]`);
  await expect(homeRow).toBeVisible();
  await expect(homeRow).toContainText(world.first.name);
  await expect.poll(() => sidebarCount(page)).toBeGreaterThan(0);
  const before = await sidebarCount(page);

  // A new approval in the other project: the count rises on the open page, with no reload.
  let reloaded = false;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) reloaded = true;
  });
  const second = approvalSchema.parse(await seed({ step: "approval", title: `Add right-pad to the build ${tag}` }));
  await expect.poll(() => sidebarCount(page), { timeout: 25_000 }).toBe(before + 1);
  expect(reloaded).toBe(false);

  // Needs you lists both, each in its project's group; Sam approves the first one inline.
  await railSpace(page, "Needs you").click();
  await page.waitForURL((url) => url.pathname === "/needs-you");
  await expect(needsYouRow(page, second.taskId)).toBeVisible();
  const row = needsYouRow(page, world.approval.taskId);
  await expect(row).toBeVisible();
  if ((await row.getByRole("button", { name: "Approve once" }).count()) === 0) await row.getByRole("button", { name: "Approve" }).click();
  await row.getByRole("button", { name: "Approve once" }).click();
  // Answered, it leaves the open list, and the count drops on the same page.
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  await expect(needsYouRow(page, second.taskId)).toBeVisible();
  reloaded = false;
  await expect.poll(() => sidebarCount(page), { timeout: 25_000 }).toBe(before);
  expect(reloaded).toBe(false);

  // Under Done, with who answered it (core's fan-out closes Sam's notification).
  await expect
    .poll(
      async () => {
        await page.getByRole("tab", { name: "Done" }).click();
        const done = page.locator("[data-done-list] li").filter({ has: page.locator(`a[href="/tasks/${world.approval.taskId}"]`) });
        const shown = (await done.count()) > 0 ? ((await done.first().textContent()) ?? "") : "";
        if (shown === "") {
          await page.getByRole("tab", { name: "Open" }).click();
        }
        return shown;
      },
      { timeout: 30_000 },
    )
    .toContain("Approved once by");
});

test("F-062/c1,c3: the board groups Sam's tasks by state, one column each, with the project filter", { tag: "@desktop-only" }, async ({ page }) => {
  const waiting = approvalSchema.parse(await seed({ step: "approval", title: `Pin the lockfile ${tag}` }));
  await signIn(page, world.samUsername);
  // The toggle on Home turns the overview into the board.
  await page.getByRole("radio", { name: "Board" }).click();
  await page.waitForURL((url) => url.searchParams.get("view") === "board");
  await expect(page.locator("[data-board]")).toBeVisible();
  // The project filter, as the toolbar's picker writes it into the address.
  await page.goto(`/?view=board&project=${world.second.id}`);
  await expect(page.getByRole("combobox", { name: "Project" })).toHaveText(world.second.name);

  const column = (id: string): Locator => page.locator(`[data-board] section[data-column="${id}"]`);
  const card = (taskId: string): Locator => page.locator(`[data-card="${taskId}"]`);
  await expect(column("needs-you").locator(card(waiting.taskId))).toBeVisible();
  await expect(column("in-review").locator(card(world.inReviewTaskId))).toBeVisible();
  await expect(column("finished").locator(card(world.doneTaskId))).toBeVisible();
  // Each card in its one column only, and the other project's tasks filtered out.
  for (const taskId of [waiting.taskId, world.inReviewTaskId, world.doneTaskId]) await expect(card(taskId)).toHaveCount(1);
  await expect(card(world.approval.taskId)).toHaveCount(0);
  for (const id of ["needs-you", "in-review", "finished"]) await expect(column(id).locator("[data-count]")).not.toHaveText("0");
  await expect(column("queued").locator("[data-card]")).toHaveCount(0);
  await expect(column("running").locator("[data-card]")).toHaveCount(0);
});
