import { randomBytes } from "node:crypto";

import { silentLogger } from "@ostra/adapter-sdk";
import { postgresAuditLog, postgresChangeNotices, postgresCommandOutbox } from "@ostra/domain";
import type { SessionTimers } from "@ostra/domain";
import { connectionIdSchema, readMarkedBlocks, taskEventSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { ConnectionId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FakeModelProvider } from "../testing/fake-adapters.ts";
import { checkRun, recorded, seedTaskInCi, startLoopHarness, stateOf } from "../testing/review-loop.ts";
import type { LoopHarness, LoopPr, LoopTask } from "../testing/review-loop.ts";
import { jobContext } from "../testing/turns.ts";
import { reconciledCommentHook } from "./pr-comments.ts";
import { githubWebhookHandler, reconcileHandler } from "./pull-requests.ts";
import type { PullRequestStateDeps } from "./pull-requests.ts";

// F-044 (Q344, settled 2026-11-22: "Add them to reconcile"), on milestone 6's review loop harness:
// with GitHub's webhooks off, the reconcile's tick finds a review on the fake host and its line
// comments, and each reaches the task as its webhook would bring it: a linked member's "changes
// requested" reopens the task (F-105), a line comment asking `@ostra` steers it (F-053). A review
// the webhook brought too lands once (F-046), and the next tick reads nothing again.

let h: LoopHarness;
let connectionId: ConnectionId;
const ALICE = { userId: "1001", login: "alice" } as const;
const BODY = "Please rename the helper before this merges.";

beforeAll(async () => {
  h = await startLoopHarness();
  // With webhooks off, the host's reviews and comments are read by the reconcile.
  h.codeHost.reconcileReads = true;
  await h.db.user.update({ where: { id: h.fixture.a.admin.userId }, data: { githubUserId: ALICE.userId, githubLogin: ALICE.login } });
  await h.db.project.update({ where: { id: h.world.projectId }, data: { aiReview: false } });
  connectionId = connectionIdSchema.parse((await h.db.connection.findFirstOrThrow({ where: { organizationId: h.world.organizationId, kind: "github" } })).id);
});

afterAll(async () => {
  await h.stop();
});

beforeEach(() => {
  h.jobs.jobs.length = 0;
});

const timers: SessionTimers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: () => Promise.resolve(false) };

/** The reconcile's deps as core wires them, a comment it finds heard as its webhook's. */
const prDeps = (): PullRequestStateDeps => ({
  db: h.db,
  jobs: h.jobs,
  notices: postgresChangeNotices,
  audit: postgresAuditLog,
  clock: h.clock,
  codeHost: h.codeHost,
  secretStore: h.secretStore,
  logger: silentLogger,
  onReconciledComment: reconciledCommentHook({
    db: h.db,
    jobs: h.jobs,
    outbox: postgresCommandOutbox,
    notices: postgresChangeNotices,
    audit: postgresAuditLog,
    clock: h.clock,
    adapters: { codeHost: h.codeHost, secretStore: h.secretStore, modelProvider: new FakeModelProvider() },
    timers,
    spendCap: { capMicroUsd: 25_000_000, capTokens: 10_000_000 },
  }),
});

/** One `github.reconcile-prs` tick, as the schedule sends it every OSTRA_RECONCILE_MINUTES. */
const tick = async (): Promise<void> => {
  await reconcileHandler(prDeps())(jobContext("github.reconcile-prs", { organizationId: h.world.organizationId, connectionId }, h.logger));
};

const firstPr = (task: LoopTask): LoopPr => {
  const pr = task.prs[0];
  if (pr === undefined) throw new Error("the task has no PR");
  return pr;
};

/** A code task whose CI passed with the AI review off: waiting for a reviewer, its session idle on its warm box. */
const waitingTask = async (): Promise<LoopTask> => {
  const task = await seedTaskInCi(h);
  checkRun(h, firstPr(task), "test", "success");
  await h.drain(["ci.evaluate"]);
  h.jobs.jobs.length = 0;
  expect(await stateOf(h, task.taskId)).toBe("in_review/waiting_for_reviewer");
  return task;
};

/** A person's review on the host, as GitHub keeps it, with its line comments written as it's submitted. */
const review = (pr: LoopPr, state: "changes_requested" | "commented", comments: readonly { readonly path: string; readonly line: number; readonly body: string }[]): string => {
  h.clock.advance(1_000);
  const at = h.clock.now();
  const added = h.codeHost.reviewsAndChecks.addReview(pr.repo, pr.number, {
    userId: ALICE.userId,
    login: ALICE.login,
    isBot: false,
    state,
    commitId: pr.head,
    submittedAt: at,
    body: state === "changes_requested" ? BODY : "",
    url: `https://github.example/${pr.repo}/pull/${String(pr.number)}#pullrequestreview-${String(at)}`,
  });
  h.codeHost.ci.addPersonReview(pr.repo, pr.number, {
    reviewId: added.reviewId,
    commitId: pr.head,
    userId: ALICE.userId,
    comments: comments.map((comment) => ({
      ...comment,
      side: "new",
      login: ALICE.login,
      url: `https://github.example/${pr.repo}/pull/${String(pr.number)}#discussion_r${String(at)}`,
      createdAt: at,
      updatedAt: at,
    })),
  });
  return added.reviewId;
};

const messagesOf = async (taskId: TaskId) =>
  (await h.db.event.findMany({ where: { taskId, kind: "user.message" }, orderBy: { seq: "asc" } })).flatMap((row) => {
    const parsed = taskEventSchema.safeParse(row.payload);
    return parsed.success && parsed.data.kind === "user.message" ? [parsed.data] : [];
  });

describe("with webhooks off, the reconcile brings reviews and their line comments (F-044)", () => {
  it("F-044/c1: with webhooks off, a linked member's review requesting changes reaches the task within one tick", async () => {
    const task = await waitingTask();
    const pr = firstPr(task);
    const reviewId = review(pr, "changes_requested", [{ path: "src/index.ts", line: 5, body: "This loop never ends." }]);
    const stored = await h.db.webhookDelivery.count();
    await tick();
    expect(recorded(h, "changes.reopen")).toEqual([{ organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId, reviewId }]);
    await h.drain(["changes.reopen"]);
    expect(await stateOf(h, task.taskId)).toBe("queued");
    const messages = (await messagesOf(task.taskId)).filter((message) => message.intent === "changes-requested");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ clientMessageId: `changes-requested:${reviewId}`, memberId: h.fixture.a.admin.id, reopen: true });
    expect(messages[0]?.text).toContain(BODY);
    expect(messages[0]?.text).toContain("src/index.ts:5");
    // GitHub sent nothing.
    expect(await h.db.webhookDelivery.count()).toBe(stored);
    // The next tick has read the review already: nothing is enqueued for it again.
    h.jobs.jobs.length = 0;
    await tick();
    expect(recorded(h, "changes.reopen")).toEqual([]);
  });

  it("F-044/c1: with webhooks off, a review's line comment asking @ostra reaches the task within one tick, with its file and line", async () => {
    const task = await waitingTask();
    const pr = firstPr(task);
    const reactions = h.codeHost.reactionCalls.length;
    review(pr, "commented", [{ path: "src/app.ts", line: 42, body: "@ostra handle the empty case here" }]);
    await tick();
    const messages = (await messagesOf(task.taskId)).filter((message) => message.intent === "pr-comment");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ memberId: h.fixture.a.admin.id });
    expect(messages[0]?.text).toContain("on the file in the first block, line 42");
    expect(readMarkedBlocks(messages[0]?.text ?? "").map((block) => [block.label, block.text])).toEqual([
      ["pr-comment-location", "src/app.ts"],
      ["pr-comment", "handle the empty case here"],
    ]);
    // 👀 on the line comment, as for its webhook; and a comment review asks for no changes.
    expect(h.codeHost.reactionCalls.slice(reactions).map((call) => call.comment.kind)).toEqual(["review"]);
    expect(recorded(h, "changes.reopen")).toEqual([]);
    const received = await h.db.event.findMany({ where: { taskId: task.taskId, kind: "pr.comment_received" } });
    expect(received.map((row) => row.payload)).toMatchObject([{ login: ALICE.login, path: "src/app.ts", line: 42 }]);
    // A second tick sends nothing twice.
    await tick();
    expect((await messagesOf(task.taskId)).filter((message) => message.intent === "pr-comment")).toHaveLength(1);
  });

  it("F-046/c1: a review the webhook brought and the reconcile then finds reopens the task once", async () => {
    const task = await waitingTask();
    const pr = firstPr(task);
    const reviewId = review(pr, "changes_requested", []);
    const payload = {
      action: "submitted",
      installation: { id: 777 },
      repository: { id: `host-${pr.repo}`, full_name: pr.repo },
      pull_request: { number: pr.number, head: { sha: pr.head } },
      review: { id: reviewId, user: { id: Number(ALICE.userId), login: ALICE.login, type: "User" }, state: "changes_requested", commit_id: pr.head, submitted_at: new Date(h.clock.now()).toISOString() },
    };
    const delivered = await githubWebhookHandler(prDeps())({
      organizationId: h.world.organizationId,
      connectionId,
      deliveryId: webhookDeliveryIdSchema.parse(randomBytes(8).toString("hex")),
      event: "pull_request_review",
      payload,
      receivedAt: h.clock.now(),
      logger: silentLogger,
    });
    expect(delivered).toEqual({ outcome: "processed" });
    await h.drain(["changes.reopen"]);
    // The reconcile's tick finds the same review on the host.
    await tick();
    await h.drain(["changes.reopen"]);
    expect((await messagesOf(task.taskId)).filter((message) => message.intent === "changes-requested")).toHaveLength(1);
    expect(await h.db.taskRound.count({ where: { taskId: task.taskId, kind: "changes_requested" } })).toBe(1);
    expect(await h.db.auditEntry.count({ where: { entityId: task.taskId, action: "pr.changes-requested" } })).toBe(1);
  });
});
