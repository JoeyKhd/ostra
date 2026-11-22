import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { boxUnscheduledFailedReason, dispatchWaitFromDb, parseServerSettings } from "@ostra/domain";
import { runnerPaths, taskTokenResponseSchema, turnIdSchema } from "@ostra/protocol";
import type { BoxId, BoxUnscheduledReason, DownFrame, LeaseEpoch, RunnerId, UpFrame } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startCore } from "../core.ts";
import type { RunningCore } from "../core.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connectPeer } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { postJson } from "../testing/harness.ts";
import { runnerEvent } from "../testing/seed.ts";
import { seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";

// ADR 0060 (amended 2026-11-22), F-093: a `kubernetes` box the cluster never placed (no node within
// the node wait, or no room: an unschedulable pod with no scale-up, or the namespace's quota
// refused it) goes back to its pool's queue with its place, not to a crash. The runner says so in
// a `runner-event` frame (`box.unscheduled`), after a status that offers no slot. The whole of core
// as `startCore` runs it (the dispatch and admission workers, the queue's sweep, the gateway,
// ingest), a fake peer for the pool runner and one for the box's sidecar, each answering as the
// runner's kubernetes dispatcher and the sidecar's task host do. Only the external services are fakes.

let test: TestDatabase;
let fixture: IsolationFixture;
let world: World;
let core: RunningCore;
let dataDir: string;
let url: string;
let poolRunner: RunnerId;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const peers: FakePeer[] = [];
/** The pool runner's last command applied, which its next connection's hello names, as a runner's does. */
let lastCommandSeq = 0;

/** What the runner's cluster offers: plenty of CPU and memory, so only the slots decide. */
const OFFER = { cpuMillis: 64_000, memoryMiB: 131_072 } as const;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  // The organization's default pool, with one `kubernetes` pool runner of 4 slots.
  const pool = await test.db.runnerPool.create({ data: { organizationId: fixture.a.organization.id, name: "cluster", isDefault: true } });
  poolRunner = (await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "pool", poolId: pool.id }, 4)).runnerId;
  await test.db.runner.update({ where: { id: poolRunner }, data: { executor: "kubernetes" } });
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-box-unscheduled-"));
  const parsed = parseServerSettings({ DATABASE_URL: test.url, OSTRA_DATA_DIR: dataDir, OSTRA_CATALOG_FETCH: "false" });
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  core = await startCore({ ...parsed.settings, corePort: 0 }, silentLogger, {
    host: "127.0.0.1",
    adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
  });
  url = `http://127.0.0.1:${String(core.port)}`;
});

afterAll(async () => {
  for (const peer of peers.splice(0)) peer.close();
  await core.stop();
  await test.dispose();
  await rm(dataDir, { recursive: true, force: true });
});

const waitFor = async (what: string, check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const runnerToken = (): string => core.gateway.context.tokens.issue(poolRunner, fixture.a.organization.id, Date.now()).accessToken;

type Boxed = QueuedTask & { readonly boxId: BoxId; readonly leaseEpoch: LeaseEpoch };

/** The next dispatch the runner is offered, accepted at once, as its kubernetes dispatcher accepts one. */
const acceptNextDispatch = async (runner: FakePeer, task: QueuedTask, timeoutMs = 20_000): Promise<Boxed> => {
  for (;;) {
    const command: Extract<DownFrame, { type: "command" }> = await runner.next("command", timeoutMs);
    lastCommandSeq = Math.max(lastCommandSeq, command.seq);
    if (command.kind !== "dispatch") {
      runner.send({ type: "command-ack", upTo: command.seq, results: [{ id: command.id, seq: command.seq, result: "done" }] });
      continue;
    }
    expect(command.body).toMatchObject({ taskId: task.taskId, sessionId: task.sessionId });
    runner.send({ type: "command-ack", upTo: command.seq, results: [{ id: command.id, seq: command.seq, result: "accepted" }] });
    await waitFor("the offer's acceptance", async () => (await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state === "preparing");
    return { ...task, boxId: command.body.boxId, leaseEpoch: command.body.leaseEpoch };
  }
};

/** The runner's status, as its kubernetes dispatcher reports it: `slots` 0 while it holds its room. */
const status = (slots: number): UpFrame => ({
  type: "status",
  executor: "kubernetes",
  capacity: 4,
  freeSlots: slots,
  labels: [],
  version: "0.0.0",
  running: [],
  spoolBytes: 0,
  resources: { slots, ...OFFER },
});

/** What the runner's dispatcher sends when the cluster never placed a box: its room held, then the word. */
const unscheduled = (runner: FakePeer, box: BoxId, reason: BoxUnscheduledReason): void => {
  runner.send(status(0));
  runner.send({ type: "runner-event", at: Date.now(), event: { kind: "box.unscheduled", boxId: box, reason } });
};

const dispatchesOf = (task: QueuedTask): Promise<number> => test.db.command.count({ where: { taskId: task.taskId, kind: "dispatch" } });

describe("a kubernetes box the cluster never placed (ADR 0060, F-093)", () => {
  it("F-093/c3: a box with no room goes back to the queue with its place, not to a crash; while its runner offers no slot no offer goes out, the sweep's included; once it offers room the task runs on a fresh box; a box with no node likewise", async () => {
    const runner = await connectPeer(url, runnerToken(), poolRunner, { executor: "kubernetes", lastCommandSeq });
    peers.push(runner);
    await runner.next("welcome");
    runner.send(status(4));

    const queued = await seedQueuedTask(test.db, world, fixture.a.member, null);
    const first = await acceptNextDispatch(runner, queued);
    const { queuedAt } = await test.db.task.findUniqueOrThrow({ where: { id: queued.taskId }, select: { queuedAt: true } });
    expect(queuedAt).not.toBeNull();

    // The cluster had no room: back in the queue.
    unscheduled(runner, first.boxId, "no-room");
    await waitFor("the requeue", async () => (await test.db.task.findUniqueOrThrow({ where: { id: queued.taskId } })).state === "queued");
    // Not a crash: the session that never ran waits for the next box, and nothing needs a member.
    expect(await test.db.session.findUniqueOrThrow({ where: { id: queued.sessionId } })).toMatchObject({ state: "starting" });
    expect(await test.db.needsYouItem.count({ where: { taskId: queued.taskId } })).toBe(0);
    expect(await test.db.event.count({ where: { taskId: queued.taskId, kind: "session.crashed" } })).toBe(0);
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: queued.taskId, epoch: first.leaseEpoch } })).toMatchObject({ state: "ended", endReason: "no-room" });
    expect(await test.db.box.findUniqueOrThrow({ where: { id: first.boxId } })).toMatchObject({ state: "failed", failedReason: boxUnscheduledFailedReason("no-room") });
    // Its place: its first queued time, kept.
    expect((await test.db.task.findUniqueOrThrow({ where: { id: queued.taskId } })).queuedAt).toEqual(queuedAt);

    // No hot loop: while the runner offers no slot, the admission words the wait and offers nothing,
    // past the queue's sweep (every 5 s) too. The one offer is the first.
    await waitFor("the wait's reason", async () => dispatchWaitFromDb((await test.db.task.findUniqueOrThrow({ where: { id: queued.taskId } })).dispatchWait)?.code === "queued");
    await expect(runner.next("command", 6_000)).rejects.toThrow(/no command frame/);
    expect(await dispatchesOf(queued)).toBe(1);
    // The runner says it again on its next connection (it keeps its events an hour): nothing changes.
    unscheduled(runner, first.boxId, "no-room");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await dispatchesOf(queued)).toBe(1);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: queued.taskId } })).toMatchObject({ state: "queued" });

    // Room again: the task is offered a fresh box at the next epoch, and runs.
    runner.send(status(4));
    const second = await acceptNextDispatch(runner, queued);
    expect(second.boxId).not.toBe(first.boxId);
    expect(second.leaseEpoch).toBe(first.leaseEpoch + 1);
    const response = await postJson(`${url}${runnerPaths.taskToken(queued.taskId)}`, { leaseEpoch: second.leaseEpoch }, runnerToken());
    expect(response.status).toBe(200);
    const { taskToken } = taskTokenResponseSchema.parse(response.body);
    const sidecar = await connectPeer(url, taskToken, poolRunner, { peer: { kind: "sidecar", taskId: queued.taskId, boxId: second.boxId, leaseEpoch: second.leaseEpoch } });
    peers.push(sidecar);
    await sidecar.next("welcome");
    sidecar.send({ type: "events", events: [runnerEvent(second, 1, { kind: "turn.started", turnId: turnIdSchema.parse("turn-1") }, second.leaseEpoch)] });
    await waitFor("the task's run", async () => (await test.db.task.findUniqueOrThrow({ where: { id: queued.taskId } })).state === "running");

    // No node joined within the node wait: the same, with its own words on the lease and the box.
    const another = await seedQueuedTask(test.db, world, fixture.a.member, null);
    const waited = await acceptNextDispatch(runner, another);
    unscheduled(runner, waited.boxId, "no-node");
    await waitFor("the no-node requeue", async () => (await test.db.task.findUniqueOrThrow({ where: { id: another.taskId } })).state === "queued");
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: another.taskId, epoch: waited.leaseEpoch } })).toMatchObject({ state: "ended", endReason: "no-node" });
    expect(await test.db.box.findUniqueOrThrow({ where: { id: waited.boxId } })).toMatchObject({ state: "failed", failedReason: boxUnscheduledFailedReason("no-node") });
    expect(await test.db.session.findUniqueOrThrow({ where: { id: another.sessionId } })).toMatchObject({ state: "starting" });
    runner.send(status(4));
    const placed = await acceptNextDispatch(runner, another);
    expect(placed.leaseEpoch).toBe(waited.leaseEpoch + 1);

    // The running task's box isn't moved by a word about it: it ran.
    unscheduled(runner, second.boxId, "no-room");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await test.db.task.findUniqueOrThrow({ where: { id: queued.taskId } })).toMatchObject({ state: "running" });
    sidecar.close();
    runner.close();
    await runner.closed;
    // Back online for the next case's dispatch: its own connection went with it.
    await test.db.runner.update({ where: { id: poolRunner }, data: { state: "online" } });
    await test.db.runnerPresence.update({ where: { runnerId: poolRunner }, data: { disconnectedAt: null } });
  }, 120_000);

  it("F-093/c3: a box.unscheduled from a runner the box isn't on changes nothing", async () => {
    const runner = await connectPeer(url, runnerToken(), poolRunner, { executor: "kubernetes", lastCommandSeq });
    peers.push(runner);
    await runner.next("welcome");
    runner.send(status(4));
    const queued = await seedQueuedTask(test.db, world, fixture.a.member, null);
    const task = await acceptNextDispatch(runner, queued);

    const otherPool = await test.db.runnerPool.create({ data: { organizationId: fixture.a.organization.id, name: "another cluster" } });
    const other = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "pool", poolId: otherPool.id }, 1);
    await test.db.runner.update({ where: { id: other.runnerId }, data: { executor: "kubernetes" } });
    const stranger = await connectPeer(url, core.gateway.context.tokens.issue(other.runnerId, fixture.a.organization.id, Date.now()).accessToken, other.runnerId, { executor: "kubernetes" });
    peers.push(stranger);
    await stranger.next("welcome");
    stranger.send({ type: "runner-event", at: Date.now(), event: { kind: "box.unscheduled", boxId: task.boxId, reason: "no-room" } });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await test.db.task.findUniqueOrThrow({ where: { id: queued.taskId } })).toMatchObject({ state: "preparing" });
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: queued.taskId, epoch: task.leaseEpoch } })).toMatchObject({ state: "active" });
    stranger.close();
    runner.close();
    await runner.closed;
  }, 60_000);
});
