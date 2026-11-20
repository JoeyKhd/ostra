import { randomBytes } from "node:crypto";

import type { OrganizationId, PoolId, ProjectId, RunnerId } from "@ostra/protocol";
import { organizationIdSchema, poolIdSchema, runnerIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 5, ticket 32 (F-095, F-086): what the Box sizes page and a project's Runners tab read
// beside ticket 27's settings (`fleetUse`), and the box's size and wait on `tasks.get` (F-093),
// through the panel's API against Postgres.

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;
let organizationId: OrganizationId;

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
  organizationId = organizationIdSchema.parse(harness.fixture.a.organization.id);
});

afterAll(async () => {
  await harness.dispose();
});

const unique = (prefix: string): string => `${prefix}-${randomBytes(3).toString("hex")}`;

const seedPool = async (name: string, maxBoxes: number | null = null): Promise<PoolId> =>
  poolIdSchema.parse((await harness.test.db.runnerPool.create({ data: { organizationId, name: unique(name), maxBoxes }, select: { id: true } })).id);

const seedRunner = async (input: {
  readonly poolId: PoolId;
  readonly executor: "docker" | "kubernetes" | "host";
  readonly minor?: number;
  readonly state?: "online" | "draining" | "offline";
  readonly cpuMillis?: number;
  readonly memoryMiB?: number;
}): Promise<{ readonly id: RunnerId; readonly name: string }> => {
  const name = unique(`runner-${input.executor}`);
  const row = await harness.test.db.runner.create({
    data: {
      organizationId,
      kind: "pool",
      poolId: input.poolId,
      name,
      publicKey: randomBytes(32).toString("base64url"),
      executor: input.executor,
      capacity: 4,
      slots: 4,
      cpuMillis: input.cpuMillis ?? null,
      memoryMiB: input.memoryMiB ?? null,
      labels: [],
      version: "0.5.0",
      state: input.state ?? "online",
      minor: input.minor ?? 4,
    },
    select: { id: true },
  });
  return { id: runnerIdSchema.parse(row.id), name };
};

const seedBox = async (projectId: ProjectId, runnerId: RunnerId, input: { readonly size: string; readonly state?: "ready" | "released" }) => {
  const task = await seedTask(harness, { organizationId, projectId, state: "running" });
  await harness.test.db.box.create({
    data: { organizationId, projectId, taskId: task.taskId, runnerId, executor: "docker", state: input.state ?? "ready", size: input.size, cpuMillis: 2000, memoryMiB: 4096 },
  });
  return task.taskId;
};

describe("the Box sizes page's counts (F-095)", () => {
  it("F-095/c1: boxes of each size now, the projects on each, the largest offer, and which runners enforce sizes", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const before = await admin.fleetUse.boxSizes();
    const pool = await seedPool("sizes");
    const big = await seedRunner({ poolId: pool, executor: "docker", cpuMillis: 64_000, memoryMiB: 900_000 });
    // Offers more but is one minor behind: it enforces nothing, so it isn't the largest offer.
    const behind = await seedRunner({ poolId: pool, executor: "docker", minor: 3, cpuMillis: 128_000, memoryMiB: 1_900_000 });
    await seedRunner({ poolId: pool, executor: "host" });
    // Offline: not counted.
    await seedRunner({ poolId: pool, executor: "kubernetes", state: "offline", cpuMillis: 200_000, memoryMiB: 2_000_000 });
    const { projectId } = await seedProject(harness, world, unique("sizes-app"));
    await admin.projects.setDefaultBoxSize({ projectId, size: "medium" });
    await seedBox(projectId, big.id, { size: "medium" });
    await seedBox(projectId, big.id, { size: "medium" });
    // A released box holds no slot.
    await seedBox(projectId, big.id, { size: "medium", state: "released" });

    const use = await admin.fleetUse.boxSizes();
    const medium = use.sizes.find((size) => size.name === "medium");
    expect(medium?.boxesNow).toBe((before.sizes.find((size) => size.name === "medium")?.boxesNow ?? 0) + 2);
    expect(medium?.projects.map((project) => project.id)).toContain(projectId);
    expect(use.sizes.find((size) => size.name === "small")?.projects.map((project) => project.id)).not.toContain(projectId);
    expect(use.largest.memoryMiB).toEqual({ value: 900_000, runnerName: big.name });
    expect(use.largest.cpuMillis).toEqual({ value: 64_000, runnerName: big.name });
    expect(use.runners.enforce).toBe(before.runners.enforce + 1);
    expect(use.runners.slotsOnly).toBe(before.runners.slotsOnly + 2);
    expect(use.runners.host).toBe(before.runners.host + 1);
    expect(use.runners.behind).toContainEqual({ id: behind.id, name: behind.name });
    expect(use.bounds.min).toEqual({ cpuMillis: 500, memoryMiB: 1024 });

    // A member reads it too (the page is read-only for them); another organization sees its own.
    expect((await (await harness.as(harness.fixture.a.member)).fleetUse.boxSizes()).sizes).toHaveLength(3);
    const other = await (await harness.as(harness.fixture.b.admin)).fleetUse.boxSizes();
    expect(other.sizes.flatMap((size) => size.projects.map((project) => project.id))).not.toContain(projectId);
    expect(other.largest.memoryMiB?.runnerName).not.toBe(big.name);
  });
});

describe("a project's use of its pools (F-086)", () => {
  it("F-086/c1: each listed pool's executors, cap, the boxes the project holds there and whether it needs a registry; the pools not listed; admins only", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const docker = await seedPool("use-docker", 6);
    const k8s = await seedPool("use-k8s", 20);
    const extra = await seedPool("use-extra");
    const dockerRunner = await seedRunner({ poolId: docker, executor: "docker" });
    await seedRunner({ poolId: docker, executor: "host" });
    await seedRunner({ poolId: k8s, executor: "kubernetes" });
    const { projectId } = await seedProject(harness, world, unique("use-app"));
    await admin.projects.setPools({ projectId, pools: [{ poolId: docker, maxBoxes: 2 }, { poolId: k8s, maxBoxes: null }] });
    await seedBox(projectId, dockerRunner.id, { size: "small" });
    await seedBox(projectId, dockerRunner.id, { size: "small" });

    const use = await admin.fleetUse.project({ projectId });
    expect(use.pools.map((pool) => pool.poolId)).toEqual([docker, k8s]);
    expect(use.pools[0]).toMatchObject({ executors: ["docker", "host"], poolMaxBoxes: 6, held: 2, queued: 0, needsRegistry: false });
    expect(use.pools[1]).toMatchObject({ executors: ["kubernetes"], poolMaxBoxes: 20, held: 0, needsRegistry: true });
    expect(use.others.map((pool) => pool.poolId)).toContain(extra);
    expect(use.others.map((pool) => pool.poolId)).not.toContain(docker);
    expect(use).toMatchObject({ running: 2, waiting: 0 });

    // With a registry set, a kubernetes pool no longer needs one.
    await harness.test.db.registry.create({ data: { organizationId, url: "registry.example.com", repositoryPrefix: "ostra/", auth: "basic" } });
    expect((await admin.fleetUse.project({ projectId })).pools[1]?.needsRegistry).toBe(false);
    await harness.test.db.registry.deleteMany({ where: { organizationId } });

    // A project member who isn't its admin is refused; another organization finds no project.
    await expect((await harness.as(harness.fixture.a.member)).fleetUse.project({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(harness.fixture.b.admin)).fleetUse.project({ projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a task's box (F-095, F-093)", () => {
  it("F-095: tasks.get says the size the box was made with, and why it waits and since when", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const pool = await seedPool("box-size");
    const runner = await seedRunner({ poolId: pool, executor: "kubernetes" });
    const { projectId } = await seedProject(harness, world, unique("box-app"));
    const taskId = await seedBox(projectId, runner.id, { size: "small" });
    expect((await admin.tasks.get({ taskId })).box).toMatchObject({ size: { name: "small", cpuMillis: 2000, memoryMiB: 4096 }, waiting: null });
    const since = new Date(Date.now() - 90_000);
    await harness.test.db.box.updateMany({ where: { taskId }, data: { state: "creating", waitingReason: "node", waitingSince: since } });
    expect((await admin.tasks.get({ taskId })).box).toMatchObject({ waiting: { reason: "node", since: since.getTime() } });
  });
});
