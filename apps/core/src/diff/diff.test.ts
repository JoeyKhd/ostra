import { createLogger } from "@ostra/adapter-sdk";
import type { CompareResult, LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  diffCommentsForMember,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  saveDiffComment,
  sendDiffComments,
  systemClock,
  taskDiffs,
} from "@ostra/domain";
import type { M3Deps, MemberScope, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { memberIdSchema, readMarkedBlocks, repoIdSchema, segmentIdSchema, taskEventSchema, taskRepoIdSchema, turnIdSchema } from "@ostra/protocol";
import type { GitSha, RepoId, TaskId, TaskRepoId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { acceptedTask, jobContext, sha } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { seedOnlineRunner, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { diffFetchHandler } from "./diff-fetch.ts";
import type { DiffFetchDeps } from "./diff-fetch.ts";

// Ticket 22 (F-027, F-072): the diff through the App's compare, cached per head, and diff comments:
// a member's private drafts, sent together as one member message, outdated when their line changes.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let ingest: Ingest;
let liveText: LiveTextWriter;
let deps: M3Deps;
let fetchDeps: DiffFetchDeps;
let driver: MemberScope;
let other: MemberScope;
let outsider: MemberScope;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const turnId = turnIdSchema.parse("turn-1");

const scopeOf = (organizationId: MemberScope["organizationId"], memberId: string, role: "admin" | "member" = "member"): MemberScope => ({
  organizationId,
  memberId: memberIdSchema.parse(memberId),
  role,
  projectRoles: new Map(),
});

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  const timers: SessionTimers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox });
  const adapters = { codeHost, secretStore, modelProvider: new FakeModelProvider() };
  deps = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters };
  fetchDeps = { db: test.db, notices: postgresChangeNotices, clock: systemClock, adapters, limits: { maxFiles: 300, maxPatchBytes: 1024 * 1024 }, logger };
  driver = scopeOf(fixture.a.organization.id, fixture.a.member.id);
  other = scopeOf(fixture.a.organization.id, fixture.a.insider.id);
  outsider = scopeOf(fixture.b.organization.id, fixture.b.admin.id, "admin");
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const repo = (): RepoId => repoIdSchema.parse(world.repoId);

/** README.md's patch at a head: line 2 says `word`, line 5 never changes. */
const readmePatch = (word: string): string => ["@@ -1,5 +1,5 @@", " # test1", `-old ${word}`, `+new ${word}`, " ", " ## Usage", " Run it."].join("\n");

const compareOf = (patch: string, extra: Partial<CompareResult> = {}): CompareResult => ({
  aheadBy: 1,
  behindBy: 0,
  mergeBase: "e".repeat(40),
  files: [{ path: "README.md", previousPath: null, status: "modified", additions: 1, deletions: 1, patch, truncated: false }],
  filesTruncated: false,
  limits: { maxFiles: 300, maxPatchBytes: 1024 * 1024 },
  ...extra,
});

/** A running task whose first turn pushed `head`, driven by `fixture.a.member`. */
const runningTask = async (head: GitSha): Promise<DrivenTask & { readonly taskRepoId: TaskRepoId; readonly branch: string }> => {
  const runner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 20);
  await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { minor: 2 } });
  const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner);
  const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  await task.send(
    { kind: "turn.started", turnId },
    { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s1"), text: "I changed the README." },
    { kind: "git.pushed", repoId: repo(), branch: branchName, headSha: head, ref: `refs/heads/${branchName}` },
  );
  const taskRepo = await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } });
  return { ...task, taskRepoId: taskRepoIdSchema.parse(taskRepo.id), branch: branchName };
};

/** Runs every queued `diff.fetch` of a task's repo through the handler, as the worker would. */
const fetchDiff = async (taskId: TaskId, headSha: GitSha): Promise<void> => {
  await diffFetchHandler(fetchDeps)(jobContext("diff.fetch", { organizationId: fixture.a.organization.id, taskId, repoId: repo(), baseSha: null, headSha }, logger));
};

const queuedFetches = async (headSha: GitSha): Promise<number> => {
  const rows = await test.db.$queryRaw<readonly { readonly count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM pgboss.job WHERE name = 'diff.fetch' AND data->>'headSha' = ${headSha}`;
  return Number(rows[0]?.count ?? 0);
};

const comment = (scope: MemberScope, taskRepoId: TaskRepoId, headSha: GitSha, line: number, body = "Say why, not what.") =>
  saveDiffComment(deps, scope, { action: "create", taskRepoId, path: "README.md", side: "new", line, headSha, body });

const userMessages = async (taskId: TaskId) => {
  const rows = await test.db.event.findMany({ where: { taskId, kind: "user.message" }, orderBy: { seq: "asc" } });
  return rows.flatMap((row) => {
    const parsed = taskEventSchema.safeParse(row.payload);
    return parsed.success && parsed.data.kind === "user.message" ? [{ ...parsed.data, seq: row.seq }] : [];
  });
};

describe("the diff", () => {
  it("F-027: many readers of a head cost one compare, and a head that hasn't changed is never fetched again", async () => {
    const head = sha("diff-head-1");
    codeHost.setCompare("ostra-test/test1", head, compareOf(readmePatch("one")));
    const task = await runningTask(head);
    const before = codeHost.compareCalls.length;
    // Five members open the Changes tab before the diff is in: one job is queued.
    for (let reader = 0; reader < 5; reader += 1) {
      const read = await taskDiffs(deps, reader % 2 === 0 ? driver : other, { taskId: task.taskId });
      expect(read.ok && read.repos[0]?.state).toBe("loading");
    }
    expect(await queuedFetches(head)).toBe(1);
    await fetchDiff(task.taskId, head);
    await fetchDiff(task.taskId, head);
    expect(codeHost.compareCalls.length - before).toBe(1);
    expect(codeHost.compareCalls.at(-1)).toEqual({ repo: "ostra-test/test1", base: "main", head });
    const read = await taskDiffs(deps, other, { taskId: task.taskId });
    expect(read.ok && read.repos[0]).toMatchObject({ state: "ready", diff: { headSha: head, files: [{ path: "README.md", tooLarge: false }] } });
    expect(await test.db.diffCache.count({ where: { repoId: repo(), headSha: head } })).toBe(1);
    // Another organization's member can't read it.
    expect((await taskDiffs(deps, outsider, { taskId: task.taskId })).ok).toBe(false);
  });

  it("F-027: a patch over the size limit is kept as too large, with the PR's files link", async () => {
    const head = sha("diff-head-big");
    const big = `@@ -1 +1 @@\n-${"x".repeat(4000)}\n+${"y".repeat(4000)}`;
    codeHost.setCompare("ostra-test/test1", head, compareOf(big));
    const task = await runningTask(head);
    await test.db.taskRepo.update({ where: { id: task.taskRepoId }, data: { prUrl: "https://github.example/ostra-test/test1/pull/9" } });
    await diffFetchHandler({ ...fetchDeps, limits: { maxFiles: 300, maxPatchBytes: 1024 } })(
      jobContext("diff.fetch", { organizationId: fixture.a.organization.id, taskId: task.taskId, repoId: repo(), baseSha: null, headSha: head }, logger),
    );
    const read = await taskDiffs(deps, driver, { taskId: task.taskId });
    expect(read.ok && read.repos[0]).toMatchObject({
      state: "ready",
      diff: { hostUrl: "https://github.example/ostra-test/test1/pull/9/files", files: [{ path: "README.md", tooLarge: true, patch: null }] },
    });
  });
});

describe("diff comments", () => {
  it("F-072: drafts are private to their member until sent, and a send makes one message and marks every draft sent", async () => {
    const head = sha("comments-head-1");
    codeHost.setCompare("ostra-test/test1", head, compareOf(readmePatch("alpha")));
    const task = await runningTask(head);
    await fetchDiff(task.taskId, head);
    const first = await comment(driver, task.taskRepoId, head, 2, "Use the project's word here.");
    const second = await comment(driver, task.taskRepoId, head, 5, "Mention `pnpm test`.");
    const theirs = await comment(other, task.taskRepoId, head, 2, "Another member's draft.");
    expect(first.ok && second.ok && theirs.ok).toBe(true);
    // A line the diff doesn't show is refused.
    expect(await comment(driver, task.taskRepoId, head, 40)).toMatchObject({ ok: false, error: "no-such-line" });
    // Each member sees their own drafts only.
    expect((await diffCommentsForMember(test.db, driver, { taskId: task.taskId }))?.map((row) => row.body)).toEqual(["Use the project's word here.", "Mention `pnpm test`."]);
    expect((await diffCommentsForMember(test.db, other, { taskId: task.taskId }))?.map((row) => row.body)).toEqual(["Another member's draft."]);
    // Another's draft can't be edited or deleted: it doesn't exist for anyone else.
    if (theirs.ok) {
      expect(await saveDiffComment(deps, driver, { action: "delete", commentId: theirs.commentId })).toMatchObject({ ok: false, error: "not-found" });
    }

    const sent = await sendDiffComments(deps, driver, { taskId: task.taskId });
    expect(sent).toMatchObject({ ok: true, sent: 2, delivery: "steer" });
    const messages = (await userMessages(task.taskId)).filter((message) => message.intent === "diff-comments");
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message?.memberId).toBe(driver.memberId);
    // Each comment with its place and quoted lines, inside marked blocks.
    expect(message?.text).toContain("ostra-test/test1, README.md, line 2:");
    const blocks = readMarkedBlocks(message?.text ?? "");
    expect(blocks.map((block) => [block.label, block.text])).toEqual([
      ["diff-lines", " # test1\n+new alpha"],
      ["diff-comment", "Use the project's word here."],
      ["diff-lines", " \n ## Usage\n Run it."],
      ["diff-comment", "Mention `pnpm test`."],
    ]);
    const steers = await test.db.command.findMany({ where: { taskId: task.taskId, kind: "steer" } });
    expect(steers).toHaveLength(1);
    const saved = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "diff.comments_sent" } });
    expect(saved.payload).toMatchObject({ count: 2 });
    // Sent comments are every member's now; the other member's draft is still theirs alone.
    const seen = await diffCommentsForMember(test.db, other, { taskId: task.taskId });
    expect(seen?.map((row) => [row.body, row.state, row.sentInSeq === message?.seq])).toEqual([
      ["Use the project's word here.", "sent", true],
      ["Mention `pnpm test`.", "sent", true],
      ["Another member's draft.", "draft", false],
    ]);
    // A second send of the same drafts sends nothing.
    expect(await sendDiffComments(deps, driver, { taskId: task.taskId })).toMatchObject({ ok: false, error: "no-drafts" });
    expect((await userMessages(task.taskId)).filter((row) => row.intent === "diff-comments")).toHaveLength(1);
    expect(await test.db.command.count({ where: { taskId: task.taskId, kind: "steer" } })).toBe(1);
    // A sent comment can't be changed.
    if (first.ok) {
      expect(await saveDiffComment(deps, driver, { action: "edit", commentId: first.commentId, body: "changed" })).toMatchObject({ ok: false, error: "sent" });
    }
  });

  it("F-072: a member who isn't the driver is told to take over while a session is going; with none going, a send reopens", async () => {
    const head = sha("comments-head-2");
    codeHost.setCompare("ostra-test/test1", head, compareOf(readmePatch("beta")));
    const task = await runningTask(head);
    await fetchDiff(task.taskId, head);
    expect((await comment(other, task.taskRepoId, head, 2)).ok).toBe(true);
    expect(await sendDiffComments(deps, other, { taskId: task.taskId })).toMatchObject({ ok: false, error: "take-over-to-send", message: "Take over to send" });
    // Refused: the draft stays a draft.
    expect((await diffCommentsForMember(test.db, other, { taskId: task.taskId }))?.map((row) => row.state)).toEqual(["draft"]);
    // The session ends, and the task waits in review: the next send is a reopen, by whoever sends it.
    await task.send(
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId: repo(), headSha: head, ahead: true, hiddenRefSha: sha("wip-2") }], archive: null },
    );
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "in_review", subState: "waiting_for_reviewer" } });
    await test.db.session.updateMany({ where: { taskId: task.taskId }, data: { state: "idle" } });
    const sent = await sendDiffComments(deps, other, { taskId: task.taskId });
    expect(sent).toMatchObject({ ok: true, sent: 1, delivery: "reopen" });
    const reopened = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(reopened.state).toBe("queued");
    expect(reopened.driverMemberId).toBe(other.memberId);
    const [message] = (await userMessages(task.taskId)).filter((row) => row.intent === "diff-comments");
    expect(message).toMatchObject({ reopen: true, memberId: other.memberId });
  });

  it("F-072: a comment on a line that changed is outdated and one on an untouched line isn't", async () => {
    const first = sha("outdated-head-1");
    const second = sha("outdated-head-2");
    codeHost.setCompare("ostra-test/test1", first, compareOf(readmePatch("gamma")));
    // The next head rewrites line 2 and leaves line 5 alone.
    codeHost.setCompare("ostra-test/test1", second, compareOf(readmePatch("delta")));
    const task = await runningTask(first);
    await fetchDiff(task.taskId, first);
    const onChanged = await comment(driver, task.taskRepoId, first, 2, "This line.");
    const onUntouched = await comment(other, task.taskRepoId, first, 5, "That line.");
    expect(onChanged.ok && onUntouched.ok).toBe(true);
    // The turn saves a new head: its diff is queued for the comments, and fetched.
    await task.send(
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId: repo(), headSha: second, ahead: true, hiddenRefSha: sha("wip-3") }], archive: null },
    );
    expect(await queuedFetches(second)).toBe(1);
    await fetchDiff(task.taskId, second);
    const rows = await test.db.diffComment.findMany({ where: { taskId: task.taskId }, orderBy: { line: "asc" } });
    expect(rows.map((row) => [row.line, row.outdatedAt !== null])).toEqual([
      [2, true],
      [5, false],
    ]);
    const shown = await diffCommentsForMember(test.db, driver, { taskId: task.taskId });
    expect(shown?.map((row) => [row.line, row.outdated])).toEqual([[2, true]]);
  });

  it("F-072: another organization's comments are invisible, and its members can't comment or send", async () => {
    const head = sha("isolation-head");
    codeHost.setCompare("ostra-test/test1", head, compareOf(readmePatch("eps")));
    const task = await runningTask(head);
    await fetchDiff(task.taskId, head);
    const mine = await comment(driver, task.taskRepoId, head, 2);
    expect(mine.ok).toBe(true);
    expect(await diffCommentsForMember(test.db, outsider, { taskId: task.taskId })).toBeNull();
    expect(await comment(outsider, task.taskRepoId, head, 2)).toMatchObject({ ok: false, error: "not-found" });
    if (mine.ok) {
      expect(await saveDiffComment(deps, outsider, { action: "edit", commentId: mine.commentId, body: "x" })).toMatchObject({ ok: false, error: "not-found" });
    }
    expect(await sendDiffComments(deps, outsider, { taskId: task.taskId })).toMatchObject({ ok: false, error: "not-found" });
    // The draft is untouched by their tries.
    expect((await diffCommentsForMember(test.db, driver, { taskId: task.taskId }))?.map((row) => row.state)).toEqual(["draft"]);
  });
});
