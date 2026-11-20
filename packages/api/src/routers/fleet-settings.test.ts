import { randomBytes, randomUUID } from "node:crypto";

import type { OrganizationId, PoolId, ProjectId, RunnerId } from "@ostra/protocol";
import { agentProfileIdSchema, organizationIdSchema, poolIdSchema, runnerIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 5, ticket 27 (F-095, F-086, F-069, F-014): box sizes, a project's pools and default
// size, a profile's runner labels and New task's runner picker, through the panel's API against
// Postgres. Every refusal is checked to change nothing.

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

const seedPool = async (name: string, inOrganization: string = organizationId): Promise<PoolId> => {
  const row = await harness.test.db.runnerPool.create({ data: { organizationId: inOrganization, name: unique(name) }, select: { id: true } });
  return poolIdSchema.parse(row.id);
};

/** A runner that's connected now: an online row and a live presence at minor 4. */
const seedRunner = async (input: {
  readonly name: string;
  readonly kind: "pool" | "personal";
  readonly poolId?: PoolId;
  readonly ownerMemberId?: string;
  readonly executor?: "docker" | "host";
  readonly slots?: number;
  readonly labels?: readonly string[];
  readonly connected?: boolean;
}): Promise<RunnerId> => {
  const executor = input.executor ?? (input.kind === "personal" ? "host" : "docker");
  const row = await harness.test.db.runner.create({
    data: {
      organizationId,
      kind: input.kind,
      poolId: input.poolId ?? null,
      ownerMemberId: input.ownerMemberId ?? null,
      name: unique(input.name),
      publicKey: randomBytes(32).toString("base64url"),
      executor,
      capacity: input.slots ?? 2,
      slots: input.slots ?? 2,
      labels: [...(input.labels ?? [])],
      version: "0.5.0",
      state: "online",
      minor: 4,
      capabilities: {
        isolation: executor === "host" ? "none" : "container",
        services: executor !== "host",
        boxSizes: executor !== "host",
        snapshots: executor === "host" ? "host-cache" : "image",
        registry: executor === "docker" ? "optional" : "none",
        nodeWait: false,
      },
    },
    select: { id: true },
  });
  if (input.connected !== false) {
    await harness.test.db.runnerPresence.create({ data: { runnerId: row.id, organizationId, replicaId: "replica-test", connectionEpoch: 1, carrier: "websocket", minor: 4 } });
  }
  return runnerIdSchema.parse(row.id);
};

/** A box that holds a slot on a runner. */
const seedBusyBox = async (projectId: ProjectId, runnerId: RunnerId): Promise<void> => {
  const task = await seedTask(harness, { organizationId, projectId, state: "running" });
  await harness.test.db.box.create({ data: { organizationId, projectId, taskId: task.taskId, runnerId, executor: "host", state: "ready" } });
};

/** A project admin who isn't an organization admin: organization A's member, listed as the project's admin. */
const makeProjectAdmin = async (projectId: ProjectId): Promise<void> => {
  await harness.test.db.projectMember.create({ data: { organizationId, projectId, memberId: harness.fixture.a.member.id, role: "admin" } });
};

const auditCount = (action: string): Promise<number> => harness.test.db.auditEntry.count({ where: { organizationId, action } });

describe("box sizes (F-095)", () => {
  it("F-095/c1: an admin updates a size, with an audit entry; a member is refused, and so is a size below the minimum", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const member = await harness.as(harness.fixture.a.member);
    expect((await member.boxSizes.list()).map((size) => [size.name, size.cpuMillis, size.memoryMiB])).toEqual([
      ["small", 2000, 4096],
      ["medium", 4000, 8192],
      ["large", 8000, 16_384],
    ]);

    // Spec step 5: large to 8 vCPU and 32 GB.
    const entries = await auditCount("box-size.updated");
    await admin.boxSizes.update({ name: "large", cpuMillis: 8000, memoryMiB: 32_768 });
    expect((await admin.boxSizes.list()).find((size) => size.name === "large")).toMatchObject({ cpuMillis: 8000, memoryMiB: 32_768 });
    expect(await auditCount("box-size.updated")).toBe(entries + 1);
    const entry = await harness.test.db.auditEntry.findFirstOrThrow({ where: { organizationId, action: "box-size.updated" }, orderBy: { createdAt: "desc" } });
    expect(entry).toMatchObject({ actorId: harness.fixture.a.admin.id, data: { size: "large", cpuMillis: 8000, memoryMiB: 32_768, memoryMiBBefore: 16_384 } });

    // A member, below the minimum CPU, below the minimum memory: each refused, nothing changed.
    await expect(member.boxSizes.update({ name: "small", cpuMillis: 1000, memoryMiB: 2048 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.boxSizes.update({ name: "small", cpuMillis: 499, memoryMiB: 2048 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.boxSizes.update({ name: "small", cpuMillis: 1000, memoryMiB: 1023 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await admin.boxSizes.list()).find((size) => size.name === "small")).toMatchObject({ cpuMillis: 2000, memoryMiB: 4096 });
    // The minimum itself is a size.
    await admin.boxSizes.update({ name: "small", cpuMillis: 500, memoryMiB: 1024 });
    expect((await admin.boxSizes.list()).find((size) => size.name === "small")).toMatchObject({ cpuMillis: 500, memoryMiB: 1024 });
    await admin.boxSizes.update({ name: "small", cpuMillis: 2000, memoryMiB: 4096 });
    expect(await auditCount("box-size.updated")).toBe(entries + 3);

    // Another organization's sizes are its own.
    const other = await harness.as(harness.fixture.b.admin);
    expect((await other.boxSizes.list()).find((size) => size.name === "large")).toMatchObject({ memoryMiB: 16_384 });
  });

  it("F-095/c2: a project's admins pick its default size and clear it; a member is refused, and another organization's admin finds no project", async () => {
    const { projectId } = await seedProject(harness, world, unique("sized"));
    const admin = await harness.as(harness.fixture.a.admin);
    expect(await admin.projects.runners({ projectId })).toMatchObject({ defaultBoxSize: null });

    await expect((await harness.as(harness.fixture.a.member)).projects.setDefaultBoxSize({ projectId, size: "small" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(harness.fixture.b.admin)).projects.setDefaultBoxSize({ projectId, size: "small" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await admin.projects.runners({ projectId })).toMatchObject({ defaultBoxSize: null });

    await makeProjectAdmin(projectId);
    const projectAdmin = await harness.as(harness.fixture.a.member);
    expect(await projectAdmin.projects.setDefaultBoxSize({ projectId, size: "medium" })).toMatchObject({ defaultBoxSize: "medium" });
    expect((await harness.test.db.project.findUniqueOrThrow({ where: { id: projectId } })).defaultBoxSize).toBe("medium");
    expect(await harness.test.db.auditEntry.count({ where: { organizationId, action: "project.default-box-size-set", entityId: projectId } })).toBe(1);
    expect(await admin.projects.setDefaultBoxSize({ projectId, size: null })).toMatchObject({ defaultBoxSize: null });
  });
});

describe("a project's pools (F-086)", () => {
  it("F-086/c1, F-091/c1: the project's pools are in the list's order with their shares, its admins set them, and the pools' admission looks again", async () => {
    const { projectId } = await seedProject(harness, world, unique("pooled"));
    const first = await seedPool("first");
    const second = await seedPool("second");
    const third = await seedPool("third");
    const admin = await harness.as(harness.fixture.a.admin);
    // A new project uses the default pool, as milestone 1's did.
    expect((await admin.projects.runners({ projectId })).pools.map((pool) => pool.isDefault)).toEqual([true]);

    harness.fakes.jobs.clear();
    const set = await admin.projects.setPools({
      projectId,
      pools: [
        { poolId: third, maxBoxes: 2 },
        { poolId: first, maxBoxes: null },
        { poolId: second, maxBoxes: 5 },
      ],
    });
    expect(set.pools.map((pool) => [pool.poolId, pool.maxBoxes])).toEqual([
      [third, 2],
      [first, null],
      [second, 5],
    ]);
    expect(set.listed).toBe(true);
    const rows = await harness.test.db.projectPool.findMany({ where: { projectId }, orderBy: { position: "asc" } });
    expect(rows.map((row) => [row.poolId, row.position, row.maxBoxes])).toEqual([
      [third, 0, 2],
      [first, 1, null],
      [second, 2, 5],
    ]);
    // The pools it had (the default) and has now each get `queue.admit`.
    const admitted = harness.fakes.jobs.jobs.filter((job) => job.job === "queue.admit").map((job) => JSON.stringify(job.payload));
    for (const poolId of [first, second, third]) {
      expect(admitted.some((payload) => payload.includes(poolId))).toBe(true);
    }
    expect(await harness.test.db.auditEntry.count({ where: { organizationId, action: "project.pools-set", entityId: projectId } })).toBe(1);

    // Reordered by a project admin who isn't an organization admin.
    await makeProjectAdmin(projectId);
    const projectAdmin = await harness.as(harness.fixture.a.member);
    expect(
      (
        await projectAdmin.projects.setPools({
          projectId,
          pools: [
            { poolId: first, maxBoxes: 1 },
            { poolId: third, maxBoxes: null },
          ],
        })
      ).pools.map((pool) => [pool.poolId, pool.maxBoxes]),
    ).toEqual([
      [first, 1],
      [third, null],
    ]);
  });

  it("F-086/c1: another organization's pool, a pool twice, a member and another organization's admin are refused, and the list stays", async () => {
    const { projectId } = await seedProject(harness, world, unique("guarded"));
    const mine = await seedPool("mine");
    const theirs = await seedPool("theirs", harness.fixture.b.organization.id);
    const admin = await harness.as(harness.fixture.a.admin);
    await admin.projects.setPools({ projectId, pools: [{ poolId: mine, maxBoxes: 3 }] });
    const before = await harness.test.db.projectPool.findMany({ where: { projectId } });

    await expect(admin.projects.setPools({ projectId, pools: [{ poolId: theirs, maxBoxes: null }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      admin.projects.setPools({
        projectId,
        pools: [
          { poolId: mine, maxBoxes: null },
          { poolId: theirs, maxBoxes: null },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      admin.projects.setPools({
        projectId,
        pools: [
          { poolId: mine, maxBoxes: null },
          { poolId: mine, maxBoxes: 2 },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.projects.setPools({ projectId, pools: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect((await harness.as(harness.fixture.a.member)).projects.setPools({ projectId, pools: [{ poolId: mine, maxBoxes: null }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(harness.fixture.b.admin)).projects.setPools({ projectId, pools: [{ poolId: theirs, maxBoxes: null }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await harness.as(harness.fixture.b.admin)).projects.runners({ projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await harness.test.db.projectPool.findMany({ where: { projectId } })).toEqual(before);
    expect(await harness.test.db.projectPool.count({ where: { poolId: theirs } })).toBe(0);
  });
});

describe("a profile's runner labels (F-069)", () => {
  it("F-069/c1: an admin sets a profile's labels, sorted and once each; reserved and malformed ones are refused, as are a member and another organization", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const saved = await admin.agentProfiles.save({
      name: unique("Labelled"),
      adapter: "opencode",
      modelId: null,
      instructions: null,
      approvalRules: [],
      planFirst: false,
      access: { kind: "everyone" },
      mcpServers: [],
      skills: [],
    });
    const profileId = saved.profileId;
    expect((await admin.agentProfiles.get({ profileId })).runnerLabels).toEqual([]);

    expect(await admin.agentProfiles.setRunnerLabels({ profileId, labels: ["tier:fast", "gpu", "tier:fast", "team/web"] })).toEqual({ runnerLabels: ["gpu", "team/web", "tier:fast"] });
    expect((await admin.agentProfiles.get({ profileId })).runnerLabels).toEqual(["gpu", "team/web", "tier:fast"]);
    expect((await admin.agentProfiles.list()).find((row) => row.id === profileId)?.runnerLabels).toEqual(["gpu", "team/web", "tier:fast"]);

    for (const refused of ["executor:docker", "os:linux", "arch:arm64", "Tier Fast", "-dash", "x".repeat(65)]) {
      await expect(admin.agentProfiles.setRunnerLabels({ profileId, labels: ["gpu", refused] }), refused).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect((await harness.as(harness.fixture.a.member)).agentProfiles.setRunnerLabels({ profileId, labels: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(harness.fixture.b.admin)).agentProfiles.setRunnerLabels({ profileId, labels: [] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: profileId } })).runnerLabels).toEqual(["gpu", "team/web", "tier:fast"]);

    // Cleared.
    expect(await admin.agentProfiles.setRunnerLabels({ profileId, labels: [] })).toEqual({ runnerLabels: [] });
  });
});

describe("New task's runner picker (F-069, F-014)", () => {
  /** A project on its own pools, with the built-in profile (which has the world's model). */
  const pickerWorld = async () => {
    const { projectId } = await seedProject(harness, world, unique("picked"));
    const fast = await seedPool("fast");
    const empty = await seedPool("empty");
    await (await harness.as(harness.fixture.a.admin)).projects.setPools({
      projectId,
      pools: [
        { poolId: empty, maxBoxes: null },
        { poolId: fast, maxBoxes: null },
      ],
    });
    await seedRunner({ name: "fast-01", kind: "pool", poolId: fast, labels: ["executor:docker", "tier:fast"] });
    const builtIn = await harness.test.db.agentProfile.findFirstOrThrow({ where: { organizationId, builtIn: true }, select: { id: true } });
    return { projectId, fast, empty, profileId: agentProfileIdSchema.parse(builtIn.id) };
  };

  it("F-069/c1: lists the project's pools in its order, each with whether it could take the task now and why not", async () => {
    const { projectId, fast, empty, profileId } = await pickerWorld();
    const member = await harness.as(harness.fixture.a.member);
    const admin = await harness.as(harness.fixture.a.admin);

    const choices = await member.tasks.runnerChoices({ projectId });
    expect(choices.pool.canRun).toBe(true);
    expect(choices.pool.reason).toBeNull();
    expect(choices.pool.pools.map((pool) => [pool.poolId, pool.canRun, pool.reason?.code ?? null])).toEqual([
      [empty, false, "no-runner-online"],
      [fast, true, null],
    ]);

    // The profile asks for a label no runner carries: no pool can, and the nearest miss names the labels.
    try {
      await admin.agentProfiles.setRunnerLabels({ profileId, labels: ["gpu"] });
      const labelled = await member.tasks.runnerChoices({ projectId, profileId });
      expect(labelled.pool.canRun).toBe(false);
      expect(labelled.pool.reason).toEqual({ code: "no-runner-with-labels", labels: ["gpu"] });
      expect(labelled.pool.pools.find((pool) => pool.poolId === fast)?.reason).toEqual({ code: "no-runner-with-labels", labels: ["gpu"] });
      await admin.agentProfiles.setRunnerLabels({ profileId, labels: ["tier:fast"] });
      expect((await member.tasks.runnerChoices({ projectId, profileId })).pool.canRun).toBe(true);
    } finally {
      await admin.agentProfiles.setRunnerLabels({ profileId, labels: [] });
    }

    // Another organization's admin can't ask about the project.
    await expect((await harness.as(harness.fixture.b.admin)).tasks.runnerChoices({ projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-014/c3, F-069/c2: offers only the member's own personal runners, each with whether it can and why not: offline, busy, no services, the provider not allowed", async () => {
    const { projectId } = await pickerWorld();
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const member = await harness.as(a.member);
    const laptop = await seedRunner({ name: "laptop", kind: "personal", ownerMemberId: a.member.id, slots: 1 });
    const desktop = await seedRunner({ name: "desktop", kind: "personal", ownerMemberId: a.member.id, connected: false });
    const theirs = await seedRunner({ name: "admins", kind: "personal", ownerMemberId: a.admin.id });

    const reasonsOf = async () => {
      const choices = await member.tasks.runnerChoices({ projectId });
      return new Map(choices.personal.map((runner) => [runner.runnerId, runner] as const));
    };
    try {
      // The provider is off on personal runners by default (Q47).
      let mine = await reasonsOf();
      expect([...mine.keys()].sort()).toEqual([laptop, desktop].sort());
      expect(mine.has(theirs)).toBe(false);
      expect(mine.get(desktop)).toMatchObject({ canRun: false, reason: "offline" });
      expect(mine.get(laptop)).toMatchObject({ canRun: false, reason: "provider-not-allowed" });

      await admin.providers.update({ providerId: world.providerId, allowOnPersonalRunners: true });
      mine = await reasonsOf();
      expect(mine.get(laptop)).toMatchObject({ canRun: true, reason: null, busy: 0, slots: 1 });

      // Busy: its one slot holds a box.
      await seedBusyBox(projectId, laptop);
      expect((await reasonsOf()).get(laptop)).toMatchObject({ canRun: false, reason: "busy", busy: 1, slots: 1 });

      // Services: a `host` runner starts none.
      const environment =
        (await harness.test.db.environment.findFirst({ where: { projectId }, select: { id: true } })) ??
        (await harness.test.db.environment.create({ data: { organizationId, projectId }, select: { id: true } }));
      await harness.test.db.service.create({ data: { id: randomUUID(), organizationId, projectId, environmentId: environment.id, name: "postgres", image: "postgres:17", variables: {} } });
      expect((await reasonsOf()).get(laptop)).toMatchObject({ canRun: false, reason: "needs-services" });
    } finally {
      await admin.providers.update({ providerId: world.providerId, allowOnPersonalRunners: false });
    }
  });

  it("F-014/c3: tasks.create refuses another member's personal runner and makes nothing; the member's own is taken", async () => {
    const { projectId } = await pickerWorld();
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const member = await harness.as(a.member);
    const mine = await seedRunner({ name: "own", kind: "personal", ownerMemberId: a.member.id });
    const theirs = await seedRunner({ name: "other", kind: "personal", ownerMemberId: a.admin.id });
    const pooled = await harness.test.db.runner.findFirstOrThrow({ where: { organizationId, kind: "pool", state: "online" }, select: { id: true } });
    try {
      await admin.providers.update({ providerId: world.providerId, allowOnPersonalRunners: true });
      const before = await harness.test.db.task.count({ where: { projectId } });
      await expect(member.tasks.create({ projectId, prompt: "on someone else's laptop", runnerId: theirs })).rejects.toMatchObject({ code: "FORBIDDEN" });
      // A pool runner isn't a personal runner to pick either.
      await expect(member.tasks.create({ projectId, prompt: "on a pool runner by name", runnerId: runnerIdSchema.parse(pooled.id) })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await harness.test.db.task.count({ where: { projectId } })).toBe(before);

      const created = await member.tasks.create({ projectId, prompt: "on my laptop", runnerId: mine });
      expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: created.taskId } })).runnerId).toBe(mine);
    } finally {
      await admin.providers.update({ providerId: world.providerId, allowOnPersonalRunners: false });
    }
  });
});
