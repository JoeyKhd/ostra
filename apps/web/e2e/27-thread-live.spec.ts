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

// Milestone 10, ticket 11 (F-151/c4): the live step and the composer, on the targets' recorded
// scenes that `seed-thread-world.ts` writes into the stack's database. S1 mid-turn: the live step
// stands in the open run's place, reads `Running pnpm test history · 8 steps done, 1 failed · 3:52`,
// ticks each second, says its words once in a polite live region (never the clock), and opens the
// run so far. S5's build turn names its plan step. The composer is one box: `Interrupt and send`
// only while a turn runs, both buttons asleep on an empty field, the hint and the next turn's model
// and level under it; S2's idle box reads as a send. Each page shows its scene at the scene's own
// moment, in UTC. `OSTRA_E2E_SHOTS` names a folder for the screenshots compared with the targets
// (`app-targets/m10-thread/`), at 1440 × 956 in both themes and at 390 × 844. Run once, at the
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

/** Tally, the demo app: the pictures the seed stores (Dana's mock, the agent's captures). */
const demoApp = (wide: boolean): string => `<!doctype html><html><head><style>
  body{margin:0;font:14px system-ui,sans-serif;background:#f4f5f8;color:#1c2333}
  header{padding:12px 16px;background:#fff;border-bottom:1px solid #e3e6ee} main{display:flex;gap:16px;padding:16px}
  .calc{flex:1;background:#fff;border-radius:8px;padding:16px} .display{font-size:32px;text-align:right}
  .history{flex:1;background:#fff;border-radius:8px;padding:12px;${wide ? "" : "display:none"}}
</style></head><body><header><b>Tally</b></header><main><section class="calc"><div class="display">1,284.50</div></section><section class="history"><b>History</b></section></main></body></html>`;

const takePictures = async (browser: Browser): Promise<{ readonly mock: string; readonly desktop: string; readonly phone: string }> => {
  const folder = await mkdtemp(path.join(tmpdir(), "ostra-e2e-live-"));
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
  const tag = `m10l-${Date.now().toString(36)}`;
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-thread-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, tag, files })], { cwd: path.resolve(import.meta.dirname, "..") });
  world = worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
});

// The phone project draws the dock in its own test; the rest are at desktop width.
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
  await page.locator("[data-part='composer']").waitFor();
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
    await page.screenshot({ path: path.join(shots, `m10-live-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

const composer = (page: Page) => page.locator("[data-part='composer']");
const send = (page: Page) => composer(page).locator("[data-action='send'], [data-action='reopen']");
const interrupt = (page: Page) => composer(page).getByRole("button", { name: "Interrupt and send" });
const under = (page: Page) => page.locator("[data-part='composer-under']");

test("F-151/c4: S1 mid-turn: the live step reads the step, its progress and the clock, ticks, says a step once, and opens the run so far", async ({ browser }) => {
  const page = await openScene(browser, "s1-working");
  const live = page.locator("[data-part='live-step']");
  await expect(live).toHaveCount(1);
  const line = live.locator("[data-part='live-line']");
  await expect(line).toHaveText("Running pnpm test history · 8 steps done, 1 failed · 3:52");
  await expect(line).toHaveAttribute("aria-expanded", "false");
  // It stands in the open run's place: the turn's first run is a line, and the live step is the last item.
  await expect(page.locator("[data-part='thread-column'] [data-item-kind]").last()).toHaveAttribute("data-item-kind", "run");
  await expect(page.locator("[data-part='thread-column'] [data-part='run']")).toHaveCount(1);
  // `failed` is the one red word.
  await expect(line.locator(".text-red")).toHaveText("failed");
  // The polite live region holds the step and its progress, never the clock.
  const region = live.locator("[data-part='live-announcement']");
  await expect(region).toHaveAttribute("aria-live", "polite");
  await expect(region).toHaveText("Running pnpm test history · 8 steps done, 1 failed");
  if (shots !== undefined) await shoot(page, "s1-working");
  // A second later the clock ticks, and the region says nothing new.
  await page.clock.setFixedTime(new Date(world.now["s1-working"] + 1_000));
  await expect(line.locator("[data-part='live-clock']")).toHaveText("3:53");
  await expect(region).toHaveText("Running pnpm test history · 8 steps done, 1 failed");
  // Pressed, it opens the run so far in place (ticket 10's opened run).
  await line.click();
  await expect(line).toHaveAttribute("aria-expanded", "true");
  await expect(live.locator("[data-part='run-steps'] li").first()).toBeVisible();
  await page.context().close();
});

test("F-151/c4: S5's build turn: the live step names the plan step", async ({ browser }) => {
  const page = await openScene(browser, "s5-approved");
  const line = page.locator("[data-part='live-step'] [data-part='live-line']");
  await expect(line).toHaveText("Editing src/keys/shortcuts.ts · Plan step 1 of 6: Add src/keys/shortcuts.ts: a map from keys to the keypad's actions · 3 steps done · 0:42");
  // The plan's entry gives way first: the steps done and the clock stay whole inside the column.
  const column = await page.locator("[data-part='thread-column']").boundingBox();
  const clock = await line.locator("[data-part='live-clock']").boundingBox();
  expect(column !== null && clock !== null && clock.x + clock.width <= column.x + column.width).toBe(true);
  if (shots !== undefined) await shoot(page, "s5-approved");
  await page.context().close();
});

test("F-151/c4: the composer is one box: Interrupt and send only while a turn runs, both asleep on an empty field, the hint and the model menu under it", async ({ browser }) => {
  // S1 mid-turn: the driver may interrupt.
  const working = await openScene(browser, "s1-working");
  const box = await composer(working).boundingBox();
  expect(box?.height).toBeCloseTo(52, 0);
  await expect(working.getByRole("textbox", { name: "Message the agent" })).toHaveAttribute("placeholder", "Message OpenCode…");
  await expect(interrupt(working)).toBeDisabled();
  await expect(send(working)).toBeDisabled();
  await expect(send(working)).toHaveAttribute("aria-label", "Send");
  expect((await send(working).boundingBox())?.width).toBe(32);
  await expect(under(working).getByTestId("composer-hint")).toHaveText("Send reaches OpenCode at its next step. Interrupt and send stops the turn first.");
  const menu = under(working).getByTestId("composer-next-turn");
  await expect(menu).toHaveText(/^Claude Sonnet 5\.5\s*·\s*High$/);
  await expect(menu).toHaveRole("combobox");
  // Words wake both.
  await working.getByRole("textbox", { name: "Message the agent" }).fill("Keep the empty state from the mock.");
  await expect(interrupt(working)).toBeEnabled();
  await expect(send(working)).toBeEnabled();
  await working.getByRole("textbox", { name: "Message the agent" }).fill("");
  await working.context().close();

  // S1 waiting on the question: no turn to interrupt; the box replies.
  const waiting = await openScene(browser, "s1");
  await expect(interrupt(waiting)).toHaveCount(0);
  await expect(waiting.getByRole("textbox", { name: "Message the agent" })).toHaveAttribute("placeholder", "Reply to OpenCode…");
  await expect(under(waiting).getByTestId("composer-hint")).toHaveText("Send reaches OpenCode after your answer.");
  await expect(send(waiting)).toBeDisabled();
  if (shots !== undefined) await shoot(waiting, "s1");
  await waiting.context().close();

  // S2, in review with its box idle: the driver's message starts the next turn in it.
  const idle = await openScene(browser, "s2");
  await expect(interrupt(idle)).toHaveCount(0);
  await expect(idle.getByRole("textbox", { name: "Message the agent" })).toHaveAttribute("placeholder", "Message OpenCode…");
  await expect(send(idle)).toHaveAttribute("aria-label", "Send");
  await expect(under(idle).getByTestId("composer-hint")).toHaveText("The box is idle. Send starts the next turn in it.");
  if (shots !== undefined) await shoot(idle, "s2");
  await idle.context().close();
});

test("F-151/c4: at phone width the box docks under the chat, its hint and model under it", async ({ browser }) => {
  const page = await openScene(browser, "s1", { width: 390, height: 844 });
  await expect(composer(page)).toBeVisible();
  // F-075: a touch screen keeps every control 44px; the target draws Send at 40.
  expect((await send(page).boundingBox())?.width).toBe(44);
  await expect(under(page).getByTestId("composer-hint")).toHaveText("Send reaches OpenCode after your answer.");
  if (shots !== undefined) await shoot(page, "s1-phone");
  await page.context().close();
});
