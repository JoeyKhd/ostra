import { randomBytes } from "node:crypto";

import { admitQueued, dispatchTask, dispatchWaitColumns, issueTaskCredentials, jobPayloadSchemas, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox } from "@ostra/domain";
import type { DispatchTaskResult } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import { leaseEpochSchema, poolIdSchema, PROTOCOL_MINOR, runnerIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { RunnerId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildTaskSpec } from "../dispatch/task-spec.ts";
import { requeueQueuedTasks } from "../dispatch/dispatcher.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { FakeModelProvider } from "../testing/fake-adapters.ts";
import { checkRun, recorded, seedTaskInCi, startLoopHarness, stateOf } from "../testing/review-loop.ts";
import type { LoopHarness, LoopPr, LoopTask } from "../testing/review-loop.ts";
import { seedOnlineRunner } from "../testing/world.ts";

// Follow-up tasks run where their task ran (2026-11-21, ADR 0059 amended; F-069, F-014, F-100). The
// maintainer ran ostra on Windows with only a personal runner, and every AI review sat queued for
// the pools. Against Postgres and the fake code host: a code task that ran on its member's personal
// runner, its PR's CI passing, `review.start` making the review task, and the review's dispatch.

let h: LoopHarness;
let poolId: ReturnType<typeof poolIdSchema.parse>;

beforeAll(async () => {
  h = await startLoopHarness();
  // The project's review profile: the world's, on its one provider.
  await h.db.project.update({ where: { id: h.world.projectId }, data: { defaultReviewProfileId: h.world.profileId } });
  const pool =await h.db.runner.findUniqueOrThrow({ where: { id: h.runner.runnerId }, select: { poolId: true } });
  poolId = poolIdSchema.parse(pool.poolId);
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  h.jobs.jobs.length = 0;
  // Each case starts with no runner online: the harness's pool runner and every personal one.
  await h.db.runner.updateMany({ where: { organizationId: h.world.organizationId }, data: { state: "offline" } });
  await h.db.modelProvider.update({ where: { id: h.world.providerId }, data: { allowOnPersonalRunners: true } });
});

/** A member's personal runner on `host`, connected at the current protocol, with the default two slots. */
const personalRunner = async (memberId: string): Promise<RunnerRef> => {
  const runner = await seedOnlineRunner(h.db, h.world.organizationId, { kind: "personal", memberId });
  await h.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { minor: PROTOCOL_MINOR } });
  return runner;
};

const online = (runnerId: RunnerId) => h.db.runner.update({ where: { id: runnerId }, data: { state: "online" } });

const firstPr = (task: LoopTask): LoopPr => {
  const pr = task.prs[0];
  if (pr === undefined) throw new Error("the task has no PR");
  return pr;
};

/** A code task that ran on `runner`, whose CI passed: `review.start` has made its review task. */
const reviewedOn = async (runner: RunnerRef): Promise<LoopTask> => {
  const task = await seedTaskInCi(h, { runner });
  checkRun(h, firstPr(task), "test", "success");
  await h.drain(["ci.evaluate"]);
  await h.drain(["review.start"]);
  expect(await stateOf(h, task.taskId)).toBe("in_review/ai_review");
  return task;
};

const reviewTaskOf = (task: LoopTask) => h.db.task.findFirstOrThrow({ where: { reviewOfTaskId: task.taskId, kind: "review" } });

/** The review task's dispatch, as `review.start` sent it, through the domain's dispatch. */
const dispatchReview = async (task: LoopTask, epoch?: number): Promise<DispatchTaskResult> => {
  const review = await reviewTaskOf(task);
  const payload = recorded(h, "task.dispatch")
    .map((one) => jobPayloadSchemas["task.dispatch"].parse(one))
    .find((one) => one.taskId === review.id);
  if (payload === undefined) throw new Error("the review task has no dispatch");
  return h.db.$transaction((tx) =>
    dispatchTask(
      { tx, jobs: h.jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: h.clock, logger: h.logger },
      epoch === undefined ? payload : { ...payload, leaseEpoch: leaseEpochSchema.parse(epoch) },
    ),
  );
};

const waitOf = async (task: LoopTask): Promise<unknown> => (await reviewTaskOf(task)).dispatchWait;

const commandsTo = (runnerId: RunnerId) => h.db.command.count({ where: { runnerId, kind: "dispatch" } });

describe("follow-up tasks run where their task ran (ADR 0059 amended 2026-11-21)", () => {
  it("F-069/c5: an AI review of a code task that ran on its member's personal runner runs there when no pool runner is online, and on no other member's", async () => {
    const mine = await personalRunner(h.fixture.a.member.id);
    const theirs = await personalRunner(h.fixture.a.insider.id);
    const task = await reviewedOn(mine);
    const review = await reviewTaskOf(task);
    // Today's rows: started by ostra, for the code task's member, with no runner of its own.
    expect(review).toMatchObject({ kind: "review", creatorMemberId: h.fixture.a.member.id, runnerId: null, state: "queued" });

    const offered = await dispatchReview(task);
    expect(offered).toMatchObject({ ok: true, runnerId: mine.runnerId });
    const box = await h.db.box.findFirstOrThrow({ where: { taskId: review.id } });
    expect(box).toMatchObject({ runnerId: mine.runnerId, executor: "host" });
    expect(box.id).not.toBe(task.boxId);
    expect((await h.db.task.findUniqueOrThrow({ where: { id: review.id } })).dispatchWait).toBeNull();
    // The other member's runner, online with room, was offered nothing.
    expect(await commandsTo(theirs.runnerId)).toBe(0);
  });

  it("F-069/c5: while the runner its task ran on is offline or full, it waits for it or a pool runner, says so, and goes to no other member's runner", async () => {
    const mine = await personalRunner(h.fixture.a.member.id);
    const task = await reviewedOn(mine);
    await h.db.runner.update({ where: { id: mine.runnerId }, data: { state: "offline" } });
    const theirs = await personalRunner(h.fixture.a.insider.id);
    const name = (await h.db.runner.findUniqueOrThrow({ where: { id: mine.runnerId } })).name;

    // Offline: no runner anywhere takes it, and the reason names the runner it waits for.
    expect(await dispatchReview(task)).toMatchObject({ ok: false, error: "no-runner" });
    expect(await waitOf(task)).toEqual({ code: "follow-up-waits", runner: { id: mine.runnerId, name }, personal: "offline" });
    expect(await commandsTo(theirs.runnerId)).toBe(0);

    // Online but full: its code task's box and another hold both its slots.
    await online(mine.runnerId);
    const other = await seedTaskInCi(h, { runner: mine });
    expect(await dispatchReview(task)).toMatchObject({ ok: false, error: "no-runner" });
    expect(await waitOf(task)).toEqual({ code: "follow-up-waits", runner: { id: mine.runnerId, name }, personal: "busy" });

    // Outdated: a runner too old for review tasks (minor 5) waits for an update.
    await h.db.box.updateMany({ where: { taskId: other.taskId }, data: { state: "stopped" } });
    await h.db.runnerPresence.update({ where: { runnerId: mine.runnerId }, data: { minor: 4 } });
    expect(await dispatchReview(task)).toMatchObject({ ok: false, error: "no-runner" });
    expect(await waitOf(task)).toEqual({ code: "follow-up-waits", runner: { id: mine.runnerId, name }, personal: "outdated" });

    // A slot frees and it's current again: the next dispatch goes there.
    await h.db.runnerPresence.update({ where: { runnerId: mine.runnerId }, data: { minor: PROTOCOL_MINOR } });
    expect(await dispatchReview(task)).toMatchObject({ ok: true, runnerId: mine.runnerId });
    expect(await commandsTo(theirs.runnerId)).toBe(0);
  });

  it("F-069/c5: a pool runner online with room still takes it first, as every task of the project", async () => {
    const mine = await personalRunner(h.fixture.a.member.id);
    const task = await reviewedOn(mine);
    await online(h.runner.runnerId);
    expect(await dispatchReview(task)).toMatchObject({ ok: true, runnerId: h.runner.runnerId });
    expect(await commandsTo(mine.runnerId)).toBe(0);
  });

  it("F-069/c5, F-090/c4: on the personal runner the review stays read-only: a review task's spec, whose git proxy only fetches, and a repo token that only reads", async () => {
    const mine = await personalRunner(h.fixture.a.member.id);
    const task = await reviewedOn(mine);
    const offered = await dispatchReview(task);
    if (!offered.ok) throw new Error(`the review's dispatch failed: ${offered.message}`);
    expect(offered.runnerId).toBe(mine.runnerId);
    const review = await reviewTaskOf(task);
    const reviewTaskId = taskIdSchema.parse(review.id);

    // The runner's git proxy refuses every push for a review task (`task-host.test.ts`, F-090/c4): the spec says it is one.
    const spec = await buildTaskSpec({ db: h.db, codeHost: h.codeHost, secretStore: h.secretStore }, { taskId: reviewTaskId, runnerId: mine.runnerId, leaseEpoch: offered.leaseEpoch });
    if (!spec.ok) throw new Error(`no spec: ${spec.message}`);
    expect(spec.spec.kind).toBe("review");
    expect(spec.spec.review?.codeTaskId).toBe(task.taskId);
    expect(spec.spec.tools).toEqual(["review", "memory"]);

    // And the code host refuses one too: the token minted for the member's machine can only read.
    const minted = h.codeHost.minted.length;
    const credentials = await h.db.$transaction((tx) =>
      issueTaskCredentials(
        { tx, audit: postgresAuditLog, clock: h.clock, adapters: { codeHost: h.codeHost, secretStore: h.secretStore, modelProvider: new FakeModelProvider() }, mcpToken: () => randomBytes(16).toString("hex") },
        { taskId: reviewTaskId, leaseEpoch: offered.leaseEpoch, runnerId: mine.runnerId },
      ),
    );
    expect(credentials.ok).toBe(true);
    expect(h.codeHost.minted.slice(minted).map((one) => one.permissions)).toEqual([{ contents: "read", metadata: "read" }]);
  });

  it("F-069/c5: with its provider not allowed on personal runners, or an outside task's review, it waits for the pools only", async () => {
    const mine = await personalRunner(h.fixture.a.member.id);
    const task = await reviewedOn(mine);
    const name = (await h.db.runner.findUniqueOrThrow({ where: { id: mine.runnerId } })).name;

    // The admin's "allow on personal runners" is off for the session's provider.
    await h.db.modelProvider.update({ where: { id: h.world.providerId }, data: { allowOnPersonalRunners: false } });
    expect(await dispatchReview(task)).toMatchObject({ ok: false, error: "no-runner" });
    expect(await waitOf(task)).toEqual({ code: "follow-up-waits", runner: { id: mine.runnerId, name }, personal: "not-allowed" });
    expect(await commandsTo(mine.runnerId)).toBe(0);
    // A pool runner still takes it.
    await online(h.runner.runnerId);
    expect(await dispatchReview(task)).toMatchObject({ ok: true, runnerId: h.runner.runnerId });

    // An outside task (F-040) never runs on a personal runner, and neither does its review.
    await h.db.runner.update({ where: { id: h.runner.runnerId }, data: { state: "offline" } });
    await h.db.modelProvider.update({ where: { id: h.world.providerId }, data: { allowOnPersonalRunners: true } });
    const outside = await reviewedOn(mine);
    await h.db.task.update({ where: { id: outside.taskId }, data: { poolOnly: true } });
    expect(await dispatchReview(outside)).toMatchObject({ ok: false, error: "no-runner" });
    expect(await waitOf(outside)).toEqual({ code: "no-runner-online" });
    expect(await h.db.lease.count({ where: { task: { reviewOfTaskId: outside.taskId } } })).toBe(0);
  });

  it("F-069/c5: a review left queued for the pools before this change is picked up by the queue's sweep, with pools or without", async () => {
    const mine = await personalRunner(h.fixture.a.member.id);
    await h.db.runner.update({ where: { id: mine.runnerId }, data: { state: "offline" } });
    const task = await reviewedOn(mine);
    const review = await reviewTaskOf(task);
    // As the old dispatch left it: the pools' reason, and no job of its own in flight.
    await h.db.task.update({ where: { id: review.id }, data: { ...dispatchWaitColumns({ code: "no-runner-online" }), queuedAt: new Date(h.clock.now()) } });
    h.jobs.jobs.length = 0;
    await online(mine.runnerId);

    const jobs = createJobs({ databaseUrl: h.test.url, role: "worker", pollingIntervalSeconds: 0.5 });
    await jobs.start();
    try {
      // The sweep asks the project's pool to admit its queue; the admission's walk gives it the member's runner.
      await requeueQueuedTasks({ db: h.db, jobs });
      expect(await jobs.find("queue.admit", { organizationId: h.world.organizationId, poolId })).toHaveLength(1);
      const admitted = await admitQueued({ db: h.db, jobs: h.jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: h.clock, logger: h.logger }, { organizationId: h.world.organizationId, poolId });
      expect(admitted.admitted).toContainEqual({ taskId: review.id, runnerId: mine.runnerId, leaseEpoch: leaseEpochSchema.parse(review.leaseEpoch + 1) });

      // In a project with no pool at all, nothing walks a queue: the sweep sends its dispatch.
      const second = await reviewedOn(mine);
      const secondReview = await reviewTaskOf(second);
      // The first review and its code task are done with the runner's slots.
      await h.db.box.updateMany({ where: { taskId: { in: [review.id, task.taskId] } }, data: { state: "stopped" } });
      await h.db.task.update({ where: { id: secondReview.id }, data: dispatchWaitColumns({ code: "no-runner-online" }) });
      const links = await h.db.projectPool.findMany({ where: { projectId: h.world.projectId } });
      await h.db.projectPool.deleteMany({ where: { projectId: h.world.projectId } });
      try {
        await requeueQueuedTasks({ db: h.db, jobs });
        const session = await h.db.session.findFirstOrThrow({ where: { taskId: secondReview.id, state: "starting" } });
        const payload = { organizationId: h.world.organizationId, taskId: taskIdSchema.parse(secondReview.id), sessionId: sessionIdSchema.parse(session.id), leaseEpoch: leaseEpochSchema.parse(secondReview.leaseEpoch + 1) };
        expect(await jobs.find("task.dispatch", payload)).toHaveLength(1);
        const offered = await h.db.$transaction((tx) => dispatchTask({ tx, jobs: h.jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: h.clock, logger: h.logger }, payload));
        expect(offered).toMatchObject({ ok: true, runnerId: runnerIdSchema.parse(mine.runnerId) });
      } finally {
        await h.db.projectPool.createMany({ data: links });
      }
    } finally {
      await jobs.stop({ graceful: false, timeoutMs: 2_000 });
    }
  });
});
