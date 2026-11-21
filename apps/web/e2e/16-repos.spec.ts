import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { ensureGitHub, expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";
import { e2eAdmin, e2eRepo } from "./settings.ts";

// F-098, F-104 (ticket 39): several repos in the panel, on the fake GitHub (`stack.ts`: one
// installation reaching `test1` and `test2`). The projects are made through New project and the
// repos page; the tasks with branches and PRs are seeded (`seed-repos-world.ts`).

const run = promisify(execFile);
const cwd = path.resolve(import.meta.dirname, "..");
const repo1 = `${e2eRepo.owner}/test1`;
const repo2 = `${e2eRepo.owner}/test2`;

/** New project with these repos, in this order; returns its ID. */
const createProject = async (page: Page, name: string, repos: readonly string[]): Promise<string> => {
  await page.goto("/projects/new");
  for (const repo of repos) await page.getByRole("checkbox", { name: new RegExp(repo) }).check();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create the project" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/environment/);
  return new URL(page.url()).pathname.split("/")[2] ?? "";
};

const order = (page: Page) => page.getByTestId("project-repos").locator("li[data-repo]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-repo")));

let projectId: string | null = null;

test.describe.configure({ mode: "serial" });

test("F-098/c3: a project admin adds a second repo and reorders", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  await ensureGitHub(page);
  const suffix = Date.now().toString(36);

  // A project made with two repos keeps them in the order they were picked.
  const both = await createProject(page, `both-${suffix}`, [repo2, repo1]);
  await page.goto(`/projects/${both}/settings/repos`);
  await expect.poll(() => order(page)).toEqual([repo2, repo1]);

  // A project with one repo; its admin adds the second from the App's repos.
  projectId = await createProject(page, `repos-${suffix}`, [repo1]);
  await page.goto(`/projects/${projectId}/repos`);
  await page.waitForURL(/\/settings\/repos$/);
  await expect.poll(() => order(page)).toEqual([repo1]);
  await page.getByTestId("add-repo").click();
  await page.getByRole("option", { name: new RegExp(repo2) }).click();
  await expect.poll(() => order(page)).toEqual([repo1, repo2]);
  await expect(page.locator(`li[data-repo="${repo2}"]`).getByTestId("repo-position")).toHaveText("2");

  // The keyboard way: the second repo's handle, ↑. The order is saved.
  await page.locator(`li[data-repo="${repo2}"]`).getByTestId("repo-handle").focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => order(page)).toEqual([repo2, repo1]);
  await page.reload();
  await expect.poll(() => order(page)).toEqual([repo2, repo1]);
  await page.locator(`li[data-repo="${repo1}"]`).getByTestId("repo-select").click();
  await expect(page.getByTestId("project-repo-panel")).toContainText("2 of 2");
});

test("F-098/c3, F-104/c7: a removal of a repo in use is refused with the task named", { tag: "@desktop-only" }, async ({ page }) => {
  expect(projectId).not.toBeNull();
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-repos-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, projectId })], { cwd });
  const world = z.object({ workingTaskId: z.string(), bothTaskId: z.string() }).parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
  await signIn(page);
  await page.goto(`/projects/${projectId ?? ""}/settings/repos?repo=`);
  const row = page.locator(`li[data-repo="${repo2}"]`);
  await expect(row.getByTestId("repo-use")).toHaveText("In use by 2 tasks");
  await row.getByTestId("repo-select").click();
  const panel = page.getByTestId("project-repo-panel");
  await expect(panel.getByTestId("repo-tasks")).toContainText("Parse negative exponents");
  await panel.getByTestId("remove-repo").click();
  // It asks first (project-repos.md, "Remove: the confirmation").
  await page.getByRole("button", { name: "Remove repo" }).click();
  const refused = panel.getByTestId("remove-refused");
  await expect(refused).toContainText("Not removed");
  await expect(refused).toContainText("Parse negative exponents");
  await expect.poll(() => order(page)).toEqual([repo2, repo1]);

  // F-104: the task with a PR in each repo shows both in its header, each with its check.
  await page.goto(`/tasks/${world.bothTaskId}`);
  const prs = page.getByTestId("task-pr");
  await expect(prs).toHaveCount(2);
  const first = page.locator(`[data-testid="task-pr"][data-repo="${repo1}"]`);
  const second = page.locator(`[data-testid="task-pr"][data-repo="${repo2}"]`);
  await expect(first).toContainText("#12");
  await expect(first.getByTestId("review-check")).toHaveText("Only drivers approved");
  await expect(first.getByTestId("review-check")).toHaveAttribute("data-state", "waiting");
  await expect(second).toContainText("#7");
  await expect(second.getByTestId("review-check")).toHaveText("Approved by repos-sam");
  await expect(second.getByTestId("review-check")).toHaveAttribute("data-state", "passed");
});

test("F-104/c7, F-098/c3: a task with two PRs shows both with their check states, at phone width too", async ({ page }) => {
  await signIn(page);
  const { databaseUrl } = await readStack();
  // The phone project runs after the desktop one: the newest project its first case made.
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-repos-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, ...(projectId === null ? {} : { projectId }) })], { cwd });
  const world = z.object({ bothTaskId: z.string() }).parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
  await page.goto(`/tasks/${world.bothTaskId}`);
  await expect(page.getByTestId("task-pr")).toHaveCount(2);
  await expect(page.getByTestId("review-check")).toHaveText(["Only drivers approved", "Approved by repos-sam"]);
  await expectNoHorizontalScroll(page);
});
