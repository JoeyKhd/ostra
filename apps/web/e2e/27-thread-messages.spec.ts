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

// Milestone 10, ticket 12 (F-151/c1, F-151/c5): a member's message, ostra's and GitHub's, receipts
// and dividers, on the targets' recorded scenes and the messages sheet's cells that
// `seed-thread-world.ts` writes into the stack's database: S3's outlined AI review and Sam's filled
// bubble, S5's "What the agent got" and the plan's receipt with `Show the plan ›`, a CI round with
// its jobs, a findings round with its hold, an `@ostra` comment from GitHub, comments on the diff,
// and the dividers between turns. Each page at its own moment, in UTC as the targets draw it.
// `OSTRA_E2E_SHOTS` names a folder for the screenshots compared with the targets
// (`app-targets/m10-thread/`), at 1440 × 956 in both themes. Run once, at the milestone's end.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

const sceneNames = ["s1-working", "s1", "s2", "s3", "s5-plan", "s5-approved"] as const;
const cellNames = ["messages-1", "messages-2", "messages-3", "messages-4", "messages-5"] as const;
type SceneName = (typeof sceneNames)[number];
type CellName = (typeof cellNames)[number];
const worldSchema = z.object({
  username: z.string(),
  tasks: z.record(z.enum(sceneNames), z.string()),
  now: z.record(z.enum(sceneNames), z.number()),
  cells: z.record(z.enum(cellNames), z.string()),
  cellNow: z.record(z.enum(cellNames), z.number()),
});
type World = z.infer<typeof worldSchema>;

/** A plain picture for the seed's files: these specs read none of them. */
const takePictures = async (browser: Browser): Promise<{ readonly mock: string; readonly desktop: string; readonly phone: string }> => {
  const folder = await mkdtemp(path.join(tmpdir(), "ostra-e2e-messages-"));
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
  const tag = `m10m-${Date.now().toString(36)}`;
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-thread-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, tag, files })], { cwd: path.resolve(import.meta.dirname, "..") });
  world = worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
});

/** A task's page at its own moment, in UTC as the targets draw it. */
const openTask = async (browser: Browser, taskId: string, now: number, viewport = { width: 1440, height: 956 }): Promise<Page> => {
  const context = await browser.newContext({ viewport, timezoneId: "UTC" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(now));
  await signIn(page, world.username, e2eAdmin.password);
  await page.goto(`/tasks/${taskId}`);
  await settleRoute(page);
  await page.locator("[data-part='thread-column'] [data-message-id]").first().waitFor();
  return page;
};
const openScene = (browser: Browser, scene: SceneName): Promise<Page> => openTask(browser, world.tasks[scene], world.now[scene]);
const openCell = (browser: Browser, cell: CellName): Promise<Page> => openTask(browser, world.cells[cell], world.cellNow[cell]);

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
  // And on a phone (390 × 844), scrolled to the thread's end as it opens.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, `m10-${name}-phone-${theme}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 956 });
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

test("F-151/c1: S3: ostra's AI review is outlined and named ostra · automatic; Sam's message is filled under his name", async ({ browser }) => {
  const page = await openScene(browser, "s3");
  const bubbles = page.locator("[data-part='thread-column'] [data-part='bubble']");
  await expect(bubbles).toHaveCount(2);
  const review = bubbles.nth(0);
  await expect(review).toHaveAttribute("data-look", "outlined");
  await expect(review.locator("[data-part='bubble-by']")).toContainText("ostra");
  await expect(review.locator("[data-part='bubble-by']")).toContainText("· automatic");
  await expect(review).toContainText("AI review of PR #483, round 2 of 3");
  await expect(review).toContainText("3 files, +203 −6 · the PR's commits, CALC-192 and its criteria");
  // What the agent got opens the review's folded text in place.
  await review.locator("[data-action='what-the-agent-got']").click();
  await expect(review.locator("[data-part='review-got']")).toContainText("acme/calculator-web#483");
  await review.locator("[data-action='what-the-agent-got']").click();
  const asked = bubbles.nth(1);
  await expect(asked).toHaveAttribute("data-look", "filled");
  await expect(asked.locator("[data-part='bubble-by']")).toHaveText(/^Sam Rivera\s*15:31$/);
  // The outlined bubble has no fill; the filled one is `--sel`.
  const fills = await bubbles.locator("[data-part='bubble-box']").evaluateAll((boxes) => boxes.map((box) => getComputedStyle(box).backgroundColor));
  expect(fills[0]).toBe("rgba(0, 0, 0, 0)");
  expect(fills[1]).not.toBe("rgba(0, 0, 0, 0)");
  await shoot(page, "s3-messages");
  await page.context().close();
});

test("F-151/c5: S5 approved: What the agent got, then the plan's receipt in its place, opening the plan with its marks", async ({ browser }) => {
  const page = await openScene(browser, "s5-approved");
  const column = page.locator("[data-part='thread-column']");
  // "What the agent got" is the first bubble, filled, under the member its message is written as.
  const got = column.locator("[data-part='ticket-context']");
  await expect(got.locator("[data-part='bubble-by']")).toContainText("Priya Shah");
  await expect(got.locator("[data-part='ticket-source']")).toHaveText("CALC-196from Linear · what the agent got");
  await expect(got).toContainText("Add keyboard shortcuts to the keypad");
  await expect(got).toContainText("2 comments");
  // The plan's block became one receipt line, between the plan turn and the build turn's marker.
  const receipt = column.locator("[data-part='receipt'][data-receipt='plan-approved']");
  await expect(receipt).toContainText("Plan approved by Alex Kim, with edits");
  await expect(receipt).toContainText("14:09");
  await expect(column.locator("[data-part='bubble']")).toHaveCount(0);
  await expect(column.locator("[data-divider='build-turn']")).toContainText("OpenCode works from the approved plan. Plan mode is off.");
  const order = await column.locator("[data-part='receipt'], [data-divider='build-turn'], [data-divider='plan-turn']").evaluateAll((parts) => parts.map((part) => part.getAttribute("data-divider") ?? "receipt"));
  expect(order).toEqual(["plan-turn", "receipt", "build-turn"]);
  await shoot(page, "s5-approved-messages");
  // Show the plan opens it: each entry with its progress mark, `edited` on the one Alex changed.
  await receipt.locator("[data-action='show-plan']").click();
  await expect(receipt.locator("[data-action='show-plan']")).toHaveAttribute("aria-expanded", "true");
  const rows = receipt.locator("[data-part='plan-shown'] li");
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(0)).toHaveAttribute("data-status", "in_progress");
  await expect(rows.nth(1)).toHaveAttribute("data-status", "pending");
  await expect(rows.nth(3)).toHaveAttribute("data-edited", "true");
  await expect(rows.nth(3)).toContainText("⌘Z and Ctrl+Z undo the last key");
  await expect(rows.nth(3)).toContainText("edited");
  await shoot(page, "s5-approved-plan-open");
  await page.context().close();
});

test("F-151/c1: the messages sheet: a CI round, a held findings round, an @ostra comment, diff comments and the dividers between turns", async ({ browser }) => {
  // Cell 1: a CI round, outlined, with its round of its limit, the automatic turn and each failing job's log.
  const ci = await openCell(browser, "messages-1");
  const round = ci.locator("[data-part='bubble'][data-round='ci']");
  await expect(round).toHaveAttribute("data-look", "outlined");
  await expect(round.locator("[data-part='bubble-by']")).toHaveText(/^ostra\s*10:31\s*· automatic$/);
  await expect(round).toContainText("CI round 1 of 2 · automatic turn 1 of 4");
  await expect(round.locator("[data-item='check']")).toHaveCount(2);
  await expect(round.locator("[data-item='check']").nth(0)).toContainText("unit-tests");
  await expect(round.locator("[data-item='check'] [data-log]")).toHaveCount(2);
  await shoot(ci, "messages-1");
  await ci.context().close();

  // Cell 2: a findings round the budget held, its hold inside its bubble; no notice line for it.
  const findings = await openCell(browser, "messages-2");
  const held = findings.locator("[data-part='bubble'][data-round='findings']");
  await expect(held).toContainText("Findings round 1 of 2 · automatic turn 2 of 4");
  await expect(held).toContainText("Sent 1 blocking finding: The store keeps 51 results. 1 nit listed, not required.");
  await expect(held.locator("[data-part='round-held']")).toContainText("Held 9 min: the project's budget for November was reached. Released when Priya Shah raised it.");
  await expect(findings.locator("[data-part='thread-column'] [data-part='notice']")).toHaveCount(0);
  await shoot(findings, "messages-2");
  await findings.context().close();

  // Cell 3: an @ostra comment came from GitHub: outlined, named by its login, Open on GitHub and Remember this.
  const comment = await openCell(browser, "messages-3");
  const fromGitHub = comment.locator("[data-part='bubble'][data-from='github']");
  // It waits for the turn's end, so it says `queued` too.
  await expect(fromGitHub.locator("[data-part='bubble-by']")).toHaveText(/^sam-rivera on GitHub\s*15:02\s*· PR comment\s*· queued$/);
  await expect(fromGitHub).toContainText("src/history/panel.tsx:42");
  await expect(fromGitHub.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute("href", /#discussion_r42$/);
  await expect(fromGitHub.locator("[data-action='remember-this']")).toBeVisible();
  await shoot(comment, "messages-3");
  await comment.context().close();

  // Cell 4: comments on the diff, filled: each where it is and its words.
  const diff = await openCell(browser, "messages-4");
  const sent = diff.locator("[data-part='bubble'][data-kind='diff-comments']");
  await expect(sent).toHaveAttribute("data-look", "filled");
  await expect(sent.locator("[data-part='bubble-by']")).toHaveText(/^Sam Rivera\s*15:06\s*· 2 comments on the diff\s*· queued$/);
  await expect(sent.locator("[data-diff-comment]")).toHaveCount(2);
  await expect(sent).toContainText("src/history/panel.tsx:18");
  await expect(sent).toContainText("Name it HISTORY_LIMIT.");
  await shoot(diff, "messages-4");
  await diff.context().close();

  // Cell 5: between turns, the day, how the session came back on its runner, a new driver; `reopened the task` and `queued`.
  const between = await openCell(browser, "messages-5");
  const column = between.locator("[data-part='thread-column']");
  const kinds = await column.locator("[data-part='divider']").evaluateAll((dividers) => dividers.map((divider) => divider.getAttribute("data-divider")));
  expect(kinds).toEqual(["day", "restored", "driver"]);
  await expect(column.locator("[data-divider='restored']")).toContainText("Restored from the session archive on build-fleet-03 · unfinished work restored");
  await expect(column.locator("[data-divider='driver']")).toContainText("Sam Rivera is driving now (Alex Kim handed it over)");
  await expect(column.locator("[data-tag='reopen']")).toHaveText("· reopened the task");
  await expect(column.locator("[data-tag='queued']")).toHaveText("· queued");
  await expect(column).not.toContainText("The runner connected");
  await shoot(between, "messages-5");
  await between.context().close();
});
