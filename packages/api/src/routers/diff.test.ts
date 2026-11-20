import { createHash } from "node:crypto";

import type { CompareResult } from "@ostra/adapter-sdk";
import { toStoredDiff } from "@ostra/domain";
import { gitShaSchema, repoIdSchema, taskEventSchema, taskRepoIdSchema } from "@ostra/protocol";
import type { GitSha, OrganizationId, ProjectId, RepoId, TaskRepoId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendEvent, createApiHarness, seedConnectionAndModel, seedLease, seedPersonalRunner, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";

// F-027, F-072, ticket 38: the Changes tab's API. The diff is each changed repo's branch against its
// base, read from the stored compare (the code host's call is core's, ticket 22); comments are
// private drafts and shared sent comments; sending follows the composer's rule.

let harness: ApiHarness;
let orgA: OrganizationId;
let project: ProjectId;
let repoId: RepoId;

const limits = { maxFiles: 300, maxPatchBytes: 1024 * 1024 };

const sha = (seed: string): GitSha => gitShaSchema.parse(createHash("sha1").update(seed).digest("hex"));

const readme = (word: string): string => ["@@ -1,5 +1,5 @@", " # test1", `-old ${word}`, `+new ${word}`, " ", " ## Usage", " Run it."].join("\n");

const compareOf = (patch: string, extra: Partial<CompareResult> = {}): CompareResult => ({
  aheadBy: 3,
  behindBy: 0,
  mergeBase: "e".repeat(40),
  files: [
    { path: "README.md", previousPath: null, status: "modified", additions: 1, deletions: 1, patch, truncated: false },
    { path: "pnpm-lock.yaml", previousPath: null, status: "modified", additions: 4000, deletions: 3000, patch: null, truncated: true },
    { path: "logo.png", previousPath: null, status: "added", additions: 0, deletions: 0, patch: null, truncated: false },
    { path: "docs/moved.md", previousPath: "docs/old.md", status: "renamed", additions: 0, deletions: 0, patch: null, truncated: false },
  ],
  filesTruncated: false,
  limits: { maxFiles: 300, maxPatchBytes: 1024 * 1024 },
  ...extra,
});

/** The diff of a head, as core's `diff.fetch` stores it. */
const storeDiff = async (head: GitSha, patch: string, extra: Partial<CompareResult> = {}) => {
  const stored = toStoredDiff(compareOf(patch, extra), { headSha: head, hostUrl: "https://github.com/ostra-test/test1/pull/7/files", limits });
  await harness.test.db.diffCache.create({
    data: { organizationId: orgA, projectId: project, repoId, baseSha: "e".repeat(40), headSha: head, result: stored },
  });
};

type Driven = SeededTask & { readonly taskRepoId: TaskRepoId; readonly head: GitSha };

/** A task with one changed repo whose pushed head is `head`; `going` gives it a running session on a runner held by the driver. */
const makeTask = async (
  title: string,
  over: { readonly head?: GitSha | null; readonly driver?: string | null; readonly going?: boolean; readonly state?: "running" | "stopped" | "in_review"; readonly projectId?: ProjectId; readonly behindBy?: number } = {},
): Promise<Driven> => {
  const head = over.head === undefined ? sha(`${title}-head`) : over.head;
  const driver = over.driver === undefined ? harness.fixture.a.member.id : over.driver;
  const projectId = over.projectId ?? project;
  const task = await seedTask(harness, {
    organizationId: orgA,
    projectId,
    title,
    state: over.state ?? "running",
    driverMemberId: driver,
    creatorMemberId: driver,
    sessionState: over.state === "stopped" ? "ended" : "running",
  });
  if (over.going !== false && (over.state ?? "running") === "running") {
    const runner = await seedPersonalRunner(harness, harness.fixture.a.member.id, `runner-${title}`);
    await seedLease(harness, task, orgA, projectId, runner);
  }
  const taskRepo = await harness.test.db.taskRepo.create({
    data: {
      organizationId: orgA,
      projectId,
      taskId: task.taskId,
      repoId,
      branchName: `ostra/${title}`,
      baseBranch: "main",
      state: head === null ? "no_branch" : "pr_open",
      headSha: head,
      prUrl: head === null ? null : "https://github.com/ostra-test/test1/pull/7",
      ...(over.behindBy === undefined ? {} : { behindBy: over.behindBy }),
    },
    select: { id: true },
  });
  return { ...task, taskRepoId: taskRepoIdSchema.parse(taskRepo.id), head: head ?? sha("none") };
};

beforeAll(async () => {
  harness = await createApiHarness();
  orgA = harness.fixture.a.organization.id;
  const world = await seedConnectionAndModel(harness);
  const calc = await seedProject(harness, world, "calc");
  project = calc.projectId;
  repoId = repoIdSchema.parse(calc.repoId);
});

afterAll(async () => {
  await harness.dispose();
});

const userMessages = async (task: SeededTask) => {
  const rows = await harness.test.db.event.findMany({ where: { taskId: task.taskId, kind: "user.message" }, orderBy: { seq: "asc" } });
  return rows.flatMap((row) => {
    const parsed = taskEventSchema.safeParse(row.payload);
    return parsed.success && parsed.data.kind === "user.message" ? [{ ...parsed.data, seq: row.seq }] : [];
  });
};

describe("diff.get", () => {
  it("F-027/c1: a member reads each repo's branch against its base: files with parsed hunks, and a note for the ones the diff does not draw", async () => {
    const task = await makeTask("read", { behindBy: 2 });
    await storeDiff(task.head, readme("one"));
    await appendEvent(harness, task, { organizationId: orgA, projectId: project }, {
      kind: "session.saved",
      turnOrdinal: 1,
      repos: [{ repoId, headSha: task.head, ahead: true, hiddenRefSha: null }],
      archive: null,
    });
    // Another member, who is not the driver, reads it.
    const member = await harness.as(harness.fixture.a.insider);
    const got = await member.diff.get({ taskId: task.taskId });
    expect(got.asOf).not.toBeNull();
    expect(got.repos).toHaveLength(1);
    const [repo] = got.repos;
    expect(repo).toMatchObject({ repo: "ostra-test/test1", branch: "ostra/read", base: "main", state: "ready", aheadBy: 3, headSha: task.head, behindBy: 2, hostUrl: "https://github.com/ostra-test/test1/pull/7/files" });
    const byPath = new Map((repo?.files ?? []).map((file) => [file.path, file]));
    const text = byPath.get("README.md");
    expect(text).toMatchObject({ kind: "text", additions: 1, deletions: 1, status: "modified" });
    expect(text?.hunks).toHaveLength(1);
    expect(text?.hunks[0]?.lines.map((line) => `${line.kind}:${String(line.oldLine)}:${String(line.newLine)}`)).toEqual(["context:1:1", "del:2:null", "add:null:2", "context:3:3", "context:4:4", "context:5:5"]);
    expect(byPath.get("pnpm-lock.yaml")).toMatchObject({ kind: "too-large", hunks: [] });
    expect(byPath.get("logo.png")).toMatchObject({ kind: "binary", hunks: [] });
    expect(byPath.get("docs/moved.md")).toMatchObject({ kind: "renamed-unchanged", previousPath: "docs/old.md", hunks: [] });
  });

  it("F-027/c1: a head that is not fetched yet answers loading and queues one diff.fetch, however many members ask; a repo with nothing pushed queues none", async () => {
    harness.fakes.jobs.clear();
    const pending = await makeTask("loading", { head: sha("not-yet-fetched") });
    const nothing = await makeTask("nothing", { head: null });
    const callers = [await harness.as(harness.fixture.a.member), await harness.as(harness.fixture.a.insider), await harness.as(harness.fixture.a.admin)];
    const answers = await Promise.all(callers.flatMap((caller) => [caller.diff.get({ taskId: pending.taskId }), caller.diff.get({ taskId: nothing.taskId })]));
    for (const [index, answer] of answers.entries()) {
      expect(answer.repos[0]).toMatchObject(index % 2 === 0 ? { state: "loading", files: [] } : { state: "no-head", files: [], headSha: null });
    }
    const fetches = harness.fakes.jobs.jobs.filter((job) => job.job === "diff.fetch");
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.payload).toMatchObject({ taskId: pending.taskId, repoId, headSha: pending.head });
  });

  it("F-027/c1: another organization's task, and a task in a project the member isn't on, are not found", async () => {
    const task = await makeTask("hidden");
    await storeDiff(task.head, readme("two"));
    const outsider = await harness.as(harness.fixture.b.admin);
    await expect(outsider.diff.get({ taskId: task.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.diff.comments.list({ taskId: task.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The restricted project's task: the plain member isn't on it.
    const restricted = await seedTask(harness, { organizationId: orgA, projectId: harness.fixture.a.restrictedProject.id, title: "restricted" });
    const member = await harness.as(harness.fixture.a.member);
    await expect(member.diff.get({ taskId: restricted.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("diff.comments", () => {
  it("F-072/c1: a member reads another's sent comments and not their drafts; a draft's text and author are the author's own", async () => {
    const task = await makeTask("private");
    await storeDiff(task.head, readme("three"));
    const driver = await harness.as(harness.fixture.a.member);
    const reviewer = await harness.as(harness.fixture.a.insider);
    const base = { taskId: task.taskId, taskRepoId: task.taskRepoId, path: "README.md", side: "new" as const, headSha: task.head };
    const sentOne = await driver.diff.comments.save({ ...base, line: 2, body: "Say why, not what." });
    await driver.diff.comments.save({ ...base, line: 4, body: "My private draft." });
    await reviewer.diff.comments.save({ ...base, line: 5, body: "A reviewer's draft." });
    // The driver sends: both of their drafts go, the reviewer's stays.
    const sent = await driver.diff.comments.send({ taskId: task.taskId });
    expect(sent).toMatchObject({ sent: 2, delivery: "steer" });
    const driverSees = await driver.diff.comments.list({ taskId: task.taskId });
    expect(driverSees.comments.map((comment) => [comment.body, comment.state, comment.mine])).toEqual([
      ["Say why, not what.", "sent", true],
      ["My private draft.", "sent", true],
    ]);
    const reviewerSees = await reviewer.diff.comments.list({ taskId: task.taskId });
    // The reviewer sees the two sent comments and their own draft, with who wrote each.
    expect(reviewerSees.comments.map((comment) => [comment.body, comment.state, comment.mine])).toEqual([
      ["Say why, not what.", "sent", false],
      ["My private draft.", "sent", false],
      ["A reviewer's draft.", "draft", true],
    ]);
    expect(reviewerSees.comments[0]?.author.name).not.toBe("");
    expect(reviewerSees.draftCount).toBe(1);
    // The driver cannot see the reviewer's draft, in the list or by touching it.
    expect(driverSees.comments.some((comment) => comment.body === "A reviewer's draft.")).toBe(false);
    const theirs = reviewerSees.comments.find((comment) => comment.state === "draft");
    await expect(driver.diff.comments.delete({ taskId: task.taskId, commentId: theirs?.commentId ?? sentOne.commentId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-072/c1: save checks the line exists in that head's diff, edits only the author's own draft, and deletes only a draft", async () => {
    const task = await makeTask("save");
    await storeDiff(task.head, readme("four"));
    const driver = await harness.as(harness.fixture.a.member);
    const other = await harness.as(harness.fixture.a.insider);
    const base = { taskId: task.taskId, taskRepoId: task.taskRepoId, path: "README.md", side: "new" as const, headSha: task.head };
    // A line outside the diff, a file outside the diff, and a head that was never fetched.
    await expect(driver.diff.comments.save({ ...base, line: 99, body: "Nowhere." })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(driver.diff.comments.save({ ...base, path: "src/none.ts", line: 2, body: "Nowhere." })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(driver.diff.comments.save({ ...base, headSha: sha("unfetched"), line: 2, body: "Nowhere." })).rejects.toMatchObject({ code: "CONFLICT" });
    // An empty comment and a very long one.
    await expect(driver.diff.comments.save({ ...base, line: 2, body: "   " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(driver.diff.comments.save({ ...base, line: 2, body: "x".repeat(4_001) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A task repo of another task isn't this task's.
    const elsewhere = await makeTask("save-elsewhere");
    await expect(driver.diff.comments.save({ ...base, taskRepoId: elsewhere.taskRepoId, line: 2, body: "Wrong task." })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const made = await driver.diff.comments.save({ ...base, line: 3, body: "Before." });
    const edited = await driver.diff.comments.save({ taskId: task.taskId, commentId: made.commentId, body: "After." });
    expect(edited.commentId).toBe(made.commentId);
    expect((await driver.diff.comments.list({ taskId: task.taskId })).comments.map((comment) => comment.body)).toEqual(["After."]);
    // Another member's draft is not theirs to see, edit or delete.
    await expect(other.diff.comments.save({ taskId: task.taskId, commentId: made.commentId, body: "Mine now." })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.diff.comments.delete({ taskId: task.taskId, commentId: made.commentId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A comment id from another task is not this task's.
    await expect(driver.diff.comments.delete({ taskId: elsewhere.taskId, commentId: made.commentId })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await driver.diff.comments.delete({ taskId: task.taskId, commentId: made.commentId });
    expect((await driver.diff.comments.list({ taskId: task.taskId })).comments).toHaveLength(0);
    // A sent comment can be neither edited nor deleted, by anyone.
    const kept = await driver.diff.comments.save({ ...base, line: 4, body: "Sent soon." });
    await driver.diff.comments.send({ taskId: task.taskId });
    await expect(driver.diff.comments.save({ taskId: task.taskId, commentId: kept.commentId, body: "Late edit." })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(driver.diff.comments.delete({ taskId: task.taskId, commentId: kept.commentId })).rejects.toMatchObject({ code: "CONFLICT" });
    // Another organization's member can't reach it at all.
    const outsider = await harness.as(harness.fixture.b.admin);
    await expect(outsider.diff.comments.delete({ taskId: task.taskId, commentId: kept.commentId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-072/c2: send is one message for a set of drafts: two sends at once make one message, and the sequence it returns is the message's", async () => {
    const task = await makeTask("send");
    await storeDiff(task.head, readme("five"));
    const driver = await harness.as(harness.fixture.a.member);
    const base = { taskId: task.taskId, taskRepoId: task.taskRepoId, path: "README.md", side: "new" as const, headSha: task.head };
    await driver.diff.comments.save({ ...base, line: 2, body: "First." });
    await driver.diff.comments.save({ ...base, line: 3, body: "Second." });
    harness.fakes.outbox.clear();
    const results = await Promise.allSettled([driver.diff.comments.send({ taskId: task.taskId }), driver.diff.comments.send({ taskId: task.taskId })]);
    const fulfilled = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: "PRECONDITION_FAILED" } });
    const messages = (await userMessages(task)).filter((message) => message.intent === "diff-comments");
    expect(messages).toHaveLength(1);
    expect(fulfilled[0]?.seq).toBe(messages[0]?.seq);
    expect(harness.fakes.outbox.commands.filter((command) => command.kind === "steer")).toHaveLength(1);
    // A third send, with nothing left to send, says so.
    await expect(driver.diff.comments.send({ taskId: task.taskId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "There are no comments to send" });
    // The message carries the comments as data in a marked block, with the file and the quoted line.
    expect(messages[0]?.text).toContain("README.md");
    expect(messages[0]?.text).toContain("First.");
  });

  it("F-072/c2: a member who isn't the driver is told to take over while a session is going; a task with no session reopens", async () => {
    const running = await makeTask("not-driver");
    await storeDiff(running.head, readme("six"));
    const other = await harness.as(harness.fixture.a.insider);
    const base = { taskId: running.taskId, taskRepoId: running.taskRepoId, path: "README.md", side: "new" as const, headSha: running.head };
    await other.diff.comments.save({ ...base, line: 2, body: "From the reviewer." });
    await expect(other.diff.comments.send({ taskId: running.taskId })).rejects.toMatchObject({ code: "FORBIDDEN", message: "Take over to send" });
    // Nothing was sent, and the draft is still a draft.
    expect((await userMessages(running)).filter((message) => message.intent === "diff-comments")).toHaveLength(0);
    expect((await other.diff.comments.list({ taskId: running.taskId })).draftCount).toBe(1);
    // After taking over, the same send goes.
    await other.tasks.takeOver({ taskId: running.taskId });
    expect(await other.diff.comments.send({ taskId: running.taskId })).toMatchObject({ sent: 1, delivery: "steer" });

    // A stopped task has no session going: the send reopens it, whoever sends.
    const stopped = await makeTask("stopped", { state: "stopped", going: false });
    await storeDiff(stopped.head, readme("seven"));
    const member = await harness.as(harness.fixture.a.member);
    await member.diff.comments.save({ taskId: stopped.taskId, taskRepoId: stopped.taskRepoId, path: "README.md", side: "new", headSha: stopped.head, line: 2, body: "Reopen with this." });
    const reopened = await member.diff.comments.send({ taskId: stopped.taskId });
    expect(reopened).toMatchObject({ sent: 1, delivery: "reopen" });
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: stopped.taskId } })).state).not.toBe("stopped");
  });

  it("F-072/c1: a later head that changes a commented line marks the comment outdated, and the list returns the line as it was", async () => {
    const task = await makeTask("outdated");
    await storeDiff(task.head, readme("eight"));
    const driver = await harness.as(harness.fixture.a.member);
    const made = await driver.diff.comments.save({ taskId: task.taskId, taskRepoId: task.taskRepoId, path: "README.md", side: "new", headSha: task.head, line: 2, body: "Rename this." });
    // Core's `diff.fetch` marks a comment outdated when a newer head changes its line.
    await harness.test.db.diffComment.update({ where: { id: made.commentId }, data: { outdatedAt: new Date() } });
    const listed = await driver.diff.comments.list({ taskId: task.taskId });
    expect(listed.comments[0]).toMatchObject({ outdated: true, quoted: { kind: "add", text: "new eight" }, headSha: task.head });
  });

  it("F-072/c1: a comment's words reach no log line", async () => {
    const task = await makeTask("logs");
    await storeDiff(task.head, readme("nine"));
    const driver = await harness.as(harness.fixture.a.member);
    const secret = "needle-comment-text-4431";
    await driver.diff.comments.save({ taskId: task.taskId, taskRepoId: task.taskRepoId, path: "README.md", side: "new", headSha: task.head, line: 2, body: secret });
    await driver.diff.comments.send({ taskId: task.taskId });
    expect(JSON.stringify(harness.logs)).not.toContain(secret);
  });
});
