import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import { z } from "zod";

import { readStack, signIn } from "./helpers.ts";
import { settleRoute } from "./routes.ts";
import { e2eAdmin } from "./settings.ts";

// Milestone 10, ticket 16 (F-151/c3): a turn's numbers, on the targets' recorded scenes that
// `seed-thread-world.ts` writes into the stack's database (S2, `CALC-192` after four turns with
// PR #483 and CI running; S3, the AI review of it). They're never a line of the column: the turn's
// time holds them in a tooltip, by keyboard focus at once and by hover after 300 ms, closed by
// Escape; the opened run's footer says the same numbers with `Event log ›` to the turn's first
// event; the properties panel holds the task's in its Usage and Session groups. At phone width
// the time is plain text and the footer wraps by fact, `Event log ›` on its own line. Each page at
// its scene's moment, in UTC as the targets draw it. `OSTRA_E2E_SHOTS` names a folder for the
// screenshots compared with the targets (`s2`, `s4`, `s3`, `s6-phone-open`), at 1440 × 956 in
// both themes and at 390 × 844. Run once, at the milestone's end.

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

/** Tally, the demo app: the pictures the seed stores as Dana's mock and the agent's captures. */
const demoApp = (wide: boolean): string => `<!doctype html><html><head><style>
  body{margin:0;font:14px system-ui,sans-serif;background:#f4f5f8;color:#1c2333}
  header{display:flex;gap:16px;align-items:center;padding:12px 16px;background:#fff;border-bottom:1px solid #e3e6ee} header b{color:#2f5be0}
  main{display:flex;flex-wrap:wrap;gap:16px;padding:16px} .calc{flex:1 1 280px;background:#fff;border-radius:8px;padding:16px}
  .display{font-size:32px;text-align:right;padding:8px 4px} .keys{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
  .keys span{background:#eef1f7;border-radius:6px;padding:12px;text-align:center}
  .history{flex:1 1 240px;background:#fff;border-radius:8px;padding:12px;${wide ? "" : "display:none"}}
</style></head><body><header><b>Tally</b><span>Calculator</span><span>History</span></header><main>
  <section class="calc"><div class="display">1,284.50</div><div class="keys">${["C", "±", "%", "÷", "7", "8", "9", "×", "4", "5", "6", "−", "1", "2", "3", "+"].map((key) => `<span>${key}</span>`).join("")}</div></section>
  <section class="history"><b>History</b></section></main></body></html>`;

const takePictures = async (browser: Browser): Promise<{ readonly mock: string; readonly desktop: string; readonly phone: string }> => {
  const folder = await mkdtemp(path.join(tmpdir(), "ostra-e2e-numbers-"));
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
  const tag = `m10n-${Date.now().toString(36)}`;
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-thread-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, tag, files })], { cwd: path.resolve(import.meta.dirname, "..") });
  world = worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
});

// The phone project checks the footer at phone width in its own test; the rest are at desktop width.
test.beforeEach(({ isMobile }, testInfo) => {
  test.skip(isMobile && !testInfo.title.includes("at phone width"), "a desktop check");
});

/** A scene's task page at the scene's own moment, in UTC as the targets draw it. */
const openScene = async (browser: Browser, scene: SceneName, viewport = { width: 1440, height: 956 }): Promise<Page> => {
  const context = await browser.newContext({ viewport, timezoneId: "UTC", ...(viewport.width < 768 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(world.now[scene]));
  await signIn(page, world.username, e2eAdmin.password);
  await page.goto(`/tasks/${world.tasks[scene]}`);
  await settleRoute(page);
  await page.locator("[data-part='thread-column'] [data-message-id]").first().waitFor();
  return page;
};

/** Scrolls the thread so `line` stands `top` px from the window's top, as the target's scroll has it. */
const scrollTo = async (line: Locator, top: number): Promise<void> => {
  await line.evaluate((element, y) => {
    let box: HTMLElement | null = element.parentElement;
    while (box !== null && !(box.scrollHeight > box.clientHeight && getComputedStyle(box).overflowY !== "visible")) box = box.parentElement;
    if (box !== null) box.scrollTop += element.getBoundingClientRect().top - y;
  }, top);
};

/** The page in both themes, for the by-eye check against the targets; the pointer stays where it is. */
const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  // `next dev`'s badge, when the stack serves the panel that way (OSTRA_E2E_DEV): the build has none.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shots, `m10-numbers-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

const turnSchema = z.object({ turnId: z.string(), startedAt: z.number(), inputTokens: z.number(), outputTokens: z.number(), reasoningTokens: z.number(), spentMicroUsd: z.number().nullable(), effort: z.string().nullable() });
const taskSchema = z.object({ result: z.object({ data: z.object({ usage: z.object({ turns: z.array(turnSchema) }).nullable() }) }) });

/** `tasks.get`'s `usage.turns` over HTTP, as the signed-in member, oldest first. */
const usageTurns = async (page: Page, taskId: string): Promise<z.infer<typeof turnSchema>[]> => {
  const response = await page.request.get(`/api/trpc/tasks.get?input=${encodeURIComponent(JSON.stringify({ taskId }))}`);
  expect(response.ok()).toBe(true);
  return [...(taskSchema.parse(await response.json()).result.data.usage?.turns ?? [])].sort((a, b) => a.startedAt - b.startedAt);
};

/** `22400` as the panel writes it: `22.4k`. */
const short = (n: number): string => (n >= 1_000 ? `${String(Number((n / 1_000).toFixed(1)))}k` : String(n));

/** The tooltip's head and its rows, `key value`. */
const tipWords = async (tip: Locator): Promise<{ readonly head: string; readonly rows: string[] }> => ({
  head: (await tip.locator("[data-part='tip-head']").innerText()).trim(),
  rows: (await tip.locator("[data-part='tip-row']").allInnerTexts()).map((row) => row.replace(/\s+/g, " ").trim()),
});

/** A panel group's rows, `key value`, by its title. */
const groupRows = async (page: Page, title: string): Promise<string[]> => {
  const group = page.getByTestId("task-properties").locator(":scope > div").filter({ has: page.locator(`h3:text-is("${title}")`) });
  return (await group.locator(":scope > div.grid, :scope > div > div.grid").allInnerTexts()).map((row) => row.replace(/\s+/g, " ").trim());
};

test("F-151/c3: S2's turn 4: the time's tooltip by keyboard, at once, closed by Escape, and by hover; its numbers the footer's and tasks.get's", async ({ browser }) => {
  const page = await openScene(browser, "s2");
  const column = page.locator("[data-part='thread-column']");
  // No turn's numbers are a line of the column.
  await expect(column).not.toContainText(" in · ", { useInnerText: true });
  const times = column.locator("[data-part='turn-time']");
  await expect(times).toHaveCount(4);
  const turn4 = column.locator("[data-part='run']").filter({ has: page.locator("[data-part='turn-time']") }).last();
  const time = turn4.locator("[data-part='turn-time']");
  await expect(time).toHaveText("14:44");
  const tip = turn4.getByRole("tooltip", { includeHidden: true });
  await expect(tip).toBeHidden();

  // By keyboard: from the run's line, Tab reaches the time, and its tooltip shows at once.
  await turn4.getByRole("button", { expanded: false }).focus();
  await page.keyboard.press("Tab");
  await expect(time).toBeFocused();
  await expect(tip).toBeVisible();
  expect(await time.getAttribute("aria-describedby")).toBe(await tip.getAttribute("id"));
  const words = await tipWords(tip);
  expect(words).toEqual({
    head: "Turn 4 · 14:44 to 14:47",
    rows: ["Effort High", "Tokens 22.4k in · 3.8k out", "Reasoning 1.1k", "Spend $0.31", "Saved archive 193 kB"],
  });
  // Above the time, its left edge 10px left of it.
  const [timeBox, tipBox] = [await time.boundingBox(), await tip.boundingBox()];
  expect(tipBox !== null && timeBox !== null && tipBox.y + tipBox.height < timeBox.y).toBe(true);
  expect(Math.round((tipBox?.x ?? 0) - (timeBox?.x ?? 0))).toBe(-10);
  expect(Math.round(tipBox?.width ?? 0)).toBe(268);
  // Escape closes it, the focus staying on the time.
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await expect(time).toBeFocused();

  // The same numbers as tasks.get counted them for the turn.
  const turns = await usageTurns(page, world.tasks.s2);
  const counted = turns[3];
  expect(turns).toHaveLength(4);
  expect(`Tokens ${short(counted?.inputTokens ?? 0)} in · ${short(counted?.outputTokens ?? 0)} out`).toBe(words.rows[1]);
  expect(`Reasoning ${short(counted?.reasoningTokens ?? 0)}`).toBe(words.rows[2]);
  expect(`Spend $${((counted?.spentMicroUsd ?? 0) / 1_000_000).toFixed(2)}`).toBe(words.rows[3]);

  // By hover: the pointer on the time shows it (after 300 ms), with the dotted underline.
  await page.keyboard.press("Tab");
  await expect(tip).toBeHidden();
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await time.hover();
  await expect(tip).toBeVisible();
  expect(await time.evaluate((element) => getComputedStyle(element).textDecorationStyle)).toBe("dotted");
  await shoot(page, "s2");
  await page.mouse.move(700, 900);
  await expect(tip).toBeHidden();

  // The opened run's footer says the same numbers, and `Event log ›` goes to the turn's first event.
  await turn4.getByRole("button", { expanded: false }).click();
  const footer = turn4.locator("[data-part='run-footer']");
  await expect(footer.locator("[data-part='footer-facts']")).toHaveText("Turn 4 · High · 22.4k in · 3.8k out · 1.1k reasoning · $0.31 · saved, archive 193 kB");
  const link = footer.getByRole("link", { name: "Event log" });
  const href = (await link.getAttribute("href")) ?? "";
  expect(href).toMatch(/^\?tab=events&seq=\d+$/);
  await scrollTo(turn4, 380);
  await shoot(page, "s2-open");
  await link.click();
  await expect(page).toHaveURL(new RegExp(`tab=events&seq=${href.split("seq=")[1] ?? ""}$`));
  await expect(page.locator("#task-tab-events")).toBeVisible();
  await page.context().close();
});

test("F-151/c3: S2's panel: Properties, Usage, Code with Checks and CI, Session with the box, the saved work and the turns", async ({ browser }) => {
  const page = await openScene(browser, "s2");
  const panel = page.getByTestId("task-properties");
  const titles = await panel.locator(":scope > div > h3").allInnerTexts();
  expect(titles.slice(0, 4)).toEqual(["Properties", "Usage", "Code", "Session"]);
  const usage = await groupRows(page, "Usage");
  // Turn 3's count was the key proxy's estimate, so the task's is marked as one.
  expect(usage[0]).toMatch(/^Tokens ≈ [\d.]+k in · [\d.]+k out$/);
  expect(usage).toContain("Spend $2.14 of $25.00");
  const code = await groupRows(page, "Code");
  expect(code).toContain("PR #483 · open");
  expect(code).toContain("Checks 3 of 3 passed · in the box");
  expect(code).toContain("CI Running · 2 of 4 jobs");
  const session = await groupRows(page, "Session");
  expect(session[0]).toMatch(/^Box Idle · stops in \d+ min$/);
  expect(session).toContain("Saved work After turn 4 · 193 kB");
  expect(session).toContain("Turns 4");
  await page.context().close();
});

test("F-151/c3: S3, a review task: its footer has no saved fact; its panel has a Result group, no Code group and no saved work", async ({ browser }) => {
  const page = await openScene(browser, "s3");
  const column = page.locator("[data-part='thread-column']");
  const turn2 = column.locator("[data-part='run']").filter({ has: page.locator("[data-part='turn-time']") }).nth(1);
  await turn2.getByRole("button", { expanded: false }).click();
  await expect(turn2.locator("[data-part='footer-facts']")).toHaveText("Turn 2 · Max · 13.4k in · 2.6k out · 1.6k reasoning · $0.19");
  const panel = page.getByTestId("task-properties");
  const titles = await panel.locator(":scope > div > h3").allInnerTexts();
  expect(titles.slice(0, 3)).toEqual(["Properties", "Result", "Usage"]);
  expect(titles).not.toContain("Code");
  const properties = await groupRows(page, "Properties");
  expect(properties).toContain("Kind AI review");
  expect(properties).toContain("Reviews PR #483 · CALC-192");
  expect(properties).toContain("Round 2 of 3");
  expect(await groupRows(page, "Result")).toEqual(["Blocking None", "Nits 1", "Review Open the review"]);
  await expect(panel.getByTestId("task-saved-work")).toHaveCount(0);
  await scrollTo(turn2, 300);
  await shoot(page, "s3-open");
  await page.context().close();
});

test("F-151/c3: at phone width the time is plain text and the opened run's footer wraps by fact, Event log on its own line", async ({ browser }) => {
  const page = await openScene(browser, "s1", { width: 390, height: 844 });
  const column = page.locator("[data-part='thread-column']");
  const first = column.locator("[data-part='run']").first();
  const time = first.locator("[data-part='turn-time']");
  await expect(time).toHaveText("14:02");
  expect(await time.getAttribute("tabindex")).toBeNull();
  await expect(first.getByRole("tooltip", { includeHidden: true })).toHaveCount(0);
  await first.getByRole("button", { expanded: false }).click();
  const footer = first.locator("[data-part='run-footer']");
  await expect(footer.locator("[data-part='footer-facts']")).toHaveText("Turn 1 · High · 41.2k in · 6.3k out · 2.1k reasoning · $0.62 so far · not saved yet");
  // No fact is split across two lines: each sits on one.
  const facts = footer.locator("[data-part='footer-fact']");
  for (const box of await facts.evaluateAll((elements) => elements.map((element) => element.getClientRects().length))) expect(box).toBe(1);
  const lines = new Set(await facts.evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top))));
  expect(lines.size).toBeGreaterThan(1);
  // `Event log ›` on its own line under the facts.
  const link = footer.getByRole("link", { name: "Event log" });
  const [factsBox, linkBox] = [await footer.locator("[data-part='footer-facts']").boundingBox(), await link.boundingBox()];
  expect(linkBox !== null && factsBox !== null && linkBox.y >= factsBox.y + factsBox.height).toBe(true);
  await first.evaluate((element) => { element.scrollIntoView({ block: "center" }); });
  await shoot(page, "s6-phone-open");
  await page.context().close();
});
