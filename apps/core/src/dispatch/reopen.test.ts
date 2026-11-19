import { randomBytes, randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { appendServerEvent, dispatchTask, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, reopenTask, systemClock } from "@ostra/domain";
import type { DispatchTaskResult, MemberScope, ReopenTaskResult, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  blobIdSchema,
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
import type { BlobRef, RepoId, RunnerId, SessionId, TaskEvent, TaskId, TaskSpec } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
import { seedOnlineRunner, seedWorld } from "../testing/world.ts";
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
const archiveOf = async (taskId: TaskId): Promise<BlobRef> => {
  const blob = await test.db.blob.create({
    data: {
      organizationId: fixture.a.organization.id,
      projectId: world.projectId,
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

const reopen = (taskId: TaskId, text?: string, clientMessageId = clientMessageIdSchema.parse(randomUUID())): Promise<ReopenTaskResult> =>
  test.db.$transaction((tx) =>
    reopenTask(
      { tx, scope, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, spendCap: CAPS, timers },
      { taskId, clientMessageId, ...(text === undefined ? {} : { text }) },
    ),
  );

const reopened = async (taskId: TaskId, text?: string): Promise<SessionId> => {
  const result = await reopen(taskId, text);
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

const memberSays = async (task: DrivenTask, text: string): Promise<void> => {
  await test.db.$transaction((tx) =>
    appendServerEvent(tx, {
      organizationId: task.organizationId,
      projectId: projectIdSchema.parse(world.projectId),
      taskId: task.taskId,
      sessionId: task.sessionId,
      at: Date.now(),
      event: { kind: "user.message", memberId: memberIdSchema.parse(fixture.a.member.id), clientMessageId: clientMessageIdSchema.parse(randomUUID()), text, delivery: "queued" },
    }),
  );
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

  it("raises a restore conflict for the driver and keeps the task running", async () => {
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

describe("what a reopen refuses (F-032, spec section 11, item 12)", () => {
  it("refuses a merged task with no merged repo, a working one, a missing message, and a task at its spend cap", async () => {
    const task = await inReview();
    // Milestone 3 reopens a merged task on a fresh branch (F-066, ticket 24); one whose repos record
    // no merge has nothing to start the fresh branch from.
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "merged", subState: null } });
    expect(await reopen(task.taskId, "more")).toMatchObject({ ok: false, error: "not-reopenable" });
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
    const connection = await test.db.connection.create({ data: { organizationId: fixture.a.organization.id, kind: "linear", appId: "api-key", state: "active" } });
    const board = await test.db.board.create({
      data: { organizationId: fixture.a.organization.id, projectId: world.projectId, connectionId: connection.id, externalId: "team-1", name: "OST", statusMap: {} },
    });
    const ticket = await test.db.ticket.create({
      data: {
        organizationId: fixture.a.organization.id,
        projectId: world.projectId,
        boardId: board.id,
        connectionId: connection.id,
        externalId: "issue-1",
        key: "OST-1",
        title: "A ticket",
        url: "https://linear.app/ostra-test/issue/OST-1",
        trackerUpdatedAt: new Date(),
      },
    });
    const stopped = await inReview();
    await test.db.task.update({ where: { id: stopped.taskId }, data: { state: "stopped", subState: null, stoppedReason: "requested", ticketId: ticket.id, boardId: board.id, ticketKey: "OST-1" } });
    const active = await inReview();
    await test.db.task.update({ where: { id: active.taskId }, data: { ticketId: ticket.id, boardId: board.id, ticketKey: "OST-1" } });
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
  it("holds 4 of the 5 facts after the archive is gone: all but the tool's output", async () => {
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
