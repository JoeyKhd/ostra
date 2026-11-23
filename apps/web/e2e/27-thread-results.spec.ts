import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { z } from "zod";

import { checkContrast, prepareA11y } from "./a11y/checks.ts";
import { readStack, signIn } from "./helpers.ts";
import { settleRoute } from "./routes.ts";
import { e2eAdmin } from "./settings.ts";

// Milestone 10, ticket 14 (F-151/c6, c7): what a turn made, on the targets' recorded scenes that
// `seed-thread-world.ts` writes into the stack's database. S2: the push line says the project's
// checks passed in the box, the PR card shows once under it with CI on GitHub counted in jobs and
// its size from the Changes tab's compare, and updates in place when CI finishes; the push opens on
// its commit and its checks; the Checks tab's marker, the stage line and Home's board count CI in
// jobs. S3: the review task's result lines, posted and confirmed, neither red, with no push or PR.
// `OSTRA_E2E_SHOTS` names a folder for the screenshots compared with the targets, at 1440 × 956 in
// both themes. Run once, at the milestone's end.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

const sceneNames = ["s1-working", "s1", "s2", "s3", "s5-plan", "s5-approved"] as const;
type SceneName = (typeof sceneNames)[number];
/** The messages sheet's cells this ticket draws: cell 1's later push, cell 6's results and a refine task's draft. */
const cellNames = ["messages-1", "messages-6", "messages-6-draft"] as const;
type CellName = (typeof cellNames)[number];
const worldSchema = z.object({
  username: z.string(),
  projectId: z.string(),
  tasks: z.record(z.enum(sceneNames), z.string()),
  now: z.record(z.enum(sceneNames), z.number()),
  results: z.record(z.enum(cellNames), z.string()),
  resultsNow: z.record(z.enum(cellNames), z.number()),
});
type World = z.infer<typeof worldSchema>;

/** The pictures the seed stores (the scenes' captures and Sam's mock): plain pages, at their sizes. */
const takePictures = async (browser: Browser): Promise<{ readonly mock: string; readonly desktop: string; readonly phone: string }> => {
  const folder = await mkdtemp(path.join(tmpdir(), "ostra-e2e-results-"));
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();
  const png = async (name: string, width: number, height: number): Promise<string> => {
    await page.setViewportSize({ width, height });
    await page.setContent(`<!doctype html><body style="margin:0;background:#f4f5f8;font:14px system-ui"><header style="padding:12px 16px;background:#fff"><b>Tally</b></header></body>`);
    const file = path.join(folder, `${name}.png`);
    await writeFile(file, await page.screenshot({ type: "png" }));
    return file;
  };
  const pictures = { mock: await png("mock", 1440, 900), desktop: await png("desktop", 1280, 800), phone: await png("phone", 390, 844) };
  await context.close();
  return pictures;
};

let world: World;
let databaseUrl: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  databaseUrl = (await readStack()).databaseUrl;
  const files = { ...(await takePictures(browser)), docx: path.join(repoRoot, "e2e", "m9-attachments", "fixtures", "history-panel-spec.docx") };
  const tag = `m10r-${Date.now().toString(36)}`;
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-thread-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, tag, files })], { cwd: path.resolve(import.meta.dirname, "..") });
  world = worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
});

/** A page signed in as the scenes' member, its clock fixed at a moment, in UTC as the targets draw it. */
const openPage = async (browser: Browser, at: number, viewport = { width: 1440, height: 956 }): Promise<Page> => {
  const context = await browser.newContext({ viewport, timezoneId: "UTC" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(at));
  await signIn(page, world.username, e2eAdmin.password);
  return page;
};

const openTask = async (page: Page, taskId: string): Promise<Page> => {
  await page.goto(`/tasks/${taskId}`);
  await settleRoute(page);
  await page.locator("[data-part='thread-column'] [data-message-id]").first().waitFor();
  return page;
};

const openScene = async (browser: Browser, scene: SceneName, viewport = { width: 1440, height: 956 }): Promise<Page> => openTask(await openPage(browser, world.now[scene], viewport), world.tasks[scene]);
const openCell = async (browser: Browser, cell: CellName): Promise<Page> => openTask(await openPage(browser, world.resultsNow[cell]), world.results[cell]);

/** The page in both themes, for the by-eye check against the targets. */
const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  // `next dev`'s badge, when the stack serves the panel that way (OSTRA_E2E_DEV): the build has none.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shots, `m10-results-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

/** The items of the column, in order, by their part: what follows what. */
const partsInOrder = (page: Page): Promise<string[]> =>
  page.locator("[data-part='thread-column'] [data-item-kind] > [data-part]").evaluateAll((nodes) => nodes.map((node) => (node instanceof HTMLElement ? `${node.dataset["part"] ?? ""}${node.dataset["result"] === undefined ? "" : `:${node.dataset["result"]}`}` : "")));

// While CI still runs on S2's head: the next test finishes it.
test("F-151/c6: Home's board counts the PR's CI in jobs", async ({ browser }) => {
  const page = await openPage(browser, world.now.s2);
  await page.goto(`/?view=board&project=${encodeURIComponent(world.projectId)}`);
  await settleRoute(page);
  await expect(page.getByText("PR #483 · CI running · 2 of 4 jobs")).toBeVisible();
  await page.context().close();
});

test("F-151/c6: at phone width the push line and the card fit the column, the card's title giving way first", async ({ browser }) => {
  const page = await openScene(browser, "s2", { width: 390, height: 844 });
  const card = page.locator("[data-part='thread-column'] [data-part='pr-card']");
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) expect(box.x + box.width).toBeLessThanOrEqual(390 - 16 + 1);
  await expect(card.locator("[data-part='pr-size'] > span")).toHaveText(["+214", "−18"]);
  await expect(card.locator("[data-part='pr-size']")).toBeInViewport();
  await shoot(page, "s2-phone");
  await page.context().close();
});

test("F-151/c6: S2's push line says 3 checks passed in the box, the card shows once under it with CI in jobs, and updates in place when CI passes", async ({ browser }) => {
  const page = await openScene(browser, "s2");
  const column = page.locator("[data-part='thread-column']");
  const push = column.locator("[data-part='result'][data-result='push']");
  await expect(push).toHaveCount(1);
  await expect(push).toContainText("Pushed ostra/calc-192-history-panel · 3 checks passed in the box");
  await expect(push.locator(".text-red")).toHaveCount(0);
  // The card: once, right under the push that opened it, with its size and CI counted in jobs.
  const card = column.locator("[data-part='pr-card']");
  await expect(card).toHaveCount(1);
  const order = await partsInOrder(page);
  expect(order.at(order.indexOf("result:push") + 1)).toBe("pr-card");
  await expect(card).toHaveAttribute("data-pr-look", "open");
  await expect(card).toContainText("#483");
  await expect(card).toContainText("Add a history panel");
  await expect(card.locator("[data-part='pr-size'] > span")).toHaveText(["+214", "−18"]);
  await expect(card.locator("[data-part='pr-ci']")).toHaveText("CI on GitHub: running, 2 of 4 jobs done · then the AI review");
  await expect(card.getByRole("link", { name: "PR #483 on GitHub" })).toHaveAttribute("href", "https://github.com/acme/calculator-web/pull/483");
  // The Checks tab's marker follows both: CI runs on GitHub, so it spins; the stage line counts the jobs.
  await expect(page.getByRole("tab", { name: /Checks/ }).getByLabel("Running")).toBeVisible();
  await expect(page.getByTestId("stage-line")).toContainText("CI running · 2 of 4 jobs");
  await shoot(page, "s2");

  // Pressed, the push opens its commit and the three checks its turn ran in the box.
  await push.getByRole("button").click();
  await expect(push.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  const opened = push.locator("[data-part='push-open']");
  await expect(opened.locator("[data-push-row='commit']")).toContainText("Pushed9c1e2f04 commits ahead of main");
  await expect(opened.getByRole("link", { name: "Show the changes up to 9c1e2f0" })).toBeVisible();
  await expect(opened.locator("[data-push-row='check']")).toHaveText(["CheckedTests✓ passed · 13 s", "CheckedLint✓ passed · 6.1 s", "CheckedTypes✓ passed · 9.4 s"]);
  await shoot(page, "s2-push-open");

  // CI finishes on GitHub: the card's line says so in place, still one card, and the tab's marker turns green.
  await run(process.execPath, [path.join(import.meta.dirname, "seed-thread-ci.ts"), JSON.stringify({ databaseUrl, taskId: world.tasks.s2, state: "passed" })], { cwd: path.resolve(import.meta.dirname, "..") });
  await expect(card.locator("[data-part='pr-ci']")).toHaveText("CI on GitHub passed · 4 jobs", { timeout: 20_000 });
  await expect(column.locator("[data-part='pr-card']")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /Checks/ }).getByLabel("All passed")).toBeVisible();
  await page.context().close();
});

test("F-151/c7: S3's result lines: the review posted with its verdict and the repeat confirmed, neither red, and no push or PR", async ({ browser }) => {
  const page = await openScene(browser, "s3");
  const column = page.locator("[data-part='thread-column']");
  const reviews = column.locator("[data-part='result'][data-result='review']");
  await expect(reviews).toHaveText(["Review posted on PR #483 · nothing blocking, 1 nitOpen the review", "Review on PR #483 confirmed · already posted this round, unchangedOpen the review"]);
  await expect(reviews.locator(".text-red")).toHaveCount(0);
  await expect(reviews.first().getByRole("link", { name: "Open the review" })).toHaveAttribute("href", `/tasks/${world.tasks.s2}/review`);
  await expect(column.locator("[data-result='push'], [data-part='pr-card']")).toHaveCount(0);
  await shoot(page, "s3");
  await page.context().close();
});

test("F-151/c6: a later push to the open PR is one line, `Pushed 9a03d1e · CI passed`, with no second card", async ({ browser }) => {
  const page = await openCell(browser, "messages-1");
  const column = page.locator("[data-part='thread-column']");
  await expect(column.locator("[data-part='result'][data-result='push']")).toHaveText(["Pushed 9a03d1e · CI passed"]);
  await expect(column.locator("[data-part='pr-card']")).toHaveCount(0);
  await shoot(page, "messages-1");
  await page.context().close();
});

test("F-151/c8: an ostra_show_preview call is the preview's result line, not a tool row; a memory proposal is its line too", async ({ browser }) => {
  const page = await openCell(browser, "messages-6");
  const column = page.locator("[data-part='thread-column']");
  const preview = column.locator("[data-part='result'][data-result='preview']");
  await expect(preview).toHaveText("Preview web :5173 /historyShow");
  await expect(preview.getByRole("link", { name: "Show" })).toHaveAttribute("href", /pane=preview&preview=port-5173&path=%2Fhistory/);
  await expect(column.locator("[data-part='result'][data-result='memory']")).toHaveText("Proposed a memory: Run the tests with pnpm test, not npmReview");
  await expect(column.getByText("ostra_show_preview")).toHaveCount(0);
  await shoot(page, "messages-6");
  await page.context().close();
});

test("F-151/c7: a refine task's turn hands in its draft as a result line, with no push or PR line", async ({ browser }) => {
  const page = await openCell(browser, "messages-6-draft");
  const column = page.locator("[data-part='thread-column']");
  const draft = column.locator("[data-part='result'][data-result='draft']");
  await expect(draft).toHaveText("Handed in draft v2 · 4 acceptance criteria, 2 sub-ticketsOpen the draft");
  await expect(draft.getByRole("link", { name: "Open the draft" })).toHaveAttribute("href", `/tasks/${world.results["messages-6-draft"]}?tab=draft`);
  await expect(column.locator("[data-result='push'], [data-part='pr-card']")).toHaveCount(0);
  await shoot(page, "messages-6-draft");
  await page.context().close();
});

test("F-151/c6: the push opened, the card and the review lines pass the contrast check in both themes", async ({ browser }) => {
  for (const [scene, taskId] of [["s2", world.tasks.s2], ["s3", world.tasks.s3]] as const) {
    const page = await openPage(browser, world.now[scene]);
    await prepareA11y(page);
    await openTask(page, taskId);
    if (scene === "s2") await page.locator("[data-part='result'][data-result='push']").getByRole("button").click();
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
      const { failures } = await checkContrast(page, "[data-part='thread-column']");
      expect(failures, `${scene}, ${theme}`).toEqual([]);
    }
    await page.context().close();
  }
});
