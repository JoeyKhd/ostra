import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import { createJobs, lockTask } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { modelIdSchema, providerIdSchema, repoIdSchema, segmentIdSchema, turnIdSchema } from "@ostra/protocol";
import type { DownFrame, EventsFrame, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { RunnerRef } from "../gateway/context.ts";
import { connect, registerPersonal, startGateway } from "../testing/harness.ts";
import { runnerEvent, seedLeasedTask, seedRunner } from "../testing/seed.ts";
import type { LeasedTask } from "../testing/seed.ts";
import { cancelGraceInTx, endGraceInTx, startGraceInTx } from "./grace.ts";
import type { GraceDeps } from "./grace.ts";
import { createIngest } from "./ingest.ts";
import type { Ingest } from "./ingest.ts";
import { createLiveTextWriter } from "./live-text.ts";
import type { LiveTextWriter } from "./live-text.ts";

// Ticket 25's cases. Ported from spikes/runner-transport/src/harness/scenarios/kill9.ts, cuts.ts and
// acks.ts (resends, gaps, stale epochs) and spike 7's appender checks.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let ingest: Ingest;
let liveText: LiveTextWriter;
let graceDeps: GraceDeps;
let ours: RunnerRef;
let theirs: RunnerRef;
const records: LogRecord[] = [];

const turnId = turnIdSchema.parse("turn-1");
const message = (segment: string, text: string): TaskEvent => ({
  kind: "agent.message",
  turnId,
  segmentId: segmentIdSchema.parse(segment),
  text,
});
const thought = (text: string): TaskEvent => ({ kind: "agent.thought", turnId, segmentId: segmentIdSchema.parse(`t-${text}`), text });
const frame = (...events: EventsFrame["events"]): EventsFrame => ({ type: "events", events });

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  const logger = createLogger((record) => records.push(record));
  liveText = createLiveTextWriter({ db: test.db, logger, intervalMs: 50 });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger });
  graceDeps = { jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, logger, graceMs: 60_000 };
  ours = await seedRunner(test.db, fixture.a.organization.id, fixture.a.member.id);
  theirs = await seedRunner(test.db, fixture.b.organization.id, fixture.b.admin.id);
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const storedSeqs = async (task: LeasedTask) =>
  (await test.db.event.findMany({ where: { taskId: task.taskId }, orderBy: { seq: "asc" }, select: { seq: true, sessionSeq: true } })).map(
    (row) => [row.seq, row.sessionSeq],
  );

const newTask = (state?: "preparing" | "running") =>
  seedLeasedTask(test.db, ours, fixture.a.openProject.id, { ...(state === undefined ? {} : { state }), creatorMemberId: fixture.a.member.id });

const otherOrganizationUntouched = async (): Promise<void> => {
  const other = await seedLeasedTask(test.db, theirs, fixture.b.project.id);
  // Our runner names their session: it's unknown to us, and nothing of theirs moves.
  const replies = await ingest(ours, frame(runnerEvent(other, 1, message("x", "not ours"))));
  expect(replies).toEqual([expect.objectContaining({ type: "error", code: "unknown-session", sessionId: other.sessionId })]);
  expect(await test.db.event.count({ where: { taskId: other.taskId } })).toBe(0);
  expect((await test.db.task.findUniqueOrThrow({ where: { id: other.taskId } })).eventSeq).toBe(0);
};

describe("ingest", () => {
  it("saves a batch numbered per task, and a resent batch stores nothing twice", async () => {
    const task = await newTask();
    const first = await ingest(ours, frame(runnerEvent(task, 1, thought("a")), runnerEvent(task, 2, thought("b")), runnerEvent(task, 3, thought("c"))));
    expect(first).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 3 }]);
    // The ack was lost: the runner sends 2 to 4 again.
    const again = await ingest(ours, frame(runnerEvent(task, 2, thought("b")), runnerEvent(task, 3, thought("c")), runnerEvent(task, 4, thought("d"))));
    expect(again).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 4 }]);
    expect(await storedSeqs(task)).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
    const session = await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } });
    expect(session.ingestedSeq).toBe(4);
    await otherOrganizationUntouched();
  });

  it("answers a gap with resendFrom, and saves what came before it", async () => {
    const task = await newTask();
    await ingest(ours, frame(runnerEvent(task, 1, thought("a"))));
    expect(await ingest(ours, frame(runnerEvent(task, 3, thought("c"))))).toEqual([
      { type: "ack", sessionId: task.sessionId, upTo: 1, resendFrom: 2 },
    ]);
    expect(await ingest(ours, frame(runnerEvent(task, 2, thought("b")), runnerEvent(task, 4, thought("d"))))).toEqual([
      { type: "ack", sessionId: task.sessionId, upTo: 2, resendFrom: 3 },
    ]);
    expect(await storedSeqs(task)).toEqual([
      [1, 1],
      [2, 2],
    ]);
    await otherOrganizationUntouched();
  });

  it("refuses a stale epoch, and stores none of it", async () => {
    const task = await newTask();
    await ingest(ours, frame(runnerEvent(task, 1, thought("a"))));
    // A newer dispatch or the grace raised the epoch.
    await test.db.task.update({ where: { id: task.taskId }, data: { leaseEpoch: 2 } });
    const replies = await ingest(ours, frame(runnerEvent(task, 2, thought("b"))));
    expect(replies).toEqual([expect.objectContaining({ type: "error", code: "stale-lease", sessionId: task.sessionId, currentEpoch: 2 })]);
    expect(await storedSeqs(task)).toEqual([[1, 1]]);
    await otherOrganizationUntouched();
  });

  it("moves the task and session as the events say, in the same transaction", async () => {
    const task = await newTask();
    const repo = await test.db.repo.create({
      data: {
        organizationId: task.organizationId,
        projectId: task.projectId,
        connectionId: (
          await test.db.connection.create({
            data: { organizationId: task.organizationId, kind: "github", appId: "5821041", slug: "ostra-test" },
          })
        ).id,
        installationId: "1",
        hostRepoId: "1",
        fullName: "ostra-test/test1",
        defaultBranch: "main",
        checkoutDir: "test1",
      },
    });
    const taskRow = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    await test.db.taskRepo.create({
      data: {
        organizationId: task.organizationId,
        projectId: task.projectId,
        taskId: task.taskId,
        repoId: repo.id,
        branchName: taskRow.branchName,
        baseBranch: "main",
      },
    });
    const repoId = repoIdSchema.parse(repo.id);
    const replies = await ingest(
      ours,
      frame(
        runnerEvent(task, 1, { kind: "turn.started", turnId }),
        runnerEvent(task, 2, message("m1", "Done.")),
        runnerEvent(task, 3, {
          kind: "usage.recorded",
          providerId: providerIdSchema.parse("provider-1"),
          modelId: modelIdSchema.parse("model-1"),
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 5,
          cacheWriteTokens: 0,
          estimated: false,
        }),
        runnerEvent(task, 4, { kind: "turn.ended", turnId, stopReason: "end_turn" }),
        runnerEvent(task, 5, { kind: "git.pushed", repoId, branch: taskRow.branchName, headSha: "a".repeat(40), ref: `refs/heads/${taskRow.branchName}` }),
        runnerEvent(task, 6, { kind: "pr.text_set", repoId, title: "Add CONTRIBUTING.md", body: "Explains the tests." }),
        runnerEvent(task, 7, { kind: "session.ended", outcome: "with-changes", repos: [{ repoId, ahead: true }] }),
      ),
    );
    expect(replies).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 7 }]);
    const after = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(after.state).toBe("running");
    const session = await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } });
    expect(session).toMatchObject({ state: "idle", inputTokens: 120, outputTokens: 30, cacheReadTokens: 5 });
    const turn = await test.db.turn.findFirstOrThrow({ where: { sessionId: task.sessionId } });
    expect(turn).toMatchObject({ ordinal: 1, startSeq: 1, stopReason: "end_turn" });
    expect(turn.endedAt).not.toBeNull();
    const taskRepo = await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } });
    expect(taskRepo).toMatchObject({ headSha: "a".repeat(40), prTitle: "Add CONTRIBUTING.md", prBody: "Explains the tests." });
    // The session's end is a job, keyed by the event's task seq.
    const reaction = await jobs.find("task.session-ended", {
      organizationId: task.organizationId,
      taskId: task.taskId,
      sessionId: task.sessionId,
      eventSeq: 7,
    });
    expect(reaction.map((job) => job.state)).toEqual(["created"]);
    // A change notice for the task's move.
    expect(await test.db.changeNotice.count({ where: { entity: "task", entityId: task.taskId } })).toBeGreaterThan(0);
  });

  it("F-089: stores each call's fresh input, output, cache-read and cache-write tokens apart, and sums each kind on the session", async () => {
    const task = await newTask("running");
    const usage = (inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, estimated = false): TaskEvent => ({
      kind: "usage.recorded",
      providerId: providerIdSchema.parse("provider-1"),
      modelId: modelIdSchema.parse("model-1"),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      estimated,
    });
    // Two calls of one turn, and a title call with no turn of its own: every call counts.
    await ingest(ours, frame(runnerEvent(task, 1, { kind: "turn.started", turnId }), runnerEvent(task, 2, usage(21, 9, 4000, 512)), runnerEvent(task, 3, usage(7, 40, 4512, 0))));
    await ingest(ours, frame(runnerEvent(task, 4, usage(3, 11, 0, 0, true))));
    const stored = z
      .array(z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(), cacheWriteTokens: z.number(), estimated: z.boolean() }))
      .parse((await test.db.event.findMany({ where: { taskId: task.taskId, kind: "usage.recorded" }, orderBy: { seq: "asc" } })).map((event) => event.payload));
    expect(stored).toEqual([
      { inputTokens: 21, outputTokens: 9, cacheReadTokens: 4000, cacheWriteTokens: 512, estimated: false },
      { inputTokens: 7, outputTokens: 40, cacheReadTokens: 4512, cacheWriteTokens: 0, estimated: false },
      { inputTokens: 3, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: true },
    ]);
    const session = await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } });
    expect(session).toMatchObject({ inputTokens: 31, outputTokens: 60, cacheReadTokens: 8512, cacheWriteTokens: 512 });
  });

  it("a crash puts the task in needs you for its driver, and fails the box", async () => {
    const task = await newTask("running");
    await test.db.session.update({ where: { id: task.sessionId }, data: { state: "running" } });
    await test.db.box.update({ where: { id: task.boxId }, data: { state: "ready" } });
    await ingest(ours, frame(runnerEvent(task, 1, { kind: "session.crashed", error: "the agent exited with code 1" })));
    const after = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(after).toMatchObject({ state: "needs_you", needsYouReason: "crashed" });
    expect(await test.db.needsYouItem.findFirst({ where: { taskId: task.taskId } })).toMatchObject({ reason: "crashed", audience: "driver", state: "open" });
    expect(await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).toMatchObject({ state: "failed" });
    expect(await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).toMatchObject({ state: "crashed" });
  });

  it("stores an event whose transition is refused, logs the refusal with IDs only, and acts on nothing", async () => {
    const task = await newTask("running");
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "stopped", stoppedReason: "requested" } });
    records.length = 0;
    const replies = await ingest(ours, frame(runnerEvent(task, 1, { kind: "turn.started", turnId })));
    expect(replies).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 1 }]);
    expect(await test.db.event.count({ where: { taskId: task.taskId } })).toBe(1);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("stopped");
    const refusal = records.find((record) => record.message === "task.transition-refused");
    expect(refusal?.fields).toEqual({ component: "ingest", taskId: task.taskId, input: "box_ready", state: "stopped" });
  });
});

// A lone surrogate is text no UTF-8 holds: Postgres' jsonb refuses it (SQLSTATE 22P02), and so it
// does on every resend. (A NUL is repaired before it gets there; see storable-event.ts.)
const LONE_SURROGATE = "\ud800";
const poison = (segment: string): TaskEvent => message(segment, `poison ${LONE_SURROGATE} text`);

const storedEvents = async (task: LeasedTask) =>
  (await test.db.event.findMany({ where: { taskId: task.taskId }, orderBy: { seq: "asc" }, select: { sessionSeq: true, kind: true, payload: true } })).map(
    (row) => [row.sessionSeq, row.kind] as const,
  );

describe("a batch the database refuses", () => {
  it("stores a placeholder for the refused event, saves the rest, and acks the whole batch", async () => {
    const task = await newTask();
    records.length = 0;
    const replies = await ingest(ours, frame(runnerEvent(task, 1, thought("a")), runnerEvent(task, 2, poison("seg-bad")), runnerEvent(task, 3, thought("c"))));
    expect(replies).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 3 }]);
    expect(await storedEvents(task)).toEqual([
      [1, "agent.thought"],
      [2, "agent.unknown"],
      [3, "agent.thought"],
    ]);
    const placeholder = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, sessionSeq: 2 } });
    expect(placeholder.payload).toEqual({ kind: "agent.unknown", acpKind: "event-refused", raw: "refused by the database: 22P02" });
    expect((await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).ingestedSeq).toBe(3);
    // The log has IDs and codes, and none of the event.
    const refused = records.filter((record) => record.message === "ingest.event-refused");
    expect(refused.map((record) => record.fields)).toEqual([
      {
        component: "ingest",
        runnerId: ours.runnerId,
        sessionId: task.sessionId,
        sessionSeq: 2,
        kind: "agent.message",
        code: "P2007",
        sqlState: "22P02",
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("poison");
  });

  it("refuses the poison once: the resend stores nothing and is acked, and the next batch flows", async () => {
    const task = await newTask();
    const batch = frame(runnerEvent(task, 1, poison("seg-1")), runnerEvent(task, 2, thought("b")));
    expect(await ingest(ours, batch)).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 2 }]);
    records.length = 0;
    // The ack was lost, so the runner sends it again: the cursor is past it, so nothing is tried.
    expect(await ingest(ours, batch)).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 2 }]);
    expect(records.filter((record) => record.message === "ingest.event-refused")).toEqual([]);
    expect(await ingest(ours, frame(runnerEvent(task, 3, thought("c")), runnerEvent(task, 4, thought("d"))))).toEqual([
      { type: "ack", sessionId: task.sessionId, upTo: 4 },
    ]);
    expect(await storedEvents(task)).toEqual([
      [1, "agent.unknown"],
      [2, "agent.thought"],
      [3, "agent.thought"],
      [4, "agent.thought"],
    ]);
  });

  it("replaces each refused event, wherever they are in the batch", async () => {
    const task = await newTask();
    const events = [
      runnerEvent(task, 1, poison("s1")),
      runnerEvent(task, 2, thought("b")),
      runnerEvent(task, 3, thought("c")),
      runnerEvent(task, 4, poison("s4")),
      runnerEvent(task, 5, thought("e")),
      runnerEvent(task, 6, poison("s6")),
    ];
    expect(await ingest(ours, frame(...events))).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 6 }]);
    expect((await storedEvents(task)).map(([, kind]) => kind)).toEqual([
      "agent.unknown",
      "agent.thought",
      "agent.thought",
      "agent.unknown",
      "agent.thought",
      "agent.unknown",
    ]);
    expect(await storedSeqs(task)).toEqual([1, 2, 3, 4, 5, 6].map((n) => [n, n]));
  });

  it("keeps the effects of the events around the refused one, and none of the refused one's", async () => {
    const task = await newTask("running");
    const replies = await ingest(
      ours,
      frame(
        runnerEvent(task, 1, { kind: "turn.started", turnId }),
        runnerEvent(task, 2, poison("seg-bad")),
        runnerEvent(task, 3, { kind: "turn.ended", turnId, stopReason: "end_turn" }),
      ),
    );
    expect(replies).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 3 }]);
    expect(await test.db.turn.findFirstOrThrow({ where: { sessionId: task.sessionId } })).toMatchObject({ ordinal: 1, startSeq: 1, stopReason: "end_turn" });
  });

  it("does not hold up another session in the same frame", async () => {
    const bad = await newTask();
    const good = await newTask();
    const replies = await ingest(
      ours,
      frame(runnerEvent(bad, 1, poison("s1")), runnerEvent(good, 1, thought("a")), runnerEvent(good, 2, thought("b")), runnerEvent(bad, 2, thought("c"))),
    );
    expect(replies).toHaveLength(2);
    expect(replies).toContainEqual({ type: "ack", sessionId: bad.sessionId, upTo: 2 });
    expect(replies).toContainEqual({ type: "ack", sessionId: good.sessionId, upTo: 2 });
    expect(await storedEvents(good)).toEqual([
      [1, "agent.thought"],
      [2, "agent.thought"],
    ]);
    expect(await storedEvents(bad)).toEqual([
      [1, "agent.unknown"],
      [2, "agent.thought"],
    ]);
  });

  it("still refuses a stale lease the plain way when the batch has a poison event", async () => {
    const task = await newTask();
    await test.db.task.update({ where: { id: task.taskId }, data: { leaseEpoch: 2 } });
    const replies = await ingest(ours, frame(runnerEvent(task, 1, poison("s1"))));
    expect(replies).toEqual([expect.objectContaining({ type: "error", code: "stale-lease", currentEpoch: 2 })]);
    expect(await storedEvents(task)).toEqual([]);
  });

  it("skips the event and says so when not even the placeholder can be stored", async () => {
    const task = await newTask();
    // The table now refuses the placeholder's kind too. NOT VALID: the rows already there are left alone.
    await test.db.$executeRaw`ALTER TABLE "event" ADD CONSTRAINT "event_refuse_test" CHECK ("kind" <> 'agent.unknown' AND "payload"->>'text' IS DISTINCT FROM 'poison') NOT VALID`;
    try {
      records.length = 0;
      const replies = await ingest(
        ours,
        frame(runnerEvent(task, 1, thought("a")), runnerEvent(task, 2, message("seg-p", "poison")), runnerEvent(task, 3, thought("c"))),
      );
      expect(replies).toHaveLength(2);
      expect(replies).toContainEqual({ type: "ack", sessionId: task.sessionId, upTo: 3 });
      expect(replies).toContainEqual(
        expect.objectContaining({ type: "error", code: "event-rejected", sessionId: task.sessionId, sessionSeq: 2 }),
      );
      // Event 2 has no row, and its number is spent: the cursor is past it.
      expect(await storedEvents(task)).toEqual([
        [1, "agent.thought"],
        [3, "agent.thought"],
      ]);
      expect((await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).ingestedSeq).toBe(3);
      expect(records.some((record) => record.message === "ingest.event-skipped")).toBe(true);
      expect(JSON.stringify(records)).not.toContain("poison");
      // Nothing is asked for again.
      expect(await ingest(ours, frame(runnerEvent(task, 2, message("seg-p", "poison")), runnerEvent(task, 3, thought("c"))))).toEqual([
        { type: "ack", sessionId: task.sessionId, upTo: 3 },
      ]);
      expect(await ingest(ours, frame(runnerEvent(task, 4, thought("d"))))).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 4 }]);
    } finally {
      await test.db.$executeRaw`ALTER TABLE "event" DROP CONSTRAINT "event_refuse_test"`;
    }
  });

  it("throws on a failure that is not the data's, so the runner reconnects and resends", async () => {
    const task = await newTask("running");
    const failing = createIngest({
      db: test.db,
      jobs: { enqueueInTx: () => Promise.reject(new Error("the queue is gone")) },
      notices: postgresChangeNotices,
      clock: systemClock,
      liveText,
      logger: createLogger((record) => records.push(record)),
    });
    await expect(failing(ours, frame(runnerEvent(task, 1, { kind: "session.ended", outcome: "without-changes", repos: [] })))).rejects.toThrow(
      "the queue is gone",
    );
    expect(await storedEvents(task)).toEqual([]);
  });

  it("does not close the socket or loop: the poison batch is acked once, and the next batch flows", async () => {
    const harness = await startGateway(test.db, test.url, { hooks: { ingest, liveText: liveText.write } });
    try {
      const runner = await registerPersonal(harness, test.db, fixture.a.member);
      const task = await seedLeasedTask(test.db, { runnerId: runner.runnerId, organizationId: fixture.a.organization.id }, fixture.a.openProject.id);
      const peer = await connect(harness, runner);
      await peer.next("welcome");
      records.length = 0;
      peer.send(frame(runnerEvent(task, 1, thought("a")), runnerEvent(task, 2, poison("seg-bad"))));
      expect(await peer.next("ack")).toEqual({ type: "ack", sessionId: task.sessionId, upTo: 2 });
      peer.send(frame(runnerEvent(task, 3, thought("c"))));
      expect(await peer.next("ack")).toEqual({ type: "ack", sessionId: task.sessionId, upTo: 3 });
      const state = await Promise.race([peer.closed.then(() => "closed"), new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve("open");
          }, 300);
        })]);
      expect(state).toBe("open");
      expect(await storedEvents(task)).toEqual([
        [1, "agent.thought"],
        [2, "agent.unknown"],
        [3, "agent.thought"],
      ]);
      peer.close();
    } finally {
      await harness.stop();
    }
  });
});

describe("live text", () => {
  it("is shown, then deleted when its message commits, and never stored as an event", async () => {
    const task = await newTask("running");
    const segmentId = segmentIdSchema.parse("seg-live");
    const live = (offset: number, text: string) => ({
      type: "live-text" as const,
      frames: [{ taskId: task.taskId, sessionId: task.sessionId, turnId, segmentId, kind: "message" as const, offset, text }],
    });
    const rows = async () =>
      z
        .array(z.object({ text: z.string() }))
        .parse(await test.db.$queryRaw<readonly unknown[]>`SELECT "text" FROM "ostra_live"."live_text" WHERE "taskId" = ${task.taskId}`);
    await liveText.write(ours, live(0, "Hel"));
    await liveText.write(ours, live(3, "lo"));
    // A frame whose offset doesn't match is dropped.
    await liveText.write(ours, live(99, "??"));
    await liveText.flush();
    expect(await rows()).toEqual([{ text: "Hello" }]);
    expect(await test.db.event.count({ where: { taskId: task.taskId } })).toBe(0);

    await ingest(ours, frame(runnerEvent(task, 1, message("seg-live", "Hello, world."))));
    expect(await rows()).toEqual([]);
    // A late partial for the completed segment doesn't bring it back.
    await liveText.write(ours, live(0, "Hello, wor"));
    await liveText.flush();
    expect(await rows()).toEqual([]);

    // Another organization's runner can't write partial text into our task.
    await liveText.write(theirs, {
      type: "live-text",
      frames: [{ taskId: task.taskId, sessionId: task.sessionId, turnId, segmentId: segmentIdSchema.parse("seg-2"), kind: "message", offset: 0, text: "spoof" }],
    });
    await liveText.flush();
    expect(await rows()).toEqual([]);
  });
});

describe("the task grace", () => {
  it("starts on a disconnect and is cancelled by a reconnect", async () => {
    const task = await newTask("running");
    const payload = { organizationId: task.organizationId, taskId: task.taskId, leaseEpoch: task.leaseEpoch };
    await test.db.$transaction((tx) => startGraceInTx(graceDeps, tx, ours));
    expect((await jobs.find("task.grace", payload)).map((job) => job.state)).toEqual(["created"]);
    expect(await test.db.event.findFirst({ where: { taskId: task.taskId, kind: "runner.lost" } })).not.toBeNull();
    await test.db.$transaction((tx) => cancelGraceInTx(graceDeps, tx, ours));
    expect((await jobs.find("task.grace", payload)).map((job) => job.state)).toEqual(["cancelled"]);
    expect(await test.db.event.findFirst({ where: { taskId: task.taskId, kind: "runner.connected" } })).not.toBeNull();
  });

  it("when it ends with the runner gone: the lease ends, the epoch goes up, the task stops and a stop command waits", async () => {
    const task = await newTask("running");
    await test.db.session.update({ where: { id: task.sessionId }, data: { state: "running" } });
    const outcome = await test.db.$transaction(async (tx) => {
      const row = await lockTask(tx, task.organizationId, task.taskId);
      if (row === null) {
        throw new Error("no task");
      }
      return endGraceInTx(graceDeps, tx, row, { organizationId: task.organizationId, taskId: task.taskId, leaseEpoch: task.leaseEpoch });
    });
    expect(outcome).toBe("stopped");
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "stopped", stoppedReason: "runner_lost", leaseEpoch: 2 });
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "ended", endReason: "grace-expired" });
    const stop = await test.db.command.findFirstOrThrow({ where: { taskId: task.taskId, kind: "stop" } });
    expect(stop.body).toEqual({ taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: 1, reason: "grace-expired" });
    expect(stop.runnerId).toBe(ours.runnerId);
    // The runner's late events are refused.
    const late = await ingest(ours, frame(runnerEvent(task, 1, thought("late"))));
    expect(late).toEqual([expect.objectContaining({ code: "stale-lease", currentEpoch: 2 })]);
  });

  it("does nothing when the runner is back", async () => {
    const task = await newTask("running");
    await test.db.runnerPresence.upsert({
      where: { runnerId: ours.runnerId },
      create: { runnerId: ours.runnerId, organizationId: ours.organizationId, replicaId: "r", connectionEpoch: 1, carrier: "websocket", minor: 0 },
      update: { disconnectedAt: null },
    });
    const outcome = await test.db.$transaction(async (tx) => {
      const row = await lockTask(tx, task.organizationId, task.taskId);
      if (row === null) {
        throw new Error("no task");
      }
      return endGraceInTx(graceDeps, tx, row, { organizationId: task.organizationId, taskId: task.taskId, leaseEpoch: task.leaseEpoch });
    });
    expect(outcome).toBe("runner-back");
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).leaseEpoch).toBe(1);
    await test.db.runnerPresence.delete({ where: { runnerId: ours.runnerId } });
  });

  it("F-045: a grace and ingests at the same moment never store a row behind the fence", async () => {
    const task = await newTask("running");
    let fenceSeq = -1;
    const batches = Array.from({ length: 12 }, (_unused, index) => index);
    const results = await Promise.all([
      ...batches.map(async (index) => {
        await new Promise((resolve) => setTimeout(resolve, index * 3));
        // Each batch carries one event; resends of what's saved are fine, gaps get resendFrom.
        const replies: readonly DownFrame[] = await ingest(ours, frame(runnerEvent(task, index + 1, thought(`n${String(index)}`))));
        return replies;
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        await test.db.$transaction(async (tx) => {
          const row = await lockTask(tx, task.organizationId, task.taskId);
          if (row === null) {
            throw new Error("no task");
          }
          fenceSeq = row.eventSeq;
          await endGraceInTx(graceDeps, tx, row, { organizationId: task.organizationId, taskId: task.taskId, leaseEpoch: task.leaseEpoch });
        });
        return [];
      })(),
    ]);
    expect(fenceSeq).toBeGreaterThanOrEqual(0);
    const stored = await test.db.event.findMany({ where: { taskId: task.taskId, leaseEpoch: 1 }, select: { seq: true } });
    // Nothing with the old epoch was stored after the grace raised it.
    expect(Math.max(0, ...stored.map((row) => row.seq))).toBeLessThanOrEqual(fenceSeq);
    expect(stored).toHaveLength(fenceSeq);
    const flat = results.flat();
    expect(flat.some((reply) => reply.type === "error" && reply.code === "stale-lease")).toBe(true);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).leaseEpoch).toBe(2);
  });
});

describe("through the gateway", () => {
  it("acks an events frame after it committed", async () => {
    const harness = await startGateway(test.db, test.url, {
      hooks: { ingest, liveText: liveText.write },
    });
    try {
      const runner = await registerPersonal(harness, test.db, fixture.a.member);
      const task = await seedLeasedTask(test.db, { runnerId: runner.runnerId, organizationId: fixture.a.organization.id }, fixture.a.openProject.id);
      const peer = await connect(harness, runner);
      await peer.next("welcome");
      peer.send(frame(runnerEvent(task, 1, thought("a")), runnerEvent(task, 2, thought("b"))));
      expect(await peer.next("ack")).toEqual({ type: "ack", sessionId: task.sessionId, upTo: 2 });
      expect(await test.db.event.count({ where: { taskId: task.taskId } })).toBe(2);
      peer.close();
    } finally {
      await harness.stop();
    }
  });
});
