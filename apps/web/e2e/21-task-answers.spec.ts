import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { z } from "zod";

import { readStack, signIn } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// Milestone 3's ticket 43 (F-026, F-063, F-024, F-084): the task page answers what the scripted fake
// agent asked, with two members. The rows core writes when the agent reaches each point are seeded
// (`seed-answers.ts`); every answer after that goes through the page and the API: the approval
// race, "Approve for this task" with its pattern and the task rule, a deny with a reason, a plan
// approved after an edit, a watcher who can't send and takes over, and usage against `tasks.get`.

const run = promisify(execFile);
const MEMBER = "e2e-answers-sam";

const seededSchema = z.object({ race: z.string(), rule: z.string(), deny: z.string(), plan: z.string(), watched: z.string(), counted: z.string() });

/** A fresh set of tasks for one test, and the second member. */
const seed = async (): Promise<z.infer<typeof seededSchema>> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-answers.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, member: MEMBER })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return seededSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

/** The second member, signed in in a browser of their own. */
const asSam = async (page: Page): Promise<Page> => {
  const context = await page.context().browser()?.newContext({ viewport: page.viewportSize() ?? { width: 1440, height: 900 } });
  if (context === undefined) throw new Error("no browser");
  const sam = await context.newPage();
  await signIn(sam, MEMBER, e2eAdmin.password);
  return sam;
};

const composer = (page: Page) => page.locator("[data-part='composer'] textarea");

test("F-026/c4,c5: two members answer one approval at once; one wins, and the other sees \"Someone answered this first\" under the winner's receipt", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  const tasks = await seed();
  const sam = await asSam(page);
  for (const tab of [page, sam]) await tab.goto(`/tasks/${tasks.race}`);
  const cards = [page, sam].map((tab) => tab.getByTestId("approval"));
  for (const card of cards) await expect(card.locator("[data-action='approve-once']")).toBeEnabled();

  // Both answers leave their browsers before either is answered: the server decides the race.
  const held: Route[] = [];
  let release = (): void => undefined;
  const bothSent = new Promise<void>((resolve) => { release = resolve; });
  const hold = async (route: Route): Promise<void> => {
    held.push(route);
    if (held.length === 2) release();
    await bothSent;
    await route.continue();
  };
  for (const tab of [page, sam]) await tab.route((url) => url.pathname.includes("approvals.answer"), hold);
  await Promise.all(cards.map((card) => card.locator("[data-action='approve-once']").click()));

  // Each browser shows the one winner's receipt; only the loser has the line under it.
  const receipts = await Promise.all(
    [page, sam].map(async (tab) => {
      const receipt = tab.locator("[data-part='approval']").filter({ hasText: /^Approved once by / });
      await expect(receipt).toBeVisible({ timeout: 10_000 });
      return receipt.textContent();
    }),
  );
  expect(receipts[0]).toBe(receipts[1]);
  await expect.poll(async () => (await page.locator("[data-part='lost-race']").count()) + (await sam.locator("[data-part='lost-race']").count())).toBe(1);
  const loser = (await page.locator("[data-part='lost-race']").count()) === 1 ? page : sam;
  await expect(loser.locator("[data-part='lost-race']")).toHaveText("Someone answered this first.");
  // The loser's line stays: a reload is the only thing that drops it (it's this browser's, not the task's).
  await loser.waitForTimeout(1_000);
  await expect(loser.locator("[data-part='lost-race']")).toBeVisible();
  await sam.context().close();
});

test("F-026/c3,c4: \"Approve for this task\" shows the pattern it adds, then the receipt names it and the task's Approval rules list it", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  const tasks = await seed();
  await page.goto(`/tasks/${tasks.rule}`);
  const card = page.getByTestId("approval");
  await expect(card).toContainText("Settings files");
  await expect(card.locator("[data-part='subject']")).toHaveText("config/settings.json");
  await expect(card.locator("[data-part='for-this-task']")).toHaveText("Approve for this task also approves later requests that match: Edit config/settings.json in this task.");
  await card.locator("[data-action='approve-task']").click();

  const receipt = page.locator("[data-part='approval']").filter({ hasText: /^Approved for this task by / });
  await expect(receipt).toHaveText(/^Approved for this task by .+ · config\/settings\.json$/, { timeout: 10_000 });
  await expect(page.getByTestId("approval")).toHaveCount(0);
  const rule = page.getByTestId("task-rule");
  await expect(rule).toHaveCount(1);
  await expect(rule).toContainText("edit config/settings.json");
  await expect(rule).toContainText("this task ·");
  // Stored, not only shown.
  await page.reload();
  await expect(page.locator("[data-part='approval']").filter({ hasText: /^Approved for this task by / })).toContainText("config/settings.json");
  await expect(page.getByTestId("task-rule")).toContainText("edit config/settings.json");
});

test("F-026/c4: a deny takes a reason, and the receipt shows it to every member", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  const tasks = await seed();
  await page.goto(`/tasks/${tasks.deny}`);
  const card = page.getByTestId("approval");
  await card.locator("[data-action='deny']").click();
  const reason = "Use date-fns: it's already a dependency.";
  await card.getByLabel(/^Reason for /).fill(reason);
  await expect(card.locator("[data-action='deny-send']")).toHaveText("Deny and send the reason");
  await card.locator("[data-action='deny-send']").click();
  await expect(page.locator("[data-part='approval']").filter({ hasText: /^Denied by / })).toHaveText(new RegExp(`^Denied by .+: ${reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), { timeout: 10_000 });

  // Another member who opens the task reads the same reason.
  const sam = await asSam(page);
  await sam.goto(`/tasks/${tasks.deny}`);
  await expect(sam.locator("[data-part='approval']").filter({ hasText: /^Denied by / })).toContainText(reason);
  await sam.context().close();
});

test("F-063/c2: the driver edits the proposed plan and approves it; the receipt shows the plan as approved, the changed step marked edited", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  const tasks = await seed();
  await page.goto(`/tasks/${tasks.plan}`);
  const plan = page.getByTestId("plan");
  await expect(plan).toContainText("Show it in Settings › About");
  await plan.locator("[data-action='edit-plan']").click();
  await plan.getByLabel("Step 2", { exact: true }).fill("Show it in Settings › About, with the build date");
  // The last step goes: the approved plan has two.
  await plan.getByRole("button", { name: "Remove the step" }).nth(2).click();
  await plan.locator("[data-action='approve-edited-plan']").click();

  const approved = page.getByTestId("plan-approved");
  await expect(approved).toContainText(/Plan approved by \S+/, { timeout: 10_000 });
  const steps = approved.locator("li");
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toHaveText("Read the version from package.json at build time");
  await expect(steps.nth(1)).toContainText("Show it in Settings › About, with the build date");
  await expect(steps.nth(1).getByText("edited", { exact: true })).toBeVisible();
  await expect(steps.nth(0).getByText("edited", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("plan")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("plan-approved").locator("li")).toHaveCount(2);
});

test("F-024/c5: a watcher has no composer, only who drives and Take over; taking over gives them the composer and the driver the watcher's bar", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  const tasks = await seed();
  await page.goto(`/tasks/${tasks.watched}`);
  await expect(composer(page)).toBeVisible();
  const sam = await asSam(page);
  await sam.goto(`/tasks/${tasks.watched}`);
  const bar = sam.locator("[data-part='watcher-bar']");
  await expect(bar).toContainText(/is driving\./);
  await expect(bar).toContainText("Take over to send messages.");
  await expect(composer(sam)).toHaveCount(0);

  await bar.locator("[data-action='take-over']").click();
  await expect(composer(sam)).toBeVisible({ timeout: 10_000 });
  await expect(sam.locator("[data-part='watcher-bar']")).toHaveCount(0);
  // The admin's page follows: the watcher's bar names the new driver.
  await expect(page.locator("[data-part='watcher-bar']")).toContainText(`${MEMBER} is driving.`, { timeout: 10_000 });
  await expect(composer(page)).toHaveCount(0);
  await sam.context().close();
});

/** `tasks.get`'s usage and spend, over HTTP as the signed-in member. */
const usageSchema = z.object({
  result: z.object({
    data: z.object({
      usage: z.object({
        totals: z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(), cacheWriteTokens: z.number(), spentMicroUsd: z.number().nullable(), agentMs: z.number(), estimated: z.boolean() }),
        turns: z.array(z.object({ ordinal: z.number(), inputTokens: z.number(), outputTokens: z.number(), estimated: z.boolean() })),
      }),
      spend: z.object({ unit: z.literal("usd"), spent: z.number(), cap: z.number(), reached: z.boolean() }),
    }),
  }),
});

/** The panel's short count: 28_000 → "28k", 5_600 → "5.6k". */
const short = (n: number): string => (n >= 1_000_000 ? `${String(Number((n / 1_000_000).toFixed(2)))}M` : n >= 1_000 ? `${String(Number((n / 1_000).toFixed(1)))}k` : String(n));

/** Micro-USD as the panel's dollars: 221_025 → "$0.22". */
const dollars = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

test("F-084/c1,c3: the properties panel shows the four kinds of tokens, the spend and the agent time, \"≈\" for an estimate, and each turn's figures in its footer, as the API reports them", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  const tasks = await seed();
  await page.goto(`/tasks/${tasks.counted}`);
  const response = await page.request.get(`/api/trpc/tasks.get?input=${encodeURIComponent(JSON.stringify({ taskId: tasks.counted }))}`);
  expect(response.ok()).toBe(true);
  const { usage, spend } = usageSchema.parse(await response.json()).result.data;
  const { totals, turns } = usage;
  // What the scripted turns counted (seed-answers.ts), as the API sums it.
  expect(totals).toMatchObject({ inputTokens: 28_000, outputTokens: 5_600, cacheReadTokens: 133_000, cacheWriteTokens: 3_500, agentMs: 112_000, estimated: true });
  // Its spend: each call's four kinds at the model's own prices ($3, $15, $0.30 and $3.75 a million),
  // worked by hand: 102,000 + 49,800 + 55,425 + 13,800 micro-USD. The Spend row reads the same figure.
  expect(totals.spentMicroUsd).toBe(221_025);
  expect(spend).toMatchObject({ unit: "usd", spent: 221_025, reached: false });

  const properties = page.getByTestId("task-properties");
  await expect(properties.getByTestId("task-tokens")).toHaveText(`≈ ${short(totals.inputTokens)} in · ${short(totals.outputTokens)} out`);
  await expect(properties.getByTestId("task-tokens-estimated")).toHaveText("estimated");
  await expect(properties.getByTestId("task-cache")).toHaveText(`${short(totals.cacheReadTokens)} read · ${short(totals.cacheWriteTokens)} write`);
  await expect(properties.getByTestId("task-spend")).toHaveText(`${dollars(spend.spent)} of ${dollars(spend.cap)}`);
  await expect(properties.getByTestId("task-agent-time")).toHaveText(`${String(Math.floor(totals.agentMs / 60_000))}m ${String(Math.round((totals.agentMs % 60_000) / 1000)).padStart(2, "0")}s`);

  const footers = page.locator("[data-part='turn-usage']");
  await expect(footers).toHaveCount(turns.length);
  for (const [i, turn] of turns.entries()) {
    await expect(footers.nth(i)).toHaveText(`${turn.estimated ? "≈ " : ""}${short(turn.inputTokens)} in · ${short(turn.outputTokens)} out`);
  }
});
