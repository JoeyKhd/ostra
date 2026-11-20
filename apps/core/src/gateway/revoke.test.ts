import { randomBytes } from "node:crypto";

import { silentLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  dispatchTask,
  moveTaskInTx,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  revokeRunner,
  RUNNER_REVOKED_END_REASON,
  systemClock,
} from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { mapTask } from "@ostra/db";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { closeCodes, leaseEpochSchema, memberIdSchema, runnerPaths, segmentIdSchema, sessionIdSchema, turnIdSchema } from "@ostra/protocol";
import type { OrganizationId, RunnerId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { handleTaskEndpoint } from "../dispatch/endpoints.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { signAssertion } from "../testing/fake-peer.ts";
import { accessToken, connect, postJson, registerPersonal, startGateway } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";
import { runnerEvent } from "../testing/seed.ts";
import { dispatchPayload, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";

// Milestone 2's ticket 41 (Q131) against the fake peer: a revoke reaches a connected runner at once,
// its leases end in the revoke's own transaction with no grace, and its still-valid access token is
// refused by every endpoint that takes one. The router's half (who may revoke) is
// `packages/api/src/routers/runners-revoke.test.ts`.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let ingest: Ingest;
let liveText: LiveTextWriter;
let world: World;
let harness: GatewayHarness;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  liveText = createLiveTextWriter({ db: test.db, logger: silentLogger, intervalMs: 50 });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger: silentLogger });
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  // The sweep would find a missed revoke after a minute: the 4403 below can only be the NOTIFY's.
  harness = await startGateway(test.db, test.url, { hooks: { ingest, liveText: liveText.write }, timers: { sweepMs: 60_000 } }, (gateway) => [
    handleTaskEndpoint({
      db: test.db,
      tokens: gateway.context.tokens,
      taskTokens: gateway.context.taskTokens,
      adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
      audit: postgresAuditLog,
      clock: systemClock,
      signingKey: randomBytes(32),
      logger: silentLogger,
    }),
  ]);
});

afterAll(async () => {
  await harness.stop();
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const scopeOf = (member: SeededMember, role: "admin" | "member"): MemberScope => ({
  organizationId: member.organizationId,
  memberId: memberIdSchema.parse(member.id),
  role,
  projectRoles: new Map(),
});

const revoke = (runnerId: RunnerId, by: MemberScope = scopeOf(fixture.a.admin, "admin")) =>
  test.db.$transaction((tx) => revokeRunner({ tx, scope: by, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, jobs }, { runnerId }));

const dispatch = (task: QueuedTask, epoch = 1) =>
  test.db.$transaction((tx) =>
    dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger: silentLogger }, dispatchPayload(task, epoch)),
  );

/** The task as an accepted offer leaves it running: the lease accepted, the session running. */
const markRunning = async (task: QueuedTask): Promise<void> => {
  await test.db.lease.updateMany({ where: { taskId: task.taskId, state: "active" }, data: { acceptedAt: new Date() } });
  await test.db.task.update({ where: { id: task.taskId }, data: { state: "running" } });
  await test.db.session.update({ where: { id: task.sessionId }, data: { state: "running" } });
  await test.db.box.updateMany({ where: { taskId: task.taskId }, data: { state: "ready" } });
};

const specOf = (task: QueuedTask, token: string, epoch = 1) =>
  fetch(`${harness.url}${runnerPaths.taskSpec(task.taskId)}?leaseEpoch=${String(epoch)}`, { headers: { authorization: `Bearer ${token}` } });

const credentialsOf = (task: QueuedTask, token: string, epoch = 1) =>
  postJson(`${harness.url}${runnerPaths.taskCredentials(task.taskId)}`, { taskId: task.taskId, leaseEpoch: epoch }, token);

const thought = (text: string) => ({ kind: "agent.thought" as const, turnId: turnIdSchema.parse("turn-1"), segmentId: segmentIdSchema.parse(`s-${text}`), text });

/** A personal runner of organization A's member, connected over the WebSocket and online. */
const onlineRunner = async (): Promise<{ readonly runner: RegisteredRunner; readonly peer: FakePeer }> => {
  const runner = await registerPersonal(harness, test.db, fixture.a.member);
  const peer = await connect(harness, runner);
  await peer.next("welcome");
  expect(await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).toMatchObject({ state: "online" });
  return { runner, peer };
};

describe("revoking a connected runner (Q131)", () => {
  it("F-091: closes its socket with 4403 at once, stops its tasks as runner_lost with their epochs raised, and refuses its still-valid token everywhere", async () => {
    const { runner, peer } = await onlineRunner();
    const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    expect(await dispatch(task)).toMatchObject({ ok: true, runnerId: runner.runnerId, leaseEpoch: 1 });
    await markRunning(task);
    // The token it holds works before the revoke, and keeps its 10 minutes after it.
    const token = (await accessToken(harness, runner)).accessToken;
    expect((await specOf(task, token)).status).toBe(200);

    const started = Date.now();
    expect(await revoke(runner.runnerId)).toEqual({ ok: true, runnerId: runner.runnerId, alreadyRevoked: false, stoppedTaskIds: [task.taskId] });
    expect(await peer.next("evict", 5_000)).toEqual({ type: "evict", reason: "revoked" });
    expect(await peer.closed).toBe(closeCodes.revoked);
    expect(Date.now() - started).toBeLessThan(5_000);

    // Its task stopped with the revoke: no grace, the epoch raised, the box and session stopped.
    const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId }, include: { leases: true, sessions: true, boxes: true } });
    expect(row).toMatchObject({ state: "stopped", stoppedReason: "runner_lost", leaseEpoch: 2 });
    expect(row.leases).toMatchObject([{ epoch: 1, state: "ended", endReason: RUNNER_REVOKED_END_REASON }]);
    expect(row.sessions).toMatchObject([{ state: "stopped" }]);
    expect(row.boxes).toMatchObject([{ state: "stopped" }]);

    // A late event batch from the old lease is refused, and nothing of it is stored.
    const before = await test.db.event.count({ where: { taskId: task.taskId } });
    const replies = await ingest(
      { runnerId: runner.runnerId, organizationId: fixture.a.organization.id },
      { type: "events", events: [runnerEvent(task, 1, thought("late"))] },
    );
    expect(replies).toEqual([expect.objectContaining({ type: "error", code: "stale-lease", sessionId: task.sessionId, currentEpoch: 2 })]);
    expect(await test.db.event.count({ where: { taskId: task.taskId } })).toBe(before);

    // The token's 10 minutes aren't over, and still: the spec, the credentials and the WebSocket refuse it.
    const spec = await specOf(task, token);
    expect(spec.status).toBe(403);
    const credentials = await credentialsOf(task, token);
    expect(credentials.status).toBe(403);
    expect(credentials.body).toMatchObject({ error: { code: "unauthorized" } });
    await expect(connect(harness, runner)).rejects.toThrow("403");
    // And its next token request fails.
    const next = await postJson(`${harness.url}${runnerPaths.token}`, signAssertion(runner.key, runner.runnerId));
    expect(next.status).toBe(403);

    const audit = await test.db.auditEntry.findFirstOrThrow({ where: { action: "runner.revoked", entityId: runner.runnerId } });
    expect(audit).toMatchObject({ actorKind: "member", actorId: fixture.a.admin.id });
    expect(audit.data).toMatchObject({ from: "online", stoppedTasks: 1 });
  });

  it("F-091: does it all in one transaction: a revoke whose transaction fails leaves the runner, its connection and its tasks as they were", async () => {
    const { runner, peer } = await onlineRunner();
    const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    expect(await dispatch(task)).toMatchObject({ ok: true });
    await markRunning(task);
    await expect(
      test.db.$transaction(async (tx) => {
        await revokeRunner({ tx, scope: scopeOf(fixture.a.admin, "admin"), notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, jobs }, { runnerId: runner.runnerId });
        throw new Error("the caller's transaction failed after the revoke");
      }),
    ).rejects.toThrow("failed after the revoke");
    expect(await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).toMatchObject({ state: "online", revokedAt: null });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "running", leaseEpoch: 1 });
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "active", endReason: null });
    // The NOTIFY rolled back with it: the peer is still connected and gets no evict.
    await expect(peer.next("evict", 1_000)).rejects.toThrow();
    const token = (await accessToken(harness, runner)).accessToken;
    expect((await specOf(task, token)).status).toBe(200);
    peer.close();
  });

  it("F-091: a reopened task of a revoked runner dispatches to another runner", async () => {
    const pool = await test.db.runnerPool.create({ data: { organizationId: fixture.a.organization.id, name: "revoke-reopen" }, select: { id: true } });
    await test.db.projectPool.create({ data: { organizationId: fixture.a.organization.id, projectId: world.projectId, poolId: pool.id } });
    const first = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "pool", poolId: pool.id });
    const second = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "pool", poolId: pool.id });
    const task = await seedQueuedTask(test.db, world, fixture.a.member, null);
    const offered = await dispatch(task);
    if (!offered.ok) {
      throw new Error("the first dispatch found no runner");
    }
    await markRunning(task);
    const lost = offered.runnerId;
    const other = lost === first.runnerId ? second.runnerId : first.runnerId;
    expect(await revoke(lost)).toMatchObject({ ok: true, stoppedTaskIds: [task.taskId] });

    // Reopen: stopped → queued, with a fresh session, and the next dispatch grants epoch 3.
    const reopenedSession = await test.db.$transaction(async (tx) => {
      const row = mapTask(await tx.task.findUniqueOrThrow({ where: { id: task.taskId } }));
      expect(await moveTaskInTx({ tx, notices: postgresChangeNotices, jobs }, row, { type: "reopen" })).toBe(true);
      return tx.session.create({
        data: { organizationId: world.organizationId, projectId: world.projectId, taskId: task.taskId, agentProfileId: world.profileId, origin: "resumed", state: "starting" },
        select: { id: true },
      });
    });
    const again = await test.db.$transaction((tx) =>
      dispatchTask(
        { tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock },
        { organizationId: task.organizationId, taskId: task.taskId, sessionId: sessionIdSchema.parse(reopenedSession.id), leaseEpoch: leaseEpochSchema.parse(3) },
      ),
    );
    expect(again).toMatchObject({ ok: true, runnerId: other, leaseEpoch: 3 });
    expect(await test.db.lease.count({ where: { runnerId: lost, state: "active" } })).toBe(0);
  });
});

describe("revoking a runner that isn't connected (Q131)", () => {
  const asState = async (state: "offline" | "joining" | "draining", organizationId: OrganizationId = fixture.a.organization.id) => {
    const { runner, peer } = await onlineRunner();
    const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    expect(await dispatch(task)).toMatchObject({ ok: true });
    await markRunning(task);
    const token = (await accessToken(harness, runner)).accessToken;
    peer.close();
    await peer.closed;
    // The disconnect marks it offline; the other states are set as an admin or a join leaves them.
    await expect.poll(async () => (await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).state).toBe("offline");
    if (state !== "offline") {
      await test.db.runner.update({ where: { id: runner.runnerId, organizationId }, data: { state } });
    }
    return { runner, task, token };
  };

  it.each(["offline", "joining", "draining"] as const)(
    "F-091: revoking a %s runner ends its leases at once and refuses its token",
    async (state) => {
      const { runner, task, token } = await asState(state);
      expect(await revoke(runner.runnerId)).toMatchObject({ ok: true, alreadyRevoked: false, stoppedTaskIds: [task.taskId] });
      expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "stopped", stoppedReason: "runner_lost", leaseEpoch: 2 });
      expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, epoch: 1 } })).toMatchObject({ state: "ended", endReason: RUNNER_REVOKED_END_REASON });
      // No grace job can stop it later: its epoch moved on.
      expect((await specOf(task, token)).status).toBe(403);
      expect((await credentialsOf(task, token)).status).toBe(403);
      await expect(connect(harness, runner)).rejects.toThrow("403");
      expect((await postJson(`${harness.url}${runnerPaths.token}`, signAssertion(runner.key, runner.runnerId))).status).toBe(403);
      expect((await test.db.auditEntry.findFirstOrThrow({ where: { action: "runner.revoked", entityId: runner.runnerId } })).data).toMatchObject({ from: state });
    },
  );

  it("F-091: another organization's admin, and a member who doesn't own the runner, are refused and change nothing", async () => {
    const { runner, peer } = await onlineRunner();
    const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    expect(await dispatch(task)).toMatchObject({ ok: true });
    expect(await revoke(runner.runnerId, scopeOf(fixture.b.admin, "admin"))).toMatchObject({ ok: false, error: "not-found" });
    // Organization A's other member: neither an admin nor the runner's owner.
    const stranger: MemberScope = { ...scopeOf(fixture.a.member, "member"), memberId: memberIdSchema.parse(fixture.a.admin.id) };
    expect(await revoke(runner.runnerId, stranger)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).toMatchObject({ state: "online", revokedAt: null });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "queued", leaseEpoch: 1 });
    await expect(peer.next("evict", 1_000)).rejects.toThrow();
    // Its owner may.
    expect(await revoke(runner.runnerId, scopeOf(fixture.a.member, "member"))).toMatchObject({ ok: true, stoppedTaskIds: [task.taskId] });
    expect(await peer.closed).toBe(closeCodes.revoked);
  });
});
