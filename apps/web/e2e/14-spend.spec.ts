import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import { z } from "zod";

import { ensureGitHub, expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";

// F-037 (ticket 36): spend and budgets in the panel. The project, its $50.00 of spend this month and
// an idle task are seeded (`seed-budget-world.ts`); core runs in the stack, so the dispatch, the gate
// and the release are its own. No runner is connected: after the release the new task waits for a
// runner, and the held message's steer is handed to the (seeded) runner's outbox.

const run = promisify(execFile);
const cwd = path.resolve(import.meta.dirname, "..");

const seededSchema = z.object({ projectId: z.string(), idleTaskId: z.string(), modelId: z.string() });
const factsSchema = z.object({
  state: z.string(),
  dispatchWait: z.unknown(),
  held: z.array(z.object({ origin: z.string(), released: z.boolean() })),
});

const seed = async (): Promise<z.infer<typeof seededSchema>> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-budget-world.ts"), JSON.stringify({ databaseUrl })], { cwd });
  return seededSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

const readBudget = async (taskId: string): Promise<z.infer<typeof factsSchema>> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "read-budget.ts"), JSON.stringify({ databaseUrl, taskId })], { cwd });
  return factsSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date());

test.describe.configure({ mode: "serial" });

test("F-037/c1,c4: an admin sets a project budget below the spend, a new task in it shows the reason before Start, a message to an idle task shows as held, and raising the budget starts both", { tag: "@desktop-only" }, async ({ page }) => {
  test.setTimeout(150_000);
  await signIn(page);
  // The seeded repo joins the stack's GitHub connection, never a stand-in one later specs would trip on.
  await ensureGitHub(page);
  const world = await seed();

  // Spend: the project's month from the rollup, with no budget yet.
  await page.goto("/organization/spend");
  await expect(page.getByRole("heading", { level: 1, name: "Spend" })).toBeVisible();
  const row = page.locator('tr[data-project="budgets"]');
  await expect(row.getByTestId("project-spent")).toHaveText("$50.00");
  await expect(row).toContainText("No budget");

  // A budget of $10.00, below the $50.00 spent: the form says so, and the save reaches it at once.
  await row.click();
  const form = page.getByTestId("budget-form");
  await expect(form).toContainText("Project budget");
  await form.getByLabel("Monthly budget").fill("10");
  await expect(form.getByTestId("budget-below")).toContainText("$50.00");
  await form.getByRole("button", { name: "Save budget" }).click();
  await expect(row.getByTestId("budget-status")).toContainText("Reached", { timeout: 15_000 });
  await expect(row.getByTestId("project-share")).toHaveText("500%");
  await expect(form.getByTestId("budget-status-line")).toContainText("new tasks and turns wait");

  // New task: the reason shows before Start, and the task still starts, queued at the gate.
  await page.goto("/tasks/new");
  await page.getByTestId("pick-project").click();
  await page.getByRole("listbox", { name: "Pick the project" }).getByRole("button", { name: "budgets", exact: true }).click();
  const reason = page.getByTestId("budget-reason");
  await expect(reason).toContainText(`budgets’s budget for ${MONTH} is reached.`);
  await expect(reason).toContainText("The task starts queued");
  await page.getByLabel("Prompt").fill("Add a docs/budget.md that says what a budget is");
  await expect(page.locator('[data-action="start-task"]')).toHaveAttribute("aria-describedby", "new-task-budget-wait");
  await page.locator('[data-action="start-task"]').click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  const newTaskId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  // Core's dispatch runs the gate: the task waits, queued, with the budget's reason.
  await expect(page.getByTestId("task-budget-wait")).toContainText(`budgets’s budget for ${MONTH} is reached`, { timeout: 30_000 });
  await expect.poll(async () => (await readBudget(newTaskId)).dispatchWait, { timeout: 15_000 }).toMatchObject({ code: "budget-reached", scope: "project" });

  // A message to the idle task: saved, and held, with the held row in the thread.
  await page.goto(`/tasks/${world.idleTaskId}`);
  await page.getByLabel("Message the agent").fill("Also add a line about tests");
  await page.locator('[data-action="send"]').click();
  await expect(page.getByTestId("message-held")).toHaveText("Held", { timeout: 15_000 });
  await expect(page.locator('[data-part="held"]')).toContainText(`Held: budgets’s budget for ${MONTH} is reached`);
  expect((await readBudget(world.idleTaskId)).held).toEqual([{ origin: "message", released: false }]);

  // The panel's Waiting group counts both; a raise above the spend lets them go.
  await page.goto(`/organization/spend?project=${world.projectId}`);
  const raise = page.getByTestId("budget-form");
  await expect(raise.getByTestId("budget-held")).toHaveText("1");
  await expect(raise.getByTestId("budget-queued")).toHaveText("1");
  await raise.getByLabel("Monthly budget").fill("1000");
  await expect(raise).toContainText("5% used");
  await raise.getByRole("button", { name: "Save budget" }).click();
  await expect(page.locator('tr[data-project="budgets"]').getByTestId("budget-status")).toHaveText("–", { timeout: 15_000 });

  // Core's release: the held message's turn goes (its steer to the runner), and the thread says so.
  await expect.poll(async () => (await readBudget(world.idleTaskId)).held, { timeout: 30_000 }).toEqual([{ origin: "message", released: true }]);
  await page.goto(`/tasks/${world.idleTaskId}`);
  await expect(page.locator('[data-part="released"]')).toContainText("Released");
  await expect(page.getByTestId("message-held")).toHaveCount(0);
  // The waiting task is offered again: it no longer waits for the budget, only for a runner.
  await expect.poll(async () => JSON.stringify((await readBudget(newTaskId)).dispatchWait), { timeout: 30_000 }).not.toContain("budget-reached");
  await page.goto(`/tasks/${newTaskId}`);
  await expect(page.getByTestId("task-budget-wait")).toHaveCount(0);
});

test("F-037/c1: Spend reads at phone width with no sideways scroll, and the project page shows its month", async ({ page }) => {
  await signIn(page);
  await ensureGitHub(page);
  const world = await seed();
  await page.goto("/organization/spend");
  await expect(page.getByTestId("spend-summary")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.goto(`/projects/${world.projectId}`);
  const viewport = page.viewportSize();
  if (viewport !== null && viewport.width >= 1280) {
    await expect(page.getByTestId("project-spend-month")).toHaveText("$50.00");
  }
});
