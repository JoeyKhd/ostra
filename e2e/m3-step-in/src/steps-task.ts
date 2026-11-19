import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { say } from "@ostra/e2e-m1/setup";
import { createIssue, ensureLabel, readIssue } from "@ostra/e2e-m2/linear";
import { taskIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import type { Page } from "@playwright/test";

import type { Demo } from "./context.ts";
import { PROFILE } from "./steps-config.ts";
import { readMail, seconds, sleep, waitFor } from "./run-state.ts";

// Spec section 3, steps 2 to 5: a ticket started with the profile, plan first, an approval answered
// by another member, and steering, interrupt and send, and take over.

const run = promisify(execFile);

export const taskIdOf = (d: Demo): TaskId => taskIdSchema.parse(d.run.taskId);

export const taskPath = (d: Demo): string => `/tasks/${taskIdOf(d)}`;

/** The task's worktree on the runner (`host`: a git worktree under the runner's data folder). */
export const worktreeOf = (d: Demo): string => path.join(d.settings.runnerDataDir, "tasks", taskIdOf(d), "workspace", d.settings.githubRepo);

/** `git status --porcelain` in the task's worktree, or `null` when there's none yet. */
export const worktreeStatus = async (d: Demo): Promise<string | null> =>
  run("git", ["-C", worktreeOf(d), "status", "--porcelain"], { windowsHide: true }).then(
    (out) => out.stdout,
    () => null,
  );

/** The newest events of a kind, as stored. */
export const eventsOf = async (d: Demo, kind: string) =>
  d.db.event.findMany({ where: { taskId: taskIdOf(d), kind }, orderBy: { seq: "asc" }, select: { seq: true, payload: true, occurredAt: true, sessionId: true } });


/** Step 2: the ticket in OST, started from the Inbox with the profile picker on `Careful`. */
export const ticket = async (d: Demo): Promise<void> => {
  const { demo, settings, tool } = d;
  if (d.run.projectHref === null) throw new Error("run setup first");
  if (d.run.ticket === null) {
    const label = await ensureLabel(tool, settings.linearTeamId, "ostra-demo");
    d.run.ticket = await createIssue(tool, {
      teamId: settings.linearTeamId,
      title: "Set the release name in config/settings.json",
      description: "Set `releaseName` in `config/settings.json` to the name the `release-names` tool gives you.",
      labelIds: [label],
    });
    d.run.timings["ticketCreatedAt"] = Date.now();
    await d.save();
    say(`step 2: ${d.run.ticket.identifier} ${d.run.ticket.url}`);
  }
  if (d.run.taskId !== null) return;
  const identifier = d.run.ticket.identifier;
  await demo.goto(`${d.run.projectHref}/inbox`);
  const row = demo.locator(`li[data-ticket="${identifier}"]`);
  await waitFor(`${identifier} in the Inbox`, 180_000, async () => {
    if ((await row.count()) > 0) return true;
    await demo.reload();
    return (await row.count()) > 0 ? true : null;
  }, 2000);
  await row.getByRole("button").first().click();
  const panel = demo.getByTestId("ticket-panel");
  await panel.waitFor();
  // The picker: Careful, test1's default for code tasks, first; the built-in OpenCode profile too.
  await panel.getByTestId("agent-profile").click();
  const items = demo.getByRole("menuitem");
  const names: string[] = [];
  for (let index = 0; index < (await items.count()); index += 1) names.push((await items.nth(index).getAttribute("data-profile")) ?? "");
  d.check("step 2: the picker offers Careful first, and OpenCode", names[0] === PROFILE && names.length >= 2, `offers ${names.join(", ")}`);
  await d.shot(demo, "step02-profile-picker");
  await demo.getByRole("menuitem").filter({ hasText: PROFILE }).click();
  await panel.getByTestId("run-on").click();
  await demo.locator(`[data-runner="${settings.runnerName}"]`).click({ timeout: 30_000 });
  await d.shot(demo, "step02-inbox-start");
  await panel.getByRole("button", { name: /Start task/ }).click();
  const active = panel.getByTestId("active-task");
  await active.waitFor({ timeout: 30_000 });
  await active.locator('a[href^="/tasks/"]').first().click();
  await demo.waitForURL(/\/tasks\/[^/]+$/, { timeout: 30_000 });
  d.run.taskId = taskIdSchema.parse(new URL(demo.url()).pathname.split("/").at(-1));
  d.run.timings["startedAt"] = Date.now();
  await d.save();
  const task = await d.db.task.findUniqueOrThrow({ where: { id: d.run.taskId }, select: { agentProfileId: true, driverMemberId: true } });
  const careful = await d.db.agentProfile.findFirst({ where: { name: PROFILE }, select: { id: true } });
  d.check("step 2: the task runs with Careful, and Demo drives", task.agentProfileId === careful?.id && task.driverMemberId !== null, `profile ${task.agentProfileId === careful?.id ? PROFILE : "another"}`);
  say(`step 2: task ${d.run.taskId}`);
};

/** Step 3: the plan turn, the needs-you moment on every channel, and the plan approved after an edit. */
export const plan = async (d: Demo): Promise<void> => {
  const { demo } = d;
  const startedAt = d.run.timings["startedAt"] ?? Date.now();
  await demo.goto(taskPath(d));
  const block = demo.getByTestId("plan");
  await waitFor("the plan", 20 * 60_000, async () => {
    if ((await block.count()) > 0) return true;
    if ((await demo.getByTestId("plan-approved").count()) > 0) return true;
    await demo.reload();
    return null;
  }, 5000);
  d.run.timings["planSeconds"] = seconds(Date.now() - startedAt);
  const proposedAt = Date.now();
  await d.shot(demo, "step03-plan-proposed");
  // No file changed in the worktree during the plan turn.
  const status = await worktreeStatus(d);
  d.check("step 3: the plan turn changed no file", status !== null && status.trim() === "", status === null ? "no worktree found" : status.trim() === "" ? "git status is clean" : `changed: ${String(status.trim().split("\n").length)} paths`);
  const planTurn = (await eventsOf(d, "turn.started"))[0];
  d.check("step 3: the first turn ran in plan mode", JSON.stringify(planTurn?.payload ?? {}).includes('"mode":"plan"'), "turn.started carries mode plan");
  // The sidebar's count, Home's first row.
  const count = demo.getByTestId("needs-you-count");
  await count.waitFor({ timeout: 60_000 }).catch(() => undefined);
  d.check("step 3: the sidebar's Needs you count rose", (await count.count()) > 0, (await count.count()) > 0 ? `shows ${await count.innerText()}` : "no count");
  await demo.goto("/");
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step03-home-needs-you");
  const homeText = await demo.locator("main").innerText();
  d.check("step 3: Home shows the plan first", homeText.includes("plan") || homeText.includes("Plan"), "Home's Needs you names the plan");
  // The ticket's comment on Linear.
  if (d.run.ticket !== null) {
    const ticketId = d.run.ticket.id;
    const comment = await waitFor("ostra's comment on the ticket", 120_000, async () => {
      const issue = await readIssue(d.tool, ticketId);
      return issue.comments.nodes.find((one) => /plan/i.test(one.body)) ?? null;
    }, 5000).catch(() => null);
    d.check("step 3: the ticket's comment says ostra waits for a plan approval", comment !== null, comment === null ? "no comment" : `${String(comment.body.length)} characters, mentions a plan`);
  }
  // The mail, with OSTRA_EMAIL_DELAY_SECONDS=0 on the stack.
  const mail = await waitFor("the plan's mail", 120_000, async () => {
    const all = await readMail(d.settings.m3StateDir);
    return all.find((one) => one.at >= startedAt && one.to.includes(d.settings.adminEmail) && /plan/i.test(one.data)) ?? null;
  }, 3000).catch(() => null);
  d.check("step 3: a mail reached Demo with the plan's moment", mail !== null, mail === null ? "no mail" : `subject "${mail.subject}", ${String(seconds(mail.at - proposedAt))} s after the plan showed`);
  if (mail !== null) d.check("step 3: the mail carries no task content", !mail.data.includes("releaseName") && !mail.data.includes("release-names"), "no ticket text in the mail");
  // Demo edits the plan, adds a step, and approves.
  await demo.goto(taskPath(d));
  if ((await demo.getByTestId("plan-approved").count()) === 0) {
    await block.locator('[data-action="edit-plan"]').click();
    await block.locator('[data-action="add-step"]').click();
    await block.getByRole("textbox").last().fill("Also put today's date in the changelog line");
    await d.shot(demo, "step03-plan-edit");
    await block.locator('[data-action="approve-edited-plan"]').click();
    await demo.getByTestId("plan-approved").waitFor({ timeout: 60_000 });
  }
  await d.shot(demo, "step03-plan-approved");
  const answered = await eventsOf(d, "plan.answered");
  d.check("step 3: the approved plan carries the added step", JSON.stringify(answered.at(-1)?.payload ?? {}).includes("today's date"), "plan.answered holds the edited plan");
};

/** Step 4: the rule asks for config/settings.json, and Sam approves it for this task. */
export const approval = async (d: Demo): Promise<void> => {
  const { sam, demo } = d;
  await sam.goto(taskPath(d));
  const card = sam.getByTestId("approval");
  await waitFor("the approval", 20 * 60_000, async () => {
    if ((await card.count()) > 0) return true;
    const rules = await d.db.taskApprovalRule.count({ where: { taskId: taskIdOf(d) } });
    if (rules > 0) return true;
    await sam.reload();
    return null;
  }, 5000);
  if ((await card.count()) > 0) {
    await d.shot(sam, "step04-approval-card");
    const text = await card.first().innerText();
    d.check("step 4: the card names the file and the rule", text.includes("config/settings.json") && text.includes("Settings files"), "names config/settings.json and the rule");
    // Sam saw it on Home too.
    await sam.goto("/");
    await sam.waitForLoadState("networkidle");
    await d.shot(sam, "step04-sam-home");
    await sam.goto(taskPath(d));
    await card.first().waitFor();
    const forTask = await card.first().locator('[data-part="for-this-task"]').innerText().catch(() => "");
    d.check("step 4: Approve for this task shows the rule it adds", forTask.includes("config/settings.json"), forTask);
    await card.first().locator('[data-action="approve-task"]').click();
    await sam.getByText(/Approved for this task by/).first().waitFor({ timeout: 60_000 });
  }
  await d.shot(sam, "step04-approval-receipt");
  const rule = await d.db.taskApprovalRule.findFirst({ where: { taskId: taskIdOf(d) }, select: { pattern: true, tool: true } });
  d.check("step 4: the task rule is Edit config/settings.json", rule?.pattern === "config/settings.json", `${rule?.tool ?? "no"} ${rule?.pattern ?? "rule"}`);
  const audit = await d.db.auditEntry.count({ where: { action: { startsWith: "approval." } } });
  d.check("step 4: the audit log has the answer", audit > 0, `${String(audit)} approval entries`);
  // Demo's notification shows it answered.
  await demo.goto("/needs-you");
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step04-demo-needs-you");
};

/** Waits until a turn runs; `null` when none started in time. */
const runningTurn = async (d: Demo, timeoutMs: number): Promise<boolean> =>
  waitFor("a running turn", timeoutMs, async () => {
    const task = await d.db.task.findUniqueOrThrow({ where: { id: taskIdOf(d) }, select: { state: true } });
    return task.state === "running" ? true : null;
  }, 1000).then(() => true, () => false);

const composer = (page: Page) => page.getByRole("textbox", { name: "Message the agent" });

/** Step 5: Send mid-turn, Interrupt and send, and Sam's take over. */
export const steer = async (d: Demo): Promise<void> => {
  const { demo, sam } = d;
  await demo.goto(taskPath(d));
  if (await runningTurn(d, 60_000)) {
    await composer(demo).fill("Also mention the ticket's key in the changelog line.");
    await demo.locator('[data-action="send"]').click();
    await sleep(3000);
  } else {
    await composer(demo).fill("Also mention the ticket's key in the changelog line.");
    await demo.locator('[data-action="send"]').click();
  }
  const sent = await waitFor("the steer's message", 60_000, async () => {
    const rows = await eventsOf(d, "user.message");
    return rows.find((row) => JSON.stringify(row.payload).includes("ticket's key")) ?? null;
  });
  const delivery = /"delivery":"(\w[\w-]*)"/.exec(JSON.stringify(sent.payload))?.[1] ?? "unknown";
  d.check("step 5: Send reached the agent", delivery === "immediate" || delivery === "queued", `delivered ${delivery}`);
  await d.shot(demo, "step05-steer-sent");
  // Interrupt and send, while a turn runs.
  if (await runningTurn(d, 120_000)) {
    await composer(demo).fill("Stop. Use the date format YYYY-MM-DD.");
    await demo.getByRole("button", { name: "Interrupt and send" }).click();
    const interrupted = await waitFor("the interrupt's message", 60_000, async () => {
      const rows = await eventsOf(d, "user.message");
      return rows.find((row) => JSON.stringify(row.payload).includes("YYYY-MM-DD")) ?? null;
    });
    d.check("step 5: Interrupt and send", JSON.stringify(interrupted.payload).includes("after-interrupt"), "the message went after an interrupt");
    await d.shot(demo, "step05-interrupt-sent");
  } else {
    d.check("step 5: Interrupt and send", false, "no turn ran to interrupt");
  }
  // Sam takes over: Demo's composer turns read-only.
  await sam.goto(taskPath(d));
  await sam.locator('[data-action="take-over"]').first().click();
  await sam.getByText(/took over/).first().waitFor({ timeout: 30_000 });
  await d.shot(sam, "step05-sam-took-over");
  await demo.reload();
  const bar = demo.locator('[data-part="watcher-bar"]');
  await bar.waitFor({ timeout: 30_000 });
  d.check("step 5: Demo's composer reads Sam is driving", (await bar.innerText()).includes("sam is driving") || (await bar.innerText()).toLowerCase().includes("sam is driving"), await bar.innerText());
  await d.shot(demo, "step05-demo-watcher");
};
