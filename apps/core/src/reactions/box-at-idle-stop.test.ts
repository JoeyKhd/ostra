import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { parseServerSettings, postgresAuditLog, postgresChangeNotices, reopenTask, systemClock } from "@ostra/domain";
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
  taskTokenResponseSchema,
  turnIdSchema,
} from "@ostra/protocol";
import type { BlobRef, BoxId, DownFrame, ExecutorKind, GitSha, LeaseEpoch, RepoId, RunnerId, TaskEvent, TaskSpec } from "@ostra/protocol";
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

// F-096/c9 (ADR 0039, amended 2026-11-22; Q343, the maintainer's "Remove at idle"): a box at its
// idle stop, and the reopen after it. A `docker` box's or a `kubernetes` pod's sidecar runs one
// session and exits with it, and its pool runner removes the box then (`box-dispatcher.ts`,
// `kubernetes-dispatcher.ts`). So core records the box gone with its session, and a reopen starts a
// fresh box restored from the session archive and the hidden ref, never `resumed` on the box that
// went, and never `rebuilt` while the archive is there. A `host` worktree stays, stopped, until its
// release, and a reopen on its runner resumes in it. The whole of core as `startCore` runs it, a
// fake peer for the pool runner and one for the box's sidecar, each answering as the runner's box
// dispatcher and the sidecar's task host do; only the external services are fakes.

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
  poolRunner = (await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "pool", poolId: pool.id }, 8)).runnerId;
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-idle-stop-"));
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

/** The next dispatch the pool runner is offered, accepted at once; any other command first is answered `done`. */
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

/** What the box dispatcher does when it makes the box: asks core for its sidecar's task token, once, and the sidecar connects on it. */
const sidecarOf = async (task: Boxed): Promise<FakePeer> => {
  const response = await postJson(`${url}${runnerPaths.taskToken(task.taskId)}`, { leaseEpoch: task.leaseEpoch }, runnerToken());
  expect(response.status).toBe(200);
  const { taskToken } = taskTokenResponseSchema.parse(response.body);
  const sidecar = await connectPeer(url, taskToken, poolRunner, { peer: { kind: "sidecar", taskId: task.taskId, boxId: task.boxId, leaseEpoch: task.leaseEpoch } });
  peers.push(sidecar);
  await sidecar.next("welcome");
  return sidecar;
};

const sendEvents = async (peer: FakePeer, task: Boxed, events: readonly TaskEvent[], from: number): Promise<void> => {
  peer.send({ type: "events", events: events.map((event, index) => runnerEvent(task, from + index, event, task.leaseEpoch)) });
  expect(await peer.next("ack")).toEqual({ type: "ack", sessionId: task.sessionId, upTo: from + events.length - 1 });
};

const specOf = async (task: Boxed): Promise<TaskSpec> => {
  const response = await fetch(`${url}${runnerPaths.taskSpec(task.taskId)}?leaseEpoch=${String(task.leaseEpoch)}`, {
    headers: { authorization: `Bearer ${runnerToken()}`, [runnerHeaders.minor]: String(PROTOCOL_MINOR) },
  });
  expect(response.status).toBe(200);
  return taskSpecSchema.parse(await response.json());
};

const releaseTimers = async (task: Boxed) =>
  (await core.jobs.find("box.release-after-idle", { organizationId: task.organizationId, taskId: task.taskId, boxId: task.boxId })).filter((job) => job.state === "created");

const releaseCommands = (boxId: BoxId): Promise<number> => test.db.command.count({ where: { runnerId: poolRunner, kind: "release", body: { path: ["boxId"], equals: boxId } } });

/** The task's one turn, finished: its branch pushed, its hidden ref and its archive saved, its PR opened. */
type Saved = { readonly repoId: RepoId; readonly head: GitSha; readonly hidden: GitSha; readonly archive: BlobRef };

/**
 * The pool runner, now on `executor`, connected; a task dispatched to it and accepted, its box made
 * (a sidecar on `docker` and `kubernetes`, the runner itself on `host`), and its first turn done.
 */
const firstTurnOn = async (executor: ExecutorKind): Promise<{ readonly runner: FakePeer; readonly box: FakePeer; readonly task: Boxed; readonly saved: Saved }> => {
  await test.db.runner.update({ where: { id: poolRunner }, data: { executor, state: "online" } });
  await test.db.runnerPresence.update({ where: { runnerId: poolRunner }, data: { disconnectedAt: null } });
  const runner = await connectPeer(url, runnerToken(), poolRunner, { executor, lastCommandSeq });
  peers.push(runner);
  await runner.next("welcome");
  const task = await acceptNextDispatch(runner, await seedQueuedTask(test.db, world, fixture.a.member, null));
  expect(await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).toMatchObject({ executor });
  const box = executor === "host" ? runner : await sidecarOf(task);
  const repoId = repoIdSchema.parse(world.repoId);
  const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const head = gitShaSchema.parse(randomBytes(20).toString("hex"));
  const hidden = gitShaSchema.parse(randomBytes(20).toString("hex"));
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
    box,
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
  expect(await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).toMatchObject({ state: "idle" });
  return { runner, box, task, saved: { repoId, head, hidden, archive } };
};

/** The idle timer runs out in the box: the session ends (`session.ended`), as the task host's timer ends it. */
const idleStop = async (box: FakePeer, task: Boxed, saved: Saved): Promise<void> => {
  await sendEvents(box, task, [{ kind: "session.ended", outcome: "with-changes", repos: [{ repoId: saved.repoId, ahead: true }] }], 6);
  await waitFor("the session's end", async () => (await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).state === "ended");
  await waitFor("the lease's end", async () => (await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, epoch: task.leaseEpoch } })).state === "ended");
};

const scope = (): MemberScope => ({ organizationId: fixture.a.organization.id, memberId: memberIdSchema.parse(fixture.a.member.id), role: "member", projectRoles: new Map() });

/** A member reopens the task with a message, and the pool runner takes the dispatch. */
const reopenOn = async (runner: FakePeer, task: Boxed, text: string): Promise<Boxed> => {
  const reopened = await core.db.$transaction((tx) =>
    reopenTask(
      { tx, scope: scope(), jobs: core.jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock },
      { taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(randomBytes(8).toString("hex")), text },
    ),
  );
  if (!reopened.ok) throw new Error(`the reopen was refused: ${reopened.error}`);
  return acceptNextDispatch(runner, { ...task, sessionId: sessionIdSchema.parse(reopened.sessionId) });
};

const closeAll = async (...open: readonly FakePeer[]): Promise<void> => {
  for (const peer of open) {
    peer.close();
    await peer.closed;
  }
};

describe("a box at its idle stop, and the reopen after it (F-096/c9, ADR 0039, Q343)", () => {
  for (const executor of ["docker", "kubernetes"] as const) {
    it(`F-096/c9, F-079/c2: a ${executor} task idles out: core records its box gone with its session, with no release to send and no box kept, and a reopen plans a fresh box restored from the session archive and the hidden ref`, async () => {
      const { runner, box: sidecar, task, saved } = await firstTurnOn(executor);

      // The idle stop: the session ends, and the sidecar exits with it (its runner removes the box).
      await idleStop(sidecar, task, saved);
      await closeAll(sidecar);
      // Core records the box gone with its session: released at once, nothing to send its runner, no idle days to wait.
      const gone = await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } });
      expect(gone).toMatchObject({ state: "released", releaseReason: "session_ended", idleSince: null });
      expect(gone.releasedAt).not.toBeNull();
      expect(gone.stoppedAt).not.toBeNull();
      expect(await releaseCommands(task.boxId)).toBe(0);
      expect(await releaseTimers(task)).toEqual([]);
      // The task keeps its PR, its branch and its hidden ref: only the box went.
      expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "in_review" });
      expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "pr_open", headSha: saved.head, hiddenRefSha: saved.hidden });
      expect(codeHost.deletedRefs).toEqual([]);

      // A reopen: a fresh box on the pool, restored from the archive and the hidden ref.
      const next = await reopenOn(runner, task, `Now add a section on the linters (${executor}).`);
      expect(next.boxId).not.toBe(task.boxId);
      expect(await test.db.box.findUniqueOrThrow({ where: { id: next.boxId } })).toMatchObject({ executor, state: "creating" });
      expect(await test.db.session.findUniqueOrThrow({ where: { id: next.sessionId } })).toMatchObject({ origin: "restored", boxId: next.boxId });
      const spec = await specOf(next);
      expect(spec.restore).toMatchObject({ origin: "restored", archive: saved.archive, hiddenRefs: [{ repoId: saved.repoId, sha: saved.hidden, baseSha: saved.head }] });
      expect(spec.restore?.pendingMessages.map((message) => message.text)).toEqual([`Now add a section on the linters (${executor}).`]);
      await closeAll(runner);
    }, 120_000);
  }

  it("F-096/c9: a docker box an older core left stopped at its idle stop is never resumed: its reopen restores on a fresh box", async () => {
    const { runner, box: sidecar, task, saved } = await firstTurnOn("docker");
    await idleStop(sidecar, task, saved);
    await closeAll(sidecar);
    // As a core from before Q343 recorded it: stopped and kept, waiting for its release.
    await test.db.box.update({ where: { id: task.boxId }, data: { state: "stopped", releaseReason: null, releasedAt: null } });

    const next = await reopenOn(runner, task, "Carry on from where you were.");
    expect(next.boxId).not.toBe(task.boxId);
    expect(await test.db.session.findUniqueOrThrow({ where: { id: next.sessionId } })).toMatchObject({ origin: "restored", boxId: next.boxId });
    expect((await specOf(next)).restore).toMatchObject({ origin: "restored", archive: saved.archive, hiddenRefs: [{ repoId: saved.repoId, sha: saved.hidden, baseSha: saved.head }] });
    await closeAll(runner);
  }, 120_000);

  it("F-096/c9, F-079/c2: a host worktree stays stopped at its idle stop, kept until its release after the idle days, and a reopen on its runner resumes in it", async () => {
    const { runner, task, saved } = await firstTurnOn("host");
    await idleStop(runner, task, saved);
    expect(await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).toMatchObject({ state: "stopped", releaseReason: null, releasedAt: null });
    expect(await releaseTimers(task)).toHaveLength(1);

    const next = await reopenOn(runner, task, "Carry on in the same worktree.");
    expect(next.boxId).toBe(task.boxId);
    expect(await test.db.session.findUniqueOrThrow({ where: { id: next.sessionId } })).toMatchObject({ origin: "resumed", boxId: task.boxId });
    expect((await specOf(next)).restore).toMatchObject({ origin: "resumed", hiddenRefs: [{ repoId: saved.repoId, sha: saved.hidden, baseSha: saved.head }] });
    await closeAll(runner);
  }, 120_000);
});
