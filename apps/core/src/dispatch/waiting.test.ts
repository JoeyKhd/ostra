import { randomUUID } from "node:crypto";

import { silentLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { dispatchTask, holdProviderInTx, postgresChangeNotices, postgresCommandOutbox, systemClock, waitingFor } from "@ostra/domain";
import type { DispatchWait, Waiting } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import type { CommandSeq, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { dispatchPayload, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";
import { applyOfferResultsInTx, offerTimeoutHandler } from "./dispatcher.ts";
import type { DispatcherDeps } from "./dispatcher.ts";

// Milestone 2's ticket 43 (Q132): why a queued task waits, stored by the real paths that decide it
// (the dispatch, a runner's answer, the offer timeout) as a code with its values, and read back as
// `tasks.get` and the task list read it (`waitingFor`). The router's half is
// `packages/api/src/routers/tasks-waiting.test.ts`.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let deps: DispatcherDeps;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() }, fixture.a.organization.id, fixture.a.openProject.id);
  deps = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger: silentLogger };
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const dispatch = (task: QueuedTask, epoch = 1) =>
  test.db.$transaction((tx) =>
    dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger: silentLogger }, dispatchPayload(task, epoch)),
  );

/** What `tasks.get` reads: the row's reason, and its active lease with the runner's name. */
const waitingOf = async (taskId: TaskId): Promise<Waiting> => {
  const task = await test.db.task.findUniqueOrThrow({ where: { id: taskId } });
  const lease = await test.db.lease.findFirst({ where: { taskId, state: "active" }, include: { runner: { select: { id: true, name: true } } } });
  return waitingFor(task, lease);
};

const storedReason = async (taskId: TaskId): Promise<unknown> => (await test.db.task.findUniqueOrThrow({ where: { id: taskId } })).dispatchWait;

const expectWaiting = async (taskId: TaskId, reason: DispatchWait): Promise<void> => {
  expect(await storedReason(taskId)).toEqual(reason);
  expect(await waitingOf(taskId)).toEqual({ kind: "no-runner", reason });
};

const ourRunner = () => seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id });

describe("a ticket task waits for its rendered ticket", () => {
  it("F-064: a dispatch before the ticket's prompt is rendered offers nothing, and the one after it offers the task", async () => {
    const runner = await ourRunner();
    const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    // As `tasks.startFromTicket` leaves it: a ticket task whose prompt `ticket.fetch-context` writes.
    await test.db.task.update({ where: { id: task.taskId }, data: { source: "ticket", ticketKey: "OST-1", prompt: null } });
    // The requeue sweep's dispatch, ahead of the render (milestone 3's demo: the agent got no ticket).
    expect(await dispatch(task)).toMatchObject({ ok: false, error: "stale" });
    expect(await test.db.lease.count({ where: { taskId: task.taskId } })).toBe(0);
    expect(await test.db.command.count({ where: { taskId: task.taskId } })).toBe(0);
    // The render writes the prompt, and its own dispatch offers the task.
    await test.db.task.update({ where: { id: task.taskId }, data: { prompt: "Set releaseName in config/settings.json" } });
    expect(await dispatch(task)).toMatchObject({ ok: true, runnerId: runner.runnerId });
  });
});

describe("why a queued task waits (Q132)", () => {
  it("F-014: a new task waits for nothing yet, and an open offer reads as offered, with the runner's name", async () => {
    const runner = await ourRunner();
    const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    expect(await waitingOf(task.taskId)).toBeNull();
    const before = Date.now();
    expect(await dispatch(task)).toMatchObject({ ok: true, runnerId: runner.runnerId });
    const name = (await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).name;
    const waiting = await waitingOf(task.taskId);
    const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, state: "active" } });
    expect(waiting).toEqual({ kind: "offered", runner: { id: runner.runnerId, name }, since: lease.grantedAt.getTime() });
    expect(lease.grantedAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    // The offer going out cleared any earlier reason.
    expect(await storedReason(task.taskId)).toBeNull();
  });

  it("F-014: stores and returns no-model, provider-held and provider-cap", async () => {
    const runner = await ourRunner();
    const noModel = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    await test.db.session.update({ where: { id: noModel.sessionId }, data: { agentProfileId: null } });
    expect(await dispatch(noModel)).toMatchObject({ ok: false, error: "no-runner" });
    await expectWaiting(noModel.taskId, { code: "no-model" });

    const until = new Date(Date.now() + 60_000);
    const held = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    await test.db.$transaction((tx) => holdProviderInTx(tx, world.organizationId, world.providerId, until));
    try {
      expect(await dispatch(held)).toMatchObject({ ok: false, error: "no-runner" });
      await expectWaiting(held.taskId, { code: "provider-held", until: until.getTime() });
    } finally {
      await test.db.modelProvider.update({ where: { id: world.providerId }, data: { dispatchHeldUntil: null } });
    }

    // One session at once, and another task of the provider holds it.
    const busy = await seedQueuedTask(test.db, world, fixture.a.member, (await ourRunner()).runnerId);
    expect(await dispatch(busy)).toMatchObject({ ok: true });
    await test.db.modelProvider.update({ where: { id: world.providerId }, data: { sessionsAtOnce: 1 } });
    try {
      const capped = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
      expect(await dispatch(capped)).toMatchObject({ ok: false, error: "no-runner" });
      await expectWaiting(capped.taskId, { code: "provider-cap", cap: 1 });
      // Milestone 1's sentence is still written beside it, for one release.
      expect((await test.db.task.findUniqueOrThrow({ where: { id: capped.taskId } })).dispatchNote).toContain("cap of 1");
    } finally {
      await test.db.modelProvider.update({ where: { id: world.providerId }, data: { sessionsAtOnce: null } });
    }
  });

  it("F-014: stores and returns personal-runner-not-allowed, personal-runner-unavailable and no-runner-online", async () => {
    const runner = await ourRunner();
    await test.db.modelProvider.update({ where: { id: world.providerId }, data: { allowOnPersonalRunners: false } });
    try {
      const notAllowed = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
      expect(await dispatch(notAllowed)).toMatchObject({ ok: false, error: "no-runner" });
      await expectWaiting(notAllowed.taskId, { code: "personal-runner-not-allowed" });
    } finally {
      await test.db.modelProvider.update({ where: { id: world.providerId }, data: { allowOnPersonalRunners: true } });
    }

    await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { disconnectedAt: new Date() } });
    const offline = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    expect(await dispatch(offline)).toMatchObject({ ok: false, error: "no-runner" });
    await expectWaiting(offline.taskId, { code: "personal-runner-unavailable" });
    // A revoked one is unavailable too.
    const revoked = await ourRunner();
    await test.db.runner.update({ where: { id: revoked.runnerId }, data: { state: "revoked", revokedAt: new Date() } });
    const onRevoked = await seedQueuedTask(test.db, world, fixture.a.member, revoked.runnerId);
    expect(await dispatch(onRevoked)).toMatchObject({ ok: false, error: "no-runner" });
    await expectWaiting(onRevoked.taskId, { code: "personal-runner-unavailable" });

    // A pool task, and no pool of the project has a runner online.
    const pool = await test.db.runnerPool.create({ data: { organizationId: fixture.a.organization.id, name: "empty" }, select: { id: true } });
    await test.db.projectPool.create({ data: { organizationId: fixture.a.organization.id, projectId: world.projectId, poolId: pool.id } });
    try {
      const pooled = await seedQueuedTask(test.db, world, fixture.a.member, null);
      expect(await dispatch(pooled)).toMatchObject({ ok: false, error: "no-runner" });
      await expectWaiting(pooled.taskId, { code: "no-runner-online" });
    } finally {
      await test.db.projectPool.deleteMany({ where: { poolId: pool.id } });
    }
  });

  it("F-014: an accepted, a declined and a timed-out offer each change it", async () => {
    const runner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 3);
    const accepted = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    const declined = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    const timedOut = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    const offers = await Promise.all([dispatch(accepted), dispatch(declined), dispatch(timedOut)]);
    for (const task of [accepted, declined, timedOut]) {
      expect(await waitingOf(task.taskId)).toMatchObject({ kind: "offered", runner: { id: runner.runnerId } });
    }
    const [a, d] = offers;
    if (!a.ok || !d.ok) {
      throw new Error("a dispatch failed");
    }
    const seqOf = async (commandId: string): Promise<CommandSeq> => (await test.db.command.findUniqueOrThrow({ where: { id: commandId } })).seq;
    await test.db.$transaction(async (tx) => {
      await applyOfferResultsInTx(deps, tx, runner, [
        { commandId: a.commandId, seq: await seqOf(a.commandId), kind: "dispatch", body: {}, taskId: accepted.taskId, result: "accepted", reason: null },
        { commandId: d.commandId, seq: await seqOf(d.commandId), kind: "dispatch", body: {}, taskId: declined.taskId, result: "rejected", reason: "no-capacity" },
      ]);
    });
    // Accepted: it is preparing, and waits on nothing.
    expect((await test.db.task.findUniqueOrThrow({ where: { id: accepted.taskId } })).state).toBe("preparing");
    expect(await waitingOf(accepted.taskId)).toBeNull();
    await expectWaiting(declined.taskId, { code: "offer-declined" });

    await offerTimeoutHandler(deps)({
      job: "task.offer-timeout",
      jobId: jobIdSchema.parse(randomUUID()),
      key: null,
      retryCount: 0,
      payload: { organizationId: timedOut.organizationId, taskId: timedOut.taskId, leaseEpoch: 1 },
      logger: silentLogger,
    });
    await expectWaiting(timedOut.taskId, { code: "offer-timed-out" });
    // The next offer clears it again.
    expect(await dispatch(timedOut, 2)).toMatchObject({ ok: true });
    expect(await waitingOf(timedOut.taskId)).toMatchObject({ kind: "offered" });
    expect(await storedReason(timedOut.taskId)).toBeNull();
  });
});
