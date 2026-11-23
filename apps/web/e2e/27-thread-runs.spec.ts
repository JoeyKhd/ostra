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

// Milestone 10, ticket 10 (F-151/c2, c3, c8): a run's line, the opened run and failures, on the
// targets' recorded scenes that `seed-thread-world.ts` writes into the stack's database (S1 waiting
// on OpenCode's question, S3 the AI review of PR #483). A run's line says its counts and its tail,
// `failed` its only red word; pressed, its steps open in order on one grid, each with its result
// and its link, the turn's footer last; `output ›` opens one more level and reads `hide output ›`;
// the unrecovered fetch has its own red line whose `details ›` opens the run at it. The page shows
// each scene at its own moment (the clock fixed there, in UTC). `OSTRA_E2E_SHOTS` names a folder
// for the screenshots compared with the targets (`s4`, `states-steps`, `s3`), 1440 × 956, both
// themes. Run once, at the milestone's end.

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
  const folder = await mkdtemp(path.join(tmpdir(), "ostra-e2e-runs-"));
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
  const tag = `m10r-${Date.now().toString(36)}`;
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-thread-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, tag, files })], { cwd: path.resolve(import.meta.dirname, "..") });
  world = worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
});

/** A scene's task page at the scene's own moment, in UTC as the targets draw it. */
const openScene = async (browser: Browser, scene: SceneName): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 956 }, timezoneId: "UTC" });
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

/** The page in both themes, for the by-eye check against the targets. */
const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.mouse.move(0, 0);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shots, `m10-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

/** The words of a run's line, and the ones in red. */
const lineWords = async (run: Locator): Promise<{ readonly text: string; readonly red: string[] }> => ({
  text: (await run.locator("[data-part='run-words']").innerText()).trim(),
  red: await run.locator("[data-part='run-words'] .text-red").allInnerTexts(),
});

test("F-151/c2, c3, c8: S1's runs: the line and its one red word, then opened, each step on its row with its result and link, the footer last", async ({ browser }) => {
  const page = await openScene(browser, "s1");
  const column = page.locator("[data-part='thread-column']");
  const [first, second] = [column.locator("[data-part='run']").nth(0), column.locator("[data-part='run']").nth(1)];
  expect(await lineWords(first)).toEqual({ text: "Thought for 6s, read 4 files", red: [] });
  // A failure the turn recovered from is one red word in the tail, and no line of its own.
  expect(await lineWords(second)).toEqual({ text: "Edited 2 files, ran 2 commands, took a screenshot · 1 failed, then passed", red: ["failed"] });
  await expect(column.locator("[data-part='failure']")).toHaveCount(0);
  // The capture under the run that took it, captioned with its own route.
  await expect(column.locator("[data-part='captures']")).toContainText("1280 · /history");

  // Pressed, the run opens in place: its steps in order, as a list, the footer its last row.
  const press = second.getByRole("button", { expanded: false });
  await press.click();
  await expect(second.getByRole("button", { expanded: true }).first()).toBeVisible();
  const steps = second.locator("[data-part='run-steps']");
  const rows = steps.getByRole("list").locator(":scope > li");
  await expect(rows).toHaveCount(7);
  expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-step")))).toEqual(["edit", "edit", "command", "thought", "edit", "command", "capture"]);
  await expect(rows.nth(1)).toContainText("src/history/panel.tsx");
  await expect(rows.nth(1)).toContainText("+118 −6");
  await expect(rows.nth(2).locator("[data-part='step-result'] .text-red")).toHaveText("exit 1");
  await expect(rows.nth(5).locator("[data-part='step-result']")).toContainText("exit 0 · 3.8 s");
  await expect(rows.nth(6)).toContainText("a screenshot of /history");
  // A path reads relative to the repo, the full one in its `title`.
  const path0 = rows.nth(0).locator("[data-part='step-subject']");
  await expect(path0).toHaveText("src/history/store.ts");
  expect(await path0.getAttribute("title")).toMatch(/src[\\/]history[\\/]store\.ts$/);
  expect(await path0.getAttribute("title")).not.toBe("src/history/store.ts");
  // The footer is the opened run's last row.
  expect(await steps.evaluate((element) => element.lastElementChild?.getAttribute("data-part"))).toBe("run-footer");
  await expect(steps.locator("[data-part='run-footer']")).toContainText("Turn 1");
  await scrollTo(second, 422);
  await shoot(page, "s4");

  // `output ›` opens the command's output under its row and reads `hide output ›`.
  const output = rows.nth(2).getByRole("button", { name: "Show the output of pnpm test history" });
  await expect(output).toHaveText("output");
  await output.click();
  await expect(rows.nth(2).getByRole("button", { name: "Hide the output of pnpm test history" })).toHaveText("hide output");
  await expect(rows.nth(2).locator("[data-part='step-output']")).toBeVisible();
  // The first run, opened: its thought and every read on one row, by the files' names.
  await first.getByRole("button", { expanded: false }).click();
  const reads = first.locator("[data-step='read']");
  await expect(reads).toHaveCount(1);
  await expect(reads.locator("[data-part='step-subject']")).toHaveText(/^[\w.-]+(, [\w.-]+){3}$/);
  await scrollTo(second, 300);
  await shoot(page, "s4-output");
  // Pressed again, the run folds, and what was open in it with it.
  await second.getByRole("button", { expanded: true }).first().click();
  await expect(second.locator("[data-part='run-steps']")).toHaveCount(0);
  await page.context().close();
});

test("F-151/c2, c8: S3's 23 steps on one line, the unrecovered fetch on its own red line, its details opening the run at it", async ({ browser }) => {
  const page = await openScene(browser, "s3");
  const column = page.locator("[data-part='thread-column']");
  const turn2 = column.locator("[data-part='run']").nth(1);
  expect(await lineWords(turn2)).toEqual({ text: "23 steps: read 9 files, searched the web 3 times, fetched 1 page, ran 8 commands, used 2 tools", red: [] });
  const failure = column.locator("[data-part='failure']");
  await expect(failure).toHaveCount(1);
  await expect(failure).toContainText("Fetch failed");
  await expect(failure).toContainText("finance.acme.dev/rounding");
  await expect(failure).toContainText("· 403 Forbidden, not retried");
  await expect(failure.locator("span.text-red")).toHaveText("Fetch failed");
  await shoot(page, "s3");

  // `details ›` opens the run at the fetch, its details open, the focus on its link.
  await failure.getByRole("button", { name: "Show the details of finance.acme.dev/rounding" }).click();
  await expect(turn2.getByRole("button", { expanded: true }).first()).toBeVisible();
  const fetch = turn2.locator("[data-step='fetch']");
  await expect(fetch.locator("[data-part='step-result'] .text-red")).toHaveText("403 Forbidden");
  await expect(fetch.locator("[data-part='step-output']")).toContainText("403");
  await expect(fetch.getByRole("button", { name: "Hide the details of finance.acme.dev/rounding" })).toBeFocused();
  // A generic tool by its name, its MCP server faint before it, never `other`; ostra's hand-in in its own words.
  const tool = turn2.locator("[data-step='tool']").first();
  await expect(tool).toContainText("Used");
  await expect(tool.locator("[data-part='step-subject']")).toHaveText("github get_pull_request");
  await expect(tool.locator("[data-part='step-subject'] .text-faint")).toHaveText("github");
  await expect(turn2.locator("[data-part='run-steps']")).not.toContainText("other");
  await expect(turn2.locator("[data-step='ostra']")).toContainText("Submitted the review");
  await expect(turn2.locator("[data-step='ostra']")).toContainText("already submitted, kept as it was");
  await expect(turn2.locator("[data-step='ostra'] .text-red")).toHaveCount(0);
  await scrollTo(turn2, 160);
  await shoot(page, "s3-open");
  await page.context().close();
});
