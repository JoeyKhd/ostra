import { createHash, randomBytes } from "node:crypto";

import type { CompareResult } from "@ostra/adapter-sdk";
import { toStoredDiff } from "@ostra/domain";
import { boardIdSchema, connectionIdSchema, findingIdSchema, gitShaSchema, repoIdSchema, taskEventSchema, taskRepoIdSchema } from "@ostra/protocol";
import type { FindingId, GitSha, OrganizationId, ProjectId, RepoId, TaskRepoId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendEvent, createApiHarness, seedBoard, seedConnectionAndModel, seedLinearConnection, seedProject, seedTask, seedTicket } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";

// Milestone 6's ticket 28 (F-102, F-100, F-101, F-035, F-105, F-111): the review screen, "Fix this"
// and "Remember this", the task's rounds and a project's Review settings, through the panel's own
// procedures against Postgres. The rows core's review loop writes (CI runs, review runs, findings,
// reviewers, rounds) are seeded as core writes them; the diff is milestone 3's stored compare.

let harness: ApiHarness;
let orgA: OrganizationId;
let projectId: ProjectId;
let repo1: RepoId;
let repo2: RepoId;

const sha = (seed: string): GitSha => gitShaSchema.parse(createHash("sha1").update(seed).digest("hex"));
const limits = { maxFiles: 300, maxPatchBytes: 1024 * 1024 };

const compareOf = (path: string, word: string): CompareResult => ({
  aheadBy: 1,
  behindBy: 0,
  mergeBase: "e".repeat(40),
  files: [
    { path, previousPath: null, status: "modified", additions: 1, deletions: 1, patch: ["@@ -1,3 +1,3 @@", " # title", `-old ${word}`, `+new ${word}`, " end"].join("\n"), truncated: false },
    { path: "a/z.ts", previousPath: null, status: "added", additions: 2, deletions: 0, patch: ["@@ -0,0 +1,2 @@", "+one", "+two"].join("\n"), truncated: false },
  ],
  filesTruncated: false,
  limits,
});

const codeOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof TRPCError) return error.code;
    throw error;
  }
  return "OK";
};

type World = SeededTask & {
  readonly pr1: TaskRepoId;
  readonly pr2: TaskRepoId;
  readonly head1: GitSha;
  readonly head2: GitSha;
  readonly blocking: FindingId;
  readonly nit: FindingId;
  readonly runId: string;
  readonly logBlobId: string;
};

/** A code task in review with two PRs, a CI run on each, one posted review with a finding on each, reviewers and two rounds. */
const reviewedTask = async (title: string, over: { readonly appliedDraft?: boolean } = {}): Promise<World> => {
  const db = harness.test.db;
  const task = await seedTask(harness, { organizationId: orgA, projectId, title, state: "in_review", driverMemberId: harness.fixture.a.admin.id, creatorMemberId: harness.fixture.a.admin.id, sessionState: "ended" });
  const board = await db.board.findFirstOrThrow({ where: { projectId } });
  const ticketId = await seedTicket(harness, { projectId, boardId: boardIdSchema.parse(board.id), connectionId: connectionIdSchema.parse(board.connectionId), description: "The ticket's own words, with its criteria." });
  await db.task.update({ where: { id: task.taskId }, data: { subState: "fixing_findings", ticketId, boardId: board.id, ciRounds: 1, reviewRounds: 1, automaticTurns: 2 } });
  if (over.appliedDraft ?? true) {
    const refine = await db.task.create({
      data: { organizationId: orgA, projectId, kind: "refine", source: "ticket", title: "Refine it", branchName: `ostra/${randomBytes(4).toString("hex")}-refine`, state: "done", ticketId, ticketKey: "ENG-1", boardId: board.id },
      select: { id: true },
    });
    await db.refineDraft.create({
      data: { organizationId: orgA, projectId, taskId: refine.id, version: 1, source: "agent", description: "Make it fast.", acceptanceCriteria: ["It renders in under 1 s", "No layout shift"], edgeCases: [], openQuestions: [], subTickets: [], appliedAt: new Date() },
    });
  }
  const head1 = sha(`${title}-1`);
  const head2 = sha(`${title}-2`);
  const repoRow = async (repoId: RepoId, number: number, head: GitSha) =>
    taskRepoIdSchema.parse(
      (
        await db.taskRepo.create({
          data: { organizationId: orgA, projectId, taskId: task.taskId, repoId, branchName: `ostra/${title}`, baseBranch: "main", state: "pr_open", headSha: head, prNumber: number, prUrl: `https://github.com/ostra-test/test/pull/${String(number)}`, prTitle: `PR ${String(number)}` },
          select: { id: true },
        })
      ).id,
    );
  const pr1 = await repoRow(repo1, 7, head1);
  const pr2 = await repoRow(repo2, 8, head2);
  for (const [repoId, head, path] of [
    [repo1, head1, "README.md"],
    [repo2, head2, "docs/guide.md"],
  ] as const) {
    const stored = toStoredDiff(compareOf(path, title), { headSha: head, hostUrl: "https://github.com/ostra-test/test/pull/7/files", limits });
    await db.diffCache.create({ data: { organizationId: orgA, projectId, repoId, baseSha: "e".repeat(40), headSha: head, result: stored } });
  }
  const blob = await db.blob.create({ data: { organizationId: orgA, store: "postgres", key: `ci-${randomBytes(4).toString("hex")}`, purpose: "ci-log", contentType: "text/plain", size: 10, sha256: "0".repeat(64) }, select: { id: true } });
  await db.ciRun.create({ data: { organizationId: orgA, projectId, taskRepoId: pr1, headSha: head1, state: "failed", checks: [{ name: "test", conclusion: "failure", externalId: "1" }, { name: "lint", conclusion: "success", externalId: "2" }], logBlobIds: [{ name: "test", blobId: blob.id }], completedAt: new Date() } });
  await db.ciRun.create({ data: { organizationId: orgA, projectId, taskRepoId: pr2, headSha: head2, state: "passed", checks: [{ name: "build", conclusion: "success", externalId: "3" }], completedAt: new Date() } });
  const run = await db.reviewRun.create({
    data: {
      organizationId: orgA,
      projectId,
      codeTaskId: task.taskId,
      round: 1,
      state: "posted",
      summary: "One problem.",
      blocking: 1,
      nits: 1,
      postedAt: new Date(),
      heads: [
        { repoId: repo1, prNumber: 7, baseSha: "e".repeat(40), headSha: head1 },
        { repoId: repo2, prNumber: 8, baseSha: "e".repeat(40), headSha: head2 },
      ],
    },
    select: { id: true },
  });
  const blocking = await db.finding.create({
    data: { organizationId: orgA, projectId, reviewRunId: run.id, taskRepoId: pr1, path: "README.md", line: 2, side: "new", severity: "blocking", title: "Name the constant", body: "Use `MAX` here; `rm -rf /` isn't the fix.", suggestion: "new MAX", postedAs: "line_comment" },
    select: { id: true },
  });
  const nit = await db.finding.create({
    data: { organizationId: orgA, projectId, reviewRunId: run.id, taskRepoId: pr2, path: "src/other.ts", line: 40, side: "new", severity: "nit", title: "A typo", body: "Off the diff.", postedAs: "review_body" },
    select: { id: true },
  });
  await db.taskReviewer.create({ data: { organizationId: orgA, projectId, taskRepoId: pr1, githubUserId: "101", login: "alice", memberId: harness.fixture.a.member.id, source: "requested", lastReviewState: "COMMENTED" } });
  await db.taskReviewer.create({ data: { organizationId: orgA, projectId, taskRepoId: pr1, teamSlug: "web", source: "codeowners" } });
  await db.taskReviewer.create({ data: { organizationId: orgA, projectId, taskRepoId: pr2, githubUserId: "202", login: "bob", source: "codeowners" } });
  await db.taskRound.create({ data: { organizationId: orgA, projectId, taskId: task.taskId, kind: "ci", number: 1, automatic: true, causeRef: `${head1}.1`, state: "started" } });
  await db.taskRound.create({ data: { organizationId: orgA, projectId, taskId: task.taskId, kind: "findings", number: 1, automatic: true, causeRef: run.id, state: "started" } });
  return { ...task, pr1, pr2, head1, head2, blocking: findingIdSchema.parse(blocking.id), nit: findingIdSchema.parse(nit.id), runId: run.id, logBlobId: blob.id };
};

beforeAll(async () => {
  harness = await createApiHarness();
  orgA = harness.fixture.a.organization.id;
  const world = await seedConnectionAndModel(harness);
  const made = await seedProject(harness, world, "reviewed");
  projectId = made.projectId;
  repo1 = repoIdSchema.parse(made.repoId);
  const first = await harness.test.db.repo.findUniqueOrThrow({ where: { id: repo1 } });
  repo2 = repoIdSchema.parse(
    (
      await harness.test.db.repo.create({
        data: { organizationId: orgA, projectId, connectionId: first.connectionId, installationId: first.installationId, hostRepoId: "2", fullName: "ostra-test/test2", defaultBranch: "main", checkoutDir: "test2", position: 1 },
        select: { id: true },
      })
    ).id,
  );
  const connectionId = await seedLinearConnection(harness);
  await seedBoard(harness, { projectId, connectionId });
});

afterAll(async () => {
  await harness.dispose();
});

describe("the review screen (F-102, ticket 28)", () => {
  it("F-102/c1: the screen of a task with two PRs: each PR's diff and files, its findings with their state, its CI and its reviewers; the ticket's criteria; the round line", async () => {
    const task = await reviewedTask("two-prs");
    const member = await harness.as(harness.fixture.a.member);
    const screen = await member.review.screen({ taskId: task.taskId });
    expect(screen.prs.map((pr) => [pr.repo, pr.prNumber, pr.diffState])).toEqual([
      ["ostra-test/test1", 7, "ready"],
      ["ostra-test/test2", 8, "ready"],
    ]);
    const [one, two] = screen.prs;
    expect(one?.fileTree).toEqual([
      { path: "a/z.ts", status: "added", additions: 2, deletions: 0, openFindings: 0 },
      { path: "README.md", status: "modified", additions: 1, deletions: 1, openFindings: 1 },
    ]);
    expect(one?.files.find((file) => file.path === "README.md")?.hunks).toHaveLength(1);
    expect(one?.findings).toMatchObject([{ findingId: task.blocking, round: 1, path: "README.md", line: 2, side: "new", severity: "blocking", state: "open", postedAs: "line_comment" }]);
    expect(two?.findings).toMatchObject([{ findingId: task.nit, severity: "nit", postedAs: "review_body" }]);
    expect(one?.ci).toMatchObject({ state: "failed", checks: [{ name: "test", conclusion: "failure" }, { name: "lint", conclusion: "success" }] });
    expect(two?.ci?.state).toBe("passed");
    const memberName = (await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.member.userId } })).name;
    expect(one?.reviewers).toEqual([
      { login: "alice", team: null, member: { memberId: harness.fixture.a.member.id, name: memberName }, source: "requested", state: "COMMENTED" },
      { login: null, team: "web", member: null, source: "codeowners", state: null },
    ]);
    expect(two?.reviewers).toMatchObject([{ login: "bob", member: null }]);
    expect(screen.ticket).toMatchObject({ acceptanceCriteria: ["It renders in under 1 s", "No layout shift"], criteriaFrom: "draft" });
    expect(screen.rounds).toEqual({ subState: "fixing_findings", ci: { used: 1, limit: 2 }, review: { used: 1, limit: 2 }, automaticTurns: { used: 2, limit: 4 } });
    expect(screen.reviewRuns).toMatchObject([{ round: 1, state: "posted", blocking: 1, nits: 1 }]);

    // No applied draft: the ticket's own text holds the criteria.
    const plain = await reviewedTask("no-draft", { appliedDraft: false });
    const plainScreen = await member.review.screen({ taskId: plain.taskId });
    expect(plainScreen.ticket).toMatchObject({ acceptanceCriteria: null, criteriaFrom: "ticket", description: "The ticket's own words, with its criteria." });

    // Another organization's admin finds no such task, and a refine or review task has no review screen.
    expect(await codeOf((await harness.as(harness.fixture.b.admin)).review.screen({ taskId: task.taskId }))).toBe("NOT_FOUND");
  });

  it("F-102/c1: a resolved finding names the round that resolved it, and a review running on a newer head says which head", async () => {
    const task = await reviewedTask("resolved-round");
    const { db } = harness.test;
    const head3 = sha("resolved-round-3");
    // Round 2 found round 1's blocking finding fixed; round 3 runs on the next head of the first PR.
    const second = await db.reviewRun.create({
      data: { organizationId: orgA, projectId, codeTaskId: task.taskId, round: 2, state: "posted", postedAt: new Date(), heads: [{ repoId: repo1, prNumber: 7, baseSha: "e".repeat(40), headSha: task.head1 }] },
      select: { id: true },
    });
    await db.finding.update({ where: { id: task.blocking }, data: { state: "resolved", resolvedInRunId: second.id } });
    await db.reviewRun.create({ data: { organizationId: orgA, projectId, codeTaskId: task.taskId, round: 3, state: "running", heads: [{ repoId: repo1, prNumber: 7, baseSha: "e".repeat(40), headSha: head3 }] } });
    const screen = await (await harness.as(harness.fixture.a.member)).review.screen({ taskId: task.taskId });
    expect(screen.prs[0]?.findings).toMatchObject([{ findingId: task.blocking, round: 1, state: "resolved", resolvedInRound: 2 }]);
    expect(screen.prs[1]?.findings).toMatchObject([{ findingId: task.nit, state: "open", resolvedInRound: null }]);
    expect(screen.reviewRuns.map((run) => [run.round, run.state, run.heads])).toEqual([
      [1, "posted", [{ repoId: repo1, headSha: task.head1 }, { repoId: repo2, headSha: task.head2 }]],
      [2, "posted", [{ repoId: repo1, headSha: task.head1 }]],
      [3, "running", [{ repoId: repo1, headSha: head3 }]],
    ]);
  });

  it("F-102/c1: Fix this puts the finding on its line as the member's draft comment, once, on the head it was found on; a finding off the diff has no line", async () => {
    const task = await reviewedTask("fix-this");
    const member = await harness.as(harness.fixture.a.member);
    const fixed = await member.review.fixThis({ findingId: task.blocking });
    expect(fixed.taskId).toBe(task.taskId);
    const again = await member.review.fixThis({ findingId: task.blocking });
    expect(again.commentId).toBe(fixed.commentId);
    const drafts = await harness.test.db.diffComment.findMany({ where: { taskId: task.taskId } });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ taskRepoId: task.pr1, path: "README.md", line: 2, side: "new", headSha: task.head1, state: "draft", memberId: harness.fixture.a.member.id });
    expect(drafts[0]?.body).toContain("Name the constant");
    expect(drafts[0]?.body).toContain("Suggested:\nnew MAX");
    // It's with the member's other drafts, which "Send to agent" sends as one prompt.
    const listed = await member.diff.comments.list({ taskId: task.taskId });
    expect(listed.comments).toMatchObject([{ commentId: fixed.commentId, state: "draft", mine: true, line: 2, path: "README.md" }]);
    // A person acted: the automatic turns count again from here.
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ automaticTurns: 0 });
    expect(await codeOf(member.review.fixThis({ findingId: task.nit }))).toBe("PRECONDITION_FAILED");
    expect(await codeOf((await harness.as(harness.fixture.b.admin)).review.fixThis({ findingId: task.blocking }))).toBe("NOT_FOUND");
    expect(await harness.test.db.diffComment.count({ where: { taskId: task.taskId } })).toBe(1);
  });

  it("F-102/c2: line comments go to the agent as one prompt: a finding sent with Fix this and the driver's own comment, in one message", async () => {
    const task = await reviewedTask("one-prompt");
    const driver = await harness.as(harness.fixture.a.admin);
    await driver.review.fixThis({ findingId: task.blocking });
    await driver.diff.comments.save({ taskId: task.taskId, taskRepoId: task.pr1, path: "a/z.ts", side: "new", line: 1, headSha: task.head1, body: "And rename this file." });
    harness.fakes.outbox.clear();
    await driver.diff.comments.send({ taskId: task.taskId });
    const messages = (await harness.test.db.event.findMany({ where: { taskId: task.taskId, kind: "user.message" }, orderBy: { seq: "asc" } })).map((row) => taskEventSchema.parse(row.payload));
    const sent = messages.flatMap((event) => (event.kind === "user.message" && event.intent === "diff-comments" ? [event] : []));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Name the constant");
    expect(sent[0]?.text).toContain("And rename this file.");
    expect(await harness.test.db.diffComment.count({ where: { taskId: task.taskId, state: "draft" } })).toBe(0);
  });

  it("F-111: Remember this on a finding makes one memory proposal, sourced by the finding", async () => {
    const task = await reviewedTask("remember");
    const member = await harness.as(harness.fixture.a.member);
    const before = await harness.test.db.memoryProposal.count({ where: { organizationId: orgA } });
    const made = await member.review.rememberFinding({ findingId: task.blocking });
    expect(await harness.test.db.memoryProposal.count({ where: { organizationId: orgA } })).toBe(before + 1);
    expect(await harness.test.db.memoryProposal.findUniqueOrThrow({ where: { id: made.proposalId } })).toMatchObject({ sourceKind: "ai_finding", sourceRef: task.blocking, taskId: task.taskId, state: "proposed" });
    expect(await codeOf((await harness.as(harness.fixture.b.admin)).review.rememberFinding({ findingId: task.blocking }))).toBe("NOT_FOUND");
  });
});

describe("the task's rounds (F-035, F-101, ticket 28)", () => {
  it("F-101: after a CI round and a findings round, each shows its cause, its state, and a capped one why", async () => {
    const task = await reviewedTask("rounds");
    // A second findings round the cap stopped, as `round.start` records it.
    await harness.test.db.taskRound.create({ data: { organizationId: orgA, projectId, taskId: task.taskId, kind: "findings", number: 3, automatic: true, causeRef: `${task.runId}-3`, state: "capped" } });
    await appendEvent(harness, task, { organizationId: orgA, projectId }, { kind: "round.capped", round: "findings", reason: "rounds" });
    const member = await harness.as(harness.fixture.a.member);
    const view = await member.tasks.rounds({ taskId: task.taskId });
    expect(view.limits).toEqual({ ciRounds: 2, reviewRounds: 2, automaticTurns: 4 });
    expect(view.rounds).toMatchObject([
      { kind: "ci", number: 1, automatic: true, state: "started", cause: { kind: "ci", headSha: task.head1, failing: [{ repo: "ostra-test/test1", name: "test", conclusion: "failure", logFile: `${task.logBlobId}.log` }] }, cappedReason: null, heldReason: null },
      { kind: "findings", number: 1, state: "started", cause: { kind: "findings", reviewRunId: task.runId, findings: [{ findingId: task.blocking, severity: "blocking" }, { findingId: task.nit, severity: "nit" }] } },
      { kind: "findings", number: 3, state: "capped", cappedReason: "rounds" },
    ]);
    // The passing check isn't a cause.
    expect(view.rounds[0]?.cause).not.toMatchObject({ failing: [{ name: "lint" }] });
    expect(await codeOf((await harness.as(harness.fixture.b.admin)).tasks.rounds({ taskId: task.taskId }))).toBe("NOT_FOUND");
  });

  it("F-035/c1,c2: each round says what its turn pushed and how CI went, and a hold the budget released says how long and who raised it", async () => {
    const task = await reviewedTask("outcomes");
    const { db } = harness.test;
    const now = Date.now();
    const minutes = (n: number) => new Date(now - n * 60_000);
    // The CI round, then the findings round; a head CI saw after each.
    await db.taskRound.updateMany({ where: { taskId: task.taskId, kind: "ci" }, data: { createdAt: minutes(30) } });
    await db.taskRound.updateMany({ where: { taskId: task.taskId, kind: "findings" }, data: { createdAt: minutes(10) } });
    const head3 = "c3".repeat(20);
    const head4 = "d4".repeat(20);
    await db.ciRun.create({ data: { organizationId: orgA, projectId, taskRepoId: task.pr1, headSha: head3, state: "passed", checks: [], firstSeenAt: minutes(20), completedAt: minutes(19) } });
    await db.ciRun.create({ data: { organizationId: orgA, projectId, taskRepoId: task.pr1, headSha: head4, state: "failed", checks: [{ name: "lint", conclusion: "failure", externalId: "9" }], firstSeenAt: minutes(5) } });
    // The CI round's turn the project's budget held for 9 minutes, until the admin raised it.
    const budget = await db.budget.create({ data: { organizationId: orgA, projectId, monthlyMicroUsd: 1n } });
    await db.heldTurn.create({ data: { organizationId: orgA, projectId, taskId: task.taskId, origin: "automatic_round", budgetId: budget.id, heldAt: minutes(29), releasedAt: minutes(20) } });
    await db.auditEntry.create({ data: { organizationId: orgA, projectId, actorKind: "member", actorId: harness.fixture.a.admin.id, action: "budget.set", entity: "budget", entityId: budget.id, createdAt: minutes(21) } });
    const view = await (await harness.as(harness.fixture.a.member)).tasks.rounds({ taskId: task.taskId });
    const adminName = (await db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.admin.userId } })).name;
    expect(view.rounds.find((round) => round.kind === "ci")).toMatchObject({
      outcome: { headSha: head3, ci: "passed", failing: null },
      hold: { heldAt: minutes(29).getTime(), releasedAt: minutes(20).getTime(), scope: "project", releasedByName: adminName },
    });
    expect(view.rounds.find((round) => round.kind === "findings")).toMatchObject({ outcome: { headSha: head4, ci: "failed", failing: "lint" }, hold: null });
  });
});

describe("a round's turn without a push (F-035, ticket 41)", () => {
  it("F-035/c1: a round whose turn ended and saved no new head says so; one still running, or whose push CI hasn't seen yet, says nothing", async () => {
    const task = await reviewedTask("no-push");
    const { db } = harness.test;
    const now = Date.now();
    const minutes = (n: number) => new Date(now - n * 60_000);
    const event = async (payload: unknown, createdAt: Date) => {
      const seq = await appendEvent(harness, task, { organizationId: orgA, projectId }, taskEventSchema.parse(payload));
      await db.event.update({ where: { taskId_seq: { taskId: task.taskId, seq } }, data: { createdAt } });
      return seq;
    };
    let ordinal = 0;
    const turn = async (startedAt: Date, endedAt: Date | null) => {
      const startSeq = await event({ kind: "turn.started", turnId: `turn-${String(ordinal + 1)}` }, startedAt);
      ordinal += 1;
      await db.turn.create({ data: { organizationId: orgA, projectId, taskId: task.taskId, sessionId: task.sessionId, ordinal, startSeq, startedAt, endedAt } });
    };
    const pushed = (headSha: string, ref = "refs/heads/ostra/no-push") => ({ kind: "git.pushed", repoId: repo1, branch: "ostra/no-push", headSha, ref });
    const saved = { kind: "session.saved", turnOrdinal: 1, repos: [], archive: null };
    // CI saw the task's heads before the rounds; the rounds ran in the task's session.
    await db.ciRun.updateMany({ where: { taskRepo: { taskId: task.taskId } }, data: { firstSeenAt: minutes(45) } });
    await db.taskRound.updateMany({ where: { taskId: task.taskId, kind: "ci" }, data: { createdAt: minutes(30), turnId: task.sessionId } });
    await db.taskRound.updateMany({ where: { taskId: task.taskId, kind: "findings" }, data: { createdAt: minutes(10), turnId: task.sessionId } });
    const head5 = sha("no-push-5");
    await db.taskRound.create({ data: { organizationId: orgA, projectId, taskId: task.taskId, kind: "ci", number: 2, automatic: true, causeRef: `${head5}.1`, state: "started", turnId: task.sessionId, createdAt: minutes(2) } });
    await event(pushed(task.head1), minutes(40));
    // The CI round's turn ended; the runner pushed the branch again at the same head, and only the hidden ref moved.
    await turn(minutes(29), minutes(25));
    await event(pushed(task.head1), minutes(25));
    await event(pushed(sha("no-push-wip"), `refs/ostra/wip/${task.taskId}`), minutes(25));
    await event(saved, minutes(25));
    // The findings round's turn pushed a new head that CI hasn't seen yet.
    await turn(minutes(9), minutes(5));
    await event(pushed(head5), minutes(5));
    await event(saved, minutes(5));
    // The second CI round's turn is still running.
    await turn(minutes(1), null);

    const view = await (await harness.as(harness.fixture.a.member)).tasks.rounds({ taskId: task.taskId });
    expect(view.rounds.map((round) => [round.kind, round.number, round.outcome])).toEqual([
      ["ci", 1, { kind: "no-push", endedAt: minutes(25).getTime() }],
      ["findings", 1, null],
      ["ci", 2, null],
    ]);
  });
});

describe("Review settings (F-100, ticket 28)", () => {
  it("F-035/c1: each repo's CI as ostra last saw it, on the newest head a task pushed there, and a repo no task pushed to has none", async () => {
    const task = await reviewedTask("ci-seen", { appliedDraft: false });
    const member = await harness.as(harness.fixture.a.member);
    const settings = await member.projects.reviewSettings({ projectId });
    const byName = new Map(settings.repos.map((repo) => [repo.fullName, repo] as const));
    expect(byName.get("ostra-test/test1")?.ci).toMatchObject({ state: "failed", headSha: task.head1, taskId: task.taskId, checks: [{ name: "test", conclusion: "failure" }, { name: "lint", conclusion: "success" }] });
    expect(byName.get("ostra-test/test2")?.ci).toMatchObject({ state: "passed", headSha: task.head2 });
    const first = await harness.test.db.repo.findUniqueOrThrow({ where: { id: repo1 } });
    const lonely = await harness.test.db.repo.create({
      data: { organizationId: orgA, projectId, connectionId: first.connectionId, installationId: first.installationId, hostRepoId: `lonely-${randomBytes(3).toString("hex")}`, fullName: `ostra-test/lonely-${randomBytes(3).toString("hex")}`, defaultBranch: "main", checkoutDir: "lonely", position: 9 },
      select: { fullName: true },
    });
    expect((await member.projects.reviewSettings({ projectId })).repos.find((repo) => repo.fullName === lonely.fullName)?.ci).toBeNull();
  });


  it("F-100/c5: the AI review switch is a project admin's only, audited; the round limits are shown and the install's", async () => {
    const member = await harness.as(harness.fixture.a.member);
    const settings = await member.projects.reviewSettings({ projectId });
    expect(settings).toMatchObject({ aiReview: true, canChange: false, limits: { ciRounds: 2, reviewRounds: 2, automaticTurns: 4 }, codeHost: { ciResults: harness.fakes.codeHost.capabilities.ciResults, reviewComments: harness.fakes.codeHost.capabilities.reviewComments } });
    expect(await codeOf(member.projects.setAiReview({ projectId, on: false }))).toBe("FORBIDDEN");
    expect(await harness.test.db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ aiReview: true });

    // A project admin who isn't an organization admin.
    await harness.test.db.projectMember.create({ data: { organizationId: orgA, projectId, memberId: harness.fixture.a.insider.id, role: "admin" } });
    const projectAdmin = await harness.as(harness.fixture.a.insider);
    expect((await projectAdmin.projects.reviewSettings({ projectId })).canChange).toBe(true);
    expect(await projectAdmin.projects.setAiReview({ projectId, on: false })).toEqual({ aiReview: false });
    expect(await harness.test.db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ aiReview: false });
    expect(await harness.test.db.auditEntry.findMany({ where: { entityId: projectId, action: "project.ai-review-set" }, select: { actorId: true, data: true } })).toEqual([{ actorId: harness.fixture.a.insider.id, data: { on: false } }]);
    // The same value again writes nothing.
    await projectAdmin.projects.setAiReview({ projectId, on: false });
    expect(await harness.test.db.auditEntry.count({ where: { entityId: projectId, action: "project.ai-review-set" } })).toBe(1);
    const admin = await harness.as(harness.fixture.a.admin);
    expect(await admin.projects.setAiReview({ projectId, on: true })).toEqual({ aiReview: true });
    expect(await codeOf((await harness.as(harness.fixture.b.admin)).projects.setAiReview({ projectId, on: false }))).toBe("NOT_FOUND");
  });
});
