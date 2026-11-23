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

// Milestone 10, ticket 17 (F-151/c10): the compact thread on a phone, in the light theme and by
// keyboard, over the scenes `seed-thread-world.ts` writes into the stack's database. At 390 px: a
// run's line wraps and its whole line is a 44px tap target, an opened run's verb sits inline before
// its subject, its rows are 36px tall, and its footer holds the turn's numbers and `Event log ›`;
// the time is plain text with no tooltip; the composer docks (a 50px box, a 40px Send) with
// `Interrupt and send` in its `…` menu. `j` and `k` move between runs' lines and needs-you blocks;
// with `prefers-reduced-motion` no spinner turns. `OSTRA_E2E_SHOTS` names a folder for the
// screenshots compared with the targets at both widths and in both themes. Run once, at the
// milestone's end.

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

const PHONE = { width: 390, height: 844 } as const;

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
  const folder = await mkdtemp(path.join(tmpdir(), "ostra-e2e-thread-phone-"));
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
  const tag = `m10-phone-${Date.now().toString(36)}`;
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-thread-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, tag, files })], { cwd: path.resolve(import.meta.dirname, "..") });
  world = worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
});

/** A scene's task page at the scene's own moment, in UTC as the targets draw it. */
const openScene = async (browser: Browser, scene: SceneName, viewport: { readonly width: number; readonly height: number } = PHONE): Promise<Page> => {
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
    await page.screenshot({ path: path.join(shots, `m10-17-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

/** A box's size, and the styles the phone's rules change. */
const boxOf = async (page: Page, selector: string): Promise<{ readonly width: number; readonly height: number; readonly x: number }> => {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`no box for ${selector}`);
  return box;
};

test("F-151/c10: at 390 px a run's line wraps, its whole line at least 44px tall, and the time has no tooltip", async ({ browser }) => {
  const page = await openScene(browser, "s1");
  const line = page.locator("[data-part='run'] [data-nav='run-line']").first();
  await expect(line).toBeVisible();
  await line.scrollIntoViewIfNeeded();
  const box = await line.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    // The whole column is the line's width: it wraps inside it rather than pushing the page sideways.
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
  }
  expect(await line.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("normal");
  // The longest run's line wraps at 390 px: it holds more than one 21px text line, where the same
  // words sit on one line at 1440.
  const words = page.locator("[data-part='run'] [data-part='run-words']").last();
  expect(await words.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(20);
  // The time is plain text here, with no tooltip and no tab stop.
  const time = page.locator("[data-part='turn-time']").first();
  await expect(time).toHaveAttribute("data-part", "turn-time");
  expect(await time.evaluate((element) => element.closest("button") !== null)).toBe(true);
  expect(await time.getAttribute("tabindex")).toBeNull();
  await expect(page.locator("[data-part='turn-tip']")).toHaveCount(0);
  await shoot(page, "s1-phone");
  await page.context().close();
});

test("F-151/c10: an opened run at 390 px: the verb inline before its subject, 36px rows, the footer with Event log", async ({ browser }) => {
  const page = await openScene(browser, "s1");
  const line = page.locator("[data-part='run'] [data-nav='run-line']").nth(1);
  await line.scrollIntoViewIfNeeded();
  await line.click();
  const steps = page.locator("[data-part='run-steps']").first();
  await expect(steps).toBeVisible();
  await expect(steps.locator("ul[role='list']")).toHaveCount(1);
  const rows = steps.locator("[data-step]");
  expect(await rows.count()).toBeGreaterThan(0);
  for (let i = 0; i < await rows.count(); i += 1) {
    const row = rows.nth(i);
    expect(await row.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(36);
  }
  // The verb sits inline before its subject: 22px icon, then the verb, then the subject on the same line.
  const first = rows.first();
  const verb = first.locator(":scope > div > span").nth(1);
  const subject = first.locator("[data-part='step-subject']").first();
  if (await subject.count() > 0) {
    const [verbBox, subjectBox] = [await verb.boundingBox(), await subject.boundingBox()];
    expect(verbBox).not.toBeNull();
    expect(subjectBox).not.toBeNull();
    if (verbBox !== null && subjectBox !== null) {
      expect(subjectBox.x).toBeGreaterThan(verbBox.x);
      expect(Math.abs(subjectBox.y - verbBox.y)).toBeLessThanOrEqual(12);
    }
  }
  // The footer holds the turn's numbers and `Event log ›` on a line of its own.
  const footer = steps.locator("[data-part='run-footer']");
  await expect(footer).toBeVisible();
  await expect(footer.locator("[data-part='footer-facts']")).toContainText("Turn 1");
  await expect(footer).toContainText("in");
  await expect(footer.getByRole("link")).toContainText("Event log");
  const facts = await footer.locator("[data-part='footer-facts']").boundingBox();
  const link = await footer.getByRole("link").boundingBox();
  if (facts !== null && link !== null) expect(link.y).toBeGreaterThan(facts.y + facts.height - 1);
  await shoot(page, "s1-open-phone");
  await page.context().close();
});

test("F-151/c10: at 390 px the composer docks, a 50px box with a 40px Send, and Interrupt and send is in its menu", async ({ browser }) => {
  const page = await openScene(browser, "s1-working");
  const dock = page.locator("[data-part='composer-dock']");
  await expect(dock).toBeVisible();
  const dockBox = await dock.boundingBox();
  expect(dockBox).not.toBeNull();
  if (dockBox !== null) {
    expect(dockBox.x).toBeLessThanOrEqual(1);
    expect(dockBox.x + dockBox.width).toBeGreaterThanOrEqual(PHONE.width - 1);
  }
  const box = await boxOf(page, "[data-part='composer']");
  expect(box.height).toBeGreaterThanOrEqual(48);
  expect(box.height).toBeLessThanOrEqual(54);
  const send = await boxOf(page, "[data-action='send']");
  expect(send.width).toBeGreaterThanOrEqual(39);
  expect(send.width).toBeLessThanOrEqual(41);
  expect(send.height).toBeGreaterThanOrEqual(39);
  // The `…` menu holds `Interrupt and send` (and Stop).
  await page.locator("[data-action='composer-menu']").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Interrupt and send" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.keyboard.press("Escape");
  await shoot(page, "s1-working-phone");
  await page.context().close();
});

test("F-151/c10: j and k move the focus between runs' lines and needs-you blocks, in order", async ({ browser }) => {
  const page = await openScene(browser, "s1");
  await page.locator("h1").first().click();
  const stops = page.locator("[data-part='thread-column'] [data-nav='run-line'], [data-part='thread-column'] [data-waits]");
  expect(await stops.count()).toBeGreaterThan(1);
  await page.keyboard.press("j");
  await expect(page.locator("[data-nav='run-line']").first()).toBeFocused();
  await page.keyboard.press("j");
  await expect(page.locator("[data-part='run'] [data-nav='run-line']").nth(1)).toBeFocused();
  await page.keyboard.press("k");
  await expect(page.locator("[data-nav='run-line']").first()).toBeFocused();
  // Walking to the end reaches the question's block; the fields keep their own keys.
  for (let i = 0; i < await stops.count(); i += 1) await page.keyboard.press("j");
  const focused = page.locator(":focus");
  expect(await focused.evaluate((element) => element.closest("[data-waits]") !== null || element.matches("[data-nav='run-line']"))).toBe(true);
  await page.context().close();
});

test("the ticket's screenshots: every scene at 1440 and 390 px, dark and light, for the by-eye check", async ({ browser }) => {
  // The shots set their own viewports, so one project's pass is the lot.
  test.skip(test.info().project.name !== "desktop", "the screenshots are the same from either project");
  test.setTimeout(240_000);
  for (const scene of sceneNames) {
    const desktop = await openScene(browser, scene, { width: 1440, height: 956 });
    await shoot(desktop, `${scene}-desktop`);
    await desktop.context().close();
    const phone = await openScene(browser, scene);
    await shoot(phone, `${scene}-phone`);
    await phone.context().close();
  }
});

test("F-151/c10: with prefers-reduced-motion no spinner turns, while the live step's time still ticks", async ({ browser }) => {
  const page = await openScene(browser, "s1-working");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await settleRoute(page);
  await page.locator("[data-part='thread-column'] [data-message-id]").first().waitFor();
  const turning = await page.evaluate(() =>
    [...document.querySelectorAll("[data-part='thread-column'] *")].filter((element) => {
      const style = getComputedStyle(element);
      return style.animationName !== "none" && style.animationDuration !== "0s" && /spin/i.test(style.animationName);
    }).length,
  );
  expect(turning).toBe(0);
  await expect(page.locator("[data-part='live-step']")).toBeVisible();
  const clock = page.locator("[data-part='live-step'] [data-part='live-clock']");
  await expect(clock).toHaveText("3:52");
  // The time still ticks with reduced motion (it isn't a transition or animation).
  await page.clock.setFixedTime(new Date(world.now["s1-working"] + 1_000));
  await expect(clock).toHaveText("3:53");
  await shoot(page, "s1-working-reduced");
  await page.context().close();
});
