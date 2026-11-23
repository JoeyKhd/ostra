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

// Milestone 10, ticket 09 (F-151/c1): the compact thread's frame, on the targets' recorded scenes
// that `seed-thread-world.ts` writes into the stack's database (S1 waiting on OpenCode's question,
// S1 mid-turn, S2 three turns later): one 720px column left-aligned in the page's padding, the
// composer as wide, the agent's prose with no avatar or header, a member's message a bubble with
// their name over it, every turn's items through their parts, and no bookkeeping row or token
// line. The page shows each scene at its own moment (the clock fixed there, in UTC, as the targets
// draw it). `OSTRA_E2E_SHOTS` names a folder for the screenshots compared with the targets
// (`app-targets/m10-thread/`), at 1440 × 956 in both themes. Run once, at the milestone's end.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

const sceneNames = ["s1-working", "s1", "s2", "s3", "s5-plan", "s5-approved"] as const;
type SceneName = (typeof sceneNames)[number];
const worldSchema = z.object({
  username: z.string(),
  projectId: z.string(),
  tasks: z.record(z.enum(sceneNames), z.string()),
  now: z.record(z.enum(sceneNames), z.number()),
});
type World = z.infer<typeof worldSchema>;

/** Tally, the demo app, in its own colours: the calculator with its history beside it. */
const demoApp = (wide: boolean): string => `<!doctype html><html><head><style>
  body{margin:0;font:14px system-ui,sans-serif;background:#f4f5f8;color:#1c2333}
  header{display:flex;gap:16px;align-items:center;padding:12px 16px;background:#fff;border-bottom:1px solid #e3e6ee} header b{color:#2f5be0}
  main{display:flex;flex-wrap:wrap;gap:16px;padding:16px} .calc{flex:1 1 280px;background:#fff;border-radius:8px;padding:16px}
  .display{font-size:32px;text-align:right;padding:8px 4px} .keys{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
  .keys span{background:#eef1f7;border-radius:6px;padding:12px;text-align:center} .keys span.op{background:#dce5ff;color:#2f5be0}
  .history{flex:1 1 240px;background:#fff;border-radius:8px;padding:12px;${wide ? "" : "display:none"}} li{display:flex;padding:8px 0;border-bottom:1px solid #eef0f4} li b{margin-left:auto}
</style></head><body><header><b>Tally</b><span>Calculator</span><span>History</span></header><main>
  <section class="calc"><div class="display">1,284.50</div><div class="keys">${["C", "±", "%", "÷", "7", "8", "9", "×", "4", "5", "6", "−", "1", "2", "3", "+", "0", "00", ".", "="].map((key, i) => `<span class="${i % 4 === 3 ? "op" : ""}">${key}</span>`).join("")}</div></section>
  <section class="history"><b>History</b><ul style="list-style:none;padding:0">${["1,284.50", "101.40", "14", "2,081.25"].map((value) => `<li><span>${value}</span><b>Use</b></li>`).join("")}</ul></section></main></body></html>`;

/** The pictures the seed stores: Dana's mock and the agent's captures at 1280 and 390 wide. */
const takePictures = async (browser: Browser): Promise<{ readonly mock: string; readonly desktop: string; readonly phone: string }> => {
  const folder = await mkdtemp(path.join(tmpdir(), "ostra-e2e-thread-"));
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();
  const png = async (name: string, width: number, height: number): Promise<string> => {
    await page.setViewportSize({ width, height });
    await page.setContent(demoApp(width > 700));
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
  const tag = `m10-${Date.now().toString(36)}`;
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-thread-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, tag, files })], { cwd: path.resolve(import.meta.dirname, "..") });
  world = worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
});

/** A scene's task page at the scene's own moment, in UTC as the targets draw it. */
const openScene = async (browser: Browser, scene: SceneName, viewport = { width: 1440, height: 956 }): Promise<Page> => {
  const context = await browser.newContext({ viewport, timezoneId: "UTC" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(world.now[scene]));
  await signIn(page, world.username, e2eAdmin.password);
  await page.goto(`/tasks/${world.tasks[scene]}`);
  await settleRoute(page);
  await page.locator("[data-part='thread-column'] [data-message-id]").first().waitFor();
  return page;
};

/** The page in both themes, for the by-eye check against the targets. */
const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  // `next dev`'s badge, when the stack serves the panel that way (OSTRA_E2E_DEV): the build has none.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shots, `m10-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

/** The column holds what a member reads: no bookkeeping row, no token line, no avatar or header. */
const expectCalmColumn = async (page: Page): Promise<void> => {
  const column = page.locator("[data-part='thread-column']");
  for (const words of ["Work saved", "The session ended", "The runner connected", "unfinished work not saved"]) await expect(column.getByText(words)).toHaveCount(0);
  await expect(column.locator("[data-part='turn-usage'], [data-part='saved'], [data-part='session-end']")).toHaveCount(0);
  await expect(column.getByText(/\d(\.\d)?k in · /)).toHaveCount(0);
  // The agent's turns are their items: prose with no avatar, name, model or status word.
  const turns = column.locator("[data-role='assistant']");
  expect(await turns.count()).toBeGreaterThan(0);
  await expect(turns.getByText("OpenCode", { exact: true })).toHaveCount(0);
  await expect(turns.getByText("Claude Sonnet 5.5")).toHaveCount(0);
  await expect(turns.locator("[data-part='prose']").first()).toBeVisible();
};

/** One 720px column, left-aligned in the page's padding, and the composer as wide. */
const expectColumn = async (page: Page): Promise<void> => {
  const column = await page.locator("[data-part='thread-column']").boundingBox();
  const title = await page.locator("h1").first().boundingBox();
  expect(column).not.toBeNull();
  expect(title).not.toBeNull();
  if (column === null || title === null) return;
  expect(column.width).toBeLessThanOrEqual(720);
  expect(column.width).toBeGreaterThan(700);
  expect(Math.abs(column.x - title.x)).toBeLessThanOrEqual(1);
  const composer = await page.locator("[data-part='composer']").boundingBox();
  if (composer !== null) {
    expect(Math.abs(composer.x - column.x)).toBeLessThanOrEqual(1);
    expect(composer.width).toBeLessThanOrEqual(720);
  }
};

test("F-151/c1: S1, waiting on the question: one 720px column of bubbles, prose and run lines, no bookkeeping, opened at its end", async ({ browser }) => {
  const page = await openScene(browser, "s1");
  await expectColumn(page);
  await expectCalmColumn(page);
  const column = page.locator("[data-part='thread-column']");
  // Sam's message is a bubble with his name over it; the agent's first run carries the turn's time.
  await expect(column.locator("[data-part='bubble']").first()).toContainText("Sam Rivera");
  await expect(column.locator("[data-part='run']").first()).toContainText("Thought for 6s, read 4 files");
  await expect(column.locator("[data-part='turn-time']")).toHaveCount(1);
  await expect(column.locator("[data-part='run']").nth(1)).toContainText("Edited 2 files, ran 2 commands, took a screenshot · 1 failed, then passed");
  await expect(column.locator("[data-part='captures']")).toContainText("1280 · /history");
  await expect(column.locator("[data-part='question']")).toBeVisible();
  // The thread opens at its end: the question is in view.
  await expect(column.locator("[data-part='question']")).toBeInViewport();
  await shoot(page, "s1");
  await page.context().close();
});

test("F-151/c1: S1 mid-turn: the live step stands in the open run's place", async ({ browser }) => {
  const page = await openScene(browser, "s1-working");
  await expectColumn(page);
  await expectCalmColumn(page);
  await expect(page.locator("[data-part='live-step']")).toContainText("Running pnpm test history");
  await expect(page.locator("[data-part='live-step']")).toContainText("8 steps done, 1 failed · 3:52");
  await shoot(page, "s1-working");
  await page.context().close();
});

test("F-151/c1: S2, four turns over two sessions: no save, session end, runner or token rows between them", async ({ browser }) => {
  const page = await openScene(browser, "s2");
  await expectColumn(page);
  await expectCalmColumn(page);
  const column = page.locator("[data-part='thread-column']");
  await expect(column.locator("[data-role='assistant']")).toHaveCount(4);
  await expect(column.locator("[data-part='bubble']")).toHaveCount(4);
  await expect(column.locator("[data-part='turn-time']")).toHaveCount(4);
  await expect(column.locator("[data-part='result'][data-result='push']")).toContainText("Pushed ostra/calc-192-history-panel · 3 checks passed in the box");
  await expect(column.locator("[data-part='pr-card']")).toHaveCount(1);
  await expect(column.locator("[data-part='receipt']")).toContainText("Sam Rivera answered Replace the display");
  await shoot(page, "s2");
  await page.context().close();
});
