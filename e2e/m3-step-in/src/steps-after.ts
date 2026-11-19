import path from "node:path";

import { checkNoCredential } from "@ostra/e2e-m1/checks";
import { scanFolder, secretNeedles } from "@ostra/e2e-m1/scan";
import { say } from "@ostra/e2e-m1/setup";
import { readIssue } from "@ostra/e2e-m2/linear";
import { taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

import type { Demo } from "./context.ts";
import { loadFixtures, readMail, readMcp, seconds, sleep, waitFor } from "./run-state.ts";
import { turnSettled } from "./steps-review.ts";
import { eventsOf, taskIdOf, taskPath } from "./steps-task.ts";

// Spec section 3, steps 11 to 16: the merge and a fresh branch, a ticket cancelled while its task
// runs, usage, Home and Needs you, mail over SMTP, and services with only a `host` runner.

const repoRow = async (d: Demo) => d.db.taskRepo.findFirstOrThrow({ where: { taskId: taskIdOf(d) }, select: { prNumber: true, prUrl: true, branchName: true, state: true, headSha: true } });

/** Step 11: the PR merges; Sam reopens; a fresh branch from main and a second PR on the same ticket. */
export const merge = async (d: Demo): Promise<void> => {
  const { sam, github } = d;
  await turnSettled(d, 20 * 60_000);
  const first = await repoRow(d);
  if (first.prNumber === null) throw new Error("no PR to merge");
  const pull = await github.octokit.rest.pulls.get({ owner: github.owner, repo: github.repo, pull_number: first.prNumber });
  if (pull.data.state === "open") {
    await github.octokit.rest.pulls.merge({ owner: github.owner, repo: github.repo, pull_number: first.prNumber, merge_method: "squash" });
    say(`step 11: merged PR #${String(first.prNumber)}`);
  }
  const mergedAt = Date.now();
  await waitFor("the task's merged state", 10 * 60_000, async () => {
    const task = await d.db.task.findUniqueOrThrow({ where: { id: taskIdOf(d) }, select: { state: true } });
    return task.state === "merged" ? true : null;
  }, 10_000);
  d.run.timings["mergeSeenSeconds"] = seconds(Date.now() - mergedAt);
  if (d.run.ticket !== null) {
    const ticketId = d.run.ticket.id;
    const done = await waitFor("the ticket's move to done", 12 * 60_000, async () => {
      const issue = await readIssue(d.tool, ticketId);
      return issue.state.type === "completed" ? issue : null;
    }, 10_000).catch(() => null);
    d.check("step 11: the task merged and the ticket moved to done", done !== null, done === null ? "the ticket didn't move" : `${done.identifier} is "${done.state.name}"`);
  }
  await sam.goto(taskPath(d));
  await d.shot(sam, "step11-merged");
  // Sam reopens: a fresh branch from main's new head.
  const box = sam.getByRole("textbox", { name: "Message the agent" });
  await box.waitFor({ timeout: 30_000 });
  await box.fill("Add a second line to the changelog for the follow-up.");
  await sam.locator('[data-action="reopen"]').click();
  const second = await waitFor("the second PR", 30 * 60_000, async () => {
    const row = await repoRow(d);
    return row.prNumber !== null && row.prNumber !== first.prNumber ? row : null;
  }, 15_000);
  const prs = await d.db.taskPullRequest.findMany({ where: { taskRepo: { taskId: taskIdOf(d) } }, select: { number: true, state: true, branchName: true }, orderBy: { openedAt: "asc" } });
  d.check("step 11: a fresh branch named -2 and a new PR, the merged one kept", second.branchName === `${first.branchName}-2` && prs.length >= 2, `branch ${second.branchName}, PRs ${prs.map((pr) => `#${String(pr.number)} ${pr.state}`).join(", ")}`);
  d.run.notes["secondPr"] = second.prUrl ?? "";
  await turnSettled(d, 20 * 60_000);
  await sam.goto(taskPath(d));
  await sam.waitForLoadState("networkidle");
  await d.shot(sam, "step11-fresh-branch");
};

const statesSchema = z.object({ team: z.object({ states: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })) }) }) });

/** Step 12: the ticket cancelled while a turn runs; the turn is interrupted and Sam stops the task. */
export const cancel = async (d: Demo): Promise<void> => {
  const { sam, tool, settings } = d;
  if (d.run.ticket === null) throw new Error("no ticket");
  await turnSettled(d, 20 * 60_000);
  const states = statesSchema.parse(await tool.call("query ($id: String!) { team(id: $id) { states { nodes { id name type } } } }", { id: settings.linearTeamId }));
  // After the merge the ticket is done; the follow-up's work puts it back in progress, as a person
  // would, so its cancel is a close while the task runs (a close after the merge does nothing).
  const started = states.team.states.nodes.find((state) => state.type === "started");
  if (started !== undefined) {
    await tool.call("mutation ($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }", { id: d.run.ticket.id, stateId: started.id });
    await sleep(15_000);
  }
  await sam.goto(taskPath(d));
  const box = sam.getByRole("textbox", { name: "Message the agent" });
  // The turn must still run when Linear's webhook for the cancel arrives (seconds later): a quick
  // model can finish a one-line change first, and then there's no running turn to interrupt.
  await box.fill(
    'First run `node -e "setTimeout(() => {}, 120000)"` and wait for it to finish (two minutes). Then add a third line to the changelog that says the release name is final, and read every file in the repo once more to check nothing else needs the name.',
  );
  const reopen = sam.locator('[data-action="reopen"]');
  if ((await reopen.count()) > 0) await reopen.click();
  else await sam.locator('[data-action="send"]').click();
  await waitFor("a running turn", 10 * 60_000, async () => {
    const task = await d.db.task.findUniqueOrThrow({ where: { id: taskIdOf(d) }, select: { state: true } });
    return task.state === "running" ? true : null;
  }, 1000);
  const canceled = states.team.states.nodes.find((state) => state.type === "canceled");
  if (canceled === undefined) throw new Error("the team has no cancelled status");
  await tool.call("mutation ($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }", { id: d.run.ticket.id, stateId: canceled.id });
  const cancelledAt = Date.now();
  say(`step 12: ${d.run.ticket.identifier} cancelled in Linear`);
  await waitFor("the ticket-closed moment", 5 * 60_000, async () => {
    const task = await d.db.task.findUniqueOrThrow({ where: { id: taskIdOf(d) }, select: { state: true, needsYouReason: true } });
    return task.needsYouReason === "ticket_closed" || (await d.db.needsYouItem.count({ where: { taskId: taskIdOf(d), reason: "ticket_closed", state: "open" } })) > 0 ? true : null;
  }, 2000);
  d.run.timings["ticketClosedSeconds"] = seconds(Date.now() - cancelledAt);
  // The turn ends cancelled: the runner's answer to core's interrupt.
  const closed = (await eventsOf(d, "ticket.closed")).filter((row) => row.occurredAt.getTime() >= cancelledAt - 1000);
  const cancelledTurns = await waitFor("the interrupted turn", 120_000, async () => {
    const rows = (await eventsOf(d, "turn.ended")).filter((row) => row.occurredAt.getTime() >= cancelledAt - 1000 && JSON.stringify(row.payload).includes('"cancelled"'));
    return rows.length > 0 ? rows : null;
  }, 2000).catch(() => []);
  d.check("step 12: the turn was interrupted and the task needs you · ticket closed", closed.length === 1 && cancelledTurns.length > 0, `ticket.closed and a cancelled turn, ${String(d.run.timings["ticketClosedSeconds"])} s after the cancel`);
  await sam.goto(taskPath(d));
  const block = sam.getByTestId("ticket-closed");
  await block.waitFor({ timeout: 60_000 });
  await d.shot(sam, "step12-ticket-closed");
  await block.locator('[data-action="stop-task"]').click();
  await waitFor("the stopped task", 120_000, async () => {
    const task = await d.db.task.findUniqueOrThrow({ where: { id: taskIdOf(d) }, select: { state: true } });
    return task.state === "stopped" ? true : null;
  }, 2000);
  const row = await repoRow(d);
  const open = row.prNumber === null ? null : await d.github.octokit.rest.pulls.get({ owner: d.github.owner, repo: d.github.repo, pull_number: row.prNumber });
  d.check("step 12: the task stopped and its PR stays open", open?.data.state === "open", `PR #${String(row.prNumber)} is ${open?.data.state ?? "missing"}`);
  await sam.reload();
  await d.shot(sam, "step12-stopped");
};

const tokenSchema = z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(), cacheWriteTokens: z.number() });

/** Step 13: usage per task and per turn, equal to the sum of the task's `usage.recorded` events. */
export const usage = async (d: Demo): Promise<void> => {
  const { sam } = d;
  const rows = await eventsOf(d, "usage.recorded");
  const sum = rows.reduce((total, row) => {
    const parsed = tokenSchema.safeParse(row.payload);
    return parsed.success
      ? { inputTokens: total.inputTokens + parsed.data.inputTokens, outputTokens: total.outputTokens + parsed.data.outputTokens, cacheReadTokens: total.cacheReadTokens + parsed.data.cacheReadTokens, cacheWriteTokens: total.cacheWriteTokens + parsed.data.cacheWriteTokens }
      : total;
  }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const sessions = await d.db.session.findMany({ where: { taskId: taskIdOf(d) }, select: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true } });
  const totals = sessions.reduce((total, row) => ({ inputTokens: total.inputTokens + row.inputTokens, outputTokens: total.outputTokens + row.outputTokens, cacheReadTokens: total.cacheReadTokens + row.cacheReadTokens, cacheWriteTokens: total.cacheWriteTokens + row.cacheWriteTokens }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  d.check("step 13: the task's totals equal the sum of its usage.recorded events", JSON.stringify(sum) === JSON.stringify(totals), `${String(rows.length)} events: ${JSON.stringify(sum)}`);
  const turns = await d.db.turn.findMany({ where: { taskId: taskIdOf(d) }, select: { inputTokens: true, agentMs: true } });
  d.check("step 13: each turn has its own figures and agent time", turns.length > 0 && turns.some((turn) => turn.inputTokens > 0) && turns.some((turn) => (turn.agentMs ?? 0) > 0), `${String(turns.length)} turns`);
  await sam.goto(taskPath(d));
  await sam.getByTestId("task-tokens").waitFor();
  const shown = await sam.getByTestId("task-tokens").innerText();
  const cache = await sam.getByTestId("task-cache").innerText();
  const agentTime = await sam.getByTestId("task-agent-time").innerText();
  d.check("step 13: the properties show tokens, cache and agent time", shown.includes("in") && cache.includes("read") && agentTime !== "", `${shown} · ${cache} · ${agentTime}`);
  const turnFooters = await sam.locator('[data-part="turn-usage"]').count();
  d.check("step 13: each turn in the thread shows its own", turnFooters > 0, `${String(turnFooters)} turn footers`);
  await d.shot(sam, "step13-usage");
};

/** Step 14: Sam's Home, its board, and the Needs you page with its Done tab. */
export const home = async (d: Demo): Promise<void> => {
  const { sam } = d;
  await sam.goto("/");
  await sam.waitForLoadState("networkidle");
  await d.shot(sam, "step14-sam-home");
  await sam.goto("/?view=board");
  await sam.locator("[data-board]").waitFor();
  await sleep(2000);
  await d.shot(sam, "step14-sam-board");
  const board = await sam.locator("[data-board]").innerText();
  d.check("step 14: the board groups the tasks by state", board.includes("Needs you") && board.includes("Finished"), "five columns");
  await sam.goto("/needs-you");
  await sam.waitForLoadState("networkidle");
  await d.shot(sam, "step14-sam-needs-you");
  await sam.getByRole("tab", { name: "Done" }).click();
  await sleep(2000);
  await d.shot(sam, "step14-sam-needs-you-done");
  const notifications = await d.db.notification.count({ where: { member: { user: { username: d.settings.samUsername } } } });
  d.check("step 14: notifications reached Sam", notifications > 0, `${String(notifications)} notifications`);
};

/** Step 15: every mail of the run went through SMTP, and says nothing of the task's content. */
export const mail = async (d: Demo): Promise<void> => {
  const all = await readMail(d.settings.m3StateDir);
  const kinds = all.map((one) => one.subject);
  d.check("step 15: the test mail and the needs-you mails went through SMTP", all.length >= 2 && all.every((one) => one.user !== null), `${String(all.length)} mails, each signed in with AUTH`);
  d.check("step 15: no mail carries the ticket's text", all.every((one) => !one.data.includes("release-names") && !one.data.includes("Quiet Heron")), kinds.length > 0 ? "none does" : "no mail");
};

/** Step 16: a task needing a service waits with only a `host` runner; a second test1 task finds the cache warm. */
export const services = async (d: Demo): Promise<void> => {
  const { demo } = d;
  if (d.run.otherProjectHref === null || d.run.projectHref === null) throw new Error("run setup first");
  // test2 needs `db`: its task stays queued, and says why.
  await demo.goto("/tasks/new");
  await demo.getByTestId("pick-project").click();
  await demo.getByRole("listbox", { name: "Pick the project" }).getByRole("button", { name: d.settings.githubOtherRepo, exact: true }).click();
  await demo.getByLabel("Prompt").fill("List the files at the repo's root in docs/files.md");
  await demo.locator('[data-action="start-task"]').click();
  await demo.waitForURL((url) => /^\/tasks\/[^/]+$/.test(url.pathname) && url.pathname !== "/tasks/new", { timeout: 30_000 });
  const waitingId = taskIdSchema.parse(new URL(demo.url()).pathname.split("/").at(-1));
  const note = demo.getByTestId("task-dispatch-note");
  await note.waitFor({ timeout: 120_000 });
  d.check("step 16: test2's task waits for a runner that can start services", (await note.innerText()).includes("services"), await note.innerText());
  await d.shot(demo, "step16-waiting-for-services");
  await demo.locator('[data-action="stop"]').click().catch(() => undefined);
  // test1 gets a setup script, so its boxes use the dependency cache; two tasks, the second warm.
  d.run.notes["servicesTask"] = waitingId;
  await demo.goto(`${d.run.projectHref}/environment`);
  await demo.getByRole("textbox", { name: "Setup script" }).fill("git log --oneline -1");
  await demo.getByRole("button", { name: "Save environment" }).first().click();
  await demo.getByText("Saved.").first().waitFor({ timeout: 30_000 });
  const setupSeen: string[] = [];
  for (const round of [1, 2]) {
    await demo.goto("/tasks/new");
    await demo.getByTestId("pick-project").click();
    await demo.getByRole("listbox", { name: "Pick the project" }).getByRole("button", { name: d.settings.githubRepo, exact: true }).click();
    await demo.getByLabel("Prompt").fill(`Say how many files are at the repo's root (round ${String(round)}). Change nothing.`);
    await demo.locator('[data-action="start-task"]').click();
    await demo.waitForURL((url) => /^\/tasks\/[^/]+$/.test(url.pathname) && url.pathname !== "/tasks/new", { timeout: 30_000 });
    const id = taskIdSchema.parse(new URL(demo.url()).pathname.split("/").at(-1));
    const finished = await waitFor("the setup's end", 10 * 60_000, async () => {
      const row = await d.db.event.findFirst({ where: { taskId: id, kind: "environment.setup_finished" }, select: { payload: true } });
      return row === null ? null : JSON.stringify(row.payload);
    }, 3000).catch(() => "none");
    setupSeen.push(/"dependencyCache":"(\w+)"/.exec(finished)?.[1] ?? "none");
    await demo.goto(`/tasks/${id}`);
    await d.shot(demo, `step16-cache-round-${String(round)}`);
    await demo.locator('[data-action="stop"]').click().catch(() => undefined);
    await waitFor("the round's stop", 120_000, async () => {
      const task = await d.db.task.findUniqueOrThrow({ where: { id }, select: { state: true } });
      return task.state === "stopped" ? true : null;
    }, 2000).catch(() => undefined);
  }
  d.check("step 16: the second test1 task finds the dependency cache warm", setupSeen[1] === "warm", `rounds: ${setupSeen.join(", ")}`);
};

/**
 * The checks after the run that this machine can make (spec section 3): nothing that shouldn't
 * reached the agent, the event log or a log line. Searched by value, never printed: the MCP
 * server's token, the SMTP password, the model key, the App's key and any GitHub token.
 */
export const secrets = async (d: Demo): Promise<void> => {
  const fixtures = await loadFixtures(d.settings.m3StateDir);
  const extra = [fixtures.mcp.token, fixtures.smtp.pass, d.settings.linearApiKey];
  const logs = [...d.settings.logFiles, path.join(d.settings.m3StateDir, "runner.log")];
  const credential = await checkNoCredential(d.settings, logs, extra);
  d.check(`after: ${credential.name}`, credential.ok, credential.detail);
  const needles = [...(await secretNeedles(d.settings)), ...extra];
  const scan = await scanFolder(d.settings.runnerDataDir, needles);
  d.check("after: no credential in the runner's folder (worktrees and the agent's folders)", scan.holding.length === 0, scan.holding.length === 0 ? `searched ${String(scan.files)} files` : `found in ${String(scan.holding.length)} files`);
  const mcp = await readMcp(d.settings.m3StateDir);
  const calls = mcp.filter((request) => request.rpc === "tools/call");
  d.check("after: the agent reached release-names only through the sidecar, with the token", calls.length > 0 && calls.every((request) => request.authorized), `${String(calls.length)} tool calls, ${String(mcp.filter((request) => !request.authorized).length)} refused requests`);
  // One ticket comment per moment, edited rather than added again (F-036, F-046's rule).
  if (d.run.ticket !== null) {
    const issue = await readIssue(d.tool, d.run.ticket.id);
    const ostra = issue.comments.nodes.filter((comment) => comment.body.includes("ostra") || comment.body.includes("/tasks/"));
    d.check("after: ostra's comments on the ticket stay few (edited in place)", ostra.length <= 4, `${String(ostra.length)} of ostra's comments on ${issue.identifier}`);
  }
  const mails = await readMail(d.settings.m3StateDir);
  const perMoment = new Map<string, number>();
  // A moment is a member, a kind (the subject's words before " · ") and a task (the mail's link).
  for (const one of mails) {
    const task = /\/tasks\/([0-9a-f-]{36})/.exec(one.data)?.[1] ?? "none";
    const key = `${one.to.join(",")}:${one.subject.split("·")[0] ?? ""}:${task}`;
    perMoment.set(key, (perMoment.get(key) ?? 0) + 1);
  }
  d.check("after: one mail per member and moment", [...perMoment.values()].every((n) => n === 1), `${String(mails.length)} mails, ${String(perMoment.size)} distinct`);
};
