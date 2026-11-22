import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { appendServerEvent, parseServerSettings, postgresAuditLog, postgresChangeNotices, reopenCarryOnText, reopenTask, systemClock } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import {
  blobIdSchema,
  clientMessageIdSchema,
  gitShaSchema,
  memberIdSchema,
  PROTOCOL_MINOR,
  repoIdSchema,
  runnerHeaders,
  runnerPaths,
  segmentIdSchema,
  sessionIdSchema,
  taskSpecSchema,
  turnIdSchema,
} from "@ostra/protocol";
import type { BlobRef, DownFrame, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startCore } from "../core.ts";
import type { RunningCore } from "../core.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { accessToken, connect, registerPersonal } from "../testing/harness.ts";
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
  it("F-047/c1: frees its runner's slot: a capacity-1 runner takes the next task, and the crash keeps its needs-you item and its events", async () => {
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

  it("F-047/c1,c2, F-045/c3: a box lost mid-turn with its runner: the restarted runner's crash keeps the branch and the hidden ref, and one click reopens the task on a fresh box from the last archive, with the lost turn's message", async () => {
    const runner: RegisteredRunner = await registerPersonal(harness, test.db, fixture.a.member);
    let peer = await connect(harness, runner);
    try {
      await peer.next("welcome");
      const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
      await core.db.$transaction((tx) => core.jobs.sendInTx(tx, "task.dispatch", dispatchPayload(task)));
      const firstOffer = await acceptNextDispatch(peer, task);
      const firstBox = (await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).boxId;

      // The first turn finishes: its branch is pushed, its hidden ref and its archive saved, its PR opened.
      const repoId = repoIdSchema.parse(world.repoId);
      const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
      const head = gitShaSchema.parse("a".repeat(40));
      const hidden = gitShaSchema.parse("b".repeat(40));
      const blob = await test.db.blob.create({
        data: {
          organizationId: task.organizationId,
          projectId: world.projectId,
          taskId: task.taskId,
          store: "postgres",
          key: `postgres:${randomBytes(8).toString("hex")}`,
          purpose: "session-archive",
          contentType: "application/gzip",
          size: 1234,
          sha256: randomBytes(32).toString("hex"),
        },
      });
      const archive: BlobRef = { blobId: blobIdSchema.parse(blob.id), size: blob.size, sha256: blob.sha256 };
      await sendEvents(peer, task, [
        { kind: "turn.started", turnId },
        { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s-1"), text: "I added CONTRIBUTING.md." },
        { kind: "git.pushed", repoId, branch: branchName, headSha: head, ref: `refs/heads/${branchName}` },
        { kind: "turn.ended", turnId, stopReason: "end_turn" },
        { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId, headSha: head, ahead: true, hiddenRefSha: hidden }], archive },
      ]);
      await waitFor("the first PR", async () => (await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state === "in_review");
      const pulls = codeHost.pulls.length;

      // A member asks for more, and the next turn starts answering it.
      const lostMessage = "Now add a section on the linters.";
      await core.db.$transaction((tx) =>
        appendServerEvent(tx, {
          organizationId: task.organizationId,
          projectId: world.projectId,
          taskId: task.taskId,
          sessionId: task.sessionId,
          at: Date.now(),
          event: { kind: "user.message", memberId: memberIdSchema.parse(fixture.a.member.id), clientMessageId: clientMessageIdSchema.parse("lost-turn-message-1"), text: lostMessage, delivery: "queued" },
        }),
      );
      const secondTurn = turnIdSchema.parse("turn-2");
      await sendEvents(
        peer,
        task,
        [
          { kind: "turn.started", turnId: secondTurn },
          { kind: "agent.message", turnId: secondTurn, segmentId: segmentIdSchema.parse("s-2"), text: "Adding the linters section." },
        ],
        6,
      );

      // The runner's process dies, and the box with it. Started again, it reports the session it held
      // crashed, as its task host does for each session its last process left (`reportRestoredSessions`).
      peer.close();
      await peer.closed;
      peer = await connect(harness, runner, { lastCommandSeq: firstOffer.seq });
      await peer.next("welcome");
      await sendEvents(peer, task, [{ kind: "session.crashed", error: "the runner restarted while the session was running" }], 8);
      expect(await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).toMatchObject({ state: "crashed" });
      expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "needs_you", needsYouReason: "crashed" });
      // The branch, the hidden ref and the PR stay: nothing deletes a ref or closes the PR.
      expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "pr_open", headSha: head, hiddenRefSha: hidden });
      expect(codeHost.deletedRefs).toEqual([]);
      expect(codeHost.pulls.length).toBe(pulls);

      // One click: the reopen with no words of the member's, from the crash.
      const scope: MemberScope = { organizationId: task.organizationId, memberId: memberIdSchema.parse(fixture.a.member.id), role: "member", projectRoles: new Map() };
      const reopened = await core.db.$transaction((tx) =>
        reopenTask(
          { tx, scope, jobs: core.jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock },
          { taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse("one-click-reopen-1") },
        ),
      );
      if (!reopened.ok) throw new Error(`the reopen was refused: ${reopened.error}`);
      const next: QueuedTask = { ...task, sessionId: sessionIdSchema.parse(reopened.sessionId) };
      await acceptNextDispatch(peer, next);
      const session = await test.db.session.findUniqueOrThrow({ where: { id: next.sessionId } });
      // A fresh box, restored from the last finished turn's archive and the hidden ref.
      expect(session.origin).toBe("restored");
      expect(session.boxId).not.toBe(firstBox);
      const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
      const token = await accessToken(harness, runner);
      const response = await fetch(`${harness.url}${runnerPaths.taskSpec(task.taskId)}?leaseEpoch=${String(leaseEpoch)}`, {
        headers: { authorization: `Bearer ${token.accessToken}`, [runnerHeaders.minor]: String(PROTOCOL_MINOR) },
      });
      expect(response.status).toBe(200);
      const spec = taskSpecSchema.parse(await response.json());
      expect(spec.restore).toMatchObject({ origin: "restored", archive, hiddenRefs: [{ repoId, sha: hidden, baseSha: head }] });
      // The runner replays the message the lost turn was answering, from the event log, once: the
      // one click adds no words of its own ("Carry on from where you stopped.") when that one is owed.
      expect(spec.restore?.pendingMessages.map((message) => message.text)).toEqual([lostMessage]);
      const replayed = await test.db.event.findMany({ where: { sessionId: next.sessionId, kind: "user.message" }, orderBy: { seq: "asc" } });
      expect(replayed.map((row) => row.payload)).toEqual([expect.objectContaining({ text: lostMessage, replayed: true })]);
      expect(JSON.stringify(replayed.map((row) => row.payload))).not.toContain(reopenCarryOnText);
    } finally {
      peer.close();
    }
  }, 90_000);
});

