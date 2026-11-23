import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { z } from "zod";

import { readStack, signIn } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// F-152/c4, F-008/c6 (ticket-chips.md): every place a ticket shows says which tracker it's from: a
// Linear team and a Jira project on one project, both kinds' marks in the Inbox's rows with their
// connection in the tooltip, a Jira task's header, its Ticket group (Tracker, Status with Jira's
// category square, Sub-tasks) and its "On Jira" rows with the transition each move took, and the
// sidebar's line. `OSTRA_E2E_SHOTS` names a folder for the screenshots compared with the targets
// (app-targets/m11-trackers/ticket-chips*); without it none is taken. Run once, at the milestone's end.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const worldSchema = z.object({
  username: z.string(),
  /** A second organization with no tracker connection: Home's step 4 open, as `setup-checklist.md` draws it. */
  freshUsername: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  linearConnection: z.string(),
  jiraConnection: z.string(),
  jiraProjectName: z.string(),
});
type World = z.infer<typeof worldSchema>;

const seed = async (input: Record<string, unknown>): Promise<unknown> => {
  const stack = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-boards-mixed.ts"), JSON.stringify({ ...input, stack })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
};
const seedWorld = async (): Promise<World> => worldSchema.parse(await seed({ scenario: "chips", password: e2eAdmin.password, tag: `chips-${Date.now().toString(36)}` }));

/** The page in both themes at 1440, as the targets draw it. */
const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  await mkdir(shots, { recursive: true });
  await page.mouse.move(0, 0);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shots, `${name}-1440-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

/** The same pages at the phone width, in both themes. */
const shootPhone = async (browser: Browser, pages: readonly { readonly username: string; readonly name: string; readonly route: string }[]): Promise<void> => {
  if (shots === undefined) return;
  // One context for every page: each sign-in keeps its own cookie jar, so a second user clears them.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  let signedIn: string | null = null;
  for (const one of pages) {
    if (signedIn !== one.username) {
      await context.clearCookies();
      await signIn(page, one.username);
      signedIn = one.username;
    }
    await page.goto(one.route);
    await page.mouse.move(0, 0);
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(shots, `${one.name}-390-${theme}.png`) });
    }
  }
  await context.close();
};

test("F-152/c4, F-008/c6: a Linear and a Jira ticket each name their tracker in the Inbox, on the task's page and in the sidebar", { tag: "@desktop-only" }, async ({ page, browser }) => {
  test.setTimeout(180_000);
  const world = await seedWorld();
  await signIn(page, world.username);

  // The Inbox: each row's mark, in the key's colour, its tooltip naming the tracker and the connection.
  await page.goto(`/projects/${world.projectId}/inbox`);
  const linearRow = page.locator('[data-ticket="CALC-170"]');
  await expect(linearRow.locator('[data-tracker-mark="linear"]')).toBeVisible();
  await expect(linearRow.locator('[data-tracker-mark="linear"]')).toHaveAttribute("data-treatment", "mono");
  await expect(linearRow.locator('[title="Linear · Acme Linear"]')).toBeVisible();
  const jiraRow = page.locator('[data-ticket="PROJ-12"]');
  await expect(jiraRow.locator('[data-tracker-mark="jira"]')).toBeVisible();
  await expect(jiraRow.locator('[data-tracker-mark="jira"]')).toHaveAttribute("data-treatment", "mono");
  await expect(jiraRow.locator('[title="Jira · Globex Jira"]')).toBeVisible();
  // F-008/c6: the Jira parent counts its sub-tasks, in Jira's word.
  await expect(jiraRow.locator('[title="1 sub-task"]')).toBeVisible();
  await shoot(page, "ticket-chips-inbox");

  // A task's header: the brand mark, then `PROJ-12 · from Jira`.
  await page.goto(`/tasks/${world.taskId}`);
  const keyLine = page.getByTestId("task-key-line");
  await expect(keyLine.locator('[data-tracker-mark="jira"]')).toBeVisible();
  await expect(keyLine.locator('[data-tracker-mark="jira"]')).toHaveAttribute("data-treatment", "brand");
  await expect(keyLine).toContainText("PROJ-12 · from Jira");

  // The Ticket group: Tracker with its mark and connection, Status with Jira's category square,
  // Board, and Sub-tasks with its done share.
  const panel = page.getByTestId("task-properties");
  await expect(panel).toContainText("Tracker");
  await expect(panel).toContainText("Globex Jira");
  await expect(panel.locator('[data-tracker-mark="jira"]').first()).toBeVisible();
  await expect(panel.locator(".jira-cat-started")).toBeVisible();
  await expect(panel).toContainText("Sub-tasks");
  await expect(panel).toContainText("1 done");

  // The "On Jira" group: each write, the move's transition, and the remote link.
  await expect(panel).toContainText("On Jira");
  await expect(panel.getByTestId("sync-steps")).toContainText("Moved the ticket");
  await expect(panel.getByTestId("sync-steps")).toContainText("by Start progress");
  await expect(panel.getByTestId("sync-steps")).toContainText("remote link");
  await shoot(page, "ticket-chips-task");

  // The sidebar's live task: the mark, one colour, before the key.
  const live = page.locator(`[data-live-task="${world.taskId}"]`);
  await expect(live.locator('[data-tracker-mark="jira"]')).toBeVisible();
  await expect(live).toContainText("PROJ-12");

  // Search: the mark and the key, and the connection's name on the right.
  await page.goto("/search?q=Checkout");
  const result = page.getByTestId("search-result").first();
  await expect(result.locator('[data-tracker-mark="jira"]')).toBeVisible();
  await expect(result).toContainText("PROJ-12");
  await expect(result).toContainText("Globex Jira");

  // New task: the board's tracker in its brand colour, before its name.
  await page.goto(`/tasks/new?project=${world.projectId}`);
  const next = page.getByTestId("next-ticket");
  await expect(next).toBeVisible();
  await expect(next.locator('[data-tracker-mark="jira"]')).toBeVisible();
  await expect(next).toContainText(world.jiraProjectName);

  // Home's step 4 (setup-checklist.md): a fresh organization, three steps done, `Connect a tracker`
  // the next one with both marks, `Skip for now` and the one primary button to Trackers.
  await page.context().clearCookies();
  await signIn(page, world.freshUsername);
  await page.goto("/");
  const trackerStep = page.locator('[data-step="tracker"]');
  await expect(trackerStep).toContainText("Connect a tracker");
  await expect(trackerStep).toHaveAttribute("data-next", "true");
  await expect(trackerStep.locator('[data-tracker-mark="linear"]')).toBeVisible();
  await expect(trackerStep.locator('[data-tracker-mark="jira"]')).toBeVisible();
  await expect(trackerStep.getByRole("button", { name: "Skip for now" })).toBeVisible();
  await expect(trackerStep.getByRole("link", { name: "Connect a tracker", exact: true })).toHaveAttribute("href", "/organization/trackers");
  await shoot(page, "setup-checklist");

  await shootPhone(browser, [
    { username: world.username, name: "ticket-chips-inbox", route: `/projects/${world.projectId}/inbox` },
    { username: world.username, name: "ticket-chips-task", route: `/tasks/${world.taskId}` },
    { username: world.freshUsername, name: "setup-checklist", route: "/" },
  ]);
});
