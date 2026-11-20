import { randomBytes } from "node:crypto";

import { silentLogger } from "@ostra/adapter-sdk";
import { codeOwnerLoginKey, fanOutNotification, moveTaskInTx, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox } from "@ostra/domain";
import { connectionIdSchema, needsYouItemIdSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { NeedsYouItemId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { githubWebhookHandler } from "../code-host/pull-requests.ts";
import type { PullRequestStateDeps } from "../code-host/pull-requests.ts";
import { FakeModelProvider } from "../testing/fake-adapters.ts";
import { checkRun, recorded, seedTaskInCi, startLoopHarness, stateOf } from "../testing/review-loop.ts";
import type { LoopHarness, LoopPr, LoopTask } from "../testing/review-loop.ts";
import type { WebhookDeliveryContext } from "../webhooks/process.ts";

/** The thread event `reviewers.updated`, as the test reads it back. */
const reviewersUpdatedSchema = z.looseObject({ repoId: z.string(), prNumber: z.number(), memberIds: z.array(z.string()) });

// Milestone 6's ticket 19 (F-102, F-036; ADR 0058, ADR 0050): a task PR's reviewers, read on the
// fake code host. The requested users and teams, and the owners CODEOWNERS names for the changed
// paths at the base, each user matched to a member through the verified GitHub link; a team kept as
// its own row; an unlinked user listed with no member. A task waiting for a reviewer is its matched
// reviewers' needs-you, or its driver's when nobody matched, and a reviewer's review clears their own.

let h: LoopHarness;

beforeAll(async () => {
  h = await startLoopHarness();
  // The verified links (F-119): the admin is `alice` (1001), the insider is `bob` (1002).
  await h.db.user.update({ where: { id: h.fixture.a.admin.userId }, data: { githubUserId: "1001", githubLogin: "alice" } });
  await h.db.user.update({ where: { id: h.fixture.a.insider.userId }, data: { githubUserId: "1002", githubLogin: "bob" } });
  await h.db.project.update({ where: { id: h.world.projectId }, data: { aiReview: false } });
});

afterAll(async () => {
  await h.stop();
});

beforeEach(() => {
  h.jobs.jobs.length = 0;
  h.records.length = 0;
});

const firstPr = (task: LoopTask): LoopPr => {
  const pr = task.prs[0];
  if (pr === undefined) throw new Error("the task has no PR");
  return pr;
};

const prDeps = (): PullRequestStateDeps => ({
  db: h.db,
  jobs: h.jobs,
  notices: postgresChangeNotices,
  audit: postgresAuditLog,
  clock: h.clock,
  codeHost: h.codeHost,
  secretStore: h.secretStore,
  logger: silentLogger,
});

const delivery = async (event: string, payload: Record<string, unknown>): Promise<WebhookDeliveryContext> => {
  const connection = await h.db.connection.findFirstOrThrow({ where: { organizationId: h.world.organizationId, kind: "github" } });
  return {
    organizationId: h.world.organizationId,
    connectionId: connectionIdSchema.parse(connection.id),
    deliveryId: webhookDeliveryIdSchema.parse(randomBytes(8).toString("hex")),
    event,
    payload,
    receivedAt: Date.now(),
    logger: silentLogger,
  };
};

/** GitHub's `pull_request` `review_requested` delivery for a task PR. */
const reviewRequested = (pr: LoopPr) => ({
  action: "review_requested",
  number: pr.number,
  installation: { id: 777 },
  repository: { id: `host-${pr.repo}`, full_name: pr.repo },
  pull_request: { number: pr.number, state: "open", head: { sha: pr.head, ref: "ostra/x" }, updated_at: new Date().toISOString() },
});

/** The PR changes `src/index.ts` and `README.md`, from its base. */
const changePaths = (pr: LoopPr): void => {
  h.codeHost.setCompare(pr.repo, pr.head, {
    aheadBy: 1,
    behindBy: 0,
    mergeBase: null,
    files: ["src/index.ts", "README.md"].map((path) => ({ path, previousPath: null, status: "modified" as const, additions: 1, deletions: 0, patch: null, truncated: false })),
    filesTruncated: false,
    limits: { maxFiles: 300, maxPatchBytes: 1_000_000 },
  });
};

const CODEOWNERS = ["# The repo's owners", "* @root-owner", "src/** @bob @ostra-test/frontend", "docs/ @dave", ""].join("\n");

/** A task PR with requested users (alice, linked; carol, not), a requested team, and a CODEOWNERS file. */
const seedReviewers = (pr: LoopPr, options: { readonly codeOwners?: boolean } = {}): void => {
  h.codeHost.ci.requestReviewers(pr.repo, pr.number, { users: [{ userId: "1001", login: "alice" }, { userId: "1003", login: "carol" }], teams: [{ slug: "Backend" }] });
  // Every test's PR is on the one repo: a test without code owners empties the file.
  h.codeHost.ci.setFile(pr.repo, "main", ".github/CODEOWNERS", options.codeOwners === false ? "" : CODEOWNERS);
  changePaths(pr);
};

const reviewersOf = async (pr: LoopPr) =>
  (await h.db.taskReviewer.findMany({ where: { taskRepoId: pr.taskRepoId }, orderBy: [{ teamSlug: "asc" }, { login: "asc" }] })).map((row) => ({
    login: row.login,
    githubUserId: row.githubUserId,
    teamSlug: row.teamSlug,
    memberId: row.memberId,
    source: row.source,
  }));

const notifyDeps = () => ({
  db: h.db,
  jobs: h.jobs,
  notices: postgresChangeNotices,
  outbox: postgresCommandOutbox,
  audit: postgresAuditLog,
  clock: h.clock,
  adapters: { codeHost: h.codeHost, modelProvider: new FakeModelProvider(), secretStore: h.secretStore },
});

/** The task's open reviewer item, and its fan-out run as `notify.fanout` runs it. */
const fannedOutItem = async (task: LoopTask): Promise<NeedsYouItemId> => {
  const item = await h.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId, reason: "waiting_for_reviewer", state: "open" } });
  const result = await fanOutNotification(notifyDeps(), { organizationId: h.world.organizationId, itemId: needsYouItemIdSchema.parse(item.id), change: "created" });
  expect(result.ok).toBe(true);
  return needsYouItemIdSchema.parse(item.id);
};

/** A review's time on the host after the item was written: the item's time is the database's, ahead of the test's clock. */
const afterTheItem = (): number => Math.max(h.clock.now(), Date.now()) + 1_000;

/** A code task whose CI passed with the AI review off: waiting for a reviewer. */
const waitingTask = async (): Promise<LoopTask> => {
  const task = await seedTaskInCi(h);
  checkRun(h, firstPr(task), "test", "success");
  await h.drain(["ci.evaluate"]);
  expect(await stateOf(h, task.taskId)).toBe("in_review/waiting_for_reviewer");
  return task;
};

describe("F-102: who reviews", () => {
  it("F-102/c3: reviewers come from the requested users and CODEOWNERS for the changed paths, matched by the link; a team is kept and not expanded; an unlinked user is listed with no member", async () => {
    const task = await seedTaskInCi(h);
    const pr = firstPr(task);
    seedReviewers(pr);
    h.jobs.jobs.length = 0;
    // GitHub's `review_requested` is a hint: it asks for `reviewers.refresh`, and the host is read.
    expect(await githubWebhookHandler(prDeps())(await delivery("pull_request", reviewRequested(pr)))).toEqual({ outcome: "processed" });
    expect(recorded(h, "reviewers.refresh")).toEqual([{ organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId }]);
    await h.drain(["reviewers.refresh"]);

    expect(await reviewersOf(pr)).toEqual([
      // The two teams, each a row with no member: the requested one and CODEOWNERS' one for `src/**`.
      { login: null, githubUserId: null, teamSlug: "backend", memberId: null, source: "team" },
      { login: null, githubUserId: null, teamSlug: "frontend", memberId: null, source: "team" },
      { login: "alice", githubUserId: "1001", teamSlug: null, memberId: h.fixture.a.admin.id, source: "requested" },
      // `bob` owns `src/index.ts` by the last matching line, and is matched by his linked login.
      { login: "bob", githubUserId: "1002", teamSlug: null, memberId: h.fixture.a.insider.id, source: "codeowners" },
      { login: "carol", githubUserId: "1003", teamSlug: null, memberId: null, source: "requested" },
      // `README.md` falls to `*`; `docs/` changed nothing, so `dave` isn't asked.
      { login: "root-owner", githubUserId: codeOwnerLoginKey("root-owner"), teamSlug: null, memberId: null, source: "codeowners" },
    ]);
    const updated = await h.db.event.findMany({ where: { taskId: task.taskId, kind: "reviewers.updated" } });
    expect(updated).toHaveLength(1);
    const payload = reviewersUpdatedSchema.parse(updated[0]?.payload);
    expect(payload).toMatchObject({ repoId: pr.repoId, prNumber: pr.number });
    expect([...payload.memberIds].sort()).toEqual([h.fixture.a.admin.id, h.fixture.a.insider.id].sort());
    // ostra requested nobody: the host's requests are the person's own.
    expect(h.codeHost.ci.requestedReviewers(pr.repo, pr.number).users.map((user) => user.login)).toEqual(["alice", "carol"]);

    // The same set again writes no second `reviewers.updated`; a request removed drops its row.
    h.jobs.record("reviewers.refresh", { organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId });
    await h.drain(["reviewers.refresh"]);
    expect(await h.db.event.count({ where: { taskId: task.taskId, kind: "reviewers.updated" } })).toBe(1);
    h.codeHost.ci.removeRequestedReviewer(pr.repo, pr.number, { userId: "1003" });
    h.jobs.record("reviewers.refresh", { organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId });
    await h.drain(["reviewers.refresh"]);
    expect((await reviewersOf(pr)).map((row) => row.login ?? row.teamSlug)).not.toContain("carol");
    expect(await h.db.event.count({ where: { taskId: task.taskId, kind: "reviewers.updated" } })).toBe(2);
    // Nothing of the CODEOWNERS file reaches a log line.
    expect(JSON.stringify(h.records)).not.toContain("The repo's owners");
  });

  it("F-102/c3: a PR's opening and the reconcile each ask for its reviewers, and a host without the capabilities reads nothing", async () => {
    const task = await seedTaskInCi(h);
    const pr = firstPr(task);
    h.jobs.jobs.length = 0;
    const opened = { ...reviewRequested(pr), action: "opened" };
    expect(await githubWebhookHandler(prDeps())(await delivery("pull_request", opened))).toEqual({ outcome: "processed" });
    expect(recorded(h, "reviewers.refresh")).toContainEqual({ organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId });

    h.codeHost.reviewLoop = false;
    try {
      h.jobs.jobs.length = 0;
      expect(await githubWebhookHandler(prDeps())(await delivery("pull_request", reviewRequested(pr)))).toMatchObject({ outcome: "ignored" });
      expect(recorded(h, "reviewers.refresh")).toEqual([]);
    } finally {
      h.codeHost.reviewLoop = true;
    }
  });
});

describe("F-102: the reviewers' needs-you", () => {
  it("F-102/c3: a task waiting for a reviewer is its matched reviewers' needs-you, and each one's review clears their own", async () => {
    const task = await waitingTask();
    const pr = firstPr(task);
    seedReviewers(pr, { codeOwners: false });
    h.jobs.record("reviewers.refresh", { organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId });
    await h.drain(["reviewers.refresh"]);
    // A second matched reviewer, asked on the host.
    h.codeHost.ci.requestReviewers(pr.repo, pr.number, { users: [{ userId: "1002", login: "bob" }], teams: [] });
    h.jobs.record("reviewers.refresh", { organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId });
    await h.drain(["reviewers.refresh"]);

    const item = await h.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId, reason: "waiting_for_reviewer", state: "open" } });
    expect(item.audience).toBe("reviewer");
    const itemId = await fannedOutItem(task);
    const open = async () => (await h.db.notification.findMany({ where: { needsYouItemId: itemId, state: "open" }, orderBy: { memberId: "asc" } })).map((row) => row.memberId);
    // The matched reviewers, never the driver; carol (unlinked) and the team reach nobody.
    expect(await open()).toEqual([h.fixture.a.admin.id, h.fixture.a.insider.id].sort());

    // alice's review comes in (GitHub drops her request): her own notification is answered, the item stays for bob.
    h.clock.advance(1_000);
    h.codeHost.reviewsAndChecks.addReview(pr.repo, pr.number, { userId: "1001", login: "alice", isBot: false, state: "commented", commitId: pr.head, submittedAt: afterTheItem() });
    h.codeHost.ci.removeRequestedReviewer(pr.repo, pr.number, { userId: "1001" });
    h.jobs.record("review.evaluate", { organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId, prNumber: pr.number, headSha: pr.head });
    await h.drain(["review.evaluate"]);
    expect(await open()).toEqual([h.fixture.a.insider.id]);
    expect((await h.db.needsYouItem.findUniqueOrThrow({ where: { id: itemId } })).state).toBe("open");
    // Her row stays, with her state, though the host no longer lists her as requested.
    h.jobs.record("reviewers.refresh", { organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId });
    await h.drain(["reviewers.refresh"]);
    expect(await h.db.taskReviewer.findFirst({ where: { taskRepoId: pr.taskRepoId, githubUserId: "1001" }, select: { lastReviewState: true } })).toEqual({ lastReviewState: "commented" });

    // bob's review: every matched reviewer reviewed, so the item is answered.
    h.clock.advance(1_000);
    h.codeHost.reviewsAndChecks.addReview(pr.repo, pr.number, { userId: "1002", login: "bob", isBot: false, state: "approved", commitId: pr.head, submittedAt: afterTheItem() });
    h.jobs.record("review.evaluate", { organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId, prNumber: pr.number, headSha: pr.head });
    await h.drain(["review.evaluate"]);
    expect(await open()).toEqual([]);
    expect(await h.db.needsYouItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({ state: "answered", resolvedByMemberId: h.fixture.a.insider.id });
  });

  it("F-102/c3: with nobody matched, the task waiting for a reviewer is its driver's", async () => {
    const task = await waitingTask();
    const pr = firstPr(task);
    // Only an unlinked user and a team are asked.
    h.codeHost.ci.requestReviewers(pr.repo, pr.number, { users: [{ userId: "1003", login: "carol" }], teams: [{ slug: "backend" }] });
    h.codeHost.ci.setFile(pr.repo, "main", ".github/CODEOWNERS", "");
    changePaths(pr);
    h.jobs.record("reviewers.refresh", { organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId });
    await h.drain(["reviewers.refresh"]);
    const itemId = await fannedOutItem(task);
    const notified = await h.db.notification.findMany({ where: { needsYouItemId: itemId } });
    const { driverMemberId } = await h.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(driverMemberId).not.toBeNull();
    expect(notified.map((row) => [row.memberId, row.kind])).toEqual([[driverMemberId, "review_requested"]]);
  });

  it("F-102/c3: a task that stops waiting for a reviewer dismisses its item", async () => {
    const task = await waitingTask();
    const item = await h.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId, reason: "waiting_for_reviewer" } });
    expect(item.state).toBe("open");
    // "Changes requested" sends the task back to its agent: nobody waits on a reviewer meanwhile.
    const row = await h.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    const moved = await h.db.$transaction((tx) =>
      moveTaskInTx({ tx, notices: postgresChangeNotices, jobs: h.jobs }, { ...row, id: task.taskId, organizationId: task.organizationId, projectId: h.world.projectId }, { type: "changes_requested" }),
    );
    expect(moved).toBe(true);
    expect((await h.db.needsYouItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe("dismissed");
  });
});
