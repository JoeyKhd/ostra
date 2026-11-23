import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Browser, Page, Request } from "@playwright/test";
import { z } from "zod";

import { readStack, signIn } from "./helpers.ts";
import { settleRoute } from "./routes.ts";
import { e2eAdmin } from "./settings.ts";

// Milestone 10, ticket 13 (F-151/c4, c5): what waits on a person, on the targets' recorded scenes
// that `seed-thread-world.ts` writes into the stack's database: S1 waiting on OpenCode's question
// (its choices with `Something else…`, `Send answer` asleep until a choice holds a value, the
// watcher's quiet block with `Take over to answer`, the pill on its band while the block is
// scrolled away), S5's plan as a numbered list inside the amber rule, and `states-asks.md`'s
// approvals: the asking step where the live step was, its block under it, two of them in order.
// `OSTRA_E2E_SHOTS` names a folder for the screenshots compared with the targets
// (`app-targets/m10-thread/`), at 1440 × 956 in both themes and at 390 × 844. Run once, at the
// milestone's end.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

const sceneNames = ["s1-working", "s1", "s2", "s3", "s5-plan", "s5-approved"] as const;
type SceneName = (typeof sceneNames)[number] | "asks-1" | "asks-1-two";
const worldSchema = z.object({
  username: z.string(),
  tasks: z.record(z.enum(sceneNames), z.string()),
  now: z.record(z.enum(sceneNames), z.number()),
  asks: z.object({
    tasks: z.object({ "asks-1": z.string(), "asks-1-two": z.string() }),
    now: z.object({ "asks-1": z.number(), "asks-1-two": z.number() }),
  }),
});
type World = z.infer<typeof worldSchema>;

/** The pictures the seed stores: plain stand-ins for Dana's mock and the agent's captures. */
const takePictures = async (browser: Browser): Promise<{ readonly mock: string; readonly desktop: string; readonly phone: string }> => {
  const folder = await mkdtemp(path.join(tmpdir(), "ostra-e2e-asks-"));
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();
  const png = async (name: string, width: number, height: number): Promise<string> => {
    await page.setViewportSize({ width, height });
    await page.setContent(`<!doctype html><body style="margin:0;background:#f4f5f8;font:14px system-ui"><header style="padding:12px 16px;background:#fff"><b style="color:#2f5be0">Tally</b></header></body>`);
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
  const tag = `m10a-${Date.now().toString(36)}`;
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-thread-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, tag, files })], { cwd: path.resolve(import.meta.dirname, "..") });
  world = worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
});

const taskOf = (scene: SceneName): { readonly id: string; readonly now: number } =>
  scene === "asks-1" || scene === "asks-1-two" ? { id: world.asks.tasks[scene], now: world.asks.now[scene] } : { id: world.tasks[scene], now: world.now[scene] };

/** A scene's task page at the scene's own moment, in UTC as the targets draw it, as Sam (the driver) or Alex. */
const openScene = async (browser: Browser, scene: SceneName, as: "sam" | "alex" = "sam", viewport = { width: 1440, height: 956 }): Promise<Page> => {
  const phone = viewport.width < 600;
  const context = await browser.newContext({ viewport, timezoneId: "UTC", ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  const { id, now } = taskOf(scene);
  await page.clock.setFixedTime(new Date(now));
  await signIn(page, as === "sam" ? world.username : `${world.username}-alex`, e2eAdmin.password);
  await page.goto(`/tasks/${id}`);
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
    await page.screenshot({ path: path.join(shots, `m10-13-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

const thread = (page: Page) => page.locator("[data-part='thread-column']");
const viewportOf = (page: Page) => page.locator("[data-part='thread'] .overflow-y-auto").first();

/** Scrolls the thread so the block's top sits just under the thread's visible end: the block is out of view. */
const scrollAbove = async (page: Page, selector: string): Promise<void> => {
  await viewportOf(page).evaluate((root, target) => {
    const block = root.querySelector(target);
    if (block === null) throw new Error(`no ${target}`);
    root.scrollTop += block.getBoundingClientRect().top - root.getBoundingClientRect().bottom + 24;
  }, selector);
};

test("F-151/c5: S1's question: its choices end with Something else…, which opens its field with the focus; Send answer sleeps until a choice holds a value", async ({ browser }) => {
  const page = await openScene(browser, "s1");
  const block = thread(page).getByTestId("question");
  await expect(block).toBeInViewport();
  await expect(block).toHaveAttribute("data-waits", "question");
  const choices = block.getByRole("radiogroup");
  await expect(choices.getByRole("radio")).toHaveCount(3);
  expect(await choices.locator("[data-part='choice']").allInnerTexts()).toEqual(["Replace the display", "Add it to the expression", "Something else…"]);
  for (const radio of await choices.getByRole("radio").all()) await expect(radio).not.toBeChecked();
  const send = block.locator("[data-action='answer-question']");
  await expect(send).toBeDisabled();
  await expect(block).toContainText("OpenCode waits for your answer. Only the driver answers questions.");
  // 30px rows, no field label over a single enum.
  const row = await choices.locator("[data-part='choice']").first().boundingBox();
  expect(row?.height).toBe(30);
  await expect(block.locator("[data-part='question-fields'] p")).toHaveCount(0);
  await page.mouse.click(1, 1);
  await shoot(page, "s1");

  // A choice wakes Send answer and sends nothing.
  let answered = 0;
  page.on("request", (request) => { if (request.url().includes("questions.answer")) answered += 1; });
  await choices.getByRole("radio", { name: "Replace the display" }).click();
  await expect(send).toBeEnabled();
  // Something else… opens its 32px field with the focus; Send answer sleeps again until it holds words.
  await choices.getByText("Something else…").click();
  const field = block.getByRole("textbox", { name: "Your answer, in your own words" });
  await expect(field).toBeFocused();
  // 32px; on a touch screen every field is 44px (F-075).
  const touch = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  expect((await field.boundingBox())?.height).toBe(touch ? 44 : 32);
  await expect(send).toBeDisabled();
  await field.fill("Replace it, but keep the expression in the line above");
  await expect(send).toBeEnabled();
  expect(answered).toBe(0);
  await page.mouse.move(1, 1);
  await field.focus();
  await shoot(page, "asks-4");
  await page.context().close();
});

test("F-151/c5: the pill shows on its band while S1's question is scrolled away, names it, and brings it back with the focus on its first choice", async ({ browser }) => {
  const page = await openScene(browser, "s1");
  const block = thread(page).getByTestId("question");
  const band = page.locator("[data-part='jump-band']");
  await expect(block).toBeInViewport();
  await expect(band).toHaveCount(0);
  // S4: the second run opened, the thread scrolled up to read it.
  await thread(page).locator("[data-part='run']").nth(1).locator("button[aria-expanded]").first().click();
  await scrollAbove(page, "[data-testid='question']");
  await expect(band).toBeVisible();
  const pill = band.getByRole("button");
  await expect(pill).toHaveText("Needs you · question");
  // A solid band 46px tall over the thread's bottom, the composer where it was.
  const bandBox = await band.boundingBox();
  const composer = await page.locator("[data-part='composer']").boundingBox();
  expect(bandBox?.height).toBe(46);
  if (bandBox !== null && composer !== null) expect(composer.y - (bandBox.y + bandBox.height)).toBeGreaterThanOrEqual(0);
  await page.mouse.move(1, 1);
  await shoot(page, "s4");

  await pill.click();
  await expect(block).toBeInViewport();
  await expect(block.getByRole("radio", { name: "Replace the display" })).toBeFocused();
  await expect(band).toHaveCount(0);
  await page.context().close();
});

test("F-151/c5: S1's question on a phone: 44px choices and a full-width Send answer", async ({ browser }) => {
  const page = await openScene(browser, "s1", "sam", { width: 390, height: 844 });
  const block = thread(page).getByTestId("question");
  await block.scrollIntoViewIfNeeded();
  const row = await block.locator("[data-part='choice']").first().boundingBox();
  expect(row?.height).toBeGreaterThanOrEqual(44);
  const send = await block.locator("[data-action='answer-question']").boundingBox();
  expect(send?.height).toBeGreaterThanOrEqual(44);
  await shoot(page, "s6-phone");
  await page.context().close();
});

test("F-151/c5: a watcher's question is quiet and disabled with Take over to answer and no pill; taking over focuses the first choice, and the words sent come back as the receipt", async ({ browser }) => {
  const page = await openScene(browser, "s1", "alex");
  const block = thread(page).getByTestId("question");
  await expect(block).toHaveAttribute("data-tone", "quiet");
  await expect(block).not.toHaveAttribute("data-waits", /.+/);
  const choices = block.getByRole("radiogroup");
  await expect(choices).toHaveAttribute("aria-disabled", "true");
  for (const radio of await choices.getByRole("radio").all()) await expect(radio).toBeDisabled();
  await expect(block.locator("[data-action='answer-question']")).toHaveCount(0);
  await expect(block).toContainText("Sam Rivera answers questions while driving.");
  await page.mouse.move(1, 1);
  await shoot(page, "asks-3");
  // Scrolled away, a quiet block has no pill.
  await scrollAbove(page, "[data-testid='question']");
  await page.waitForTimeout(300);
  await expect(page.locator("[data-part='jump-band']")).toHaveCount(0);
  await viewportOf(page).evaluate((root) => { root.scrollTop = root.scrollHeight; });

  // Take over to answer: Alex drives, and the focus is on the first choice.
  await block.locator("[data-action='take-over-to-answer']").click();
  await expect(block.getByRole("radio", { name: "Replace the display" })).toBeFocused({ timeout: 10_000 });
  await expect(block).toHaveAttribute("data-tone", "amber");

  // Something else…, then ⌘↵ / Ctrl+↵: `questions.answer` carries the words and names the field in `other`.
  await block.getByText("Something else…").click();
  const words = "Replace it, but keep the expression in the line above";
  await block.getByRole("textbox", { name: "Your answer, in your own words" }).fill(words);
  const sent = page.waitForRequest((request: Request) => request.url().includes("questions.answer") && request.method() === "POST");
  await page.keyboard.press("Control+Enter");
  const body = (await sent).postData() ?? "";
  expect(body).toContain(words);
  expect(body).toMatch(/"other":\["[^"]+"\]/);
  // The block becomes its receipt, the words quoted.
  const receipt = thread(page).locator("[data-part='receipt'][data-receipt='question']");
  await expect(receipt).toContainText(`Alex Kim answered “${words}”`, { timeout: 15_000 });
  await expect(thread(page).getByTestId("question")).toHaveCount(0);
  await page.context().close();
});

test("F-151/c5: S5's plan is a numbered list right inside the amber rule, with Approve plan, Edit and approve and Ask for changes to the plan", async ({ browser }) => {
  const page = await openScene(browser, "s5-plan");
  const plan = thread(page).getByTestId("plan");
  await expect(plan).toHaveAttribute("data-waits", "plan");
  const entries = plan.locator("[data-part='plan-entries'] > li");
  await expect(entries).toHaveCount(6);
  await expect(entries.nth(0)).toHaveText("1Add src/keys/shortcuts.ts: a map from keys to the keypad's actions");
  await expect(plan.locator("[data-part='plan-line']")).toHaveCount(0);
  expect(await plan.getByRole("button").allInnerTexts()).toEqual(["Approve plan", "Edit and approve", "Ask for changes to the plan"]);
  await expect(plan).toContainText("Nothing in the repo has changed. OpenCode starts the work from the plan you approve.");
  await page.mouse.move(1, 1);
  await shoot(page, "s5-plan");
  await page.context().close();
});

test("F-151/c4: an approval's block sits under its asking step; two open approvals are two steps and two blocks, in order", async ({ browser }) => {
  const page = await openScene(browser, "asks-1");
  const asking = thread(page).locator("[data-part='asking-step']");
  await expect(asking).toHaveCount(1);
  await expect(asking).toContainText("Wants to run pnpm db:migrate");
  await expect(asking).toContainText("needs approval");
  const block = asking.getByTestId("approval");
  await expect(block).toHaveAttribute("data-waits", "approval");
  await expect(block).toContainText("Database changes asks before OpenCode runs this command:");
  await expect(block.locator("[data-part='subject']")).toHaveText("pnpm db:migrate");
  expect(await block.getByRole("button").allInnerTexts()).toEqual(["Deny", "Approve once", "Approve for this task"]);
  await expect(block.locator("[data-part='for-this-task']")).toHaveText("Approve for this task also approves commands that start with pnpm db:migrate.");
  await expect(block).toContainText("Any member of calculator can answer. The first answer wins.");
  await page.mouse.click(1, 1);
  await shoot(page, "asks-1");
  await page.context().close();

  const two = await openScene(browser, "asks-1-two");
  const steps = thread(two).locator("[data-part='asking-step']");
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toContainText("Wants to run pnpm db:migrate");
  await expect(steps.nth(1)).toContainText("Wants to run pnpm db:reset");
  for (const index of [0, 1]) await expect(steps.nth(index).getByTestId("approval")).toHaveCount(1);
  await expect(steps.nth(0).getByTestId("approval").locator("[data-part='subject']")).toHaveText("pnpm db:migrate");
  await expect(steps.nth(1).getByTestId("approval").locator("[data-part='subject']")).toHaveText("pnpm db:reset");
  await two.mouse.click(1, 1);
  await shoot(two, "asks-1-two");
  await two.context().close();
});
