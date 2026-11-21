import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { z } from "zod";

import { checkContrast, prepareA11y, walkByTab } from "./a11y/checks.ts";
import { readStack, signIn } from "./helpers.ts";
import { settleRoute } from "./routes.ts";
import { e2eAdmin, e2eBaseUrl } from "./settings.ts";

// Milestone 8's ticket 17 (F-121, F-140): the environment's App tab and the thread's pictures, on
// a world `seed-app-world.ts` seeds: a task whose turn took three screenshots and a recording,
// whose box has stopped since; a process another task kept; a refine task with a screenshot. The
// pictures are real: this spec takes them of a small demo app in the browser first (PNGs, and the
// recording's JPEG frames), and the panel reads them back through core. `OSTRA_E2E_SHOTS` names a
// folder for the screenshots compared with the targets (app-targets/m8/environment-app-processes*,
// task-attachments*), at 1440 in both themes and at 390.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const worldSchema = z.object({
  username: z.string(),
  projectId: z.string(),
  historyTaskId: z.string(),
  refineTaskId: z.string(),
  keptProposalId: z.string(),
  pictures: z.object({ desktop: z.string(), tablet: z.string(), phone: z.string(), recording: z.string(), older: z.string(), refine: z.string() }),
});
type World = z.infer<typeof worldSchema>;

/** A small demo app, in its own colours: a calculator with its history beside it. `entries` and `display` change between pictures. */
const demoApp = (entries: number, display: string): string => {
  const rows = Array.from({ length: entries }, (_, i) => `<li><span>${String(1027.6 + i)} × 1.25</span><b>${(1284.5 + i * 1.25).toFixed(2)}</b><button>Use</button></li>`).join("");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
    body{margin:0;font:14px system-ui,sans-serif;background:#f4f5f8;color:#1c2333}
    header{display:flex;gap:16px;align-items:center;padding:12px 16px;background:#fff;border-bottom:1px solid #e3e6ee}
    header b{color:#2f5be0} main{display:flex;flex-wrap:wrap;gap:16px;padding:16px}
    .calc{flex:1 1 280px;background:#fff;border-radius:8px;padding:16px}
    .display{font-size:32px;text-align:right;padding:8px 4px} .keys{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
    .keys span{background:#eef1f7;border-radius:6px;padding:12px;text-align:center} .keys span.op{background:#dce5ff;color:#2f5be0}
    .history{flex:1 1 240px;background:#fff;border-radius:8px;padding:12px} ul{list-style:none;padding:0;margin:0}
    li{display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid #eef0f4} li b{margin-left:auto} li button{font-size:11px}
  </style></head><body><header><b>Tally</b><span>Calculator</span><span>History</span><span>Settings</span></header><main>
    <section class="calc"><div class="display">${display}</div><div class="keys">${["C", "±", "%", "÷", "7", "8", "9", "×", "4", "5", "6", "−", "1", "2", "3", "+", "0", "00", ".", "="].map((key, i) => `<span class="${i % 4 === 3 ? "op" : ""}">${key}</span>`).join("")}</div></section>
    <section class="history"><b>History</b><ul>${rows}</ul></section></main></body></html>`;
};

/** Takes the pictures the seed stores: PNGs at three widths, an older one, a refine task's, and the recording's frames. */
const takePictures = async (browser: Browser): Promise<Record<string, string | string[]>> => {
  const folder = await mkdtemp(path.join(tmpdir(), "ostra-e2e-pictures-"));
  const page = await browser.newPage();
  const png = async (name: string, width: number, height: number, entries: number, display: string): Promise<string> => {
    await page.setViewportSize({ width, height });
    await page.setContent(demoApp(entries, display));
    const file = path.join(folder, `${name}.png`);
    await writeFile(file, await page.screenshot({ type: "png" }));
    return file;
  };
  const desktop = await png("desktop", 1280, 800, 6, "1,284.50");
  const tablet = await png("tablet", 768, 1024, 6, "1,284.50");
  const phone = await png("phone", 390, 844, 6, "1,284.50");
  const older = await png("older", 1280, 800, 2, "0");
  const refine = await png("refine", 1280, 800, 0, "0");
  const frames: string[] = [];
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [i, display] of ["0", "1027.6", "1027.6 × 1.25", "1,284.50", "1,284.50", "1,284.50"].entries()) {
    await page.setContent(demoApp(i < 3 ? 2 : 3, display));
    const file = path.join(folder, `frame-${String(i)}.jpg`);
    await writeFile(file, await page.screenshot({ type: "jpeg", quality: 60 }));
    frames.push(file);
  }
  await page.close();
  return { desktop, tablet, phone, older, refine, frames };
};

const seed = async (browser: Browser): Promise<World> => {
  const { databaseUrl } = await readStack();
  const files = await takePictures(browser);
  const tag = `t17-${Date.now().toString(36)}`;
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-app-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, tag, files })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

/** The member's theme, saved through the panel's own API, as the theme menu saves it. */
const chooseTheme = async (page: Page, theme: "dark" | "light"): Promise<void> => {
  await page.waitForLoadState("networkidle");
  const response = await page.request.post("/api/trpc/account.setTheme", { data: { theme }, headers: { origin: e2eBaseUrl } });
  expect(response.ok()).toBe(true);
};

/** The page at 1440 (or 390) in both themes, for the by-eye check against the targets. */
const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  await page.mouse.move(0, 0);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(shots, `m8-t17-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

/** Every picture of the strip has loaded its file: drawn from the panel's download route. */
const expectDrawn = async (page: Page): Promise<void> => {
  await expect
    .poll(() => page.locator("[data-testid='attachment-strip'] img").evaluateAll((images) => images.length > 0 && images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)))
    .toBe(true);
};

let world: World;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  world = await seed(browser);
});

test("F-121/c4,c5,c7: a turn's screenshots and recording show in the thread after its box stopped and after a reload, the viewer moves through them, the player plays and pauses, and a refine task's screenshot goes into its draft", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 956 });
  await signIn(page, world.username);
  await page.goto(`/tasks/${world.historyTaskId}`);

  // The turn's run of three screenshots, at its place, then the recording, then where they're kept.
  const runs = page.locator("[data-part='attachments']");
  await expect(runs).toHaveCount(3);
  const shotsRun = runs.filter({ has: page.locator("[data-verb]", { hasText: "Captured" }) }).filter({ hasText: "3 screenshots of" });
  await expect(shotsRun.getByTestId("attachment-thumb")).toHaveCount(3);
  await expect(shotsRun.getByTestId("attachment-thumb").locator("span.font-mono")).toHaveText(["1280 · /history", "768", "390"]);
  await expect(shotsRun.getByTestId("attachment-browser")).toContainText("Taken in Chromium 131.0.6778.85");
  const recordingRun = runs.filter({ has: page.locator("[data-verb]", { hasText: "Recorded" }) });
  await expect(recordingRun).toContainText("Add, reload, reuse a result");
  await expect(recordingRun).toContainText("0:02 · 4 steps");
  await expect(recordingRun.getByTestId("attachments-where")).toContainText("In the description of PR #486, and kept with the task");
  // The agent's picture calls are folded into the rows: no tool row of theirs.
  await expect(page.getByText("ostra_take_screenshot")).toHaveCount(0);
  // The box stopped since (the session ended): the pictures are drawn from their files all the same.
  await expect(page.locator("[data-part='session-end']")).toHaveCount(1);
  await expectDrawn(page);
  await expect(page.getByTestId("attachments-group")).toContainText("4 screenshots · 1 recording");

  // A failed start of the API is a red line with its log's tail.
  const failed = page.locator("[data-part='app-process'][data-state='exited']");
  await expect(failed).toContainText("api exited 1");
  await failed.getByRole("button", { name: "Show log" }).click();
  await expect(failed.getByTestId("app-log-tail")).toContainText("EADDRINUSE");

  await shotsRun.scrollIntoViewIfNeeded();
  await shoot(page, "thread");

  // After a reload: the same.
  await page.reload();
  await expect(page.locator("[data-part='attachments']")).toHaveCount(3);
  await expectDrawn(page);

  // The viewer: the first screenshot, the turn's four in its filmstrip, ← and →, Compare, Escape.
  const first = shotsRun.getByRole("button", { name: /^Screenshot of \/history at 1280 wide/ });
  await first.click();
  const viewer = page.getByTestId("attachment-viewer");
  await expect(viewer).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`attachment=${world.pictures.desktop}`));
  await expect(viewer.getByTestId("viewer-position")).toContainText("1 of 4");
  await expect(viewer.getByTestId("viewer-picture")).toHaveJSProperty("complete", true);
  await expect(viewer.getByTestId("viewer-browser")).toHaveText("Chromium 131.0.6778.85");
  await shoot(page, "viewer");
  await viewer.getByRole("button", { name: /^Compare with/ }).click();
  await expect(viewer.getByTestId("attachment-compare")).toBeVisible();
  await viewer.getByRole("slider", { name: "Before and after" }).press("ArrowRight");
  await expect(viewer.getByRole("slider", { name: "Before and after" })).toHaveAttribute("aria-valuenow", "55");
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(first).toBeFocused();

  // The recording plays and pauses in ostra's player, its steps beside it.
  await recordingRun.getByRole("button", { name: /^Recording of/ }).click();
  const player = page.getByTestId("recording-player");
  await expect(player.getByTestId("recording-frame")).toBeVisible();
  await expect(page.getByTestId("recording-steps").getByRole("button")).toHaveText(["1Open /", "2Fill #amount with “1027.6 × 1.25”", "3Click “Add”", "4Press F5"]);
  await expect(player).toHaveAttribute("data-state", "paused");
  await player.getByRole("button", { name: "Play" }).click();
  await expect(player).toHaveAttribute("data-state", "playing");
  await expect(player.getByTestId("recording-time")).not.toHaveText(/^0:00 \//);
  await player.getByRole("button", { name: "Pause" }).click();
  await expect(player).toHaveAttribute("data-state", "paused");
  const pausedAt = await player.getByTestId("recording-time").textContent();
  await page.waitForTimeout(800);
  await expect(player.getByTestId("recording-time")).toHaveText(pausedAt ?? "");
  // A step seeks the reel.
  await page.getByTestId("recording-steps").getByRole("button", { name: /Press F5/ }).click();
  await expect(page.getByTestId("recording-steps").getByRole("button", { name: /Press F5/ })).toHaveAttribute("aria-current", "step");
  await page.keyboard.press("Escape");

  // The PR's link lands on the first picture's row.
  await page.goto(`/tasks/${world.historyTaskId}#attachments`);
  await expect(page.locator("#attachments")).toBeInViewport();

  // "Add to draft" on the refine task: the screenshot joins the draft's images.
  await page.goto(`/tasks/${world.refineTaskId}?tab=activity&attachment=${world.pictures.refine}`);
  const refineViewer = page.getByTestId("attachment-viewer");
  await refineViewer.getByRole("button", { name: "Add to draft" }).click();
  await expect(refineViewer.getByRole("button", { name: "In the draft" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.goto(`/tasks/${world.refineTaskId}?tab=draft`);
  const images = page.locator("[data-field='images'] li");
  await expect(images).toHaveCount(1);
  await expect(images.locator("img")).toHaveJSProperty("complete", true);
});

test("F-140/c1,c2,c3,c9: the App tab lists the processes with their last box, refuses in the API's words what the API refuses, and a kept process accepted with its command joins the list", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 956 });
  await signIn(page, world.username);
  await page.goto(`/projects/${world.projectId}/environment?tab=app`);
  const table = page.getByRole("table", { name: "App processes" });
  await expect(table.locator("tr[data-process]")).toHaveCount(2);
  const web = table.locator("tr[data-process='web']");
  await expect(web).toContainText("primary");
  await expect(web).toContainText("calculator-web · pnpm dev");
  await expect(web.locator("[data-last-box='ready']").last()).toContainText("ready");
  await expect(table.locator("tr[data-process='api']")).toContainText("HTTP/health");
  await expect(table.locator("tr[data-kept='storybook']")).toContainText("Sam Rivera kept it from");
  await expect(page.getByRole("table", { name: "Services with a web UI" }).locator("tr[data-web-ui='mailpit']")).toContainText("Yes");
  await expect(page.getByTestId("screenshot-settings").locator("[data-route]")).toHaveText(["/", "/history", "/settings"]);
  await expect(page.getByTestId("in-box-addresses")).toContainText("OSTRA_APP_WEB_URL");
  await expect(page.getByTestId("box-browser")).toContainText("Chromium 131");
  await shoot(page, "app");

  // The sheet: a ready check's path without its `/` is refused on blur, in words, and the save waits.
  await table.locator("tr[data-process='api']").click();
  const sheet = page.getByTestId("app-process-sheet");
  await expect(sheet.getByRole("heading", { name: "Edit api" })).toBeVisible();
  const path = sheet.getByLabel("The path it answers on");
  await path.fill("health");
  await sheet.getByLabel("Port").focus();
  await expect(sheet.getByText("A path starts with /, such as /health.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Save process" })).toBeDisabled();
  await shoot(page, "app-sheet");
  await path.fill("/health");
  // A port the list has already: the API's own words.
  await sheet.getByLabel("Port").fill("5173");
  await sheet.getByLabel("Command").focus();
  await expect(sheet.getByText("Two app processes listen on port 5173: each port is used once.")).toBeVisible();
  await sheet.getByLabel("Port").fill("3001");
  await sheet.getByLabel("Command").fill("pnpm start:dev --watch");
  await sheet.getByRole("button", { name: "Save process" }).click();
  await expect(sheet).toBeHidden();
  await expect(table.locator("tr[data-process='api']")).toContainText("pnpm start:dev --watch");
  // The start order is kept: api is still second.
  await expect(table.locator("tr[data-process]")).toHaveText([/^web/, /^api/]);

  // The kept process: Review, name its command, Accept: it joins the list's end.
  await table.locator("tr[data-kept='storybook']").getByRole("button", { name: "Review" }).click();
  await expect(sheet.getByRole("heading", { name: "Keep storybook" })).toBeVisible();
  await sheet.getByLabel("Command").fill("pnpm storybook --port 6006 --ci");
  await sheet.getByRole("button", { name: "Accept" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("app-said")).toContainText("storybook is part of the environment now");
  await expect(table.locator("tr[data-process]")).toHaveText([/^web/, /^api/, /^storybook/]);
  await expect(table.locator("tr[data-kept]")).toHaveCount(0);
});

test("F-081/c2: the keyboard walk and the contrast check pass on the App tab, its sheet, the thread's pictures and the viewer, in both themes", async ({ page }) => {
  test.setTimeout(240_000);
  await prepareA11y(page);
  await signIn(page, world.username);
  const problems: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    await chooseTheme(page, theme);
    const visit = async (url: string, ready: () => Promise<void>, label: string): Promise<void> => {
      await page.goto(url);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await ready();
      // The shell draws too (the panel's Live list lands a round trip after the page's own data):
      // the walk numbers the controls once, so it starts when nothing changes any more.
      await settleRoute(page);
      problems.push(...(await checkContrast(page, null)).failures.map((failure) => `${label} (${theme}): ${failure}`));
      problems.push(...(await walkByTab(page, null)).map((problem) => `${label} (${theme}): ${problem}`));
    };
    await visit(`/projects/${world.projectId}/environment?tab=app`, () => expect(page.locator("tr[data-process='web']")).toBeVisible(), "the App tab");
    await page.locator("tr[data-process='web']").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("app-process-sheet")).toBeVisible();
    problems.push(...(await checkContrast(page, "[data-testid='app-process-sheet']")).failures.map((failure) => `the sheet (${theme}): ${failure}`));
    problems.push(...(await walkByTab(page, "[data-testid='app-process-sheet']")).map((problem) => `the sheet (${theme}): ${problem}`));
    await page.keyboard.press("Escape");
    await visit(`/tasks/${world.historyTaskId}`, () => expectDrawn(page), "the thread's pictures");
    await page.getByTestId("attachment-thumb").first().getByRole("button").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("attachment-viewer")).toBeVisible();
    problems.push(...(await checkContrast(page, "[data-testid='attachment-viewer']")).failures.map((failure) => `the viewer (${theme}): ${failure}`));
    problems.push(...(await walkByTab(page, "[data-testid='attachment-viewer']")).map((problem) => `the viewer (${theme}): ${problem}`));
    await page.keyboard.press("Escape");
  }
  expect(problems).toEqual([]);
});

test("the pages at phone width, for the by-eye check", async ({ page }) => {
  test.skip(shots === undefined, "only for the screenshots");
  await signIn(page, world.username);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${world.projectId}/environment?tab=app`);
  await expect(page.locator("tr[data-process='web']")).toBeVisible();
  await shoot(page, "app-390");
  await page.goto(`/tasks/${world.historyTaskId}`);
  await expectDrawn(page);
  await page.locator("[data-part='attachments']").first().scrollIntoViewIfNeeded();
  await shoot(page, "thread-390");
  await page.setViewportSize({ width: 1440, height: 956 });
  await page.goto(`/projects/${world.projectId}/environment?tab=app`);
  await expect(page.locator("tr[data-process='web']")).toBeVisible();
  await shoot(page, "app-1440");
});
