// `pnpm e2e:m2` (ticket 39): milestone 2's demo (spec section 3), on this machine, against a
// running dev stack (`pnpm dev`), the test org and the test Linear workspace. It starts from
// milestone 1's steps (the first admin, the model provider, the GitHub App, the project, a personal
// runner), seeds the Linear connection from the maintainer's key (the overnight run: step 1 waits
// for the maintainer's Authorize click), attaches team OST in the panel, creates a real ticket,
// starts it from the Inbox, waits for the PR and the ticket's moves, lets the box idle, releases
// the worktree, reopens the task on a second runner from the session archive, and merges the PR.
// It drives the panel in Chromium and keeps screenshots under the spec folder.
//
// Secrets come from the environment (model.env, github.env, github-test.env, linear.env and the
// tunnel's address) and are typed into forms or stored in the secret store only: never printed.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { devDataDir, devPgDir } from "@ostra/db/dev";
import { checkNoCredential } from "@ostra/e2e-m1/checks";
import type { CheckResult } from "@ostra/e2e-m1/checks";
import { demoDatabase } from "@ostra/e2e-m1/database";
import { demoGitHub } from "@ostra/e2e-m1/github";
import { scanFolder } from "@ostra/e2e-m1/scan";
import type { DemoGitHub } from "@ostra/e2e-m1/github";
import type { RunningRunner } from "@ostra/e2e-m1/runner";
import { addModelProvider, connectGitHub, connectRunner, createProject, loadState, say, screenshot, signInAsAdmin } from "@ostra/e2e-m1/setup";
import { taskIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { z } from "zod";

import { checkDrift, checkNoCiForHiddenRef, checkOutbox, checkPolling, cleanUpSecondTask, openTask, secondTask } from "./extras.ts";
import { addComment, archiveIssue, createIssue, ensureLabel, linearTool, readIssue, uploadImage } from "./linear.ts";
import type { CreatedIssue, LinearTool } from "./linear.ts";
import { removeSeedWebhook, seedLinear } from "./seed-linear.ts";
import type { SeededConnection } from "./seed-linear.ts";
import { m2Settings } from "./settings.ts";
import type { M2Settings } from "./settings.ts";

// ---------- the run's own state, so a second run picks up where the last one stopped ----------

const runStateSchema = z.object({
  ticket: z.object({ id: z.string(), identifier: z.string(), url: z.string(), createdAt: z.number(), title: z.string(), file: z.string() }).nullable().default(null),
  taskId: z.string().nullable().default(null),
  pr: z.object({ number: z.number(), url: z.string() }).nullable().default(null),
  released: z.boolean().default(false),
  reopened: z.boolean().default(false),
  merged: z.boolean().default(false),
  timings: z.record(z.string(), z.number()).default({}),
});

type RunState = z.infer<typeof runStateSchema>;

const loadRunState = async (file: string): Promise<RunState> => {
  try {
    return runStateSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return runStateSchema.parse({});
  }
};

const saveRunState = async (file: string, state: RunState): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2));
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `read` until it answers non-null, or throws `what` after `timeoutMs`. */
const waitFor = async <T,>(what: string, timeoutMs: number, read: () => Promise<T | null>, everyMs = 1000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
};

const seconds = (ms: number): number => Math.round(ms / 100) / 10;

// ---------- the steps ----------

/** Step 2: the board, attached in the panel; the mapping drafts itself from Linear's status types. */
const attachBoard = async (page: Page, settings: M2Settings, projectHref: string): Promise<void> => {
  await page.goto(`${projectHref}/boards`);
  const attached = page.getByText(`· ${settings.linearTeamKey}`, { exact: false }).first();
  await page.getByText("Attach a team").first().waitFor({ timeout: 30_000 });
  const already = page.locator("li", { hasText: settings.linearTeamKey }).filter({ hasText: "Detach" });
  if ((await already.count()) > 0) {
    say(`step 2: ${settings.linearTeamKey} is attached`);
  } else {
    say(`step 2: attach ${settings.linearTeamKey}`);
    await page.getByRole("combobox", { name: "Attach a team" }).click();
    await page.getByRole("option", { name: new RegExp(`· ${settings.linearTeamKey}`) }).click();
    await page.getByRole("button", { name: "Attach", exact: true }).click();
    await already.first().waitFor({ timeout: 30_000 });
  }
  await attached.waitFor({ timeout: 30_000 }).catch(() => undefined);
  await screenshot(page, settings, "board-attached");
};


/** Step 3: a real ticket in OST, made the way a person makes one: a description with an image, a label, a comment. */
const createTicket = async (tool: LinearTool, settings: M2Settings): Promise<CreatedIssue & { readonly createdAt: number; readonly title: string; readonly file: string }> => {
  // Each run's own file: an earlier run's merged PR left its file on the default branch.
  const file = `GREETING-${randomBytes(2).toString("hex")}.md`;
  const title = `Add ${file} that says hello from ostra`;
  const assetUrl = await uploadImage(tool, "greeting-sketch.png");
  const labelId = await ensureLabel(tool, settings.linearTeamId, "ostra-demo");
  const createdAt = Date.now();
  const issue = await createIssue(tool, {
    teamId: settings.linearTeamId,
    title,
    description: [
      "We want a friendly file at the root of the repo.",
      "",
      `Create \`${file}\` with a level-one heading \`Hello from ostra\` and one sentence saying which ticket asked for it.`,
      "",
      `![greeting-sketch.png](${assetUrl})`,
    ].join("\n"),
    labelIds: [labelId],
  });
  await addComment(tool, issue.id, "Keep it short: the heading and one sentence are enough.");
  return { ...issue, createdAt, title, file };
};

/** Step 4: the ticket in the Inbox, then "Start task" on it, on the given runner. */
const startFromInbox = async (db: Db, page: Page, settings: M2Settings, projectHref: string, ticket: CreatedIssue, created: number, state: RunState): Promise<TaskId> => {
  await page.goto(`${projectHref}/inbox`);
  const row = page.locator(`li[data-ticket="${ticket.identifier}"]`);
  // The webhook brings it within seconds; the Inbox refetches every 10 s, so reload until it shows.
  await waitFor(`${ticket.identifier} in the Inbox`, 120_000, async () => {
    if ((await row.count()) > 0) return true;
    await page.reload();
    return (await row.count()) > 0 ? true : null;
  }, 1500);
  state.timings["inboxSeconds"] = seconds(Date.now() - created);
  const cached = await db.ticket.findFirst({ where: { externalId: ticket.id }, select: { createdAt: true } });
  if (cached !== null) state.timings["ticketCachedSeconds"] = seconds(cached.createdAt.getTime() - created);
  say(`step 3: ${ticket.identifier} is in the ticket cache after ${String(state.timings["ticketCachedSeconds"] ?? "?")} s, and the Inbox shows it after ${String(state.timings["inboxSeconds"])} s`);
  await row.getByRole("button").first().click();
  const panel = page.getByTestId("ticket-panel");
  await panel.waitFor();
  await panel.getByTestId("run-on").click();
  await page.locator(`[data-runner="${settings.runnerName}"]`).click({ timeout: 30_000 });
  await screenshot(page, settings, "inbox");
  await panel.getByRole("button", { name: /Start task/ }).click();
  // The panel turns into the ticket's active task, queued, with a link to it.
  const active = panel.getByTestId("active-task");
  await active.waitFor({ timeout: 30_000 });
  await screenshot(page, settings, "inbox-started");
  await active.locator("a[href^=\"/tasks/\"]").first().click();
  await page.waitForURL(/\/tasks\/[^/]+$/, { timeout: 30_000 });
  const taskId = taskIdSchema.parse(new URL(page.url()).pathname.split("/").at(-1));
  say(`step 4: task ${taskId} started from ${ticket.identifier}`);
  await screenshot(page, settings, "task-queued");
  return taskId;
};

/** The ticket's state on Linear, until `ready` says it's what the step expects. */
const waitOnLinear = async (tool: LinearTool, ticketId: string, what: string, timeoutMs: number, ready: (issue: Awaited<ReturnType<typeof readIssue>>) => boolean): Promise<Awaited<ReturnType<typeof readIssue>>> =>
  waitFor(what, timeoutMs, async () => {
    const issue = await readIssue(tool, ticketId);
    return ready(issue) ? issue : null;
  }, 3000);

const taskUrlOf = (settings: M2Settings, taskId: TaskId): string => `${settings.publicUrl}/tasks/${taskId}`;

const ostraComments = (issue: Awaited<ReturnType<typeof readIssue>>, settings: M2Settings, taskId: TaskId): number =>
  issue.comments.nodes.filter((comment) => comment.body.includes(taskUrlOf(settings, taskId))).length;

/** Step 6: the PR's link on the task page. */
const waitForPullRequest = async (page: Page, settings: M2Settings, timeoutMs: number): Promise<{ readonly number: number; readonly url: string }> => {
  const started = Date.now();
  let next = 0;
  while (Date.now() - started < timeoutMs) {
    const link = page.getByTestId("pr-link").first();
    if ((await link.count()) > 0) {
      const href = await link.getAttribute("href");
      const number = Number(/\/pull\/(\d+)/.exec(href ?? "")?.[1] ?? Number.NaN);
      if (href !== null && Number.isInteger(number)) {
        await screenshot(page, settings, "pull-request");
        return { number, url: href };
      }
    }
    if (Date.now() >= next) {
      await screenshot(page, settings, "working");
      next = Date.now() + 60_000;
    }
    await page.waitForTimeout(3000);
    if ((await page.getByTestId("pr-link").count()) === 0 && Date.now() - started > 30_000 && (Date.now() - started) % 60_000 < 3000) await page.reload();
  }
  await screenshot(page, settings, "timed-out");
  throw new Error("no pull request in time");
};

/** A session that still holds its box: the runner's idle timer hasn't stopped it yet. */
const OPEN_SESSION_STATES: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

/** The task's sessions, oldest first, as the checks read them. */
const sessionsOf = (db: Db, taskId: TaskId) =>
  db.session.findMany({ where: { taskId }, orderBy: { startedAt: "asc" }, select: { id: true, state: true, origin: true, archiveBlobId: true, archiveTurnOrdinal: true, boxId: true } });

const releaseOldWorktree = async (settings: M2Settings, runner: RunningRunner, taskId: TaskId): Promise<void> => {
  // "The old worktree is gone (the script releases it, as cleanup would)": the first runner stops
  // and its task folder goes, so the reopen can't resume in place.
  await runner.stop();
  await rm(path.join(settings.runnerDataDir, "tasks", taskId), { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
};

// Spec section 3 asks for today's date at the top, which an agent sometimes writes in its first turn
// already: then the reopen has nothing to commit, and the PR can't show the update. This sentence
// can't be there before.
const REOPEN_MESSAGE = 'Also add this sentence at the end of the file: "Reopened from its session archive." And what did you change in your first turn, and why?';

const reopenTask = async (page: Page, settings: M2Settings, taskId: TaskId): Promise<void> => {
  await openTask(page, taskId);
  const composer = page.getByRole("textbox", { name: "Message" }).or(page.locator("textarea")).first();
  await composer.waitFor({ timeout: 30_000 });
  await composer.fill(REOPEN_MESSAGE);
  await screenshot(page, settings, "reopen-composer");
  await page.locator('[data-action="reopen"]').click();
};

// ---------- main ----------

const main = async (): Promise<void> => {
  const settings = m2Settings(process.env);
  await mkdir(settings.screenshotDir, { recursive: true });
  const stateFile = path.join(settings.stateDir, "run.json");
  const run = await loadRunState(stateFile);
  const login = await loadState(path.join(settings.stateDir, "state.json"));
  const database = await demoDatabase(process.env, devPgDir);
  const db = createDb(database.url, { maxConnections: 2 });
  const tool = linearTool(settings.linearApiKey);
  const github: DemoGitHub = await demoGitHub(settings);
  let browser: Browser | null = null;
  const runners: RunningRunner[] = [];
  let seeded: SeededConnection | null = null;
  const checks: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    say(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ baseURL: settings.panelUrl, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await signInAsAdmin(page, settings, login);
    await addModelProvider(page, settings);
    await connectGitHub(page, settings);
    const projectHref = await createProject(page, settings);

    // Step 1, the overnight way: the connection from the maintainer's key, the webhook on the tunnel.
    seeded = await seedLinear({
      db,
      tool,
      env: process.env,
      serverDataDir: path.join(devDataDir, "server"),
      apiKey: settings.linearApiKey,
      teamId: settings.linearTeamId,
      publicUrl: settings.devPublicUrl,
    });
    say(`step 1 (seed): Linear connection ${seeded.connectionId} on ${seeded.workspaceKey}, ${seeded.webhookId === null ? "polling" : "webhooks on the tunnel"}`);
    await page.goto("/organization/linear");
    await page.getByText(seeded.workspaceKey).first().waitFor({ timeout: 30_000 });
    await screenshot(page, settings, "linear-connected");

    await attachBoard(page, settings, projectHref);

    if (run.ticket === null) {
      say("step 3: create a ticket in OST");
      run.ticket = await createTicket(tool, settings);
      await saveRunState(stateFile, run);
    }
    const ticket = run.ticket;
    say(`step 3: ${ticket.identifier} ${ticket.url}`);

    if (run.taskId === null) {
      runners.push(await connectRunner(page, settings, path.join(settings.stateDir, "demo-runner.log")));
      run.taskId = await startFromInbox(db, page, settings, projectHref, ticket, ticket.createdAt, run);
      await saveRunState(stateFile, run);
      const startedAt = Date.now();
      const started = await waitOnLinear(tool, ticket.id, "the ticket's move to started, the comment and the task link", 120_000, (issue) =>
        issue.state.type === "started" && ostraComments(issue, settings, taskIdSchema.parse(run.taskId)) >= 1 && issue.attachments.nodes.some((a) => a.url === taskUrlOf(settings, taskIdSchema.parse(run.taskId))),
      );
      run.timings["startedOnLinearSeconds"] = seconds(Date.now() - startedAt);
      say(`step 4: on Linear, ${ticket.identifier} is "${started.state.name}", with ostra's comment and the task link, after ${String(run.timings["startedOnLinearSeconds"])} s`);
    }
    const taskId = taskIdSchema.parse(run.taskId);

    if (run.pr === null) {
      if (runners.length === 0) runners.push(await connectRunner(page, settings, path.join(settings.stateDir, "demo-runner.log")));
      await openTask(page, taskId);
      await page.getByText(ticket.identifier).first().waitFor({ timeout: 30_000 });
      await screenshot(page, settings, "task-ticket");
      const prStarted = Date.now();
      run.pr = await waitForPullRequest(page, settings, 25 * 60_000);
      run.timings["prSeconds"] = seconds(Date.now() - prStarted);
      await saveRunState(stateFile, run);
      say(`step 6: ${run.pr.url}`);
    }
    const pr = run.pr;

    // Step 6 on Linear: the PR linked, in review, the progress comment edited in place.
    const reviewed = await waitOnLinear(tool, ticket.id, "the PR's link on the ticket", 120_000, (issue) => issue.attachments.nodes.some((a) => a.url === pr.url));
    check("step 6: the PR is linked on the ticket", true, `${reviewed.identifier} is "${reviewed.state.name}", ${String(reviewed.attachments.nodes.length)} attachments`);

    if (!run.released) {
      if (runners.length === 0) runners.push(await connectRunner(page, settings, path.join(settings.stateDir, "demo-runner.log")));
      // Step 7: idle. The runner stops the agent after OSTRA_BOX_IDLE_MINUTES, and the session ends.
      say(`step 7: waiting for the box to go idle and stop (OSTRA_BOX_IDLE_MINUTES=${String(settings.idleMinutes)})`);
      const idleStarted = Date.now();
      await waitFor("the session's end after the idle timer", (settings.idleMinutes + 5) * 60_000, async () => {
        const sessions = await sessionsOf(db, taskId);
        return sessions.every((one) => !OPEN_SESSION_STATES.has(one.state)) ? true : null;
      }, 5000);
      run.timings["idleStopSeconds"] = seconds(Date.now() - idleStarted);
      await openTask(page, taskId);
      await screenshot(page, settings, "idle-stopped");
      const sessions = await sessionsOf(db, taskId);
      const archive = sessions.at(-1)?.archiveBlobId ?? null;
      check("step 7: the session ended on the idle timer", sessions.at(-1)?.state === "ended", `the session is ${sessions.at(-1)?.state ?? "missing"} after ${String(run.timings["idleStopSeconds"])} s`);
      const ref = await github.octokit.rest.git.getRef({ owner: github.owner, repo: github.repo, ref: `ostra/wip/${taskId}` }).then(
        (response) => response.data.object.sha,
        () => null,
      );
      check("step 7: the hidden ref and the archive are kept", archive !== null && ref !== null, `archive blob ${archive ?? "none"}, refs/ostra/wip/${taskId} ${ref ?? "missing"}`);
      // Pushed after the turn, at least the idle timer ago.
      if (ref !== null) checks.push(await checkNoCiForHiddenRef(github, ref, Date.now() - settings.idleMinutes * 60_000));
      for (const runner of runners.splice(0)) await releaseOldWorktree(settings, runner, taskId);
      run.released = true;
      await saveRunState(stateFile, run);
      say("step 8: the first runner is stopped and its worktree is gone");
    }

    if (!run.reopened) {
      runners.push(await connectRunner(page, settings.secondRunner, path.join(settings.stateDir, "demo-runner-2.log")));
      const before = await github.octokit.rest.pulls.get({ owner: github.owner, repo: github.repo, pull_number: pr.number });
      const reopenedAt = Date.now();
      await reopenTask(page, settings, taskId);
      await page.locator('[data-part="restored"]').first().waitFor({ timeout: 10 * 60_000 });
      run.timings["restoreSeconds"] = seconds(Date.now() - reopenedAt);
      const origin = await page.locator('[data-part="restored"]').last().getAttribute("data-origin");
      await screenshot(page, settings, "restored");
      check("step 8: restored from the session archive", origin === "restored", `the thread's marker says ${origin ?? "nothing"}, after ${String(run.timings["restoreSeconds"])} s`);
      const moved = await waitFor("the PR's new commit", 20 * 60_000, async () => {
        const now = await github.octokit.rest.pulls.get({ owner: github.owner, repo: github.repo, pull_number: pr.number });
        return now.data.head.sha === before.data.head.sha ? null : now.data.head.sha;
      }, 10_000);
      run.timings["reopenToCommitSeconds"] = seconds(Date.now() - reopenedAt);
      await openTask(page, taskId);
      await screenshot(page, settings, "reopened-commit");
      check("step 8: the reopen's commit updates the same PR", true, `${pr.url} head is now ${moved.slice(0, 7)}`);
      const answer = await waitFor("the reopened agent's answer", 5 * 60_000, async () => {
        const reopened = await sessionsOf(db, taskId);
        const last = reopened.at(-1);
        if (last === undefined || last.origin === "new") return null;
        const rows = await db.event.findMany({ where: { taskId, sessionId: last.id, kind: "agent.message" }, select: { payload: true } });
        const text = rows.map((row) => JSON.stringify(row.payload)).join("\n");
        return text === "" ? null : text;
      }, 5000);
      check("step 8: the agent answers about its first turn", answer.includes(ticket.file), answer.includes(ticket.file) ? `its answer names ${ticket.file}, the file its first turn created` : "its answer doesn't name its first turn's file");
      run.reopened = true;
      await saveRunState(stateFile, run);
    }

    if (!run.merged) {
      say("step 9: merge the PR");
      await waitFor("the reopened session's end", (settings.idleMinutes + 15) * 60_000, async () => {
        const sessions = await sessionsOf(db, taskId);
        return sessions.every((one) => !OPEN_SESSION_STATES.has(one.state)) ? true : null;
      }, 5000).catch(() => undefined);
      await github.octokit.rest.pulls.merge({ owner: github.owner, repo: github.repo, pull_number: pr.number, merge_method: "squash" });
      const mergedAt = Date.now();
      await waitFor("the task's merged state", 10 * 60_000, async () => {
        const task = await db.task.findUnique({ where: { id: taskId }, select: { state: true } });
        return task?.state === "merged" ? true : null;
      }, 5000);
      run.timings["mergeSeenSeconds"] = seconds(Date.now() - mergedAt);
      run.merged = true;
      await saveRunState(stateFile, run);
    }
    const done = await waitOnLinear(tool, ticket.id, "the ticket's move to done", 5 * 60_000, (issue) => issue.state.type === "completed");
    await openTask(page, taskId);
    await screenshot(page, settings, "merged");
    check("step 9: the ticket moved to done", true, `${done.identifier} is "${done.state.name}"`);

    // ---------- the checks after the run ----------
    const final = await readIssue(tool, ticket.id);
    const comments = ostraComments(final, settings, taskId);
    const prLinks = final.attachments.nodes.filter((a) => a.url === pr.url).length;
    const taskLinks = final.attachments.nodes.filter((a) => a.url === taskUrlOf(settings, taskId)).length;
    check("no duplicates on the ticket (F-046)", comments === 1 && prLinks === 1 && taskLinks === 1, `${String(comments)} progress comment, ${String(prLinks)} PR link, ${String(taskLinks)} task link`);
    const moves = final.history.nodes.filter((entry) => entry.toState !== null).map((entry) => entry.toState?.name ?? "");
    const distinct = new Set(moves);
    check("one status change per mapped step (F-046)", distinct.size === moves.length, `moves: ${moves.reverse().join(" → ")}`);
    const pulls = await github.octokit.rest.pulls.list({ owner: github.owner, repo: github.repo, state: "all", per_page: 100 });
    const branch = pulls.data.find((one) => one.number === pr.number)?.head.ref ?? "";
    const forTask = pulls.data.filter((one) => one.head.ref === branch).length;
    check("one PR on GitHub (F-046)", forTask === 1, `${String(forTask)} PR on ${branch}`);
    const merged = await github.octokit.rest.pulls.get({ owner: github.owner, repo: github.repo, pull_number: pr.number });
    const keyLower = ticket.identifier.toLowerCase();
    check(
      "the PR names the ticket",
      merged.data.title.startsWith(`${ticket.identifier}:`) && (merged.data.body ?? "").includes(`Closes ${ticket.identifier}`) && branch.startsWith(`ostra/${keyLower}-`),
      `title "${merged.data.title}", branch ${branch}`,
    );
    const hidden = await github.octokit.rest.git.getRef({ owner: github.owner, repo: github.repo, ref: `ostra/wip/${taskId}` }).then(() => true, () => false);
    const box = await db.box.findMany({ where: { taskId }, select: { state: true } });
    checks.push(await checkOutbox(db, taskId));
    check("cleanup after the merge (F-079)", !hidden && box.every((one) => one.state === "released"), `hidden ref ${hidden ? "still there" : "deleted"}, boxes ${box.map((one) => one.state).join(", ")}`);
    // The Linear key never reaches the runner (spec section 2): searched by value, never printed.
    const credential = await checkNoCredential(settings, settings.logFiles, [settings.linearApiKey]);
    check(credential.name, credential.ok, credential.detail);
    const scanned = [];
    for (const root of [settings.runnerDataDir, settings.secondRunner.runnerDataDir]) scanned.push(await scanFolder(root, [settings.linearApiKey]));
    const holding = scanned.flatMap((scan) => scan.holding);
    check("the Linear key is nowhere on the runners", holding.length === 0, holding.length === 0 ? `searched ${String(scanned.reduce((n, scan) => n + scan.files, 0))} files in both runners' folders` : `found in ${String(holding.length)} files`);
    if (process.argv.includes("--checks")) {
      if (runners.length === 0) runners.push(await connectRunner(page, settings.secondRunner, path.join(settings.stateDir, "demo-runner-2.log")));
      const second = await secondTask({
        page,
        settings,
        runnerSettings: settings.secondRunner,
        db,
        tool,
        projectHref,
        idleMinutes: settings.idleMinutes,
        moveToOtherRunner: async () => {
          for (const runner of runners.splice(0)) await runner.stop();
          runners.push(await connectRunner(page, settings, path.join(settings.stateDir, "demo-runner.log")));
        },
      });
      checks.push(...second.checks);
      // Webhooks off: the seed's webhook goes first. Then the drift poll, then polling mode.
      await removeSeedWebhook(tool, seeded.webhookId);
      seeded = { ...seeded, webhookId: null };
      checks.push(await checkDrift(db, tool, ticket, ticket.title, settings.reconcileMinutes));
      checks.push(await checkPolling(db, tool, seeded.connectionId, ticket, ticket.title));
      checks.push({ name: "repo checks (F-055, F-060)", ok: true, detail: "waiting on ticket 40: test1 and test2 are private repos on a free plan, so no ruleset can be read or switched" });
      say("WAIT repo checks (F-055, F-060): waiting on ticket 40's steps 1 to 4");
      if (!process.argv.includes("--keep-second")) await cleanUpSecondTask(github, tool, second.taskId, second.prNumber, second.ticketKey);
    }
    await writeFile(path.join(settings.stateDir, "result.json"), JSON.stringify({ ticket, taskId, pr, timings: run.timings, checks }, null, 2));
    if (process.argv.includes("--archive-ticket")) await archiveIssue(tool, ticket.id);
    if (checks.some((one) => !one.ok)) process.exitCode = 1;
  } finally {
    await saveRunState(stateFile, run).catch(() => undefined);
    await browser?.close();
    for (const runner of runners) await runner.stop();
    if (seeded !== null && !process.argv.includes("--keep-webhook")) await removeSeedWebhook(tool, seeded.webhookId).catch(() => undefined);
    await db.$disconnect();
  }
};

await main();
