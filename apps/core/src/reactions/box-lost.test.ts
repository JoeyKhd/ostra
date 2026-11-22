import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  appendServerEvent,
  BOX_LOST_ERROR,
  parseServerSettings,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  reopenCarryOnText,
  reopenTask,
  systemClock,
} from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import {
  blobIdSchema,
  clientMessageIdSchema,
  gitShaSchema,
  leaseEpochSchema,
  memberIdSchema,
  PROTOCOL_MINOR,
  repoIdSchema,
  runnerHeaders,
  runnerPaths,
  segmentIdSchema,
  sessionIdSchema,
  taskSpecSchema,
  taskTokenResponseSchema,
  turnIdSchema,
} from "@ostra/protocol";
import type { BlobRef, BoxId, DownFrame, LeaseEpoch, RunnerId, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startCore } from "../core.ts";
import type { RunningCore } from "../core.ts";
import { endGraceInTx } from "../ingest/grace.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connectPeer } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { postJson } from "../testing/harness.ts";
import { runnerEvent } from "../testing/seed.ts";
import { seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";

// F-047 and F-045/c3 on a pool runner's boxes (ADR 0029's parity, ADR 0039's lost box): a `docker`
// or `kubernetes` box's session is its sidecar's, so when the box goes mid-turn only its runner
// sees it, and says `box.lost` in a runner event. The whole of core as `startCore` runs it (the
// dispatch and admission workers, the gateway, ingest, the sidecar's grace, the reactions, the spec
// endpoint), a fake peer for the pool runner and one for the box's sidecar, each answering as the
// runner's box dispatcher and the sidecar's task host do. Only the external services are fakes.

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

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  // The organization's default pool, with one pool runner: a task with no picked runner goes there.
  const pool = await test.db.runnerPool.create({ data: { organizationId: fixture.a.organization.id, name: "boxes", isDefault: true } });
  poolRunner = (await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "pool", poolId: pool.id }, 4)).runnerId;
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-box-lost-"));
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

/** The pool runner's own access token, as core issues it for a signed assertion. */
const runnerToken = (): string => core.gateway.context.tokens.issue(poolRunner, fixture.a.organization.id, Date.now()).accessToken;

type Boxed = QueuedTask & { readonly boxId: BoxId; readonly leaseEpoch: LeaseEpoch };

/**
 * The next dispatch the pool runner is offered, accepted as its box dispatcher accepts one (at
 * once); any other command first is answered `done`. The box and its lease, as core made them.
 */
const acceptNextDispatch = async (runner: FakePeer, task: QueuedTask): Promise<Boxed> => {
  for (;;) {
    const command: Extract<DownFrame, { type: "command" }> = await runner.next("command", 20_000);
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

/** What the box dispatcher does when it makes the box: asks core for its sidecar's task token, once. */
const sidecarOf = async (task: Boxed): Promise<FakePeer> => {
  const response = await postJson(`${url}${runnerPaths.taskToken(task.taskId)}`, { leaseEpoch: task.leaseEpoch }, runnerToken());
  expect(response.status).toBe(200);
  const { taskToken } = taskTokenResponseSchema.parse(response.body);
  const sidecar = await connectPeer(url, taskToken, poolRunner, { peer: { kind: "sidecar", taskId: task.taskId, boxId: task.boxId, leaseEpoch: task.leaseEpoch } });
  peers.push(sidecar);
  await sidecar.next("welcome");
  return sidecar;
};

const sendEvents = async (sidecar: FakePeer, task: Boxed, events: readonly TaskEvent[], from: number): Promise<void> => {
  sidecar.send({ type: "events", events: events.map((event, index) => runnerEvent(task, from + index, event, task.leaseEpoch)) });
  expect(await sidecar.next("ack")).toEqual({ type: "ack", sessionId: task.sessionId, upTo: from + events.length - 1 });
};

const graceJobs = async (task: Boxed) =>
  (await core.jobs.find("task.grace", { organizationId: task.organizationId, taskId: task.taskId, leaseEpoch: task.leaseEpoch })).filter((job) => job.state === "created");

describe("a pool runner's box lost under its task (F-047, F-045/c3)", () => {
  for (const executor of ["docker", "kubernetes"] as const) {
    it(`F-047/c1,c2, F-045/c3: a ${executor} box lost mid-turn while its runner stays: the runner's box.lost marks the session crashed at once and keeps the branch and the hidden ref, and one click reopens the task on a fresh box from the last archive, with the lost turn's message`, async () => {
      await test.db.runner.update({ where: { id: poolRunner }, data: { executor } });
      const runner = await connectPeer(url, runnerToken(), poolRunner, { executor, lastCommandSeq });
      peers.push(runner);
      await runner.next("welcome");

      const queued = await seedQueuedTask(test.db, world, fixture.a.member, null);
      const task = await acceptNextDispatch(runner, queued);
      const firstBox = await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } });
      expect(firstBox.executor).toBe(executor);
      let sidecar = await sidecarOf(task);

      // The first turn finishes in the box: its branch pushed, its hidden ref and its archive saved, its PR opened.
      const repoId = repoIdSchema.parse(world.repoId);
      const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
      const head = gitShaSchema.parse("d".repeat(40));
      const hidden = gitShaSchema.parse("e".repeat(40));
      const blob = await test.db.blob.create({
        data: {
          organizationId: task.organizationId,
          projectId: world.projectId,
          taskId: task.taskId,
          store: "postgres",
          key: `postgres:${randomBytes(8).toString("hex")}`,
          purpose: "session-archive",
          contentType: "application/gzip",
          size: 2048,
          sha256: randomBytes(32).toString("hex"),
        },
      });
      const archive: BlobRef = { blobId: blobIdSchema.parse(blob.id), size: blob.size, sha256: blob.sha256 };
      const turnId = turnIdSchema.parse("turn-1");
      await sendEvents(
        sidecar,
        task,
        [
          { kind: "turn.started", turnId },
          { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s-1"), text: "I added CONTRIBUTING.md." },
          { kind: "git.pushed", repoId, branch: branchName, headSha: head, ref: `refs/heads/${branchName}` },
          { kind: "turn.ended", turnId, stopReason: "end_turn" },
          { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId, headSha: head, ahead: true, hiddenRefSha: hidden }], archive },
        ],
        1,
      );
      await waitFor("the first PR", async () => (await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state === "in_review");
      const pulls = codeHost.pulls.length;

      // A member asks for more, and the next turn starts answering it in the same box.
      const lostMessage = `Now add a section on the linters (${executor}).`;
      await core.db.$transaction((tx) =>
        appendServerEvent(tx, {
          organizationId: task.organizationId,
          projectId: world.projectId,
          taskId: task.taskId,
          sessionId: task.sessionId,
          at: Date.now(),
          event: { kind: "user.message", memberId: memberIdSchema.parse(fixture.a.member.id), clientMessageId: clientMessageIdSchema.parse(`box-lost-${executor}-1`), text: lostMessage, delivery: "queued" },
        }),
      );
      const secondTurn = turnIdSchema.parse("turn-2");
      await sendEvents(
        sidecar,
        task,
        [
          { kind: "turn.started", turnId: secondTurn },
          { kind: "agent.message", turnId: secondTurn, segmentId: segmentIdSchema.parse("s-2"), text: "Adding the linters section." },
        ],
        6,
      );
      expect(await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).toMatchObject({ state: "running" });

      // The box dies mid-turn while its runner stays up. On docker the sidecar's connection goes
      // first and its grace starts; on kubernetes the runner's word comes first, here.
      const lost = { type: "runner-event", at: Date.now(), event: { kind: "box.lost", boxId: task.boxId, exitCode: 137 } } as const;
      if (executor === "docker") {
        sidecar.close();
        await sidecar.closed;
        await waitFor("the sidecar's grace", async () => (await graceJobs(task)).length === 1);
      }
      runner.send(lost);
      await waitFor("the crash", async () => (await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).state === "crashed");
      if (executor === "kubernetes") {
        sidecar.close();
        await sidecar.closed;
      }

      // Crashed at once, not stopped after the grace: needs you for the driver, the box failed, the lease ended.
      const crashed = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
      expect(crashed).toMatchObject({ state: "needs_you", needsYouReason: "crashed", stoppedReason: null, leaseEpoch: task.leaseEpoch });
      expect(await test.db.needsYouItem.findMany({ where: { taskId: task.taskId, reason: "crashed" } })).toMatchObject([{ audience: "driver", state: "open" }]);
      expect(await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).toMatchObject({ state: "failed", failedReason: "the session crashed" });
      expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, epoch: task.leaseEpoch } })).toMatchObject({ state: "ended", endReason: "released" });
      // On the task's timeline: core's own `session.crashed`, with the cause `box_lost`.
      const crashes = await test.db.event.findMany({ where: { taskId: task.taskId, kind: "session.crashed" } });
      expect(crashes.map((row) => ({ sessionId: row.sessionId, sessionSeq: row.sessionSeq, payload: row.payload }))).toEqual([
        { sessionId: task.sessionId, sessionSeq: null, payload: { kind: "session.crashed", error: BOX_LOST_ERROR, cause: "box_lost" } },
      ]);
      // The branch, the hidden ref and the PR stay: nothing deletes a ref or closes the PR.
      expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "pr_open", headSha: head, hiddenRefSha: hidden });
      expect(codeHost.deletedRefs).toEqual([]);
      expect(codeHost.pulls.length).toBe(pulls);
      // The sidecar's grace, when it comes, finds the lease ended and stops nothing; on kubernetes none started.
      const graceDeps = { jobs: core.jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, logger: silentLogger };
      const graceEnd = await core.db.$transaction(async (tx) =>
        endGraceInTx(graceDeps, tx, mapTask(await tx.task.findUniqueOrThrow({ where: { id: task.taskId } })), { organizationId: task.organizationId, taskId: task.taskId, leaseEpoch: task.leaseEpoch }),
      );
      expect(graceEnd).toBe("lease-ended");
      if (executor === "kubernetes") {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(await graceJobs(task)).toEqual([]);
      }

      // The runner says it again on its next connection (it keeps its events an hour): nothing changes.
      runner.send({ ...lost, at: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "session.crashed" } })).toBe(1);
      expect(await test.db.needsYouItem.count({ where: { taskId: task.taskId, reason: "crashed" } })).toBe(1);

      // One click: the reopen with no words of the member's, from the crash.
      const scope: MemberScope = { organizationId: task.organizationId, memberId: memberIdSchema.parse(fixture.a.member.id), role: "member", projectRoles: new Map() };
      const reopened = await core.db.$transaction((tx) =>
        reopenTask(
          { tx, scope, jobs: core.jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock },
          { taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(`box-lost-${executor}-reopen`) },
        ),
      );
      if (!reopened.ok) throw new Error(`the reopen was refused: ${reopened.error}`);
      const next = await acceptNextDispatch(runner, { ...task, sessionId: sessionIdSchema.parse(reopened.sessionId) });
      // A fresh box on the pool, restored from the last finished turn's archive and the hidden ref.
      expect(next.boxId).not.toBe(task.boxId);
      expect(next.leaseEpoch).toBe(leaseEpochSchema.parse(task.leaseEpoch + 1));
      expect(await test.db.box.findUniqueOrThrow({ where: { id: next.boxId } })).toMatchObject({ executor });
      expect(await test.db.session.findUniqueOrThrow({ where: { id: next.sessionId } })).toMatchObject({ origin: "restored", boxId: next.boxId });
      const response = await fetch(`${url}${runnerPaths.taskSpec(task.taskId)}?leaseEpoch=${String(next.leaseEpoch)}`, {
        headers: { authorization: `Bearer ${runnerToken()}`, [runnerHeaders.minor]: String(PROTOCOL_MINOR) },
      });
      expect(response.status).toBe(200);
      const spec = taskSpecSchema.parse(await response.json());
      expect(spec.restore).toMatchObject({ origin: "restored", archive, hiddenRefs: [{ repoId, sha: hidden, baseSha: head }] });
      // The lost turn's message is replayed from the event log, once, and the one click adds no words.
      expect(spec.restore?.pendingMessages.map((message) => message.text)).toEqual([lostMessage]);
      const replayed = await test.db.event.findMany({ where: { sessionId: next.sessionId, kind: "user.message" }, orderBy: { seq: "asc" } });
      expect(replayed.map((row) => row.payload)).toEqual([expect.objectContaining({ text: lostMessage, replayed: true })]);
      expect(JSON.stringify(replayed.map((row) => row.payload))).not.toContain(reopenCarryOnText);

      // The fresh box's sidecar carries on, on the new lease.
      sidecar = await sidecarOf(next);
      await sendEvents(sidecar, next, [{ kind: "turn.started", turnId: turnIdSchema.parse("turn-3") }], 1);
      await waitFor("the reopened turn", async () => (await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state === "running");
      sidecar.close();
      runner.close();
      await runner.closed;
      // Back online for the next case's dispatch: its own connection went with it.
      await test.db.runner.update({ where: { id: poolRunner }, data: { state: "online" } });
      await test.db.runnerPresence.update({ where: { runnerId: poolRunner }, data: { disconnectedAt: null } });
    }, 120_000);
  }

  it("F-047/c1: a box that never started, reported lost before its sidecar ever connected, crashes its preparing task on docker and kubernetes alike: it needs its driver, the box failed, the lease ended", async () => {
    for (const executor of ["docker", "kubernetes"] as const) {
      await test.db.runner.update({ where: { id: poolRunner }, data: { executor } });
      const runner = await connectPeer(url, runnerToken(), poolRunner, { executor, lastCommandSeq });
      peers.push(runner);
      await runner.next("welcome");
      const task = await acceptNextDispatch(runner, await seedQueuedTask(test.db, world, fixture.a.member, null));
      expect(await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).toMatchObject({ state: "starting" });

      // Its create failed, or its sidecar ended or wasn't ready in time: the runner's word, with no session event before it.
      runner.send({ type: "runner-event", at: Date.now(), event: { kind: "box.lost", boxId: task.boxId, exitCode: null } });
      await waitFor(`the ${executor} box's crash`, async () => (await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).state === "crashed");
      expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "needs_you", needsYouReason: "crashed" });
      expect(await test.db.needsYouItem.findMany({ where: { taskId: task.taskId, reason: "crashed" } })).toMatchObject([{ audience: "driver", state: "open" }]);
      expect(await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).toMatchObject({ state: "failed" });
      expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, epoch: task.leaseEpoch } })).toMatchObject({ state: "ended", endReason: "released" });
      expect((await test.db.event.findMany({ where: { taskId: task.taskId, kind: "session.crashed" } })).map((row) => row.payload)).toEqual([
        { kind: "session.crashed", error: BOX_LOST_ERROR, cause: "box_lost" },
      ]);
      runner.close();
      await runner.closed;
      await test.db.runner.update({ where: { id: poolRunner }, data: { state: "online" } });
      await test.db.runnerPresence.update({ where: { runnerId: poolRunner }, data: { disconnectedAt: null } });
    }
  }, 120_000);

  it("F-047/c1: a box.lost from a runner the box isn't on, or for a box whose session already ended, changes nothing", async () => {
    await test.db.runner.update({ where: { id: poolRunner }, data: { executor: "docker" } });
    const runner = await connectPeer(url, runnerToken(), poolRunner, { executor: "docker", lastCommandSeq });
    peers.push(runner);
    await runner.next("welcome");
    const task = await acceptNextDispatch(runner, await seedQueuedTask(test.db, world, fixture.a.member, null));
    const sidecar = await sidecarOf(task);
    await sendEvents(sidecar, task, [{ kind: "turn.started", turnId: turnIdSchema.parse("turn-1") }], 1);

    // Another pool's runner names this box: it isn't its box, and nothing moves.
    const otherPool = await test.db.runnerPool.create({ data: { organizationId: fixture.a.organization.id, name: "other boxes" } });
    const other = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "pool", poolId: otherPool.id }, 1);
    const stranger = await connectPeer(url, core.gateway.context.tokens.issue(other.runnerId, fixture.a.organization.id, Date.now()).accessToken, other.runnerId, { executor: "docker" });
    peers.push(stranger);
    await stranger.next("welcome");
    stranger.send({ type: "runner-event", at: Date.now(), event: { kind: "box.lost", boxId: task.boxId, exitCode: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).toMatchObject({ state: "running" });
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "active" });

    // The agent's crash, which the sidecar said itself: the box's loss after it adds nothing.
    await sendEvents(sidecar, task, [{ kind: "session.crashed", error: "the agent's process exited mid-turn", cause: "agent_exited" }], 2);
    runner.send({ type: "runner-event", at: Date.now(), event: { kind: "box.lost", boxId: task.boxId, exitCode: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await test.db.event.findMany({ where: { taskId: task.taskId, kind: "session.crashed" } })).map((row) => row.sessionSeq)).toEqual([2]);
    expect(await test.db.needsYouItem.count({ where: { taskId: task.taskId, reason: "crashed" } })).toBe(1);
    sidecar.close();
    stranger.close();
    runner.close();
    await runner.closed;
    await test.db.runner.update({ where: { id: poolRunner }, data: { state: "online" } });
    await test.db.runnerPresence.update({ where: { runnerId: poolRunner }, data: { disconnectedAt: null } });
  }, 60_000);
});
