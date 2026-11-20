import { say } from "@ostra/e2e-m1/setup";
import { createIssue, ensureLabel } from "@ostra/e2e-m2/linear";
import type { Locator, Page } from "@playwright/test";

import type { Demo } from "./context.ts";
import { waitFor } from "./state.ts";

// The demo's tasks (ticket 41): a ticket in OST started from a project's Inbox, a prompt task from
// a project's page, and the waits on a task's state, read from the stack's database.

/** The task's state, sub-state and needs-you reason, as stored. */
export const taskRow = async (d: Demo, taskId: string) =>
  d.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { state: true, subState: true, needsYouReason: true, planState: true, dispatchWait: true, spentMicroUsd: true } });

/** A turn of the task that hasn't finished. */
export const turnRunning = async (d: Demo, taskId: string): Promise<boolean> =>
  (await d.db.turn.count({ where: { taskId, endedAt: null } })) > 0;

const SETTLED = new Set(["in_review", "needs_you", "stopped", "merged", "done"]);

/** Waits until the task's turns are over and it rests in review, needs you, stopped, merged or done. */
export const settled = async (d: Demo, taskId: string, timeoutMs = 20 * 60_000): Promise<string> =>
  waitFor(`task ${taskId} to settle`, timeoutMs, async () => {
    const row = await taskRow(d, taskId);
    if (!SETTLED.has(row.state)) return null;
    if (await turnRunning(d, taskId)) return null;
    return row.needsYouReason === null ? row.state : `${row.state} · ${row.needsYouReason}`;
  }, 5000);

/** What Demo says when an agent's question expired unseen: the run can't answer a form. */
export const EXPIRED_ANSWER = "Your question expired before I saw it. Use your best judgement, keep the change small, and go ahead.";

/**
 * `settled`, answering an agent's question: a question nobody answers expires, which cancels its
 * turn and ends the session, and the task rests in "Needs you · question". The driver then reopens
 * it with an answer, as a person would, at most twice. Each answer is noted in the run's state.
 */
export const settledAnswering = async (d: Demo, page: Page, taskId: string, answer = EXPIRED_ANSWER): Promise<string> => {
  let state = await settled(d, taskId);
  for (let round = 1; round <= 2 && state === "needs_you · question"; round += 1) {
    const turns = await d.db.turn.count({ where: { taskId } });
    say(`task ${taskId}: its question expired; the driver answers in a message`);
    d.run.notes[`question-answered:${taskId}`] = String(round);
    await sendMessage(page, taskId, answer);
    await waitFor("the answered turn", 8 * 60_000, async () => ((await d.db.turn.count({ where: { taskId } })) > turns ? true : null), 3000).catch(() => undefined);
    state = await settled(d, taskId);
  }
  return state;
};

/** Waits until a turn of the task runs. */
export const running = async (d: Demo, taskId: string, timeoutMs = 10 * 60_000): Promise<void> => {
  await waitFor(`a running turn of ${taskId}`, timeoutMs, async () => ((await turnRunning(d, taskId)) ? true : null), 1000);
};

/** A ticket in OST with the demo's label. */
export const ticket = async (d: Demo, key: string, title: string, description: string): Promise<{ readonly id: string; readonly identifier: string; readonly url: string }> => {
  const known = d.run.ids[`ticket:${key}`];
  if (known !== undefined) {
    const [id = "", identifier = "", url = ""] = known.split("|");
    return { id, identifier, url };
  }
  const label = await ensureLabel(d.tool, d.settings.linearTeamId, "ostra-demo");
  const made = await createIssue(d.tool, { teamId: d.settings.linearTeamId, title, description, labelIds: [label] });
  d.run.ids[`ticket:${key}`] = `${made.id}|${made.identifier}|${made.url}`;
  await d.save();
  say(`${key}: ${made.identifier} ${made.url}`);
  return made;
};

/** Starts the ticket's task from the project's Inbox on the runner; the task's ID. */
export const startFromInbox = async (d: Demo, page: Page, projectId: string, identifier: string, runnerName: string, profile?: string): Promise<string> => {
  await page.goto(`/projects/${projectId}/inbox`);
  const row = page.locator(`li[data-ticket="${identifier}"]`);
  await waitFor(`${identifier} in the Inbox`, 240_000, async () => {
    if ((await row.count()) > 0) return true;
    await page.reload();
    await page.waitForLoadState("networkidle");
    return (await row.count()) > 0 ? true : null;
  }, 3000);
  await row.getByRole("button").first().click();
  const panel = page.getByTestId("ticket-panel");
  await panel.waitFor();
  if (profile !== undefined && (await panel.getByTestId("agent-profile").count()) > 0) {
    await panel.getByTestId("agent-profile").click();
    await page.getByRole("menuitem").filter({ hasText: profile }).first().click();
  }
  await panel.getByTestId("run-on").click();
  await page.locator(`[data-runner="${runnerName}"]`).click({ timeout: 30_000 });
  await panel.getByRole("button", { name: /Start task/ }).click();
  const active = panel.getByTestId("active-task");
  await active.waitFor({ timeout: 30_000 });
  await active.locator('a[href^="/tasks/"]').first().click();
  await page.waitForURL(/\/tasks\/[^/]+$/, { timeout: 30_000 });
  const taskId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  say(`${identifier}: task ${taskId}`);
  return taskId;
};

/** Starts a prompt task from the project's page on the runner; the task's ID. */
export const startPromptTask = async (page: Page, projectId: string, prompt: string, runnerName: string, profile?: string): Promise<string> => {
  await page.goto(`/projects/${projectId}`);
  const form = page.getByTestId("new-task");
  await form.locator("textarea").fill(prompt);
  if (profile !== undefined) {
    const picker = form.getByTestId("agent-profile");
    if ((await picker.count()) > 0) {
      await picker.click();
      await page.getByRole("menuitem").filter({ hasText: profile }).first().click();
    }
  }
  await form.getByRole("combobox", { name: "Run on" }).click();
  await page.getByRole("option", { name: new RegExp(runnerName) }).click({ timeout: 30_000 });
  await form.getByRole("button", { name: /Start/ }).click();
  await page.waitForURL(/\/tasks\/[^/]+$/, { timeout: 60_000 });
  const taskId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  say(`task ${taskId} started in ${projectId}`);
  return taskId;
};

/** New task (`/tasks/new`) with the project picked: the form, once its start check has answered. */
export const openNewTask = async (page: Page, projectName: string, prompt: string, profile?: string): Promise<void> => {
  await page.goto("/tasks/new");
  await page.getByTestId("pick-project").click({ timeout: 30_000 });
  await page.getByRole("listbox", { name: "Pick the project" }).getByRole("button", { name: projectName, exact: true }).click();
  await page.getByTestId("pick-project").filter({ hasText: projectName }).waitFor({ timeout: 15_000 });
  if (profile !== undefined) {
    await page.getByTestId("agent-profile").click({ timeout: 30_000 });
    await page.locator(`[role="menuitem"][data-profile="${profile}"]`).click();
    await page.getByTestId("agent-profile-name").filter({ hasText: profile }).waitFor({ timeout: 15_000 });
  }
  await page.locator("#new-task-prompt").fill(prompt);
  await page.waitForLoadState("networkidle");
};

/** Starts a task from New task, on the named runner and profile; the task's ID. */
export const startNewTask = async (page: Page, projectName: string, prompt: string, runnerName: string, profile?: string): Promise<string> => {
  await openNewTask(page, projectName, prompt, profile);
  await page.getByTestId("run-on").click({ timeout: 30_000 });
  await page.locator(`[role="menuitem"][data-runner="${runnerName}"]`).click({ timeout: 30_000 });
  await page.locator('[data-action="start-task"]').click({ timeout: 30_000 });
  await page.waitForURL((url) => /^\/tasks\/[0-9a-f-]{36}$/.test(url.pathname), { timeout: 60_000 });
  const taskId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  say(`task ${taskId} started in ${projectName}${profile === undefined ? "" : ` with ${profile}`}`);
  return taskId;
};

/** Sends a message to the task's agent from its page: "Send" on a live task, "Reopen" on one at rest. */
export const sendMessage = async (page: Page, taskId: string, text: string): Promise<void> => {
  await page.goto(`/tasks/${taskId}`);
  await page.waitForLoadState("networkidle");
  const box = page.getByLabel("Message the agent");
  await box.waitFor({ timeout: 30_000 });
  await box.fill(text);
  const button = page.locator('[data-action="send"], [data-action="reopen"]').filter({ visible: true }).first();
  await button.waitFor({ timeout: 30_000 });
  await button.click({ timeout: 30_000 });
  // The composer empties once the message is taken.
  await waitFor("the message to be taken", 30_000, async () => ((await box.inputValue().catch(() => "")) === "" ? true : null), 500);
};

/** The audit actions written since `since`, oldest first. */
export const auditSince = async (d: Demo, since: number) =>
  d.db.auditEntry.findMany({ where: { createdAt: { gte: new Date(since) } }, select: { action: true, actorId: true, actorName: true, entityId: true, data: true }, orderBy: { createdAt: "asc" } });

/** One attribute of every element a locator matches, in order. */
export const attributes = async (locator: Locator, name: string): Promise<readonly string[]> =>
  Promise.all((await locator.all()).map(async (one) => (await one.getAttribute(name)) ?? ""));

/** Merges every open PR of the task with the App's token (no test token, ticket 42), then waits for the task to read merged. */
export const mergeTaskPrs = async (d: Demo, taskId: string): Promise<string> => {
  const { github } = d;
  const prs = await d.db.taskPullRequest.findMany({ where: { taskRepo: { taskId } }, select: { number: true, taskRepo: { select: { repo: { select: { fullName: true } } } } } });
  for (const pr of prs) {
    const [owner = "", repo = ""] = pr.taskRepo.repo.fullName.split("/");
    const pull = await github.octokit.rest.pulls.get({ owner, repo, pull_number: pr.number });
    if (pull.data.merged || pull.data.state !== "open") continue;
    await github.octokit.rest.pulls.merge({ owner, repo, pull_number: pr.number, merge_method: "squash" });
    say(`merged ${repo}#${String(pr.number)}`);
  }
  return waitFor(`task ${taskId} merged`, 6 * 60_000, async () => {
    const row = await d.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { state: true } });
    return row.state === "merged" || row.state === "done" ? row.state : null;
  }, 5000).catch(() => "not merged");
};
