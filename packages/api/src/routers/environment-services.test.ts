import { randomBytes } from "node:crypto";

import { secretRefSchema } from "@ostra/adapter-sdk";
import { serviceVariablesFromDb, snapshotFailureColumn } from "@ostra/domain";
import { runnerIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, RepoId, RunnerId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { appendEvent, createApiHarness, seedConnectionAndModel, seedLease, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 40 (F-094, F-051, F-054; ADR 0038 amended, ADR 0052): the environment's services, checks
// and snapshot through the API. Project admins edit; members read, a secret by name only. A
// service's change, an environment's save and Rebuild queue one snapshot build; `environments.get`
// says where the project's tasks can run, and when its services have no runner to start them.

let harness: ApiHarness;
let projectId: ProjectId;
let repoId: RepoId;
let organizationId: OrganizationId;
let poolId: string;
const DB_PASSWORD = `pg-${randomBytes(8).toString("hex")}`;
const NEW_PASSWORD = `pg-${randomBytes(8).toString("hex")}`;

const service = (overrides: Record<string, unknown> = {}) => ({
  projectId,
  name: "db",
  image: "postgres:17",
  port: 5432,
  variables: [
    { kind: "plain" as const, name: "POSTGRES_USER", value: "app" },
    { kind: "secret" as const, name: "POSTGRES_PASSWORD", value: DB_PASSWORD },
  ],
  healthCheck: "pg_isready -U app",
  ...overrides,
});

const snapshotJobs = () => harness.fakes.jobs.jobs.filter((job) => job.job === "snapshot.schedule");

/** A runner of the project's pool (or a member's personal one), online now at `minor`. */
const onlineRunner = async (input: { readonly executor: "docker" | "host"; readonly personalOf?: string; readonly minor?: number; readonly name?: string }): Promise<RunnerId> => {
  const runner = await harness.test.db.runner.create({
    data: {
      organizationId,
      ...(input.personalOf === undefined ? { kind: "pool" as const, poolId } : { kind: "personal" as const, ownerMemberId: input.personalOf }),
      name: input.name ?? `runner-${randomBytes(3).toString("hex")}`,
      publicKey: randomBytes(32).toString("base64url"),
      executor: input.executor,
      capacity: 2,
      version: "0.0.0",
      state: "online",
    },
    select: { id: true },
  });
  await harness.test.db.runnerPresence.create({
    data: { runnerId: runner.id, organizationId, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor: input.minor ?? 2 },
  });
  return runnerIdSchema.parse(runner.id);
};

const environmentId = async (): Promise<string> => (await harness.test.db.environment.findUniqueOrThrow({ where: { projectId } })).id;

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  const seeded = await seedProject(harness, world, "services-env");
  projectId = seeded.projectId;
  repoId = seeded.repoId;
  organizationId = harness.fixture.a.organization.id;
  const pool = await harness.test.db.runnerPool.create({ data: { organizationId, name: "build-fleet" }, select: { id: true } });
  poolId = pool.id;
  // The project runs in build-fleet only, in place of the default pool it was made with.
  await harness.test.db.projectPool.deleteMany({ where: { projectId } });
  await harness.test.db.projectPool.create({ data: { organizationId, projectId, poolId } });
});

beforeEach(async () => {
  harness.fakes.jobs.clear();
  await harness.test.db.runner.updateMany({ where: { organizationId }, data: { state: "offline" } });
});

afterAll(async () => {
  await harness.dispose();
});

describe("services, checks and the snapshot through the API", () => {
  it("F-094/c1: a project admin edits the services, a member only reads them, and a secret is stored as a reference and never returned", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const member = await harness.as(harness.fixture.a.member);
    await expect(member.environments.services.save(service())).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { serviceId } = await admin.environments.services.save(service());
    const listed = await member.environments.services.list({ projectId });
    expect(listed).toEqual([
      {
        serviceId,
        name: "db",
        image: "postgres:17",
        port: 5432,
        variables: [
          { kind: "plain", name: "POSTGRES_USER", value: "app" },
          { kind: "secret", name: "POSTGRES_PASSWORD", set: true },
        ],
        healthCheck: "pg_isready -U app",
        lastBox: null,
        previewLabel: null,
      },
    ]);
    // Stored as a reference in the secret store; the value is in no output and no row.
    const row = await harness.test.db.service.findUniqueOrThrow({ where: { id: serviceId } });
    const [, secret] = serviceVariablesFromDb(row.variables);
    if (secret?.kind !== "secret") {
      throw new Error("the secret wasn't stored as one");
    }
    expect(secretRefSchema.safeParse(secret.secretRef).success).toBe(true);
    expect((await harness.fakes.secretStore.get(organizationId, secret.secretRef)).ok).toBe(true);
    expect(JSON.stringify([listed, row, await admin.environments.get({ projectId })])).not.toContain(DB_PASSWORD);

    // Saved again without the value, it keeps it; with a new one, the old reference goes.
    await admin.environments.services.save(service({ serviceId, variables: [{ kind: "secret", name: "POSTGRES_PASSWORD" }] }));
    const kept = serviceVariablesFromDb((await harness.test.db.service.findUniqueOrThrow({ where: { id: serviceId } })).variables);
    expect(kept).toEqual([{ kind: "secret", name: "POSTGRES_PASSWORD", secretRef: secret.secretRef }]);
    await admin.environments.services.save(service({ serviceId, variables: [{ kind: "secret", name: "POSTGRES_PASSWORD", value: NEW_PASSWORD }] }));
    expect((await harness.fakes.secretStore.get(organizationId, secret.secretRef)).ok).toBe(false);
    await expect(admin.environments.services.save(service({ name: "db" }))).rejects.toMatchObject({ code: "CONFLICT", message: "A service with that name exists." });
    await expect(admin.environments.services.save(service({ name: "cache", variables: [{ kind: "secret", name: "TOKEN" }] }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.environments.services.save(service({ name: "cache", image: "not an image" }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(member.environments.services.delete({ projectId, serviceId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(JSON.stringify(harness.logs)).not.toContain(NEW_PASSWORD);
  });

  it("F-051/c2: a service's change, an environment's save and Rebuild each queue one snapshot build; a check's change queues none", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const { serviceId } = await admin.environments.services.save(service({ name: "cache", image: "redis:7", port: 6379, variables: [], healthCheck: null }));
    await admin.environments.services.save(service({ serviceId, name: "cache", image: "redis:7.4", port: 6379, variables: [], healthCheck: null }));
    expect(snapshotJobs().map((job) => job.payload)).toEqual([{ organizationId, projectId, reason: "environment-changed" }]);
    harness.fakes.jobs.clear();
    await admin.environments.services.delete({ projectId, serviceId });
    expect(snapshotJobs()).toHaveLength(1);
    harness.fakes.jobs.clear();
    await admin.environments.save({ projectId, environment: { baseImage: null, setupScript: "pnpm install", envFiles: [], entries: [] } });
    expect(snapshotJobs().map((job) => job.payload)).toEqual([{ organizationId, projectId, reason: "environment-changed" }]);
    harness.fakes.jobs.clear();
    await admin.environments.snapshot.rebuild({ projectId });
    expect(snapshotJobs().map((job) => job.payload)).toEqual([{ organizationId, projectId, reason: "rebuild" }]);
    harness.fakes.jobs.clear();
    await admin.environments.checks.save({ projectId, name: "lint", command: "pnpm lint", repoId: null, timeoutSeconds: 600 });
    expect(snapshotJobs()).toHaveLength(0);
    const member = await harness.as(harness.fixture.a.member);
    await expect(member.environments.snapshot.rebuild({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("F-054/c1: checks list in their order with their repo and timeout; a project admin adds one last, reorders, edits and removes them", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const member = await harness.as(harness.fixture.a.member);
    await harness.test.db.check.deleteMany({ where: { projectId } });
    const typecheck = await admin.environments.checks.save({ projectId, name: "typecheck", command: "pnpm typecheck", repoId, timeoutSeconds: 600 });
    const test = await admin.environments.checks.save({ projectId, name: "test", command: "pnpm test", repoId: null, timeoutSeconds: 90 });
    const diff = await admin.environments.checks.save({ projectId, name: "diff", command: "git diff --check origin/main...HEAD", repoId, timeoutSeconds: 60 });
    expect(await member.environments.checks.list({ projectId })).toEqual([
      { checkId: typecheck.checkId, name: "typecheck", command: "pnpm typecheck", repoId, repoFullName: "ostra-test/test1", timeoutSeconds: 600, position: 1 },
      { checkId: test.checkId, name: "test", command: "pnpm test", repoId: null, repoFullName: null, timeoutSeconds: 90, position: 2 },
      { checkId: diff.checkId, name: "diff", command: "git diff --check origin/main...HEAD", repoId, repoFullName: "ostra-test/test1", timeoutSeconds: 60, position: 3 },
    ]);
    const reordered = await admin.environments.checks.reorder({ projectId, checkIds: [diff.checkId, typecheck.checkId, test.checkId] });
    expect(reordered.map((check) => [check.name, check.position])).toEqual([
      ["diff", 1],
      ["typecheck", 2],
      ["test", 3],
    ]);
    await expect(admin.environments.checks.reorder({ projectId, checkIds: [diff.checkId, typecheck.checkId] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A new check goes last, after the new order.
    const format = await admin.environments.checks.save({ projectId, name: "format", command: "pnpm format:check", repoId: null, timeoutSeconds: 60 });
    expect((await member.environments.checks.list({ projectId })).map((check) => check.name)).toEqual(["diff", "typecheck", "test", "format"]);
    await admin.environments.checks.delete({ projectId, checkId: format.checkId });
    await admin.environments.checks.save({ projectId, checkId: test.checkId, name: "test", command: "pnpm test --run", repoId: null, timeoutSeconds: 120 });
    await admin.environments.checks.delete({ projectId, checkId: typecheck.checkId });
    expect((await member.environments.checks.list({ projectId })).map((check) => [check.name, check.command, check.timeoutSeconds, check.position])).toEqual([
      ["diff", "git diff --check origin/main...HEAD", 60, 1],
      ["test", "pnpm test --run", 120, 2],
    ]);
    await expect(member.environments.checks.save({ projectId, name: "x", command: "true", repoId: null, timeoutSeconds: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.environments.checks.reorder({ projectId, checkIds: [test.checkId, diff.checkId] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.environments.checks.delete({ projectId, checkId: diff.checkId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.environments.checks.save({ projectId, name: "diff", command: "true", repoId: null, timeoutSeconds: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("F-051: the snapshot's state reads back: none, queued waiting for a docker runner, building, ready on its runner, and the last failure's reason", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const member = await harness.as(harness.fixture.a.member);
    await harness.test.db.snapshot.deleteMany({ where: { projectId } });
    // The audit log is append-only (F-073): the Rebuild below is the newest request, so it names who asked.
    const builder = await onlineRunner({ executor: "docker", name: "build-01" });
    expect(await member.environments.snapshot.get({ projectId })).toMatchObject({
      kind: "image",
      hostInstead: "worktree-and-dependency-cache",
      ready: null,
      pending: null,
      lastFailure: null,
      waitingForDockerRunner: false,
    });
    const base = { organizationId, projectId, environmentId: await environmentId() };
    const ready = await harness.test.db.snapshot.create({
      data: {
        ...base,
        reason: "lockfile-changed",
        state: "ready",
        runnerId: builder,
        digest: `sha256:${"9c41e2a".padEnd(64, "0")}`,
        imageRef: "ostra-snapshot/x:y",
        buildDurationMs: 161_000,
        secretScan: "passed",
        readyAt: new Date(Date.now() - 2 * 3_600_000),
        createdAt: new Date(Date.now() - 3 * 3_600_000),
      },
    });
    await admin.environments.snapshot.rebuild({ projectId });
    const failed = await harness.test.db.snapshot.create({
      data: { ...base, reason: "rebuild", state: "failed", runnerId: builder, failedReason: snapshotFailureColumn("setup-failed", "pnpm install exited with 1\nERR_PNPM") },
    });
    const queued = await harness.test.db.snapshot.create({ data: { ...base, reason: "rebuild", state: "queued" } });
    const adminName = (await harness.test.db.member.findUniqueOrThrow({ where: { id: harness.fixture.a.admin.id }, select: { user: { select: { name: true } } } })).user.name;
    const view = await member.environments.snapshot.get({ projectId });
    expect(view).toMatchObject({
      kind: "image",
      ready: { snapshotId: ready.id, durationMs: 161_000, runnerName: "build-01", digest: ready.digest, reason: "lockfile-changed", requestedBy: null, secretScan: "passed" },
      pending: { snapshotId: queued.id, state: "queued", runnerName: null, reason: "rebuild", requestedBy: adminName },
      lastFailure: { snapshotId: failed.id, reason: "setup-failed", detail: "pnpm install exited with 1\nERR_PNPM", runnerName: "build-01" },
      waitingForDockerRunner: false,
    });
    expect(view.ready?.builtAt).toBe(ready.readyAt?.getTime());
    // The docker runner goes offline: the queued build waits, and the page says so.
    await harness.test.db.runner.update({ where: { id: builder }, data: { state: "offline" } });
    expect(await member.environments.snapshot.get({ projectId })).toMatchObject({ pending: { state: "queued" }, waitingForDockerRunner: true });
    await harness.test.db.snapshot.update({ where: { id: queued.id }, data: { state: "building", runnerId: builder } });
    expect(await member.environments.snapshot.get({ projectId })).toMatchObject({ pending: { state: "building", runnerName: "build-01" }, waitingForDockerRunner: false });
    // With only host runners in the pools, there's no image: a worktree and a dependency cache.
    await harness.test.db.runner.update({ where: { id: builder }, data: { revokedAt: new Date(), state: "revoked" } });
    await onlineRunner({ executor: "host" });
    expect(await member.environments.snapshot.get({ projectId })).toMatchObject({ kind: "host-cache" });
  });

  it("F-094/c3: environments.get flags services with no runner that can start them, with the pools, the runners that can and the executors online, and each service's health on its last box", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const member = await harness.as(harness.fixture.a.member);
    await harness.test.db.service.deleteMany({ where: { projectId } });
    await harness.test.db.runner.updateMany({ where: { organizationId }, data: { state: "revoked", revokedAt: new Date() } });
    expect((await member.environments.get({ projectId })).whereTasksRun).toEqual({
      pools: [{ poolId, name: "build-fleet" }],
      servicesRunnersOnline: 0,
      executorsOnline: [],
      poolExecutors: [],
      services: 0,
      noServicesRunner: false,
    });
    const { serviceId } = await admin.environments.services.save(service({ variables: [] }));
    await onlineRunner({ executor: "host" });
    await onlineRunner({ executor: "host", personalOf: harness.fixture.a.member.id, name: "alex-mbp" });
    // A docker runner below minor 2 can't start them either.
    await onlineRunner({ executor: "docker", minor: 1 });
    expect((await member.environments.get({ projectId })).whereTasksRun).toMatchObject({
      servicesRunnersOnline: 0,
      executorsOnline: ["docker", "host"],
      services: 1,
      noServicesRunner: true,
    });
    const docker = await onlineRunner({ executor: "docker", name: "build-02" });
    expect((await member.environments.get({ projectId })).whereTasksRun).toMatchObject({ servicesRunnersOnline: 1, poolExecutors: ["docker", "host"], noServicesRunner: false });

    // The service's health is read from the last box that ran it.
    const task = await seedTask(harness, { organizationId, projectId, state: "running" });
    await seedLease(harness, task, organizationId, projectId, docker);
    const box = await harness.test.db.box.findFirstOrThrow({ where: { taskId: task.taskId } });
    await harness.test.db.session.update({ where: { id: task.sessionId }, data: { boxId: box.id } });
    await appendEvent(harness, task, { organizationId, projectId }, { kind: "service.healthy", name: "db", afterMs: 4_000 });
    expect((await member.environments.services.list({ projectId }))[0]?.lastBox).toMatchObject({ state: "healthy", runnerName: "build-02", afterMs: 4_000, reason: null });
    await appendEvent(harness, task, { organizationId, projectId }, { kind: "service.failed", name: "db", reason: "health check timed out" });
    expect((await member.environments.services.list({ projectId }))[0]).toMatchObject({ serviceId, lastBox: { state: "failed", runnerName: "build-02", reason: "health check timed out" } });
  });

  it("F-094/c1: another organization's environments are invisible", async () => {
    const theirs = await harness.as(harness.fixture.b.admin);
    await expect(theirs.environments.services.list({ projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(theirs.environments.checks.list({ projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(theirs.environments.snapshot.get({ projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(theirs.environments.services.save(service({ name: "theirs" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(theirs.environments.snapshot.rebuild({ projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await harness.test.db.service.count({ where: { name: "theirs" } })).toBe(0);
    // Their own project has none of ours.
    const ownProject = harness.fixture.b.project.id;
    await harness.test.db.environment.create({ data: { organizationId: harness.fixture.b.organization.id, projectId: ownProject, status: "saved" } });
    expect(await theirs.environments.services.list({ projectId: ownProject })).toEqual([]);
    expect(await theirs.environments.checks.list({ projectId: ownProject })).toEqual([]);
    expect(await theirs.environments.snapshot.get({ projectId: ownProject })).toMatchObject({ ready: null, pending: null });
  });
});
