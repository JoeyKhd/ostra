import { randomBytes } from "node:crypto";

import type { OrganizationId, PoolId, ProjectId, RunnerId, TaskId } from "@ostra/protocol";
import { organizationIdSchema, poolIdSchema, projectIdSchema, runnerIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedPersonalRunner, seedTask } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 5, ticket 26 (F-092, F-067): the fleet, drain, resume, revoke and the queue through the
// panel's API. Every count is from seeded rows: pools, runners, their `Box` rows and queued tasks.

let harness: ApiHarness;
let organizationId: OrganizationId;

beforeAll(async () => {
  harness = await createApiHarness();
  organizationId = organizationIdSchema.parse(harness.fixture.a.organization.id);
});

afterAll(async () => {
  await harness.dispose();
});

type RunnerSeed = {
  readonly name: string;
  readonly executor?: "docker" | "host" | "kubernetes";
  readonly state?: "joining" | "online" | "offline" | "draining" | "revoked";
  readonly slots?: number;
  readonly version?: string;
  readonly labels?: readonly string[];
  readonly capabilities?: object;
  readonly minor?: number;
};

const seedPool = async (name: string): Promise<PoolId> => {
  const row = await harness.test.db.runnerPool.create({ data: { organizationId, name }, select: { id: true } });
  return poolIdSchema.parse(row.id);
};

const seedRunner = async (poolId: PoolId, seed: RunnerSeed): Promise<RunnerId> => {
  const row = await harness.test.db.runner.create({
    data: {
      organizationId,
      kind: "pool",
      poolId,
      name: seed.name,
      publicKey: randomBytes(32).toString("base64url"),
      executor: seed.executor ?? "docker",
      capacity: seed.slots ?? 2,
      slots: seed.slots ?? 2,
      labels: [...(seed.labels ?? [])],
      version: seed.version ?? "0.5.0",
      state: seed.state ?? "online",
      ...(seed.minor === undefined ? {} : { minor: seed.minor }),
      ...(seed.capabilities === undefined ? {} : { capabilities: seed.capabilities }),
    },
    select: { id: true },
  });
  return runnerIdSchema.parse(row.id);
};

/** A project of its own, on its own pool, so other tests' tasks never share its queue. */
const seedProjectOn = async (poolId: PoolId, name: string): Promise<ProjectId> => {
  const project = await harness.test.db.project.create({ data: { organizationId, name, slug: `${name}-${randomBytes(3).toString("hex")}`, access: "open" }, select: { id: true } });
  await harness.test.db.projectPool.create({ data: { organizationId, projectId: project.id, poolId, position: 0 } });
  return projectIdSchema.parse(project.id);
};

/** A task holding a box on a runner, in a box state. */
const seedBox = async (projectId: ProjectId, runnerId: RunnerId, state: "creating" | "preparing" | "ready" | "idle" | "stopped" | "released" | "failed") => {
  const task = await seedTask(harness, { organizationId, projectId, state: "running" });
  await harness.test.db.box.create({ data: { organizationId, projectId, taskId: task.taskId, runnerId, executor: "docker", state } });
  return task;
};

/** A task in its pool's queue: queued, a session starting, no offer out. */
const seedQueued = async (projectId: ProjectId, input: { readonly title: string; readonly priority: number; readonly queuedAt: Date; readonly creatorMemberId?: string }): Promise<TaskId> => {
  const task = await seedTask(harness, { organizationId, projectId, title: input.title, state: "queued", sessionState: "starting", creatorMemberId: input.creatorMemberId ?? null });
  await harness.test.db.task.update({ where: { id: task.taskId }, data: { queuePriority: input.priority, queuedAt: input.queuedAt } });
  return task.taskId;
};

const capabilities = (executor: "docker" | "host" | "kubernetes") => ({
  isolation: executor === "host" ? "none" : "container",
  services: executor !== "host",
  boxSizes: executor !== "host",
  snapshots: executor === "docker" ? "image" : executor === "host" ? "host-cache" : "none",
  registry: executor === "kubernetes" ? "required" : executor === "docker" ? "optional" : "none",
  nodeWait: executor === "kubernetes",
});

describe("the fleet's counts (F-092)", () => {
  it("F-092/c1,c2: a pool's busy boxes are its runners' boxes that hold a slot, against the slots of its working runners", async () => {
    const poolId = await seedPool("counted-fleet");
    const projectId = await seedProjectOn(poolId, "counted");
    const one = await seedRunner(poolId, { name: "fleet-01", slots: 3, version: "0.5.0", labels: ["tier:fast", "executor:docker"] });
    const two = await seedRunner(poolId, { name: "fleet-02", slots: 2, version: "0.4.9", state: "draining", labels: ["executor:docker"] });
    await seedRunner(poolId, { name: "fleet-03", slots: 4, version: "0.5.1", state: "offline" });
    await seedRunner(poolId, { name: "fleet-gone", slots: 8, state: "revoked" });
    // Busy: creating, ready and idle on one, preparing on two. Not busy: stopped, released, failed.
    await seedBox(projectId, one, "creating");
    await seedBox(projectId, one, "ready");
    await seedBox(projectId, one, "idle");
    await seedBox(projectId, two, "preparing");
    await seedBox(projectId, one, "stopped");
    await seedBox(projectId, two, "released");
    await seedBox(projectId, two, "failed");
    await seedQueued(projectId, { title: "waits", priority: 3, queuedAt: new Date() });

    const admin = await harness.as(harness.fixture.a.admin);
    const pool = (await admin.pools.list()).find((row) => row.id === poolId);
    expect(pool).toMatchObject({
      busy: 4,
      // The online and the draining runner's slots; the offline one's don't count.
      slots: 5,
      queueLength: 1,
      runnerCount: 3,
      onlineCount: 1,
      versions: ["0.4.9", "0.5.0", "0.5.1"],
      versionRange: { min: "0.4.9", max: "0.5.1" },
      labels: ["executor:docker", "tier:fast"],
      executors: ["docker"],
    });
    const runners = (await admin.runners.list()).filter((row) => row.pool?.id === poolId);
    expect(runners.map((row) => [row.name, row.busy, row.slots, row.state])).toEqual([
      ["fleet-01", 3, 3, "online"],
      ["fleet-02", 1, 2, "draining"],
      ["fleet-03", 0, 4, "offline"],
      ["fleet-gone", 0, 8, "revoked"],
    ]);
  });

  it("F-092/c3, F-015/c5: each runner's capability lines: not isolated on host, direct internet access on kubernetes, same user on a host pool in development", async () => {
    const poolId = await seedPool("lined-fleet");
    const host = await seedRunner(poolId, { name: "line-host", executor: "host", minor: 4, capabilities: capabilities("host") });
    const kube = await seedRunner(poolId, { name: "line-kube", executor: "kubernetes", minor: 4, capabilities: capabilities("kubernetes") });
    const docker = await seedRunner(poolId, { name: "line-docker", executor: "docker", minor: 4, capabilities: capabilities("docker") });
    // A minor-3 host runner reports no capabilities: read from its executor.
    const older = await seedRunner(poolId, { name: "line-older", executor: "host", minor: 3 });
    const personal = await seedPersonalRunner(harness, harness.fixture.a.member.id, "line-laptop");

    const admin = await harness.as(harness.fixture.a.admin);
    const linesOf = async (caller: typeof admin) => new Map((await caller.runners.list()).map((row) => [row.id, row.lines] as const));
    const lines = await linesOf(admin);
    expect([lines.get(host), lines.get(kube), lines.get(docker), lines.get(older), lines.get(personal)]).toEqual([
      ["not-isolated"],
      ["direct-internet-access"],
      [],
      ["not-isolated"],
      ["not-isolated"],
    ]);
    // The row's own chip reads the same fact: a host runner, in a pool or a member's, isn't isolated.
    const isolated = new Map((await admin.runners.list()).map((row) => [row.id, row.isolated] as const));
    expect([isolated.get(host), isolated.get(kube), isolated.get(docker), isolated.get(older), isolated.get(personal)]).toEqual([false, true, true, false, false]);
    expect((await admin.pools.list()).find((row) => row.id === poolId)?.lines).toEqual(["not-isolated", "direct-internet-access"]);

    // With `OSTRA_DEV_HOST_POOL_SAME_USER`, a host pool's runners say so; a personal runner doesn't.
    const context = await harness.contextOf(harness.fixture.a.admin);
    const sameUser = harness.callerFor({ ...context, deps: { ...context.deps, settings: { ...context.deps.settings, devHostPoolSameUser: true } } });
    const development = await linesOf(sameUser);
    expect([development.get(host), development.get(older), development.get(kube), development.get(personal)]).toEqual([
      ["not-isolated", "same-user-development"],
      ["not-isolated", "same-user-development"],
      ["direct-internet-access"],
      ["not-isolated"],
    ]);
    expect((await sameUser.pools.list()).find((row) => row.id === poolId)?.lines).toEqual(["not-isolated", "direct-internet-access", "same-user-development"]);
    expect((await sameUser.runners.get({ runnerId: host })).lines).toEqual(["not-isolated", "same-user-development"]);
  });

  it("F-092/c1: members see their own personal runner and the pools' names, admins everything", async () => {
    const { a, b } = harness.fixture;
    const poolId = await seedPool("seen-fleet");
    const pooled = await seedRunner(poolId, { name: "seen-01" });
    const mine = await seedPersonalRunner(harness, a.member.id, "seen-mine");
    const theirs = await seedPersonalRunner(harness, a.insider.id, "seen-theirs");
    const member = await harness.as(a.member);
    await expect(member.runners.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.pools.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.pools.get({ poolId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await member.pools.names()).find((row) => row.id === poolId)).toEqual({ id: poolId, name: "seen-fleet", isDefault: false });
    expect((await member.runners.mine()).map((row) => row.id)).toContain(mine);
    expect((await member.runners.get({ runnerId: mine })).name).toBe("seen-mine");
    await expect(member.runners.get({ runnerId: theirs })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(member.runners.get({ runnerId: pooled })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const admin = await harness.as(a.admin);
    expect((await admin.runners.get({ runnerId: pooled })).name).toBe("seen-01");
    expect((await admin.runners.get({ runnerId: theirs })).name).toBe("seen-theirs");
    await expect((await harness.as(b.admin)).runners.get({ runnerId: pooled })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await (await harness.as(b.admin)).pools.names()).map((row) => row.id)).not.toContain(poolId);
  });

  it("F-092/c2: a runner's page has the token it joined with, who approved it, its boxes now and its last 20 audit entries", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const made = await admin.pools.create({ name: "paged-fleet", requiresApproval: true });
    const projectId = await seedProjectOn(made.poolId, "paged");
    const runnerId = await seedRunner(made.poolId, { name: "paged-01", state: "joining" });
    await harness.test.db.runner.update({ where: { id: runnerId }, data: { joinTokenId: made.joinToken.joinTokenId } });
    await admin.runners.approve({ runnerId });
    await harness.test.db.runner.update({ where: { id: runnerId }, data: { state: "online" } });
    const busyTask = await seedBox(projectId, runnerId, "ready");
    await seedBox(projectId, runnerId, "released");
    for (let index = 0; index < 22; index += 1) {
      await harness.test.db.auditEntry.create({ data: { organizationId, actorKind: "system", action: "runner.joined", entity: "runner", entityId: runnerId, createdAt: new Date(Date.now() - 60_000 + index) } });
    }
    const page = await admin.runners.get({ runnerId });
    expect(page).toMatchObject({
      name: "paged-01",
      pool: { id: made.poolId, name: "paged-fleet" },
      joinToken: { id: made.joinToken.joinTokenId, label: null, revoked: false },
      approvedBy: { memberId: a.admin.id },
      busy: 1,
    });
    expect(page.boxes.map((box) => [box.task.id, box.state])).toEqual([[busyTask.taskId, "ready"]]);
    expect(page.audit).toHaveLength(20);
    // The approval is the newest.
    expect(page.audit[0]?.action).toBe("runner.approved");
    expect(JSON.stringify(page)).not.toContain(made.joinToken.token);
  });

  it("F-092/c2: a runner's page counts the CPU and memory its slot-holding boxes take against what it offers, with each box's size and task key", async () => {
    const poolId = await seedPool("sized-fleet");
    const projectId = await seedProjectOn(poolId, "sized");
    const runnerId = await seedRunner(poolId, { name: "sized-01", slots: 4, minor: 4 });
    await harness.test.db.runner.update({ where: { id: runnerId }, data: { cpuMillis: 15_000, memoryMiB: 30_720 } });
    const sizedBox = async (state: "ready" | "released", ticketKey: string | null) => {
      const task = await seedTask(harness, { organizationId, projectId, state: "running" });
      await harness.test.db.task.update({ where: { id: task.taskId }, data: { ticketKey } });
      await harness.test.db.box.create({ data: { organizationId, projectId, taskId: task.taskId, runnerId, executor: "docker", state, size: "small", cpuMillis: 2000, memoryMiB: 4096 } });
      return task;
    };
    const ticketed = await sizedBox("ready", "CALC-212");
    await sizedBox("ready", null);
    await sizedBox("released", "CALC-213");

    const admin = await harness.as(harness.fixture.a.admin);
    const page = await admin.runners.get({ runnerId });
    expect(page.resources).toEqual({ cpuMillis: 15_000, memoryMiB: 30_720 });
    // Two live small boxes, each with the sidecar's 1 vCPU and 256 MiB (ADR 0059's footprint); the released one holds nothing.
    expect(page.used).toEqual({ cpuMillis: 6000, memoryMiB: 8704 });
    expect(page.boxes.map((box) => [box.task.key, box.size, box.cpuMillis, box.memoryMiB])).toEqual([
      ["CALC-212", "small", 2000, 4096],
      [null, "small", 2000, 4096],
    ]);
    expect(page.boxes[0]?.task.id).toBe(ticketed.taskId);

    // Slots only (`host`, with no resources reported): no use to count.
    const host = await seedRunner(poolId, { name: "sized-host", executor: "host" });
    expect((await admin.runners.get({ runnerId: host })).used).toBeNull();
  });
});

describe("drain, resume and revoke (F-092)", () => {
  it("F-092/c4: an admin drains, resumes and revokes a runner, with the counts the confirms show; a member is refused each", async () => {
    const { a, b } = harness.fixture;
    const poolId = await seedPool("drained-fleet");
    const projectId = await seedProjectOn(poolId, "drained");
    const runnerId = await seedRunner(poolId, { name: "drain-01", minor: 3 });
    await seedBox(projectId, runnerId, "ready");
    await seedBox(projectId, runnerId, "idle");
    const member = await harness.as(a.member);
    await expect(member.runners.drain({ runnerId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(b.admin)).runners.drain({ runnerId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } })).state).toBe("online");

    const admin = await harness.as(a.admin);
    expect(await admin.runners.drain({ runnerId })).toEqual({ runnerId, state: "draining", runningTasks: 2 });
    expect(await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } })).toMatchObject({ state: "draining", drainedByMemberId: a.admin.id });
    expect((await admin.runners.list()).find((row) => row.id === runnerId)).toMatchObject({ state: "draining", busy: 2 });
    await expect(admin.runners.drain({ runnerId })).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(member.runners.resume({ runnerId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Not connected: offline; minor 3 has no `resume` command.
    expect(await admin.runners.resume({ runnerId })).toEqual({ runnerId, state: "offline", commandSent: false });
    await expect(admin.runners.resume({ runnerId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await harness.test.db.auditEntry.count({ where: { entityId: runnerId, action: { in: ["runner.drained", "runner.resumed"] } } })).toBe(2);

    await expect(member.runners.revoke({ runnerId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } })).revokedAt).toBeNull();
    const revoked = await admin.runners.revoke({ runnerId });
    expect(revoked).toMatchObject({ runnerId, alreadyRevoked: false });
    expect((await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } })).state).toBe("revoked");
  });
});

describe("the queue (F-067)", () => {
  it("F-067/c2, F-092/c2: a pool's queue is in ticket priority order, then by when each was queued, and a member sees their own task's place", async () => {
    const { a } = harness.fixture;
    const poolId = await seedPool("queued-fleet");
    const projectId = await seedProjectOn(poolId, "queued");
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 9, minutes));
    const low = await seedQueued(projectId, { title: "low", priority: 4, queuedAt: at(0) });
    const promptLater = await seedQueued(projectId, { title: "prompt later", priority: 3, queuedAt: at(5), creatorMemberId: a.member.id });
    const urgent = await seedQueued(projectId, { title: "urgent", priority: 1, queuedAt: at(9) });
    const promptFirst = await seedQueued(projectId, { title: "prompt first", priority: 3, queuedAt: at(1) });
    await harness.test.db.task.update({ where: { id: promptLater }, data: { dispatchWait: { code: "queued", poolId, place: 9 } } });

    const admin = await harness.as(a.admin);
    const queue = await admin.pools.queue({ poolId });
    expect(queue.map((entry) => [entry.place, entry.taskId, entry.priority])).toEqual([
      [1, urgent, 1],
      [2, promptFirst, 3],
      [3, promptLater, 3],
      [4, low, 4],
    ]);
    expect(queue[2]).toMatchObject({ project: { id: projectId, name: "queued" }, queuedAt: at(5).getTime(), waitReason: { code: "queued", poolId }, createdBy: { memberId: a.member.id } });

    const member = await harness.as(a.member);
    await expect(member.pools.queue({ poolId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The place is read from the queue now, not the one the admission last recorded (9).
    expect((await member.tasks.get({ taskId: promptLater })).queue).toEqual({ poolId, poolName: "queued-fleet", place: 3, length: 4 });
    const listed = (await member.tasks.list({ projectId })).flatMap((group) => group.tasks);
    expect(listed.find((task) => task.id === low)?.queue).toEqual({ poolId, poolName: "queued-fleet", place: 4, length: 4 });
    expect((await admin.pools.list()).find((row) => row.id === poolId)?.queueLength).toBe(4);
  });

  it("F-067/c2: an admin cancels any queued task and its member their own; another member is refused", async () => {
    const { a } = harness.fixture;
    const poolId = await seedPool("cancelled-fleet");
    const projectId = await seedProjectOn(poolId, "cancelled");
    const own = await seedQueued(projectId, { title: "own", priority: 3, queuedAt: new Date(), creatorMemberId: a.member.id });
    const other = await seedQueued(projectId, { title: "other", priority: 3, queuedAt: new Date(), creatorMemberId: a.insider.id });

    await expect((await harness.as(a.member)).tasks.cancelQueued({ taskId: other })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: other } })).state).toBe("queued");
    expect(await (await harness.as(a.member)).tasks.cancelQueued({ taskId: own })).toEqual({ taskId: own, state: "stopped" });
    expect(await (await harness.as(a.admin)).tasks.cancelQueued({ taskId: other })).toEqual({ taskId: other, state: "stopped" });
    for (const taskId of [own, other]) {
      expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ state: "stopped", stoppedReason: "cancelled" });
      expect(await harness.test.db.auditEntry.count({ where: { action: "task.cancelled", entityId: taskId } })).toBe(1);
    }
    // A task no longer queued isn't cancelled again.
    await expect((await harness.as(a.admin)).tasks.cancelQueued({ taskId: own })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await (await harness.as(a.admin)).pools.queue({ poolId })).toEqual([]);
  });
});
