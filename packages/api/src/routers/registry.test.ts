import { randomBytes } from "node:crypto";

import type { OrganizationId, ProjectId, RunnerId } from "@ostra/protocol";
import { organizationIdSchema, runnerIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedProject, trpcFailure } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 5, ticket 28 (F-120): the organization's snapshot registry through the panel's API.
// Every credential below is a value no answer, error or log line may hold.

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;
let organizationId: OrganizationId;
let projectId: ProjectId;

const PUSH = { username: "ostra-push", token: `push-token-${randomBytes(12).toString("hex")}` };
const PULL = { username: "ostra-pull", token: `pull-token-${randomBytes(12).toString("hex")}` };
const NEW_PUSH = { username: "ostra-push-2", token: `push-token-2-${randomBytes(12).toString("hex")}` };
const secrets = [PUSH.token, PULL.token, NEW_PUSH.token];

const SETTINGS = { url: "registry.example.com", repositoryPrefix: "ostra/snapshots", auth: "basic" as const };
const DIGEST = `sha256:${"ab".repeat(32)}`;

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
  organizationId = organizationIdSchema.parse(harness.fixture.a.organization.id);
  projectId = (await seedProject(harness, world, "registered")).projectId;
});

afterAll(async () => {
  await harness.dispose();
});

beforeEach(async () => {
  await (await harness.as(harness.fixture.a.admin)).registry.clear();
  harness.fakes.jobs.clear();
});

const admin = () => harness.as(harness.fixture.a.admin);
const checksQueued = () => harness.fakes.jobs.jobs.filter((job) => job.job === "registry.check");

/** Nothing the API answered, threw or logged holds a credential's value. */
const expectNoSecretIn = (value: unknown): void => {
  const text = JSON.stringify(value);
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
};

const seedKubernetesRunner = async (poolName: string): Promise<void> => {
  const pool = await harness.test.db.runnerPool.create({ data: { organizationId, name: poolName }, select: { id: true } });
  await harness.test.db.runner.create({
    data: { organizationId, kind: "pool", poolId: pool.id, name: `${poolName}-01`, publicKey: randomBytes(32).toString("base64url"), executor: "kubernetes", capacity: 4, version: "0.5.0", state: "online" },
  });
};

/** A ready snapshot of the project, pushed to the registry, built on a runner. */
const seedPushedSnapshot = async (registryId: string): Promise<{ readonly snapshotId: string; readonly runnerId: RunnerId }> => {
  const runner = await harness.test.db.runner.findFirstOrThrow({ where: { organizationId, executor: "kubernetes" }, select: { id: true } });
  const environment =
    (await harness.test.db.environment.findFirst({ where: { projectId }, select: { id: true } })) ??
    (await harness.test.db.environment.create({ data: { organizationId, projectId }, select: { id: true } }));
  const snapshot = await harness.test.db.snapshot.create({
    data: {
      organizationId,
      projectId,
      environmentId: environment.id,
      state: "ready",
      reason: "environment-changed",
      digest: DIGEST,
      runnerId: runner.id,
      registryId,
      builder: "buildkit",
      pushedAt: new Date(),
      readyAt: new Date(),
    },
    select: { id: true },
  });
  return { snapshotId: snapshot.id, runnerId: runnerIdSchema.parse(runner.id) };
};

describe("the registry (F-120)", () => {
  it("F-120/c1: an admin sets it and reads it back: the address, prefix and auth kind, each credential as set, never its value", async () => {
    await seedKubernetesRunner(`k8s-${randomBytes(3).toString("hex")}`);
    const caller = await admin();
    const before = await caller.registry.get();
    expect(before.registry).toBeNull();
    expect(before.poolsNeedingIt.length).toBeGreaterThan(0);

    const view = await caller.registry.set({ ...SETTINGS, push: PUSH, pull: PULL });
    expect(view.registry).toMatchObject({ url: "registry.example.com", repositoryPrefix: "ostra/snapshots", auth: "basic", pushSet: true, pullSet: true, check: null });
    expectNoSecretIn(view);
    expectNoSecretIn(await caller.registry.get());
    // The values are in the secret store, and the row holds its references only.
    expect(harness.fakes.secretStore.values().some((value) => value.includes(PUSH.token))).toBe(true);
    const row = await harness.test.db.registry.findUniqueOrThrow({ where: { organizationId } });
    expectNoSecretIn(row);
    expectNoSecretIn(await harness.test.db.auditEntry.findMany({ where: { organizationId, action: "registry.set" } }));
    expectNoSecretIn(harness.logs);
  });

  it("F-120/c1: a member and another organization's admin can't read, set, check or clear it, and another organization's settings are its own", async () => {
    const caller = await admin();
    await caller.registry.set({ ...SETTINGS, push: PUSH, pull: PULL });
    const member = await harness.as(harness.fixture.a.member);
    await expect(member.registry.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.registry.set({ ...SETTINGS, url: "evil.example.com" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.registry.check()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.registry.clear()).rejects.toMatchObject({ code: "FORBIDDEN" });

    const other = await harness.as(harness.fixture.b.admin);
    expect((await other.registry.get()).registry).toBeNull();
    await expect(other.registry.check()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await other.registry.clear()).toEqual({ cleared: false });
    await other.registry.set({ ...SETTINGS, url: "theirs.example.com", push: NEW_PUSH, pull: NEW_PUSH });
    expect((await caller.registry.get()).registry).toMatchObject({ url: "registry.example.com" });
    expect((await other.registry.get()).registry).toMatchObject({ url: "theirs.example.com" });
    await other.registry.clear();
    expect((await caller.registry.get()).registry).toMatchObject({ url: "registry.example.com", pushSet: true });
  });

  it("F-120/c1: no credential's value is in a refusal", async () => {
    const caller = await admin();
    const bad = await trpcFailure(caller.registry.set({ ...SETTINGS, url: "not a host!", push: PUSH, pull: PULL }));
    expect(bad.code).toBe("BAD_REQUEST");
    expectNoSecretIn(bad);
    // `basic` with no pull credential stored or given.
    const missing = await trpcFailure(caller.registry.set({ ...SETTINGS, push: PUSH }));
    expect(missing.code).toBe("BAD_REQUEST");
    expectNoSecretIn(missing);
    expect((await caller.registry.get()).registry).toBeNull();
    expectNoSecretIn(harness.logs);
  });

  it("F-120/c1: a credential left out keeps the stored one; one given replaces it, and the old value leaves the store", async () => {
    const caller = await admin();
    await caller.registry.set({ ...SETTINGS, push: PUSH, pull: PULL });
    const first = await harness.test.db.registry.findUniqueOrThrow({ where: { organizationId } });

    // A new prefix, no credentials: both kept, by reference.
    const kept = await caller.registry.set({ ...SETTINGS, repositoryPrefix: "ostra/other" });
    expect(kept.registry).toMatchObject({ repositoryPrefix: "ostra/other", pushSet: true, pullSet: true });
    const second = await harness.test.db.registry.findUniqueOrThrow({ where: { organizationId } });
    expect([second.pushSecretId, second.pullSecretId]).toEqual([first.pushSecretId, first.pullSecretId]);
    expect(harness.fakes.secretStore.values().some((value) => value.includes(PUSH.token))).toBe(true);

    // A new push credential: the pull one stays, the old push value is gone from the store.
    await caller.registry.set({ ...SETTINGS, push: NEW_PUSH });
    const third = await harness.test.db.registry.findUniqueOrThrow({ where: { organizationId } });
    expect(third.pullSecretId).toBe(first.pullSecretId);
    expect(third.pushSecretId).not.toBe(first.pushSecretId);
    expect(harness.fakes.secretStore.values().some((value) => value.includes(PUSH.token))).toBe(false);
    expect(harness.fakes.secretStore.values().some((value) => value.includes(NEW_PUSH.token))).toBe(true);
  });

  it("F-120/c1: the check is queued once per settings' version, and returns at once", async () => {
    const caller = await admin();
    await caller.registry.set({ ...SETTINGS, push: PUSH, pull: PULL });
    // The set queued the check for its version; asking again joins it.
    expect(checksQueued()).toHaveLength(1);
    const asked = await caller.registry.check();
    await caller.registry.check();
    expect(checksQueued()).toHaveLength(1);
    expect(checksQueued()[0]?.payload).toMatchObject({ organizationId, version: asked.version });
    expect((await caller.registry.get()).registry?.updatedAt).toBe(asked.version);

    // New settings, a new version: one more.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await caller.registry.set({ ...SETTINGS, repositoryPrefix: "ostra/next" });
    const again = await caller.registry.check();
    expect(again.version).toBeGreaterThan(asked.version);
    expect(checksQueued()).toHaveLength(2);
  });

  it("F-120/c1: lists the organization's snapshots in it, and the environment's snapshot says where it was pushed, what built it and on which runner", async () => {
    const caller = await admin();
    await seedKubernetesRunner(`k8s-${randomBytes(3).toString("hex")}`);
    const view = await caller.registry.set({ ...SETTINGS, push: PUSH, pull: PULL });
    const registryId = view.registry?.registryId ?? "";
    const { snapshotId, runnerId } = await seedPushedSnapshot(registryId);
    const ref = `registry.example.com/ostra/snapshots/${projectId}@${DIGEST}`;

    expect((await caller.registry.get()).snapshots).toEqual([expect.objectContaining({ snapshotId, projectId, projectName: "registered", digest: DIGEST, ref })]);
    const snapshot = await (await harness.as(harness.fixture.a.member)).environments.snapshot.get({ projectId });
    expect(snapshot.ready).toMatchObject({ snapshotId, digest: DIGEST, builder: "buildkit", runnerId, registry: { ref } });

    // Cleared: the row and its credentials go, the snapshot stops naming it, the image stays where it is.
    expect(await caller.registry.clear()).toEqual({ cleared: true });
    expect(await harness.test.db.registry.count({ where: { organizationId } })).toBe(0);
    expect(harness.fakes.secretStore.values().some((value) => value.includes(PUSH.token) || value.includes(PULL.token))).toBe(false);
    expect((await harness.test.db.snapshot.findUniqueOrThrow({ where: { id: snapshotId } })).registryId).toBeNull();
    expect(await harness.test.db.auditEntry.count({ where: { organizationId, action: "registry.cleared" } })).toBeGreaterThan(0);
    expect((await caller.registry.get()).snapshots).toEqual([]);
    expect((await (await harness.as(harness.fixture.a.member)).environments.snapshot.get({ projectId })).ready?.registry).toBeNull();
  });
});
