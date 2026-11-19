import { randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import { postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import type { SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { connectionIdSchema, gitShaSchema, readMarkedBlocks, repoIdSchema, segmentIdSchema, sessionIdSchema, taskEventSchema, turnIdSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, RepoId, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { openPullRequestsHandler } from "../reactions/session-end.ts";
import type { ReactionDeps } from "../reactions/session-end.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { acceptedTask, jobContext, sha } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { seedOnlineRunner, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import type { WebhookDeliveryContext } from "../webhooks/process.ts";
import { githubCommentHandler, prCommentHook } from "./pr-comments.ts";
import type { PrCommentDeps } from "./pr-comments.ts";
import { githubWebhookHandler } from "./pull-requests.ts";
import type { PullRequestStateDeps } from "./pull-requests.ts";

// Ticket 25 (F-053, ADR 0052, ADR 0041): `@ostra` on a task's PR. A linked member's comment reopens
// the task once, with one 👀; a replay does nothing; a line comment carries its path and line; a
// comment from anyone else is dropped with no reply; a comment while a session runs waits for the
// turn's end; another organization's task is never matched.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let restricted: World;
let otherWorld: World;
let ingest: Ingest;
let liveText: LiveTextWriter;
let reactionDeps: ReactionDeps;
let prDeps: PullRequestStateDeps;
let commentDeps: PrCommentDeps;
let runner: RunnerRef;
let insiderRunner: RunnerRef;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
let commentIds = 9_000;

/** GitHub accounts: each member's verified link, as F-119 stores it on the account. */
const GITHUB = { member: { id: 7001, login: "sam-member" }, insider: { id: 7002, login: "ivy-insider" }, outsider: { id: 7003, login: "bo-other-org" } } as const;

const link = async (member: SeededMember, account: { readonly id: number; readonly login: string }): Promise<void> => {
  await test.db.user.update({ where: { id: member.userId }, data: { githubUserId: String(account.id), githubLogin: account.login, githubLinkedAt: new Date() } });
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  // The restricted project's repo, on the same App: only its listed members open it.
  const first = await test.db.repo.findUniqueOrThrow({ where: { id: world.repoId } });
  const hidden = await test.db.repo.create({
    data: {
      organizationId: world.organizationId,
      projectId: fixture.a.restrictedProject.id,
      connectionId: first.connectionId,
      installationId: first.installationId,
      hostRepoId: "host-ostra-test/restricted",
      fullName: "ostra-test/restricted",
      defaultBranch: "main",
      checkoutDir: "restricted",
    },
  });
  await test.db.project.update({ where: { id: fixture.a.restrictedProject.id }, data: { defaultCodeProfileId: world.profileId } });
  restricted = { ...world, projectId: fixture.a.restrictedProject.id, repoId: hidden.id };
  otherWorld = await seedWorld(test.db, { codeHost, secretStore }, fixture.b.organization.id, fixture.b.project.id, { fullName: "ostra-test/other" });
  const timers: SessionTimers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox });
  const adapters = { codeHost, secretStore, modelProvider: new FakeModelProvider() };
  reactionDeps = { db: test.db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters, publicUrl: "http://localhost:3000", logger, timers };
  prDeps = {
    db: test.db,
    jobs,
    notices: postgresChangeNotices,
    audit: postgresAuditLog,
    clock: systemClock,
    codeHost,
    secretStore,
    logger,
    onComment: prCommentHook({ db: test.db, jobs }),
  };
  commentDeps = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters, timers };
  runner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 50);
  insiderRunner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.insider.id }, 50);
  for (const ref of [runner, insiderRunner]) {
    await test.db.runnerPresence.update({ where: { runnerId: ref.runnerId }, data: { minor: 2 } });
  }
  await link(fixture.a.member, GITHUB.member);
  await link(fixture.a.insider, GITHUB.insider);
  await link(fixture.b.admin, GITHUB.outsider);
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const repoOf = (of: World): RepoId => repoIdSchema.parse(of.repoId);
const fullNameOf = async (of: World): Promise<string> => (await test.db.repo.findUniqueOrThrow({ where: { id: of.repoId } })).fullName;
const connectionOf = async (of: World): Promise<ConnectionId> => connectionIdSchema.parse((await test.db.repo.findUniqueOrThrow({ where: { id: of.repoId } })).connectionId);

/** A task whose first turn pushed and opened its PR; `idle` leaves it in review with its session idle. */
const taskWithPr = async (of: World, creator: SeededMember, by: RunnerRef, word: string): Promise<DrivenTask & { readonly number: number }> => {
  const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, of, creator, by);
  const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const turnId = turnIdSchema.parse("turn-1");
  const events: TaskEvent[] = [
    { kind: "turn.started", turnId },
    { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s1"), text: "Done." },
    { kind: "git.pushed", repoId: repoOf(of), branch: branchName, headSha: sha(word), ref: `refs/heads/${branchName}` },
    { kind: "turn.ended", turnId, stopReason: "end_turn" },
    { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId: repoOf(of), headSha: gitShaSchema.parse(sha(word)), ahead: true, hiddenRefSha: sha(`wip-${word}`) }], archive: null },
  ];
  await task.send(...events);
  const saved = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.saved" }, orderBy: { seq: "desc" } });
  await openPullRequestsHandler(reactionDeps)(jobContext("task.open-pull-requests", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: saved.seq }, logger));
  const taskRepo = await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } });
  if (taskRepo.prNumber === null) throw new Error("no PR");
  return { ...task, number: taskRepo.prNumber };
};

type Comment = {
  readonly of: World;
  readonly number: number;
  readonly body: string;
  readonly author: { readonly id: number; readonly login: string };
  readonly line?: { readonly path: string; readonly line: number };
  readonly commentId?: number;
  readonly action?: string;
  /** Delivered on this organization's connection (default: the repo's own). */
  readonly via?: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId };
};

/**
 * A comment's delivery as milestone 2's inbox leaves it (stored, verified), then `webhook.process`'s
 * GitHub handler, then the `github.comment` job it queued, as the worker would run them.
 */
const deliver = async (comment: Comment): Promise<{ readonly commentId: string; readonly outcome: string }> => {
  const commentId = comment.commentId ?? (commentIds += 1);
  const made = codeHost.commentDelivery(await fullNameOf(comment.of), {
    number: comment.number,
    commentId,
    body: comment.body,
    authorId: comment.author.id,
    authorLogin: comment.author.login,
    ...(comment.action === undefined ? {} : { action: comment.action }),
    ...(comment.line === undefined ? {} : { line: comment.line }),
  });
  const organizationId = comment.via?.organizationId ?? comment.of.organizationId;
  const connectionId = comment.via?.connectionId ?? (await connectionOf(comment.of));
  const deliveryId = webhookDeliveryIdSchema.parse(randomUUID());
  const payload: unknown = JSON.parse(made.body);
  await test.db.$executeRaw`
    INSERT INTO "webhook_delivery" ("id", "organizationId", "connectionId", "deliveryId", "event", "payload")
    VALUES (${randomUUID()}, ${organizationId}, ${connectionId}, ${deliveryId}, ${made.event}, ${made.body}::jsonb)`;
  const context: WebhookDeliveryContext = { organizationId, connectionId, deliveryId, event: made.event, payload, receivedAt: Date.now(), logger };
  const outcome = await githubWebhookHandler(prDeps)(context);
  const queued = { organizationId, connectionId, commentId: String(commentId) };
  if ((await jobs.find("github.comment", queued)).length > 0) {
    await githubCommentHandler(commentDeps)(jobContext("github.comment", queued, logger));
  }
  return { commentId: String(commentId), outcome: outcome.outcome };
};

const messagesOf = async (taskId: string) =>
  (await test.db.event.findMany({ where: { taskId, kind: "user.message" }, orderBy: { seq: "asc" } })).flatMap((row) => {
    const parsed = taskEventSchema.safeParse(row.payload);
    return parsed.success && parsed.data.kind === "user.message" && parsed.data.intent === "pr-comment" ? [parsed.data] : [];
  });

const reactionsOn = (commentId: string): number => codeHost.reactionCalls.filter((call) => call.comment.commentId === commentId).length;

const dropped = (commentId: string) => records.filter((record) => record.message === "pr.comment-dropped" && record.fields["commentId"] === commentId).map((record) => record.fields["reason"]);

describe("@ostra on the PR (F-053)", () => {
  it("F-053: a linked member's comment reopens the task once, with one reaction, and a replayed delivery does nothing", async () => {
    const task = await taskWithPr(world, fixture.a.member, runner, "reopen-1");
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("in_review");
    const first = await deliver({ of: world, number: task.number, body: "  @OSTRA please also update the changelog", author: GITHUB.member });
    expect(first.outcome).toBe("processed");
    expect(reactionsOn(first.commentId)).toBe(1);
    expect(codeHost.reactionCalls.at(-1)).toMatchObject({ repo: "ostra-test/test1", comment: { kind: "issue", commentId: first.commentId }, reaction: "eyes" });
    const reopened = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(reopened).toMatchObject({ state: "queued", driverMemberId: fixture.a.member.id });
    const messages = await messagesOf(task.taskId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ reopen: true, memberId: fixture.a.member.id });
    expect(readMarkedBlocks(messages[0]?.text ?? "").map((block) => [block.label, block.text])).toEqual([["pr-comment", "please also update the changelog"]]);
    expect(messages[0]?.text).toContain(`#issuecomment-${first.commentId}`);
    const received = await test.db.event.findMany({ where: { taskId: task.taskId, kind: "pr.comment_received" } });
    expect(received.map((row) => row.payload)).toMatchObject([{ login: GITHUB.member.login, path: null, line: null }]);
    // The member is credited by the link's no-reply address.
    expect(await test.db.taskCoAuthor.findFirst({ where: { taskId: task.taskId, email: `${String(GITHUB.member.id)}+${GITHUB.member.login}@users.noreply.github.com` } })).not.toBeNull();

    // The same delivery again, and an edit of the accepted comment: nothing more.
    await deliver({ of: world, number: task.number, body: "  @OSTRA please also update the changelog", author: GITHUB.member, commentId: Number(first.commentId) });
    await deliver({ of: world, number: task.number, body: "@ostra please also update the changelog, and the README", author: GITHUB.member, commentId: Number(first.commentId), action: "edited" });
    expect(await messagesOf(task.taskId)).toHaveLength(1);
    expect(reactionsOn(first.commentId)).toBe(1);
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "pr.comment_received" } })).toBe(1);
    // No log line holds the comment's text.
    expect(JSON.stringify(records)).not.toContain("update the changelog");
  });

  it("F-053: an edit that adds @ostra counts once, and a comment that doesn't ask is ignored", async () => {
    const task = await taskWithPr(world, fixture.a.member, runner, "edit-1");
    const plain = await deliver({ of: world, number: task.number, body: "Looks good to me.", author: GITHUB.member });
    expect(plain.outcome).toBe("ignored");
    expect(await deliver({ of: world, number: task.number, body: "Ask @ostra later", author: GITHUB.member })).toMatchObject({ outcome: "ignored" });
    await deliver({ of: world, number: task.number, body: "Looks good.\n@ostra\nRename the helper.", author: GITHUB.member, commentId: Number(plain.commentId), action: "edited" });
    await deliver({ of: world, number: task.number, body: "Looks good.\n@ostra\nRename the helper, please.", author: GITHUB.member, commentId: Number(plain.commentId), action: "edited" });
    const messages = await messagesOf(task.taskId);
    expect(messages).toHaveLength(1);
    expect(readMarkedBlocks(messages[0]?.text ?? "")[0]?.text).toBe("Rename the helper.");
  });

  it("F-053: a line comment carries its path and line", async () => {
    const task = await taskWithPr(world, fixture.a.member, runner, "line-1");
    const made = await deliver({ of: world, number: task.number, body: "@ostra handle the empty case here", author: GITHUB.member, line: { path: "src/app.ts", line: 42 } });
    expect(reactionsOn(made.commentId)).toBe(1);
    expect(codeHost.reactionCalls.at(-1)?.comment).toEqual({ kind: "review", commentId: made.commentId });
    const [message] = await messagesOf(task.taskId);
    expect(message?.text).toContain("on the file in the first block, line 42");
    expect(readMarkedBlocks(message?.text ?? "")[0]).toMatchObject({ label: "pr-comment-location", text: "src/app.ts" });
    const [received] = await test.db.event.findMany({ where: { taskId: task.taskId, kind: "pr.comment_received" } });
    expect(received?.payload).toMatchObject({ path: "src/app.ts", line: 42 });
  });

  it("F-053: an unlinked commenter, a linked one without access and a bot are dropped with no reply", async () => {
    const task = await taskWithPr(world, fixture.a.member, runner, "drop-1");
    const unlinked = await deliver({ of: world, number: task.number, body: "@ostra delete everything", author: { id: 8888, login: "stranger" } });
    const bot = await deliver({ of: world, number: task.number, body: "@ostra bump the deps", author: { id: 49699333, login: "dependabot[bot]" } });
    // Another GitHub account under a linked member's login (a renamed account's old name, taken
    // again): the link is the account's ID, so it's a stranger.
    const sameLogin = await deliver({ of: world, number: task.number, body: "@ostra push to main", author: { id: 9_999_999, login: GITHUB.member.login } });
    // A linked member of the organization who can't open the restricted project.
    const hidden = await taskWithPr(restricted, fixture.a.insider, insiderRunner, "drop-2");
    const noAccess = await deliver({ of: restricted, number: hidden.number, body: "@ostra look at this", author: GITHUB.member });
    expect(dropped(unlinked.commentId)).toEqual(["unlinked"]);
    expect(dropped(bot.commentId)).toEqual(["unlinked"]);
    expect(dropped(sameLogin.commentId)).toEqual(["unlinked"]);
    expect(dropped(noAccess.commentId)).toEqual(["no-access"]);
    for (const comment of [unlinked, bot, sameLogin, noAccess]) {
      expect(reactionsOn(comment.commentId)).toBe(0);
    }
    expect(await messagesOf(task.taskId)).toHaveLength(0);
    expect(await messagesOf(hidden.taskId)).toHaveLength(0);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("in_review");
    // The insider, who can open it, is heard.
    await deliver({ of: restricted, number: hidden.number, body: "@ostra look at this", author: GITHUB.insider });
    expect(await messagesOf(hidden.taskId)).toHaveLength(1);
  });

  it("F-053: a comment while a session runs waits for the turn's end", async () => {
    const task = await taskWithPr(world, fixture.a.member, runner, "running-1");
    // The insider drives it now, and a turn is running.
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "running", subState: null, driverMemberId: fixture.a.insider.id } });
    await test.db.session.update({ where: { id: task.sessionId }, data: { state: "running" } });
    const before = await test.db.command.count({ where: { taskId: task.taskId, kind: "steer" } });
    const made = await deliver({ of: world, number: task.number, body: "@ostra also run the linter", author: GITHUB.member });
    const steers = await test.db.command.findMany({ where: { taskId: task.taskId, kind: "steer" }, orderBy: { seq: "asc" } });
    expect(steers).toHaveLength(before + 1);
    expect(steers.at(-1)?.body).toMatchObject({ sessionId: task.sessionId, delivery: "queue", intent: "pr-comment" });
    const [message] = await messagesOf(task.taskId);
    expect(message).toMatchObject({ delivery: "queued", memberId: fixture.a.member.id });
    expect(message?.reopen).toBeUndefined();
    // Nobody took over: the driver is still the insider, and the task still runs.
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "running", driverMemberId: fixture.a.insider.id });
    expect(reactionsOn(made.commentId)).toBe(1);
  });

  it("F-053: a comment while the reopened task waits for its runner is retried, then waits for the turn's end", async () => {
    const task = await taskWithPr(world, fixture.a.member, runner, "waiting-1");
    // The first comment reopens the task: it's queued, its new session not started yet.
    await deliver({ of: world, number: task.number, body: "@ostra add a test", author: GITHUB.member });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("queued");
    // A second one now has no session to queue for and nothing to reopen: its job fails, to run again.
    await expect(deliver({ of: world, number: task.number, body: "@ostra and update the docs", author: GITHUB.member })).rejects.toThrow("waits for its session");
    const second = String(commentIds);
    expect(await messagesOf(task.taskId)).toHaveLength(1);
    expect(dropped(second)).toEqual([]);
    // The runner takes the session and its turn starts: the retry is a queued steer.
    const session = await test.db.session.findFirstOrThrow({ where: { taskId: task.taskId }, orderBy: { startedAt: "desc" } });
    const next = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner, { taskId: task.taskId, sessionId: sessionIdSchema.parse(session.id), organizationId: task.organizationId });
    await next.send({ kind: "turn.started", turnId: turnIdSchema.parse("turn-1") });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("running");
    const queued = { organizationId: world.organizationId, connectionId: await connectionOf(world), commentId: second };
    await githubCommentHandler(commentDeps)(jobContext("github.comment", queued, logger));
    const messages = await messagesOf(task.taskId);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ delivery: "queued", memberId: fixture.a.member.id });
    expect(readMarkedBlocks(messages[1]?.text ?? "").map((block) => block.text)).toEqual(["and update the docs"]);
    const steers = await test.db.command.findMany({ where: { taskId: task.taskId, kind: "steer" }, orderBy: { seq: "asc" } });
    expect(steers.at(-1)?.body).toMatchObject({ sessionId: session.id, delivery: "queue", intent: "pr-comment" });
  });

  it("F-053: another organization's task is never matched", async () => {
    const task = await taskWithPr(world, fixture.a.member, runner, "iso-1");
    // A member of the other organization, linked, comments on this organization's PR.
    const foreign = await deliver({ of: world, number: task.number, body: "@ostra change it", author: GITHUB.outsider });
    expect(dropped(foreign.commentId)).toEqual(["unlinked"]);
    // A delivery on the other organization's connection naming this organization's repo matches nothing.
    const otherConnection = await connectionOf(otherWorld);
    const crossed = await deliver({ of: world, number: task.number, body: "@ostra change it", author: GITHUB.member, via: { organizationId: otherWorld.organizationId, connectionId: otherConnection } });
    expect(dropped(crossed.commentId)).toEqual(["no-task"]);
    expect(await messagesOf(task.taskId)).toHaveLength(0);
    expect(reactionsOn(foreign.commentId) + reactionsOn(crossed.commentId)).toBe(0);
  });
});
