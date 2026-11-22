import { randomBytes, randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import type { FakeMergeOutcome, FakeReviewInput } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  evaluateReviewCheck,
  INDEPENDENT_REVIEW_CHECK_NAME,
  jobKey,
  jobPayloadSchemas,
  linkGitHubUser,
  openPullRequests,
  pendingReasonWords,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  REVIEW_CHECK_WAITING_TITLE,
  systemClock,
  unlinkGitHubUser,
} from "@ostra/domain";
import type { JobName, JobPayload, JobQueue, ReviewCheckDeps } from "@ostra/domain";
import { connectionIdSchema, gitShaSchema, repoFullNameSchema, sessionIdSchema, taskRepoIdSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { GitSha, TaskRepoId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { githubWebhookHandler, reconcilePullRequests } from "../code-host/pull-requests.ts";
import type { PullRequestStateDeps } from "../code-host/pull-requests.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { jobContext } from "../testing/turns.ts";
import { seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";
import type { WebhookDeliveryContext } from "../webhooks/process.ts";
import { reviewEvaluateHandler } from "./review-check.ts";

// Milestone 4's ticket 18 (F-104): the `ostra/independent-review` check, evaluated against the fake
// code host's reviews and check runs and Postgres, and what enqueues its evaluation.

let test: TestDatabase;
let fixture: IsolationFixture;
let world: World;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const REPO = repoFullNameSchema.parse("ostra-test/test1");

type Enqueued = { readonly job: JobName; readonly payload: unknown; readonly startAfterMs: number | undefined };
const enqueued: Enqueued[] = [];
const jobs: JobQueue = {
  enqueueInTx: (_tx, job, payload, options) => {
    enqueued.push({ job, payload, startAfterMs: options?.startAfterMs });
    return Promise.resolve();
  },
};

/** Each person's GitHub account. */
const GH = { driver: "9001", other: "9002", second: "9003", outsider: "9004", unlinked: "9005", bot: "9006", removed: "9007" } as const;

const sha = (char: string): GitSha => gitShaSchema.parse(char.repeat(40));

const link = (member: SeededMember, githubUserId: string, login: string) =>
  test.db.user.update({ where: { id: member.userId }, data: { githubUserId, githubLogin: login, githubLinkedAt: new Date() } });

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  await link(fixture.a.member, GH.driver, "dana-driver");
  await link(fixture.a.admin, GH.other, "olly-other");
  await link(fixture.a.insider, GH.second, "sam-second");
  await link(fixture.b.admin, GH.outsider, "otto-outsider");
});

afterAll(async () => {
  await test.dispose();
});

beforeEach(() => {
  enqueued.length = 0;
  records.length = 0;
});

const deps = (overrides: Partial<ReviewCheckDeps> = {}): ReviewCheckDeps => ({
  db: test.db,
  notices: postgresChangeNotices,
  clock: systemClock,
  adapters: { codeHost, secretStore },
  logger,
  ...overrides,
});

type TaskPr = QueuedTask & { readonly taskRepoId: TaskRepoId; readonly number: number; readonly head: GitSha };

/** A task whose one repo has an open PR, opened on the fake host, at a head of its own. */
const taskWithPr = async (): Promise<TaskPr> => {
  const task = await seedQueuedTask(test.db, world, fixture.a.member, null);
  const taskRepo = await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } });
  const app = codeHost.apps.keys().next().value ?? "";
  const opened = await codeHost.openPullRequest({
    access: { app: { appId: app, privateKey: codeHost.apps.get(app)?.privateKey ?? "" }, installationId: "777", repo: REPO },
    head: taskRepo.branchName,
    base: "main",
    title: "Add a short CONTRIBUTING.md",
    body: "Body.",
    draft: false,
  });
  if (!opened.ok) throw new Error("the fake host refused the PR");
  // A head of its own: the fake host keeps one check run per repo, head and name.
  const head = gitShaSchema.parse(randomBytes(20).toString("hex"));
  codeHost.pushHead(REPO, opened.value.number, head);
  await test.db.taskRepo.update({ where: { id: taskRepo.id }, data: { state: "pr_open", prNumber: opened.value.number, prUrl: opened.value.url, headSha: head, ahead: true } });
  await test.db.taskPullRequest.create({
    data: { organizationId: world.organizationId, projectId: world.projectId, taskRepoId: taskRepo.id, number: opened.value.number, url: opened.value.url, branchName: taskRepo.branchName, state: "open" },
  });
  await test.db.task.update({ where: { id: task.taskId }, data: { state: "in_review", subState: "waiting_for_reviewer" } });
  return { ...task, taskRepoId: taskRepoIdSchema.parse(taskRepo.id), number: opened.value.number, head };
};

const review = (pr: TaskPr, who: keyof typeof GH, state: FakeReviewInput["state"], commit: GitSha = pr.head, at = Date.now()) =>
  codeHost.reviewsAndChecks.addReview(REPO, pr.number, { userId: GH[who], login: `${who}-login`, isBot: who === "bot", state, commitId: commit, submittedAt: at });

const evaluate = async (pr: TaskPr, head: GitSha = pr.head, overrides: Partial<ReviewCheckDeps> = {}) => {
  const result = await evaluateReviewCheck(deps(overrides), { organizationId: world.organizationId, taskRepoId: pr.taskRepoId, prNumber: pr.number, headSha: head });
  if (!result.ok) throw new Error(`not evaluated: ${result.error}`);
  return result;
};

const runOf = (head: GitSha) => {
  const runs = codeHost.reviewsAndChecks.checkRuns(REPO, head, INDEPENDENT_REVIEW_CHECK_NAME);
  expect(runs.length).toBeLessThanOrEqual(1);
  return runs[0];
};

/** Why a merge was refused, or `null` when it went through. */
const refusal = (outcome: FakeMergeOutcome): string | null => (outcome.merged ? null : outcome.reason);

const rowOf = (pr: TaskPr, head: GitSha = pr.head) => test.db.reviewCheck.findUnique({ where: { taskRepoId_headSha: { taskRepoId: pr.taskRepoId, headSha: head } } });

const checkEvents = (pr: TaskPr) => test.db.event.findMany({ where: { taskId: pr.taskId, kind: "review.check_updated" }, orderBy: { seq: "asc" } });

describe("F-104: the independent-review check", () => {
  it("F-104/c1,c2,c7, F-119/c3: a new PR's check waits, and an approval by a linked member who didn't drive the task passes it, naming them", async () => {
    const pr = await taskWithPr();
    expect((await evaluate(pr)).outcome).toBe("published");
    const waiting = runOf(pr.head);
    expect(waiting).toMatchObject({ status: "in_progress", conclusion: null, title: REVIEW_CHECK_WAITING_TITLE, summary: pendingReasonWords("no-approval") });
    expect(await rowOf(pr)).toMatchObject({ status: "pending", prNumber: pr.number, checkRunId: waiting?.checkRunId, approverMemberId: null });

    review(pr, "other", "commented");
    review(pr, "other", "approved");
    const passed = await evaluate(pr);
    expect(passed).toMatchObject({ outcome: "updated", verdict: { status: "passed", approverMemberId: fixture.a.admin.id } });
    const name = (await test.db.user.findUniqueOrThrow({ where: { id: fixture.a.admin.userId } })).name;
    // One run on the head, updated in place.
    expect(runOf(pr.head)).toMatchObject({ checkRunId: waiting?.checkRunId, status: "completed", conclusion: "success", title: `Approved by ${name}` });
    expect(await rowOf(pr)).toMatchObject({ status: "passed", approverMemberId: fixture.a.admin.id, reason: `Approved by ${name}` });
    const events = await checkEvents(pr);
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({ status: "pending", approverMemberId: null, prNumber: pr.number, headSha: pr.head }),
      expect.objectContaining({ status: "passed", approverMemberId: fixture.a.admin.id }),
    ]);
  });

  it("F-104/c2,c4,c5, F-119/c3: an approval by a driver, a bot, an unlinked user, another organization's or a removed member waits, saying why", async () => {
    const cases: readonly [keyof typeof GH, Parameters<typeof pendingReasonWords>[0]][] = [
      ["driver", "only-drivers-approved"],
      ["bot", "only-bots-approved"],
      ["unlinked", "only-unlinked-approved"],
      ["outsider", "only-unlinked-approved"],
    ];
    for (const [who, reason] of cases) {
      const pr = await taskWithPr();
      review(pr, who, "approved");
      expect((await evaluate(pr)).verdict).toEqual({ status: "pending", reason });
      expect(runOf(pr.head)).toMatchObject({ status: "in_progress", summary: pendingReasonWords(reason) });
      expect((await rowOf(pr))?.status).toBe("pending");
    }
    // A member who was removed no longer counts, though their link stays.
    const removed = await taskWithPr();
    await test.db.member.update({ where: { id: fixture.a.insider.id }, data: { state: "removed", removedAt: new Date() } });
    try {
      review(removed, "second", "approved");
      expect((await evaluate(removed)).verdict).toEqual({ status: "pending", reason: "only-unlinked-approved" });
    } finally {
      await test.db.member.update({ where: { id: fixture.a.insider.id }, data: { state: "active", removedAt: null } });
    }
  });

  it("F-104/c5: a driver is every member credited with a trailer on the task", async () => {
    const pr = await taskWithPr();
    await test.db.taskCoAuthor.create({
      data: { organizationId: world.organizationId, projectId: world.projectId, taskId: pr.taskId, memberId: fixture.a.insider.id, name: "Sam Second", email: "9003+sam@users.noreply.github.com" },
    });
    review(pr, "second", "approved");
    expect((await evaluate(pr)).verdict).toEqual({ status: "pending", reason: "only-drivers-approved" });
    // Someone with no trailer passes it.
    review(pr, "other", "approved");
    expect((await evaluate(pr)).verdict).toMatchObject({ status: "passed", approverMemberId: fixture.a.admin.id });
  });

  it("F-104/c4,c6: a new head waits for an approval of that head, and the old head's check keeps its result", async () => {
    const pr = await taskWithPr();
    review(pr, "other", "approved");
    expect((await evaluate(pr)).verdict.status).toBe("passed");
    const next = sha("b");
    const result = await evaluate(pr, next);
    expect(result).toMatchObject({ outcome: "published", verdict: { status: "pending", reason: "approval-is-stale" } });
    expect(runOf(next)).toMatchObject({ status: "in_progress", title: REVIEW_CHECK_WAITING_TITLE });
    expect(runOf(pr.head)).toMatchObject({ status: "completed", conclusion: "success" });
    expect((await rowOf(pr, next))?.status).toBe("pending");
    expect((await rowOf(pr))?.status).toBe("passed");
    // An approval of the new head passes it.
    review(pr, "other", "approved", next);
    expect((await evaluate(pr, next)).verdict.status).toBe("passed");
  });

  it("F-104/c4,c6: a dismissal, a withdrawn approval, or changes requested after it set a passed check back to waiting, on the same run", async () => {
    const pr = await taskWithPr();
    const approval = review(pr, "other", "approved");
    await evaluate(pr);
    const runId = runOf(pr.head)?.checkRunId;
    expect(runOf(pr.head)?.conclusion).toBe("success");
    codeHost.reviewsAndChecks.dismissReview(REPO, pr.number, approval.reviewId);
    expect((await evaluate(pr)).verdict).toEqual({ status: "pending", reason: "no-approval" });
    expect(runOf(pr.head)).toMatchObject({ checkRunId: runId, status: "in_progress", conclusion: null });
    expect((await rowOf(pr))?.approverMemberId).toBeNull();
    // Approved again, then the same reviewer asks for changes: waiting again.
    review(pr, "other", "approved");
    expect((await evaluate(pr)).verdict.status).toBe("passed");
    review(pr, "other", "changes_requested");
    expect((await evaluate(pr)).verdict).toEqual({ status: "pending", reason: "changes-requested" });
    expect(runOf(pr.head)).toMatchObject({ checkRunId: runId, status: "in_progress", summary: pendingReasonWords("changes-requested") });
  });

  it("F-104/c6: a replayed review webhook enqueues the same keyed evaluation, which writes nothing the second time", async () => {
    const pr = await taskWithPr();
    review(pr, "other", "approved");
    const connection = await test.db.repo.findUniqueOrThrow({ where: { id: world.repoId }, select: { connectionId: true, hostRepoId: true } });
    const payload = {
      action: "submitted",
      installation: { id: 777 },
      repository: { id: connection.hostRepoId, full_name: REPO },
      pull_request: { number: pr.number, head: { sha: pr.head } },
      review: { id: 1, user: { id: Number(GH.other), login: "olly-other", type: "User" }, state: "APPROVED", commit_id: pr.head, submitted_at: new Date().toISOString(), body: "Looks good, secret words." },
    };
    const deliver = () =>
      githubWebhookHandler(prDeps())({
        organizationId: world.organizationId,
        connectionId: connectionIdSchema.parse(connection.connectionId),
        deliveryId: webhookDeliveryIdSchema.parse(randomUUID()),
        event: "pull_request_review",
        payload,
        receivedAt: Date.now(),
        logger,
      } satisfies WebhookDeliveryContext);
    expect(await deliver()).toEqual({ outcome: "processed" });
    expect(await deliver()).toEqual({ outcome: "processed" });
    const expected: JobPayload<"review.evaluate"> = { organizationId: world.organizationId, taskRepoId: pr.taskRepoId, prNumber: pr.number, headSha: pr.head };
    expect(enqueued).toEqual([
      { job: "review.evaluate", payload: expected, startAfterMs: 10_000 },
      { job: "review.evaluate", payload: expected, startAfterMs: 10_000 },
    ]);
    // One key, so the queue runs one; and a second run of it changes nothing.
    expect(jobKey("review.evaluate", expected)).toBe(`pr:${pr.taskRepoId}:${String(pr.number)}:review:${pr.head}`);
    expect((await evaluate(pr)).outcome).toBe("published");
    const update = vi.spyOn(codeHost, "updateCheckRun");
    const publish = vi.spyOn(codeHost, "publishCheckRun");
    const before = await rowOf(pr);
    expect((await evaluate(pr)).outcome).toBe("unchanged");
    expect(update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    update.mockRestore();
    publish.mockRestore();
    expect((await rowOf(pr))?.updatedAt).toEqual(before?.updatedAt);
    expect(await checkEvents(pr)).toHaveLength(1);
    // Logins and IDs only: never a review's text.
    expect(JSON.stringify(records)).not.toContain("secret words");
    expect(JSON.stringify(await checkEvents(pr))).not.toContain("secret words");
    // A review on a PR that isn't a task's is ignored.
    payload.pull_request.number = 9_999;
    expect((await deliver()).outcome).toBe("ignored");
  });

  it("F-104/c3,c7: under branch protection, a waiting check blocks a merge in both modes, by in_progress or by action_required", async () => {
    const pr = await taskWithPr();
    const base = "main";
    // GitHub blocks on an in-progress required check: the default.
    codeHost.reviewsAndChecks.protect(REPO, base, { requiredCheck: INDEPENDENT_REVIEW_CHECK_NAME, mode: "in_progress-blocks" });
    expect(codeHost.reviewsAndChecks.merge(REPO, base, pr.head).merged).toBe(false);
    await evaluate(pr);
    expect(refusal(codeHost.reviewsAndChecks.merge(REPO, base, pr.head))).toContain("in progress");
    review(pr, "other", "approved");
    await evaluate(pr);
    expect(codeHost.reviewsAndChecks.merge(REPO, base, pr.head)).toEqual({ merged: true });

    // GitHub lets an in-progress check through: the switch reports `action_required`, which blocks.
    const second = await taskWithPr();
    const head = sha("c");
    codeHost.reviewsAndChecks.protect(REPO, base, { requiredCheck: INDEPENDENT_REVIEW_CHECK_NAME, mode: "only-failing-blocks" });
    await evaluate(second, head, { waiting: "action_required" });
    expect(runOf(head)).toMatchObject({ status: "completed", conclusion: "action_required", title: REVIEW_CHECK_WAITING_TITLE });
    expect(refusal(codeHost.reviewsAndChecks.merge(REPO, base, head))).toContain("needs action");
    review(second, "other", "approved", head);
    await evaluate(second, head, { waiting: "action_required" });
    expect(runOf(head)).toMatchObject({ status: "completed", conclusion: "success" });
    expect(codeHost.reviewsAndChecks.merge(REPO, base, head)).toEqual({ merged: true });
    codeHost.reviewsAndChecks.protect(REPO, base, null);
  });

  it("F-104: a host failure throws for a retry and writes nothing; a PR the task never had isn't evaluated", async () => {
    const pr = await taskWithPr();
    codeHost.failReviewLists = 1;
    await expect(evaluate(pr)).rejects.toThrow(/couldn't list the reviews/);
    expect(await rowOf(pr)).toBeNull();
    expect(runOf(pr.head)).toBeUndefined();
    expect(await evaluateReviewCheck(deps(), { organizationId: world.organizationId, taskRepoId: pr.taskRepoId, prNumber: 4_242, headSha: pr.head })).toMatchObject({ ok: false, error: "not-a-task-pr" });
    expect(await evaluateReviewCheck(deps(), { organizationId: fixture.b.organization.id, taskRepoId: pr.taskRepoId, prNumber: pr.number, headSha: pr.head })).toMatchObject({ ok: false, error: "not-found" });
  });
});

const parseBody = (body: string): unknown => {
  const parsed: unknown = JSON.parse(body);
  return parsed;
};

const prDeps = (): PullRequestStateDeps => ({ db: test.db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, codeHost, secretStore, logger });

describe("F-104: what enqueues an evaluation", () => {
  const evaluations = () => enqueued.filter((entry) => entry.job === "review.evaluate").map((entry) => entry.payload);

  it("F-104/c6: a new head on the PR (synchronize) and the PR reconcile each enqueue an evaluation on the new head", async () => {
    const pr = await taskWithPr();
    const next = sha("d");
    codeHost.pushHead(REPO, pr.number, next);
    const connection = await test.db.repo.findUniqueOrThrow({ where: { id: world.repoId }, select: { connectionId: true } });
    const connectionId = connectionIdSchema.parse(connection.connectionId);
    const delivery = codeHost.pullRequestDelivery(REPO, pr.number, "synchronize");
    const outcome = await githubWebhookHandler(prDeps())({
      organizationId: world.organizationId,
      connectionId,
      deliveryId: webhookDeliveryIdSchema.parse(randomUUID()),
      event: "pull_request",
      payload: parseBody(delivery.body),
      receivedAt: Date.now(),
      logger,
    });
    expect(outcome).toEqual({ outcome: "processed" });
    expect(evaluations()).toEqual([{ organizationId: world.organizationId, taskRepoId: pr.taskRepoId, prNumber: pr.number, headSha: next }]);
    enqueued.length = 0;
    await reconcilePullRequests(prDeps(), { organizationId: world.organizationId, connectionId });
    expect(evaluations()).toContainEqual({ organizationId: world.organizationId, taskRepoId: pr.taskRepoId, prNumber: pr.number, headSha: next });
  });

  it("F-104/c2: linking or unlinking a GitHub account enqueues an evaluation of each open task PR of the member's organization", async () => {
    const pr = await taskWithPr();
    const ports = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() } };
    const unlinked = await unlinkGitHubUser(ports, { userId: fixture.a.insider.userId });
    expect(unlinked.ok).toBe(true);
    expect(evaluations()).toContainEqual({ organizationId: world.organizationId, taskRepoId: pr.taskRepoId, prNumber: pr.number, headSha: pr.head });
    enqueued.length = 0;
    expect((await linkGitHubUser(ports, { userId: fixture.a.insider.userId, githubUserId: GH.second, githubLogin: "sam-second" })).ok).toBe(true);
    expect(evaluations()).toContainEqual({ organizationId: world.organizationId, taskRepoId: pr.taskRepoId, prNumber: pr.number, headSha: pr.head });
    // Never another organization's PRs.
    expect(evaluations().every((payload) => JSON.stringify(payload).includes(world.organizationId))).toBe(true);
  });

  it("F-104/c1: a PR ostra opens gets its check enqueued on its head, and the job publishes it there as waiting", async () => {
    const task = await seedQueuedTask(test.db, world, fixture.a.member, null);
    const head = sha("e");
    await test.db.taskRepo.updateMany({ where: { taskId: task.taskId }, data: { ahead: true, headSha: head, state: "branch_pushed" } });
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "running" } });
    const opened = await openPullRequests(
      { db: test.db, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() }, publicUrl: "https://ostra.example", jobs },
      { organizationId: world.organizationId, taskId: task.taskId, sessionId: sessionIdSchema.parse(task.sessionId), eventSeq: 1 },
    );
    expect(opened.ok).toBe(true);
    const taskRepo = await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } });
    const [payload] = evaluations();
    expect(evaluations()).toEqual([{ organizationId: world.organizationId, taskRepoId: taskRepo.id, prNumber: taskRepo.prNumber, headSha: head }]);
    // The queue runs it: the check is on the PR's head, waiting.
    const parsed = jobPayloadSchemas["review.evaluate"].parse(payload);
    await reviewEvaluateHandler({ db: test.db, notices: postgresChangeNotices, clock: systemClock, adapters: { codeHost, secretStore } })(jobContext("review.evaluate", parsed, logger));
    expect(runOf(head)).toMatchObject({ status: "in_progress", title: REVIEW_CHECK_WAITING_TITLE, repo: REPO });
    expect(await test.db.reviewCheck.findUnique({ where: { taskRepoId_headSha: { taskRepoId: taskRepo.id, headSha: head } } })).toMatchObject({ status: "pending", prNumber: taskRepo.prNumber });
  });
});
