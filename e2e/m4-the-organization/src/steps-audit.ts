import { say } from "@ostra/e2e-m1/setup";
import { z } from "zod";

import type { Demo } from "./context.ts";
import { attributes, settled, startPromptTask } from "./tasks.ts";

// Spec section 3, steps 10 and 11: the audit log and the event log, and search.

const memberIdOf = async (d: Demo, username: string): Promise<string> => {
  const member = await d.db.member.findFirstOrThrow({ where: { user: { username } }, select: { id: true } });
  return member.id;
};

const rowCount = async (d: Demo, query: string): Promise<{ readonly count: string; readonly actions: readonly string[] }> => {
  const { demo } = d;
  await demo.goto(`/organization/audit?${query}`);
  await demo.getByTestId("audit-row").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  const count = (await demo.getByTestId("audit-count").innerText().catch(() => "")).trim();
  const actions = await attributes(demo.getByTestId("audit-row"), "data-action");
  return { count, actions };
};

/** Step 10: the audit log by Sam, by budget.*, the credential issuances, the CSV, the event log and Sam's project view. */
export const audit = async (d: Demo): Promise<void> => {
  const { demo } = d;
  const sam = await memberIdOf(d, d.settings.sam.username);
  const bySam = await d.db.auditEntry.findMany({ where: { actorId: sam }, select: { action: true } });
  const samActions = new Set(bySam.map((entry) => entry.action));
  d.check(
    "step 10: filtered by Sam: the acceptance, the task start, the environment save, the proposal's approval",
    ["invitation.accepted", "task.created", "environment.saved", "memory.proposal-approved"].every((action) => samActions.has(action)),
    [...samActions].join(", "),
  );
  const samView = await rowCount(d, `actor=${sam}&period=any`);
  await d.shot(demo, "step10-audit-by-sam");
  say(`step 10: by Sam: ${samView.count}`);
  const budgets = await rowCount(d, "action=budget.*&period=any");
  const budgetRows = await d.db.auditEntry.count({ where: { action: { startsWith: "budget." } } });
  d.check("step 10: filtered by budget.*: each budget change", budgetRows >= 4 && budgets.count.startsWith(String(budgetRows)), `${budgets.count} on the page, ${String(budgetRows)} stored`);
  await d.shot(demo, "step10-audit-budgets");
  const tasks = await d.db.task.findMany({ select: { id: true } });
  const issued = await d.db.auditEntry.findMany({ where: { action: "task.credentials-issued" }, select: { entityId: true } });
  const withIssue = new Set(issued.map((entry) => entry.entityId));
  const started = await d.db.turn.findMany({ distinct: ["taskId"], select: { taskId: true } });
  const missing = started.filter((turn) => !withIssue.has(turn.taskId));
  d.check("step 10: each task that ran has its task.credentials-issued", missing.length === 0, `${String(started.length)} tasks ran, ${String(tasks.length)} tasks, ${String(missing.length)} without`);
  await rowCount(d, "action=task.credentials-issued&period=any");
  await d.shot(demo, "step10-audit-credentials");
  // Export CSV downloads the filtered view.
  await demo.goto("/organization/audit?action=budget.*&period=any");
  const href = (await demo.getByTestId("audit-export").getAttribute("href").catch(() => null)) ?? "";
  const csv = href === "" ? "" : await (await demo.request.get(href)).text();
  const lines = csv.split("\n").filter((line) => line.trim() !== "");
  d.check("step 10: Export CSV downloads the filtered view", lines.length - 1 === budgetRows && lines.slice(1).every((line) => line.includes("budget.")), `${String(Math.max(0, lines.length - 1))} rows`);
  // The task of step 4's event log: every tool call with its full input.
  const step4 = d.id("task:step4");
  await demo.goto(`/tasks/${step4}?tab=events`);
  await demo.getByTestId("event-row").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  const shown = await demo.getByTestId("event-row").count();
  const called = await d.db.event.count({ where: { taskId: step4, kind: "tool.called" } });
  d.check("step 10: step 4's event log lists its tool calls", shown > 0 && called > 0, `${String(shown)} rows shown, ${String(called)} tool calls stored`);
  await d.shot(demo, "step10-event-log");
  // Sam, test2's project admin, sees test2's entries in its settings, and none of the organization's.
  const samPage = await d.page("sam");
  await samPage.goto(`/projects/${d.id("project:test2")}/settings/audit`);
  await samPage.waitForLoadState("networkidle");
  await samPage.getByTestId("audit-row").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  const samRows = await samPage.getByTestId("audit-row").count();
  const org = await d.query(samPage, "audit.list", {});
  d.check("step 10: Sam sees test2's entries in its settings", samRows > 0, `${String(samRows)} rows`);
  d.check("step 10: Sam sees none of the organization's", !org.ok && org.code === "FORBIDDEN", org.ok ? "audit.list answered" : org.code);
  await d.shot(samPage, "step10-sam-test2-audit");
};

const paletteResults = async (d: Demo, page: Awaited<ReturnType<Demo["page"]>>, text: string): Promise<readonly string[]> => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.keyboard.press("Control+K");
  const palette = page.getByTestId("search-palette");
  await palette.waitFor({ timeout: 15_000 });
  await palette.getByRole("combobox").fill(text);
  await page.waitForTimeout(2500);
  return attributes(palette.getByTestId("search-palette-result"), "data-task");
};

const searchSchema = z.looseObject({ results: z.array(z.looseObject({ taskId: z.string() })).optional(), tasks: z.array(z.looseObject({ taskId: z.string() })).optional() });

/** Step 11: a vault task, then Sam's palette for apiVersion with filters, and the vault word for each. */
export const search = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const vault = d.id("project:vault");
  if (d.run.ids["task:step11"] === undefined) {
    d.run.ids["task:step11"] = await startPromptTask(demo, vault, "Write `VAULT-ONLY-7731` into `notes.txt`", settings.runnerName);
    await d.save();
  }
  const vaultTask = d.id("task:step11");
  await settled(d, vaultTask);
  const sam = await d.page("sam");
  const step4 = d.id("task:step4");
  const first = await paletteResults(d, sam, "apiVersion");
  d.check("step 11: apiVersion finds step 4's task first for Sam", first[0] === step4, `${String(first.length)} results`);
  await d.shot(sam, "step11-palette-apiversion");
  const kept = await paletteResults(d, sam, "apiVersion repo:test2 status:merged");
  d.check("step 11: repo:test2 status:merged keeps it", kept.includes(step4), `${String(kept.length)} results`);
  await d.shot(sam, "step11-palette-filters");
  const dropped = await paletteResults(d, sam, "apiVersion by:sam");
  d.check("step 11: by:sam drops it", !dropped.includes(step4), `${String(dropped.length)} results`);
  const samVault = await paletteResults(d, sam, "VAULT-ONLY-7731");
  d.check("step 11: VAULT-ONLY-7731 finds nothing for Sam", samVault.length === 0, `${String(samVault.length)} results`);
  await d.shot(sam, "step11-sam-vault-nothing");
  const demoVault = await paletteResults(d, demo, "VAULT-ONLY-7731");
  d.check("step 11: VAULT-ONLY-7731 finds the vault task for Demo", demoVault.includes(vaultTask), `${String(demoVault.length)} results`);
  await d.shot(demo, "step11-demo-vault");
  const api = await d.query(sam, "search.tasks", { query: "VAULT-ONLY-7731" });
  const parsed = api.ok ? searchSchema.safeParse(api.data) : null;
  const ids = parsed?.success === true ? [...(parsed.data.results ?? []), ...(parsed.data.tasks ?? [])].map((one) => one.taskId) : [];
  d.check("step 11: search.tasks as Sam returns no vault task", api.ok && !ids.includes(vaultTask), api.ok ? `${String(ids.length)} results` : api.code);
};
