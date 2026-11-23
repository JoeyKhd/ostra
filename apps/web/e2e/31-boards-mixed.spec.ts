import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import { z } from "zod";

import { hydrated, readStack, signIn } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// F-152/c4, F-008/c5, F-008/c7, F-152/c5 (boards-mixed.md): a project's Boards with a Linear team
// and a Jira project from two connections, through the panel, the API, the domain and the database,
// with the stack's fake Linear and fake Jira as the organization's two connections. The Jira board's
// mapping shows its workflow's transitions and the statuses no route leaves; Done is moved by
// switches to Jira automation; a disconnected connection's board is paused and reads only.
// `OSTRA_E2E_SHOTS` names a folder for the screenshots compared with the targets
// (app-targets/m11-trackers/boards-mixed*); without it none is taken.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const worldSchema = z.object({
  username: z.string(),
  projectId: z.string(),
  linearConnectionId: z.string(),
  jiraConnectionId: z.string(),
  linearTeam: z.object({ name: z.string(), key: z.string(), externalId: z.string() }),
  jiraProject: z.object({ name: z.string(), key: z.string(), externalId: z.string() }),
});
type World = z.infer<typeof worldSchema>;

const seed = async (input: Record<string, unknown>): Promise<unknown> => {
  const stack = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-boards-mixed.ts"), JSON.stringify({ ...input, stack })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
};
const seedWorld = async (): Promise<World> => worldSchema.parse(await seed({ scenario: "world", password: e2eAdmin.password, tag: `bm-${Date.now().toString(36)}` }));
const setJiraConnection = async (state: "active" | "failed"): Promise<void> => { await seed({ scenario: "connection", state }); };

const openBoards = async (page: Page, projectId: string): Promise<void> => {
  await page.goto(`/projects/${projectId}/boards`);
  await expect(page.getByRole("heading", { name: "Boards" })).toBeVisible();
  await hydrated(page.getByRole("combobox", { name: "Attach" }));
};

const attach = async (page: Page, name: string): Promise<void> => {
  await page.getByRole("combobox", { name: "Attach" }).click();
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(page.getByTestId("boards")).toContainText(name);
};

const rowOf = (page: Page, name: string): Locator => page.getByTestId("boards").getByRole("button", { name: new RegExp(name) });

/** The page in both themes at 1440 and 390, as the targets draw it. */
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

const shootPhone = async (browser: Browser, username: string, projectId: string): Promise<void> => {
  if (shots === undefined) return;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await signIn(page, username);
  await page.goto(`/projects/${projectId}/boards`);
  await expect(page.getByTestId("boards")).toBeVisible();
  await page.mouse.move(0, 0);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shots, `boards-mixed-390-${theme}.png`) });
  }
  await context.close();
};

test("F-152/c4, F-008/c5, F-008/c7: a Linear team and a Jira project from two connections attach to one project, each row with its mark; the Jira mapping shows its transitions and unreachable status, and Done is moved by switches to Jira automation", { tag: "@desktop-only" }, async ({ page, browser }) => {
  test.setTimeout(180_000);
  const world = await seedWorld();
  await signIn(page, world.username);
  await openBoards(page, world.projectId);

  // Both connections' boards are in the one picker, grouped by connection.
  await page.getByRole("combobox", { name: "Attach" }).click();
  await expect(page.getByRole("option", { name: new RegExp(`^${world.linearTeam.name}`) })).toBeVisible();
  await expect(page.getByRole("option", { name: new RegExp(`^${world.jiraProject.name}`) })).toBeVisible();
  await expect(page.getByText("Acme Linear")).toBeVisible();
  await expect(page.getByText("Globex Jira")).toBeVisible();
  await page.keyboard.press("Escape");

  await attach(page, world.linearTeam.name);
  // The picker, grouped by connection, before the second board leaves it nothing to attach.
  await page.getByRole("combobox", { name: "Attach" }).click();
  await shoot(page, "boards-attach");
  await page.keyboard.press("Escape");
  await attach(page, world.jiraProject.name);

  // F-152/c4: each row carries its tracker's mark and its connection's name.
  const rows = page.getByTestId("boards");
  await expect(rows.locator('[data-tracker-mark="linear"]')).toHaveCount(1);
  await expect(rows.locator('[data-tracker-mark="jira"]')).toHaveCount(1);
  await expect(rows).toContainText("Acme Linear · team");
  await expect(rows).toContainText("Globex Jira · project");

  // F-008/c5: the Jira board's mapping names each step's transition, and the status no route leaves.
  await rowOf(page, world.jiraProject.name).click();
  const mapping = page.getByTestId("mapping");
  await expect(mapping).toContainText("by Start progress, from Backlog or To Do");
  await expect(mapping).toContainText("by Ready for review, from In Progress");
  await expect(mapping).toContainText("No transition reaches Done from Won't Do. A ticket there stays put, and ostra says so in its comment.");
  await expect(mapping).toContainText("Workflow in Jira");
  await expect(page.getByTestId("board-properties")).toContainText("Workflow for PROJ");

  // F-008/c7: Done is moved by switches to Jira automation, and its line shows; Save mapping keeps it.
  await page.getByRole("radio", { name: "Jira automation" }).click();
  await expect(page.getByTestId("jira-automation")).toContainText("ostra won't move PROJ tickets to Done.");
  await page.getByRole("button", { name: "Save mapping" }).click();
  await expect(page.getByText("Mapping saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("radio", { name: "Jira automation" })).toHaveAttribute("aria-checked", "true");

  await shoot(page, "boards-mixed");
  await shootPhone(browser, world.username, world.projectId);
});

test("F-152/c5: a disconnected connection's board is paused, read only, with its line and link", { tag: "@desktop-only" }, async ({ page }) => {
  test.setTimeout(180_000);
  const world = await seedWorld();
  await signIn(page, world.username);
  await openBoards(page, world.projectId);
  await attach(page, world.jiraProject.name);

  await setJiraConnection("failed");
  await page.reload();
  const row = page.getByTestId("boards").locator('[data-paused="true"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Connection failed");
  await expect(row).toContainText("Globex Jira · project");
  const pause = page.getByTestId("board-pause");
  await expect(pause).toContainText("Globex Jira failed on");
  await expect(pause).toContainText("nothing moves on Jira");
  await expect(pause.getByRole("link", { name: "Reconnect on Trackers" })).toHaveAttribute("href", "/organization/trackers");

  // Its mapping reads only: no picker, and the tracker isn't asked for a workflow.
  await expect(page.getByTestId("mapping").getByRole("combobox")).toHaveCount(0);
  await expect(page.getByTestId("mapping")).toContainText("Started");

  await setJiraConnection("active");
});

test("boards-mixed.md: on a phone each board is a card and the mapping stacks", async ({ page }) => {
  test.setTimeout(180_000);
  const world = await seedWorld();
  await signIn(page, world.username);
  await openBoards(page, world.projectId);
  await attach(page, world.linearTeam.name);
  await attach(page, world.jiraProject.name);

  const rows = page.getByTestId("boards");
  await expect(rows).toContainText("Acme Linear · team");
  await expect(rows).toContainText("Globex Jira · project");
  await rowOf(page, world.jiraProject.name).click();
  await expect(page.getByTestId("mapping")).toContainText("by Start progress, from Backlog or To Do");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
