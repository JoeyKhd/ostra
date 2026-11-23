import { randomBytes } from "node:crypto";

import { acceptOffer, dispatchTask, jobPayloadSchemas, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, reopenTask, submitReview } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { blobIdSchema, clientMessageIdSchema, memberIdSchema, segmentIdSchema, sessionIdSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { Finding, RepoId, SessionId, TaskEventOf, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RunnerRef } from "../gateway/context.ts";
import { sessionEndedHandler } from "../reactions/session-end.ts";
import { FakeModelProvider } from "../testing/fake-adapters.ts";
import { checkRun, recorded, seedTaskInCi, startLoopHarness, stateOf } from "../testing/review-loop.ts";
import type { LoopHarness, LoopPr, LoopTask } from "../testing/review-loop.ts";
import { drive, jobContext } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { recordTaskPrHead } from "./ci.ts";

// The stuck AI review (the maintainer, 2026-11-22: "this ai review never stops btw"), against
// Postgres, core's real ingest and the session-end job. A review task left `running` only by
// posting its findings, so a turn that ended with nothing new to hand in (a member's message to a
// review already posted, a round voided by a moved head) kept it running forever: its session idled
// out, its lease ended, and its code task said "AI review: running" with nothing running. A review
// task now rests as done when its turn ends with its round's review in, or with nothing left to
// review; a round whose session ends without its review needs its driver, one click from carrying
// on; and a session that crashes under it (a runner's restart) needs its driver too.

let h: LoopHarness;

beforeAll(async () => {
  h = await startLoopHarness();
  const model = await h.db.model.create({ data: { organizationId: h.world.organizationId, providerId: h.world.providerId, endpointModelId: "review-model-rests" } });
  const profile = await h.db.agentProfile.create({
    data: { organizationId: h.world.organizationId, name: "Review", adapter: "opencode", modelId: model.id, builtIn: true, builtInKind: "review" },
  });
  await h.db.project.update({ where: { id: h.world.projectId }, data: { defaultReviewProfileId: profile.id } });
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  h.jobs.jobs.length = 0;
  h.records.length = 0;
  await h.db.project.update({ where: { id: h.world.projectId }, data: { aiReview: true } });
});

const firstPr = (task: LoopTask): LoopPr => {
  const pr = task.prs[0];
  if (pr === undefined) throw new Error("the task has no PR");
  return pr;
};

type Reviewing = { readonly task: LoopTask; readonly pr: LoopPr; readonly reviewTaskId: TaskId; readonly review: DrivenTask };

/** Offers the review task's queued dispatch for `sessionId` to the harness's runner, which accepts it: the task is preparing. */
const acceptDispatch = async (reviewTaskId: TaskId, sessionId: SessionId): Promise<DrivenTask> => {
  const payload = recorded(h, "task.dispatch")
    .map((one) => jobPayloadSchemas["task.dispatch"].parse(one))
    .find((one) => one.taskId === reviewTaskId && one.sessionId === sessionId);
  if (payload === undefined) throw new Error("the review task has no dispatch for the session");
  h.jobs.jobs.splice(
    h.jobs.jobs.findIndex((job) => job.job === "task.dispatch" && jobPayloadSchemas["task.dispatch"].parse(job.payload).sessionId === sessionId),
    1,
  );
  const offered = await h.db.$transaction((tx) => dispatchTask({ tx, jobs: h.jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: h.clock }, payload));
  if (!offered.ok) throw new Error(`the review's dispatch failed: ${offered.message}`);
  const command = await h.db.command.findUniqueOrThrow({ where: { id: offered.commandId } });
  const runner: RunnerRef = { runnerId: offered.runnerId, organizationId: h.world.organizationId };
  const accepted = await h.db.$transaction((tx) =>
    acceptOffer({ tx, jobs: h.jobs, notices: postgresChangeNotices, clock: h.clock, logger: h.logger }, { runnerId: runner.runnerId, commandId: offered.commandId, seq: command.seq, result: "accepted" }),
  );
  if (!accepted.ok) throw new Error(`the review's offer wasn't accepted: ${accepted.error}`);
  return drive(h.ingest, { taskId: reviewTaskId, sessionId, organizationId: h.world.organizationId }, runner, offered.leaseEpoch);
};

/** A code task whose CI passed, in its AI review, the review task's first turn started on the harness's runner. */
const reviewing = async (): Promise<Reviewing> => {
  const task = await seedTaskInCi(h);
  const pr = firstPr(task);
  checkRun(h, pr, "test", "success");
  await h.drain(["ci.evaluate"]);
  await h.drain(["review.start"]);
  expect(await stateOf(h, task.taskId)).toBe("in_review/ai_review");
  const row = await h.db.task.findFirstOrThrow({ where: { reviewOfTaskId: task.taskId, kind: "review" } });
  const reviewTaskId = taskIdSchema.parse(row.id);
  const session = await h.db.session.findFirstOrThrow({ where: { taskId: reviewTaskId }, orderBy: { startedAt: "desc" } });
  const review = await acceptDispatch(reviewTaskId, sessionIdSchema.parse(session.id));
  await review.send({ kind: "turn.started", turnId: turnIdSchema.parse(`turn-${randomBytes(3).toString("hex")}`) });
  expect(await stateOf(h, reviewTaskId)).toBe("running");
  h.codeHost.ci.setDiff(pr.repo, pr.number, [{ path: "src/index.ts", new: [{ start: 1, end: 20 }], old: [] }]);
  return { task, pr, reviewTaskId, review };
};

const nit = (repoId: RepoId): Finding => ({ repoId, path: "src/index.ts", line: 5, side: "new", severity: "nit", title: "A clearer name", body: "`x` says little.", suggestion: null });

/** `submit_review` as its endpoint calls it. */
const submit = (reviewTaskId: TaskId, findings: readonly Finding[]) =>
  h.db.$transaction((tx) =>
    submitReview({ tx, jobs: h.jobs, notices: postgresChangeNotices, clock: h.clock, logger: h.logger }, { organizationId: h.world.organizationId, reviewTaskId, review: { summary: "One small thing.", findings: [...findings] } }),
  );

/** The end of a turn as a minor-9 runner sends it for a read-only kind: its last words, then its save, with no repos. */
const turnEnds = (task: DrivenTask, ordinal: number) => {
  const turnId = turnIdSchema.parse(`turn-end-${randomBytes(3).toString("hex")}`);
  return task.send(
    { kind: "turn.started", turnId },
    { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse(`s-${randomBytes(3).toString("hex")}`), text: "The review I handed in still stands." },
    { kind: "turn.ended", turnId, stopReason: "end_turn" },
    { kind: "session.saved", turnOrdinal: ordinal, repos: [], archive: { blobId: blobIdSchema.parse(`blob-archive-${randomBytes(3).toString("hex")}`), size: 100, sha256: "a".repeat(64) } },
  );
};

/** The idle timer ends the session (`session.ended`), and core's `task.session-ended` job runs. */
const sessionEnds = async (task: DrivenTask, repos: TaskEventOf<"session.ended">["repos"] = []): Promise<void> => {
  await task.send({ kind: "session.ended", outcome: "without-changes", repos });
  await sessionEndJobRuns(task);
};

/** Core's `task.session-ended` job, for the session's stored end. */
const sessionEndJobRuns = async (task: DrivenTask): Promise<void> => {
  const ended = await h.db.event.findFirstOrThrow({ where: { taskId: task.taskId, sessionId: task.sessionId, kind: "session.ended" }, orderBy: { seq: "desc" } });
  await sessionEndedHandler({
    db: h.db,
    jobs: h.jobs,
    notices: postgresChangeNotices,
    audit: postgresAuditLog,
    clock: h.clock,
    adapters: { codeHost: h.codeHost, secretStore: h.secretStore, modelProvider: new FakeModelProvider() },
    publicUrl: "http://localhost:3000",
    logger: h.logger,
  })(jobContext("task.session-ended", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: ended.seq }, h.logger));
};

const scope = (): MemberScope => ({ organizationId: h.world.organizationId, memberId: memberIdSchema.parse(h.fixture.a.member.id), role: "member", projectRoles: new Map() });

/** A member's reopen of the review task: with words, or the one click from a stall or a crash. */
const reopen = async (reviewTaskId: TaskId, text?: string): Promise<SessionId> => {
  const reopened = await h.db.$transaction((tx) =>
    reopenTask(
      { tx, scope: scope(), jobs: h.jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: h.clock },
      { taskId: reviewTaskId, clientMessageId: clientMessageIdSchema.parse(`reopen-${randomBytes(4).toString("hex")}`), ...(text === undefined ? {} : { text }) },
    ),
  );
  if (!reopened.ok) throw new Error(`the reopen was refused: ${reopened.error}`);
  return reopened.sessionId;
};

const openItemsOf = async (taskId: string) => (await h.db.needsYouItem.findMany({ where: { taskId, state: "open" }, select: { reason: true, audience: true } })).map((item) => `${item.reason}/${item.audience}`);

describe("the stuck AI review: a review task never stays running with nothing to hand in", () => {
  it("F-100/c6: a member's message to a review already posted is answered, then the review rests as done, so its code task shows the round's result", async () => {
    const { task, pr, reviewTaskId, review } = await reviewing();
    const handedIn = await submit(reviewTaskId, [nit(pr.repoId)]);
    if (!handedIn.ok) throw new Error(handedIn.message);
    await turnEnds(review, 1);
    // Handed in, not yet posted: the post is what ends the round.
    expect(await stateOf(h, reviewTaskId)).toBe("running");
    await h.drain(["review.post"]);
    expect(await stateOf(h, reviewTaskId)).toBe("done");
    expect(await stateOf(h, task.taskId)).toBe("in_review/waiting_for_reviewer");

    // The member asks the review agent something: the task reopens on a session of its own.
    const sessionId = await reopen(reviewTaskId, "Why is that only a nit?");
    const followUp = await acceptDispatch(reviewTaskId, sessionId);
    // Its turn answers, and hands in nothing new (a repeat is answered `already`; the round is over).
    await turnEnds(followUp, 1);
    expect(await stateOf(h, reviewTaskId)).toBe("done");
    // The round's review stands as posted, once.
    expect(await h.db.reviewRun.findFirstOrThrow({ where: { reviewTaskId }, orderBy: { round: "desc" } })).toMatchObject({ state: "posted", nits: 1 });
    expect(h.codeHost.ci.reviews(pr.repo, pr.number)).toHaveLength(1);

    // The idle timer ends the session: the review stays done, nothing waits on it, its lease ends.
    await sessionEnds(followUp);
    expect(await stateOf(h, reviewTaskId)).toBe("done");
    expect(await openItemsOf(reviewTaskId)).toEqual([]);
    expect(await h.db.lease.count({ where: { taskId: reviewTaskId, state: "active" } })).toBe(0);
    expect(await stateOf(h, task.taskId)).toBe("in_review/waiting_for_reviewer");
  });

  it("F-100/c6: a review whose PR's head moved under it rests as done once its turn ends: the void round has nothing left to hand in", async () => {
    const { task, pr, reviewTaskId, review } = await reviewing();
    await recordTaskPrHead(
      { db: h.db, jobs: h.jobs, notices: postgresChangeNotices, adapters: { codeHost: h.codeHost, secretStore: h.secretStore } },
      { organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId, headSha: "d".repeat(40) },
    );
    expect(await stateOf(h, task.taskId)).toBe("in_review/ci_running");
    expect(await h.db.reviewRun.findFirstOrThrow({ where: { reviewTaskId }, orderBy: { round: "desc" } })).toMatchObject({ state: "failed" });
    // The agent's hand-in for the old head is refused, and its turn ends.
    expect(await submit(reviewTaskId, [nit(pr.repoId)])).toMatchObject({ ok: false, error: "not-in-review" });
    await turnEnds(review, 1);
    expect(await stateOf(h, reviewTaskId)).toBe("done");
    await sessionEnds(review);
    expect(await stateOf(h, reviewTaskId)).toBe("done");
  });

  it("F-100/c6: a round whose session ends without its review needs the driver, and one click carries it on to a hand-in that counts", async () => {
    const { task, pr, reviewTaskId, review } = await reviewing();
    // The agent ends its turn without calling submit_review: its box stays warm, so a message can still reach it.
    await turnEnds(review, 1);
    expect(await stateOf(h, reviewTaskId)).toBe("running");
    // The idle timer ends the session with the round's review never handed in.
    await sessionEnds(review);
    expect(await stateOf(h, reviewTaskId)).toBe("needs_you/stalled");
    expect(await openItemsOf(reviewTaskId)).toEqual(["stalled/driver"]);
    expect(await h.db.lease.count({ where: { taskId: reviewTaskId, state: "active" } })).toBe(0);
    // Its code task still waits for the round.
    expect(await stateOf(h, task.taskId)).toBe("in_review/ai_review");

    // One click: the review carries on in a fresh session, and its hand-in is the round's.
    const sessionId = await reopen(reviewTaskId);
    expect(await openItemsOf(reviewTaskId)).toEqual([]);
    const again = await acceptDispatch(reviewTaskId, sessionId);
    await again.send({ kind: "turn.started", turnId: turnIdSchema.parse("turn-carry-on") });
    const handedIn = await submit(reviewTaskId, [nit(pr.repoId)]);
    expect(handedIn).toMatchObject({ ok: true });
    await h.drain(["review.post"]);
    expect(await stateOf(h, reviewTaskId)).toBe("done");
    expect(await stateOf(h, task.taskId)).toBe("in_review/waiting_for_reviewer");
  });

  it("F-047/c1: a runner restarting under a running review session marks it crashed for its driver, and one click reopens it to a hand-in that counts", async () => {
    const { task, pr, reviewTaskId, review } = await reviewing();
    // The runner's restart: the agent didn't survive, and the runner says so for the session.
    await review.send({ kind: "session.crashed", error: "the runner restarted while the session was running" });
    expect(await stateOf(h, reviewTaskId)).toBe("needs_you/crashed");
    expect(await openItemsOf(reviewTaskId)).toEqual(["crashed/driver"]);
    expect(await h.db.session.findUniqueOrThrow({ where: { id: review.sessionId } })).toMatchObject({ state: "crashed" });
    expect(await h.db.lease.count({ where: { taskId: reviewTaskId, state: "active" } })).toBe(0);
    expect(await stateOf(h, task.taskId)).toBe("in_review/ai_review");

    const sessionId = await reopen(reviewTaskId);
    const again = await acceptDispatch(reviewTaskId, sessionId);
    await again.send({ kind: "turn.started", turnId: turnIdSchema.parse("turn-after-crash") });
    expect(await submit(reviewTaskId, [nit(pr.repoId)])).toMatchObject({ ok: true });
    await h.drain(["review.post"]);
    expect(await stateOf(h, reviewTaskId)).toBe("done");
    expect(await stateOf(h, task.taskId)).toBe("in_review/waiting_for_reviewer");
    // A session that dies after the round is done changes nothing.
    await again.send({ kind: "session.crashed", error: "the runner restarted while the session was running" });
    expect(await stateOf(h, reviewTaskId)).toBe("done");
    expect(await openItemsOf(reviewTaskId)).toEqual([]);
  });

  it("F-047/c1, F-100/c6: a runner restarting while the review waits between turns ends its session as an idle stop, and the round it still owes needs its driver as stalled", async () => {
    const { task, reviewTaskId, review } = await reviewing();
    // The agent ends its turn without its review: the session is idle, its box warm.
    await turnEnds(review, 1);
    expect(await stateOf(h, reviewTaskId)).toBe("running");
    // The runner restarts: no turn was in progress, so the session ends as its idle timer would.
    await review.send({ kind: "session.crashed", error: "the runner restarted while the session was running" });
    expect(await h.db.event.count({ where: { taskId: reviewTaskId, kind: "session.crashed" } })).toBe(0);
    await sessionEndJobRuns(review);
    expect(await h.db.session.findUniqueOrThrow({ where: { id: review.sessionId } })).toMatchObject({ state: "ended" });
    expect(await stateOf(h, reviewTaskId)).toBe("needs_you/stalled");
    expect(await openItemsOf(reviewTaskId)).toEqual(["stalled/driver"]);
    expect(await h.db.lease.count({ where: { taskId: reviewTaskId, state: "active" } })).toBe(0);
    expect(await stateOf(h, task.taskId)).toBe("in_review/ai_review");
  });
});
