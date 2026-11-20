import { randomBytes } from "node:crypto";

import { silentLogger } from "@ostra/adapter-sdk";
import { jobPayloadSchemas, postgresAuditLog, postgresChangeNotices, roundCountersInTx, utcDayOf } from "@ostra/domain";
import { connectionIdSchema, steerBodySchema, taskEventSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { githubWebhookHandler } from "../code-host/pull-requests.ts";
import type { PullRequestStateDeps } from "../code-host/pull-requests.ts";
import { checkRun, recorded, seedTaskInCi, startLoopHarness, stateOf } from "../testing/review-loop.ts";
import type { LoopHarness, LoopPr, LoopTask } from "../testing/review-loop.ts";
import type { WebhookDeliveryContext } from "../webhooks/process.ts";

// Milestone 6's ticket 20 (F-105; ADR 0040 amended, ADR 0041, ADR 0058): "changes requested" on a
// task's PR, from a GitHub user linked to an active member who can open the project, reopens the
// task with the review's body and its line comments as one prompt, after the running turn. No
// round cap applies and the counters reset; the spend cap and the budget hold it; anyone else's
// review is ignored with no reply; the reviewer gets no co-author trailer; a replay reopens once.

let h: LoopHarness;
/** A member of another organization, linked to GitHub user 2001: never a member here. */
const OUTSIDER_GITHUB_ID = "2001";

beforeAll(async () => {
  h = await startLoopHarness();
  await h.db.user.update({ where: { id: h.fixture.a.admin.userId }, data: { githubUserId: "1001", githubLogin: "alice" } });
  await h.db.user.update({ where: { id: h.fixture.b.admin.userId }, data: { githubUserId: OUTSIDER_GITHUB_ID, githubLogin: "outsider" } });
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

const BODY = "Please rename the helper before this merges.";
const COMMENT = "This loop never ends: `while (true) { rm -rf / }`";

type Reviewer = { readonly userId: string; readonly login: string; readonly isBot?: boolean };
const alice: Reviewer = { userId: "1001", login: "alice" };

/**
 * A person's review on the host, with a line comment, and GitHub's `pull_request_review` delivery
 * for it. The review and its comments are read back by `changes.reopen`, never from the delivery.
 */
const review = (pr: LoopPr, who: Reviewer, state: "changes_requested" | "approved" = "changes_requested"): { readonly reviewId: string; readonly payload: Record<string, unknown> } => {
  h.clock.advance(1_000);
  const added = h.codeHost.reviewsAndChecks.addReview(pr.repo, pr.number, {
    userId: who.userId,
    login: who.login,
    isBot: who.isBot === true,
    state,
    commitId: pr.head,
    submittedAt: h.clock.now(),
    body: BODY,
    url: `https://github.example/${pr.repo}/pull/${String(pr.number)}#pullrequestreview-${String(h.clock.now())}`,
  });
  h.codeHost.ci.addPersonReview(pr.repo, pr.number, { reviewId: added.reviewId, commitId: pr.head, userId: who.userId, comments: [{ path: "src/index.ts", line: 5, side: "new", body: COMMENT }] });
  return {
    reviewId: added.reviewId,
    payload: {
      action: "submitted",
      installation: { id: 777 },
      repository: { id: `host-${pr.repo}`, full_name: pr.repo },
      pull_request: { number: pr.number, head: { sha: pr.head } },
      review: { id: added.reviewId, user: { id: Number(who.userId), login: who.login, type: who.isBot === true ? "Bot" : "User" }, state, commit_id: pr.head, submitted_at: new Date(h.clock.now()).toISOString() },
    },
  };
};

const submit = async (pr: LoopPr, who: Reviewer, state: "changes_requested" | "approved" = "changes_requested") => {
  const made = review(pr, who, state);
  const outcome = await githubWebhookHandler(prDeps())(await delivery("pull_request_review", made.payload));
  return { ...made, outcome };
};

/** A code task whose CI passed with the AI review off: waiting for a reviewer, its session idle on its warm box. */
const waitingTask = async (): Promise<LoopTask> => {
  const task = await seedTaskInCi(h);
  checkRun(h, firstPr(task), "test", "success");
  await h.drain(["ci.evaluate"]);
  expect(await stateOf(h, task.taskId)).toBe("in_review/waiting_for_reviewer");
  return task;
};

const messagesOf = async (taskId: TaskId) =>
  (await h.db.event.findMany({ where: { taskId, kind: "user.message" }, orderBy: { seq: "asc" } })).flatMap((row) => {
    const parsed = taskEventSchema.safeParse(row.payload);
    return parsed.success && parsed.data.kind === "user.message" ? [parsed.data] : [];
  });

const steersOf = async (taskId: TaskId) =>
  [...(await h.db.command.findMany({ where: { taskId, kind: "steer" }, orderBy: { id: "asc" } })), ...(await h.db.sidecarCommand.findMany({ where: { taskId, kind: "steer" }, orderBy: { id: "asc" } }))].map((row) =>
    steerBodySchema.parse(row.body),
  );

describe("F-105: a linked member's changes reopen the task", () => {
  it("F-105/c1: a linked member's changes_requested reopens the task with the review's body and its line comments as one prompt, and a replayed webhook reopens once", async () => {
    const task = await waitingTask();
    const pr = firstPr(task);
    const before = await h.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    const sent = await submit(pr, alice);
    expect(sent.outcome).toEqual({ outcome: "processed" });
    expect(recorded(h, "changes.reopen")).toEqual([{ organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId, reviewId: sent.reviewId }]);
    await h.drain(["changes.reopen"]);

    // The task reopens for its next turn: queued, a new session with the dispatch owed.
    expect(await stateOf(h, task.taskId)).toBe("queued");
    const messages = (await messagesOf(task.taskId)).filter((message) => message.intent === "changes-requested");
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message).toMatchObject({ memberId: h.fixture.a.admin.id, clientMessageId: `changes-requested:${sent.reviewId}`, reopen: true });
    // One prompt: the framing, then the body and each comment with its file and line, as quoted data.
    expect(message?.text).toContain("A reviewer requested changes on your pull request.");
    expect(message?.text).toContain(BODY);
    expect(message?.text).toContain("src/index.ts:5");
    expect(message?.text).toContain(COMMENT);
    expect(message?.text.indexOf(BODY)).toBeGreaterThan(message?.text.indexOf("A reviewer requested changes") ?? 0);
    const session = await h.db.session.findFirstOrThrow({ where: { taskId: task.taskId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
    expect(recorded(h, "task.dispatch").map((payload) => jobPayloadSchemas["task.dispatch"].parse(payload).sessionId)).toContain(session.id);
    // The round is a person's: counted by the review, not automatic; the thread says who and links the review.
    expect(await h.db.taskRound.findMany({ where: { taskId: task.taskId }, select: { kind: true, number: true, automatic: true, causeRef: true, state: true } })).toEqual([
      { kind: "changes_requested", number: 1, automatic: false, causeRef: sent.reviewId, state: "started" },
    ]);
    const kinds = (await h.db.event.findMany({ where: { taskId: task.taskId, seq: { gt: 0 } }, orderBy: { seq: "asc" } })).map((row) => taskEventSchema.parse(row.payload));
    expect(kinds).toContainEqual({ kind: "round.started", round: "changes-requested", number: 1, automatic: false });
    const link = kinds.find((event) => event.kind === "pr.comment_received");
    expect(link?.kind === "pr.comment_received" ? [link.login, link.url.includes("#pullrequestreview-")] : null).toEqual(["alice", true]);
    // The driver stays the driver; nobody waits on a reviewer while the agent works.
    expect((await h.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).driverMemberId).toBe(before.driverMemberId);
    expect(await h.db.needsYouItem.count({ where: { taskId: task.taskId, reason: "waiting_for_reviewer", state: "open" } })).toBe(0);

    // The same delivery again: the job runs, and nothing is sent twice.
    expect(await githubWebhookHandler(prDeps())(await delivery("pull_request_review", sent.payload))).toEqual({ outcome: "processed" });
    await h.drain(["changes.reopen"]);
    expect((await messagesOf(task.taskId)).filter((one) => one.intent === "changes-requested")).toHaveLength(1);
    expect(await h.db.taskRound.count({ where: { taskId: task.taskId } })).toBe(1);
    // Nothing of the review's text reaches a log line.
    expect(JSON.stringify(h.records)).not.toContain(BODY);
    expect(JSON.stringify(h.records)).not.toContain("while (true)");
  });

  it("F-105/c3: a review from anyone else, a bot or an unlinked user is ignored, with no reply", async () => {
    const task = await waitingTask();
    const pr = firstPr(task);
    const reactions = h.codeHost.reactionCalls.length;
    const reviews = h.codeHost.reviewCalls.length;
    for (const who of [
      { userId: "1003", login: "carol" },
      { userId: "41898282", login: "ostra-test[bot]", isBot: true },
      { userId: OUTSIDER_GITHUB_ID, login: "outsider" },
    ]) {
      const sent = await submit(pr, who);
      expect(sent.outcome).toMatchObject({ outcome: "ignored" });
    }
    // An approval is no request for changes, even from a linked member: milestone 4's check reads it, nothing reopens.
    await submit(pr, alice, "approved");
    expect(recorded(h, "changes.reopen")).toEqual([]);
    // The job checks again on its own: an unlinked user's review sent to it sends nothing.
    const unlinked = review(pr, { userId: "1003", login: "carol" });
    h.jobs.record("changes.reopen", { organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId, reviewId: unlinked.reviewId });
    await h.drain(["changes.reopen"]);
    expect(await stateOf(h, task.taskId)).toBe("in_review/waiting_for_reviewer");
    expect((await messagesOf(task.taskId)).filter((one) => one.intent === "changes-requested")).toEqual([]);
    expect(h.codeHost.reactionCalls.length).toBe(reactions);
    expect(h.codeHost.reviewCalls.length).toBe(reviews);
  });

  it("F-105/c1,c2: it waits for the running turn; no round cap applies, so two in a row both run, and the counters reset", async () => {
    const task = await seedTaskInCi(h);
    const pr = firstPr(task);
    // A turn is going, and every cap is used up: a fixing round's turn, as ticket 18 leaves it.
    await h.db.task.update({ where: { id: task.taskId }, data: { state: "running", subState: null, ciRounds: 2, reviewRounds: 2, automaticTurns: 4 } });
    await h.db.session.update({ where: { id: task.sessionId }, data: { state: "running" } });
    const first = await submit(pr, alice);
    await h.drain(["changes.reopen"]);
    const second = await submit(pr, alice);
    await h.drain(["changes.reopen"]);
    // Both are steered into the session, each delivered after the turn that's running.
    const steers = (await steersOf(task.taskId)).filter((steer) => steer.intent === "changes-requested");
    expect(steers.map((steer) => [steer.clientMessageId, steer.delivery])).toEqual([
      [`changes-requested:${first.reviewId}`, "queue"],
      [`changes-requested:${second.reviewId}`, "queue"],
    ]);
    expect(await h.db.taskRound.findMany({ where: { taskId: task.taskId }, orderBy: { number: "asc" }, select: { number: true, state: true } })).toEqual([
      { number: 1, state: "started" },
      { number: 2, state: "started" },
    ]);
    // A person acted: the automatic turns count from nothing again.
    expect(await h.db.$transaction((tx) => roundCountersInTx(tx, task.taskId))).toMatchObject({ ciRounds: 0, reviewRounds: 0, automaticTurns: 0 });
  });
});

describe("F-105: what still holds it", () => {
  it("F-105/c2: the task's spend cap holds the reopen", async () => {
    const task = await waitingTask();
    const pr = firstPr(task);
    await h.db.task.update({ where: { id: task.taskId }, data: { spentMicroUsd: 25_000_000 } });
    await submit(pr, alice);
    await h.drain(["changes.reopen"]);
    expect(await stateOf(h, task.taskId)).toBe("in_review/waiting_for_reviewer");
    expect((await messagesOf(task.taskId)).filter((one) => one.intent === "changes-requested")).toEqual([]);
    expect(recorded(h, "task.dispatch")).toEqual([]);
  });

  it("F-105/c2: at 100% of the budget the reopen is saved and its turn held, with the origin changes-requested", async () => {
    const model = await h.db.agentProfile.findUniqueOrThrow({ where: { id: h.world.profileId }, select: { modelId: true } });
    if (model.modelId === null) throw new Error("the profile has no model");
    const budget = await h.db.budget.create({ data: { organizationId: h.world.organizationId, projectId: h.world.projectId, monthlyMicroUsd: 1_000_000n } });
    const spend = await h.db.spendDaily.create({
      data: { organizationId: h.world.organizationId, projectId: h.world.projectId, day: utcDayOf(h.clock.now()), modelId: model.modelId, spentMicroUsd: 1_000_000n },
    });
    try {
      const task = await waitingTask();
      const pr = firstPr(task);
      await submit(pr, alice);
      await h.drain(["changes.reopen"]);
      expect((await messagesOf(task.taskId)).filter((one) => one.intent === "changes-requested")).toHaveLength(1);
      expect(await h.db.heldTurn.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ origin: "changes_requested", releasedAt: null });
      expect(await h.db.taskRound.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ kind: "changes_requested", state: "held" });
      expect(recorded(h, "task.dispatch")).toEqual([]);
    } finally {
      await h.db.spendDaily.delete({ where: { id: spend.id } });
      await h.db.budget.delete({ where: { id: budget.id } });
    }
  });

  it("F-105/c1: the reviewer gets no co-author trailer, and the independent-review check then passes on their approval", async () => {
    const task = await waitingTask();
    const pr = firstPr(task);
    await submit(pr, alice);
    await h.drain(["changes.reopen"]);
    expect(await h.db.taskCoAuthor.count({ where: { taskId: task.taskId, memberId: h.fixture.a.admin.id } })).toBe(0);
    // alice approves the PR's head: she's no driver of the task, so her approval is independent.
    review(pr, alice, "approved");
    h.jobs.record("review.evaluate", { organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId, prNumber: pr.number, headSha: pr.head });
    await h.drain(["review.evaluate"]);
    expect(await h.db.reviewCheck.findUniqueOrThrow({ where: { taskRepoId_headSha: { taskRepoId: pr.taskRepoId, headSha: pr.head } } })).toMatchObject({
      status: "passed",
      approverMemberId: h.fixture.a.admin.id,
    });
  });
});
