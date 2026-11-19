import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { appendServerEvent, parseServerSettings } from "@ostra/domain";
import { clientMessageIdSchema, gitShaSchema, memberIdSchema, repoIdSchema, segmentIdSchema, turnIdSchema } from "@ostra/protocol";
import type { DownFrame, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startCore } from "../core.ts";
import type { RunningCore } from "../core.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { connect, registerPersonal } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";
import { runnerEvent } from "../testing/seed.ts";
import { dispatchPayload, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";

// A crash frees the runner's slot (F-047, ADR 0034): the whole of core, as `startCore` runs it
// (the dispatch worker, the requeue sweep, the gateway, ingest), with a personal runner of
// capacity 1 on a fake peer that answers as the runner does. Only the external services are fakes.

let test: TestDatabase;
let fixture: IsolationFixture;
let world: World;
let core: RunningCore;
let dataDir: string;
let harness: GatewayHarness;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const turnId = turnIdSchema.parse("turn-1");

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-crash-"));
  const parsed = parseServerSettings({ DATABASE_URL: test.url, OSTRA_DATA_DIR: dataDir, OSTRA_CATALOG_FETCH: "false" });
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  core = await startCore({ ...parsed.settings, corePort: 0 }, silentLogger, {
    host: "127.0.0.1",
    adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
  });
  harness = { url: `http://127.0.0.1:${String(core.port)}`, gateway: core.gateway, stop: core.stop };
});

afterAll(async () => {
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

/** The next dispatch the runner is offered, answered `accepted` as the task host answers it. */
const acceptNextDispatch = async (peer: FakePeer, task: QueuedTask, timeoutMs = 20_000): Promise<Extract<DownFrame, { type: "command" }>> => {
  const command = await peer.next("command", timeoutMs);
  expect(command.kind).toBe("dispatch");
  expect(command.body).toMatchObject({ taskId: task.taskId, sessionId: task.sessionId });
  peer.send({ type: "command-ack", upTo: command.seq, results: [{ id: command.id, seq: command.seq, result: "accepted" }] });
  await waitFor("the offer's acceptance", async () => (await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state === "preparing");
  return command;
};

const sendEvents = async (peer: FakePeer, task: QueuedTask, events: readonly TaskEvent[], from = 1): Promise<void> => {
  peer.send({ type: "events", events: events.map((event, index) => runnerEvent(task, from + index, event)) });
  const ack = await peer.next("ack");
  expect(ack).toEqual({ type: "ack", sessionId: task.sessionId, upTo: from + events.length - 1 });
};

describe("a task that crashes", () => {
  it("F-047: frees its runner's slot: a capacity-1 runner takes the next task, and the crash keeps its needs-you item and its events", async () => {
    const runner: RegisteredRunner = await registerPersonal(harness, test.db, fixture.a.member);
    expect((await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).capacity).toBe(1);
    const peer = await connect(harness, runner);
    try {
      await peer.next("welcome");

      // The first task takes the runner's one slot.
      const first = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
      await core.db.$transaction((tx) => core.jobs.sendInTx(tx, "task.dispatch", dispatchPayload(first)));
      await acceptNextDispatch(peer, first);

      // A second one waits: the runner is full.
      const second = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
      await waitFor("the second task to wait for a slot", async () => (await test.db.task.findUniqueOrThrow({ where: { id: second.taskId } })).dispatchWait !== null);
      expect(await test.db.lease.count({ where: { taskId: second.taskId } })).toBe(0);

      // The first task's agent dies mid-turn, and the runner says so.
      await sendEvents(peer, first, [
        { kind: "turn.started", turnId },
        { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s-1"), text: "Reading the tests first." },
        { kind: "session.crashed", error: "the agent's process exited mid-turn" },
      ]);

      // The crash: needs you for the driver, the session crashed, the box failed, the events kept.
      expect(await test.db.task.findUniqueOrThrow({ where: { id: first.taskId } })).toMatchObject({ state: "needs_you", needsYouReason: "crashed" });
      expect(await test.db.needsYouItem.findMany({ where: { taskId: first.taskId } })).toMatchObject([
        { reason: "crashed", audience: "driver", state: "open" },
      ]);
      expect(await test.db.session.findUniqueOrThrow({ where: { id: first.sessionId } })).toMatchObject({ state: "crashed" });
      expect((await test.db.event.findMany({ where: { taskId: first.taskId }, orderBy: { seq: "asc" } })).map((row) => row.kind)).toEqual([
        "turn.started",
        "agent.message",
        "session.crashed",
      ]);
      const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: first.taskId } });
      expect(lease).toMatchObject({ state: "ended", endReason: "released" });
      expect(await test.db.box.findUniqueOrThrow({ where: { id: lease.boxId } })).toMatchObject({ state: "failed", failedReason: "the session crashed" });

      // The slot is free: core's requeue sweep offers the waiting task to the same runner, and it starts.
      const offered = await acceptNextDispatch(peer, second);
      expect(offered.body).toMatchObject({ leaseEpoch: 1 });
      expect(await test.db.lease.findFirstOrThrow({ where: { taskId: second.taskId, state: "active" } })).toMatchObject({ runnerId: runner.runnerId });
      await sendEvents(peer, second, [{ kind: "turn.started", turnId }]);
      expect(await test.db.task.findUniqueOrThrow({ where: { id: second.taskId } })).toMatchObject({ state: "running" });
      expect(await test.db.session.findUniqueOrThrow({ where: { id: second.sessionId } })).toMatchObject({ state: "running" });
    } finally {
      peer.close();
    }
  }, 60_000);

  it("F-047 (ticket 38): a reopen's turn that crashes after its save moved the task to review still needs you, and owes its message", async () => {
    const runner: RegisteredRunner = await registerPersonal(harness, test.db, fixture.a.member);
    const peer = await connect(harness, runner);
    try {
      await peer.next("welcome");
      const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
      // The member's message, as a reopen writes it: the turn below answers it.
      await core.db.$transaction((tx) =>
        appendServerEvent(tx, {
          organizationId: task.organizationId,
          projectId: world.projectId,
          taskId: task.taskId,
          sessionId: task.sessionId,
          at: Date.now(),
          event: { kind: "user.message", memberId: memberIdSchema.parse(fixture.a.member.id), clientMessageId: clientMessageIdSchema.parse("crash-after-save-1"), text: "Add a second file.", delivery: "queued" },
        }),
      );
      await core.db.$transaction((tx) => core.jobs.sendInTx(tx, "task.dispatch", dispatchPayload(task)));
      await acceptNextDispatch(peer, task);
      // The agent dies mid-turn; the runner still saves the work, which moves the task to review,
      // and only then says the session crashed (the order the live run showed).
      const repoId = repoIdSchema.parse(world.repoId);
      await sendEvents(peer, task, [
        { kind: "turn.started", turnId },
        { kind: "turn.failed", turnId, error: "the agent's process exited mid-turn" },
        { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId, headSha: gitShaSchema.parse("c".repeat(40)), ahead: true, hiddenRefSha: null }], archive: null },
      ]);
      await waitFor("the save's move to review", async () => (await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state === "in_review");
      await sendEvents(peer, task, [{ kind: "session.crashed", error: "the agent's process exited mid-turn" }], 4);
      expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "needs_you", needsYouReason: "crashed" });
      expect(await test.db.needsYouItem.findMany({ where: { taskId: task.taskId, reason: "crashed" } })).toMatchObject([{ state: "open" }]);
    } finally {
      peer.close();
    }
  }, 60_000);
});
