import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PROGRESS_COMMENT_MARKER } from "@ostra/domain";
import { repoRoot } from "@ostra/e2e-m1/settings";
import { readIssue, updateIssueTitle } from "@ostra/e2e-m2/linear";
import type { TaskId } from "@ostra/protocol";
import { z } from "zod";

import { checkEventsOnce, checkNoDoubles } from "../live/checks.ts";
import { marker } from "../live/stub-model.ts";
import { caseFile, newTicketTask, sessionsOf, taskRow, waitForFileOnBranch, waitForPr, waitForSession, waitForState, waitUntil } from "../live/tasks.ts";
import type { TicketTask } from "../live/tasks.ts";
import type { SuiteRunner, World } from "../live/world.ts";
import { linearWebhookSecret } from "../live/world.ts";
import { runCase, seconds } from "./case.ts";
import type { CaseResult } from "./case.ts";

// The server's rows of spec section 3's table (ticket 38): a restart mid-turn, dropped webhooks,
// replayed webhooks, a retry after a write committed (on the fakes and on the real services through
// the fault proxy), the runaway limits, and spike 8's three kill points.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitForTools = async (world: World, taskId: TaskId, count: number): Promise<void> => {
  await waitUntil(`${String(count)} tool calls of ${taskId}`, 180_000, async () => {
    const last = (await sessionsOf(world, taskId)).at(-1);
    return last !== undefined && (await world.db.event.count({ where: { sessionId: last.id, kind: "tool.called" } })) >= count ? true : null;
  }, 500);
};

type JobRow = { readonly name: string; readonly state: string; readonly key: string | null; readonly due: boolean };

/** The jobs core queued for a task: each one's name, state, key, and whether it was due 30 s ago. */
const jobsOf = async (world: World, taskId: TaskId): Promise<readonly JobRow[]> => {
  const rows = await world.db.$queryRaw<readonly { name: string; state: string; key: string | null; due: boolean }[]>`
    SELECT name, state::text AS state, singleton_key AS key, start_after < now() - interval '30 seconds' AS due
    FROM pgboss.job WHERE data->>'taskId' = ${taskId} ORDER BY name`;
  return rows;
};

export const restartServerCase = (world: World, runner: SuiteRunner): Promise<CaseResult> =>
  runCase("restart-server", "Restart the server mid-turn: kill -9 core and web, start them again", async (c) => {
    const file = caseFile("restart-server", 1);
    const task = await newTicketTask(world, { caseName: "restart-server", marker: marker("slow", `${file} 8 2500`), runner });
    await waitForTools(world, task.taskId, 2);
    const killedAt = Date.now();
    await Promise.all([world.stack.killCore(), world.stack.killWeb()]);
    c.say("core and the panel are killed mid-turn");
    await sleep(5000);
    await world.stack.startCore();
    c.time("coreBackSeconds", seconds(killedAt));
    await world.stack.startWeb();
    c.time("webBackSeconds", seconds(killedAt));
    await waitUntil("the runner back online", 120_000, async () => {
      const row = await world.db.runner.findUnique({ where: { id: runner.runnerId }, select: { state: true } });
      return row?.state === "online" ? true : null;
    });
    c.time("runnerBackSeconds", seconds(killedAt));
    const pr = await waitForPr(world, task.taskId, 300_000);
    await waitForFileOnBranch(world, task.branch, file, 120_000);
    await waitForSession(world, task.taskId, ["idle"], 180_000);
    const row = await taskRow(world, task.taskId);
    c.check("the runner reconnects and the task carries on", row.state === "in_review", `PR #${String(pr.number)} ${String(seconds(killedAt))} s after the kill; the task is ${row.state}`);
    // Every job the task's turn queued ran once: none left behind, none twice.
    await waitUntil("the task's ticket writes done", 120_000, async () => ((await world.db.ticketWrite.count({ where: { taskId: task.taskId, state: "pending" } })) === 0 ? true : null));
    // A timer that waits for its time (the maximum duration, the idle release) is queued, not stuck.
    const jobs = await jobsOf(world, task.taskId);
    const stuck = jobs.filter((job) => job.state === "active" || job.state === "failed" || job.state === "retry" || (job.state === "created" && job.due));
    const done = jobs.filter((job) => job.state === "completed");
    const keys = done.map((job) => `${job.name}:${job.key ?? ""}`);
    const twice = keys.filter((key, index) => keys.indexOf(key) !== index);
    const opened = done.filter((job) => job.name === "task.open-pull-requests").length;
    c.check(
      "queued jobs run once",
      stuck.length === 0 && twice.length === 0 && opened === 1,
      `${String(done.length)} jobs completed, each key once (${[...new Set(done.map((job) => job.name))].join(", ")}); ${String(jobs.length - done.length)} timers waiting for their time; ${String(stuck.length)} stuck`,
    );
    c.add(await checkEventsOnce(world, task.taskId));
    c.add(await checkNoDoubles(world, task));
  });

/** Edits the ticket's title and answers how long the cache took to see it, or `null` within `timeoutMs`. */
const titleArrives = async (world: World, task: TicketTask, timeoutMs: number): Promise<number | null> => {
  const title = `Failure suite: drift ${randomUUID().slice(0, 6)}`;
  const at = Date.now();
  await updateIssueTitle(world.tool, task.issueId, title);
  return waitUntil("the edited title in the cache", timeoutMs, async () => {
    const row = await world.db.ticket.findFirst({ where: { externalId: task.issueId }, select: { title: true } });
    return row?.title === title ? seconds(at) : null;
  }).catch(() => null);
};

export const dropWebhooksCase = (world: World, runner: SuiteRunner): Promise<CaseResult> =>
  runCase("drop-webhooks", "Drop webhooks: block both webhook routes for the case", async (c) => {
    const file = caseFile("drop-webhooks", 1);
    const task = await newTicketTask(world, { caseName: "drop-webhooks", marker: marker("write", file), runner });
    const pr = await waitForPr(world, task.taskId);
    await waitForSession(world, task.taskId, ["idle"], 120_000);
    await world.stack.restartCore({ OSTRA_DEV_BLOCK_WEBHOOKS: "linear,github" });
    c.say("core restarted with both webhook routes blocked");
    const deliveriesBefore = await world.db.webhookDelivery.count({ where: { connectionId: world.connectionId } });
    const arrived = await titleArrives(world, task, 150_000);
    c.time("ticketChangeSeconds", arrived ?? -1);
    c.check("ticket changes arrive within 60 s", arrived !== null && arrived <= 75, arrived === null ? "the edit never reached the cache" : `the edit reached the cache by the drift poll ${String(arrived)} s later (the poll runs every OSTRA_RECONCILE_MINUTES=1; 60 s is the working value, 75 s the bar with the poll's own time)`);
    const deliveriesAfter = await world.db.webhookDelivery.count({ where: { connectionId: world.connectionId } });
    c.check("the blocked route stored nothing", deliveriesAfter === deliveriesBefore, `${String(deliveriesAfter - deliveriesBefore)} deliveries stored while blocked`);
    const mergedAt = Date.now();
    await world.github.octokit.rest.pulls.merge({ owner: world.github.owner, repo: world.github.repo, pull_number: pr.number, merge_method: "squash" });
    const state = await waitForState(world, task.taskId, ["merged", "done"], 5 * 60_000 + 30_000).catch(() => null);
    c.time("mergeSeenSeconds", seconds(mergedAt));
    c.check("a PR merge within 5 min", state !== null && seconds(mergedAt) <= 300, state === null ? "the merge wasn't seen" : `the task is ${state} ${String(seconds(mergedAt))} s after the merge, by the reconcile`);
    await world.stack.restartCore();
    c.say("core restarted with the webhook routes open again");
    c.add(await checkEventsOnce(world, task.taskId));
    c.add(await checkNoDoubles(world, task));
  });

// ---------- replay ----------

const githubSignature = (secret: string, body: string): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const linearSignature = (secret: string, body: string): string => createHmac("sha256", secret).update(body).digest("hex");

/**
 * What the replay compares before and after: Linear's comments, links, status and history on the
 * run's tickets, the outbox, and GitHub's PRs. New deliveries are not compared: Linear sends its own
 * for whatever else happens meanwhile, under new IDs. The replayed IDs are checked on their own.
 */
const effects = async (world: World): Promise<string> => {
  const parts: string[] = [];
  for (const ticket of world.made.tickets) {
    const issue = await readIssue(world.tool, ticket.id).catch(() => null);
    if (issue === null) continue;
    parts.push(`${ticket.identifier}:${String(issue.comments.nodes.length)}c:${String(issue.attachments.nodes.length)}a:${issue.state.id}:${String(issue.history.nodes.length)}h`);
  }
  parts.push(`writes:${String(await world.db.ticketWrite.count({ where: { organizationId: world.organizationId } }))}`);
  const pulls = await world.github.octokit.rest.pulls.list({ owner: world.github.owner, repo: world.github.repo, state: "all", per_page: 100 });
  parts.push(`prs:${String(pulls.data.filter((pull) => pull.head.ref.startsWith("ostra/")).length)}`);
  return parts.join(" ");
};

const payloadSchema = z.looseObject({ type: z.string().optional() });

export const replayWebhooksCase = (world: World, githubWebhookSecret: string, pr: { readonly number: number }): Promise<CaseResult> =>
  runCase("replay-webhooks", "Replay webhooks: resend every delivery the inbox recorded, Linear's and GitHub's", async (c) => {
    const github = await world.db.connection.findFirstOrThrow({ where: { organizationId: world.organizationId, kind: "github" }, select: { id: true } });
    // The App's own webhooks go to the maintainer's address, so the suite delivers GitHub's itself:
    // a `pull_request` event for a PR of this run, signed with the App's secret the panel holds.
    const pull = await world.github.octokit.rest.pulls.get({ owner: world.github.owner, repo: world.github.repo, pull_number: pr.number });
    const repository = await world.github.octokit.rest.repos.get({ owner: world.github.owner, repo: world.github.repo });
    const body = JSON.stringify({ action: "synchronize", number: pr.number, pull_request: pull.data, repository: repository.data, installation: { id: Number(process.env["GITHUB_APP_INSTALLATION_ID"] ?? "0") } });
    const delivered = await fetch(`${world.stack.coreUrl}/webhooks/github/${github.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": randomUUID(), "x-hub-signature-256": githubSignature(githubWebhookSecret, body) },
      body,
    });
    c.check("GitHub's delivery is recorded", delivered.status === 200, `the inbox answered ${String(delivered.status)}`);
    // The cases before this one may still be writing (a needs-you notice is posted after its delay,
    // and Linear's webhook for it follows): the replay starts once nothing has changed for 30 s.
    let before = await effects(world);
    const settleUntil = Date.now() + 5 * 60_000;
    for (;;) {
      await sleep(30_000);
      const now = await effects(world);
      if (now === before || Date.now() > settleUntil) break;
      before = now;
    }
    const deliveries = await world.db.webhookDelivery.findMany({ select: { connectionId: true, deliveryId: true, event: true, payload: true, connection: { select: { kind: true } } } });
    const secret = await linearWebhookSecret(world.db, path.join(repoRoot, ".ostra-dev", "server"), world.connectionId);
    const replayedAt = new Date();
    const answers = new Map<number, number>();
    for (const delivery of deliveries) {
      if (delivery.payload === null) continue;
      let status: number;
      if (delivery.connection.kind === "linear") {
        // Signed again with a fresh timestamp, as Linear's own retry would be: the same delivery ID.
        const fresh = JSON.stringify({ ...Object(delivery.payload), webhookTimestamp: Date.now() });
        const type = payloadSchema.parse(delivery.payload).type ?? delivery.event;
        status = (
          await fetch(`${world.stack.coreUrl}/webhooks/linear/${delivery.connectionId}`, {
            method: "POST",
            headers: { "content-type": "application/json", "linear-delivery": delivery.deliveryId, "linear-event": type, "linear-signature": linearSignature(secret, fresh) },
            body: fresh,
          })
        ).status;
      } else {
        const raw = JSON.stringify(delivery.payload);
        status = (
          await fetch(`${world.stack.coreUrl}/webhooks/github/${delivery.connectionId}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": delivery.event, "x-github-delivery": delivery.deliveryId, "x-hub-signature-256": githubSignature(githubWebhookSecret, raw) },
            body: raw,
          })
        ).status;
      }
      answers.set(status, (answers.get(status) ?? 0) + 1);
    }
    const linearCount = deliveries.filter((one) => one.connection.kind === "linear").length;
    const githubCount = deliveries.length - linearCount;
    c.check("every delivery replayed", deliveries.length > 0 && githubCount > 0 && linearCount > 0, `${String(linearCount)} of Linear's and ${String(githubCount)} of GitHub's; answers ${[...answers].map(([status, n]) => `${String(status)} ×${String(n)}`).join(", ")}`);
    // Long enough for anything a replay set off: the queue polls every 0.5 s and the writer retries in seconds.
    await sleep(20_000);
    const after = await effects(world);
    // The inbox's own proof: no second row for a replayed ID, and no handler ran for one again.
    const ids = deliveries.map((one) => one.deliveryId);
    const rows = await world.db.webhookDelivery.findMany({ where: { deliveryId: { in: ids } }, select: { connectionId: true, deliveryId: true } });
    const distinct = new Set(rows.map((row) => `${row.connectionId}:${row.deliveryId}`)).size;
    const handled = await world.db.$queryRaw<readonly { n: bigint }[]>`
      SELECT count(*) AS n FROM pgboss.job WHERE name = 'webhook.process' AND created_on > ${replayedAt} AND data->>'deliveryId' = ANY(${ids})`;
    const handledAgain = Number(handled[0]?.n ?? 0n);
    c.check(
      "each replayed delivery is stored once and handled once",
      rows.length === deliveries.length && distinct === rows.length && handledAgain === 0,
      `${String(rows.length)} rows for ${String(deliveries.length)} replayed IDs (${String(distinct)} distinct); ${String(handledAgain)} webhook.process jobs queued for them after the replay began`,
    );
    c.check("nothing new happens on Linear or GitHub", after === before, after === before ? `the same comments, links, statuses, history, tracker writes and PRs before and after (${String(world.made.tickets.length)} tickets)` : `before: ${before} / after: ${after}`);
  });

// ---------- retry after a write committed ----------

export const retryLiveCase = (world: World, runner: SuiteRunner): Promise<CaseResult> =>
  runCase("retry-after-commit", "Retry after a write committed: the real services through a fault-injecting proxy", async (c) => {
    const linear = world.faults.linear;
    const github = world.faults.github;
    for (const mutation of ["issueUpdate", "commentCreate", "attachmentCreate", "attachmentLinkGitHubPR"]) {
      linear.arm({ name: `linear ${mutation}`, match: (request) => request.mutation === mutation });
    }
    github.arm({ name: "github POST /pulls", match: (request) => request.method === "POST" && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(request.path) });
    const file = caseFile("retry", 1);
    const task = await newTicketTask(world, { caseName: "retry-after-commit", marker: marker("write", file), runner });
    const pr = await waitForPr(world, task.taskId, 300_000);
    await waitUntil("every fault fired and every ticket write done", 300_000, async () =>
      linear.armed().length === 0 && github.armed().length === 0 && (await world.db.ticketWrite.count({ where: { taskId: task.taskId, state: "pending" } })) === 0 ? true : null,
    ).catch(() => undefined);
    const fired = [...linear.fired(), ...github.fired()];
    c.check("each write was applied and answered 500", fired.length === 5 && fired.every((one) => one.upstreamStatus < 300), fired.map((one) => `${one.name} (the service said ${String(one.upstreamStatus)})`).join(", ") || "no fault fired");
    const issue = await readIssue(world.tool, task.issueId);
    const taskUrl = `${world.m2.publicUrl}/tasks/${task.taskId}`;
    const comments = issue.comments.nodes.filter((comment) => comment.body.includes(taskUrl) && comment.body.includes(PROGRESS_COMMENT_MARKER)).length;
    const taskLinks = issue.attachments.nodes.filter((attachment) => attachment.url === taskUrl).length;
    const prLinks = issue.attachments.nodes.filter((attachment) => attachment.url === pr.url).length;
    const pulls = await world.github.octokit.rest.pulls.list({ owner: world.github.owner, repo: world.github.repo, state: "all", head: `${world.github.owner}:${task.branch}` });
    c.check("no second comment, link, status change or PR", comments === 1 && taskLinks === 1 && prLinks === 1 && pulls.data.length === 1, `${String(comments)} comment, ${String(taskLinks)} task link, ${String(prLinks)} PR link, ${String(pulls.data.length)} PR`);
    c.add(await checkEventsOnce(world, task.taskId));
    c.add(await checkNoDoubles(world, task));
  });

/** The fakes' half, and spike 8's kill points: `apps/core/src/failure-suite.test.ts`, run with OSTRA_FAILURE_SUITE=1. */
export const coreFakesCase = (logFile: string): Promise<CaseResult> =>
  runCase("core-on-fakes", "Kill a replica mid-job (spike 8's three kill points), and a retry after a write committed on the fakes", async (c) => {
    const report = path.join(path.dirname(logFile), "core-on-fakes.json");
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [path.join(repoRoot, "apps", "core", "node_modules", "vitest", "vitest.mjs"), "run", "src/failure-suite.test.ts", "--reporter=json", `--outputFile=${report}`], {
        cwd: path.join(repoRoot, "apps", "core"),
        env: { ...process.env, OSTRA_FAILURE_SUITE: "1" },
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("exit", resolve);
      child.once("error", () => {
        resolve(null);
      });
    });
    const reportSchema = z.looseObject({
      testResults: z.array(z.looseObject({ assertionResults: z.array(z.looseObject({ title: z.string(), status: z.string(), duration: z.number().nullish() })) })),
    });
    const parsed = reportSchema.safeParse(JSON.parse(await readFile(report, "utf8").catch(() => "{}")));
    const tests = parsed.success ? parsed.data.testResults.flatMap((file) => file.assertionResults) : [];
    for (const test of tests.filter((one) => one.status !== "skipped" && one.status !== "pending")) {
      c.check(test.title, test.status === "passed", `${test.status} in ${String(Math.round((test.duration ?? 0) / 100) / 10)} s`);
    }
    c.check("the core suite passed", code === 0 && tests.length > 0, `vitest exited ${String(code)} with ${String(tests.length)} tests`);
  });

// ---------- runaway limits ----------

export const limitsCase = (world: World, runner: SuiteRunner): Promise<CaseResult> =>
  runCase("limits", "Stall, maximum duration, spend cap: the timers at seconds and the cap at cents", async (c) => {
    // Core's runaway timers in seconds and the cap at cents, for this case only.
    await world.stack.restartCore({ CORE_TEST_STALL_MS: "30000", CORE_TEST_SESSION_MAX_MS: "120000", OSTRA_TASK_SPEND_CAP_USD: "0.25" });
    c.say("core restarted with the stall at 30 s, the maximum duration at 120 s and the cap at 0.25 USD");
    const [stall, busy, spend] = await Promise.all([
      newTicketTask(world, { caseName: "limits-stall", marker: marker("stall", ""), runner }),
      newTicketTask(world, { caseName: "limits-max-duration", marker: marker("busy", ""), runner }),
      newTicketTask(world, { caseName: "limits-spend-cap", marker: marker("spend", caseFile("spend", 1)), runner }),
    ]);
    const expect = [
      { task: stall, limit: "stall", reason: "stalled" },
      { task: busy, limit: "max_duration", reason: "stalled" },
      { task: spend, limit: "spend_cap", reason: "spend_cap" },
    ] as const;
    for (const one of expect) {
      const session = await waitUntil(`${one.limit} on ${one.task.identifier}`, 300_000, async () => {
        const last = (await sessionsOf(world, one.task.taskId)).at(-1);
        return last?.limitReached === null || last === undefined ? null : last;
      }, 2000).catch(() => null);
      const item = await waitUntil(`the needs-you item of ${one.task.identifier}`, 60_000, () =>
        world.db.needsYouItem.findFirst({ where: { taskId: one.task.taskId, reason: one.reason, state: "open" }, select: { id: true } }),
      ).catch(() => null);
      const ended = session === null ? null : await waitForSession(world, one.task.taskId, ["ended", "stopped"], 120_000).catch(() => null);
      const row = await taskRow(world, one.task.taskId);
      // The session's own clock: from its start to its end, not to when this loop looked.
      const endedAt = ended?.endedAt ?? null;
      const lasted = ended === null || endedAt === null ? null : Math.round((endedAt.getTime() - ended.startedAt.getTime()) / 100) / 10;
      c.time(`${one.limit}Seconds`, lasted ?? -1);
      c.check(
        `${one.limit} stops the session cleanly, and the task needs you`,
        session?.limitReached === one.limit && item !== null && ended !== null,
        `${one.task.identifier}: limit ${session?.limitReached ?? "none"}, the session ${ended?.state ?? "still open"} after ${lasted === null ? "?" : String(lasted)} s, needs-you ${item === null ? "missing" : one.reason}, task ${row.state}${one.limit === "spend_cap" ? ` at ${String(row.spentMicroUsd / 1_000_000)} USD` : ""}`,
      );
      c.add(await checkEventsOnce(world, one.task.taskId));
    }
    await world.stack.restartCore();
    c.say("core restarted with the usual limits");
    for (const one of expect) c.add(await checkNoDoubles(world, one.task));
  });
