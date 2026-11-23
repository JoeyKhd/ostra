import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { z } from "zod";

import { readStack, signIn } from "./helpers.ts";
import { settleRoute } from "./routes.ts";
import { e2eAdmin } from "./settings.ts";

// Milestone 10, ticket 15 (F-151/c7, F-151/c9): a review task's page and the status line, on the
// targets' recorded scenes that `seed-thread-world.ts` writes into the stack's database. S3, the AI
// review of PR #483: only the Activity and Event log tabs, `Open the code task` and `PR #483` in the
// top bar and nothing of a code task's (no Take it local, Changes, Checks, Stop or PR line), its key
// line `CALC-192 · AI review` and its title `Review of PR #483`, and the status line's round and
// `box released`. S2, a code task in review with its box idle: its tabs and top bar as before, and
// its status line `In review · CI running · PR #483 · box idle, stops in 11 min`. S1 mid-turn: the
// activity and `Started … on build-fleet-03`, no box words. Each page shows its scene at the scene's
// own moment, in UTC. `OSTRA_E2E_SHOTS` names a folder for the screenshots compared with the targets
// (`app-targets/m10-thread/s3`, `s7-s3-light`, `s2`), at 1440 × 956 in both themes and at 390 × 844.
// Run once, at the milestone's end.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

const sceneNames = ["s1-working", "s1", "s2", "s3", "s5-plan", "s5-approved"] as const;
type SceneName = (typeof sceneNames)[number];
const worldSchema = z.object({
  username: z.string(),
  tasks: z.record(z.enum(sceneNames), z.string()),
  now: z.record(z.enum(sceneNames), z.number()),
});
type World = z.infer<typeof worldSchema>;

/** A plain picture for the seed's files: this spec reads none of them. */
const takePictures = async (browser: Browser): Promise<{ readonly mock: string; readonly desktop: string; readonly phone: string }> => {
  const folder = await mkdtemp(path.join(tmpdir(), "ostra-e2e-review-task-"));
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();
  const png = async (name: string, width: number, height: number): Promise<string> => {
    await page.setViewportSize({ width, height });
    await page.setContent(`<body style="margin:0;background:#f4f5f8;font:14px system-ui"><p style="padding:16px">Tally</p></body>`);
    const file = path.join(folder, `${name}.png`);
    await writeFile(file, await page.screenshot({ type: "png" }));
    return file;
  };
  const pictures = { mock: await png("mock", 1440, 900), desktop: await png("desktop", 1280, 800), phone: await png("phone", 390, 844) };
  await context.close();
  return pictures;
};

let world: World;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const { databaseUrl } = await readStack();
  const files = { ...(await takePictures(browser)), docx: path.join(repoRoot, "e2e", "m9-attachments", "fixtures", "history-panel-spec.docx") };
  const tag = `m10r-${Date.now().toString(36)}`;
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-thread-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, tag, files })], { cwd: path.resolve(import.meta.dirname, "..") });
  world = worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
});

// The scenes' top bar and status line are the desktop's; the phone draws its own in ticket 17.
test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "a desktop check");
});

/** A scene's task page at the scene's own moment, in UTC as the targets draw it. */
const openScene = async (browser: Browser, scene: SceneName, search = ""): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 956 }, timezoneId: "UTC" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(world.now[scene]));
  await signIn(page, world.username, e2eAdmin.password);
  await page.goto(`/tasks/${world.tasks[scene]}${search}`);
  await settleRoute(page);
  await page.locator("[data-part='thread-column'] [data-message-id]").first().waitFor();
  return page;
};

/** The page in both themes, and on a phone, for the by-eye check against the targets. */
const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  // `next dev`'s badge, when the stack serves the panel that way (OSTRA_E2E_DEV): the build has none.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.mouse.move(0, 0);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shots, `m10-review-${name}-${theme}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, `m10-review-${name}-phone-${theme}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 956 });
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

const topBar = (page: Page) => page.locator("header").first();
const tabNames = (page: Page) => page.getByRole("tablist").first().getByRole("tab");

test("F-151/c7: S3: a review task has only Activity and Event log, Open the code task and PR #483, its key line and title, and nothing of a code task's", async ({ browser }) => {
  const page = await openScene(browser, "s3");
  // The key line, the title and the crumb name what it reviews.
  await expect(page.getByTestId("task-key-line")).toHaveText("CALC-192 · AI review");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review of PR #483");
  await expect(topBar(page).locator("[aria-current='page']")).toHaveText("Review of PR #483");
  // Exactly two tabs.
  await expect(tabNames(page)).toHaveText([/^Activity/, /^Event log/]);
  // The top bar: copy link, Properties (one toggle, on), Open the code task, PR #483; no Take it local or Stop.
  const bar = topBar(page);
  await expect(bar.locator("[data-action='copy-link']")).toBeVisible();
  await expect(bar.locator("[data-action='properties-toggle']")).toHaveAttribute("aria-pressed", "true");
  await expect(bar.getByTestId("side-pane-toggle")).toHaveCount(0);
  const codeTask = bar.locator("[data-action='open-code-task']");
  await expect(codeTask).toHaveText("Open the code task");
  await expect(codeTask).toHaveAttribute("href", `/tasks/${world.tasks.s2}`);
  await expect(codeTask).toHaveAttribute("title", "CALC-192 Add a history panel");
  await expect(bar.getByRole("link", { name: "PR #483" })).toHaveAttribute("href", /\/pull\/483$/);
  await expect(bar.getByRole("button", { name: "Take it local" })).toHaveCount(0);
  await expect(bar.locator("[data-action='stop']")).toHaveCount(0);
  await expect(bar.locator("[data-action='open-review']")).toHaveCount(0);
  // No line of a code task's work: no PR line (milestone 10 took the header's, ticket 17), no
  // "Reviews …" line, no read-only note.
  await expect(page.locator("[data-part='status-place']")).toHaveCount(0);
  await expect(page.getByTestId("review-of")).toHaveCount(0);
  await expect(page.getByTestId("task-read-only")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("Ended without changes");
  // The composer reopens the review on a fresh box.
  await expect(page.locator("[data-part='composer'] textarea")).toHaveAttribute("placeholder", "Message OpenCode to reopen the review…");
  await expect(page.locator("[data-part='composer-under']")).toContainText("Send reopens the review on a fresh box.");
  await shoot(page, "s3");

  // Properties is one toggle: off hides the panel, on shows it again.
  await bar.locator("[data-action='properties-toggle']").click();
  await expect(bar.locator("[data-action='properties-toggle']")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("complementary", { name: "Properties" })).toHaveCount(0);
  await bar.locator("[data-action='properties-toggle']").click();
  await expect(page.getByRole("complementary", { name: "Properties" })).toBeVisible();
  await page.context().close();

  // A `?tab=` naming a tab a review hasn't opens Activity.
  for (const tab of ["changes", "checks", "draft"]) {
    const named = await openScene(browser, "s3", `?tab=${tab}`);
    await expect(named.getByRole("tab", { selected: true })).toHaveText(/^Activity/);
    await expect(named.locator("[data-part='thread-column']")).toBeVisible();
    await named.context().close();
  }
});

test("F-151/c7: S2: a code task's tabs and top bar are as before: Preview | Properties, copy link, PR #483, Take it local", async ({ browser }) => {
  const page = await openScene(browser, "s2");
  await expect(page.getByTestId("task-key-line")).toHaveText("CALC-192 · from a prompt");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add a history panel");
  await expect(tabNames(page)).toHaveText([/^Activity/, /^Changes/, /^Checks/, /^Event log/]);
  const bar = topBar(page);
  await expect(bar.getByTestId("side-pane-toggle")).toBeVisible();
  await expect(bar.locator("[data-action='copy-link']")).toBeVisible();
  await expect(bar.getByRole("link", { name: "PR #483" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Take it local" })).toBeVisible();
  await expect(bar.locator("[data-action='open-code-task']")).toHaveCount(0);
  // No turn runs: no Stop. PR #483 comes before Take it local, as `s2.md` draws it.
  await expect(bar.locator("[data-action='stop']")).toHaveCount(0);
  const order = await bar.locator("a, button").evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()).filter((text) => text === "PR #483" || text === "Take it local"));
  expect(order).toEqual(["PR #483", "Take it local"]);
  await shoot(page, "s2");
  await page.context().close();
});

test("F-151/c9: the status line names the box when no turn runs, and what the turn does while one runs", async ({ browser }) => {
  // S3: done, its round's verdict, its box released.
  const review = await openScene(browser, "s3");
  await expect(review.getByTestId("task-doing")).toHaveText("Done·round 2 of 3: nothing blocking, 1 nit·box released");
  await expect(review.getByTestId("task-doing").locator("[data-part='status-box']")).toHaveAttribute("data-box", "released");
  await review.context().close();

  // S2: in review with CI running, the PR it's at, the box idle and when it stops.
  const idle = await openScene(browser, "s2");
  await expect(idle.getByTestId("task-doing")).toHaveText(/^In review · CI running·PR #483·box idle, stops in \d+ min$/);
  await expect(idle.getByTestId("task-doing")).not.toContainText("Started");
  await idle.context().close();

  // S1 mid-turn: what it does now and when it started, on which runner; no box words.
  const working = await openScene(browser, "s1-working");
  await expect(working.getByTestId("task-doing")).toHaveText("Running·Running pnpm test history·Started 3 min ago on build-fleet-03");
  await expect(working.getByTestId("task-doing").locator("[data-part='status-box']")).toHaveCount(0);
  await shoot(working, "s1-working");
  await working.context().close();

  // S5 building: a file by its name.
  const building = await openScene(browser, "s5-approved");
  await expect(building.getByTestId("task-doing")).toContainText("Editing shortcuts.ts");
  await shoot(building, "s5-approved");
  await building.context().close();
});
