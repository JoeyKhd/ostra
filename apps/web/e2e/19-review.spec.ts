import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { ensureGitHub, expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";
import { e2eRepo } from "./settings.ts";

// F-102, F-100, F-101, F-035, F-111 (milestone 6's ticket 35): the review screen, the task's
// rounds and a project's Review settings, on the fake GitHub. The project is made through New
// project on `test1`; the rows the review loop leaves after a CI round and a findings round are
// seeded as core writes them (`seed-review-world.ts`: the reviewing fake's nit open, round 1's
// blocking finding resolved), since this stack runs no agent. Everything after goes through the
// pages: "Fix this" and "Send to agent", "Remember this", "Keep working" at the CI round limit, and
// the AI review switch. `OSTRA_E2E_SHOTS` names a folder for the screenshots compared with the
// targets (app-targets/m6/review-screen.webp, task-rounds.webp, review-settings.webp). A review
// waiting for a runner (`seed-follow-up-world.ts`, 2026-11-21) says what it reviews and why it
// waits, its code task says so too, and the Live list holds it under its code task.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];
const worldSchema = z.object({ taskId: z.string(), cappedTaskId: z.string(), findingId: z.string(), taskRepoId: z.string(), logFile: z.string() });
type World = z.infer<typeof worldSchema> & { readonly projectId: string };

const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  const phone = (page.viewportSize()?.width ?? 1440) < 600;
  await page.mouse.move(0, 0);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.screenshot({ path: path.join(shots, `m6-${name}${phone ? "-phone" : ""}-${theme}-final.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

/** A project on the fake GitHub's test1, through New project, and the review loop's rows in it. */
const seedWorld = async (page: Page): Promise<World> => {
  await ensureGitHub(page);
  await page.goto("/projects/new");
  await page.getByRole("checkbox", { name: new RegExp(`${e2eRepo.owner}/test1`) }).check();
  await page.getByLabel("Name", { exact: true }).fill(`calc-review-${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Create the project" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/environment/);
  const projectId = new URL(page.url()).pathname.split("/")[2] ?? "";
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-review-world.ts"), JSON.stringify({ databaseUrl, projectId })], { cwd: path.resolve(import.meta.dirname, "..") });
  return { ...worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")), projectId };
};

test("F-102/c1,c4, F-111/c1, F-035/c1: a reviewer reads the PR with its findings and CI, Fix this and Send to agent send it as one prompt, and Remember this proposes it", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const world = await seedWorld(page);

  // The task page: the status line (milestone 10, ticket 15: no stage strip since ticket 17), the
  // rounds in the thread and the panel.
  await page.goto(`/tasks/${world.taskId}`);
  const doing = page.getByTestId("task-doing");
  await expect(doing).toContainText("In review · waiting for a reviewer");
  await expect(doing.locator("[data-part='status-place']")).toHaveText("PR #12");
  await expect(page.getByTestId("rounds-group")).toContainText("2 of 4");
  // Milestone 10 (ticket 12): each round is its message's outlined bubble in the thread, ostra's own.
  const rounds = page.locator('[data-part="thread-column"]');
  await expect(rounds.locator('[data-part="bubble"][data-round="ci"]')).toContainText("CI round 1 of 2");
  await expect(rounds.locator(`[data-part="bubble"][data-round="ci"] [data-log="${world.logFile}"]`)).toHaveCount(1);
  await expect(rounds.locator('[data-part="bubble"][data-round="findings"]')).toContainText("Sent 1 blocking finding: Read the version at build time.");
  await expect(page.getByTestId("rounds-group")).toContainText("2 of 4");
  await shoot(page, "task-rounds-review");

  // The Checks tab: the code host's CI on the PR's head.
  await page.goto(`/tasks/${world.taskId}?tab=checks`);
  await expect(page.getByTestId("code-host-ci").locator('[data-check="build"]')).toHaveAttribute("data-conclusion", "success");

  // The review screen: the reviewer's own wait in amber words, the findings on their lines, the
  // criteria panel. Milestone 10 (ticket 17) took the top bar's Review button: the screen is the
  // task's own route, linked from a review's result line.
  await page.goto(`/tasks/${world.taskId}/review`);
  await expect(page.getByTestId("review-screen")).toBeVisible();
  await expect(page.getByTestId("review-round-line")).toContainText("Waiting for your review");
  await expect(page.getByTestId("review-round-line")).toContainText("CI passed");
  await expect(page.getByTestId("review-round-line")).toContainText("AI review round 2: nothing blocking");
  const open = page.locator(`[data-finding="${world.findingId}"]`);
  await expect(open).toContainText("An unused import");
  await expect(open).toHaveAttribute("data-state", "open");
  await expect(page.locator('[data-finding][data-state="resolved"]')).toContainText("Read the version at build time");
  await expect(page.getByTestId("review-reviewers")).toContainText("Requested");
  await expect(page.getByTestId("review-reviewers")).toContainText("Team · CODEOWNERS");
  await expect(page.locator('[data-action="open-on-github"]')).toHaveAttribute("href", /\/pull\/12\/files$/);
  await shoot(page, "review-screen");

  // Fix this: the finding joins the reviewer's drafts on its line; Send to agent sends them as one message.
  await open.locator('[data-action="fix-this"]').click();
  await expect(open.getByTestId("finding-fixed")).toHaveText("Added to your drafts");
  await expect(page.getByText("1 draft comment")).toBeVisible();
  await page.getByRole("button", { name: /^Send/ }).click();
  await expect(page.getByText(/Sent 1 comment/)).toBeVisible();

  // Remember this: one proposal, sourced by the finding.
  await open.locator('[data-action="remember-finding"]').click();
  await expect(open.getByTestId("finding-proposed")).toContainText("memory");
  await open.getByRole("link", { name: "See it" }).click();
  await page.waitForURL(/\/memory\/proposals/);
  await expect(page.getByText("An unused import").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});

const followUpSchema = z.object({ codeTaskId: z.string(), reviewTaskId: z.string(), runner: z.string() });

test("F-100/c6, F-147/c8: a review waiting for a runner says what it reviews, why it waits and where it may run, and sits under its code task", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const world = await seedWorld(page);
  // A code task that ran on the admin's laptop, now offline, and the AI review it waits on (`seed-follow-up-world.ts`).
  const { databaseUrl } = await readStack();
  const title = `Add a simple index.html ${Date.now().toString(36)}`;
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-follow-up-world.ts"), JSON.stringify({ databaseUrl, projectId: world.projectId, personal: true, title })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  const followUp = followUpSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));

  // The review's page: the task and PR it reviews (milestone 10, ticket 15: its key line, its title and
  // its top bar's `Open the code task` and `PR #14`), and why it waits, with the way out.
  await page.goto(`/tasks/${followUp.reviewTaskId}`);
  await expect(page.getByTestId("task-key-line")).toContainText("· AI review");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review of PR #14");
  const codeTask = page.locator("header [data-action='open-code-task']");
  await expect(codeTask).toHaveAttribute("href", `/tasks/${followUp.codeTaskId}`);
  await expect(codeTask).toHaveAttribute("title", new RegExp(`${title}$`));
  await expect(page.locator("header").getByRole("link", { name: "PR #14" })).toHaveCount(1);
  const waiting = page.getByTestId("follow-up-waiting");
  await expect(waiting).toContainText("Waiting for a runner.");
  await expect(waiting).toContainText(`AI review runs on ${followUp.runner}, the runner its code task ran on, or on one of`);
  await expect(waiting.locator('[data-action="connect-runner"]')).toHaveAttribute("href", "/organization/runners");
  // The pools' place and reason aren't said again under it.
  await expect(page.getByTestId("task-wait-line")).toHaveCount(0);
  // The Live list: the review under its code task, with its tag, never a row of its own.
  if ((page.viewportSize()?.width ?? 1440) >= 1280) {
    await expect(page.locator(`[data-live-task="${followUp.codeTaskId}"]`)).toContainText(title);
    await expect(page.locator(`[data-live-task="${followUp.reviewTaskId}"]`)).toHaveAttribute("data-follow-up", "review");
    await expect(page.locator(`[data-live-task="${followUp.reviewTaskId}"]`)).not.toContainText(`Review: ${title}`);
  }

  // Its code task's page: the AI review's state at the end of the thread, linking back to it.
  await waiting.getByRole("link", { name: "Open the code task" }).click();
  await page.waitForURL(new RegExp(`/tasks/${followUp.codeTaskId}$`));
  const line = page.getByTestId("ai-review-line");
  await expect(line).toHaveAttribute("data-state", "waiting");
  await expect(line).toContainText("AI review: waiting for a runner");
  await line.getByRole("link", { name: "Open the review task" }).click();
  await page.waitForURL(new RegExp(`/tasks/${followUp.reviewTaskId}$`));
  await expectNoHorizontalScroll(page);
});

test("F-101/c4: at the CI round limit the driver sees the cap and Keep working sends the agent on", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  const world = await seedWorld(page);
  await page.goto(`/tasks/${world.cappedTaskId}`);
  const cap = page.getByTestId("round-cap");
  await expect(cap).toHaveAttribute("data-cap", "ci");
  await expect(cap).toContainText("Needs you · CI round limit");
  await expect(cap).toContainText("e2e still fails");
  await expect(page.getByTestId("task-doing")).toContainText("Needs you · round limit");
  await expect(page.locator('[data-part="thread-column"] [data-part="bubble"][data-round="ci"]')).toHaveCount(2);
  await shoot(page, "task-rounds");
  await cap.locator('[data-action="keep-working"]').click();
  await expect(cap).toHaveCount(0);
  await expect(page.getByTestId("rounds-group")).toContainText("0 of 2");
});

test("F-100/c5: a project admin turns the AI review off and on; the limits and each repo's CI show", async ({ page }) => {
  await signIn(page);
  const world = await seedWorld(page);
  await page.goto(`/projects/${world.projectId}/settings/review`);
  const settings = page.getByTestId("review-settings");
  await expect(settings.locator('[data-limit="OSTRA_CI_ROUNDS"]')).toContainText("2");
  await expect(settings.locator('[data-limit="OSTRA_AUTOMATIC_TURNS"]')).toContainText("4");
  await expect(settings.getByTestId("ci-seen").locator("li").first()).toHaveAttribute("data-ci", /failed|passed/);
  const toggle = page.getByTestId("ai-review-switch");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await shoot(page, "review-settings");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(settings.getByRole("status")).toContainText("Off. Open pull requests go straight to their reviewers after CI.");
  await expect(settings.locator('[data-limit="OSTRA_REVIEW_ROUNDS"]')).toContainText("not used while AI review is off");
  await page.reload();
  await expect(page.getByTestId("ai-review-switch")).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("ai-review-switch").click();
  await expect(page.getByTestId("ai-review-switch")).toHaveAttribute("aria-checked", "true");
  await expectNoHorizontalScroll(page);
});
