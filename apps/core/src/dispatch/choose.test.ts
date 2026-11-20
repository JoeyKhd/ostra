import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import { admitQueued, dispatchTask, ensureBoxSizes, postgresChangeNotices, postgresCommandOutbox, queueTask, systemClock } from "@ostra/domain";
import type { AdmitDeps } from "@ostra/domain";
import { seedPool, seedQueuedTask as seedQueued, seedRunner, seedTaskStartedByNobody } from "@ostra/domain/testing";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { leaseEpochSchema, memberIdSchema, sessionIdSchema } from "@ostra/protocol";
import type { OrganizationId, PoolId, ProjectId, RunnerCapabilities, RunnerId, SessionId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

// Ticket 14 (F-069, ADR 0059): choosing a runner, through the real admission against Postgres. The
// pure table of every reason is `packages/domain/src/fleet/fleet.test.ts`; here each one comes
// from rows: pools in order, labels, room, personal runners, tasks no member started, services.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let organizationId: OrganizationId;
let projectId: ProjectId;

const docker: RunnerCapabilities = { isolation: "container", services: true, boxSizes: true, snapshots: "image", registry: "optional", nodeWait: false };
const kubernetes: RunnerCapabilities = { isolation: "container", services: true, boxSizes: true, snapshots: "image", registry: "required", nodeWait: true };
const host: RunnerCapabilities = { isolation: "none", services: false, boxSizes: false, snapshots: "host-cache", registry: "none", nodeWait: false };

const deps = (): AdmitDeps => ({ db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock });
const admit = (poolId: PoolId) => admitQueued(deps(), { organizationId, poolId });

type Queued = { readonly taskId: TaskId; readonly sessionId: SessionId };

const withSession = async (taskId: TaskId): Promise<Queued> => {
  const session = await test.db.session.create({ data: { organizationId, projectId, taskId, agentProfileId: world.profileId, origin: "new", state: "starting" } });
  return { taskId, sessionId: sessionIdSchema.parse(session.id) };
};

/** A member's queued task, put in the queue the way `task.dispatch` does (`queueTask`). */
const queued = async (options: { readonly creator?: SeededMember; readonly runnerId?: RunnerId; readonly queuedAt?: Date } = {}): Promise<Queued> => {
  const { taskId } = await seedQueued(test.db, {
    organizationId,
    projectId,
    creatorMemberId: memberIdSchema.parse((options.creator ?? fixture.a.member).id),
    ...(options.runnerId === undefined ? {} : { runnerId: options.runnerId }),
    ...(options.queuedAt === undefined ? {} : { queuedAt: options.queuedAt }),
  });
  const task = await withSession(taskId);
  await test.db.$transaction((tx) => queueTask({ tx, jobs, clock: systemClock }, { organizationId, taskId, keepPlace: true }));
  return task;
};

const connected = async (input: Parameters<typeof seedRunner>[1]): Promise<RunnerId> => {
  const { runnerId } = await seedRunner(test.db, input);
  await test.db.runnerPresence.create({ data: { runnerId, organizationId, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor: input.minor ?? 4 } });
  return runnerId;
};

const dispatchOf = (task: Queued) =>
  test.db.$transaction((tx) =>
    dispatchTask(
      { tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock },
      { organizationId, taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: leaseEpochSchema.parse(1) },
    ),
  );

const waitOf = async (taskId: TaskId): Promise<unknown> => (await test.db.task.findUniqueOrThrow({ where: { id: taskId } })).dispatchWait;
const runnerOfLease = async (taskId: TaskId): Promise<string | null> => (await test.db.lease.findFirst({ where: { taskId, state: "active" } }))?.runnerId ?? null;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  organizationId = fixture.a.organization.id;
  projectId = fixture.a.openProject.id;
  world = await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() }, organizationId, projectId);
  await test.db.$transaction((tx) => ensureBoxSizes(tx, organizationId));
});

beforeEach(async () => {
  // Each case starts with an empty queue, no pool on the project, no runner online, no size, no
  // services, no registry and no labels asked for.
  await test.db.task.updateMany({ where: { organizationId, state: "queued" }, data: { state: "stopped", stoppedReason: "requested" } });
  await test.db.projectPool.deleteMany({ where: { organizationId } });
  await test.db.runner.updateMany({ where: { organizationId }, data: { state: "offline" } });
  await test.db.project.update({ where: { id: projectId }, data: { defaultBoxSize: null } });
  await test.db.service.deleteMany({ where: { organizationId } });
  await test.db.registry.deleteMany({ where: { organizationId } });
  await test.db.agentProfile.update({ where: { id: world.profileId }, data: { runnerLabels: [] } });
  await test.db.snapshot.deleteMany({ where: { organizationId } });
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const addService = async (): Promise<void> => {
  const environment = await test.db.environment.findFirstOrThrow({ where: { projectId } });
  await test.db.service.create({
    data: { organizationId, projectId, environmentId: environment.id, name: "postgres", image: "postgres:17", port: 5432, variables: [] },
  });
};

describe("choosing a runner (F-069)", () => {
  it("F-069/c1: the project's pools in its order: the first pool's runner, then the next pool when the first has no room", async () => {
    const first = await seedPool(test.db, { organizationId });
    const second = await seedPool(test.db, { organizationId });
    // Listed second-then-first in rows, ordered first-then-second by position.
    await test.db.projectPool.create({ data: { organizationId, projectId, poolId: second.poolId, position: 1 } });
    await test.db.projectPool.create({ data: { organizationId, projectId, poolId: first.poolId, position: 0 } });
    const inFirst = await connected({ organizationId, poolId: first.poolId, slots: 1, capabilities: docker });
    const inSecond = await connected({ organizationId, poolId: second.poolId, slots: 5, capabilities: docker });
    const a = await queued();
    const b = await queued();
    expect(await dispatchOf(a)).toMatchObject({ ok: true, runnerId: inFirst });
    // The first pool is full: the next pool in the project's order.
    expect(await dispatchOf(b)).toMatchObject({ ok: true, runnerId: inSecond });
  });

  it("F-069/c1: a runner must carry every label the task's profile asks for, matched exactly", async () => {
    await test.db.agentProfile.update({ where: { id: world.profileId }, data: { runnerLabels: ["gpu", "region:eu"] } });
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId }] });
    const oneShort = await connected({ organizationId, poolId, slots: 4, labels: ["gpu", "executor:docker"], capabilities: docker });
    const task = await queued();
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).requiredLabels).toEqual(["gpu", "region:eu"]);
    expect((await admit(poolId)).admitted).toEqual([]);
    expect(await waitOf(task.taskId)).toEqual({ code: "no-runner-with-labels", labels: ["gpu", "region:eu"] });
    // A label of a similar name isn't the label.
    await test.db.runner.update({ where: { id: oneShort }, data: { labels: ["gpu", "region:eu-west"] } });
    expect((await admit(poolId)).admitted).toEqual([]);
    const fits = await connected({ organizationId, poolId, slots: 1, labels: ["arch:x64", "gpu", "region:eu"], capabilities: docker });
    expect((await admit(poolId)).admitted.map((entry) => entry.runnerId)).toEqual([fits]);
  });

  it("F-069/c1: each reason a task waits comes from the rows, the nearest miss across the pools", async () => {
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId }] });
    const task = await queued();
    const reason = async (): Promise<unknown> => {
      await admit(poolId);
      return waitOf(task.taskId);
    };
    // No runner in the pool.
    expect(await reason()).toEqual({ code: "no-runner-online" });
    // A kubernetes runner, with no registry set: it needs one.
    const cluster = await connected({ organizationId, poolId, executor: "kubernetes", slots: 4, resources: { cpuMillis: 4_000, memoryMiB: 8_192 }, capabilities: kubernetes });
    expect(await reason()).toEqual({ code: "needs-registry", poolId });
    await test.db.runner.update({ where: { id: cluster }, data: { state: "offline" } });
    // Services, and only a host runner.
    await addService();
    const onHost = await connected({ organizationId, poolId, executor: "host", slots: 4, resources: null, capabilities: host });
    await test.db.runner.update({ where: { id: onHost }, data: { state: "offline" } });
    expect(await reason()).toEqual({ code: "needs-services" });
    await test.db.service.deleteMany({ where: { organizationId } });
    // Gone: the kubernetes and the host runners, so a docker runner is the pool's only one.
    await test.db.runner.deleteMany({ where: { id: { in: [cluster, onHost] } } });
    // A label no runner carries.
    await test.db.task.update({ where: { id: task.taskId }, data: { requiredLabels: ["gpu"] } });
    const plain = await connected({ organizationId, poolId, slots: 1, resources: { cpuMillis: 4_000, memoryMiB: 8_192 }, capabilities: docker });
    expect(await reason()).toEqual({ code: "no-runner-with-labels", labels: ["gpu"] });
    await test.db.task.update({ where: { id: task.taskId }, data: { requiredLabels: [] } });
    // A size no runner could ever hold: large is 8 vCPU, plus the sidecar's.
    await test.db.project.update({ where: { id: projectId }, data: { defaultBoxSize: "large" } });
    expect(await reason()).toEqual({ code: "size-too-large", size: "large" });
    await test.db.project.update({ where: { id: projectId }, data: { defaultBoxSize: null } });
    // The project's share of the pool, and the pool's cap, each at zero.
    await test.db.projectPool.updateMany({ where: { poolId }, data: { maxBoxes: 0 } });
    expect(await reason()).toEqual({ code: "project-share-reached", poolId, cap: 0 });
    await test.db.projectPool.updateMany({ where: { poolId }, data: { maxBoxes: null } });
    await test.db.runnerPool.update({ where: { id: poolId }, data: { maxBoxes: 0 } });
    expect(await reason()).toEqual({ code: "pool-full", poolId });
    await test.db.runnerPool.update({ where: { id: poolId }, data: { maxBoxes: null } });
    // A fitting runner that's offline.
    await test.db.runner.update({ where: { id: plain }, data: { state: "offline" } });
    expect(await reason()).toEqual({ code: "no-runner-online" });
    // Online, and busy: the task waits its turn.
    await test.db.runner.update({ where: { id: plain }, data: { state: "online", slots: 0 } });
    expect(await reason()).toEqual({ code: "queued", poolId, place: 1 });
    // A free slot: it goes.
    await test.db.runner.update({ where: { id: plain }, data: { slots: 1 } });
    await admit(poolId);
    expect(await runnerOfLease(task.taskId)).toBe(plain);
  });

  it("F-069/c4: a task whose environment has services never goes to a host runner, in a pool or on a personal runner", async () => {
    await addService();
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId }] });
    const onHost = await connected({ organizationId, poolId, executor: "host", slots: 4, resources: null, capabilities: host });
    const task = await queued();
    expect((await admit(poolId)).admitted).toEqual([]);
    expect(await test.db.lease.count({ where: { runnerId: onHost } })).toBe(0);
    const inDocker = await connected({ organizationId, poolId, slots: 1, capabilities: docker });
    expect((await admit(poolId)).admitted.map((entry) => entry.runnerId)).toEqual([inDocker]);
    // A member's personal runner on host: never.
    const personal = await connected({ organizationId, ownerMemberId: memberIdSchema.parse(fixture.a.member.id), executor: "host", slots: 2, capabilities: host });
    const mine = await queued({ runnerId: personal });
    expect(await dispatchOf(mine)).toMatchObject({ ok: false, error: "no-runner" });
    expect(await test.db.lease.count({ where: { runnerId: personal } })).toBe(0);
    expect(await runnerOfLease(task.taskId)).toBe(inDocker);
  });
});

describe("who may use a personal runner (F-069)", () => {
  it("F-069/c2: a member's personal runner takes only the tasks that member started and picked it for", async () => {
    const owner = fixture.a.member;
    const personal = await connected({ organizationId, ownerMemberId: memberIdSchema.parse(owner.id), executor: "host", slots: 4, capabilities: host });
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId }] });
    const inPool = await connected({ organizationId, poolId, slots: 4, capabilities: docker });
    // The owner's own task, picked for it: it, and nothing else.
    const picked = await queued({ creator: owner, runnerId: personal });
    expect(await dispatchOf(picked)).toMatchObject({ ok: true, runnerId: personal });
    // The owner's task without a pick: the pools, never the personal runner.
    const unpicked = await queued({ creator: owner });
    expect((await admit(poolId)).admitted.map((entry) => ({ taskId: entry.taskId, runnerId: entry.runnerId }))).toEqual([{ taskId: unpicked.taskId, runnerId: inPool }]);
    // Another member's task naming it: refused, not sent to it.
    const someoneElses = await queued({ creator: fixture.a.insider, runnerId: personal });
    expect(await dispatchOf(someoneElses)).toMatchObject({ ok: false, error: "no-runner" });
    expect(await waitOf(someoneElses.taskId)).toEqual({ code: "personal-runner-unavailable" });
    expect(await test.db.lease.count({ where: { runnerId: personal } })).toBe(1);
  });

  it("F-069/c3: a task no member started goes to the pools only, never to a personal runner, even when its member is known", async () => {
    const owner = fixture.a.member;
    const personal = await connected({ organizationId, ownerMemberId: memberIdSchema.parse(owner.id), executor: "host", slots: 4, capabilities: host });
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId }] });
    // No runner in the pool yet: it waits for one, though the personal runner is free.
    const { taskId } = await seedTaskStartedByNobody(test.db, { organizationId, projectId, driverMemberId: memberIdSchema.parse(owner.id), runnerId: personal });
    const task = await withSession(taskId);
    const result = await test.db.$transaction((tx) => queueTask({ tx, jobs, clock: systemClock }, { organizationId, taskId, keepPlace: true }));
    expect(result).toMatchObject({ ok: true, poolIds: [poolId] });
    expect((await admit(poolId)).admitted).toEqual([]);
    expect(await dispatchOf(task)).toMatchObject({ ok: false, error: "no-runner" });
    expect(await waitOf(taskId)).toEqual({ code: "no-runner-online" });
    expect(await test.db.lease.count({ where: { runnerId: personal } })).toBe(0);
    // A pool runner joins: the task goes there.
    const inPool = await connected({ organizationId, poolId, slots: 1, capabilities: docker });
    expect((await admit(poolId)).admitted.map((entry) => entry.runnerId)).toEqual([inPool]);
    expect(await test.db.lease.count({ where: { runnerId: personal } })).toBe(0);
  });
});

describe("the pick among fitting runners (F-069)", () => {
  it("F-069/c1: the most free room wins, then the runner holding the project's snapshot, then the one offered least recently", async () => {
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId }] });
    const small = await connected({ organizationId, poolId, slots: 2, capabilities: docker });
    const big = await connected({ organizationId, poolId, slots: 3, capabilities: docker });
    // Most room: the one with three free slots.
    const first = await queued();
    expect(await dispatchOf(first)).toMatchObject({ ok: true, runnerId: big });
    // Now two free each: the one holding the project's ready snapshot, though `small` was never offered.
    const environment = await test.db.environment.findFirstOrThrow({ where: { projectId } });
    await test.db.snapshot.create({ data: { organizationId, projectId, environmentId: environment.id, state: "ready", reason: "test", runnerId: big } });
    const second = await queued();
    expect(await dispatchOf(second)).toMatchObject({ ok: true, runnerId: big });
    // Two free each again, no snapshot: the one offered least recently, `small` (never).
    await test.db.snapshot.deleteMany({ where: { organizationId } });
    await test.db.runner.update({ where: { id: big }, data: { slots: 4 } });
    const third = await queued();
    expect(await dispatchOf(third)).toMatchObject({ ok: true, runnerId: small });
    // One free each: `big` was offered before `small`'s last offer, so `big`.
    await test.db.runner.update({ where: { id: big }, data: { slots: 3 } });
    const fourth = await queued();
    expect(await dispatchOf(fourth)).toMatchObject({ ok: true, runnerId: big });
  });
});
