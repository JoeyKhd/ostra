import { randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { CompareResult, LogRecord } from "@ostra/adapter-sdk";
import { ociClient, OCI_CONFIG, OCI_MANIFEST, startFakeOciRegistry } from "@ostra/adapter-sdk/testing/net";
import type { FakeOciRegistry, FakeRegistryCredential } from "@ostra/adapter-sdk/testing/net";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  dispatchTask,
  ensureBoxSizes,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  registryCheckFromDb,
  setRegistry,
  systemClock,
} from "@ostra/domain";
import type { Clock, MemberScope, RegistryDeps } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  dispatchBodySchema,
  memberIdSchema,
  registryCredentialSchema,
  runnerEventFrameSchema,
  runnerPaths,
  snapshotBuildBodySchema,
  snapshotIdSchema,
} from "@ostra/protocol";
import type { RegistryId, RunnerCapabilities, SnapshotId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { accessToken, postJson, registerPersonal, startGateway } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";
import { dispatchPayload, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { applySnapshotRunnerEvent, enqueueSnapshotInTx, snapshotScheduleHandler } from "../snapshots/snapshots.ts";
import type { SnapshotDeps } from "../snapshots/snapshots.ts";
import { registryCheckHandler } from "./check.ts";
import { handleRegistryEndpoint } from "./endpoints.ts";
import { createRegistryProbe } from "./probe.ts";

// Ticket 17 (F-120, ADR 0060): the organization's snapshot registry, against the fake OCI
// registry. The check's three results come from core's own calls; the push credential goes to the
// builder while it builds; the pull credential to the runner holding the task's current lease.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let harness: GatewayHarness;
let registry: FakeOciRegistry;
let poolId: string;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const REPO = "ostra-test/test1";
const digest = (fill: string): string => `sha256:${fill.repeat(64)}`;

const dockerCaps: RunnerCapabilities = { isolation: "container", services: true, boxSizes: true, snapshots: "image", registry: "optional", nodeWait: false };
const kubernetesCaps: RunnerCapabilities = { isolation: "container", services: true, boxSizes: true, snapshots: "image", registry: "required", nodeWait: true };

const admin = (): MemberScope => ({
  organizationId: world.organizationId,
  memberId: memberIdSchema.parse(fixture.a.admin.id),
  role: "admin",
  projectRoles: new Map(),
});

const registryDeps = (clock: Clock = systemClock): RegistryDeps => ({ db: test.db, audit: postgresAuditLog, notices: postgresChangeNotices, clock, jobs, adapters: { secretStore } });

const snapshotDeps = (): SnapshotDeps => ({ db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, codeHost, secretStore, logger });

const asCredential = (credential: FakeRegistryCredential) => ({ username: credential.username, token: credential.password });

/** The organization's registry, set as an admin sets it, pointing at `target`. */
const setTo = async (
  target: FakeOciRegistry,
  credentials: { readonly push: FakeRegistryCredential; readonly pull: FakeRegistryCredential },
  auth: "basic" | "node" = "basic",
): Promise<RegistryId> => {
  const result = await setRegistry(registryDeps(), admin(), {
    url: target.url,
    repositoryPrefix: "ostra",
    auth,
    push: asCredential(credentials.push),
    ...(auth === "basic" ? { pull: asCredential(credentials.pull) } : {}),
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.registryId;
};

/** Runs the queued `registry.check` as the worker would, and reads what it stored. */
const runCheck = async (registryId: RegistryId) => {
  const row = await test.db.registry.findUniqueOrThrow({ where: { id: registryId } });
  await registryCheckHandler({ db: test.db, notices: postgresChangeNotices, clock: systemClock, secretStore, probe: createRegistryProbe({ timeoutMs: 5_000 }) })({
    job: "registry.check",
    jobId: jobIdSchema.parse(randomUUID()),
    key: null,
    retryCount: 0,
    payload: { organizationId: world.organizationId, registryId, version: row.updatedAt.getTime() },
    logger,
  });
  const after = await test.db.registry.findUniqueOrThrow({ where: { id: registryId } });
  return { checkedAt: after.checkedAt, result: registryCheckFromDb(after.checkResult) };
};

/** A runner registered through the gateway (so it has a token), made a minor-4 runner of the pool. */
const poolRunner = async (executor: "docker" | "kubernetes", pool: string = poolId): Promise<RegisteredRunner> => {
  const registered = await registerPersonal(harness, test.db, fixture.a.member);
  await test.db.runner.update({
    where: { id: registered.runnerId },
    data: {
      kind: "pool",
      poolId: pool,
      ownerMemberId: null,
      executor,
      state: "online",
      capacity: 4,
      slots: 4,
      cpuMillis: 16_000,
      memoryMiB: 32_768,
      minor: 4,
      capabilities: executor === "docker" ? dockerCaps : kubernetesCaps,
      approvedAt: new Date(),
    },
  });
  await test.db.runnerPresence.create({
    data: { runnerId: registered.runnerId, organizationId: world.organizationId, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor: 4 },
  });
  return registered;
};

const tokenOf = async (runner: RegisteredRunner): Promise<string> => (await accessToken(harness, runner)).accessToken;

const pushCredential = async (snapshotId: string, runner: RegisteredRunner) =>
  postJson(`${harness.url}${runnerPaths.snapshotPushCredential(snapshotId)}`, {}, await tokenOf(runner));

const pullCredential = async (taskId: string, epoch: number, runner: RegisteredRunner) =>
  postJson(`${harness.url}${runnerPaths.taskPullCredential(taskId)}`, { leaseEpoch: epoch }, await tokenOf(runner));

/** One `snapshot.schedule`, run as the worker would. */
const scheduleBuild = async (): Promise<void> => {
  const payload = { organizationId: world.organizationId, projectId: world.projectId, reason: "environment-changed" as const };
  await test.db.$transaction((tx) => enqueueSnapshotInTx(jobs, tx, payload, "environment-changed"));
  await snapshotScheduleHandler(snapshotDeps())({ job: "snapshot.schedule", jobId: jobIdSchema.parse(randomUUID()), key: null, retryCount: 0, payload, logger });
  await jobs.cancelInTx(null, "snapshot.schedule", payload);
};

const buildCommands = async () =>
  (await test.db.command.findMany({ where: { organizationId: world.organizationId, kind: "snapshot_build" }, orderBy: { createdAt: "asc" } })).map((row) => ({
    runnerId: row.runnerId,
    body: snapshotBuildBodySchema.parse(row.body),
  }));

const credentialAudits = () =>
  test.db.auditEntry.findMany({ where: { organizationId: world.organizationId, action: "registry.credential-issued" }, orderBy: { createdAt: "asc" } });

/** A ready snapshot of the project, pushed to the organization's registry with `manifestDigest`. */
const pushedSnapshot = async (registryId: RegistryId, manifestDigest: string): Promise<SnapshotId> => {
  const environment = await test.db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
  const row = await test.db.snapshot.create({
    data: {
      organizationId: world.organizationId,
      projectId: world.projectId,
      environmentId: environment.id,
      reason: "environment-changed",
      state: "ready",
      registryId,
      builder: "docker",
      digest: manifestDigest,
      imageRef: `${registry.host}/ostra/${world.projectId}:pushed`,
      pushedAt: new Date(),
      readyAt: new Date(),
    },
    select: { id: true },
  });
  return snapshotIdSchema.parse(row.id);
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  await test.db.$transaction((tx) => ensureBoxSizes(tx, world.organizationId));
  const pool = await test.db.runnerPool.create({ data: { organizationId: world.organizationId, name: "fleet" }, select: { id: true } });
  poolId = pool.id;
  await test.db.projectPool.create({ data: { organizationId: world.organizationId, projectId: world.projectId, poolId } });
  registry = await startFakeOciRegistry({ auth: "bearer" });
  harness = await startGateway(test.db, test.url, {}, (gateway) => [
    handleRegistryEndpoint({ db: test.db, tokens: gateway.context.tokens, adapters: { secretStore }, audit: postgresAuditLog, clock: systemClock, logger }),
  ]);
});

beforeEach(async () => {
  // Each case starts with no registry, no runner online, no snapshot and no build.
  await test.db.runner.updateMany({ where: { organizationId: world.organizationId }, data: { state: "offline" } });
  await test.db.snapshot.deleteMany({ where: { organizationId: world.organizationId } });
  await test.db.command.deleteMany({ where: { organizationId: world.organizationId, kind: "snapshot_build" } });
  await test.db.registry.deleteMany({ where: { organizationId: world.organizationId } });
  const head: CompareResult = { aheadBy: 0, behindBy: 0, mergeBase: "c".repeat(40), files: [], filesTruncated: false, limits: { maxFiles: 300, maxPatchBytes: 1_000_000 } };
  codeHost.setCompare(REPO, "main", head, "main");
});

afterAll(async () => {
  await harness.stop();
  await registry.close();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("the snapshot registry (F-120)", () => {
  it("F-120: setting the registry keeps the credentials in the secret store, audits it and queues a check; only an admin may", async () => {
    const forbidden = await setRegistry(registryDeps(), { ...admin(), memberId: memberIdSchema.parse(fixture.a.member.id), role: "member" }, {
      url: registry.url,
      repositoryPrefix: "ostra",
      auth: "basic",
      push: asCredential(registry.push),
      pull: asCredential(registry.pull),
    });
    expect(forbidden).toMatchObject({ ok: false, error: "forbidden" });
    const setAt = Date.now() + 1_000_000;
    const set = await setRegistry(registryDeps({ now: () => setAt }), admin(), {
      url: registry.url,
      repositoryPrefix: "/ostra/",
      auth: "basic",
      push: asCredential(registry.push),
      pull: asCredential(registry.pull),
    });
    if (!set.ok) {
      throw new Error(set.message);
    }
    const registryId = set.registryId;
    const row = await test.db.registry.findUniqueOrThrow({ where: { id: registryId } });
    expect(row).toMatchObject({ url: registry.url, repositoryPrefix: "ostra", auth: "basic", checkedAt: null });
    // The row names the secret store's entries, never a credential.
    expect(JSON.stringify(row)).not.toContain(registry.push.password);
    expect(JSON.stringify(row)).not.toContain(registry.pull.password);
    const audit = await test.db.auditEntry.findFirstOrThrow({ where: { organizationId: world.organizationId, action: "registry.set" }, orderBy: { createdAt: "desc" } });
    expect(audit.entityId).toBe(registryId);
    expect(JSON.stringify(audit)).not.toContain(registry.push.password);
    // The check for this setting's version, queued in the same transaction.
    expect(await jobs.find("registry.check", { organizationId: world.organizationId, registryId, version: setAt })).toHaveLength(1);
    // A pull credential is needed unless the cluster pulls with its own identity.
    expect(
      await setRegistry(registryDeps(), admin(), { url: "registry.example.com", repositoryPrefix: "ostra", auth: "basic", push: asCredential(registry.push) }),
    ).toMatchObject({ ok: true });
    await test.db.registry.deleteMany({ where: { organizationId: world.organizationId } });
    expect(
      await setRegistry(registryDeps(), admin(), { url: "registry.example.com", repositoryPrefix: "ostra", auth: "basic", push: asCredential(registry.push) }),
    ).toMatchObject({ ok: false, error: "invalid-input" });
    expect(await setRegistry(registryDeps(), admin(), { url: "not a url", repositoryPrefix: "ostra", auth: "node", push: asCredential(registry.push) })).toMatchObject({
      ok: false,
      error: "invalid-input",
    });
  });

  it("F-120: the check's three results: push and pull allowed, pull only, refused; nothing is pushed", async () => {
    const both = await runCheck(await setTo(registry, { push: registry.push, pull: registry.pull }));
    expect(both.result).toMatchObject({ result: "push-and-pull" });
    expect(both.checkedAt).not.toBeNull();
    // The push scope was checked by an upload started and cancelled; no manifest and no blob was written.
    const requests = registry.requests();
    expect(requests.some((request) => request.method === "POST" && request.path === "/v2/ostra/ostra-registry-check/blobs/uploads/" && request.status === 202)).toBe(true);
    expect(requests.some((request) => request.method === "DELETE" && request.path.startsWith("/v2/ostra/ostra-registry-check/blobs/uploads/"))).toBe(true);
    expect(requests.filter((request) => request.method === "PUT" || request.method === "PATCH")).toEqual([]);

    // The pull credential given as the push one: core reads, but can't write.
    const pullOnly = await runCheck(await setTo(registry, { push: registry.pull, pull: registry.pull }));
    expect(pullOnly.result).toMatchObject({ result: "pull-only" });

    // Credentials the registry doesn't know.
    const wrong = { username: "nobody", password: "not-a-password", can: [] };
    const refused = await runCheck(await setTo(registry, { push: wrong, pull: wrong }));
    expect(refused.result).toMatchObject({ result: "refused", status: 401 });
    // The stored words never carry a credential.
    expect(JSON.stringify([both, pullOnly, refused])).not.toContain(registry.push.password);
    expect(JSON.stringify(records)).not.toContain(registry.push.password);
  });

  it("F-120: the check reads an existing snapshot's manifest with the pull credential, on a Basic-auth registry too", async () => {
    const basic = await startFakeOciRegistry({ auth: "basic" });
    try {
      const registryId = await setTo(basic, { push: basic.push, pull: basic.pull });
      // A snapshot pushed under the project's repository, as a build leaves it.
      const client = ociClient(basic.url, { username: basic.push.username, password: basic.push.password });
      const name = `ostra/${world.projectId}`;
      const config = Buffer.from("{}");
      const configDigest = await client.pushBlob(name, config);
      const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST, config: { mediaType: OCI_CONFIG, digest: configDigest, size: config.length }, layers: [] }));
      const manifestDigest = await client.pushManifest(name, "built", OCI_MANIFEST, manifest);
      await pushedSnapshot(registryId, manifestDigest);
      const before = basic.requests().length;
      const checked = await runCheck(registryId);
      expect(checked.result).toMatchObject({ result: "push-and-pull" });
      const read = basic.requests().slice(before).find((request) => request.method === "HEAD" && request.path === `/v2/${name}/manifests/${manifestDigest}`);
      expect(read).toMatchObject({ user: basic.pull.username, status: 200 });
    } finally {
      await basic.close();
    }
  });

  it("F-120: with a registry, a build pushes: the command names the ref, and the push credential goes to the builder only, while it builds", async () => {
    const registryId = await setTo(registry, { push: registry.push, pull: registry.pull });
    const builder = await poolRunner("docker");
    const stranger = await poolRunner("docker");
    await test.db.runner.update({ where: { id: stranger.runnerId }, data: { state: "offline" } });
    await scheduleBuild();
    const [command] = await buildCommands();
    const [row] = await test.db.snapshot.findMany({ where: { organizationId: world.organizationId } });
    expect(row).toMatchObject({ state: "building", runnerId: builder.runnerId, registryId, builder: "docker" });
    expect(command?.runnerId).toBe(builder.runnerId);
    expect(command?.body).toMatchObject({ builder: "docker", push: { ref: `${registry.host}/ostra/${world.projectId}:${row?.id ?? ""}` } });
    // No credential in the command.
    expect(JSON.stringify(command)).not.toContain(registry.push.password);
    const snapshotId = row?.id ?? "";

    const issued = await pushCredential(snapshotId, builder);
    expect(issued.status).toBe(200);
    expect(registryCredentialSchema.parse(issued.body)).toMatchObject({ registry: registry.host, username: registry.push.username, token: registry.push.password });
    // Another runner of the organization: refused.
    await test.db.runner.update({ where: { id: stranger.runnerId }, data: { state: "online" } });
    const other = await pushCredential(snapshotId, stranger);
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: { code: "not-the-builder" } });
    // One audit entry per issuance, naming the runner and the snapshot, never the credential.
    const audits = await credentialAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorKind: "runner", actorId: builder.runnerId, entityId: registryId, data: { kind: "push", snapshotId } });
    expect(JSON.stringify(audits)).not.toContain(registry.push.password);

    // Built: ready, named as the registry holds it, with when it got there; then no credential.
    await applySnapshotRunnerEvent(
      snapshotDeps(),
      { runnerId: builder.runnerId, organizationId: world.organizationId },
      runnerEventFrameSchema.parse({ type: "runner-event", at: Date.now(), event: { kind: "snapshot.built", snapshotId, imageDigest: digest("7"), durationMs: 90_000 } }),
    );
    const ready = await test.db.snapshot.findUniqueOrThrow({ where: { id: snapshotId } });
    expect(ready).toMatchObject({ state: "ready", digest: digest("7"), imageRef: `${registry.host}/ostra/${world.projectId}:${snapshotId}` });
    expect(ready.pushedAt).not.toBeNull();
    const after = await pushCredential(snapshotId, builder);
    expect(after.status).toBe(409);
    expect(await credentialAudits()).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(registry.push.password);
  });

  it("F-120: a kubernetes pool's runner builds with BuildKit and pushes, ahead of a docker runner", async () => {
    await setTo(registry, { push: registry.push, pull: registry.pull });
    await poolRunner("docker");
    const cluster = await poolRunner("kubernetes");
    await scheduleBuild();
    const [command] = await buildCommands();
    expect(command?.runnerId).toBe(cluster.runnerId);
    const [row] = await test.db.snapshot.findMany({ where: { organizationId: world.organizationId } });
    expect(row).toMatchObject({ state: "building", runnerId: cluster.runnerId, builder: "buildkit" });
    expect(command?.body).toMatchObject({ builder: "buildkit", push: { ref: `${registry.host}/ostra/${world.projectId}:${row?.id ?? ""}` } });
  });

  it("F-120: the pull credential goes to the runner holding the task's current lease, and is refused at a stale epoch", async () => {
    const registryId = await setTo(registry, { push: registry.push, pull: registry.pull });
    const snapshotId = await pushedSnapshot(registryId, digest("d"));
    const holder = await poolRunner("kubernetes");
    const task = await seedQueuedTask(test.db, world, fixture.a.member, null);
    const offered = await test.db.$transaction((tx) =>
      dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger }, dispatchPayload(task, 1)),
    );
    expect(offered).toMatchObject({ ok: true, runnerId: holder.runnerId });
    // The dispatch names the project's ready snapshot by digest; never a credential.
    const dispatch = await test.db.command.findFirstOrThrow({ where: { organizationId: world.organizationId, kind: "dispatch", taskId: task.taskId } });
    const body = dispatchBodySchema.parse(dispatch.body);
    expect(body.box?.image).toEqual({ ref: `${registry.host}/ostra/${world.projectId}:${snapshotId}`, digest: digest("d") });
    expect(JSON.stringify(dispatch)).not.toContain(registry.pull.password);

    // A second runner of the same organization and pool, online: refused.
    const other = await poolRunner("kubernetes");
    const refused = await pullCredential(task.taskId, 1, other);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "stale-lease", currentEpoch: 1 } });

    const issued = await pullCredential(task.taskId, 1, holder);
    expect(issued.status).toBe(200);
    expect(registryCredentialSchema.parse(issued.body)).toMatchObject({ registry: registry.host, username: registry.pull.username, token: registry.pull.password });
    const audits = await credentialAudits();
    expect(audits.filter((entry) => JSON.stringify(entry.data).includes(task.taskId))).toMatchObject([
      { actorKind: "runner", actorId: holder.runnerId, entityId: registryId, data: { kind: "pull", taskId: task.taskId, leaseEpoch: 1 } },
    ]);

    // The holder at an epoch that isn't the current one: refused.
    const stale = await pullCredential(task.taskId, 2, holder);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: "stale-lease" } });
    await test.db.task.update({ where: { id: task.taskId }, data: { leaseEpoch: 2 } });
    const superseded = await pullCredential(task.taskId, 1, holder);
    expect(superseded.status).toBe(409);
    expect(superseded.body).toMatchObject({ error: { code: "stale-lease", currentEpoch: 2 } });
    await test.db.task.update({ where: { id: task.taskId }, data: { leaseEpoch: 1 } });

    // With the cluster's own identity there's no pull credential to hand out.
    await test.db.registry.update({ where: { id: registryId }, data: { auth: "node", pullSecretId: null } });
    const nodeAuth = await pullCredential(task.taskId, 1, holder);
    expect(nodeAuth.status).toBe(409);
    expect(nodeAuth.body).toMatchObject({ error: { code: "no-image" } });
    expect(JSON.stringify(records)).not.toContain(registry.pull.password);
  });

  it("F-120: a kubernetes pool without a registry builds nothing, and its task waits for one", async () => {
    // The project's one pool holds one kubernetes runner and nothing else.
    const cluster = await test.db.runnerPool.create({ data: { organizationId: world.organizationId, name: "cluster" }, select: { id: true } });
    await test.db.projectPool.deleteMany({ where: { projectId: world.projectId } });
    await test.db.projectPool.create({ data: { organizationId: world.organizationId, projectId: world.projectId, poolId: cluster.id } });
    await poolRunner("kubernetes", cluster.id);
    await scheduleBuild();
    expect(await buildCommands()).toEqual([]);
    expect(await test.db.snapshot.findMany({ where: { organizationId: world.organizationId } })).toMatchObject([{ state: "queued", runnerId: null }]);
    const task = await seedQueuedTask(test.db, world, fixture.a.member, null);
    const result = await test.db.$transaction((tx) =>
      dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger }, dispatchPayload(task, 1)),
    );
    expect(result).toMatchObject({ ok: false });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).dispatchWait).toEqual({ code: "needs-registry", poolId: cluster.id });
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "stopped", stoppedReason: "requested" } });
    await test.db.projectPool.deleteMany({ where: { projectId: world.projectId } });
    await test.db.projectPool.create({ data: { organizationId: world.organizationId, projectId: world.projectId, poolId } });
  });

  it("F-120: a docker runner without a registry still builds and keeps its own snapshot (milestone 3's path)", async () => {
    const builder = await poolRunner("docker");
    await scheduleBuild();
    const [command] = await buildCommands();
    expect(command?.runnerId).toBe(builder.runnerId);
    expect(command?.body.push ?? null).toBeNull();
    const [row] = await test.db.snapshot.findMany({ where: { organizationId: world.organizationId } });
    expect(row).toMatchObject({ state: "building", registryId: null });
    // No registry: no push credential for it.
    expect((await pushCredential(row?.id ?? "", builder)).status).toBe(409);
  });
});
