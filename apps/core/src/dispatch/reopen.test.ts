import { randomBytes, randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  appendServerEvent,
  dispatchTask,
  dispatchWaitFromDb,
  markTicketBlock,
  markTicketInline,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  REBUILD_TEMPLATE_MAX_CHARS,
  reopenTask,
  sendMemberMessageInTx,
  stopTask,
  systemClock,
} from "@ostra/domain";
import type { DispatchTaskResult, MemberScope, ReopenTaskResult, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  blobIdSchema,
  boxIdSchema,
  clientMessageIdSchema,
  encodeTaskSpecForMinor,
  leaseEpochSchema,
  memberIdSchema,
  projectIdSchema,
  repoIdSchema,
  segmentIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "@ostra/protocol";
import type { BlobRef, BoxId, RepoId, RunnerId, SessionId, TaskEvent, TaskId, TaskSpec } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { releaseAfterIdleHandler } from "../cleanup/cleanup.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { openPullRequestsHandler } from "../reactions/session-end.ts";
import type { ReactionDeps } from "../reactions/session-end.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { fanoutChangesOf } from "../testing/notify.ts";
import { acceptedTask, drive, jobContext, sha } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { INSTALLATION_ID, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { applyOfferResultsInTx } from "./dispatcher.ts";
import { buildTaskSpec } from "./task-spec.ts";

// Ticket 18 (F-032, F-033, F-047): a reopen, and the dispatch's choice of ADR 0039's three steps:
// the same box while its runner keeps it, a fresh box from the archive and the hidden ref, or the
// rebuild template. The epoch rises with the dispatch, so the old box's writes are refused, and a
// lost box's unanswered message is carried into the next spec once.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let ingest: Ingest;
let liveText: LiveTextWriter;
let timers: SessionTimers;
let deps: ReactionDeps;
let first: RunnerRef;
let second: RunnerRef;
let scope: MemberScope;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const turnId = turnIdSchema.parse("turn-1");
const CAPS = { capMicroUsd: 25_000_000, capTokens: 10_000_000 } as const;
const SPEC_SETTINGS = { idleMinutes: 15, spendCap: CAPS } as const;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  timers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox });
  deps = {
    db: test.db,
    jobs,
    notices: postgresChangeNotices,
    audit: postgresAuditLog,
    clock: systemClock,
    adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
    publicUrl: "http://localhost:3000",
    logger,
    timers,
  };
  first = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 20);
  second = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 20);
  await test.db.runnerPresence.updateMany({ where: { runnerId: { in: [first.runnerId, second.runnerId] } }, data: { minor: 1 } });
  scope = { organizationId: fixture.a.organization.id, memberId: memberIdSchema.parse(fixture.a.member.id), role: "member", projectRoles: new Map() };
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const repo = (): RepoId => repoIdSchema.parse(world.repoId);

/** The first runner online or offline, as a laptop that went to sleep. */
const setOnline = async (runner: RunnerRef, online: boolean): Promise<void> => {
  await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { disconnectedAt: online ? null : new Date(), lastSeenAt: new Date() } });
};

const setMinor = async (runner: RunnerRef, minor: number): Promise<void> => {
  await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { minor } });
};

/** An archive blob of the task, as the bulk path leaves one. */
const archiveOf = async (taskId: TaskId, projectId: string = world.projectId): Promise<BlobRef> => {
  const blob = await test.db.blob.create({
    data: {
      organizationId: fixture.a.organization.id,
      projectId,
      taskId,
      store: "postgres",
      key: `postgres:${randomUUID()}`,
      purpose: "session-archive",
      contentType: "application/gzip",
      size: 1234,
      sha256: randomBytes(32).toString("hex"),
    },
  });
  return { blobId: blobIdSchema.parse(blob.id), size: blob.size, sha256: blob.sha256 };
};

/** A task in review: one turn with changes, its work saved with an archive, its PR open. */
const inReview = async (): Promise<DrivenTask & { readonly archive: BlobRef }> => {
  await setOnline(first, true);
  const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, first);
  const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const archive = await archiveOf(task.taskId);
  await task.send(
    { kind: "turn.started", turnId },
    { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s1"), text: "I added CONTRIBUTING.md." },
    { kind: "git.pushed", repoId: repo(), branch: branchName, headSha: sha("head-1"), ref: `refs/heads/${branchName}` },
    { kind: "turn.ended", turnId, stopReason: "end_turn" },
    { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId: repo(), headSha: sha("head-1"), ahead: true, hiddenRefSha: sha("wip-1") }], archive },
  );
  const saved = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.saved" } });
  await openPullRequestsHandler(deps)(
    jobContext("task.open-pull-requests", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: saved.seq }, logger),
  );
  expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("in_review");
  return { ...task, archive };
};

const reopen = (taskId: TaskId, text?: string, clientMessageId = clientMessageIdSchema.parse(randomUUID()), by: MemberScope = scope): Promise<ReopenTaskResult> =>
  test.db.$transaction((tx) =>
    reopenTask(
      { tx, scope: by, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, spendCap: CAPS, timers },
      { taskId, clientMessageId, ...(text === undefined ? {} : { text }) },
    ),
  );

/** A member of the open project's organization who isn't the task's creator or driver: a plain member unless said. */
const scopeOf = (member: SeededMember, role: "admin" | "member" = "member"): MemberScope => ({
  organizationId: fixture.a.organization.id,
  memberId: memberIdSchema.parse(member.id),
  role,
  projectRoles: new Map(),
});

const reopened = async (taskId: TaskId, text?: string, by: MemberScope = scope): Promise<SessionId> => {
  const result = await reopen(taskId, text, clientMessageIdSchema.parse(randomUUID()), by);
  if (!result.ok) {
    throw new Error(`reopen refused: ${result.error}`);
  }
  return result.sessionId;
};

const dispatch = async (taskId: TaskId, sessionId: SessionId): Promise<DispatchTaskResult> => {
  const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: taskId } });
  return test.db.$transaction((tx) =>
    dispatchTask(
      {
        tx,
        jobs,
        outbox: postgresCommandOutbox,
        notices: postgresChangeNotices,
        clock: systemClock,
        reopen: { agentImportsArchives: (adapter) => adapter === "opencode", archiveMaxBytes: 64 * 1024 * 1024 },
      },
      { organizationId: fixture.a.organization.id, taskId, sessionId, leaseEpoch: leaseEpochSchema.parse(leaseEpoch + 1) },
    ),
  );
};

const accept = async (taskId: TaskId, offered: DispatchTaskResult, runner: RunnerRef): Promise<void> => {
  if (!offered.ok) {
    throw new Error(`dispatch: ${offered.error}`);
  }
  const command = await test.db.command.findUniqueOrThrow({ where: { id: offered.commandId } });
  await test.db.$transaction((tx) =>
    applyOfferResultsInTx({ jobs, notices: postgresChangeNotices, clock: systemClock, logger }, tx, runner, [
      { commandId: offered.commandId, seq: command.seq, kind: "dispatch", body: command.body, taskId, result: "accepted", reason: null },
    ]),
  );
};

const specFor = async (taskId: TaskId, runnerId: RunnerId): Promise<TaskSpec> => {
  const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: taskId } });
  const built = await buildTaskSpec({ db: test.db, codeHost, secretStore, settings: SPEC_SETTINGS }, { taskId, runnerId, leaseEpoch: leaseEpochSchema.parse(leaseEpoch) });
  if (!built.ok) {
    throw new Error(`spec: ${built.error}`);
  }
  return built.spec;
};

const memberSays = async (task: DrivenTask, text: string, member: SeededMember = fixture.a.member): Promise<void> => {
  await test.db.$transaction((tx) =>
    appendServerEvent(tx, {
      organizationId: task.organizationId,
      projectId: projectIdSchema.parse(world.projectId),
      taskId: task.taskId,
      sessionId: task.sessionId,
      at: Date.now(),
      event: { kind: "user.message", memberId: memberIdSchema.parse(member.id), clientMessageId: clientMessageIdSchema.parse(randomUUID()), text, delivery: "queued" },
    }),
  );
};

/** The box a session ran in. */
const boxOf = async (sessionId: SessionId): Promise<BoxId | null> => {
  const { boxId } = await test.db.session.findUniqueOrThrow({ where: { id: sessionId } });
  return boxId === null ? null : boxIdSchema.parse(boxId);
};

/** The new session's events, at the task's epoch now, as the runner holding its lease sends them. */
const driveSession = async (taskId: TaskId, sessionId: SessionId, runner: RunnerRef): Promise<DrivenTask> => {
  const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: taskId } });
  return drive(ingest, { taskId, sessionId, organizationId: fixture.a.organization.id }, runner, leaseEpoch);
};

/** The organization's one Linear connection and its board, made once: an organization has one active Linear connection. */
let linearBoard: { readonly connectionId: string; readonly boardId: string } | null = null;
const boardOf = async (): Promise<{ readonly connectionId: string; readonly boardId: string }> => {
  if (linearBoard === null) {
    const connection = await test.db.connection.create({ data: { organizationId: fixture.a.organization.id, kind: "linear", appId: "api-key", state: "active" } });
    const board = await test.db.board.create({
      data: { organizationId: fixture.a.organization.id, projectId: world.projectId, connectionId: connection.id, externalId: "team-1", name: "OST", statusMap: {} },
    });
    linearBoard = { connectionId: connection.id, boardId: board.id };
  }
  return linearBoard;
};

/** A ticket on the board, as the tracker's sync stores it. */
const ticketOf = async (key: string, title: string, description: string | null = null): Promise<{ readonly id: string; readonly boardId: string; readonly key: string }> => {
  const { connectionId, boardId } = await boardOf();
  const ticket = await test.db.ticket.create({
    data: {
      organizationId: fixture.a.organization.id,
      projectId: world.projectId,
      boardId,
      connectionId,
      externalId: `issue-${key}`,
      key,
      title,
      description,
      url: `https://linear.app/ostra-test/issue/${key}`,
      trackerUpdatedAt: new Date(),
    },
  });
  return { id: ticket.id, boardId, key };
};

describe("the three steps (ADR 0039)", () => {
  it("resumes on the same box while its runner keeps it, raises the epoch, and refuses the old box's writes", async () => {
    const task = await inReview();
    const before = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    const oldSession = await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } });
    const sessionId = await reopened(task.taskId, "Also add today's date at the top.");
    // The reopen: a member message tagged as one, the member drives, the old session and its grant end.
    const reopenedRow = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(reopenedRow).toMatchObject({ state: "queued", driverMemberId: fixture.a.member.id });
    expect(await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).toMatchObject({ state: "stopped" });
    expect(await test.db.lease.count({ where: { taskId: task.taskId, state: "active" } })).toBe(0);
    const message = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, sessionId, kind: "user.message" } });
    expect(message.payload).toMatchObject({ reopen: true, text: "Also add today's date at the top." });
    expect(await jobs.find("task.dispatch", { organizationId: task.organizationId, taskId: task.taskId, sessionId, leaseEpoch: leaseEpochSchema.parse(before.leaseEpoch + 1) })).toHaveLength(1);

    const offered = await dispatch(task.taskId, sessionId);
    expect(offered.ok && offered.boxId).toBe(oldSession.boxId);
    expect(await test.db.session.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({ origin: "resumed", boxId: oldSession.boxId });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).leaseEpoch).toBe(before.leaseEpoch + 1);
    await accept(task.taskId, offered, first);

    // A write from the old session at the old epoch is refused (F-045).
    const stale = await ingest(first, {
      type: "events",
      events: [{ sessionId: task.sessionId, sessionSeq: task.next(), leaseEpoch: before.leaseEpoch, at: Date.now(), event: { kind: "agent.thought", turnId, segmentId: segmentIdSchema.parse("late"), text: "late" } }],
    });
    expect(stale).toEqual([expect.objectContaining({ type: "error", code: "stale-lease" })]);

    const spec = await specFor(task.taskId, first.runnerId);
    expect(spec.restore).toEqual({
      origin: "resumed",
      archive: null,
      hiddenRefs: [{ repoId: repo(), sha: sha("wip-1"), baseSha: sha("head-1") }],
      pendingMessages: [expect.objectContaining({ text: "Also add today's date at the top." })],
    });
    // Every reopen's prompt is the template, the fallback a failed resume or import uses.
    expect(spec.prompt).toContain("## Every message from the team, oldest first");
    expect(spec.prompt).toContain("I added CONTRIBUTING.md.");
    expect(spec.prompt).not.toContain("Also add today's date");

    // The next turn's saved work updates the same PR: no second one.
    const pulls = codeHost.pulls.length;
    const resumed = drive(ingest, { taskId: task.taskId, sessionId, organizationId: task.organizationId }, first, before.leaseEpoch + 1);
    await resumed.send(
      { kind: "session.restored", origin: "resumed", replayedUpdates: 3, hiddenRef: "none" },
      { kind: "turn.started", turnId },
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId: repo(), headSha: sha("head-2"), ahead: true, hiddenRefSha: sha("wip-2") }], archive: null },
    );
    const restored = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.restored" } });
    expect(restored.payload).toMatchObject({ origin: "resumed", previousBox: "kept" });
    expect(codeHost.pulls.length).toBe(pulls);
    expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "pr_open", headSha: sha("head-2") });
  });

  it("restores on a fresh box from the archive when the runner is gone, and replays the lost box's message once", async () => {
    const task = await inReview();
    // A second turn: the member asks, the turn starts, and the box goes with the runner.
    await memberSays(task, "What did you change, and why?");
    await task.send({ kind: "turn.started", turnId }, { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s2"), text: "Looking" });
    await setOnline(first, false);
    const sessionId = await reopened(task.taskId, "Carry on, please.");
    const offered = await dispatch(task.taskId, sessionId);
    expect(offered.ok && offered.runnerId).toBe(second.runnerId);
    const session = await test.db.session.findUniqueOrThrow({ where: { id: sessionId } });
    const oldSession = await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } });
    expect(session.origin).toBe("restored");
    expect(session.boxId).not.toBe(oldSession.boxId);
    await accept(task.taskId, offered, second);
    const spec = await specFor(task.taskId, second.runnerId);
    expect(spec.restore?.origin).toBe("restored");
    expect(spec.restore?.archive).toEqual(task.archive);
    expect(spec.restore?.pendingMessages.map((message) => message.text)).toEqual(["What did you change, and why?", "Carry on, please."]);
    // The replayed copy is in the new session's thread, marked so; the spec has it once.
    const replayed = await test.db.event.findMany({ where: { taskId: task.taskId, sessionId, kind: "user.message" }, orderBy: { seq: "asc" } });
    expect(replayed.map((row) => row.payload)).toEqual([
      expect.objectContaining({ text: "What did you change, and why?", replayed: true }),
      expect.objectContaining({ text: "Carry on, please.", reopen: true }),
    ]);
    // The interrupted turn's partial text goes into the template, in its own section.
    expect(spec.prompt).toContain("## The turn that was interrupted");
    expect(spec.prompt).toContain("Looking");
    // The runner says it restored, and core names the box before it as lost.
    const restored = drive(ingest, { taskId: task.taskId, sessionId, organizationId: task.organizationId }, second, spec.leaseEpoch);
    await restored.send({ kind: "session.restored", origin: "restored", replayedUpdates: 12, hiddenRef: "applied" });
    expect((await test.db.event.findFirstOrThrow({ where: { sessionId, kind: "session.restored" } })).payload).toMatchObject({ previousBox: "lost" });
    await setOnline(first, true);
  });

  it("rebuilds from the template when the archive is gone, or the runner can't restore", async () => {
    const task = await inReview();
    await setOnline(first, false);
    await test.db.blob.delete({ where: { id: task.archive.blobId } });
    const sessionId = await reopened(task.taskId, "Go on.");
    const offered = await dispatch(task.taskId, sessionId);
    expect(await test.db.session.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({ origin: "rebuilt" });
    await accept(task.taskId, offered, second);
    const spec = await specFor(task.taskId, second.runnerId);
    expect(spec.restore).toMatchObject({ origin: "rebuilt", archive: null });
    expect(spec.prompt).toContain("You are picking up a task");

    // A minor-0 runner can't restore: the step falls back to the template, which is its prompt.
    const other = await inReview();
    await setOnline(first, false);
    await setMinor(second, 0);
    try {
      const otherSession = await reopened(other.taskId, "Again.");
      const offeredOther = await dispatch(other.taskId, otherSession);
      expect(await test.db.session.findUniqueOrThrow({ where: { id: otherSession } })).toMatchObject({ origin: "rebuilt" });
      await accept(other.taskId, offeredOther, second);
      const minor0 = encodeTaskSpecForMinor(await specFor(other.taskId, second.runnerId), 0);
      expect(minor0.restore).toBeUndefined();
      expect(minor0.prompt).toContain("You are picking up a task");
    } finally {
      await setMinor(second, 1);
      await setOnline(first, true);
    }
  });

  it("F-033/c7: a fresh box's restore conflict (the branch moved and won't merge) raises a needs-you item for the driver, and the task keeps running", async () => {
    const task = await inReview();
    await setOnline(first, false);
    const sessionId = await reopened(task.taskId, "Go on.");
    const offered = await dispatch(task.taskId, sessionId);
    await accept(task.taskId, offered, second);
    const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    const restored = drive(ingest, { taskId: task.taskId, sessionId, organizationId: task.organizationId }, second, leaseEpoch);
    await restored.send({ kind: "session.restored", origin: "restored", replayedUpdates: 0, hiddenRef: "conflict" }, { kind: "turn.started", turnId });
    const conflict = await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId, reason: "restore_conflict" } });
    expect(conflict).toMatchObject({ state: "open", audience: "driver" });
    // F-036: raised with its fan-out.
    expect(await fanoutChangesOf(test.db, conflict.id)).toEqual(["created"]);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("running");
    await setOnline(first, true);
  });
});

// ---------- any member, any box, any runner (F-032, F-033) ----------

/** A second project of the organization, its two repos on the task's one branch name (F-098): `test1` and `test2`. */
const twoRepoProject = async (): Promise<{ readonly world: World; readonly secondRepoId: RepoId }> => {
  const organizationId = fixture.a.organization.id;
  const known = await test.db.repo.findUniqueOrThrow({ where: { id: world.repoId } });
  const project = await test.db.project.create({
    data: { organizationId, name: "two repos", slug: `two-repos-${randomUUID().slice(0, 8)}`, access: "open", defaultCodeProfileId: world.profileId },
  });
  codeHost.repos.set(INSTALLATION_ID, [
    ...(codeHost.repos.get(INSTALLATION_ID) ?? []).filter((listed) => listed.fullName !== "ostra-test/test2"),
    { hostRepoId: "host-ostra-test/test2", fullName: "ostra-test/test2", defaultBranch: "main", private: true, cloneUrl: "https://github.example/ostra-test/test2.git" },
  ]);
  const repoIn = (fullName: string, checkoutDir: string, position: number) =>
    test.db.repo.create({
      data: { organizationId, projectId: project.id, connectionId: known.connectionId, installationId: known.installationId, hostRepoId: `host-${fullName}`, fullName, defaultBranch: "main", checkoutDir, position },
    });
  const one = await repoIn("ostra-test/test1", "test1", 0);
  const two = await repoIn("ostra-test/test2", "test2", 1);
  return { world: { ...world, projectId: projectIdSchema.parse(project.id), repoId: one.id }, secondRepoId: repoIdSchema.parse(two.id) };
};

describe("F-032, F-033: any member reopens any task, in any box, on any runner", () => {
  it("F-032/c1: members who never drove the task reopen it, from in review and from stopped, become its driver, and keep prompting on the same branch", async () => {
    const task = await inReview();
    const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    const insider = scopeOf(fixture.a.insider);
    const admin = scopeOf(fixture.a.admin, "admin");

    // From in review: a plain member who neither started nor drove it reopens it, and drives it now.
    const sessionId = await reopened(task.taskId, "Also add today's date at the top.", insider);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "queued", creatorMemberId: fixture.a.member.id, driverMemberId: fixture.a.insider.id });
    const offered = await dispatch(task.taskId, sessionId);
    await accept(task.taskId, offered, first);
    const spec = await specFor(task.taskId, first.runnerId);
    expect(spec.sessionId).toBe(sessionId);
    // The same branch: the spec names it, and no repo carries one of its own.
    expect(spec.branchName).toBe(branchName);
    expect(spec.repos.map((repo) => repo.branchName ?? spec.branchName)).toEqual([branchName]);

    // The reopened session runs, and its driver keeps prompting it: the next message is steered into the same session.
    const resumed = await driveSession(task.taskId, sessionId, first);
    await resumed.send({ kind: "session.restored", origin: "resumed", replayedUpdates: 3, hiddenRef: "none" }, { kind: "turn.started", turnId });
    const steered = await test.db.$transaction((tx) =>
      sendMemberMessageInTx(
        { jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock },
        tx,
        insider,
        { taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: "And say it in the changelog.", intent: "message", sender: "driver" },
      ),
    );
    expect(steered).toMatchObject({ ok: true, delivery: "steer", sessionId });
    const steer = await test.db.command.findFirstOrThrow({ where: { taskId: task.taskId, kind: "steer" }, orderBy: { seq: "desc" } });
    expect(steer).toMatchObject({ runnerId: first.runnerId });
    expect(steer.body).toMatchObject({ sessionId, text: "And say it in the changelog." });
    // The runner gives the steer a turn of its own after this one, and its commits go up on the
    // task's branch, landing on the task's one repo row for it.
    const steerTurn = turnIdSchema.parse("turn-2");
    await resumed.send(
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "turn.started", turnId: steerTurn },
      { kind: "git.pushed", repoId: repo(), branch: branchName, headSha: sha("head-2"), ref: `refs/heads/${branchName}` },
      { kind: "turn.ended", turnId: steerTurn, stopReason: "end_turn" },
      { kind: "session.saved", turnOrdinal: 2, repos: [{ repoId: repo(), headSha: sha("head-2"), ahead: true, hiddenRefSha: sha("wip-2") }], archive: null },
    );
    expect(await test.db.taskRepo.findMany({ where: { taskId: task.taskId }, select: { branchName: true, headSha: true } })).toEqual([{ branchName, headSha: sha("head-2") }]);

    // From stopped: the insider stops it, and an admin who never touched it reopens it, on the same branch again.
    expect((await test.db.$transaction((tx) => stopTask({ tx, scope: insider, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock }, { taskId: task.taskId }))).ok).toBe(true);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("stopped");
    const again = await reopened(task.taskId, "One more: link it from the README.", admin);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).driverMemberId).toBe(fixture.a.admin.id);
    await accept(task.taskId, await dispatch(task.taskId, again), first);
    const next = await specFor(task.taskId, first.runnerId);
    expect(next.sessionId).toBe(again);
    expect(next.branchName).toBe(branchName);
    expect(next.repos.map((repo) => repo.branchName ?? next.branchName)).toEqual([branchName]);
    expect(next.restore?.hiddenRefs).toEqual([{ repoId: repo(), sha: sha("wip-2"), baseSha: sha("head-2") }]);
    expect(next.restore?.pendingMessages.map((message) => message.text)).toEqual(["One more: link it from the README."]);
  });

  it("F-032/c2: after a reopen, the new commits in each of a task's two repos update the same two PRs, and no new PR opens", async () => {
    const two = await twoRepoProject();
    const queued = await seedQueuedTask(test.db, two.world, fixture.a.member, first.runnerId);
    const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: queued.taskId } });
    await test.db.taskRepo.create({ data: { organizationId: fixture.a.organization.id, projectId: two.world.projectId, taskId: queued.taskId, repoId: two.secondRepoId, branchName, baseBranch: "main" } });
    const repos = [repoIdSchema.parse(two.world.repoId), two.secondRepoId] as const;
    const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, two.world, fixture.a.member, first, queued);
    await task.send(
      { kind: "turn.started", turnId },
      ...repos.map((repoId): TaskEvent => ({ kind: "git.pushed", repoId, branch: branchName, headSha: sha(`${repoId}-1`), ref: `refs/heads/${branchName}` })),
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "session.saved", turnOrdinal: 1, repos: repos.map((repoId) => ({ repoId, headSha: sha(`${repoId}-1`), ahead: true, hiddenRefSha: sha(`${repoId}-w1`) })), archive: await archiveOf(task.taskId, two.world.projectId) },
    );
    const firstSave = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.saved" } });
    await openPullRequestsHandler(deps)(jobContext("task.open-pull-requests", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: firstSave.seq }, logger));
    const before = await test.db.taskRepo.findMany({ where: { taskId: task.taskId }, orderBy: { createdAt: "asc" }, select: { repoId: true, prNumber: true, prUrl: true, state: true } });
    expect(before.map((row) => row.state)).toEqual(["pr_open", "pr_open"]);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "in_review" });
    const pulls = codeHost.pulls.length;

    // Another member reopens it; its next turn commits in both repos, on the same branch.
    const sessionId = await reopened(task.taskId, "Also bump the version in both.", scopeOf(fixture.a.insider));
    await accept(task.taskId, await dispatch(task.taskId, sessionId), first);
    const spec = await specFor(task.taskId, first.runnerId);
    expect(spec.repos.map((repo) => [repo.repoId, repo.branchName ?? spec.branchName])).toEqual(repos.map((repoId) => [repoId, branchName]));
    const resumed = await driveSession(task.taskId, sessionId, first);
    await resumed.send(
      { kind: "session.restored", origin: "resumed", replayedUpdates: 2, hiddenRef: "none" },
      { kind: "turn.started", turnId },
      ...repos.map((repoId): TaskEvent => ({ kind: "git.pushed", repoId, branch: spec.branchName, headSha: sha(`${repoId}-2`), ref: `refs/heads/${spec.branchName}` })),
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "session.saved", turnOrdinal: 1, repos: repos.map((repoId) => ({ repoId, headSha: sha(`${repoId}-2`), ahead: true, hiddenRefSha: sha(`${repoId}-w2`) })), archive: null },
    );
    const secondSave = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, sessionId, kind: "session.saved" } });
    await openPullRequestsHandler(deps)(jobContext("task.open-pull-requests", { organizationId: task.organizationId, taskId: task.taskId, sessionId, eventSeq: secondSave.seq }, logger));

    // The same two PRs, each now at the new commit of its repo; the code host was asked for none.
    expect(codeHost.pulls.length).toBe(pulls);
    const after = await test.db.taskRepo.findMany({ where: { taskId: task.taskId }, orderBy: { createdAt: "asc" }, select: { repoId: true, prNumber: true, prUrl: true, state: true, branchName: true, headSha: true } });
    expect(after).toEqual(before.map((row) => ({ ...row, branchName, headSha: sha(`${row.repoId}-2`) })));
    for (const row of after) {
      const pull = codeHost.pulls.find((candidate) => candidate.number === row.prNumber);
      expect(pull).toMatchObject({ state: "open", headBranch: branchName });
    }
    expect(await test.db.taskPullRequest.count({ where: { taskRepo: { taskId: task.taskId } } })).toBe(2);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "in_review" });
  });

  it("F-033/c1: other members reopen the task through ADR 0039's three steps in turn: its kept box, a fresh box on another runner from the archive and the hidden ref, then the template in a fresh box", async () => {
    const task = await inReview();
    const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    const keptBox = await boxOf(task.sessionId);
    try {
      // 1. A member who didn't drive it reopens it while its runner keeps the box: the same box resumes.
      const one = await reopened(task.taskId, "Also add today's date at the top.", scopeOf(fixture.a.insider));
      const offeredOne = await dispatch(task.taskId, one);
      expect(offeredOne).toMatchObject({ ok: true, runnerId: first.runnerId, boxId: keptBox });
      expect(await test.db.session.findUniqueOrThrow({ where: { id: one } })).toMatchObject({ origin: "resumed", boxId: keptBox });
      await accept(task.taskId, offeredOne, first);
      expect((await specFor(task.taskId, first.runnerId)).restore?.origin).toBe("resumed");
      const archive = await archiveOf(task.taskId);
      await (await driveSession(task.taskId, one, first)).send(
        { kind: "session.restored", origin: "resumed", replayedUpdates: 3, hiddenRef: "none" },
        { kind: "turn.started", turnId },
        { kind: "git.pushed", repoId: repo(), branch: branchName, headSha: sha("head-2"), ref: `refs/heads/${branchName}` },
        { kind: "turn.ended", turnId, stopReason: "end_turn" },
        { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId: repo(), headSha: sha("head-2"), ahead: true, hiddenRefSha: sha("wip-2") }], archive },
      );
      expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "in_review", driverMemberId: fixture.a.insider.id });

      // 2. The runner goes away with the box, and an admin reopens it: a fresh box on the other runner, from the archive and the hidden ref.
      await setOnline(first, false);
      const two = await reopened(task.taskId, "Carry on, please.", scopeOf(fixture.a.admin, "admin"));
      const offeredTwo = await dispatch(task.taskId, two);
      expect(offeredTwo).toMatchObject({ ok: true, runnerId: second.runnerId });
      const freshBox = await boxOf(two);
      expect(freshBox).not.toBeNull();
      expect(freshBox).not.toBe(keptBox);
      expect(await test.db.session.findUniqueOrThrow({ where: { id: two } })).toMatchObject({ origin: "restored" });
      await accept(task.taskId, offeredTwo, second);
      const specTwo = await specFor(task.taskId, second.runnerId);
      expect(specTwo.restore).toMatchObject({ origin: "restored", archive, hiddenRefs: [{ repoId: repo(), sha: sha("wip-2"), baseSha: sha("head-2") }] });
      await (await driveSession(task.taskId, two, second)).send(
        { kind: "session.restored", origin: "restored", replayedUpdates: 6, hiddenRef: "applied" },
        { kind: "turn.started", turnId },
        { kind: "turn.ended", turnId, stopReason: "end_turn" },
        { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId: repo(), headSha: sha("head-2"), ahead: true, hiddenRefSha: sha("wip-3") }], archive: null },
      );
      expect((await test.db.event.findFirstOrThrow({ where: { sessionId: two, kind: "session.restored" } })).payload).toMatchObject({ previousBox: "lost" });
      expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "in_review", driverMemberId: fixture.a.admin.id });

      // 3. That runner goes away too, and the blob store has no archive left: the member who started it
      // reopens it from the template, in a fresh box on the runner that's back.
      await setOnline(first, true);
      await setOnline(second, false);
      await test.db.blob.deleteMany({ where: { taskId: task.taskId, purpose: "session-archive" } });
      const three = await reopened(task.taskId, "One more thing: a changelog line.");
      const offeredThree = await dispatch(task.taskId, three);
      expect(offeredThree).toMatchObject({ ok: true, runnerId: first.runnerId });
      const rebuiltBox = await boxOf(three);
      expect([keptBox, freshBox]).not.toContain(rebuiltBox);
      expect(await test.db.session.findUniqueOrThrow({ where: { id: three } })).toMatchObject({ origin: "rebuilt" });
      await accept(task.taskId, offeredThree, first);
      const specThree = await specFor(task.taskId, first.runnerId);
      expect(specThree.restore).toMatchObject({ origin: "rebuilt", archive: null, hiddenRefs: [{ repoId: repo(), sha: sha("wip-3"), baseSha: sha("head-2") }] });
      expect(specThree.prompt).toContain("You are picking up a task");
      expect(specThree.prompt).toContain("Also add today's date at the top.");
      expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ driverMemberId: fixture.a.member.id });
      // Every step kept the task's branch.
      expect([specTwo.branchName, specThree.branchName]).toEqual([branchName, branchName]);
    } finally {
      await setOnline(first, true);
      await setOnline(second, true);
    }
  });

  it("F-033/c2: once its idle days release the box, a reopen takes the normal path with the runner still online: a fresh box from the archive and the hidden ref", async () => {
    const task = await inReview();
    const released = await boxOf(task.sessionId);
    if (released === null) throw new Error("the session had no box");
    await releaseAfterIdleHandler({
      db: test.db,
      jobs,
      outbox: postgresCommandOutbox,
      notices: postgresChangeNotices,
      audit: postgresAuditLog,
      clock: systemClock,
      adapters: { codeHost, secretStore },
      logger,
      retentionDays: null,
      releaseAfterIdleMs: timers.boxReleaseIdleMs,
    })(jobContext("box.release-after-idle", { organizationId: task.organizationId, taskId: task.taskId, boxId: released }, logger));
    expect(await test.db.box.findUniqueOrThrow({ where: { id: released } })).toMatchObject({ state: "released", releaseReason: "idle_expired" });
    expect(await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId: first.runnerId } })).toMatchObject({ disconnectedAt: null });

    const sessionId = await reopened(task.taskId, "Also add a section on releases.");
    const offered = await dispatch(task.taskId, sessionId);
    // The same runner, which never went away, and a new box on it.
    expect(offered).toMatchObject({ ok: true, runnerId: first.runnerId });
    const fresh = await boxOf(sessionId);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(released);
    expect(await test.db.session.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({ origin: "restored" });
    await accept(task.taskId, offered, first);
    const spec = await specFor(task.taskId, first.runnerId);
    expect(spec.restore).toEqual({
      origin: "restored",
      archive: task.archive,
      hiddenRefs: [{ repoId: repo(), sha: sha("wip-1"), baseSha: sha("head-1") }],
      pendingMessages: [expect.objectContaining({ text: "Also add a section on releases." })],
    });
    // The runner restores it, and core names the box before as released: nothing was lost.
    await (await driveSession(task.taskId, sessionId, first)).send({ kind: "session.restored", origin: "restored", replayedUpdates: 4, hiddenRef: "applied" });
    expect((await test.db.event.findFirstOrThrow({ where: { sessionId, kind: "session.restored" } })).payload).toMatchObject({ origin: "restored", previousBox: "released" });
  });
});

describe("what a reopen refuses (F-032, spec section 11, item 12)", () => {
  it("refuses a merged task with no merged repo, a working one, a missing message, and a task at its spend cap", async () => {
    const task = await inReview();
    // Milestone 3 reopens a merged task on a fresh branch (F-066, ticket 24); one whose repos record
    // no merge has nothing to start the fresh branch from.
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "merged", subState: null } });
    expect(await reopen(task.taskId, "more")).toMatchObject({ ok: false, error: "merged_reopen_later" });
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "in_review", subState: "waiting_for_reviewer" } });
    expect(await reopen(task.taskId)).toMatchObject({ ok: false, error: "text-required" });
    // At the spend cap: tokens, since the model has no price.
    await test.db.session.update({ where: { id: task.sessionId }, data: { inputTokens: CAPS.capTokens } });
    expect(await reopen(task.taskId, "more")).toMatchObject({ ok: false, error: "spend-cap-reached" });
    await test.db.session.update({ where: { id: task.sessionId }, data: { inputTokens: 0 } });
    // The one-click reopen from a limit writes the carry-on words as the member's message.
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "needs_you", subState: null, needsYouReason: "stalled" } });
    const sessionId = await reopened(task.taskId);
    expect((await test.db.event.findFirstOrThrow({ where: { sessionId, kind: "user.message" } })).payload).toMatchObject({ text: "Carry on from where you stopped.", reopen: true });
    expect(await reopen(task.taskId, "and again")).toMatchObject({ ok: false, error: "not-reopenable" });
  });

  it("refuses a second active task for one ticket, and leaves another organization's task alone", async () => {
    const ticket = await ticketOf("OST-1", "A ticket");
    const stopped = await inReview();
    await test.db.task.update({ where: { id: stopped.taskId }, data: { state: "stopped", subState: null, stoppedReason: "requested", ticketId: ticket.id, boardId: ticket.boardId, ticketKey: "OST-1" } });
    const active = await inReview();
    await test.db.task.update({ where: { id: active.taskId }, data: { ticketId: ticket.id, boardId: ticket.boardId, ticketKey: "OST-1" } });
    const refused = await reopen(stopped.taskId, "again");
    expect(refused).toMatchObject({ ok: false, error: "ticket-has-task" });
    expect(!refused.ok && refused.message).toContain(active.taskId);
    // Another organization's member can't reach the task at all.
    const theirs: MemberScope = { organizationId: fixture.b.organization.id, memberId: memberIdSchema.parse(fixture.b.admin.id), role: "admin", projectRoles: new Map() };
    const foreign = await test.db.$transaction((tx) =>
      reopenTask(
        { tx, scope: theirs, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock },
        { taskId: active.taskId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: "mine now" },
      ),
    );
    expect(foreign).toMatchObject({ ok: false, error: "not-found" });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: active.taskId } })).state).toBe("in_review");
  });
});

// ---------- spike 2's five questions, through the rebuild step ----------

// The same five facts as packages/domain's template test (spikes/can-a-session-move-to-a-fresh-box/
// src/harness/questions.ts), stored as the event log holds them: a fact the member stated, a file
// the agent created, a tool's output, an edit the member asked for, a decision the agent stated.
const facts = { codename: "BLUE-HERON", docSlug: "docs/heron-notes.md", printed: "RESULT-48213", readmeWord: "salutations", port: "4173" };

describe("the rebuild template on spike 2's history (ADR 0039, Q128)", () => {
  it("F-033/c3: a rebuilt session's prompt is made with no model call, and holds the ticket, the PR's text, every member and agent message oldest first, the interrupted turn apart and the branch's log, with no tool output", async () => {
    await setOnline(first, true);
    const ticket = await ticketOf("OST-77", "Add a heron page", "List every heron.\nKeep it short.");
    const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, first);
    await test.db.task.update({ where: { id: task.taskId }, data: { source: "ticket", ticketId: ticket.id, boardId: ticket.boardId, ticketKey: ticket.key } });
    const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    const turn = (index: number) => turnIdSchema.parse(`turn-${String(index)}`);
    const said = (index: number, text: string): TaskEvent => ({ kind: "agent.message", turnId: turn(index), segmentId: segmentIdSchema.parse(`m${String(index)}`), text });
    const edit = toolCallIdSchema.parse("call-edit");
    const shell = toolCallIdSchema.parse("call-shell");
    // Turn 1 answers the member: it edits a file, runs a command, sets the PR's text and pushes.
    await memberSays(task, "Start with the list of herons.");
    await task.send(
      { kind: "turn.started", turnId: turn(1) },
      { kind: "tool.called", turnId: turn(1), toolCallId: edit, toolKind: "edit", title: "Write the page", input: { paths: ["docs/herons.md"] } },
      { kind: "tool.completed", toolCallId: edit, output: { files: [{ path: "docs/herons.md", added: 12, removed: 0, patch: "+PATCH-TEXT-NEVER-COPIED" }] } },
      { kind: "tool.called", turnId: turn(1), toolCallId: shell, toolKind: "execute", title: "count", input: { command: "wc -l docs/herons.md" } },
      { kind: "tool.completed", toolCallId: shell, output: { output: "TOOL-OUTPUT-NEVER-COPIED", truncated: false, exitCode: 0 } },
      said(1, "I listed six herons."),
      { kind: "pr.text_set", repoId: repo(), title: "Add the heron page", body: "## What\n\nA page that lists the herons.\n" },
      { kind: "git.pushed", repoId: repo(), branch: branchName, headSha: sha("heron-1"), ref: `refs/heads/${branchName}` },
      { kind: "turn.ended", turnId: turn(1), stopReason: "end_turn" },
      { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId: repo(), headSha: sha("heron-1"), ahead: true, hiddenRefSha: sha("heron-wip-1") }], archive: null },
    );
    const saved = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.saved" } });
    await openPullRequestsHandler(deps)(jobContext("task.open-pull-requests", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: saved.seq }, logger));
    // Turn 2 answers another member.
    await memberSays(task, "Add the grey heron too.", fixture.a.insider);
    await task.send({ kind: "turn.started", turnId: turn(2) }, said(2, "The grey heron is in."), { kind: "turn.ended", turnId: turn(2), stopReason: "end_turn" });
    // Turn 3 is cut off partway through its answer, when the box goes with its runner.
    await memberSays(task, "Now write a short summary.");
    await task.send({ kind: "turn.started", turnId: turn(3) }, said(3, "Writing the summary now:"));
    await setOnline(first, false);
    try {
      const sessionId = await reopened(task.taskId, "Carry on, please.");
      const offered = await dispatch(task.taskId, sessionId);
      expect(await test.db.session.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({ origin: "rebuilt" });
      await accept(task.taskId, offered, second);
      // ostra makes no call of its own while it builds the spec: no request leaves core, and the
      // same history gives the same prompt.
      const fetches = vi.spyOn(globalThis, "fetch");
      let spec: TaskSpec;
      try {
        spec = await specFor(task.taskId, second.runnerId);
        expect((await specFor(task.taskId, second.runnerId)).prompt).toBe(spec.prompt);
        expect(fetches).not.toHaveBeenCalled();
      } finally {
        fetches.mockRestore();
      }
      const { prompt } = spec;
      const at = (text: string): number => prompt.indexOf(text);
      // Its sections, in the template's order.
      const headings = ["## The ticket", "## The pull requests", "## Every message from the team, oldest first", "## Every message of yours, oldest first", "## The turn that was interrupted", "## The branches' logs", "## The workspace"];
      expect(headings.map(at).every((index, position, all) => index >= 0 && (position === 0 || index > (all[position - 1] ?? 0)))).toBe(true);
      // The ticket, and the PR's text as the agent set it.
      expect(prompt).toContain(`OST-77: ${markTicketInline("Add a heron page")}`);
      expect(prompt).toContain(markTicketBlock("List every heron.\nKeep it short."));
      expect(prompt).toContain(`ostra-test/test1: ${markTicketInline("Add the heron page")}`);
      expect(prompt).toContain("A page that lists the herons.");
      // Every member message (both members') and every agent message, oldest first.
      expect(at("Start with the list of herons.")).toBeLessThan(at("Add the grey heron too."));
      expect(at("Add the grey heron too.")).toBeLessThan(at("## Every message of yours"));
      expect(at("## Every message of yours")).toBeLessThan(at("I listed six herons."));
      expect(at("I listed six herons.")).toBeLessThan(at("The grey heron is in."));
      // The interrupted turn's text in its own section, never as a finished message; the message it
      // was answering, and the reopen's, are the new session's first turns instead.
      expect(at("Writing the summary now:")).toBeGreaterThan(at("## The turn that was interrupted"));
      expect(prompt.split("Writing the summary now:")).toHaveLength(2);
      expect(spec.restore?.pendingMessages.map((message) => message.text)).toEqual(["Now write a short summary.", "Carry on, please."]);
      // So the section points at the message sent again after the prompt, not at the last one above
      // ("Add the grey heron too.", which turn 2 answered).
      expect(prompt).not.toContain("Now write a short summary.");
      expect(prompt).toContain("it was working on a message from the team that isn't above: it comes to you again right after this, as the team's next message.");
      expect(prompt).not.toContain("the team's last message above");
      // The branch's log: its pushes and the files the agent changed, by line counts.
      expect(prompt).toContain(`ostra-test/test1, branch ${branchName}:`);
      expect(prompt).toContain(`pushed: ${sha("heron-1")}`);
      expect(prompt).toContain(" docs/herons.md | +12 -0");
      // No tool's output, and no patch.
      expect(prompt).not.toContain("TOOL-OUTPUT-NEVER-COPIED");
      expect(prompt).not.toContain("PATCH-TEXT-NEVER-COPIED");
      expect(prompt).toContain("restored as it was");
      expect(prompt.length).toBeLessThanOrEqual(REBUILD_TEMPLATE_MAX_CHARS);
    } finally {
      await setOnline(first, true);
    }
  });

  it("F-033/c3: a long history's template stays under its cap, the oldest messages left out first and counted", async () => {
    await setOnline(first, true);
    const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, first);
    const long = "x".repeat(28_000);
    for (let index = 1; index <= 6; index += 1) {
      const id = turnIdSchema.parse(`turn-${String(index)}`);
      await memberSays(task, `QUESTION-${String(index)}`);
      await task.send(
        { kind: "turn.started", turnId: id },
        { kind: "agent.message", turnId: id, segmentId: segmentIdSchema.parse(`a${String(index)}`), text: `ANSWER-${String(index)} ${long}` },
        { kind: "turn.ended", turnId: id, stopReason: "end_turn" },
      );
    }
    await task.send({ kind: "session.saved", turnOrdinal: 6, repos: [{ repoId: repo(), headSha: null, ahead: false, hiddenRefSha: null }], archive: null });
    await setOnline(first, false);
    try {
      const sessionId = await reopened(task.taskId, "Sum it up.");
      const offered = await dispatch(task.taskId, sessionId);
      expect(await test.db.session.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({ origin: "rebuilt" });
      await accept(task.taskId, offered, second);
      const { prompt } = await specFor(task.taskId, second.runnerId);
      expect(prompt.length).toBeLessThanOrEqual(REBUILD_TEMPLATE_MAX_CHARS);
      const cut = /\((\d+) of the oldest messages were left out to keep this under 100000 characters\.\)/.exec(prompt);
      expect(Number(cut?.[1] ?? 0)).toBeGreaterThan(0);
      expect(prompt).not.toContain("QUESTION-1");
      expect(prompt).not.toContain("ANSWER-1 ");
      expect(prompt).toContain("QUESTION-6");
      expect(prompt).toContain("ANSWER-6 ");
    } finally {
      await setOnline(first, true);
    }
  });

  it("F-033/c3: holds 4 of the 5 facts after the archive is gone: all but the tool's output", async () => {
    await setOnline(first, true);
    const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, first);
    const turn = async (index: number, member: string, events: readonly TaskEvent[], answer: string): Promise<void> => {
      await memberSays(task, member);
      const id = turnIdSchema.parse(`turn-${String(index)}`);
      await task.send(
        { kind: "turn.started", turnId: id },
        ...events,
        { kind: "agent.message", turnId: id, segmentId: segmentIdSchema.parse(`a${String(index)}`), text: answer },
        { kind: "turn.ended", turnId: id, stopReason: "end_turn" },
      );
    };
    const call = toolCallIdSchema.parse("call-notes");
    const run = toolCallIdSchema.parse("call-run");
    await turn(1, `The codename for this task is ${facts.codename}. Remember it.`, [], "Noted.");
    await turn(
      2,
      "Write some notes under docs/.",
      [
        { kind: "tool.called", turnId: turnIdSchema.parse("turn-2"), toolCallId: call, toolKind: "edit", title: "Write notes", input: { paths: [facts.docSlug] } },
        { kind: "tool.completed", toolCallId: call, output: { files: [{ path: facts.docSlug, added: 3, removed: 0, patch: "+secret patch text" }] } },
      ],
      "I wrote the notes.",
    );
    await turn(
      3,
      "Run node -e 'console.log(\"RESULT-\" + 48213)'.",
      [
        { kind: "tool.called", turnId: turnIdSchema.parse("turn-3"), toolCallId: run, toolKind: "execute", title: "node", input: { command: "node -e" } },
        { kind: "tool.completed", toolCallId: run, output: { output: facts.printed, truncated: false, exitCode: 0 } },
      ],
      "The command ran.",
    );
    await turn(4, `In README.md, replace hello with ${facts.readmeWord}.`, [], "Done: README.md updated.");
    await turn(5, "Pick a port for the dev server, and tell me.", [], `I'll use port ${facts.port} for the dev server.`);
    // Nothing pushed: the task needs its driver, who reopens it with the question.
    await task.send({ kind: "session.saved", turnOrdinal: 5, repos: [{ repoId: repo(), headSha: null, ahead: false, hiddenRefSha: null }], archive: null });

    await setOnline(first, false);
    const sessionId = await reopened(task.taskId, "What did you change in your first turn, and why?");
    const offered = await dispatch(task.taskId, sessionId);
    expect(await test.db.session.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({ origin: "rebuilt" });
    await accept(task.taskId, offered, second);
    const { prompt } = await specFor(task.taskId, second.runnerId);
    const held = [facts.codename, facts.docSlug, facts.printed, facts.readmeWord, facts.port].filter((fact) => prompt.includes(fact));
    expect(held).toEqual([facts.codename, facts.docSlug, facts.readmeWord, facts.port]);
    expect(held.length).toBeGreaterThanOrEqual(4);
    // No tool output and no patch: the template holds paths and line counts only.
    expect(prompt).not.toContain(facts.printed);
    expect(prompt).not.toContain("secret patch text");
    expect(prompt).toContain(`${facts.docSlug} | +3 -0`);
    await setOnline(first, true);
  });
});

describe("a reopen no provider serves (F-135)", () => {
  it("F-135/c11: a reopen in a project whose list serves no model waits queued with the no-key reason, and its needs-you item is the organization admins'", async () => {
    const task = await inReview();
    const organizationId = fixture.a.organization.id;
    const projectId = world.projectId;
    // An organization admin gives the project a list of its own, with no provider on it.
    await test.db.providerListEntry.deleteMany({ where: { organizationId, projectId } });
    await test.db.project.update({ where: { id: projectId }, data: { ownProviders: true } });
    try {
      const sessionId = await reopened(task.taskId, "Also add a changelog entry.");
      expect(await dispatch(task.taskId, sessionId)).toMatchObject({ ok: false, error: "no-runner", message: "no-provider-for-model" });
      const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
      expect(row.state).toBe("queued");
      expect(dispatchWaitFromDb(row.dispatchWait)).toEqual({ code: "no-provider-for-model", modelName: "dev-model-1" });
      expect(await test.db.lease.count({ where: { taskId: task.taskId, state: "active" } })).toBe(0);
      // The new session records no provider: nothing falls back to another key, or the last session's.
      expect((await test.db.session.findUniqueOrThrow({ where: { id: sessionId } })).providerId).toBeNull();
      const items = await test.db.needsYouItem.findMany({ where: { taskId: task.taskId, state: "open" } });
      expect(items.map((item) => [item.reason, item.audience])).toEqual([["no_provider_for_model", "organization_admins"]]);
    } finally {
      await test.db.providerListEntry.deleteMany({ where: { organizationId, projectId } });
      await test.db.project.update({ where: { id: projectId }, data: { ownProviders: false } });
      await test.db.task.update({ where: { id: task.taskId }, data: { state: "stopped", stoppedReason: "requested" } });
    }
  });
});
