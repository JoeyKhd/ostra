import { say } from "@ostra/e2e-m1/setup";
import { z } from "zod";

import type { Demo } from "./context.ts";
import { mailTo } from "./steps-people.ts";
import { PROFILE } from "./steps-setup.ts";
import { sleep, waitFor } from "./state.ts";
import { openNewTask, sendMessage, settled, startNewTask, taskRow, turnRunning } from "./tasks.ts";

// Spec section 3, steps 6 and 13: costs and a budget, and Insights.

const monthSchema = z.string();
const figures = z.looseObject({ spentMicroUsd: z.number() });
const spendSchema = z.looseObject({
  total: figures,
  byProject: z.array(z.looseObject({ spentMicroUsd: z.number(), line: z.looseObject({ kind: z.string(), name: z.string().optional() }) })),
  byModel: z.array(z.looseObject({ name: z.string(), spentMicroUsd: z.number() })),
  byProvider: z.array(z.looseObject({ name: z.string(), spentMicroUsd: z.number() })),
  budgets: z.array(z.looseObject({ spentMicroUsd: z.number(), monthlyMicroUsd: z.number(), share: z.number().nullable(), state: z.string(), overshootMicroUsd: z.number() })),
});

export const dollars = (micro: number): string => `$${(micro / 1_000_000).toFixed(4)}`;

const monthNow = async (d: Demo): Promise<string> => {
  const answer = await d.query(d.demo, "spend.currentMonth");
  if (!answer.ok) throw new Error(`spend.currentMonth: ${answer.code}`);
  return monthSchema.parse(answer.data);
};

export const spendMonth = async (d: Demo) => {
  const month = await monthNow(d);
  const answer = await d.query(d.demo, "spend.month", { month });
  if (!answer.ok) throw new Error(`spend.month: ${answer.code}`);
  return { month, view: spendSchema.parse(answer.data) };
};

/** test1's spend this month, in micro-USD, as the Spend page counts it. */
const test1Spent = async (d: Demo): Promise<number> => {
  const { view } = await spendMonth(d);
  return view.byProject.find((row) => row.line.name === "test1")?.spentMicroUsd ?? 0;
};

/** Sets test1's budget through the Spend page's form, in dollars (whole cents). */
const setBudget = async (d: Demo, usd: number, shot: string): Promise<void> => {
  const { demo } = d;
  await demo.goto(`/organization/spend?project=${d.id("project:test1")}`);
  const form = demo.getByTestId("budget-form");
  if ((await form.count()) === 0) await demo.locator('tr[data-project="test1"]').click();
  await form.waitFor({ timeout: 30_000 });
  await form.getByLabel("Monthly budget").fill(usd.toFixed(2));
  await d.shot(demo, shot);
  await form.getByRole("button", { name: "Save budget" }).click();
  await demo.waitForTimeout(2500);
};

/** A budget in whole cents with spend between 80% and 100% of it, near 110% of the spend. */
const warnBudget = (spentMicro: number): number => {
  const spent = spentMicro / 1_000_000;
  for (const factor of [1.1, 1.15, 1.2, 1.05, 1.24]) {
    const usd = Math.round(spent * factor * 100) / 100;
    if (usd > 0 && spent / usd >= 0.8 && spent / usd < 1) return usd;
  }
  return Math.max(0.01, Math.ceil((spent / 0.9) * 100) / 100);
};

/** Step 6: spend on the task, the project and the Spend page; a budget's 80% and 100%; the gate and the release. */
export const budget = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const test1 = d.id("project:test1");
  const step4 = d.id("task:step4");
  await demo.goto(`/tasks/${step4}`);
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step06-task-spend");
  await demo.goto(`/projects/${test1}`);
  await demo.waitForLoadState("networkidle");
  const projectSpend = (await demo.getByTestId("project-spend-month").innerText().catch(() => "")).trim();
  d.check("step 6: test1's page shows the month's spend", projectSpend.startsWith("$"), projectSpend);
  await d.shot(demo, "step06-project-spend");
  await demo.goto("/organization/spend");
  await demo.getByRole("heading", { level: 1, name: "Spend" }).waitFor();
  await d.shot(demo, "step06-spend");
  const { month, view } = await spendMonth(d);
  const [start, end] = [new Date(`${month}-01T00:00:00Z`), new Date(new Date(`${month}-01T00:00:00Z`).setUTCMonth(new Date(`${month}-01T00:00:00Z`).getUTCMonth() + 1))];
  const turns = await d.db.turn.aggregate({ where: { startedAt: { gte: start, lt: end } }, _sum: { spentMicroUsd: true } });
  const tasks = await d.db.task.aggregate({ _sum: { spentMicroUsd: true } });
  const turnSum = turns._sum.spentMicroUsd ?? 0;
  d.check(
    "step 6: the organization's total equals the sum of its tasks' spend this month",
    Math.abs(view.total.spentMicroUsd - turnSum) <= 1 && Math.abs(view.total.spentMicroUsd - (tasks._sum.spentMicroUsd ?? 0)) <= 1,
    `Spend ${dollars(view.total.spentMicroUsd)}, turns ${dollars(turnSum)}, tasks ${dollars(tasks._sum.spentMicroUsd ?? 0)}; ${String(view.byProject.length)} projects, ${String(view.byModel.length)} models`,
  );
  // 110% of test1's spend: the 80% notice at once.
  const spent = await test1Spent(d);
  const warnUsd = warnBudget(spent);
  d.run.notes["step6-spent-before"] = dollars(spent);
  d.run.notes["step6-budget-1"] = `$${warnUsd.toFixed(2)}`;
  const since = Date.now();
  await setBudget(d, warnUsd, "step06-budget-110");
  const notice = await waitFor("the 80% notice", 120_000, async () => (await d.db.budgetNotice.findFirst({ where: { threshold: "warn" }, select: { sentAt: true } })) ?? null, 2000).catch(() => null);
  d.check("step 6: the 80% notice is written at once", notice !== null, notice === null ? "none" : `sent ${String(Math.round((notice.sentAt.getTime() - since) / 1000))} s after the save`);
  await demo.goto("/needs-you");
  await demo.waitForLoadState("networkidle");
  const needsYou = await demo.locator("main").innerText();
  d.check("step 6: Demo's Needs you says test1 is at its budget's share", needsYou.includes("test1") && needsYou.includes("% of its budget"), (/test1[^\n]*% of its budget[^\n]*/.exec(needsYou)?.[0] ?? "no line").slice(0, 120));
  await d.shot(demo, "step06-needs-you-80");
  const warnMail = await mailTo(d, settings.adminEmail, /budget/i, since).catch(() => null);
  d.check("step 6: the 80% mail reaches Demo", warnMail !== null, warnMail === null ? "no mail" : `subject "${warnMail.subject}"`);
  // A Careful task: the plan, approved after about a minute; the budget lowered during the build turn.
  if (d.run.ids["task:step6"] === undefined) {
    d.run.ids["task:step6"] = await startNewTask(demo, "test1", "Add a `CONTRIBUTING.md` with three short rules", settings.runnerName, PROFILE);
    await d.save();
  }
  const taskId = d.id("task:step6");
  const planState = await settled(d, taskId);
  d.check("step 6: the plan turn ends as Needs you · plan", planState === "needs_you · plan", planState);
  await demo.goto(`/tasks/${taskId}`);
  await d.shot(demo, "step06-plan");
  if ((await taskRow(d, taskId)).needsYouReason === "plan") {
    await sleep(60_000);
    await demo.goto(`/tasks/${taskId}`);
    await demo.locator('[data-action="approve-plan"]').first().click({ timeout: 30_000 });
  }
  // The build turn starts, or, when the plan turn's own spend crossed the line, the gate holds it.
  const heldPlan = await waitFor("the build turn, or its hold", 10 * 60_000, async () => {
    if (await turnRunning(d, taskId)) return "running";
    return (await d.db.heldTurn.count({ where: { taskId, releasedAt: null } })) > 0 ? "held" : null;
  }, 1000).catch(() => "neither");
  const reachedSince = Date.now();
  if (heldPlan === "held") {
    d.check("step 6: past 100% after the plan turn, the approved plan's build turn is held", true, "held at the approval: the plan turn's spend crossed the line, so there was no build turn to lower the budget under");
    await demo.goto(`/tasks/${taskId}`);
    await demo.waitForLoadState("networkidle");
    await d.shot(demo, "step06-plan-held");
  } else if (await turnRunning(d, taskId)) {
    const sofar = await test1Spent(d);
    const lowUsd = Math.max(0.01, Math.floor(sofar * 0.9 / 10_000) / 100);
    d.run.notes["step6-budget-2"] = `$${lowUsd.toFixed(2)} (spend so far ${dollars(sofar)})`;
    await setBudget(d, lowUsd, "step06-budget-90");
    d.check("step 6: the budget was lowered while the build turn ran", await turnRunning(d, taskId), d.run.notes["step6-budget-2"]);
  } else {
    d.check("step 6: the budget was lowered while the build turn ran", false, "the build turn wasn't running");
  }
  const after = heldPlan === "held" ? "held at the approval" : await settled(d, taskId);
  say(`step 6: the build turn ended: ${after}`);
  const reached = await waitFor("the 100% notice", 180_000, async () => (await d.db.budgetNotice.findFirst({ where: { threshold: "reached" }, select: { sentAt: true } })) ?? null, 3000).catch(() => null);
  d.check("step 6: test1 reached its budget: the notice is written", reached !== null, reached === null ? "none" : "written");
  // Where the line was crossed: by the plan turn's own spend, or by the lowering during the build turn.
  if (reached !== null) d.run.notes["step6-reached"] = reached.sentAt.getTime() < reachedSince ? "crossed by the plan turn's spend, before the build turn" : "crossed when the budget was lowered during the build turn";
  const reachedMail = await mailTo(d, settings.adminEmail, /reached/i, since).catch(() => null);
  d.check("step 6: the 100% mail reaches Demo", reachedMail !== null && /reached/i.test(`${reachedMail.subject} ${reachedMail.text}`), reachedMail === null ? "no mail" : `subject "${reachedMail.subject}"`);
  await demo.goto("/needs-you");
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step06-needs-you-reached");
  // A held message.
  await sendMessage(demo, taskId, "Also add a line about tests");
  const held = await waitFor("the held message", 60_000, async () => ((await demo.locator('[data-part="held"]').count()) > 0 ? true : null), 2000).catch(() => false);
  const heldLine = await demo.locator('[data-part="held"]').first().innerText().catch(() => "");
  d.check("step 6: Demo's message is held, and the thread says why", held && /Held: test1.s budget for .* is reached/.test(heldLine), heldLine || "no held row");
  await d.shot(demo, "step06-held");
  // A new task in test1 waits, with the reason before Start.
  await openNewTask(demo, "test1", "Add a `docs/budget.md` saying what a budget is");
  await demo.getByTestId("budget-reason").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  const reason = await demo.getByTestId("budget-reason").first().innerText().catch(() => "");
  d.check("step 6: the New task form shows the budget's reason before Start", /budget/i.test(reason), reason || "no reason shown");
  await d.shot(demo, "step06-new-task-reason");
  if (d.run.ids["task:step6-queued"] === undefined) {
    d.run.ids["task:step6-queued"] = await startNewTask(demo, "test1", "Add a `docs/budget.md` saying what a budget is", settings.runnerName);
    await d.save();
  }
  const queued = d.id("task:step6-queued");
  await sleep(5000);
  const queuedRow = await taskRow(d, queued);
  d.check("step 6: the new task in test1 waits, queued, with the reason", queuedRow.state === "queued" && JSON.stringify(queuedRow.dispatchWait ?? {}).includes("budget"), `${queuedRow.state}: ${JSON.stringify(queuedRow.dispatchWait)}`);
  await demo.goto(`/tasks/${queued}`);
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step06-queued");
  // A task in test2 still starts.
  if (d.run.ids["task:step6-test2"] === undefined) {
    d.run.ids["task:step6-test2"] = await startNewTask(demo, "test2", "Add a `docs/budget.md` with one line: test2 has no budget", settings.runnerName);
    await d.save();
  }
  const other = d.id("task:step6-test2");
  const otherStarted = await waitFor("test2's task to start", 8 * 60_000, async () => ((await d.db.turn.count({ where: { taskId: other } })) > 0 ? true : null), 3000).catch(() => false);
  d.check("step 6: a task in test2 still starts", otherStarted, otherStarted ? "its first turn started" : "no turn");
  await settled(d, other).catch(() => undefined);
  // Raise the budget: the held message's turn starts, and the waiting task starts.
  const turnsHeld = await d.db.turn.count({ where: { taskId } });
  await setBudget(d, Math.max(50, warnUsd * 20), "step06-budget-raised");
  const released = await waitFor("the held turn released", 3 * 60_000, async () => ((await d.db.heldTurn.count({ where: { taskId, releasedAt: { not: null } } })) > 0 ? true : null), 3000).catch(() => false);
  d.check("step 6: raising the budget releases the held message", released, released ? "released" : "still held");
  const resumed = await waitFor("the held message's turn", 8 * 60_000, async () => ((await d.db.turn.count({ where: { taskId } })) > turnsHeld ? true : null), 3000).catch(() => false);
  d.check("step 6: the held message starts its turn", resumed, `${String(await d.db.turn.count({ where: { taskId } }))} turns`);
  const queuedStarted = await waitFor("the waiting task to start", 10 * 60_000, async () => ((await d.db.turn.count({ where: { taskId: queued } })) > 0 ? true : null), 5000).catch(() => false);
  d.check("step 6: the waiting task starts", queuedStarted, (await taskRow(d, queued)).state);
  await settled(d, taskId).catch(() => undefined);
  await settled(d, queued).catch(() => undefined);
  await demo.goto(`/tasks/${taskId}`);
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step06-released");
  // Spend shows the overshoot past 100%: lowered once more under the spend, read, then raised again.
  const now = await test1Spent(d);
  const under = Math.max(0.01, Math.floor(now * 0.9 / 10_000) / 100);
  await setBudget(d, under, "step06-budget-under");
  const { view: overshot } = await spendMonth(d);
  const line = overshot.budgets.find((one) => one.state === "reached");
  d.check("step 6: Spend shows the overshoot past 100%", line !== undefined && line.overshootMicroUsd > 0, line === undefined ? "no reached budget" : `spent ${dollars(line.spentMicroUsd)} of ${dollars(line.monthlyMicroUsd)}, ${dollars(line.overshootMicroUsd)} over`);
  await demo.goto("/organization/spend");
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step06-overshoot");
  await setBudget(d, Math.max(50, warnUsd * 20), "step06-budget-final");
};

/** Step 13: Insights for the organization and test1, and Sam's view with vault folded. */
export const insights = async (d: Demo): Promise<void> => {
  const { demo } = d;
  await demo.goto("/organization/insights?period=7d");
  await demo.getByRole("heading", { name: "Insights", level: 1 }).waitFor();
  await demo.getByTestId("insights-computed").waitFor({ timeout: 120_000 });
  const computed = await demo.getByTestId("insights-computed").innerText();
  const cells = demo.getByTestId("insights-figures").locator("[data-figure]");
  const figures: Record<string, string> = {};
  for (let index = 0; index < (await cells.count()); index += 1) {
    const cell = cells.nth(index);
    figures[(await cell.getAttribute("data-figure")) ?? String(index)] = (await cell.getByTestId("figure-value").innerText().catch(() => "")).trim();
  }
  d.run.notes["step13-figures"] = JSON.stringify(figures);
  d.check("step 13: the organization's Insights show the figures, computed minutes ago", Object.keys(figures).length >= 6 && computed.includes("Computed"), `${computed}; ${JSON.stringify(figures)}`);
  await d.shot(demo, "step13-insights");
  await demo.goto(`/projects/${d.id("project:test1")}/insights?period=7d`);
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step13-test1-insights");
  const sam = await d.page("sam");
  await sam.goto("/organization/insights?period=7d");
  await sam.waitForLoadState("networkidle");
  await sam.waitForTimeout(1500);
  const text = await sam.locator("body").innerText();
  d.check("step 13: Sam's Insights show vault's share as Other projects", text.includes("Other projects") && !text.includes("vault"), text.includes("Other projects") ? "Other projects shown" : "no Other projects line");
  await d.shot(sam, "step13-sam-insights");
};
