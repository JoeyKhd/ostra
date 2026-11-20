import { randomBytes, randomUUID } from "node:crypto";

import { createLogger, hiddenRefFor } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import type { SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { blobIdSchema, boxIdSchema, commandIdSchema, commandSeqSchema, PROTOCOL_MINOR, releaseBodySchema, repoIdSchema, segmentIdSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { BlobRef, BoxId, OrganizationId, RepoId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { openPullRequestsHandler } from "../reactions/session-end.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connect, registerPersonal, startGateway } from "../testing/harness.ts";
import { fanoutChangesOf } from "../testing/notify.ts";
import { acceptedTask, jobContext, sha } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { applyReleaseResultsInTx, boxReleaseHandler, releaseAfterIdleHandler, runRetention } from "./cleanup.ts";
import type { CleanupDeps } from "./cleanup.ts";

// Ticket 20 (F-079, F-096): a box released once when its task's last PR merges, with the hidden ref
// deleted; an offline runner's `release` delivered when it reconnects; the idle days' release that
// a turn in between cancels; and retention, off by default, that deletes only finished tasks'
// content past the period and records each run.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let otherWorld: World;
let ingest: Ingest;
let liveText: LiveTextWriter;
let timers: SessionTimers;
let runner: RunnerRef;
let otherRunner: RunnerRef;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const turnId = turnIdSchema.parse("turn-1");

const cleanupDeps = (overrides: Partial<CleanupDeps> = {}): CleanupDeps => ({
  db: test.db,
  jobs,
  outbox: postgresCommandOutbox,
  notices: postgresChangeNotices,
  audit: postgresAuditLog,
  clock: systemClock,
  adapters: { codeHost, secretStore },
  logger,
  retentionDays: null,
  releaseAfterIdleMs: 14 * 24 * 3_600_000,
  ...overrides,
});

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  otherWorld = await seedWorld(test.db, { codeHost, secretStore }, fixture.b.organization.id, fixture.b.project.id, { fullName: "ostra-test/other" });
  timers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox });
  runner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 20);
  otherRunner = await seedOnlineRunner(test.db, fixture.b.organization.id, { kind: "personal", memberId: fixture.b.admin.id }, 20);
  await test.db.runnerPresence.updateMany({ where: { runnerId: { in: [runner.runnerId, otherRunner.runnerId] } }, data: { minor: 1 } });
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const repoOf = (target: World): RepoId => repoIdSchema.parse(target.repoId);

/** A task in review on `on`: one turn with changes, its hidden ref and archive saved, its PR open. */
const inReview = async (target: "ours" | "theirs" = "ours"): Promise<DrivenTask & { readonly boxId: BoxId; readonly archive: BlobRef }> => {
  const theWorld = target === "ours" ? world : otherWorld;
  const task =
    target === "ours"
      ? await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner)
      : await acceptedTask({ db: test.db, jobs, ingest, logger }, otherWorld, fixture.b.admin, otherRunner);
  const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const blob = await test.db.blob.create({
    data: {
      organizationId: task.organizationId,
      projectId: theWorld.projectId,
      taskId: task.taskId,
      store: "postgres",
      key: `postgres:${randomUUID()}`,
      purpose: "session-archive",
      contentType: "application/gzip",
      size: 10,
      sha256: randomBytes(32).toString("hex"),
    },
  });
  const archive = { blobId: blobIdSchema.parse(blob.id), size: blob.size, sha256: blob.sha256 };
  await task.send(
    { kind: "turn.started", turnId },
    { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s1"), text: "Done." },
    { kind: "git.pushed", repoId: repoOf(theWorld), branch: branchName, headSha: sha("head"), ref: `refs/heads/${branchName}` },
    { kind: "turn.ended", turnId, stopReason: "end_turn" },
    { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId: repoOf(theWorld), headSha: sha("head"), ahead: true, hiddenRefSha: sha("wip") }], archive },
  );
  const saved = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.saved" } });
  await openPullRequestsHandler({
    db: test.db,
    jobs,
    notices: postgresChangeNotices,
    audit: postgresAuditLog,
    clock: systemClock,
    adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
    publicUrl: "http://localhost:3000",
    logger,
  })(jobContext("task.open-pull-requests", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: saved.seq }, logger));
  const session = await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } });
  return { ...task, boxId: boxIdSchema.parse(session.boxId), archive };
};

/** What ticket 16 leaves when the task's last PR merges. */
const merge = async (taskId: TaskId): Promise<void> => {
  await test.db.task.update({ where: { id: taskId }, data: { state: "merged", subState: null } });
  await test.db.taskRepo.updateMany({ where: { taskId }, data: { state: "merged", mergedAt: new Date() } });
};

const releaseCommands = async (boxId: string) =>
  (await test.db.command.findMany({ where: { kind: "release" }, orderBy: { seq: "asc" } })).filter((row) => releaseBodySchema.parse(row.body).boxId === boxId);

describe("releasing a box (F-079)", () => {
  it("releases the box once when the task's last PR merges, and deletes the hidden ref", async () => {
    const theirs = await inReview("theirs");
    const task = await inReview();
    await merge(task.taskId);
    const payload = { organizationId: task.organizationId, taskId: task.taskId, boxId: task.boxId, reason: "prs-closed" as const };
    await boxReleaseHandler(cleanupDeps())(jobContext("box.release", payload, logger));
    await boxReleaseHandler(cleanupDeps())(jobContext("box.release", payload, logger));
    const commands = await releaseCommands(task.boxId);
    expect(commands).toHaveLength(1);
    expect(releaseBodySchema.parse(commands[0]?.body)).toEqual({ taskId: task.taskId, boxId: task.boxId, reason: "prs-closed" });
    // The box counts as released at once; the ack sets when it went.
    expect(await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).toMatchObject({ state: "released", releaseReason: "prs_closed", releasedAt: null });
    expect(await test.db.lease.count({ where: { boxId: task.boxId, state: "active" } })).toBe(0);
    const ref = hiddenRefFor(task.taskId);
    expect(codeHost.deletedRefs.filter((done) => done.ref === ref)).toEqual([{ repo: "ostra-test/test1", ref }]);
    expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ hiddenRefSha: null, hiddenRefBaseSha: null });
    const [command] = commands;
    if (command === undefined) {
      throw new Error("a command");
    }
    await test.db.$transaction((tx) =>
      applyReleaseResultsInTx({ clock: systemClock, logger }, tx, runner, [
        { commandId: commandIdSchema.parse(command.id), seq: commandSeqSchema.parse(command.seq), kind: "release", body: command.body, taskId: task.taskId, result: "done", reason: null },
      ]),
    );
    expect((await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).releasedAt).not.toBeNull();
    // Another organization's box and ref are untouched.
    expect(await test.db.box.findUniqueOrThrow({ where: { id: theirs.boxId } })).toMatchObject({ state: "idle" });
    expect(codeHost.deletedRefs.some((done) => done.ref === hiddenRefFor(theirs.taskId))).toBe(false);
  });

  it("keeps the hidden ref of a task that can still be reopened", async () => {
    const task = await inReview();
    await boxReleaseHandler(cleanupDeps())(jobContext("box.release", { organizationId: task.organizationId, taskId: task.taskId, boxId: task.boxId, reason: "requested" }, logger));
    expect(await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).toMatchObject({ state: "released" });
    expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ hiddenRefSha: sha("wip") });
    expect(codeHost.deletedRefs.some((done) => done.ref === hiddenRefFor(task.taskId))).toBe(false);
  });

  it("gives an offline runner its release when it reconnects, from the one command in the outbox", async () => {
    const harness = await startGateway(test.db, test.url, { hooks: { ingest, liveText: liveText.write } });
    try {
      const registered = await registerPersonal(harness, test.db, fixture.a.member);
      const first = await connect(harness, registered, { minor: PROTOCOL_MINOR - 1 });
      await first.next("welcome");
      first.close();
      await first.closed;
      const organizationId: OrganizationId = fixture.a.organization.id;
      const task = await test.db.task.create({
        data: { organizationId, projectId: world.projectId, kind: "code", source: "prompt", title: "Done", prompt: "done", branchName: `ostra/${randomBytes(4).toString("hex")}-done`, state: "merged", runnerId: registered.runnerId },
      });
      const box = await test.db.box.create({ data: { organizationId, projectId: world.projectId, taskId: task.id, runnerId: registered.runnerId, executor: "host", state: "stopped", stoppedAt: new Date() } });
      await boxReleaseHandler(cleanupDeps())(
        jobContext("box.release", { organizationId, taskId: taskIdSchema.parse(task.id), boxId: boxIdSchema.parse(box.id), reason: "prs-closed" }, logger),
      );
      expect(await test.db.box.findUniqueOrThrow({ where: { id: box.id } })).toMatchObject({ state: "released", releasedAt: null });
      const again = await connect(harness, registered, { minor: PROTOCOL_MINOR - 1 });
      const delivered = await again.next("command");
      expect(delivered).toMatchObject({ kind: "release", body: { boxId: box.id, reason: "prs-closed" } });
      expect(await releaseCommands(box.id)).toHaveLength(1);
      again.close();
    } finally {
      await harness.stop();
    }
  });
});

describe("the idle days (F-079, F-096)", () => {
  it("releases a box still idle when its delayed job wakes, and leaves one a turn runs in", async () => {
    const idle = await inReview();
    const idleJob = await jobs.find("box.release-after-idle", { organizationId: idle.organizationId, taskId: idle.taskId, boxId: idle.boxId });
    expect(idleJob.at(-1)).toMatchObject({ state: "created" });
    await releaseAfterIdleHandler(cleanupDeps())(jobContext("box.release-after-idle", { organizationId: idle.organizationId, taskId: idle.taskId, boxId: idle.boxId }, logger));
    expect(await test.db.box.findUniqueOrThrow({ where: { id: idle.boxId } })).toMatchObject({ state: "released", releaseReason: "idle_expired" });

    const busy = await inReview();
    // A turn starts in the box: the timer is cancelled, and a late wake-up does nothing.
    await busy.send({ kind: "turn.started", turnId });
    expect((await jobs.find("box.release-after-idle", { organizationId: busy.organizationId, taskId: busy.taskId, boxId: busy.boxId })).at(-1)).toMatchObject({ state: "cancelled" });
    await releaseAfterIdleHandler(cleanupDeps())(jobContext("box.release-after-idle", { organizationId: busy.organizationId, taskId: busy.taskId, boxId: busy.boxId }, logger));
    expect(await test.db.box.findUniqueOrThrow({ where: { id: busy.boxId } })).toMatchObject({ state: "ready" });
    expect(await releaseCommands(busy.boxId)).toHaveLength(0);
  });
});

describe("retention (F-079, spec section 11, item 11)", () => {
  const age = async (taskId: TaskId, days: number): Promise<void> => {
    await test.db.$executeRaw`UPDATE "task" SET "updatedAt" = ${new Date(Date.now() - days * 24 * 3_600_000)} WHERE "id" = ${taskId}`;
  };
  const finish = async (task: DrivenTask, days: number): Promise<void> => {
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "stopped", subState: null, stoppedReason: "requested" } });
    await age(task.taskId, days);
  };

  it("deletes nothing while off, and only finished tasks' content past the period once on, recording each run", async () => {
    const old = await inReview();
    const recent = await inReview();
    const running = await inReview();
    const theirs = await inReview("theirs");
    await finish(old, 40);
    await finish(recent, 5);
    await age(running.taskId, 40);
    await finish(theirs, 5);

    // Off by default: nothing goes, and nothing is recorded.
    const off = await runRetention(cleanupDeps());
    expect(off.retentionDays).toBeNull();
    expect(await test.db.event.count({ where: { taskId: old.taskId } })).toBeGreaterThan(0);
    expect(await test.db.auditEntry.count({ where: { action: "retention.swept" } })).toBe(0);
    // A saved "keep" wins over the env's days.
    await test.db.instanceSetting.upsert({ where: { id: "instance" }, create: { id: "instance", retentionDays: null, retentionSetAt: new Date() }, update: { retentionDays: null, retentionSetAt: new Date() } });
    expect((await runRetention(cleanupDeps({ retentionDays: 1 }))).retentionDays).toBeNull();
    expect(await test.db.event.count({ where: { taskId: old.taskId } })).toBeGreaterThan(0);

    // A saved 30 days: the old finished task's history and blobs go; its row and repos stay.
    await test.db.instanceSetting.update({ where: { id: "instance" }, data: { retentionDays: 30, retentionSetAt: new Date() } });
    const on = await runRetention(cleanupDeps());
    expect(on.retentionDays).toBe(30);
    expect(on.swept).toMatchObject({ ok: true, tasks: 1 });
    expect(await test.db.event.count({ where: { taskId: old.taskId } })).toBe(0);
    expect(await test.db.blob.count({ where: { taskId: old.taskId } })).toBe(0);
    expect(await test.db.session.findUniqueOrThrow({ where: { id: old.sessionId } })).toMatchObject({ archiveBlobId: null });
    expect(await test.db.task.findUnique({ where: { id: old.taskId } })).not.toBeNull();
    expect(await test.db.taskRepo.count({ where: { taskId: old.taskId } })).toBe(1);
    expect(await test.db.auditEntry.findFirstOrThrow({ where: { action: "task.history_removed", entityId: old.taskId } })).toMatchObject({ data: { blobs: 1 } });
    // The recent, the running and the other organization's tasks keep everything.
    for (const kept of [recent, running, theirs]) {
      expect(await test.db.event.count({ where: { taskId: kept.taskId } })).toBeGreaterThan(0);
      expect(await test.db.blob.count({ where: { taskId: kept.taskId } })).toBe(1);
    }
    // Each organization's run is recorded with its own counts.
    expect(await test.db.auditEntry.findFirstOrThrow({ where: { action: "retention.swept", organizationId: fixture.a.organization.id } })).toMatchObject({
      data: { tasks: 1, blobs: 1 },
    });
    expect(await test.db.auditEntry.findFirstOrThrow({ where: { action: "retention.swept", organizationId: fixture.b.organization.id } })).toMatchObject({
      data: { tasks: 0, blobs: 0 },
    });
    // A second run has nothing left to delete for it.
    expect((await runRetention(cleanupDeps())).swept).toMatchObject({ ok: true, tasks: 0 });
  });
});

describe("needs-you items that outlived their task (F-036, F-062)", () => {
  it("F-036/c2, F-062/c2: the daily clean-up closes items left open on stopped and merged tasks, owes their fan-out, and leaves the rest", async () => {
    /** A task in `state` with one item in `itemState`, as a release before stopping closed items left it. */
    const seed = async (target: World, state: "stopped" | "merged" | "needs_you", itemState: "open" | "answered" = "open") => {
      const creator = target === world ? fixture.a.member : fixture.b.admin;
      const task = await seedQueuedTask(test.db, target, creator, null);
      await test.db.task.update({
        where: { id: task.taskId },
        data: state === "stopped" ? { state, stoppedReason: "requested" } : state === "merged" ? { state } : { state, needsYouReason: "no_changes" },
      });
      const item = await test.db.needsYouItem.create({
        data: { organizationId: target.organizationId, projectId: target.projectId, taskId: task.taskId, reason: "no_changes", audience: "driver", state: itemState, ...(itemState === "open" ? {} : { resolvedAt: new Date(0) }) },
      });
      return item.id;
    };
    const stopped = await seed(world, "stopped");
    const merged = await seed(world, "merged");
    const theirs = await seed(otherWorld, "stopped");
    const waiting = await seed(world, "needs_you");
    const answered = await seed(world, "stopped", "answered");

    const first = await runRetention(cleanupDeps());
    expect(first.itemsClosed).toBe(3);
    for (const id of [stopped, merged, theirs]) {
      const item = await test.db.needsYouItem.findUniqueOrThrow({ where: { id } });
      expect(item).toMatchObject({ state: "dismissed", resolvedByMemberId: null });
      expect(item.resolvedAt).not.toBeNull();
      // Its notifications close through the fan-out, as any dismissal's.
      expect(await fanoutChangesOf(test.db, id)).toEqual(["dismissed"]);
    }
    // A task that still needs you keeps its item; one already answered stays as it was.
    expect(await test.db.needsYouItem.findUniqueOrThrow({ where: { id: waiting } })).toMatchObject({ state: "open", resolvedAt: null });
    expect(await test.db.needsYouItem.findUniqueOrThrow({ where: { id: answered } })).toMatchObject({ state: "answered", resolvedAt: new Date(0) });
    expect(await fanoutChangesOf(test.db, waiting)).toEqual([]);
    // Nothing is left for the next run.
    expect((await runRetention(cleanupDeps())).itemsClosed).toBe(0);
  });

  it("F-036/c2, F-062/c2, F-065/c2: the clean-up keeps the newest open item of a superseding reason on each task, dismisses the older with their fan-out, and leaves approvals, questions and plans stacked", async () => {
    const task = await seedQueuedTask(test.db, world, fixture.a.member, null);
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "needs_you", needsYouReason: "no_changes" } });
    const other = await seedQueuedTask(test.db, otherWorld, fixture.b.admin, null);
    await test.db.task.update({ where: { id: other.taskId }, data: { state: "needs_you", needsYouReason: "crashed" } });
    /** An open item as a release before the rule raised it: beside the older ones, never instead. */
    const raw = async (target: World, taskId: string, reason: "no_changes" | "crashed" | "approval" | "question" | "plan", minute: number) =>
      (
        await test.db.needsYouItem.create({
          data: { organizationId: target.organizationId, projectId: target.projectId, taskId, reason, audience: "driver", summary: `${reason} ${String(minute)}`, createdAt: new Date(Date.UTC(2026, 10, 19, 10, minute)) },
        })
      ).id;
    // As the maintainer's instance had it: three no-changes items, one per turn that ended without changes.
    const noChanges = [await raw(world, task.taskId, "no_changes", 1), await raw(world, task.taskId, "no_changes", 3), await raw(world, task.taskId, "no_changes", 2)];
    const crashed = [await raw(otherWorld, other.taskId, "crashed", 4), await raw(otherWorld, other.taskId, "crashed", 5)];
    const stacked = [
      await raw(world, task.taskId, "approval", 6),
      await raw(world, task.taskId, "approval", 7),
      await raw(world, task.taskId, "question", 8),
      await raw(world, task.taskId, "question", 9),
      await raw(world, task.taskId, "plan", 10),
      await raw(world, task.taskId, "plan", 11),
    ];
    const [olderNoChanges, newestNoChanges, middleNoChanges] = noChanges;
    const [olderCrash, newestCrash] = crashed;

    const first = await runRetention(cleanupDeps());
    expect(first.itemsClosed).toBe(3);
    for (const id of [olderNoChanges, middleNoChanges, olderCrash]) {
      const item = await test.db.needsYouItem.findUniqueOrThrow({ where: { id: id ?? "" } });
      expect(item).toMatchObject({ state: "dismissed", resolvedByMemberId: null });
      expect(item.resolvedAt).not.toBeNull();
      // Its notifications close through the fan-out, as any dismissal's.
      expect(await fanoutChangesOf(test.db, id ?? "")).toEqual(["dismissed"]);
    }
    // The newest of each stays open, and every approval, question and plan waits on its own answer.
    for (const id of [newestNoChanges, newestCrash, ...stacked]) {
      expect(await test.db.needsYouItem.findUniqueOrThrow({ where: { id: id ?? "" } })).toMatchObject({ state: "open", resolvedAt: null });
      expect(await fanoutChangesOf(test.db, id ?? "")).toEqual([]);
    }
    expect(await test.db.needsYouItem.count({ where: { taskId: task.taskId, state: "open" } })).toBe(7);
    // Nothing is left for the next run.
    expect((await runRetention(cleanupDeps())).itemsClosed).toBe(0);
  });
});
