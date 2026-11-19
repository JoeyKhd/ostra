import { randomBytes } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { dispatchTask, issueTaskCredentials, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock, waitingFor } from "@ostra/domain";
import type { SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { leaseEpochSchema, taskSpecSchema, turnIdSchema } from "@ostra/protocol";
import type { RunnerId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { acceptedTask } from "../testing/turns.ts";
import { dispatchPayload, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { buildTaskSpec } from "./task-spec.ts";

// Ticket 27 (F-094, ADR 0038 amended, ADR 0029): a task whose environment has a service runs only on
// a runner that can start it. Never on `host`: it waits there, with the reason. Its service's
// secret reaches the runner in the credentials, and nowhere else. A service that fails to start
// fails the setup.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let otherWorld: World;
let ingest: Ingest;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const SERVICE_SECRET = `db-secret-${randomBytes(8).toString("hex")}`;

const dispatch = (task: { readonly organizationId: World["organizationId"]; readonly taskId: TaskId; readonly sessionId: Parameters<typeof dispatchPayload>[0]["sessionId"] }, epoch = 1) =>
  test.db.$transaction((tx) =>
    dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger }, dispatchPayload(task, epoch)),
  );

/** A runner as its `hello` left it: online at `minor`, with its executor. */
const runnerOf = async (
  owner: { readonly kind: "personal"; readonly memberId: string } | { readonly kind: "pool"; readonly poolId: string },
  executor: "docker" | "host",
  minor = 2,
  organizationId: World["organizationId"] = world.organizationId,
) => {
  const runner = await seedOnlineRunner(test.db, organizationId, owner, 4);
  await test.db.runner.update({ where: { id: runner.runnerId }, data: { executor } });
  await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { minor } });
  return runner;
};

const nameOf = async (runnerId: RunnerId): Promise<string> => (await test.db.runner.findUniqueOrThrow({ where: { id: runnerId } })).name;

/** A pool of the project's own, the only one it lists. */
const onlyPool = async (name: string): Promise<string> => {
  await test.db.projectPool.deleteMany({ where: { projectId: world.projectId } });
  const pool = await test.db.runnerPool.create({ data: { organizationId: world.organizationId, name }, select: { id: true } });
  await test.db.projectPool.create({ data: { organizationId: world.organizationId, projectId: world.projectId, poolId: pool.id } });
  return pool.id;
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  otherWorld = await seedWorld(test.db, { codeHost, secretStore }, fixture.b.organization.id, fixture.b.project.id, { fullName: "ostra-test/other" });
  const timers: SessionTimers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  ingest = createIngest({
    db: test.db,
    jobs,
    notices: postgresChangeNotices,
    clock: systemClock,
    liveText: createLiveTextWriter({ db: test.db, logger }),
    logger,
    timers,
    outbox: postgresCommandOutbox,
  });
  const secretRef = await secretStore.put({ organizationId: world.organizationId, purpose: "environment.secret" }, SERVICE_SECRET);
  if (!secretRef.ok) {
    throw new Error("the fake secret store refused");
  }
  const environment = await test.db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
  await test.db.service.create({
    data: {
      organizationId: world.organizationId,
      projectId: world.projectId,
      environmentId: environment.id,
      name: "db",
      image: "postgres:17",
      port: 5432,
      variables: [
        { kind: "plain", name: "POSTGRES_USER", value: "app" },
        { kind: "secret", name: "POSTGRES_PASSWORD", secretRef: secretRef.value },
      ],
      healthCheck: "pg_isready -U app",
    },
  });
});

beforeEach(async () => {
  // Each case starts with no runner online, so the one it seeds is the only choice.
  await test.db.runner.updateMany({ where: { organizationId: world.organizationId }, data: { state: "offline" } });
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("services and where a task may run (F-094)", () => {
  it("F-094: a task with a service is never offered to a host runner: it waits, with the online runners in its reason", async () => {
    const host = await runnerOf({ kind: "personal", memberId: fixture.a.member.id }, "host");
    const task = await seedQueuedTask(test.db, world, fixture.a.member, host.runnerId);
    expect(await dispatch(task)).toMatchObject({ ok: false, error: "no-runner" });
    const reason = { code: "needs-services-runner", online: [{ name: await nameOf(host.runnerId), executor: "host" }] };
    const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(row.state).toBe("queued");
    expect(row.dispatchWait).toEqual(reason);
    expect(row.dispatchNote).toBe("Needs a runner that can start services (the docker executor); only host runners are online.");
    expect(waitingFor(row, null)).toEqual({ kind: "no-runner", reason });
    expect(await test.db.lease.count({ where: { taskId: task.taskId } })).toBe(0);
    expect(await test.db.command.count({ where: { runnerId: host.runnerId } })).toBe(0);
  });

  it("F-094: in the project's pools, a host runner is passed over and a docker runner gets the task; with only host runners it waits", async () => {
    const poolId = await onlyPool("build-fleet");
    const host = await runnerOf({ kind: "pool", poolId }, "host");
    const waiting = await seedQueuedTask(test.db, world, fixture.a.member, null);
    expect(await dispatch(waiting)).toMatchObject({ ok: false, error: "no-runner" });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: waiting.taskId } })).dispatchWait).toEqual({
      code: "needs-services-runner",
      online: [{ name: await nameOf(host.runnerId), executor: "host" }],
    });
    // A docker runner below minor 2 reads no services section: it can't take the task either.
    const old = await runnerOf({ kind: "pool", poolId }, "docker", 1);
    expect(await dispatch(waiting)).toMatchObject({ ok: false, error: "no-runner" });
    expect(await test.db.lease.count({ where: { runnerId: old.runnerId } })).toBe(0);
    const docker = await runnerOf({ kind: "pool", poolId }, "docker");
    expect(await dispatch(waiting)).toMatchObject({ ok: true, runnerId: docker.runnerId });
    expect(await test.db.lease.count({ where: { runnerId: host.runnerId } })).toBe(0);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: waiting.taskId } })).dispatchWait).toBeNull();
  });

  it("F-094: a busy docker runner makes the task wait for a slot, not for a services runner", async () => {
    const poolId = await onlyPool("busy-fleet");
    const docker = await runnerOf({ kind: "pool", poolId }, "docker");
    await test.db.runner.update({ where: { id: docker.runnerId }, data: { capacity: 1 } });
    await runnerOf({ kind: "pool", poolId }, "host");
    // Its one slot is taken by the first task.
    expect(await dispatch(await seedQueuedTask(test.db, world, fixture.a.member, null))).toMatchObject({ ok: true, runnerId: docker.runnerId });
    const task = await seedQueuedTask(test.db, world, fixture.a.member, null);
    expect(await dispatch(task)).toMatchObject({ ok: false, error: "no-runner" });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).dispatchWait).toEqual({ code: "no-runner-online" });
  });

  it("F-094: the spec carries the service with its plain variables only; its secret is in the credentials and nowhere else", async () => {
    const docker = await runnerOf({ kind: "personal", memberId: fixture.a.member.id }, "docker");
    const driven = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, docker);
    const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: driven.taskId, state: "active" } });
    const epoch = leaseEpochSchema.parse(lease.epoch);
    const spec = await buildTaskSpec({ db: test.db, codeHost, secretStore }, { taskId: driven.taskId, runnerId: docker.runnerId, leaseEpoch: epoch });
    if (!spec.ok) {
      throw new Error(spec.message);
    }
    expect(taskSpecSchema.parse(spec.spec).services).toEqual([
      { name: "db", image: "postgres:17", port: 5432, variables: [{ name: "POSTGRES_USER", value: "app" }], healthCheck: "pg_isready -U app" },
    ]);
    expect(JSON.stringify(spec.spec)).not.toContain(SERVICE_SECRET);

    const issued = await test.db.$transaction((tx) =>
      issueTaskCredentials(
        { tx, audit: postgresAuditLog, clock: systemClock, adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() }, mcpToken: () => "ostra-mcp-test" },
        { taskId: driven.taskId, leaseEpoch: epoch, runnerId: docker.runnerId },
      ),
    );
    if (!issued.ok) {
      throw new Error(issued.message);
    }
    expect(issued.credentials.services).toEqual([{ name: "db", variables: [{ name: "POSTGRES_PASSWORD", value: SERVICE_SECRET }] }]);
    // Nowhere else: not in an event, an audit entry, a command, a log line, or the service's row.
    const audit = await test.db.auditEntry.findMany({ where: { organizationId: world.organizationId } });
    expect(audit.find((entry) => entry.action === "task.credentials-issued")?.data).toMatchObject({ serviceSecrets: 1 });
    const stored = JSON.stringify([
      audit,
      await test.db.event.findMany({ where: { taskId: driven.taskId } }),
      await test.db.command.findMany({ where: { taskId: driven.taskId } }),
      await test.db.service.findMany({}),
    ]);
    expect(stored).not.toContain(SERVICE_SECRET);
    expect(JSON.stringify(records)).not.toContain(SERVICE_SECRET);
  });

  it("F-094: a service that fails to start fails the setup, with its name and reason, as a failed setup does", async () => {
    const docker = await runnerOf({ kind: "personal", memberId: fixture.a.member.id }, "docker");
    const driven = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, docker);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: driven.taskId } })).state).toBe("preparing");
    await driven.send({ kind: "service.healthy", name: "cache", afterMs: 900 }, { kind: "service.failed", name: "db", reason: "health check timed out" });
    const task = await test.db.task.findUniqueOrThrow({ where: { id: driven.taskId } });
    expect(task).toMatchObject({ state: "needs_you", needsYouReason: "setup_failed" });
    const item = await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: driven.taskId, state: "open" } });
    expect(item).toMatchObject({ reason: "setup_failed", audience: "driver", summary: "The db service didn't start: health check timed out" });
    // Both are stored on the box's session, where the environment page reads a service's health.
    const kinds = (await test.db.event.findMany({ where: { sessionId: driven.sessionId }, orderBy: { seq: "asc" } })).map((event) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(["service.healthy", "service.failed"]));
    expect(await test.db.lease.count({ where: { taskId: driven.taskId, state: "active" } })).toBe(0);
    const box = await test.db.box.findFirstOrThrow({ where: { taskId: driven.taskId } });
    expect(box).toMatchObject({ state: "failed", failedReason: "the db service failed" });
  });

  it("F-094: a service failing after the box was ready only stores the event", async () => {
    const docker = await runnerOf({ kind: "personal", memberId: fixture.a.member.id }, "docker");
    const driven = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, docker);
    await driven.send({ kind: "turn.started", turnId: turnIdSchema.parse("turn-1") }, { kind: "service.failed", name: "db", reason: "exited with code 1" });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: driven.taskId } })).state).toBe("running");
    expect(await test.db.needsYouItem.count({ where: { taskId: driven.taskId } })).toBe(0);
  });

  it("F-094: another organization's tasks, with no service, still go to its host runner", async () => {
    const theirs = await runnerOf({ kind: "personal", memberId: fixture.b.admin.id }, "host", 2, otherWorld.organizationId);
    const task = await seedQueuedTask(test.db, otherWorld, fixture.b.admin, theirs.runnerId);
    expect(await dispatch(task)).toMatchObject({ ok: true, runnerId: theirs.runnerId });
  });
});
