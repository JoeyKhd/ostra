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

test("F-026/c4,c5: two members answer one approval at once; one wins, and both read the winner's receipt on the answered call's row", { tag: "@desktop-only" }, async ({ page }) => {
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

  // Milestone 10 (tickets 12 and 13): an answered approval leaves its block for the turn's run, so
  // each browser drops the card and reads the one winner's receipt on the answered call's row.
  const receipts = await Promise.all(
    [page, sam].map(async (tab) => {
      await expect(tab.getByTestId("approval")).toHaveCount(0, { timeout: 10_000 });
      await tab.locator("[data-part='live-line']").click();
      const row = tab.locator("[data-part='run-steps'] li[data-step='command']").filter({ hasText: "pnpm db:migrate" });
      await expect(row).toContainText(/approved once by /);
      return row.innerText();
    }),
  );
  expect(receipts[0]).toBe(receipts[1]);
  await sam.context().close();
});

test("F-026/c3,c4: \"Approve for this task\" shows the pattern it adds, then the task's Approval rules list it and the run's row reads the receipt", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  const tasks = await seed();
  await page.goto(`/tasks/${tasks.rule}`);
  const card = page.getByTestId("approval");
  await expect(card).toContainText("Settings files");
  await expect(card.locator("[data-part='subject']")).toHaveText("config/settings.json");
  await expect(card.locator("[data-part='for-this-task']")).toHaveText("Approve for this task also approves later edits of this file.");
  await card.locator("[data-action='approve-task']").click();

  // Milestone 10: the block leaves for the run, whose row reads the receipt; the pattern it added
  // is the task's Approval rules, and `tasks.get` keeps both.
  await expect(page.getByTestId("approval")).toHaveCount(0, { timeout: 10_000 });
  await page.locator("[data-part='live-line']").click();
  const row = page.locator("[data-part='run-steps'] li[data-step='edit']").filter({ hasText: "config/settings.json" });
  await expect(row).toContainText(/approved for this task by /);
  const rule = page.getByTestId("task-rule");
  await expect(rule).toHaveCount(1);
  await expect(rule).toContainText("edit config/settings.json");
  await expect(rule).toContainText("this task ·");
  const answered = await approvalOf(page, tasks.rule);
  expect(answered).toMatchObject({ state: "answered", decision: "allow_task", forThisTask: { pattern: "config/settings.json" } });
  // Stored, not only shown.
  await page.reload();
  await page.locator("[data-part='live-line']").click();
  await expect(page.locator("[data-part='run-steps'] li[data-step='edit']").filter({ hasText: "config/settings.json" })).toContainText(/approved for this task by /);
  await expect(page.getByTestId("task-rule")).toContainText("edit config/settings.json");
});

test("F-026/c4: a deny takes a reason, every member reads the receipt, and the reason stays on the answer", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  const tasks = await seed();
  await page.goto(`/tasks/${tasks.deny}`);
  const card = page.getByTestId("approval");
  await card.locator("[data-action='deny']").click();
  const reason = "Use date-fns: it's already a dependency.";
  await card.getByLabel(/^Reason for /).fill(reason);
  await expect(card.locator("[data-action='deny-send']")).toHaveText("Deny and send the reason");
  await card.locator("[data-action='deny-send']").click();
  // Milestone 10: the run's row reads the deny (in red) and its receipt; the reason is kept on the
  // answer, which `tasks.get` gives every member (the receipt's words dropped it in the compact thread).
  const row = page.locator("[data-part='run-steps'] li[data-step='command']").filter({ hasText: "pnpm add moment" });
  await expect(page.getByTestId("approval")).toHaveCount(0, { timeout: 10_000 });
  await page.locator("[data-part='live-line']").click();
  await expect(row).toContainText("denied");
  await expect(row.locator(".text-red")).toContainText("denied");
  await expect(row).toContainText(/denied by /);
  expect(await approvalOf(page, tasks.deny)).toMatchObject({ state: "answered", decision: "deny", denyReason: reason });

  // Another member who opens the task reads the same answer.
  const sam = await asSam(page);
  await sam.goto(`/tasks/${tasks.deny}`);
  await expect(sam.getByTestId("approval")).toHaveCount(0);
  await sam.locator("[data-part='live-line']").click();
  await expect(sam.locator("[data-part='run-steps'] li[data-step='command']").filter({ hasText: "pnpm add moment" })).toContainText(/denied by /);
  const theirs = await approvalOf(sam, tasks.deny);
  expect(theirs).toMatchObject({ decision: "deny", denyReason: reason });
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

  // Milestone 10 (ticket 12): the block becomes its receipt, and `Show the plan ›` opens the plan as approved.
  const approved = page.locator("[data-part='receipt'][data-receipt='plan-approved']");
  await expect(approved).toContainText(/Plan approved by \S+.*, with edits/, { timeout: 10_000 });
  await approved.locator("[data-action='show-plan']").click();
  const steps = approved.locator("[data-part='plan-shown'] li");
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toContainText("Read the version from package.json at build time");
  await expect(steps.nth(1)).toContainText("Show it in Settings › About, with the build date");
  await expect(steps.nth(1)).toHaveAttribute("data-edited", "true");
  await expect(steps.nth(0)).not.toHaveAttribute("data-edited", "true");
  await expect(page.getByTestId("plan")).toHaveCount(0);
  await page.reload();
  await page.locator("[data-part='receipt'][data-receipt='plan-approved'] [data-action='show-plan']").click();
  await expect(page.locator("[data-part='receipt'][data-receipt='plan-approved'] [data-part='plan-shown'] li")).toHaveCount(2);
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

/** `tasks.get`'s approvals: the answer, its reason and the rule `Approve for this task` added. */
const approvalsSchema = z.object({
  result: z.object({
    data: z.object({
      approvals: z.array(
        z.object({
          approvalId: z.string(),
          state: z.string(),
          decision: z.enum(["allow_once", "allow_task", "deny"]).nullable(),
          denyReason: z.string().nullable(),
          forThisTask: z.object({ pattern: z.string() }).nullable(),
        }),
      ),
    }),
  }),
});

/** The task's one approval, over HTTP as the signed-in member. */
const approvalOf = async (page: Page, taskId: string): Promise<z.infer<typeof approvalsSchema>["result"]["data"]["approvals"][number]> => {
  const response = await page.request.get(`/api/trpc/tasks.get?input=${encodeURIComponent(JSON.stringify({ taskId }))}`);
  expect(response.ok()).toBe(true);
  const [approval] = approvalsSchema.parse(await response.json()).result.data.approvals;
  if (approval === undefined) throw new Error("the task has no approval");
  return approval;
};

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

  // Milestone 10 (ticket 16): each turn's figures are its run's footer, opened on its line.
  const closedRuns = page.locator("[data-part='run'] [data-nav='run-line'][aria-expanded='false']");
  while ((await closedRuns.count()) > 0) await closedRuns.first().click();
  const footers = page.locator("[data-part='run-footer'] [data-part='footer-facts']");
  await expect(footers).toHaveCount(turns.length);
  for (const [i, turn] of turns.entries()) {
    await expect(footers.nth(i)).toContainText(`${turn.estimated ? "≈" : ""}${short(turn.inputTokens)} in · ${short(turn.outputTokens)} out`);
    await expect(footers.nth(i)).toContainText(`Turn ${String(turn.ordinal)}`);
  }
});
