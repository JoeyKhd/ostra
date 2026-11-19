import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { GitHubAdapter } from "@ostra/adapter-github";
import { createLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  CHECKS_SECTION_START,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  reconcileBehind,
  reopenTask,
  requestUpdateBranchWith,
  systemClock,
} from "@ostra/domain";
import type { M3Deps, MemberScope, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  checkIdSchema,
  clientMessageIdSchema,
  connectionIdSchema,
  gitShaSchema,
  memberIdSchema,
  readMarkedBlocks,
  repoFullNameSchema,
  repoIdSchema,
  segmentIdSchema,
  sessionIdSchema,
  taskEventSchema,
  turnIdSchema,
  webhookDeliveryIdSchema,
} from "@ostra/protocol";
import type { CheckId, CheckStatus, ConnectionId, RepoId, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { githubCommentHandler, prCommentHook } from "../code-host/pr-comments.ts";
import { githubWebhookHandler, reconcilePullRequests } from "../code-host/pull-requests.ts";
import type { PullRequestStateDeps } from "../code-host/pull-requests.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { acceptedTask, jobContext } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { seedOnlineRunner, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import type { WebhookDeliveryContext } from "../webhooks/process.ts";
import { openPullRequestsHandler } from "./session-end.ts";
import type { ReactionDeps } from "./session-end.ts";

// Milestone 3, tickets 23 to 25, live on ostra-test/test1 with the test App (F-054, F-070, F-066,
// F-053). Core's real code paths, with the real GitHub adapter in place of the fake code host: the
// PR opener, the push webhook's handler, the reconciles, the reopen and the `@ostra` jobs. The
// runner's part (its commits and pushes) is played by the App's token through GitHub's REST API.
//
// Gated on the test App's credentials (`~/.config/ostra-dev/github.env` and `github-test.env`), so
// it never runs in CI: its run's log is the evidence (`apps/core/evidence/m3-pr-live.txt`). It works
// on branches of its own, merges only into a base branch it made, and deletes every branch it made;
// its PRs stay on GitHub, closed or merged, as the record.
//
// GitHub doesn't deliver the App's webhooks here: the test App has no webhook (ticket 51, step 9).
// So each webhook is built from GitHub's own objects (the REST answer for the comment, the repo and
// the commit) in the shape GitHub sends, stored in the inbox as milestone 2's route stores it, and
// read by the real adapter's `parseWebhook`. There's no second GitHub user's token either (step 10):
// the comments are the App's own, so the first is dropped as an unlinked bot's, and then a member
// is linked to the App's account to stand in for a person.

const envSchema = z.object({
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1),
  GITHUB_APP_INSTALLATION_ID: z.string().min(1),
  GITHUB_TEST_ORG: z.string().min(1),
  GITHUB_TEST_REPO: z.string().min(1),
});
const env = envSchema.safeParse(process.env);
const userAgent = "ostra-core-m3-live-test/0.0.0";

const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));

/** What the test prints for the evidence: IDs, numbers and URLs, never a token. */
const note = (line: string): void => {
  process.stdout.write(`[m3-live] ${line}\n`);
};

describe.skipIf(!env.success)("milestone 3's PR flow, live on the test org (F-054, F-070, F-066, F-053)", () => {
  let test: TestDatabase;
  let fixture: IsolationFixture;
  let jobs: Jobs;
  let world: World;
  let ingest: Ingest;
  let liveText: LiveTextWriter;
  let reactionDeps: ReactionDeps;
  let prDeps: PullRequestStateDeps;
  let deps: M3Deps;
  let runner: RunnerRef;
  let timers: SessionTimers;
  let driver: MemberScope;
  let connectionId: ConnectionId;
  let lintCheck: CheckId;
  let token = "";
  let fullName = "";
  let hostRepoId = 0;
  let installationId = "";
  let base = "";
  const madeBranches: string[] = [];
  const madePulls: number[] = [];
  const secretStore = new FakeSecretStore();

  const config = (): z.infer<typeof envSchema> => {
    if (!env.success) throw new Error("the live environment is not loaded");
    return env.data;
  };

  // ---------- GitHub's REST API, as the runner and the people would use it ----------

  const api = async (path: string, init: { readonly method?: string; readonly body?: unknown } = {}): Promise<{ readonly status: number; readonly json: unknown }> => {
    const response = await fetch(`https://api.github.com${path.startsWith("/repos") ? path : `/repos/${fullName}${path}`}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "user-agent": userAgent, accept: "application/vnd.github+json", "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    const json: unknown = text === "" ? null : JSON.parse(text);
    return { status: response.status, json };
  };
  const field = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((at, key) => Reflect.get(Object(at), key), value);
  const text = (value: unknown, ...path: string[]): string => {
    const found = field(value, ...path);
    if (typeof found !== "string") throw new Error(`no ${path.join(".")}`);
    return found;
  };
  const num = (value: unknown, ...path: string[]): number => {
    const found = field(value, ...path);
    if (typeof found !== "number") throw new Error(`no ${path.join(".")}`);
    return found;
  };
  const headOf = async (branch: string): Promise<string> => text((await api(`/git/ref/heads/${branch}`)).json, "object", "sha");
  const makeBranch = async (branch: string, from: string): Promise<void> => {
    const made = await api("/git/refs", { method: "POST", body: { ref: `refs/heads/${branch}`, sha: from } });
    expect(made.status).toBe(201);
    madeBranches.push(branch);
  };
  /** A commit of one file on `branch`, as a turn's push or a person's push would make it: its SHA. */
  const commitFile = async (branch: string, path: string, content: string): Promise<string> => {
    const existing = await api(`/contents/${path}?ref=${encodeURIComponent(branch)}`);
    const put = await api(`/contents/${path}`, {
      method: "PUT",
      body: {
        message: `test: ${path} for ostra's milestone 3 live test`,
        content: Buffer.from(content).toString("base64"),
        branch,
        ...(existing.status === 200 ? { sha: text(existing.json, "sha") } : {}),
      },
    });
    expect([200, 201]).toContain(put.status);
    return text(put.json, "commit", "sha");
  };
  const pull = async (number: number): Promise<unknown> => (await api(`/pulls/${String(number)}`)).json;
  const eyesOn = async (kind: "issue" | "review", commentId: number): Promise<number> => {
    const listed = await api(kind === "issue" ? `/issues/comments/${String(commentId)}/reactions` : `/pulls/comments/${String(commentId)}/reactions`);
    return Array.isArray(listed.json) ? listed.json.filter((reaction) => field(reaction, "content") === "eyes").length : -1;
  };

  // ---------- core, on the real repo ----------

  beforeAll(async () => {
    // GitHub refuses an App's JWT stamped by a clock that is off; run on GitHub's clock (as the adapter's live test does).
    const head = await fetch("https://api.github.com/zen", { method: "HEAD", headers: { "user-agent": userAgent } });
    const date = head.headers.get("date");
    const skew = date === null ? 0 : Date.parse(date) - Date.now();
    if (Math.abs(skew) > 30_000) {
      const realNow = Date.now.bind(Date);
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    }
    const live = config();
    const privateKey = await readFile(live.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
    fullName = `${live.GITHUB_TEST_ORG}/${live.GITHUB_TEST_REPO}`;
    installationId = live.GITHUB_APP_INSTALLATION_ID;
    const github = new GitHubAdapter({ userAgent }, { logger, clock: adapterClock });
    const minted = await github.mintRepoToken(
      { app: { appId: live.GITHUB_APP_ID, privateKey }, installationId, repo: repoFullNameSchema.parse(fullName) },
      { contents: "write", pull_requests: "write", metadata: "read" },
    );
    if (!minted.ok) throw new Error(`minting failed: ${minted.error.code}`);
    token = minted.value.token;
    hostRepoId = num((await api(`/repos/${fullName}`)).json, "id");

    test = await createTestDatabase();
    fixture = await seedIsolationFixture(test.db);
    jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
    await jobs.start();
    // The first-run setup, then pointed at the real App and repo.
    world = await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore }, fixture.a.organization.id, fixture.a.openProject.id, { fullName });
    const keyRef = await secretStore.put({ organizationId: world.organizationId, purpose: "github-app.private-key" }, privateKey);
    if (!keyRef.ok) throw new Error("the secret store refused");
    const repoRow = await test.db.repo.findUniqueOrThrow({ where: { id: world.repoId } });
    connectionId = connectionIdSchema.parse(repoRow.connectionId);
    await test.db.connection.update({ where: { id: connectionId }, data: { appId: live.GITHUB_APP_ID, privateKeySecretRef: keyRef.value } });
    await test.db.repo.update({ where: { id: world.repoId }, data: { installationId, hostRepoId: String(hostRepoId) } });
    const environment = await test.db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
    lintCheck = checkIdSchema.parse(
      (
        await test.db.check.create({
          data: { organizationId: world.organizationId, projectId: world.projectId, environmentId: environment.id, name: "lint", command: "pnpm lint", repoId: world.repoId, position: 0, timeoutSeconds: 300 },
        })
      ).id,
    );

    timers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
    liveText = createLiveTextWriter({ db: test.db, logger });
    ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox });
    const adapters = { codeHost: github, secretStore, modelProvider: new FakeModelProvider() };
    reactionDeps = { db: test.db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters, publicUrl: "http://localhost:3000", logger, timers };
    prDeps = {
      db: test.db,
      jobs,
      notices: postgresChangeNotices,
      audit: postgresAuditLog,
      clock: systemClock,
      codeHost: github,
      secretStore,
      logger,
      onComment: prCommentHook({ db: test.db, jobs }),
    };
    deps = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters };
    runner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 50);
    await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { minor: 2 } });
    driver = { organizationId: world.organizationId, memberId: memberIdSchema.parse(fixture.a.member.id), role: "member", projectRoles: new Map() };

    // The task's base: a branch of its own off main, so the merge below never touches main.
    base = `ostra-live/m3-base-${randomBytes(4).toString("hex")}`;
    await makeBranch(base, await headOf("main"));
    note(`repo ${fullName}, base branch ${base}`);
  }, 180_000);

  afterAll(async () => {
    if (token !== "") {
      for (const number of madePulls) {
        const now = await pull(number);
        if (field(now, "state") === "open") await api(`/pulls/${String(number)}`, { method: "PATCH", body: { state: "closed" } });
      }
      for (const branch of madeBranches) await api(`/git/refs/heads/${branch}`, { method: "DELETE" });
    }
    await liveText.stop();
    await jobs.stop({ graceful: false, timeoutMs: 2_000 });
    await test.dispose();
  }, 120_000);

  const repo = (): RepoId => repoIdSchema.parse(world.repoId);

  /** One turn on `task`: its push of `head`, its lint run, its save; then the PR opener, as its job would run. */
  const turn = async (task: DrivenTask, ordinal: number, head: string, lint: CheckStatus | null, tail = "lint output"): Promise<void> => {
    const row = await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } });
    const turnId = turnIdSchema.parse(`turn-${String(ordinal)}`);
    const headSha = gitShaSchema.parse(head);
    const events: TaskEvent[] = [
      { kind: "turn.started", turnId },
      { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse(`s${String(ordinal)}`), text: `Turn ${String(ordinal)} of ostra's live test.` },
      { kind: "git.pushed", repoId: repo(), branch: row.branchName, headSha, ref: `refs/heads/${row.branchName}` },
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
    ];
    if (lint !== null) {
      events.push(
        { kind: "check.started", checkId: lintCheck, repoId: repo(), name: "lint" },
        { kind: "check.finished", checkId: lintCheck, status: lint, exitCode: lint === "passed" ? 0 : 1, durationMs: 900, outputTail: tail, outputBlobId: null },
      );
    }
    events.push({
      kind: "session.saved",
      turnOrdinal: ordinal,
      repos: [{ repoId: repo(), headSha, ahead: true, hiddenRefSha: headSha }],
      archive: null,
      ...(lint === null ? {} : { checks: [{ checkId: lintCheck, status: lint }] }),
    });
    await task.send(...events);
    const saved = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.saved" }, orderBy: { seq: "desc" } });
    const payload = { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: saved.seq };
    if ((await jobs.find("task.open-pull-requests", payload)).length > 0) {
      await openPullRequestsHandler(reactionDeps)(jobContext("task.open-pull-requests", payload, logger));
    }
  };

  const taskRepoOf = (task: DrivenTask) => test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } });

  /** A webhook GitHub would send, stored in the inbox as milestone 2's route stores it, then `webhook.process`'s handler. */
  const deliver = async (event: string, payload: Readonly<Record<string, unknown>>) => {
    const deliveryId = webhookDeliveryIdSchema.parse(randomUUID());
    const body = JSON.stringify(payload);
    await test.db.$executeRaw`
      INSERT INTO "webhook_delivery" ("id", "organizationId", "connectionId", "deliveryId", "event", "payload")
      VALUES (${randomUUID()}, ${world.organizationId}, ${connectionId}, ${deliveryId}, ${event}, ${body}::jsonb)`;
    const context: WebhookDeliveryContext = { organizationId: world.organizationId, connectionId, deliveryId, event, payload, receivedAt: Date.now(), logger };
    return githubWebhookHandler(prDeps)(context);
  };
  const envelope = () => ({ installation: { id: Number(installationId) }, repository: { id: hostRepoId, full_name: fullName } });

  /** The `github.comment` job a comment's delivery queued, run as the worker would. */
  const runCommentJob = async (commentId: number): Promise<void> => {
    const queued = { organizationId: world.organizationId, connectionId, commentId: String(commentId) };
    if ((await jobs.find("github.comment", queued)).length > 0) {
      await githubCommentHandler({ ...deps, timers })(jobContext("github.comment", queued, logger));
    }
  };

  const reopen = (task: DrivenTask, message: string) =>
    test.db.$transaction((tx) =>
      reopenTask(
        { tx, scope: driver, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, timers },
        { taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(`reopen-${randomUUID()}`), text: message },
      ),
    );

  /** The task's newest session, accepted by the runner, as the dispatch would leave it. */
  const nextSession = async (task: DrivenTask): Promise<DrivenTask> => {
    const session = await test.db.session.findFirstOrThrow({ where: { taskId: task.taskId }, orderBy: { startedAt: "desc" } });
    return acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner, { taskId: task.taskId, sessionId: sessionIdSchema.parse(session.id), organizationId: task.organizationId });
  };

  const messagesOf = async (taskId: string, intent: string) =>
    (await test.db.event.findMany({ where: { taskId, kind: "user.message" }, orderBy: { seq: "asc" } })).flatMap((row) => {
      const parsed = taskEventSchema.safeParse(row.payload);
      return parsed.success && parsed.data.kind === "user.message" && parsed.data.intent === intent ? [parsed.data] : [];
    });

  it("F-054, F-070, F-066, F-053: checks draft and ready the PR, a moved base is behind, a merge reopens on -2, and @ostra is heard", { timeout: 600_000 }, async () => {
    // ---- Ticket 23 (F-054): a failing check opens a draft with the Checks section ----
    const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner);
    const branch = `ostra-live/m3-task-${randomBytes(4).toString("hex")}`;
    await test.db.task.update({ where: { id: task.taskId }, data: { branchName: branch } });
    await test.db.taskRepo.updateMany({ where: { taskId: task.taskId }, data: { branchName: branch, baseBranch: base } });
    await makeBranch(branch, await headOf(base));
    const head1 = await commitFile(branch, `${branch.replaceAll("/", "-")}.md`, "One.\n");
    await turn(task, 1, head1, "failed", "src/app.ts:3 <b>error</b> `no-unused-vars` | **bold**");
    const first = await taskRepoOf(task);
    if (first.prNumber === null) throw new Error("no PR was opened");
    const number = first.prNumber;
    madePulls.push(number);
    let pr = await pull(number);
    note(`ticket 23: PR #${String(number)} opened as a draft: ${text(pr, "html_url")}`);
    expect(field(pr, "draft")).toBe(true);
    expect(text(pr, "base", "ref")).toBe(base);
    expect(text(pr, "body").split(CHECKS_SECTION_START)).toHaveLength(2);
    expect(text(pr, "body")).toContain("- **lint**: ❌ failed");
    // The check's output is data in a code block: GitHub keeps its markup as text.
    expect(text(pr, "body")).toContain("<b>error</b>");
    const fence = text(pr, "body").indexOf("```");
    expect(fence).toBeGreaterThan(-1);
    expect(fence).toBeLessThan(text(pr, "body").indexOf("<b>error</b>"));

    // A person adds a line to the description on GitHub; the next turn passes: ready, the section edited, the line kept.
    expect((await api(`/pulls/${String(number)}`, { method: "PATCH", body: { body: `${text(pr, "body")}\n\nA reviewer's note, kept.` } })).status).toBe(200);
    const head2 = await commitFile(branch, `${branch.replaceAll("/", "-")}.md`, "One.\nTwo.\n");
    await turn(task, 2, head2, "passed");
    pr = await pull(number);
    note(`ticket 23: after a passing turn, PR #${String(number)} is ready: draft=${String(field(pr, "draft"))}`);
    expect(field(pr, "draft")).toBe(false);
    expect(text(pr, "body").split(CHECKS_SECTION_START)).toHaveLength(2);
    expect(text(pr, "body")).toContain("- **lint**: ✅ passed");
    expect(text(pr, "body")).not.toContain("<b>error</b>");
    expect(text(pr, "body")).toContain("A reviewer's note, kept.");
    expect(await test.db.taskPullRequest.findFirst({ where: { taskRepoId: first.id, number } })).toMatchObject({ draft: false, draftByOstra: false, state: "open" });

    // ---- Ticket 24 (F-070): the base moves; its push makes the branch behind; Update branch names it ----
    const baseHead = await commitFile(base, `base-${randomBytes(3).toString("hex")}.md`, "The base moved.\n");
    const before = await headOf(base);
    expect(before).toBe(baseHead);
    expect(await deliver("push", { ...envelope(), ref: `refs/heads/${base}`, before: head1, after: baseHead, commits: [] })).toEqual({ outcome: "processed" });
    expect((await taskRepoOf(task)).behindBy).toBe(1);
    note(`ticket 24: a push to ${base} made the task's branch behind by ${String((await taskRepoOf(task)).behindBy)} (GitHub's compare)`);
    const update = await requestUpdateBranchWith(deps, { timers }, driver, { taskId: task.taskId });
    expect(update).toMatchObject({ ok: true, repos: 1, delivery: "reopen" });
    const [asked] = await messagesOf(task.taskId, "update-branch");
    expect(asked?.text).toContain(`${fullName}: merge \`${base}\` into`);
    // The agent's turn merges the base in (as the prompt asks, never a rebase), and the checks pass.
    const merging = await nextSession(task);
    const merged = await api("/merges", { method: "POST", body: { base: branch, head: base, commit_message: "Merge the base into the task's branch" } });
    expect(merged.status).toBe(201);
    await turn(merging, 1, text(merged.json, "sha"), "passed");
    await reconcileBehind({ db: test.db, notices: postgresChangeNotices, clock: systemClock, adapters: { codeHost: reactionDeps.adapters.codeHost, secretStore } });
    expect((await taskRepoOf(task)).behindBy).toBe(0);
    note("ticket 24: after the update-branch turn merged the base in, the reconcile reads behind 0");

    // ---- Ticket 24 (F-066): the PR merges on GitHub; a reopen starts -2 from the base; its push opens a new PR ----
    // GitHub answers 405 while it still works out whether the PR can merge: asked again, a few times.
    let merge = await api(`/pulls/${String(number)}/merge`, { method: "PUT", body: { merge_method: "merge" } });
    for (let attempt = 0; merge.status === 405 && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      merge = await api(`/pulls/${String(number)}/merge`, { method: "PUT", body: { merge_method: "merge" } });
    }
    expect(merge.status).toBe(200);
    await reconcilePullRequests(prDeps, { organizationId: world.organizationId, connectionId });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("merged");
    note(`ticket 24: PR #${String(number)} merged on GitHub; the reconcile moved the task to merged`);
    const reopened = await reopen(task, "One more line, please.");
    expect(reopened).toMatchObject({ ok: true, freshBranches: [{ taskRepoId: first.id, branchName: `${branch}-2` }] });
    expect(await taskRepoOf(task)).toMatchObject({ branchName: `${branch}-2`, generation: 2, state: "no_branch", prNumber: null, hiddenRefSha: null });
    const fresh = await nextSession(task);
    // The restore starts the repo from the base's head, not the old branch: the runner's push of -2.
    await makeBranch(`${branch}-2`, await headOf(base));
    const head3 = await commitFile(`${branch}-2`, `${branch.replaceAll("/", "-")}-2.md`, "Three.\n");
    await turn(fresh, 1, head3, "passed");
    const second = await taskRepoOf(task);
    if (second.prNumber === null) throw new Error("no second PR was opened");
    const number2 = second.prNumber;
    madePulls.push(number2);
    const pr2 = await pull(number2);
    note(`ticket 24: the reopen's first push opened PR #${String(number2)} from ${branch}-2: ${text(pr2, "html_url")}`);
    expect(number2).not.toBe(number);
    expect([text(pr2, "head", "ref"), text(pr2, "base", "ref"), field(pr2, "state")]).toEqual([`${branch}-2`, base, "open"]);
    expect(field(await pull(number), "merged")).toBe(true);
    expect((await test.db.taskPullRequest.findMany({ where: { taskRepoId: first.id }, orderBy: { openedAt: "asc" } })).map((row) => [row.number, row.state, row.branchName])).toEqual([
      [number, "merged", branch],
      [number2, "open", `${branch}-2`],
    ]);

    // ---- Ticket 25 (F-053): `@ostra` on the new PR ----
    const asBot = await api(`/issues/${String(number2)}/comments`, { method: "POST", body: { body: "@ostra please add a fourth line to the file" } });
    expect(asBot.status).toBe(201);
    const comment = asBot.json;
    const commentId = num(comment, "id");
    const botId = num(comment, "user", "id");
    const botLogin = text(comment, "user", "login");
    const issueComment = (action: string) => ({ ...envelope(), action, issue: { number: number2, pull_request: { url: text(pr2, "url") } }, comment, sender: field(comment, "user") });
    // The App's own account is a bot no member is linked to: dropped, no reaction, no message.
    expect(await deliver("issue_comment", issueComment("created"))).toEqual({ outcome: "processed" });
    await runCommentJob(commentId);
    expect(records.filter((record) => record.message === "pr.comment-dropped" && record.fields["commentId"] === String(commentId)).map((record) => record.fields["reason"])).toEqual(["unlinked"]);
    expect(await eyesOn("issue", commentId)).toBe(0);
    expect(await messagesOf(task.taskId, "pr-comment")).toHaveLength(0);
    note(`ticket 25: comment ${String(commentId)} by ${botLogin} (unlinked) dropped, 0 reactions on GitHub`);

    // A member linked to that account (standing in for a person: ticket 51, step 10), and the comment edited: heard once.
    await test.db.user.update({ where: { id: fixture.a.member.userId }, data: { githubUserId: String(botId), githubLogin: botLogin, githubLinkedAt: new Date() } });
    expect(await deliver("issue_comment", issueComment("edited"))).toEqual({ outcome: "processed" });
    await runCommentJob(commentId);
    expect(await eyesOn("issue", commentId)).toBe(1);
    const [heard] = await messagesOf(task.taskId, "pr-comment");
    expect(heard).toMatchObject({ memberId: fixture.a.member.id });
    expect(readMarkedBlocks(heard?.text ?? "").map((block) => block.text)).toEqual(["please add a fourth line to the file"]);
    expect(heard?.text).toContain(text(comment, "html_url"));
    // A replay of the same delivery: nothing more.
    await deliver("issue_comment", issueComment("edited"));
    await runCommentJob(commentId);
    expect(await messagesOf(task.taskId, "pr-comment")).toHaveLength(1);
    expect(await eyesOn("issue", commentId)).toBe(1);
    note(`ticket 25: once linked, comment ${String(commentId)} was heard: one message, one eyes reaction on GitHub (${text(comment, "html_url")})`);

    // A line comment on the new PR: its path and line ride along, and it gets its own reaction.
    const path = `${branch.replaceAll("/", "-")}-2.md`;
    const onLine = await api(`/pulls/${String(number2)}/comments`, { method: "POST", body: { body: "@ostra handle the empty case here", commit_id: head3, path, line: 1, side: "RIGHT" } });
    expect(onLine.status).toBe(201);
    const lineComment = onLine.json;
    const lineId = num(lineComment, "id");
    expect(await deliver("pull_request_review_comment", { ...envelope(), action: "created", pull_request: { number: number2 }, comment: lineComment, sender: field(lineComment, "user") })).toEqual({ outcome: "processed" });
    // The first comment reopened the task, which waits for its runner: the job fails, to run again.
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("queued");
    await expect(runCommentJob(lineId)).rejects.toThrow("waits for its session");
    expect(await messagesOf(task.taskId, "pr-comment")).toHaveLength(1);
    // The runner takes the session and its turn starts: the retry waits for the turn's end.
    const answering = await nextSession(task);
    await answering.send({ kind: "turn.started", turnId: turnIdSchema.parse("turn-1") });
    await runCommentJob(lineId);
    expect(await eyesOn("review", lineId)).toBe(1);
    const received = await test.db.event.findMany({ where: { taskId: task.taskId, kind: "pr.comment_received" }, orderBy: { seq: "asc" } });
    expect(received.map((row) => row.payload)).toMatchObject([
      { login: botLogin, path: null, line: null },
      { login: botLogin, path, line: 1 },
    ]);
    const all = await messagesOf(task.taskId, "pr-comment");
    expect(all).toHaveLength(2);
    expect(all[1]?.text).toContain(`on ${path}, line 1`);
    expect(all[1]).toMatchObject({ delivery: "queued" });
    note(`ticket 25: line comment ${String(lineId)} on ${path}, line 1 waited while the task started, then was queued for the turn's end with its path and line; one eyes reaction (${text(lineComment, "html_url")})`);
    // No log line holds a comment's text.
    expect(JSON.stringify(records)).not.toContain("fourth line");
  });
});
