import type { Db } from "@ostra/db";
import type { CheckResult } from "@ostra/e2e-m1/checks";
import type { DemoGitHub } from "@ostra/e2e-m1/github";
import type { DemoSettings } from "@ostra/e2e-m1/settings";
import { say, screenshot, startTask } from "@ostra/e2e-m1/setup";
import type { TaskId } from "@ostra/protocol";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { archiveIssue, updateIssueTitle } from "./linear.ts";
import type { LinearTool } from "./linear.ts";

// The checks after the run that need more than the main task (spec section 3): no CI for a hidden
// ref (F-096), the tracker writer's outbox (F-046), a ticket change by polling alone (F-042), and a
// second task that gets a ticket with "Create ticket" (F-097) and then reopens from the rebuild
// template alone (F-033, step 3).

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const waitUntil = async <T,>(what: string, timeoutMs: number, read: () => Promise<T | null>, everyMs = 2000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
};

const result = (name: string, ok: boolean, detail: string): CheckResult => {
  say(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  return { name, ok, detail };
};

/** F-096: a hidden ref starts no CI. `test1` has a push workflow (ticket 40), and a branch push starts it within 45 s. */
export const checkNoCiForHiddenRef = async (github: DemoGitHub, sha: string, savedAt: number): Promise<CheckResult> => {
  const wait = savedAt + 60_000 - Date.now();
  if (wait > 0) await sleep(wait);
  const runs = await github.octokit.rest.actions.listWorkflowRunsForRepo({ owner: github.owner, repo: github.repo, head_sha: sha, per_page: 10 });
  return result("the hidden ref starts no CI (F-096)", runs.data.total_count === 0, `${String(runs.data.total_count)} workflow runs for ${sha.slice(0, 7)} at least 60 s after it was pushed`);
};

/** F-046: one write per mapped step in the tracker writer's outbox, each applied. */
export const checkOutbox = async (db: Db, taskId: TaskId): Promise<CheckResult> => {
  const writes = await db.ticketWrite.findMany({ where: { taskId }, select: { kind: true, state: true, idempotencyKey: true } });
  const moves = writes.filter((write) => write.kind === "move").map((write) => write.idempotencyKey.split(":").at(-1) ?? "");
  const comments = writes.filter((write) => write.kind === "comment").length;
  const links = writes.filter((write) => write.kind === "link_task").length;
  const pending = writes.filter((write) => write.state !== "done").length;
  const ok = moves.join(",") === "started,in-review,done" && comments === 1 && links === 1 && pending === 0;
  return result("one tracker write per step (F-046)", ok, `moves ${moves.join(" → ")}, ${String(comments)} comment, ${String(links)} task link, ${String(writes.length - pending)} of ${String(writes.length)} writes done`);
};

/** Edits the ticket's title in Linear and answers how many seconds the new title took to reach the ticket cache, or `null`. */
const titleReachesCache = async (db: Db, tool: LinearTool, ticketId: string, title: string, suffix: string, timeoutMs: number): Promise<number | null> => {
  const changed = `${title} (${suffix})`;
  const at = Date.now();
  await updateIssueTitle(tool, ticketId, changed);
  const seen = await waitUntil("the polled title", timeoutMs, async () => {
    const row = await db.ticket.findFirst({ where: { externalId: ticketId }, select: { title: true } });
    return row?.title === changed ? Date.now() : null;
  }, 1000).catch(() => null);
  await updateIssueTitle(tool, ticketId, title);
  return seen === null ? null : Math.round((seen - at) / 1000);
};

/**
 * F-044: on a webhooks connection whose webhook is gone (the seed's is deleted first), a change made
 * in Linear still reaches the ticket cache, by the drift poll every `OSTRA_RECONCILE_MINUTES`.
 */
export const checkDrift = async (db: Db, tool: LinearTool, ticket: { readonly id: string; readonly identifier: string }, title: string, reconcileMinutes: number): Promise<CheckResult> => {
  const limit = reconcileMinutes * 60 + 15;
  const taken = await titleReachesCache(db, tool, ticket.id, title, "drift", (limit + 60) * 1000);
  return result(
    "with webhooks off, a ticket change still arrives (F-044)",
    taken !== null && taken <= limit,
    taken === null ? "the change never reached the cache" : `${ticket.identifier}'s new title reached the cache ${String(taken)} s after the edit, with no webhook (the drift poll runs every ${String(reconcileMinutes)} min)`,
  );
};

/**
 * F-042: a connection in polling mode, as on an install Linear can't reach, gets every ticket change
 * within the poll interval (60 s), plus the job's own start.
 */
export const checkPolling = async (db: Db, tool: LinearTool, connectionId: string, ticket: { readonly id: string; readonly identifier: string }, title: string): Promise<CheckResult> => {
  // What the seed writes when there's no public address. Core's 30 s tick moves the board's schedule.
  await db.connection.update({ where: { id: connectionId }, data: { webhookMode: "polling" } });
  await sleep(40_000);
  const taken = await titleReachesCache(db, tool, ticket.id, title, "polled", 180_000);
  return result(
    "a private install gets every ticket change by polling (F-042)",
    taken !== null && taken <= 75,
    taken === null ? "the change never reached the cache" : `in polling mode, ${ticket.identifier}'s new title reached the cache ${String(taken)} s after the edit`,
  );
};

const CODENAME = "HERON-7";
const README_WORD = "kingfisher";

const FIRST_PROMPT =
  `Our project's codename is ${CODENAME}. Create docs/heron.md holding one line with the codename. ` +
  'Then run this command and tell me what it printed: node -e "console.log(17 * 23)". ' +
  "Finally, pick a TCP port between 4100 and 4199 for a future preview server, and name it in your last sentence.";
const SECOND_PROMPT = `In README.md, add the word ${README_WORD} on its own line at the end.`;
const QUESTIONS =
  "Answer from what you remember of this task, without running any tool or reading any file: " +
  "1. What is our project's codename? 2. Which file did you create in your first turn? 3. What did the node command print? " +
  "4. Which word did I ask you to add to the README? 5. Which port did you pick for the preview server?";

const messageSchema = z.object({ kind: z.literal("agent.message"), text: z.string() });

/** The agent's messages in the task, oldest first. */
const agentMessages = async (db: Db, taskId: TaskId, sessionIds?: readonly string[]): Promise<readonly string[]> => {
  const rows = await db.event.findMany({
    where: { taskId, kind: "agent.message", ...(sessionIds === undefined ? {} : { sessionId: { in: [...sessionIds] } }) },
    orderBy: [{ seq: "asc" }],
    select: { payload: true },
  });
  return rows.flatMap((row) => {
    const parsed = messageSchema.safeParse(row.payload);
    return parsed.success ? [parsed.data.text] : [];
  });
};

/** Which of spike 2's five facts the answer holds. */
export const scoreAnswers = (answer: string, port: string | null): readonly { readonly question: string; readonly ok: boolean }[] => [
  { question: "the codename", ok: answer.includes(CODENAME) },
  { question: "the file it created", ok: answer.includes("heron.md") },
  { question: "the command's output", ok: answer.includes("391") },
  { question: "the README's word", ok: answer.toLowerCase().includes(README_WORD) },
  { question: "the port it picked", ok: port !== null && answer.includes(port) },
];

const OPEN = new Set(["starting", "running", "waiting", "idle"]);

const sessionsSettled = async (db: Db, taskId: TaskId): Promise<boolean> =>
  (await db.session.findMany({ where: { taskId }, select: { state: true } })).every((session) => !OPEN.has(session.state));

/**
 * The second task: a prompt task on the second runner that sets spike 2's five facts over two
 * turns, gets a ticket with "Create ticket" (F-097), stops on the idle timer, loses its archive, and
 * reopens with the five questions from the rebuild template alone.
 */
export const secondTask = async (input: {
  readonly page: Page;
  readonly settings: DemoSettings;
  readonly runnerSettings: DemoSettings;
  readonly db: Db;
  readonly tool: LinearTool;
  readonly projectHref: string;
  readonly idleMinutes: number;
  /** Takes the task's box away: its runner goes offline and another one comes online, so a reopen gets a fresh box. */
  readonly moveToOtherRunner: () => Promise<void>;
}): Promise<{ readonly checks: readonly CheckResult[]; readonly taskId: TaskId; readonly prNumber: number | null; readonly ticketKey: string | null }> => {
  const { page, settings, db } = input;
  const checks: CheckResult[] = [];
  say("checks: a second task, for Create ticket and the rebuild template");
  const taskId = await startTask(page, input.runnerSettings, input.projectHref, FIRST_PROMPT);
  const pr = await waitUntil("the second task's PR", 20 * 60_000, async () => {
    const row = await db.taskRepo.findFirst({ where: { taskId, prNumber: { not: null } }, select: { prNumber: true, headSha: true } });
    return row?.prNumber === undefined || row.prNumber === null ? null : { number: row.prNumber, head: row.headSha };
  }, 3000);
  await page.goto(`/tasks/${taskId}`);

  // F-097: "Create ticket" on a prompt task, linked both ways.
  await page.getByRole("button", { name: "Create ticket" }).click({ timeout: 60_000 });
  const ticketKey = await waitUntil("the created ticket", 120_000, async () => {
    const row = await db.task.findUnique({ where: { id: taskId }, select: { ticketKey: true } });
    return row?.ticketKey ?? null;
  });
  const taskUrl = `${settings.publicUrl}/tasks/${taskId}`;
  const linked = await waitUntil("the created ticket's link to the task", 60_000, async () => {
    const issue = z
      .object({ issue: z.object({ attachments: z.object({ nodes: z.array(z.object({ url: z.string() })) }) }) })
      .parse(await input.tool.call("query ($id: String!) { issue(id: $id) { attachments(first: 20) { nodes { url } } } }", { id: ticketKey }));
    return issue.issue.attachments.nodes.some((node) => node.url === taskUrl) ? true : null;
  }).catch(() => false);
  await page.reload();
  await page.getByText(ticketKey).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  await screenshot(page, settings, "create-ticket");
  checks.push(result("Create ticket links a prompt task both ways (F-097)", linked, `${ticketKey} on Linear links the task, and the task names ${ticketKey}`));

  // The second turn, on the warm box. The task is in review and its session idle, so the composer
  // reopens it, and the reopen resumes the same box (ADR 0039's first step).
  const composer = page.locator("textarea").first();
  await composer.fill(SECOND_PROMPT);
  await page.locator('[data-action="send"], [data-action="reopen"]').first().click();
  const resumed = await page.locator('[data-part="restored"]').first().waitFor({ timeout: 5 * 60_000 }).then(
    async () => page.locator('[data-part="restored"]').last().getAttribute("data-origin"),
    () => null,
  );
  await screenshot(page, settings, "resumed");
  checks.push(result("a reopen on the warm box resumes it (F-033)", resumed === "resumed", `the thread says ${resumed ?? "nothing"}`));
  await waitUntil("the second turn's commit", 15 * 60_000, async () => {
    const row = await db.taskRepo.findFirst({ where: { taskId }, select: { headSha: true } });
    return row !== null && row.headSha !== null && row.headSha !== pr.head ? true : null;
  }, 3000);
  const firstMessages = await agentMessages(db, taskId);
  const port = /\b41\d\d\b/.exec(firstMessages.join("\n"))?.[0] ?? null;

  // The idle timer ends the session. Then its archive is lost and its box's runner goes away, so
  // the reopen has neither a kept box nor an archive: core chooses the rebuild template.
  await waitUntil("the second task's idle stop", (input.idleMinutes + 15) * 60_000, async () => ((await sessionsSettled(db, taskId)) ? true : null), 5000);
  const sessions = await db.session.findMany({ where: { taskId, archiveBlobId: { not: null } }, select: { archiveBlobId: true } });
  const blobIds = sessions.flatMap((session) => (session.archiveBlobId === null ? [] : [session.archiveBlobId]));
  await db.blob.deleteMany({ where: { id: { in: blobIds } } });
  say(`checks: deleted ${String(blobIds.length)} session archives of task ${taskId}`);
  await input.moveToOtherRunner();

  const before = new Set((await db.session.findMany({ where: { taskId }, select: { id: true } })).map((session) => session.id));
  await page.goto(`/tasks/${taskId}`);
  await page.locator("textarea").first().fill(QUESTIONS);
  await page.locator('[data-action="reopen"]').click();
  const origin = await waitUntil("the reopened session's restore", 10 * 60_000, async () => {
    const rows = await db.event.findMany({ where: { taskId, kind: "session.restored", sessionId: { notIn: [...before] } }, select: { payload: true } });
    const parsed = z.object({ origin: z.string() }).safeParse(rows.at(-1)?.payload);
    return parsed.success ? parsed.data.origin : null;
  }, 3000);
  const fresh = await waitUntil("the reopened session's answer", 15 * 60_000, async () => {
    const ids = (await db.session.findMany({ where: { taskId }, select: { id: true } })).map((session) => session.id).filter((id) => !before.has(id));
    const answers = ids.length === 0 ? [] : await agentMessages(db, taskId, ids);
    const settled = await sessionsSettled(db, taskId);
    const idle = (await db.session.count({ where: { id: { in: ids }, state: "idle" } })) > 0;
    return answers.length > 0 && (idle || settled) ? answers.join("\n") : null;
  }, 5000);
  await page.reload();
  await screenshot(page, settings, "rebuilt");
  const score = scoreAnswers(fresh, port);
  const right = score.filter((item) => item.ok).length;
  checks.push(
    result(
      "reopened from the rebuild template alone (F-033)",
      origin === "rebuilt" && right >= 4,
      `the session was ${origin}; ${String(right)} of 5 answers right${score.some((item) => !item.ok) ? ` (missed: ${score.filter((item) => !item.ok).map((item) => item.question).join(", ")})` : ""}`,
    ),
  );
  return { checks, taskId, prNumber: pr.number, ticketKey };
};

/** Closes the second task's PR, deletes its branch and hidden ref, and archives its ticket: none is kept (spec section 3, "Clean-up"). */
export const cleanUpSecondTask = async (github: DemoGitHub, tool: LinearTool, taskId: TaskId, prNumber: number | null, ticketKey: string | null): Promise<void> => {
  await github.octokit.rest.git.deleteRef({ owner: github.owner, repo: github.repo, ref: `ostra/wip/${taskId}` }).catch(() => undefined);
  if (prNumber !== null) {
    const pull = await github.octokit.rest.pulls.get({ owner: github.owner, repo: github.repo, pull_number: prNumber });
    if (pull.data.state === "open") await github.octokit.rest.pulls.update({ owner: github.owner, repo: github.repo, pull_number: prNumber, state: "closed" });
    await github.octokit.rest.git.deleteRef({ owner: github.owner, repo: github.repo, ref: `heads/${pull.data.head.ref}` }).catch(() => undefined);
  }
  if (ticketKey !== null) await archiveIssue(tool, ticketKey);
};
