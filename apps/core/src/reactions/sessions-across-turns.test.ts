import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { answerApproval, answerQuestion, moveTaskInTx, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import type { MemberScope, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  approvalIdSchema,
  approvalRuleIdSchema,
  blobIdSchema,
  boxIdSchema,
  leaseEpochSchema,
  memberIdSchema,
  optionIdSchema,
  PROTOCOL_MINOR,
  questionIdSchema,
  repoIdSchema,
  segmentIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "@ostra/protocol";
import type { RepoId, TaskEvent } from "@ostra/protocol";
import { mapTask } from "@ostra/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { RunnerRef } from "../gateway/context.ts";
import { createIngest, salvageEventsFrame } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { fanoutChangesOf } from "../testing/notify.ts";
import { connect, registerPersonal, startGateway } from "../testing/harness.ts";
import { runnerEvent, seedLeasedTask } from "../testing/seed.ts";
import { acceptedTask, jobContext, sha } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { seedOnlineRunner, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { endGraceInTx } from "../ingest/grace.ts";
import type { GraceDeps } from "../ingest/grace.ts";
import { openPullRequestsHandler, sessionEndedHandler } from "./session-end.ts";
import type { ReactionDeps } from "./session-end.ts";

// Ticket 17: a session that lives across turns (F-096, F-030, F-065, F-047). Each turn's work leaves
// the box with `session.saved`; core opens the PR once, after the first turn with changes; the
// session idles between turns and ends when the idle timer stops the box. A minor-0 runner's
// `session.ended` keeps milestone 1's meaning. An event core can't store is refused once.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let otherWorld: World;
let ingest: Ingest;
let liveText: LiveTextWriter;
let deps: ReactionDeps;
let runner: RunnerRef;
let otherRunner: RunnerRef;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const turnId = turnIdSchema.parse("turn-1");

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  otherWorld = await seedWorld(test.db, { codeHost, secretStore }, fixture.b.organization.id, fixture.b.project.id, { fullName: "ostra-test/other" });
  const timers: SessionTimers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers });
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
  runner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 8);
  otherRunner = await seedOnlineRunner(test.db, fixture.b.organization.id, { kind: "personal", memberId: fixture.b.admin.id }, 8);
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const repo = (): RepoId => repoIdSchema.parse(world.repoId);
const ingestDeps = () => ({ db: test.db, jobs, ingest, logger });

/** A task whose first turn has started. */
const runningTask = async (): Promise<DrivenTask> => {
  const task = await acceptedTask(ingestDeps(), world, fixture.a.member, runner);
  await task.send({ kind: "turn.started", turnId });
  expect(await state(task)).toMatchObject({ state: "running" });
  return task;
};

const state = async (task: DrivenTask) => {
  const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  return { state: row.state, subState: row.subState, needsYouReason: row.needsYouReason };
};

const saved = (turnOrdinal: number, ahead: boolean, head: string | null, archive = true): TaskEvent => ({
  kind: "session.saved",
  turnOrdinal,
  repos: [{ repoId: repo(), headSha: head === null ? null : sha(head), ahead, hiddenRefSha: sha(`wip-${String(turnOrdinal)}`) }],
  archive: archive ? { blobId: blobIdSchema.parse(`blob-archive-${String(turnOrdinal)}`), size: 100, sha256: "a".repeat(64) } : null,
});

/** A turn: started, a message, maybe a push and the PR's text, ended, then saved. */
const turn = async (task: DrivenTask, ordinal: number, changes: boolean, title = "ignored"): Promise<void> => {
  const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const events: TaskEvent[] = [];
  if (ordinal > 1) {
    events.push({ kind: "turn.started", turnId });
  }
  events.push({ kind: "agent.message", turnId, segmentId: segmentIdSchema.parse(`s${String(ordinal)}`), text: `turn ${String(ordinal)} done` });
  if (changes) {
    events.push(
      { kind: "git.pushed", repoId: repo(), branch: branchName, headSha: sha(`head-${String(ordinal)}`), ref: `refs/heads/${branchName}` },
      { kind: "pr.text_set", repoId: repo(), title, body: `The change of turn ${String(ordinal)}.` },
    );
  }
  events.push({ kind: "turn.ended", turnId, stopReason: "end_turn" });
  events.push(saved(ordinal, changes || ordinal > 2, changes ? `head-${String(ordinal)}` : null));
  await task.send(...events);
};

const savedSeq = async (task: DrivenTask, ordinal: number): Promise<number> => {
  const rows = await test.db.event.findMany({ where: { taskId: task.taskId, kind: "session.saved" }, orderBy: { seq: "asc" } });
  const row = rows[ordinal - 1];
  if (row === undefined) {
    throw new Error(`no session.saved for turn ${String(ordinal)}`);
  }
  return row.seq;
};

const openPrJobs = async (task: DrivenTask, ordinal: number) =>
  jobs.find("task.open-pull-requests", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: await savedSeq(task, ordinal) });

const runOpener = async (task: DrivenTask, ordinal: number): Promise<void> => {
  await openPullRequestsHandler(deps)(
    jobContext("task.open-pull-requests", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: await savedSeq(task, ordinal) }, logger),
  );
};

const endSession = async (task: DrivenTask): Promise<void> => {
  const ended = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.ended" } });
  await sessionEndedHandler(deps)(jobContext("task.session-ended", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: ended.seq }, logger));
};

/** Another organization's running task, which nothing here may touch. */
const otherTask = async (): Promise<DrivenTask> => {
  const task = await acceptedTask(ingestDeps(), otherWorld, fixture.b.admin, otherRunner);
  await task.send({ kind: "turn.started", turnId });
  return task;
};

const untouched = async (task: DrivenTask): Promise<void> => {
  const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  expect(row.state).toBe("running");
  expect(row.eventSeq).toBe(1);
  expect(await test.db.needsYouItem.count({ where: { taskId: task.taskId } })).toBe(0);
  expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "no_branch", hiddenRefSha: null });
};

describe("a session across turns (F-096, F-030, F-065)", () => {
  it("opens one PR after the second turn, none for the first or the third, idles between turns and ends on the timer", async () => {
    const other = await otherTask();
    const task = await runningTask();
    const session = await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } });
    const boxId = boxIdSchema.parse(session.boxId);
    // The session's maximum duration started with its first turn (F-068).
    expect(await jobs.find("session.max-duration", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId })).toHaveLength(1);
    expect(await test.db.box.findUniqueOrThrow({ where: { id: boxId } })).toMatchObject({ state: "ready" });

    // Turn 1, no changes: needs you (F-065), the session idles, the box stays warm.
    const before = codeHost.pulls.length;
    await turn(task, 1, false);
    expect(await state(task)).toMatchObject({ state: "needs_you", needsYouReason: "no_changes" });
    expect(await openPrJobs(task, 1)).toHaveLength(0);
    const noChanges = await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId, reason: "no_changes" } });
    expect(noChanges).toMatchObject({ summary: "turn 1 done" });
    // F-036: raised with its fan-out.
    expect(await fanoutChangesOf(test.db, noChanges.id)).toEqual(["created"]);
    expect(await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).toMatchObject({
      state: "idle",
      archiveBlobId: "blob-archive-1",
      archiveTurnOrdinal: 1,
    });
    const idleBox = await test.db.box.findUniqueOrThrow({ where: { id: boxId } });
    expect(idleBox.state).toBe("idle");
    expect(idleBox.idleSince).not.toBeNull();
    expect(await jobs.find("box.release-after-idle", { organizationId: task.organizationId, taskId: task.taskId, boxId })).toHaveLength(1);
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "active" });

    // The member answers: the next turn runs in the warm box.
    await test.db.$transaction(async (tx) => {
      await moveTaskInTx({ tx, notices: postgresChangeNotices, jobs }, mapTask(await tx.task.findUniqueOrThrow({ where: { id: task.taskId } })), { type: "member_acted", boxWarm: true });
    });

    // Turn 2, with changes: one PR job, and the opener opens one PR.
    await turn(task, 2, true);
    expect(await test.db.box.findUniqueOrThrow({ where: { id: boxId } })).toMatchObject({ state: "idle" });
    expect(await openPrJobs(task, 2)).toHaveLength(1);
    await runOpener(task, 2);
    await runOpener(task, 2);
    expect(codeHost.pulls.slice(before)).toHaveLength(1);
    expect(codeHost.pulls.at(-1)?.body).toContain("The change of turn 2.");
    expect(await state(task)).toMatchObject({ state: "in_review", subState: "waiting_for_reviewer" });
    expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({
      state: "pr_open",
      ahead: true,
      headSha: sha("head-2"),
      hiddenRefSha: sha("wip-2"),
      hiddenRefBaseSha: sha("head-2"),
    });

    // Turn 3, with changes again: the push updated the PR; no second PR, no PR job.
    await turn(task, 3, true);
    expect(await openPrJobs(task, 3)).toHaveLength(0);
    expect(codeHost.pulls.slice(before)).toHaveLength(1);
    expect(await state(task)).toMatchObject({ state: "in_review" });
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "pr.opened" } })).toBe(1);
    expect(await test.db.turn.count({ where: { sessionId: task.sessionId } })).toBe(3);

    // A save whose archive failed keeps the last good one.
    await task.send({ kind: "turn.started", turnId }, { kind: "turn.ended", turnId, stopReason: "end_turn" }, saved(4, true, "head-3", false));
    expect(await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).toMatchObject({ archiveBlobId: "blob-archive-3", archiveTurnOrdinal: 3 });

    // The idle timer stopped the box: a minor-1 runner's `session.ended` only ends the session.
    await task.send({ kind: "session.ended", outcome: "with-changes", repos: [{ repoId: repo(), ahead: true }] });
    await endSession(task);
    expect(await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).toMatchObject({ state: "ended", outcome: "with_changes" });
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "ended", endReason: "released" });
    const stopped = await test.db.box.findUniqueOrThrow({ where: { id: boxId } });
    expect(stopped.state).toBe("stopped");
    expect(stopped.stoppedAt).not.toBeNull();
    expect(await state(task)).toMatchObject({ state: "in_review" });
    expect(codeHost.pulls.slice(before)).toHaveLength(1);
    // Milestone 6 (F-102): a task in review waits for its reviewer, and has that one item; nothing else waits.
    expect(await test.db.needsYouItem.count({ where: { taskId: task.taskId, state: "open", reason: { notIn: ["no_changes", "waiting_for_reviewer"] } } })).toBe(0);
    expect(await test.db.needsYouItem.count({ where: { taskId: task.taskId, state: "open", reason: "waiting_for_reviewer" } })).toBe(1);
    // The session's timer is gone with it.
    const timer = await jobs.find("session.max-duration", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId });
    expect(timer.every((job) => job.state === "cancelled")).toBe(true);

    await untouched(other);
  });

  it("F-030/c2: a later turn's new title from the agent renames the open PR; the same title again leaves a person's rename", async () => {
    const task = await runningTask();
    await turn(task, 1, true, "Add a history panel");
    await runOpener(task, 1);
    const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    const pull = (): { readonly title: string; readonly number: number } | undefined => codeHost.pulls.find((item) => item.headBranch === branchName);
    expect(pull()?.title).toBe("Add a history panel");
    const renames = codeHost.titleUpdates.length;

    // Turn 2 changes the PR and the agent says so in a new title: the opener runs for the save and renames it.
    await turn(task, 2, true, "Add a history panel with a clear button");
    expect(await openPrJobs(task, 2)).toHaveLength(1);
    // A member's next message has started a turn by the time the opener runs: the task stays running.
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "running", subState: null } });
    await runOpener(task, 2);
    expect(pull()?.title).toBe("Add a history panel with a clear button");
    expect(codeHost.titleUpdates.slice(renames)).toEqual([{ repo: "ostra-test/test1", number: pull()?.number, title: "Add a history panel with a clear button" }]);
    expect(await state(task)).toMatchObject({ state: "running" });
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "pr.opened" } })).toBe(1);
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "in_review", subState: "waiting_for_reviewer" } });

    // A person renames it on the host; turn 3 sets the same title again: no job, and the person's title stays.
    const index = codeHost.pulls.findIndex((item) => item.headBranch === branchName);
    const current = codeHost.pulls[index];
    if (current === undefined) {
      throw new Error("the PR is there");
    }
    codeHost.pulls[index] = { ...current, title: "History panel (by hand)" };
    await turn(task, 3, true, "Add a history panel with a clear button");
    expect(await openPrJobs(task, 3)).toHaveLength(0);
    expect(pull()?.title).toBe("History panel (by hand)");
    expect(codeHost.titleUpdates.slice(renames)).toHaveLength(1);
  });

  it("F-065/c2, F-036/c2, F-062/c2: two turns that end without changes leave one open no-changes item, the second's, and dismiss the first with its fan-out", async () => {
    const task = await runningTask();
    await turn(task, 1, false);
    const first = await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId, reason: "no_changes" } });
    expect(first).toMatchObject({ state: "open", summary: "turn 1 done" });

    // The next turn starts with nobody answering the item, as an automatic turn will (milestone 6).
    await test.db.$transaction(async (tx) => {
      await moveTaskInTx({ tx, notices: postgresChangeNotices, jobs }, mapTask(await tx.task.findUniqueOrThrow({ where: { id: task.taskId } })), { type: "member_acted", boxWarm: true });
    });
    await turn(task, 2, false);
    expect(await state(task)).toMatchObject({ state: "needs_you", needsYouReason: "no_changes" });

    // One open item, the newer moment with the newer summary; the older is dismissed by ostra.
    const open = await test.db.needsYouItem.findMany({ where: { taskId: task.taskId, state: "open" } });
    expect(open.map((item) => ({ reason: item.reason, summary: item.summary }))).toEqual([{ reason: "no_changes", summary: "turn 2 done" }]);
    const second = open[0]?.id ?? "";
    expect(await test.db.needsYouItem.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ state: "dismissed", resolvedByMemberId: null });
    // Each change owes its fan-out: the older's notifications close, the newer's open.
    expect(await fanoutChangesOf(test.db, first.id)).toEqual(["created", "dismissed"]);
    expect(await fanoutChangesOf(test.db, second)).toEqual(["created"]);
  });

  it("keeps milestone 1's meaning for a minor-0 runner's session.ended: the PR opens on it", async () => {
    const other = await otherTask();
    const task = await runningTask();
    const before = codeHost.pulls.length;
    await task.send(
      { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("m0"), text: "Done." },
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "session.ended", outcome: "with-changes", repos: [{ repoId: repo(), ahead: true }] },
    );
    await endSession(task);
    const ended = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.ended" } });
    await openPullRequestsHandler(deps)(
      jobContext("task.open-pull-requests", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: ended.seq }, logger),
    );
    expect(codeHost.pulls.slice(before)).toHaveLength(1);
    expect(await state(task)).toMatchObject({ state: "in_review" });
    await untouched(other);
  });

  it("F-096/c8: a turn that waits on a person meets the idle timer: the box stops, the item stays open, and the answer reopens the task with the decision", async () => {
    const answerDeps = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock };
    const driver: MemberScope = { organizationId: fixture.a.organization.id, memberId: memberIdSchema.parse(fixture.a.member.id), role: "member", projectRoles: new Map() };
    const other = await otherTask();
    // A runner at this build's minor, which holds a request for a person (a minor-0 one has it answered).
    const current = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 8);
    await test.db.runnerPresence.updateMany({ where: { runnerId: current.runnerId }, data: { minor: PROTOCOL_MINOR } });
    const waitingOnCurrent = async (): Promise<DrivenTask> => {
      const task = await acceptedTask(ingestDeps(), world, fixture.a.member, current);
      await task.send({ kind: "turn.started", turnId });
      return task;
    };

    /** What the runner sends when the idle timer fires on a waiting turn (`idle-and-release.test.ts`): the request closed as expired, the turn cancelled and saved, the session ended. */
    const idleOut = async (task: DrivenTask, closed: TaskEvent): Promise<void> => {
      await task.send(closed, { kind: "turn.ended", turnId, stopReason: "cancelled" }, saved(1, false, null), {
        kind: "session.ended",
        outcome: "without-changes",
        repos: [{ repoId: repo(), ahead: false }],
      });
      await endSession(task);
      const session = await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } });
      expect(session.state).toBe("ended");
      expect(await test.db.box.findUniqueOrThrow({ where: { id: session.boxId ?? "" } })).toMatchObject({ state: "stopped" });
      expect(await test.db.lease.count({ where: { taskId: task.taskId, state: "active" } })).toBe(0);
    };
    /** The task's next session's opening message: the decision, as the reopen carries it. */
    const reopenText = async (task: DrivenTask): Promise<string> => {
      const sessions = await test.db.session.findMany({ where: { taskId: task.taskId }, orderBy: { startedAt: "asc" } });
      expect(sessions).toHaveLength(2);
      const message = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "user.message", sessionId: sessions[1]?.id ?? "" } });
      return z.looseObject({ text: z.string(), reopen: z.literal(true) }).parse(message.payload).text;
    };

    // A question.
    const asking = await waitingOnCurrent();
    const questionId = questionIdSchema.parse(crypto.randomUUID());
    await asking.send({ kind: "question.asked", turnId, questionId, message: "Which name should the release get?", fields: [{ id: "name", label: "Release name", type: "text" }] });
    await idleOut(asking, { kind: "question.closed", questionId, reason: "expired" });
    expect(await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: asking.taskId, reason: "question" } })).toMatchObject({ state: "open", questionId });
    expect(await state(asking)).toMatchObject({ state: "needs_you", needsYouReason: "question" });
    expect(await answerQuestion(answerDeps, driver, { taskId: asking.taskId, questionId, answers: { name: "Aurora" } })).toEqual({ ok: true, reopened: true });
    expect(await state(asking)).toMatchObject({ state: "queued" });
    expect(await reopenText(asking)).toContain("Aurora");
    expect(await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: asking.taskId, reason: "question" } })).toMatchObject({ state: "answered" });

    // An approval.
    const holding = await waitingOnCurrent();
    const approvalId = approvalIdSchema.parse(crypto.randomUUID());
    const once = optionIdSchema.parse("o-once");
    await holding.send({
      kind: "approval.requested",
      turnId,
      approvalId,
      toolCallId: toolCallIdSchema.parse(`tool-${approvalId}`),
      options: [
        { optionId: once, label: "Approve once", kind: "allow-once", decision: "allow_once" },
        { optionId: optionIdSchema.parse("o-deny"), label: "Deny", kind: "reject-once", decision: "deny" },
      ],
      rule: { source: "profile", ruleId: approvalRuleIdSchema.parse("rule-config"), name: "Edit files matching config/**" },
      subject: { kind: "path", value: "config/settings.json" },
    });
    await idleOut(holding, { kind: "approval.closed", approvalId, reason: "expired" });
    expect(await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: holding.taskId, approvalId } })).toMatchObject({ state: "open" });
    expect(await state(holding)).toMatchObject({ state: "needs_you", needsYouReason: "approval" });
    expect(await answerApproval(answerDeps, driver, { approvalId, optionId: once, decision: "allow_once", reason: null })).toMatchObject({ ok: true, reopened: true });
    expect(await state(holding)).toMatchObject({ state: "queued" });
    expect(await reopenText(holding)).toContain("config/settings.json");
    expect(await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: holding.taskId, approvalId } })).toMatchObject({ state: "answered" });
    await untouched(other);
  });
});

describe("an event core can't store (F-043)", () => {
  it("is refused once with a needs-you item, acked past, and the next batch is stored", async () => {
    const other = await otherTask();
    const task = await runningTask();
    // An event that fails validation: an agent message with no text.
    const bad = {
      type: "events",
      events: [
        { sessionId: task.sessionId, sessionSeq: task.next(), leaseEpoch: 2, at: Date.now(), event: { kind: "agent.thought", turnId, segmentId: "t1", text: "fine" } },
        { sessionId: task.sessionId, sessionSeq: task.next(), leaseEpoch: 2, at: Date.now(), event: { kind: "agent.message", turnId, segmentId: "s1", secret: "nope" } },
      ],
    };
    // The task was dispatched at epoch 1 (the seed) or above: use its epoch.
    const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    for (const item of bad.events) {
      item.leaseEpoch = leaseEpoch;
    }
    const salvaged = salvageEventsFrame(JSON.stringify(bad), 1);
    expect(salvaged).not.toBeNull();
    if (salvaged === null) {
      throw new Error("salvaged");
    }
    expect(salvaged.refused.size).toBe(1);
    records.length = 0;
    const replies = await ingest(runner, salvaged.frame, salvaged.refused);
    expect(replies).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 3 }]);
    const stored = await test.db.event.findMany({ where: { taskId: task.taskId }, orderBy: { seq: "asc" }, select: { kind: true, payload: true } });
    expect(stored.map((row) => row.kind)).toEqual(["turn.started", "agent.thought", "agent.unknown"]);
    expect(JSON.stringify(stored)).not.toContain("nope");
    expect(JSON.stringify(records)).not.toContain("nope");
    const item = await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId, reason: "unstorable_event" } });
    expect(item).toMatchObject({ state: "open", audience: "driver" });
    // F-036: raised with its fan-out, which an item with no moment of its own turns into nothing.
    expect(await fanoutChangesOf(test.db, item.id)).toEqual(["created"]);
    // The same frame again is a duplicate: nothing new, no second item.
    expect(await ingest(runner, salvaged.frame, salvaged.refused)).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 3 }]);
    expect(await test.db.needsYouItem.count({ where: { taskId: task.taskId, reason: "unstorable_event" } })).toBe(1);
    // The next batch is stored as usual.
    await task.send({ kind: "agent.thought", turnId, segmentId: segmentIdSchema.parse("t2"), text: "next" });
    expect(await test.db.event.count({ where: { taskId: task.taskId } })).toBe(4);
    // A second refused event while the item is open raises no second item.
    const again = salvageEventsFrame(
      JSON.stringify({ type: "events", events: [{ sessionId: task.sessionId, sessionSeq: task.next(), leaseEpoch, at: Date.now(), event: { kind: "nonsense" } }] }),
      1,
    );
    expect(again).not.toBeNull();
    if (again !== null) {
      await ingest(runner, again.frame, again.refused);
    }
    expect(await test.db.needsYouItem.count({ where: { taskId: task.taskId, reason: "unstorable_event" } })).toBe(1);
    expect(await state(task)).toMatchObject({ state: "running" });
    await untouched(other);
  });

  it("leaves a frame it can't salvage a violation: a bad envelope, a server-only kind, or nothing wrong", () => {
    const envelope = { sessionId: "s", sessionSeq: 1, leaseEpoch: 1, at: 1 };
    expect(salvageEventsFrame("not json", 1)).toBeNull();
    expect(salvageEventsFrame(JSON.stringify({ type: "status" }), 1)).toBeNull();
    expect(salvageEventsFrame(JSON.stringify({ type: "events", events: [{ ...envelope, sessionSeq: "x", event: { kind: "agent.thought" } }] }), 1)).toBeNull();
    expect(salvageEventsFrame(JSON.stringify({ type: "events", events: [{ ...envelope, event: { kind: "user.message", text: "forged" } }] }), 1)).toBeNull();
    expect(salvageEventsFrame(JSON.stringify({ type: "events", events: [{ ...envelope, event: { kind: "runner.connected", runnerId: "r" } }] }), 1)).toBeNull();
    // A minor-1 kind from a minor-0 peer is refused for that peer, as an event.
    const minor1 = salvageEventsFrame(JSON.stringify({ type: "events", events: [{ ...envelope, event: { kind: "session.limit_reached", limit: "stall", observed: 10 } }] }), 0);
    expect(minor1?.refused.size).toBe(1);
    expect(salvageEventsFrame(JSON.stringify({ type: "events", events: [{ ...envelope, event: { kind: "session.limit_reached", limit: "stall", observed: 10 } }] }), 1)).toBeNull();
  });
});

describe("an invalid event through the gateway (F-043)", () => {
  it("is acked past instead of closing the socket, so the runner never resends it", async () => {
    const harness = await startGateway(test.db, test.url, { hooks: { ingest, liveText: liveText.write } });
    try {
      const registered = await registerPersonal(harness, test.db, fixture.a.member);
      const task = await seedLeasedTask(test.db, { runnerId: registered.runnerId, organizationId: fixture.a.organization.id }, fixture.a.openProject.id);
      const peer = await connect(harness, registered);
      await peer.next("welcome");
      const envelope = (sessionSeq: number) => ({ sessionId: task.sessionId, sessionSeq, leaseEpoch: 1, at: Date.now() });
      peer.sendText(
        JSON.stringify({
          type: "events",
          events: [
            { ...envelope(1), event: { kind: "agent.thought", turnId, segmentId: "t1", text: "fine" } },
            { ...envelope(2), event: { kind: "tool.called", turnId } },
          ],
        }),
      );
      expect(await peer.next("ack")).toEqual({ type: "ack", sessionId: task.sessionId, upTo: 2 });
      peer.send({ type: "events", events: [runnerEvent(task, 3, { kind: "agent.thought", turnId, segmentId: segmentIdSchema.parse("t3"), text: "next" })] });
      expect(await peer.next("ack")).toEqual({ type: "ack", sessionId: task.sessionId, upTo: 3 });
      expect(peer.frames.some((frame) => frame.type === "error")).toBe(false);
      expect((await test.db.event.findMany({ where: { taskId: task.taskId }, orderBy: { seq: "asc" } })).map((row) => row.kind)).toEqual([
        "agent.thought",
        "agent.unknown",
        "agent.thought",
      ]);
      expect(await test.db.needsYouItem.count({ where: { taskId: task.taskId, reason: "unstorable_event", state: "open" } })).toBe(1);
      peer.close();
    } finally {
      await harness.stop();
    }
  });
});

describe("a lost box after its work was saved (F-047, F-045)", () => {
  it("keeps a task in review when the grace ends, with its archive and hidden ref named on it", async () => {
    const other = await otherTask();
    const task = await runningTask();
    await turn(task, 1, true);
    await runOpener(task, 1);
    expect(await state(task)).toMatchObject({ state: "in_review" });
    const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { disconnectedAt: new Date() } });
    try {
      const graceDeps: GraceDeps = { jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, logger };
      const outcome = await test.db.$transaction(async (tx) => {
        const row = await tx.task.findUniqueOrThrow({ where: { id: task.taskId } });
        return endGraceInTx(graceDeps, tx, row, { organizationId: task.organizationId, taskId: task.taskId, leaseEpoch: leaseEpochSchema.parse(leaseEpoch) });
      });
      expect(outcome).toBe("stopped");
    } finally {
      await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { disconnectedAt: null } });
    }
    expect(await state(task)).toMatchObject({ state: "in_review" });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).leaseEpoch).toBe(leaseEpoch + 1);
    expect(await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).toMatchObject({ state: "stopped", archiveBlobId: "blob-archive-1" });
    expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ hiddenRefSha: sha("wip-1") });
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "ended", endReason: "grace-expired" });
    await untouched(other);
  });
});
