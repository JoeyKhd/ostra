import { randomBytes, randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { CompareResult, LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { dispatchTask, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, scheduleSnapshot, snapshotFailureFromDb, systemClock } from "@ostra/domain";
import type { JobPayload } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { JobHandler, Jobs } from "@ostra/jobs";
import {
  commandIdSchema,
  commandSeqSchema,
  connectionIdSchema,
  leaseEpochSchema,
  runnerEventFrameSchema,
  runnerPaths,
  snapshotBuildBodySchema,
  snapshotCredentialsSchema,
  snapshotIdSchema,
  taskSpecSchema,
  webhookDeliveryIdSchema,
} from "@ostra/protocol";
import type { OrganizationId, RunnerId, SnapshotId, TaskSpec } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { githubWebhookHandler } from "../code-host/pull-requests.ts";
import { buildTaskSpec } from "../dispatch/task-spec.ts";
import { ackingHooks } from "../gateway/context.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connect, accessToken, postJson, registerPersonal, startGateway } from "../testing/harness.ts";
import { dispatchPayload, ENV_SECRET, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { handleSnapshotEndpoint } from "./endpoints.ts";
import {
  applySnapshotCommandResultsInTx,
  applySnapshotRunnerEvent,
  enqueueSnapshotInTx,
  requeueSnapshots,
  snapshotNightlyHandler,
  snapshotScheduleHandler,
  snapshotsOnPush,
} from "./snapshots.ts";
import type { SnapshotDeps } from "./snapshots.ts";

// Ticket 26 (F-051, ADR 0038 amended): a project's snapshot is built by a `docker` runner of its
// pools, on its triggers, once a minute at most; a failed build leaves the ready one in use; the
// spec names the ready snapshot only to the runner that holds it, and a `host` runner its cache.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let otherWorld: World;
let poolId: string;
let otherPoolId: string;
let connectionId: ReturnType<typeof connectionIdSchema.parse>;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const SETUP_SECRET = `setup-secret-${randomBytes(8).toString("hex")}`;
const REPO = "ostra-test/test1";
const digest = (fill: string): string => `sha256:${fill.repeat(64)}`;

const deps = (): SnapshotDeps => ({
  db: test.db,
  jobs,
  outbox: postgresCommandOutbox,
  notices: postgresChangeNotices,
  clock: systemClock,
  codeHost,
  secretStore,
  logger,
});

const run = <N extends "snapshot.schedule" | "snapshot.nightly">(handler: JobHandler<N>, job: N, payload: JobPayload<N>): Promise<void> =>
  handler({ job, jobId: jobIdSchema.parse(randomUUID()), key: null, retryCount: 0, payload, logger });

/** The queued `snapshot.schedule` jobs of a project and reason: the triggers' output. */
const queuedJobs = async (payload: JobPayload<"snapshot.schedule">): Promise<number> =>
  (await jobs.find("snapshot.schedule", payload)).filter((job) => job.state === "created").length;

/** Runs a queued trigger's job as the worker would, then takes it off the queue. */
const work = async (payload: JobPayload<"snapshot.schedule">): Promise<void> => {
  await run(snapshotScheduleHandler(deps()), "snapshot.schedule", payload);
  await jobs.cancelInTx(null, "snapshot.schedule", payload);
};

const trigger = async (reason: JobPayload<"snapshot.schedule">["reason"], target: World = world): Promise<JobPayload<"snapshot.schedule">> => {
  const payload = { organizationId: target.organizationId, projectId: target.projectId, reason };
  await test.db.$transaction((tx) => enqueueSnapshotInTx(jobs, tx, payload, reason));
  return payload;
};

const snapshotsOf = (target: World = world) => test.db.snapshot.findMany({ where: { projectId: target.projectId }, orderBy: { createdAt: "asc" } });
const buildCommands = (target: World = world) =>
  test.db.command.findMany({ where: { organizationId: target.organizationId, kind: "snapshot_build" }, orderBy: { createdAt: "asc" } });

/** A `docker` runner of the project's pool, online at `minor`. */
const dockerRunner = async (pool: string = poolId, organizationId: OrganizationId = world.organizationId, minor = 2, capacity = 4): Promise<RunnerRef> => {
  const runner = await seedOnlineRunner(test.db, organizationId, { kind: "pool", poolId: pool }, capacity);
  await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { minor } });
  return runner;
};

/** The runner reports a build's result in a `runner-event` frame, as the gateway hands it on. */
const report = (runner: RunnerRef, event: Record<string, unknown>) =>
  applySnapshotRunnerEvent(deps(), runner, runnerEventFrameSchema.parse({ type: "runner-event", at: Date.now(), event }));

const built = (runner: RunnerRef, snapshotId: string, fill = "a") => report(runner, { kind: "snapshot.built", snapshotId, imageDigest: digest(fill), durationMs: 161_000 });

/** The default branch's head, as a compare of `main` with itself reads it. */
const setHead = (sha: string): void => {
  const result: CompareResult = { aheadBy: 0, behindBy: 0, mergeBase: sha, files: [], filesTruncated: false, limits: { maxFiles: 300, maxPatchBytes: 1_000_000 } };
  codeHost.setCompare(REPO, "main", result, "main");
};

const pushPayload = (ref: string, paths: readonly string[] | null) => ({
  ref,
  before: "1".repeat(40),
  after: "2".repeat(40),
  repository: { id: `host-${REPO}`, full_name: REPO },
  installation: { id: 777 },
  ...(paths === null ? {} : { commits: [{ added: [], removed: [], modified: paths }] }),
});

const push = (payload: unknown) =>
  githubWebhookHandler({
    db: test.db,
    jobs,
    notices: postgresChangeNotices,
    audit: postgresAuditLog,
    clock: systemClock,
    codeHost,
    secretStore,
    logger,
    onPush: (input) => snapshotsOnPush(deps(), input),
  })({
    organizationId: world.organizationId,
    connectionId,
    deliveryId: webhookDeliveryIdSchema.parse(randomUUID()),
    event: "push",
    payload,
    receivedAt: Date.now(),
    logger,
  });

/** A task dispatched in the project's pools (or to `runnerId`, a personal runner), and its spec. */
const dispatchedSpec = async (runnerId: RunnerId | null): Promise<{ readonly runnerId: RunnerId; readonly spec: TaskSpec }> => {
  const task = await seedQueuedTask(test.db, world, fixture.a.member, runnerId);
  const offered = await test.db.$transaction((tx) =>
    dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger }, dispatchPayload(task, 1)),
  );
  if (!offered.ok) {
    throw new Error(offered.message);
  }
  const spec = await buildTaskSpec({ db: test.db, codeHost, secretStore }, { taskId: task.taskId, runnerId: offered.runnerId, leaseEpoch: leaseEpochSchema.parse(1) });
  if (!spec.ok) {
    throw new Error(spec.message);
  }
  return { runnerId: offered.runnerId, spec: taskSpecSchema.parse(spec.spec) };
};

/** A ready snapshot on `runner`, through a build and its report. */
const readySnapshot = async (runner: RunnerRef, fill = "a"): Promise<SnapshotId> => {
  await work(await trigger("environment-changed"));
  const [row] = (await snapshotsOf()).filter((snapshot) => snapshot.state === "building");
  if (row === undefined) {
    throw new Error("no build went out");
  }
  await built(runner, row.id, fill);
  return snapshotIdSchema.parse(row.id);
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  otherWorld = await seedWorld(test.db, { codeHost, secretStore }, fixture.b.organization.id, fixture.b.project.id, { fullName: "ostra-test/other" });
  const repo = await test.db.repo.findUniqueOrThrow({ where: { id: world.repoId } });
  connectionId = connectionIdSchema.parse(repo.connectionId);
  const environment = await test.db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
  const setupRef = await secretStore.put({ organizationId: world.organizationId, purpose: "environment.secret" }, SETUP_SECRET);
  if (!setupRef.ok) {
    throw new Error("the fake secret store refused");
  }
  await test.db.environmentEntry.create({
    data: {
      organizationId: world.organizationId,
      projectId: world.projectId,
      environmentId: environment.id,
      repoId: world.repoId,
      kind: "secret",
      name: "NPM_TOKEN",
      secretRef: setupRef.value,
      availableDuringSetup: true,
    },
  });
  const pool = await test.db.runnerPool.create({ data: { organizationId: world.organizationId, name: "build-fleet" }, select: { id: true } });
  poolId = pool.id;
  await test.db.projectPool.create({ data: { organizationId: world.organizationId, projectId: world.projectId, poolId } });
  const other = await test.db.runnerPool.create({ data: { organizationId: otherWorld.organizationId, name: "their-fleet" }, select: { id: true } });
  otherPoolId = other.id;
  await test.db.projectPool.create({ data: { organizationId: otherWorld.organizationId, projectId: otherWorld.projectId, poolId: otherPoolId } });
});

beforeEach(async () => {
  // Each case starts with no runner online and no snapshot, so what it seeds is all there is.
  await test.db.runner.updateMany({ where: { organizationId: world.organizationId }, data: { state: "offline" } });
  await test.db.snapshot.deleteMany({ where: { organizationId: world.organizationId } });
  await test.db.command.deleteMany({ where: { organizationId: world.organizationId, kind: "snapshot_build" } });
  setHead("c".repeat(40));
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("snapshots (F-051)", () => {
  it("F-051: a docker runner builds the snapshot over the protocol: the command, its credentials, its result", async () => {
    const harness = await startGateway(
      test.db,
      test.url,
      {
        hooks: {
          ...ackingHooks,
          runnerEvent: (runner, frame) => applySnapshotRunnerEvent(deps(), runner, frame),
          onCommandResultsInTx: (tx, runner, results) => applySnapshotCommandResultsInTx(deps(), tx, runner, results),
        },
      },
      (gateway) => [handleSnapshotEndpoint({ db: test.db, tokens: gateway.context.tokens, adapters: { codeHost, secretStore }, audit: postgresAuditLog, clock: systemClock, logger })],
    );
    try {
      const registered = await registerPersonal(harness, test.db, fixture.a.member);
      await test.db.runner.update({ where: { id: registered.runnerId }, data: { kind: "pool", poolId, ownerMemberId: null, executor: "docker" } });
      const peer = await connect(harness, registered);
      // The runner is online once the server answered its hello.
      await peer.next("welcome");
      await work(await trigger("environment-changed"));
      const command = await peer.next("command");
      expect(command.kind).toBe("snapshot-build");
      const body = snapshotBuildBodySchema.parse(command.body);
      expect(body.projectId).toBe(world.projectId);
      expect(body.environment).toMatchObject({
        setupScript: "pnpm install",
        repos: [
          {
            fullName: REPO,
            cloneUrl: `https://github.example/${REPO}.git`,
            variables: [{ name: "NODE_ENV", value: "test", availableDuringSetup: true }],
            setupSecrets: { variables: ["NPM_TOKEN"], files: [] },
          },
        ],
      });
      // The command names the setup secret, never a secret's value.
      expect(JSON.stringify(command)).not.toContain(SETUP_SECRET);
      expect(JSON.stringify(command)).not.toContain(ENV_SECRET);
      const [row] = await snapshotsOf();
      expect(row).toMatchObject({ id: body.snapshotId, state: "building", runnerId: registered.runnerId, reason: "environment-changed" });

      // The setup secrets come from the credentials endpoint, for the runner the build went to only.
      const token = await accessToken(harness, registered);
      const credentials = await postJson(`${harness.url}${runnerPaths.snapshotCredentials(body.snapshotId)}`, { snapshotId: body.snapshotId }, token.accessToken);
      expect(credentials.status).toBe(200);
      const issued = snapshotCredentialsSchema.parse(credentials.body);
      expect(issued.secrets).toEqual([{ repoId: world.repoId, entries: [{ kind: "variable", name: "NPM_TOKEN", value: SETUP_SECRET, availableDuringSetup: true }] }]);
      expect(JSON.stringify(issued)).not.toContain(ENV_SECRET);
      expect(codeHost.minted.at(-1)?.permissions).toEqual({ contents: "read", metadata: "read" });
      const stranger = await registerPersonal(harness, test.db, fixture.a.member);
      const refused = await postJson(
        `${harness.url}${runnerPaths.snapshotCredentials(body.snapshotId)}`,
        { snapshotId: body.snapshotId },
        (await accessToken(harness, stranger)).accessToken,
      );
      expect(refused.status).toBe(409);

      peer.send({ type: "runner-event", at: Date.now(), event: { kind: "snapshot.built", snapshotId: body.snapshotId, imageDigest: digest("9"), durationMs: 161_000 } });
      const until = Date.now() + 10_000;
      while ((await test.db.snapshot.findUniqueOrThrow({ where: { id: body.snapshotId } })).state !== "ready" && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await test.db.snapshot.findUniqueOrThrow({ where: { id: body.snapshotId } })).toMatchObject({
        state: "ready",
        runnerId: registered.runnerId,
        digest: digest("9"),
        imageRef: `ostra-snapshot/${world.projectId}:${body.snapshotId}`,
        buildDurationMs: 161_000,
        secretScan: "passed",
      });
      expect(JSON.stringify(records)).not.toContain(SETUP_SECRET);
      peer.close();
    } finally {
      await harness.stop();
    }
  });

  it("F-051: each trigger queues one build: the environment's change, a lockfile pushed to the default branch, the nightly when the branch moved", async () => {
    const runner = await dockerRunner();
    // The environment changed (the panel enqueues it, ticket 40): one job, one build, one command.
    const changed = await trigger("environment-changed");
    expect(await queuedJobs(changed)).toBe(1);
    await work(changed);
    expect(await snapshotsOf()).toHaveLength(1);
    expect(await buildCommands()).toHaveLength(1);
    const [first] = await snapshotsOf();
    await built(runner, first?.id ?? "", "1");

    // A push to the default branch: a lockfile makes one job; other paths, or another branch, none.
    const lockfile = { organizationId: world.organizationId, projectId: world.projectId, reason: "lockfile-changed" as const };
    expect(await push(pushPayload("refs/heads/main", ["README.md"]))).toMatchObject({ outcome: "ignored" });
    expect(await push(pushPayload("refs/heads/feature", ["pnpm-lock.yaml"]))).toMatchObject({ outcome: "ignored" });
    expect(await queuedJobs(lockfile)).toBe(0);
    expect(await push(pushPayload("refs/heads/main", ["web/pnpm-lock.yaml", "web/src/app.ts"]))).toEqual({ outcome: "processed" });
    expect(await queuedJobs(lockfile)).toBe(1);
    await work(lockfile);
    // Without the paths in the payload, a compare of the push's heads says what changed.
    codeHost.setCompare(REPO, "2".repeat(40), { aheadBy: 1, behindBy: 0, mergeBase: null, files: [{ path: "Cargo.lock", previousPath: null, status: "modified", additions: 1, deletions: 1, patch: null, truncated: false }], filesTruncated: false, limits: { maxFiles: 300, maxPatchBytes: 1_000_000 } }, "1".repeat(40));
    expect(await push(pushPayload("refs/heads/main", null))).toEqual({ outcome: "processed" });
    expect(await queuedJobs(lockfile)).toBe(1);
    await jobs.cancelInTx(null, "snapshot.schedule", lockfile);
    const afterPush = await snapshotsOf();
    expect(afterPush.map((row) => row.reason)).toEqual(["environment-changed", "lockfile-changed"]);
    await built(runner, afterPush[1]?.id ?? "", "2");

    // The nightly: nothing moved since the ready snapshot, so no build; the branch moved, one.
    await run(snapshotNightlyHandler(deps()), "snapshot.nightly", {});
    const nightly = { organizationId: world.organizationId, projectId: world.projectId, reason: "nightly" as const };
    expect(await queuedJobs(nightly)).toBe(1);
    await work(nightly);
    expect(await snapshotsOf()).toHaveLength(2);
    setHead("d".repeat(40));
    await run(snapshotNightlyHandler(deps()), "snapshot.nightly", {});
    await work(nightly);
    const all = await snapshotsOf();
    expect(all.map((row) => [row.reason, row.state])).toEqual([
      ["environment-changed", "replaced"],
      ["lockfile-changed", "ready"],
      ["nightly", "building"],
    ]);
    expect(await buildCommands()).toHaveLength(3);
  });

  it("F-051: two triggers within a minute queue one build", async () => {
    await dockerRunner();
    const changed = await trigger("environment-changed");
    const lockfile = await trigger("lockfile-changed");
    await work(changed);
    await work(lockfile);
    await work(await trigger("rebuild"));
    expect(await snapshotsOf()).toHaveLength(1);
    expect(await buildCommands()).toHaveLength(1);
  });

  it("F-051: a failed build keeps the previous snapshot in use", async () => {
    const runner = await dockerRunner();
    const previous = await readySnapshot(runner, "e");
    await work(await trigger("rebuild"));
    const failing = (await snapshotsOf()).find((row) => row.state === "building");
    await report(runner, { kind: "snapshot.failed", snapshotId: failing?.id, reason: "secret-found", detail: "NPM_TOKEN was found in a layer" });
    const failed = await test.db.snapshot.findUniqueOrThrow({ where: { id: failing?.id ?? "" } });
    expect(failed).toMatchObject({ state: "failed", secretScan: "failed" });
    expect(snapshotFailureFromDb(failed.failedReason)).toEqual({ reason: "secret-found", detail: "NPM_TOKEN was found in a layer" });
    expect(await test.db.snapshot.findUniqueOrThrow({ where: { id: previous } })).toMatchObject({ state: "ready" });
    // The previous one still starts the runner's boxes.
    const { spec } = await dispatchedSpec(null);
    expect(spec.snapshot).toEqual({ kind: "image", snapshotId: previous, imageRef: `ostra-snapshot/${world.projectId}:${previous}`, digest: digest("e") });
  });

  it("F-051: the spec names the ready snapshot only to the runner that holds it, and no runner is passed over for lacking it", async () => {
    const holder = await dockerRunner(poolId, world.organizationId, 2, 1);
    const snapshotId = await readySnapshot(holder);
    // A second docker runner with more free slots is chosen as before, and its box starts without it.
    const other = await dockerRunner(poolId, world.organizationId, 2, 8);
    const elsewhere = await dispatchedSpec(null);
    expect(elsewhere.runnerId).toBe(other.runnerId);
    expect(elsewhere.spec.snapshot).toBeUndefined();
    await test.db.runner.update({ where: { id: other.runnerId }, data: { state: "offline" } });
    const onHolder = await dispatchedSpec(null);
    expect(onHolder.runnerId).toBe(holder.runnerId);
    expect(onHolder.spec.snapshot).toEqual({ kind: "image", snapshotId, imageRef: `ostra-snapshot/${world.projectId}:${snapshotId}`, digest: digest("a") });
  });

  it("F-051: a host runner's spec names the project's dependency cache", async () => {
    const host = await seedOnlineRunner(test.db, world.organizationId, { kind: "personal", memberId: fixture.a.member.id }, 4);
    await test.db.runnerPresence.update({ where: { runnerId: host.runnerId }, data: { minor: 2 } });
    const { runnerId, spec } = await dispatchedSpec(host.runnerId);
    expect(runnerId).toBe(host.runnerId);
    expect(spec.snapshot).toEqual({ kind: "host-cache", cacheKey: `project-${world.projectId}` });
  });

  it("F-051: with no docker runner online the build stays queued, and goes out once one is", async () => {
    // A host runner and a docker runner below minor 2 can't build it.
    await dockerRunner(poolId, world.organizationId, 1);
    const result = await scheduleSnapshot(
      { db: test.db, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, adapters: { codeHost, secretStore } },
      { projectId: world.projectId, reason: "environment-changed" },
    );
    expect(result).toMatchObject({ ok: false, error: "no-docker-runner" });
    expect((await snapshotsOf()).map((row) => row.state)).toEqual(["queued"]);
    expect(await buildCommands()).toHaveLength(0);
    expect(await requeueSnapshots(deps())).toEqual({ sent: 0 });
    const runner = await dockerRunner();
    expect(await requeueSnapshots(deps())).toEqual({ sent: 1 });
    expect(await snapshotsOf()).toMatchObject([{ state: "building", runnerId: runner.runnerId }]);
  });

  it("F-051: a build its runner refused, or lost by going offline, goes back to the queue", async () => {
    const runner = await dockerRunner();
    await work(await trigger("environment-changed"));
    const [command] = (await buildCommands()).slice(-1);
    if (command === undefined) {
      throw new Error("no build went out");
    }
    await test.db.$transaction((tx) =>
      applySnapshotCommandResultsInTx(deps(), tx, runner, [
        { commandId: commandIdSchema.parse(command.id), seq: commandSeqSchema.parse(command.seq), kind: "snapshot-build", body: command.body, taskId: null, result: "rejected", reason: "past-not-after" },
      ]),
    );
    expect(await snapshotsOf()).toMatchObject([{ state: "queued", runnerId: null }]);
    await requeueSnapshots(deps());
    expect(await snapshotsOf()).toMatchObject([{ state: "building", runnerId: runner.runnerId }]);
    await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { disconnectedAt: new Date() } });
    await requeueSnapshots(deps());
    expect(await snapshotsOf()).toMatchObject([{ state: "queued", runnerId: null }]);
  });

  it("F-051: another organization's snapshots are untouched", async () => {
    const theirs = await dockerRunner(otherPoolId, otherWorld.organizationId);
    const theirSnapshot = await test.db.snapshot.create({
      data: {
        organizationId: otherWorld.organizationId,
        projectId: otherWorld.projectId,
        environmentId: (await test.db.environment.findUniqueOrThrow({ where: { projectId: otherWorld.projectId } })).id,
        reason: "nightly",
        state: "ready",
        runnerId: theirs.runnerId,
        digest: digest("b"),
        imageRef: "ostra-snapshot/theirs",
        readyAt: new Date(),
      },
    });
    const ours = await dockerRunner();
    // A job that names their organization with our project does nothing.
    await work({ organizationId: otherWorld.organizationId, projectId: world.projectId, reason: "environment-changed" });
    expect(await snapshotsOf()).toHaveLength(0);
    const snapshotId = await readySnapshot(ours);
    // Their runner can't report on our build, nor read its secrets.
    await work(await trigger("rebuild"));
    const building = (await snapshotsOf()).find((row) => row.state === "building");
    await report(theirs, { kind: "snapshot.failed", snapshotId: building?.id, reason: "build-failed", detail: "no" });
    expect(await test.db.snapshot.findUniqueOrThrow({ where: { id: building?.id ?? "" } })).toMatchObject({ state: "building" });
    await built(ours, building?.id ?? "", "f");
    expect(await test.db.snapshot.findUniqueOrThrow({ where: { id: snapshotId } })).toMatchObject({ state: "replaced" });
    expect(await test.db.snapshot.findUniqueOrThrow({ where: { id: theirSnapshot.id } })).toMatchObject({ state: "ready", digest: digest("b") });
    expect(await buildCommands(otherWorld)).toHaveLength(0);
  });
});
