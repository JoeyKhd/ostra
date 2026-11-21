import { randomBytes } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { tamperToken } from "@ostra/adapter-sdk/testing";
import { mapTask } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { dispatchTask, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  boxIdSchema,
  closeCodes,
  leaseEpochSchema,
  projectIdSchema,
  runnerPaths,
  segmentIdSchema,
  taskCredentialsSchema,
  taskTokenResponseSchema,
  turnIdSchema,
} from "@ostra/protocol";
import type { BoxId, LeaseEpoch, RunnerId, TaskEvent } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { handleTaskEndpoint } from "../dispatch/endpoints.ts";
import { cancelGraceInTx, cancelSidecarGraceInTx, endGraceInTx, startGraceInTx, startSidecarGraceInTx } from "../ingest/grace.ts";
import type { GraceDeps } from "../ingest/grace.ts";
import { createIngest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { applyStopResultsInTx } from "../reactions/session-end.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connectPeer } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { postJson, startGateway } from "../testing/harness.ts";
import type { GatewayHarness } from "../testing/harness.ts";
import { runnerEvent } from "../testing/seed.ts";
import { dispatchPayload, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";

// Milestone 1's ticket 41 (Q129, ADR 0034, "The task token"): a `docker` or `kubernetes` box's
// sidecar connects to core as its own peer, with a token for its one task, tied to the lease. Real
// ingest, grace and stop reactions, a fake peer for the sidecar and the runner, fake GitHub.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let harness: GatewayHarness;
let liveText: LiveTextWriter;
let graceDeps: GraceDeps;
let poolRunner: RunnerId;
const records: LogRecord[] = [];
const issued: string[] = [];
const peers: FakePeer[] = [];
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  const logger = createLogger((record) => records.push(record));
  liveText = createLiveTextWriter({ db: test.db, logger, intervalMs: 50 });
  graceDeps = { jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, logger, graceMs: 60_000 };
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  harness = await startGateway(
    test.db,
    test.url,
    {
      logger,
      hooks: {
        ingest: createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger }),
        liveText: liveText.write,
        onConnectedInTx: (tx, runner) => cancelGraceInTx(graceDeps, tx, runner),
        onDisconnectedInTx: (tx, runner) => startGraceInTx(graceDeps, tx, runner),
        onSidecarConnectedInTx: (tx, lease) => cancelSidecarGraceInTx(graceDeps, tx, lease),
        onSidecarDisconnectedInTx: (tx, lease) => startSidecarGraceInTx(graceDeps, tx, lease),
        onCommandResultsInTx: (tx, runner, results) => applyStopResultsInTx({ notices: postgresChangeNotices, clock: systemClock, logger }, tx, runner, results),
      },
    },
    (gateway) => [
      handleTaskEndpoint({
        db: test.db,
        tokens: gateway.context.tokens,
        taskTokens: gateway.context.taskTokens,
        adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
        audit: postgresAuditLog,
        clock: systemClock,
        signingKey: randomBytes(32),
        logger,
      }),
    ],
  );
  // The organization's default pool, with one docker runner: a task with no picked runner goes there.
  const pool = await test.db.runnerPool.create({ data: { organizationId: fixture.a.organization.id, name: "boxes", isDefault: true } });
  poolRunner = (await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "pool", poolId: pool.id }, 50)).runnerId;
});

afterEach(() => {
  for (const peer of peers.splice(0)) {
    peer.close();
  }
});

afterAll(async () => {
  await harness.stop();
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const thought = (text: string): TaskEvent => ({ kind: "agent.thought", turnId: turnIdSchema.parse("turn-1"), segmentId: segmentIdSchema.parse(`t-${text.replaceAll(" ", "-")}`), text });

/** The pool runner's own access token, as core issues it for a signed assertion. */
const runnerToken = (runnerId: RunnerId = poolRunner, organizationId = fixture.a.organization.id): string =>
  harness.gateway.context.tokens.issue(runnerId, organizationId, Date.now()).accessToken;

type Boxed = QueuedTask & { readonly boxId: BoxId; readonly leaseEpoch: LeaseEpoch; readonly projectId: string };

/** A task dispatched to the pool runner: a docker box and an active lease. */
const boxedTask = async (epoch = 1, existing?: QueuedTask): Promise<Boxed> => {
  const task = existing ?? (await seedQueuedTask(test.db, world, fixture.a.member, null));
  const result = await test.db.$transaction((tx) =>
    dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger: createLogger(() => undefined) }, dispatchPayload(task, epoch)),
  );
  expect(result).toMatchObject({ ok: true, runnerId: poolRunner });
  const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, epoch }, include: { box: true } });
  expect(lease.box.executor).toBe("docker");
  return { ...task, boxId: boxIdSchema.parse(lease.boxId), leaseEpoch: leaseEpochSchema.parse(epoch), projectId: lease.projectId };
};

/** What the runner does when it makes the box: asks core for the task token, once. */
const taskTokenFor = async (task: Boxed): Promise<string> => {
  const response = await postJson(`${harness.url}${runnerPaths.taskToken(task.taskId)}`, { leaseEpoch: task.leaseEpoch }, runnerToken());
  expect(response.status).toBe(200);
  const { taskToken } = taskTokenResponseSchema.parse(response.body);
  issued.push(taskToken);
  return taskToken;
};

const sidecar = async (task: Boxed, token: string): Promise<FakePeer> => {
  const peer = await connectPeer(harness.url, token, poolRunner, { peer: { kind: "sidecar", taskId: task.taskId, boxId: task.boxId, leaseEpoch: task.leaseEpoch } });
  peers.push(peer);
  await peer.next("welcome");
  return peer;
};

const specOf = (task: Pick<Boxed, "taskId">, token: string, epoch = 1) =>
  fetch(`${harness.url}${runnerPaths.taskSpec(task.taskId)}?leaseEpoch=${String(epoch)}`, { headers: { authorization: `Bearer ${token}` } });
const credentialsOf = (task: Pick<Boxed, "taskId">, token: string, epoch = 1) =>
  postJson(`${harness.url}${runnerPaths.taskCredentials(task.taskId)}`, { taskId: task.taskId, leaseEpoch: epoch }, token);

const stopCommand = (task: Boxed) =>
  test.db.$transaction((tx) =>
    postgresCommandOutbox.enqueueInTx(tx, task.organizationId, poolRunner, {
      kind: "stop",
      body: { taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: task.leaseEpoch, reason: "requested" },
      notAfter: Date.now() + 60_000,
      task: { taskId: task.taskId, projectId: projectIdSchema.parse(task.projectId) },
    }),
  );

const graceJobs = async (task: Boxed) =>
  (await jobs.find("task.grace", { organizationId: task.organizationId, taskId: task.taskId, leaseEpoch: task.leaseEpoch })).filter((job) => job.state === "created");

describe("the task token", () => {
  it("F-015/c3: a box's sidecar connects with its task token, sends its task's events, receives a stop and fetches its credentials", async () => {
    const task = await boxedTask();
    const token = await taskTokenFor(task);
    const peer = await sidecar(task, token);

    peer.send({ type: "events", events: [runnerEvent(task, 1, thought("a")), runnerEvent(task, 2, thought("b"))] });
    expect(await peer.next("ack")).toEqual({ type: "ack", sessionId: task.sessionId, upTo: 2 });
    expect(await test.db.event.count({ where: { taskId: task.taskId, sessionId: task.sessionId } })).toBe(2);

    const credentials = await credentialsOf(task, token);
    expect(credentials.status).toBe(200);
    expect(taskCredentialsSchema.parse(credentials.body).repos).toHaveLength(1);
    expect((await specOf(task, token)).status).toBe(200);

    // The task's stop goes to its sidecar, numbered per box, and not to the runner.
    await stopCommand(task);
    const stop = await peer.next("command");
    expect(stop).toMatchObject({ kind: "stop", seq: 1, body: { taskId: task.taskId, reason: "requested" } });
    expect(await test.db.command.count({ where: { taskId: task.taskId, kind: "stop" } })).toBe(0);
    expect(await test.db.sidecarCommand.count({ where: { taskId: task.taskId, boxId: task.boxId, kind: "stop" } })).toBe(1);
  });

  it("F-015/c4: the same token is refused for another task's spec, credentials and events, and for another organization", async () => {
    const task = await boxedTask();
    const other = await boxedTask();
    const token = await taskTokenFor(task);
    expect((await specOf(other, token)).status).toBe(403);
    expect((await credentialsOf(other, token)).status).toBe(403);
    // The runner's own endpoint for a task token: a task token can't mint another.
    expect((await postJson(`${harness.url}${runnerPaths.taskToken(other.taskId)}`, { leaseEpoch: 1 }, token)).status).toBe(403);

    const peer = await sidecar(task, token);
    peer.send({ type: "events", events: [runnerEvent(other, 1, thought("not mine"))] });
    expect(await peer.closed).toBe(closeCodes.protocolViolation);
    expect(await test.db.event.count({ where: { taskId: other.taskId } })).toBe(0);

    // A token naming another organization, with this task: signed by core, and still nothing.
    const forged = harness.gateway.context.taskTokens.issue({
      organizationId: fixture.b.organization.id,
      taskId: task.taskId,
      leaseEpoch: task.leaseEpoch,
      boxId: task.boxId,
      runnerId: poolRunner,
    });
    issued.push(forged);
    expect((await specOf(task, forged)).status).toBe(404);
    expect((await credentialsOf(task, forged)).status).toBe(404);
    await expect(connectPeer(harness.url, forged, poolRunner, { peer: { kind: "sidecar", taskId: task.taskId, boxId: task.boxId, leaseEpoch: 1 } })).rejects.toThrow("404");
    // And one core didn't sign.
    expect((await specOf(task, tamperToken(token))).status).toBe(401);
  });

  it("F-015/c4: a token whose lease ended by a stop is refused everywhere with the stale-lease answer", async () => {
    const task = await boxedTask();
    const token = await taskTokenFor(task);
    const peer = await sidecar(task, token);
    await stopCommand(task);
    const stop = await peer.next("command");
    // The sidecar stopped its task: the stop's result releases the lease.
    peer.send({ type: "command-ack", upTo: stop.seq, results: [{ id: stop.id, seq: stop.seq, result: "done" }] });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, epoch: 1 } })).state === "ended") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, epoch: 1 } })).state).toBe("ended");
    expect((await specOf(task, token)).status).toBe(409);
    const credentials = await credentialsOf(task, token);
    expect(credentials.status).toBe(409);
    expect(credentials.body).toMatchObject({ error: { code: "stale-lease" } });
    // On the socket: the next frame gets the protocol's error, and the sidecar is closed.
    peer.send({ type: "events", events: [runnerEvent(task, 1, thought("late"))] });
    expect(await peer.next("error")).toMatchObject({ code: "stale-lease" });
    expect(await peer.closed).toBe(closeCodes.revoked);
    expect(await test.db.event.count({ where: { taskId: task.taskId } })).toBe(0);
    await expect(connectPeer(harness.url, token, poolRunner, { peer: { kind: "sidecar", taskId: task.taskId, boxId: task.boxId, leaseEpoch: 1 } })).rejects.toThrow("409");
  });

  it("F-015/c3, F-045/c2: a token whose lease ended by the grace, or by a new dispatch, is refused", async () => {
    // The grace: the sidecar went and stayed away.
    const lost = await boxedTask();
    const lostToken = await taskTokenFor(lost);
    const lostPeer = await sidecar(lost, lostToken);
    lostPeer.close();
    await lostPeer.closed;
    for (let attempt = 0; attempt < 100 && (await graceJobs(lost)).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await graceJobs(lost)).toHaveLength(1);
    const outcome = await test.db.$transaction(async (tx) => {
      const row = await tx.task.findUniqueOrThrow({ where: { id: lost.taskId } });
      return endGraceInTx(graceDeps, tx, row, { organizationId: lost.organizationId, taskId: lost.taskId, leaseEpoch: lost.leaseEpoch });
    });
    expect(outcome).toBe("stopped");
    expect((await specOf(lost, lostToken)).status).toBe(409);
    expect((await credentialsOf(lost, lostToken)).status).toBe(409);
    await expect(connectPeer(harness.url, lostToken, poolRunner, { peer: { kind: "sidecar", taskId: lost.taskId, boxId: lost.boxId, leaseEpoch: 1 } })).rejects.toThrow("409");
    // And the old lease's writes: its runner's late batch, at the epoch the grace ended, is refused
    // by core's ingest, and nothing of it is stored.
    const ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger: createLogger(() => undefined) });
    const lateBatch = async (task: Boxed, text: string) => {
      const before = await test.db.event.count({ where: { taskId: task.taskId } });
      const replies = await ingest({ runnerId: poolRunner, organizationId: task.organizationId }, { type: "events", events: [runnerEvent(task, 1, thought(text))] });
      expect(replies).toEqual([expect.objectContaining({ type: "error", code: "stale-lease", sessionId: task.sessionId, currentEpoch: 2 })]);
      expect(await test.db.event.count({ where: { taskId: task.taskId } })).toBe(before);
    };
    await lateBatch(lost, "after the grace");

    // A new dispatch: the offer timed out, and the task went out again at the next epoch.
    const moved = await boxedTask();
    const movedToken = await taskTokenFor(moved);
    await test.db.lease.updateMany({ where: { taskId: moved.taskId, epoch: 1 }, data: { state: "ended", endReason: "offer-timeout", endedAt: new Date() } });
    const again = await boxedTask(2, moved);
    expect(again.boxId).not.toBe(moved.boxId);
    expect((await specOf(moved, movedToken)).status).toBe(409);
    expect((await credentialsOf(moved, movedToken)).status).toBe(409);
    await expect(connectPeer(harness.url, movedToken, poolRunner, { peer: { kind: "sidecar", taskId: moved.taskId, boxId: moved.boxId, leaseEpoch: 1 } })).rejects.toThrow("409");
    await lateBatch(moved, "after the new dispatch");
    // The new box's own token works.
    expect((await specOf(again, await taskTokenFor(again), 2)).status).toBe(200);
  });

  it("F-015/c4: a runner's token gets no credentials for a boxed lease, and still gets them for a host lease", async () => {
    const boxed = await boxedTask();
    const refused = await credentialsOf(boxed, runnerToken());
    expect(refused.status).toBe(403);
    // The runner still reads the spec, which holds no secret, to make the box.
    expect((await specOf(boxed, runnerToken())).status).toBe(200);

    const laptop = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id });
    const hosted = await seedQueuedTask(test.db, world, fixture.a.member, laptop.runnerId);
    const result = await test.db.$transaction((tx) =>
      dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger: createLogger(() => undefined) }, dispatchPayload(hosted)),
    );
    expect(result).toMatchObject({ ok: true, runnerId: laptop.runnerId });
    expect((await credentialsOf(hosted, runnerToken(laptop.runnerId))).status).toBe(200);
    // A host lease has no sidecar, so no task token.
    expect((await postJson(`${harness.url}${runnerPaths.taskToken(hosted.taskId)}`, { leaseEpoch: 1 }, runnerToken(laptop.runnerId))).status).toBe(400);
  });

  it("F-015/c3: a second connection of a box evicts the first with 4409", async () => {
    const task = await boxedTask();
    const token = await taskTokenFor(task);
    const first = await sidecar(task, token);
    const second = await sidecar(task, token);
    expect(await first.next("evict")).toEqual({ type: "evict", reason: "replaced" });
    expect(await first.closed).toBe(closeCodes.replaced);
    second.send({ type: "events", events: [runnerEvent(task, 1, thought("still here"))] });
    expect(await second.next("ack")).toEqual({ type: "ack", sessionId: task.sessionId, upTo: 1 });
    const box = await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } });
    expect(box).toMatchObject({ sidecarConnectionEpoch: 2, sidecarDisconnectedAt: null });
  });

  it("F-015/c3, F-045/c1: the runner's connection closes while its box's sidecar stays: the task carries on and no grace starts", async () => {
    const task = await boxedTask();
    const token = await taskTokenFor(task);
    const runner = await connectPeer(harness.url, runnerToken(), poolRunner);
    peers.push(runner);
    await runner.next("welcome");
    const peer = await sidecar(task, token);

    runner.close();
    await runner.closed;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const presence = await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId: poolRunner } });
      if (presence.disconnectedAt !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId: poolRunner } })).disconnectedAt).not.toBeNull();
    expect(await graceJobs(task)).toHaveLength(0);
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "runner.lost" } })).toBe(0);
    // The sidecar carries on: its events are stored, and its credentials still come.
    peer.send({ type: "events", events: [runnerEvent(task, 1, thought("carrying on"))] });
    expect(await peer.next("ack")).toEqual({ type: "ack", sessionId: task.sessionId, upTo: 1 });
    expect((await credentialsOf(task, token)).status).toBe(200);
    expect(mapTask(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).not.toBe("stopped");

    // It's the sidecar's connection that holds the grace.
    peer.close();
    await peer.closed;
    for (let attempt = 0; attempt < 100 && (await graceJobs(task)).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await graceJobs(task)).toHaveLength(1);
    // And its reconnect cancels it.
    await sidecar(task, token);
    for (let attempt = 0; attempt < 100 && (await graceJobs(task)).length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await graceJobs(task)).toHaveLength(0);
    // The runner went offline with its connection: back online for the next test's dispatch.
    await test.db.runner.update({ where: { id: poolRunner }, data: { state: "online" } });
    await test.db.runnerPresence.update({ where: { runnerId: poolRunner }, data: { disconnectedAt: null } });
  });

  it("F-015/c4: the task token reaches no log line", async () => {
    const task = await boxedTask();
    const token = await taskTokenFor(task);
    const peer = await sidecar(task, token);
    peer.send({ type: "events", events: [runnerEvent(task, 1, thought("log me not"))] });
    await peer.next("ack");
    await credentialsOf(task, token);
    // A line that tried to carry it is redacted by the log guard.
    const probe: LogRecord[] = [];
    createLogger((record) => probe.push(record)).warn(`a token ${token} in a message`, { field: token });
    expect(JSON.stringify(probe)).not.toContain(token);
    expect(records.some((record) => record.message === "task.token-issued")).toBe(true);
    const logged = JSON.stringify(records);
    expect(issued.length).toBeGreaterThan(5);
    for (const each of issued) {
      expect(logged).not.toContain(each);
      expect(logged).not.toContain(each.slice("ostra-task-".length, "ostra-task-".length + 40));
    }
  });
});
