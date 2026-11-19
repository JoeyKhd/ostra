import { createLogger } from "@ostra/adapter-sdk";
import { createApiHarness } from "@ostra/api/testing";
import type { ApiHarness } from "@ostra/api/testing";
import type { SeededMember } from "@ostra/db/testing";
import {
  dispatchTask,
  drainRunner,
  ensureDefaultPool,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  resumeRunner,
  systemClock,
} from "@ostra/domain";
import type { EnqueueOptions, JobName, JobPayload, MemberScope } from "@ostra/domain";
import type { Tx } from "@ostra/db";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { memberIdSchema, organizationIdSchema, projectIdSchema, registerResponseSchema, runnerPaths, segmentIdSchema, turnIdSchema } from "@ostra/protocol";
import type { Command, RunnerId, TaskEvent } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connectPeer, makeRunnerKey } from "../testing/fake-peer.ts";
import type { ConnectOptions, FakePeer } from "../testing/fake-peer.ts";
import { accessToken, postJson, registerBody, startGateway } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";
import { runnerEvent } from "../testing/seed.ts";
import { dispatchPayload, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

// Milestone 5's ticket 15 (F-092, ADR 0029 "Drain, resume and revoke", Q108): an admin drains a
// runner and resumes it, against a fake peer on the real gateway. The hold is the runner's row:
// offers go to `online` runners only, and `hello` never lifts it.

let api: ApiHarness;
let gateway: GatewayHarness;
let jobs: Jobs;
let world: World;
const peers: FakePeer[] = [];

beforeAll(async () => {
  api = await createApiHarness();
  gateway = await startGateway(api.test.db, api.test.url);
  jobs = createJobs({ databaseUrl: api.test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  const { a } = api.fixture;
  world = await seedWorld(
    api.test.db,
    { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() },
    organizationIdSchema.parse(a.organization.id),
    projectIdSchema.parse(a.openProject.id),
  );
});

afterEach(() => {
  for (const peer of peers.splice(0)) {
    peer.close();
  }
});

afterAll(async () => {
  await gateway.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await api.dispose();
});

const scopeOf = (member: SeededMember, role: "admin" | "member"): MemberScope => ({
  organizationId: organizationIdSchema.parse(member.organizationId),
  memberId: memberIdSchema.parse(member.id),
  role,
  projectRoles: new Map(),
});

/** The jobs a drain or a resume enqueued, besides enqueuing them. */
const enqueued: { readonly name: string; readonly payload: unknown }[] = [];

const deps = () => ({
  db: api.test.db,
  jobs: {

    enqueueInTx: async <N extends JobName>(tx: Tx, name: N, payload: JobPayload<N>, options?: EnqueueOptions) => {
      enqueued.push({ name, payload });
      await jobs.enqueueInTx(tx, name, payload, options);
    },
  },
  outbox: postgresCommandOutbox,
  notices: postgresChangeNotices,
  audit: postgresAuditLog,
  clock: systemClock,
});

const logger = createLogger(() => undefined);
const dispatch = (payload: ReturnType<typeof dispatchPayload>) =>
  api.test.db.$transaction((tx) =>
    dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger }, payload),
  );

/** A runner joined to the organization's default pool, which needs no approval. */
const joined = async (name: string): Promise<RegisteredRunner> => {
  const { a } = api.fixture;
  const admin = await api.as(a.admin);
  const poolId = await api.test.db.$transaction((tx) => ensureDefaultPool(tx, organizationIdSchema.parse(a.organization.id)));
  const made = await admin.pools.createJoinToken({ poolId });
  const key = await makeRunnerKey();
  const response = await postJson(`${gateway.url}${runnerPaths.register}`, registerBody(key, { name, executor: "docker", joinToken: made.token }));
  const registered = registerResponseSchema.parse(response.body);
  return { key, registered, runnerId: registered.runnerId };
};

const connected = async (runner: RegisteredRunner, options: ConnectOptions = {}, on: GatewayHarness = gateway): Promise<FakePeer> => {
  const token = await accessToken(on, runner);
  const peer = await connectPeer(on.url, token.accessToken, runner.runnerId, options);
  peers.push(peer);
  await peer.next("welcome");
  return peer;
};

const stateOf = async (runnerId: RunnerId) => (await api.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } })).state;

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** The next command of `kind` the peer got. */
const nextCommand = async (peer: FakePeer, kind: Command["kind"]): Promise<Command> => {
  for (;;) {
    const frame = await peer.next("command", 5_000);
    if (frame.kind === kind) {
      return frame;
    }
  }
};

const thought: TaskEvent = { kind: "agent.thought", turnId: turnIdSchema.parse("turn-1"), segmentId: segmentIdSchema.parse("t-1"), text: "still working" };

const commandKinds = (peer: FakePeer): readonly string[] => peer.frames.flatMap((frame) => (frame.type === "command" ? [frame.kind] : []));

/** Takes the runner out of the default pool's offers, so the next test's runner is the only one. */
const retire = async (runnerId: RunnerId): Promise<void> => {
  await api.test.db.runner.update({ where: { id: runnerId }, data: { state: "revoked", revokedAt: new Date() } });
};

describe("a drain", () => {
  it("F-092: a drained runner gets no offer while a task it holds finishes", async () => {
    const { a } = api.fixture;
    const runner = await joined("drain-holds");
    const peer = await connected(runner);
    expect(await stateOf(runner.runnerId)).toBe("online");

    const held = await seedQueuedTask(api.test.db, world, a.admin, null);
    expect(await dispatch(dispatchPayload(held))).toMatchObject({ ok: true, runnerId: runner.runnerId });
    await nextCommand(peer, "dispatch");

    expect(await drainRunner(deps(), scopeOf(a.admin, "admin"), { runnerId: runner.runnerId })).toEqual({ ok: true, state: "draining" });
    const row = await api.test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } });
    expect(row).toMatchObject({ state: "draining", drainedByMemberId: a.admin.id });
    expect(row.drainedAt).not.toBeNull();
    // The runner hears `drain` once, through the outbox.
    await nextCommand(peer, "drain");
    expect(await api.test.db.auditEntry.count({ where: { action: "runner.drained", entityId: runner.runnerId, actorId: a.admin.id } })).toBe(1);
    // The task it holds is told on its own timeline.
    const drained = await api.test.db.event.findMany({ where: { taskId: held.taskId, kind: "runner.drained" } });
    expect(drained).toHaveLength(1);

    // A new task isn't offered to it.
    const waiting = await seedQueuedTask(api.test.db, world, a.admin, null);
    expect(await dispatch(dispatchPayload(waiting))).toMatchObject({ ok: false, error: "no-runner" });
    expect(await api.test.db.lease.count({ where: { taskId: waiting.taskId } })).toBe(0);

    // The task it holds keeps its lease and goes on: its events are still taken, and nothing stops it.
    expect(await api.test.db.lease.count({ where: { taskId: held.taskId, runnerId: runner.runnerId, state: "active" } })).toBe(1);
    peer.send({ type: "events", events: [runnerEvent(held, 1, thought)] });
    expect(await peer.next("ack")).toMatchObject({ sessionId: held.sessionId, upTo: 1 });
    expect(commandKinds(peer)).not.toContain("stop");
    await retire(runner.runnerId);
  });

  it("F-092: stays draining through a disconnect, the runner's restart and a server restart", async () => {
    const { a } = api.fixture;
    const runner = await joined("drain-restarts");
    const peer = await connected(runner);
    expect(await drainRunner(deps(), scopeOf(a.admin, "admin"), { runnerId: runner.runnerId })).toMatchObject({ ok: true });

    // A disconnect.
    peer.close();
    await peer.closed;
    await waitFor(async () => (await api.test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId: runner.runnerId } })).disconnectedAt !== null);
    expect(await stateOf(runner.runnerId)).toBe("draining");

    // The runner restarts: a new process, a new hello.
    const restarted = await connected(runner);
    expect(await stateOf(runner.runnerId)).toBe("draining");
    const task = await seedQueuedTask(api.test.db, world, a.admin, null);
    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: false, error: "no-runner" });
    restarted.close();
    await restarted.closed;

    // Core restarts: the old replica stops, a new one serves, and the runner says hello to it.
    await gateway.stop();
    gateway = await startGateway(api.test.db, api.test.url);
    await connected(runner);
    expect(await stateOf(runner.runnerId)).toBe("draining");
    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: false, error: "no-runner" });
    await retire(runner.runnerId);
  });

  it("F-092: a member is refused, even for their own personal runner, and nothing changes", async () => {
    const { a, b } = api.fixture;
    const own = await seedOnlineRunner(api.test.db, organizationIdSchema.parse(a.organization.id), { kind: "personal", memberId: a.member.id });
    expect(await drainRunner(deps(), scopeOf(a.member, "member"), { runnerId: own.runnerId })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await stateOf(own.runnerId)).toBe("online");
    // Another organization's admin finds no such runner.
    expect(await drainRunner(deps(), scopeOf(b.admin, "admin"), { runnerId: own.runnerId })).toMatchObject({ ok: false, error: "not-found" });
    // An admin drains it; a member can't resume it either.
    expect(await drainRunner(deps(), scopeOf(a.admin, "admin"), { runnerId: own.runnerId })).toMatchObject({ ok: true });
    expect(await resumeRunner(deps(), scopeOf(a.member, "member"), { runnerId: own.runnerId })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await stateOf(own.runnerId)).toBe("draining");
    expect(await api.test.db.auditEntry.count({ where: { action: { in: ["runner.drained", "runner.resumed"] }, entityId: own.runnerId } })).toBe(1);
    // Only an online or offline runner is drained, and only a draining one resumed.
    expect(await drainRunner(deps(), scopeOf(a.admin, "admin"), { runnerId: own.runnerId })).toMatchObject({ ok: false, error: "not-allowed-in-state" });
    await retire(own.runnerId);
  });
});

describe("a resume", () => {
  it("F-092: resumes a connected runner to online, sends resume once, and asks its pool's queue again", async () => {
    const { a } = api.fixture;
    const runner = await joined("resume-online");
    const peer = await connected(runner);
    expect(await drainRunner(deps(), scopeOf(a.admin, "admin"), { runnerId: runner.runnerId })).toMatchObject({ ok: true });
    const drain = await nextCommand(peer, "drain");
    peer.send({ type: "command-ack", upTo: drain.seq, results: [{ id: drain.id, seq: drain.seq, result: "accepted" }] });

    expect(await resumeRunner(deps(), scopeOf(a.admin, "admin"), { runnerId: runner.runnerId })).toEqual({ ok: true, state: "online", commandSent: true });
    expect(await stateOf(runner.runnerId)).toBe("online");
    expect(await api.test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).toMatchObject({ drainedAt: null, drainedByMemberId: null });
    const resume = await nextCommand(peer, "resume");
    peer.send({ type: "command-ack", upTo: resume.seq, results: [{ id: resume.id, seq: resume.seq, result: "accepted" }] });
    await waitFor(async () => (await api.test.db.command.findUniqueOrThrow({ where: { id: resume.id } })).ackedAt !== null);
    expect(await api.test.db.auditEntry.count({ where: { action: "runner.resumed", entityId: runner.runnerId } })).toBe(1);
    const poolId = (await api.test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).poolId;
    expect(enqueued).toContainEqual({ name: "queue.admit", payload: { organizationId: a.organization.id, poolId } });

    // Applied once: a reconnect from the acked seq gets no second `resume`.
    peer.close();
    await peer.closed;
    const again = await connected(runner, { lastCommandSeq: resume.seq });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(commandKinds(again)).not.toContain("resume");
    expect(await api.test.db.command.count({ where: { runnerId: runner.runnerId, kind: "resume" } })).toBe(1);

    // And it takes tasks again.
    const task = await seedQueuedTask(api.test.db, world, a.admin, null);
    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: true, runnerId: runner.runnerId });
    await retire(runner.runnerId);
  });

  it("F-092: resumes a runner that isn't connected to offline, and it goes online at its next hello", async () => {
    const { a } = api.fixture;
    const runner = await joined("resume-offline");
    const peer = await connected(runner);
    expect(await drainRunner(deps(), scopeOf(a.admin, "admin"), { runnerId: runner.runnerId })).toMatchObject({ ok: true });
    peer.close();
    await peer.closed;
    await waitFor(async () => (await api.test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId: runner.runnerId } })).disconnectedAt !== null);

    expect(await resumeRunner(deps(), scopeOf(a.admin, "admin"), { runnerId: runner.runnerId })).toEqual({ ok: true, state: "offline", commandSent: true });
    expect(await stateOf(runner.runnerId)).toBe("offline");
    await connected(runner);
    expect(await stateOf(runner.runnerId)).toBe("online");
    expect(await resumeRunner(deps(), scopeOf(a.admin, "admin"), { runnerId: runner.runnerId })).toMatchObject({ ok: false, error: "not-draining" });
    await retire(runner.runnerId);
  });

  it("F-092: a minor-3 runner gets no resume command, and the result says so", async () => {
    const { a } = api.fixture;
    const runner = await joined("resume-minor-3");
    const peer = await connected(runner, { minor: 3 });
    expect(await drainRunner(deps(), scopeOf(a.admin, "admin"), { runnerId: runner.runnerId })).toMatchObject({ ok: true });
    await nextCommand(peer, "drain");
    expect(await resumeRunner(deps(), scopeOf(a.admin, "admin"), { runnerId: runner.runnerId })).toEqual({ ok: true, state: "online", commandSent: false });
    expect(await api.test.db.command.count({ where: { runnerId: runner.runnerId, kind: "resume" } })).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(commandKinds(peer)).not.toContain("resume");
    await retire(runner.runnerId);
  });
});
