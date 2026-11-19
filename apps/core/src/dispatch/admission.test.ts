import { isDeepStrictEqual } from "node:util";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  admitQueued,
  cancelQueuedTask,
  dispatchTask,
  ensureBoxSizes,
  poolQueueInTx,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  queueTask,
  recordRunnerReport,
  requeueTaskInTx,
  revokeRunner,
  systemClock,
  TASK_BUSY,
} from "@ostra/domain";
import type { AdmitDeps, MemberScope } from "@ostra/domain";
import { seedPool, seedQueuedTask as seedQueued, seedRunner } from "@ostra/domain/testing";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { commandIdSchema, commandSeqSchema, leaseEpochSchema, memberIdSchema, sessionIdSchema } from "@ostra/protocol";
import type { OrganizationId, PoolId, ProjectId, RunnerCapabilities, RunnerId, SessionId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { applyOfferResultsInTx } from "./dispatcher.ts";

// Ticket 13 (F-067, F-095, ADR 0059): capacity, the pool queue and its admission, through the real
// dispatch against Postgres. Every count is read back from `Box` rows.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let organizationId: OrganizationId;
let projectA: ProjectId;
let projectB: ProjectId;
const records: LogRecord[] = [];
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const adapters = { codeHost, secretStore, modelProvider: new FakeModelProvider() };
const logger = createLogger((record) => records.push(record));

const dockerCapabilities: RunnerCapabilities = { isolation: "container", services: true, boxSizes: true, snapshots: "image", registry: "optional", nodeWait: false };

const deps = (db: Db = test.db): AdmitDeps => ({ db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger });

const admit = (poolId: PoolId, db: Db = test.db) => admitQueued(deps(db), { organizationId, poolId });

const scopeOf = (member: SeededMember, role: "admin" | "member"): MemberScope => ({
  organizationId: member.organizationId,
  memberId: memberIdSchema.parse(member.id),
  role,
  projectRoles: new Map(),
});

type Queued = { readonly taskId: TaskId; readonly sessionId: SessionId };

/** A queued task in a project, with the session its start waits on, as `createPromptTask` leaves it. */
const queued = async (
  projectId: ProjectId,
  options: { readonly priority?: number; readonly queuedAt?: Date; readonly creator?: SeededMember; readonly runnerId?: RunnerId } = {},
): Promise<Queued> => {
  const { taskId } = await seedQueued(test.db, {
    organizationId,
    projectId,
    creatorMemberId: memberIdSchema.parse((options.creator ?? fixture.a.member).id),
    ...(options.priority === undefined ? {} : { queuePriority: options.priority }),
    ...(options.queuedAt === undefined ? {} : { queuedAt: options.queuedAt }),
    ...(options.runnerId === undefined ? {} : { runnerId: options.runnerId }),
  });
  const session = await test.db.session.create({
    data: { organizationId, projectId, taskId, agentProfileId: world.profileId, origin: "new", state: "starting" },
  });
  return { taskId, sessionId: sessionIdSchema.parse(session.id) };
};

/** A connected runner at minor 4: a pool's when `poolId` is given, else the member's personal one. */
const connected = async (input: Parameters<typeof seedRunner>[1]): Promise<RunnerId> => {
  const { runnerId } = await seedRunner(test.db, input);
  await test.db.runnerPresence.create({
    data: { runnerId, organizationId, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor: input.minor ?? 4 },
  });
  return runnerId;
};

const dockerRunner = (poolId: PoolId, slots: number, resources: { readonly cpuMillis: number; readonly memoryMiB: number } | null = null) =>
  connected({ organizationId, poolId, executor: "docker", slots, resources, capabilities: dockerCapabilities });

/** The boxes that hold a slot, counted from rows: per project on a pool's runners, and in all. */
const liveBoxes = async (poolId: PoolId, projectId?: ProjectId): Promise<number> =>
  test.db.box.count({
    where: { organizationId, state: { in: ["creating", "preparing", "ready", "idle"] }, runner: { poolId }, ...(projectId === undefined ? {} : { projectId }) },
  });

const waitOf = async (taskId: TaskId): Promise<unknown> => (await test.db.task.findUniqueOrThrow({ where: { id: taskId } })).dispatchWait;

const dispatchPersonal = (task: Queued, personalSlots?: number) =>
  test.db.$transaction((tx) =>
    dispatchTask(
      { tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger, ...(personalSlots === undefined ? {} : { personalSlots }) },
      { organizationId, taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: leaseEpochSchema.parse(1) },
    ),
  );

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  organizationId = fixture.a.organization.id;
  projectA = fixture.a.openProject.id;
  projectB = fixture.a.restrictedProject.id;
  world = await seedWorld(test.db, { codeHost, secretStore }, organizationId, projectA);
  await test.db.$transaction((tx) => ensureBoxSizes(tx, organizationId));
});

beforeEach(async () => {
  // Each case starts with an empty queue, no pool on any project and no runner online.
  await test.db.task.updateMany({ where: { organizationId, state: "queued" }, data: { state: "stopped", stoppedReason: "requested" } });
  await test.db.projectPool.deleteMany({ where: { organizationId } });
  await test.db.runner.updateMany({ where: { organizationId }, data: { state: "offline" } });
  await test.db.project.updateMany({ where: { organizationId }, data: { defaultBoxSize: null } });
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("capacity (F-067, F-095)", () => {
  it("F-067, F-095: a runner's capacity is its slots, and where sizes apply its CPU and memory, counted from its boxes", async () => {
    await test.db.project.update({ where: { id: projectA }, data: { defaultBoxSize: "small" } });
    // small: 2 vCPU and 4 GiB, plus the sidecar's 1 vCPU and 256 MiB: 3000m and 4352 MiB a box.
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId: projectA }] });
    const byCpu = await dockerRunner(poolId, 4, { cpuMillis: 7_000, memoryMiB: 64_000 });
    const firstTask = await queued(projectA, { queuedAt: new Date(Date.now() - 10_000) });
    for (let index = 1; index < 4; index += 1) {
      await queued(projectA, { queuedAt: new Date(Date.now() - 10_000 + index) });
    }
    const first = await admit(poolId);
    // Four slots, but CPU for two boxes only.
    expect(first.admitted.map((entry) => entry.runnerId)).toEqual([byCpu, byCpu]);
    expect(await liveBoxes(poolId)).toBe(2);
    expect(first.waiting.map((entry) => entry.reason)).toEqual([
      { code: "queued", poolId, place: 1 },
      { code: "queued", poolId, place: 2 },
    ]);
    // Each box carries the project's size, on its row and in the dispatch.
    const box = await test.db.box.findFirstOrThrow({ where: { taskId: firstTask.taskId } });
    expect(box).toMatchObject({ size: "small", cpuMillis: 2_000, memoryMiB: 4_096 });
    const command = await test.db.command.findFirstOrThrow({ where: { taskId: firstTask.taskId, kind: "dispatch" } });
    expect(command.body).toMatchObject({ box: { size: { name: "small", cpuMillis: 2_000, memoryMiB: 4_096 }, image: null } });

    // A runner with memory for one more box takes the third; then the fourth waits again.
    const byMemory = await dockerRunner(poolId, 8, { cpuMillis: 64_000, memoryMiB: 5_000 });
    const second = await admit(poolId);
    expect(second.admitted.map((entry) => entry.runnerId)).toEqual([byMemory]);
    // A runner with room by CPU and memory but one slot takes the last one, and is then full.
    const bySlots = await dockerRunner(poolId, 1, { cpuMillis: 64_000, memoryMiB: 64_000 });
    expect((await admit(poolId)).admitted.map((entry) => entry.runnerId)).toEqual([bySlots]);
    const fifth = await queued(projectA);
    expect((await admit(poolId)).admitted).toEqual([]);
    expect(await waitOf(fifth.taskId)).toEqual({ code: "queued", poolId, place: 1 });
    expect(await liveBoxes(poolId)).toBe(4);
    // A box that stops frees its slot and its room.
    await test.db.box.updateMany({ where: { taskId: firstTask.taskId }, data: { state: "stopped" } });
    expect((await admit(poolId)).admitted.map((entry) => entry.runnerId)).toEqual([byCpu]);
  });

  it("F-067: a runner without resources (slots only) counts slots, as milestone 1 did", async () => {
    await test.db.project.update({ where: { id: projectA }, data: { defaultBoxSize: "large" } });
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId: projectA }] });
    const host = await connected({ organizationId, poolId, executor: "host", slots: 2, resources: null, capabilities: { ...dockerCapabilities, isolation: "none", services: false, boxSizes: false, snapshots: "host-cache", registry: "none" } });
    for (let index = 0; index < 3; index += 1) {
      await queued(projectA);
    }
    expect((await admit(poolId)).admitted.map((entry) => entry.runnerId)).toEqual([host, host]);
    // No size on a runner that doesn't apply them.
    const boxes = await test.db.box.findMany({ where: { runnerId: host } });
    expect(boxes.map((box) => box.size)).toEqual([null, null]);
  });

  it("F-067: a personal runner runs two at once unless its member sets another number, outside any pool", async () => {
    const owner = fixture.a.member;
    const personal = await connected({ organizationId, ownerMemberId: memberIdSchema.parse(owner.id), executor: "host", slots: 1 });
    // Not reported yet: the server's default, OSTRA_PERSONAL_RUNNER_CAPACITY (2).
    await test.db.runner.update({ where: { id: personal }, data: { slots: null } });
    const first = await queued(projectA, { runnerId: personal });
    const second = await queued(projectA, { runnerId: personal });
    const third = await queued(projectA, { runnerId: personal });
    expect(await dispatchPersonal(first)).toMatchObject({ ok: true, runnerId: personal });
    expect(await dispatchPersonal(second)).toMatchObject({ ok: true, runnerId: personal });
    expect(await dispatchPersonal(third)).toMatchObject({ ok: false, error: "no-runner" });
    expect(await waitOf(third.taskId)).toEqual({ code: "personal-runner-unavailable" });
    // Its tasks are in no pool's queue.
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId: projectA }] });
    expect(await poolQueueInTx(test.db, organizationId, poolId)).toEqual([]);
    // The setting at 3 lets the third start; a number its member set on the runner wins over it.
    expect(await dispatchPersonal(third, 3)).toMatchObject({ ok: true, runnerId: personal });
    const fourth = await queued(projectA, { runnerId: personal });
    await test.db.runner.update({ where: { id: personal }, data: { slots: 4 } });
    expect(await dispatchPersonal(fourth, 3)).toMatchObject({ ok: true, runnerId: personal });
  });
});

describe("the pool queue and its admission (F-067)", () => {
  it("F-067: the queue's order is priority, then the time first queued, then the ID, and each waiting task has its place", async () => {
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId: projectA }] });
    const runner = await dockerRunner(poolId, 1);
    const base = Date.now() - 60_000;
    const low = await queued(projectA, { priority: 4, queuedAt: new Date(base) });
    const mediumLater = await queued(projectA, { priority: 3, queuedAt: new Date(base + 2_000) });
    const mediumEarlier = await queued(projectA, { priority: 3, queuedAt: new Date(base + 1_000) });
    const urgent = await queued(projectA, { priority: 1, queuedAt: new Date(base + 3_000) });
    expect((await poolQueueInTx(test.db, organizationId, poolId)).map((entry) => entry.taskId)).toEqual([
      urgent.taskId,
      mediumEarlier.taskId,
      mediumLater.taskId,
      low.taskId,
    ]);
    // One slot: the urgent task takes it, though it was queued last; the rest wait in order.
    const pass = await admit(poolId);
    expect(pass.admitted.map((entry) => entry.taskId)).toEqual([urgent.taskId]);
    expect(await waitOf(mediumEarlier.taskId)).toEqual({ code: "queued", poolId, place: 1 });
    expect(await waitOf(mediumLater.taskId)).toEqual({ code: "queued", poolId, place: 2 });
    expect(await waitOf(low.taskId)).toEqual({ code: "queued", poolId, place: 3 });
    // More room: the next two, in the queue's order, then the last.
    await test.db.runner.update({ where: { id: runner }, data: { slots: 3 } });
    expect((await admit(poolId)).admitted.map((entry) => entry.taskId)).toEqual([mediumEarlier.taskId, mediumLater.taskId]);
    await test.db.runner.update({ where: { id: runner }, data: { slots: 4 } });
    expect((await admit(poolId)).admitted.map((entry) => entry.taskId)).toEqual([low.taskId]);
  });

  it("F-067, F-095: a project at its share of a pool is passed over, and another project's task starts", async () => {
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId: projectA, maxBoxes: 1 }, { projectId: projectB }] });
    await dockerRunner(poolId, 4);
    const base = Date.now() - 60_000;
    const a1 = await queued(projectA, { priority: 1, queuedAt: new Date(base) });
    const a2 = await queued(projectA, { priority: 1, queuedAt: new Date(base + 1_000) });
    const b1 = await queued(projectB, { priority: 4, queuedAt: new Date(base + 2_000), creator: fixture.a.insider });
    const pass = await admit(poolId);
    // A's second task is ahead of B's in the queue, but A is at its share: B's starts.
    expect(pass.admitted.map((entry) => entry.taskId)).toEqual([a1.taskId, b1.taskId]);
    expect(pass.waiting).toEqual([{ taskId: a2.taskId, reason: { code: "project-share-reached", poolId, cap: 1 } }]);
    expect(await liveBoxes(poolId, projectA)).toBe(1);
    expect(await liveBoxes(poolId, projectB)).toBe(1);
  });

  it("F-067, F-095: fifty admissions raced from three core replicas never exceed a project's share or the pool's cap, counted from rows", async () => {
    const replicas = [test.db, createDb(test.url), createDb(test.url)];
    try {
      const { poolId } = await seedPool(test.db, { organizationId, maxBoxes: 6, projects: [{ projectId: projectA, maxBoxes: 2 }, { projectId: projectB, maxBoxes: 3 }] });
      for (let index = 0; index < 3; index += 1) {
        await dockerRunner(poolId, 10);
      }
      const base = Date.now() - 60_000;
      const tasks: Queued[] = [];
      for (let index = 0; index < 50; index += 1) {
        tasks.push(
          await queued(index % 2 === 0 ? projectA : projectB, {
            queuedAt: new Date(base + index),
            ...(index % 2 === 0 ? {} : { creator: fixture.a.insider }),
          }),
        );
      }
      // The race: all fifty admissions at once, each tried by every replica, as the pools' passes
      // and the dispatch jobs of three cores would. A task another replica holds is skipped.
      const storm = async (): Promise<void> => {
        const outcomes = await Promise.allSettled(
          tasks.flatMap((task) =>
            replicas.map((db) =>
              db.$transaction(
                (tx) =>
                  dispatchTask(
                    { tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock },
                    { organizationId, taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: leaseEpochSchema.parse(1) },
                  ),
                { maxWait: 120_000, timeout: 120_000 },
              ),
            ),
          ),
        );
        const failed = outcomes.flatMap((outcome): string[] => {
          if (outcome.status === "fulfilled") {
            return [];
          }
          const reason: unknown = outcome.reason;
          return reason instanceof Error && reason.message === TASK_BUSY ? [] : [String(reason)];
        });
        expect(failed).toEqual([]);
      };
      await storm();
      expect(await liveBoxes(poolId, projectA)).toBe(2);
      expect(await liveBoxes(poolId, projectB)).toBe(3);
      expect(await liveBoxes(poolId)).toBe(5);
      // Each replica's pass of the pool's queue, at once, adds nothing.
      await Promise.all(replicas.map((db) => admit(poolId, db)));
      expect(await liveBoxes(poolId)).toBe(5);
      // Without B's share, the pool's cap holds, and no more.
      await test.db.projectPool.updateMany({ where: { poolId, projectId: projectB }, data: { maxBoxes: null } });
      await storm();
      await Promise.all(replicas.map((db) => admit(poolId, db)));
      expect(await liveBoxes(poolId, projectA)).toBe(2);
      expect(await liveBoxes(poolId)).toBe(6);
      const waiting = await test.db.task.findMany({ where: { organizationId, state: "queued", leases: { none: { state: "active" } } }, select: { dispatchWait: true } });
      expect(waiting).toHaveLength(44);
      const reasons = waiting.map((row) => row.dispatchWait);
      expect(reasons).toContainEqual({ code: "project-share-reached", poolId, cap: 2 });
      expect(reasons).toContainEqual({ code: "pool-full", poolId });
      expect(reasons.filter((reason) => !isDeepStrictEqual(reason, { code: "project-share-reached", poolId, cap: 2 }) && !isDeepStrictEqual(reason, { code: "pool-full", poolId }))).toEqual([]);
    } finally {
      await Promise.all(replicas.slice(1).map((db) => db.$disconnect()));
    }
  });

  it("F-067: a requeue keeps its place: a declined offer, a revoked pool runner's offer and a box with no node", async () => {
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId: projectA }] });
    const runner = await dockerRunner(poolId, 1);
    const base = Date.now() - 60_000;
    const older = await queued(projectA, { queuedAt: new Date(base) });
    const newer = await queued(projectA, { queuedAt: new Date(base + 1_000) });
    const queuedAt = async (task: Queued) => (await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).queuedAt?.getTime();

    // 1. Declined: the offer ends, and the older task is still first in line.
    expect((await admit(poolId)).admitted.map((entry) => entry.taskId)).toEqual([older.taskId]);
    const declined = await test.db.command.findFirstOrThrow({ where: { taskId: older.taskId, kind: "dispatch" }, orderBy: { seq: "desc" } });
    await test.db.$transaction((tx) =>
      applyOfferResultsInTx({ jobs, notices: postgresChangeNotices, clock: systemClock, logger }, tx, { runnerId: runner, organizationId }, [
        {
          commandId: commandIdSchema.parse(declined.id),
          seq: commandSeqSchema.parse(declined.seq),
          kind: "dispatch",
          body: {},
          taskId: older.taskId,
          result: "rejected",
          reason: "no-capacity",
        },
      ]),
    );
    expect(await queuedAt(older)).toBe(base);
    expect((await admit(poolId)).admitted.map((entry) => entry.taskId)).toEqual([older.taskId]);

    // 2. Its pool runner is revoked before it accepts: back in the queue, still first.
    const replacement = await dockerRunner(poolId, 1);
    const revoked = await test.db.$transaction((tx) =>
      revokeRunner({ tx, scope: scopeOf(fixture.a.admin, "admin"), notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, jobs }, { runnerId: runner }),
    );
    expect(revoked).toMatchObject({ ok: true, stoppedTaskIds: [] });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: older.taskId } })).toMatchObject({ state: "queued" });
    expect(await queuedAt(older)).toBe(base);
    expect((await admit(poolId)).admitted.map((entry) => ({ taskId: entry.taskId, runnerId: entry.runnerId }))).toEqual([{ taskId: older.taskId, runnerId: replacement }]);

    // 3. Accepted, then its box never got a node (ADR 0060): back to queued, still first.
    const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: older.taskId, state: "active" } });
    await test.db.lease.update({ where: { id: lease.id }, data: { acceptedAt: new Date() } });
    await test.db.task.update({ where: { id: older.taskId }, data: { state: "preparing" } });
    const requeued = await test.db.$transaction((tx) =>
      requeueTaskInTx({ jobs, notices: postgresChangeNotices, clock: systemClock, logger }, tx, {
        organizationId,
        taskId: older.taskId,
        endReason: "no-node",
        boxReason: "no node came for the box",
        wait: null,
      }),
    );
    expect(requeued).toBe(true);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: older.taskId } })).toMatchObject({ state: "queued" });
    expect(await test.db.box.findUniqueOrThrow({ where: { id: lease.boxId } })).toMatchObject({ state: "failed" });
    expect(await queuedAt(older)).toBe(base);
    expect((await poolQueueInTx(test.db, organizationId, poolId)).map((entry) => entry.taskId)).toEqual([older.taskId, newer.taskId]);
    expect((await admit(poolId)).admitted.map((entry) => entry.taskId)).toEqual([older.taskId]);
  });

  it("F-067: queueing a task sets its priority, its profile's labels and its first time, and a requeue keeps that time", async () => {
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId: projectA }] });
    await test.db.agentProfile.update({ where: { id: world.profileId }, data: { runnerLabels: ["region:eu", "gpu"] } });
    try {
      const task = await queued(projectA, { queuedAt: new Date(1_000) });
      await test.db.task.update({ where: { id: task.taskId }, data: { queuePriority: 1 } });
      const fresh = await test.db.$transaction((tx) => queueTask({ tx, jobs, clock: systemClock }, { organizationId, taskId: task.taskId, keepPlace: false }));
      // A prompt task has no ticket: Medium.
      expect(fresh).toEqual({ ok: true, queuePriority: 3, poolIds: [poolId] });
      const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
      expect(row.requiredLabels).toEqual(["gpu", "region:eu"]);
      expect(row.queuedAt?.getTime()).toBeGreaterThan(1_000);
      const kept = await test.db.$transaction((tx) => queueTask({ tx, jobs, clock: systemClock }, { organizationId, taskId: task.taskId, keepPlace: true }));
      expect(kept.ok).toBe(true);
      expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).queuedAt).toEqual(row.queuedAt);
      // The pool's admission was sent, once.
      expect(await jobs.find("queue.admit", { organizationId, poolId })).toHaveLength(1);
    } finally {
      await test.db.agentProfile.update({ where: { id: world.profileId }, data: { runnerLabels: [] } });
    }
  });
});

describe("cancelling a queued task (F-067)", () => {
  const cancel = (taskId: TaskId, scope: MemberScope) =>
    cancelQueuedTask({ db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters }, scope, { taskId });

  it("F-067: an admin cancels any queued task, a member their own, and another member is refused", async () => {
    const mine = await queued(projectA, { creator: fixture.a.member });
    const theirs = await queued(projectA, { creator: fixture.a.member });
    // Another member of the organization, not the task's: refused, nothing changes.
    expect(await cancel(theirs.taskId, scopeOf(fixture.a.insider, "member"))).toMatchObject({ ok: false, error: "forbidden" });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: theirs.taskId } })).toMatchObject({ state: "queued", cancelledByMemberId: null });
    // Another organization's admin doesn't see it.
    expect(await cancel(theirs.taskId, scopeOf(fixture.b.admin, "admin"))).toMatchObject({ ok: false, error: "not-found" });
    // The task's member.
    expect(await cancel(mine.taskId, scopeOf(fixture.a.member, "member"))).toEqual({ ok: true, state: "stopped" });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: mine.taskId } })).toMatchObject({
      state: "stopped",
      stoppedReason: "cancelled",
      cancelledByMemberId: fixture.a.member.id,
    });
    // An admin.
    expect(await cancel(theirs.taskId, scopeOf(fixture.a.admin, "admin"))).toEqual({ ok: true, state: "stopped" });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: theirs.taskId } })).toMatchObject({ stoppedReason: "cancelled", cancelledByMemberId: fixture.a.admin.id });
    // The event, the audit entry, and the session stopped, in the same transaction.
    const event = await test.db.event.findFirstOrThrow({ where: { taskId: theirs.taskId, kind: "task.cancelled" } });
    expect(event.payload).toMatchObject({ kind: "task.cancelled", memberId: fixture.a.admin.id });
    expect(await test.db.auditEntry.count({ where: { action: "task.cancelled", entityId: theirs.taskId } })).toBe(1);
    expect(await test.db.session.findUniqueOrThrow({ where: { id: theirs.sessionId } })).toMatchObject({ state: "stopped" });
    // Only a queued task.
    expect(await cancel(theirs.taskId, scopeOf(fixture.a.admin, "admin"))).toMatchObject({ ok: false, error: "not-queued" });
  });

  it("F-067: cancelling a task whose offer is out ends the offer, so the runner's late answer is stale", async () => {
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId: projectA }] });
    await dockerRunner(poolId, 1);
    const task = await queued(projectA);
    expect((await admit(poolId)).admitted).toHaveLength(1);
    expect(await cancel(task.taskId, scopeOf(fixture.a.admin, "admin"))).toEqual({ ok: true, state: "stopped" });
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "ended", endReason: "cancelled" });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ leaseEpoch: 2 });
    expect(await liveBoxes(poolId)).toBe(0);
  });
});

describe("what a runner reports (F-067, F-069)", () => {
  it("F-069: a runner's report is kept with the built-in labels, and a reserved label it tries to set is dropped and logged", async () => {
    const { poolId } = await seedPool(test.db, { organizationId });
    const runner = await dockerRunner(poolId, 2);
    await test.db.runner.update({ where: { id: runner }, data: { os: { platform: "linux", arch: "arm64", release: "6.8" } } });
    records.length = 0;
    const result = await test.db.$transaction((tx) =>
      recordRunnerReport(
        { tx, clock: systemClock, notices: postgresChangeNotices, jobs, logger },
        {
          runnerId: runner,
          organizationId,
          minor: 4,
          version: "0.5.0",
          slots: 3,
          resources: { slots: 6, cpuMillis: 12_000, memoryMiB: 24_000 },
          capabilities: dockerCapabilities,
          install: "npm",
          labels: ["gpu", "executor:kubernetes", "os:darwin"],
          os: null,
          arch: null,
        },
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      labels: ["arch:arm64", "executor:docker", "gpu", "os:linux"],
      droppedLabels: ["executor:kubernetes", "os:darwin"],
      versionState: "current",
    });
    expect(await test.db.runner.findUniqueOrThrow({ where: { id: runner } })).toMatchObject({
      labels: ["arch:arm64", "executor:docker", "gpu", "os:linux"],
      slots: 6,
      cpuMillis: 12_000,
      memoryMiB: 24_000,
      install: "npm",
      minor: 4,
      capabilities: dockerCapabilities,
    });
    const line = records.find((record) => record.message === "runner.reserved-labels-dropped");
    expect(line?.fields).toEqual({ runnerId: runner, dropped: 2 });
    // The log line names the runner and a count, never a label.
    expect(JSON.stringify(line)).not.toContain("kubernetes");
  });
});
