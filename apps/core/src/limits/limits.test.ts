import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { Prisma } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { modelTokenPrices, postgresChangeNotices, postgresCommandOutbox, priceTokens, spendCapReached, systemClock } from "@ostra/domain";
import type { Clock, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { leaseEpochSchema, modelIdSchema, providerIdSchema, sessionIdSchema, stopBodySchema, taskSpecSchema, turnIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { buildTaskSpec } from "../dispatch/task-spec.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { fanoutChangesOf } from "../testing/notify.ts";
import { acceptedTask, jobContext } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { seedOnlineRunner, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { ensureStallSweepSchedule, maxDurationHandler, stallSweepHandler, sweepStalledSessions } from "./limits.ts";
import type { LimitDeps } from "./limits.ts";

// Ticket 19 (F-068): the maximum duration and the stall on the server, with a fake clock; usage
// priced on its four kinds and summed across sessions; the spend cap the runner reports.

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
const STALL_MS = 10 * 60_000;

/** A clock that runs `offsetMs` ahead of the real one. */
const clockAhead = (offsetMs: number): Clock => ({ now: () => Date.now() + offsetMs });

const limitDeps = (clock: Clock): LimitDeps => ({
  db: test.db,
  jobs,
  outbox: postgresCommandOutbox,
  notices: postgresChangeNotices,
  clock,
  logger,
  timers,
  stallMs: STALL_MS,
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
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const runningTask = async (target: "ours" | "theirs" = "ours"): Promise<DrivenTask> => {
  const task =
    target === "ours"
      ? await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner)
      : await acceptedTask({ db: test.db, jobs, ingest, logger }, otherWorld, fixture.b.admin, otherRunner);
  await task.send({ kind: "turn.started", turnId });
  return task;
};

const sessionRef = (task: DrivenTask) => ({ organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId });

const stopCommands = async (task: DrivenTask) =>
  (await test.db.command.findMany({ where: { taskId: task.taskId, kind: "stop" }, orderBy: { seq: "asc" } })).map((row) => stopBodySchema.parse(row.body));

const outcomeOf = async (task: DrivenTask) => {
  const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const session = await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } });
  return { task: row.state, reason: row.needsYouReason, session: session.state, limit: session.limitReached };
};

describe("the maximum duration (F-068)", () => {
  it("fires once, stops the session as runaway, and never acts after the session ended", async () => {
    const theirs = await runningTask("theirs");
    const task = await runningTask();
    expect(await jobs.find("session.max-duration", sessionRef(task))).toEqual([expect.objectContaining({ state: "created" })]);
    const handler = maxDurationHandler(limitDeps(clockAhead(120 * 60_000)));
    await handler(jobContext("session.max-duration", sessionRef(task), logger));
    expect(await outcomeOf(task)).toEqual({ task: "needs_you", reason: "stalled", session: "stopped", limit: "max_duration" });
    expect(await stopCommands(task)).toEqual([expect.objectContaining({ reason: "runaway", sessionId: task.sessionId })]);
    // Core recorded the limit as its own event: no session number.
    const event = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.limit_reached" } });
    expect(event).toMatchObject({ sessionSeq: null, payload: { kind: "session.limit_reached", limit: "max-duration", observed: 120 } });
    const stalledItem = await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId, reason: "stalled" } });
    expect(stalledItem).toMatchObject({ audience: "driver", state: "open" });
    // F-036: the item's creation enqueued its fan-out, once, however often the job ran.
    expect(await fanoutChangesOf(test.db, stalledItem.id)).toEqual(["created"]);
    // Its timer was cancelled with it; running the job again does nothing more.
    expect((await jobs.find("session.max-duration", sessionRef(task))).every((job) => job.state === "cancelled")).toBe(true);
    await handler(jobContext("session.max-duration", sessionRef(task), logger));
    expect(await stopCommands(task)).toHaveLength(1);
    expect(await test.db.needsYouItem.count({ where: { taskId: task.taskId } })).toBe(1);
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "session.limit_reached" } })).toBe(1);
    // Another organization's session is left alone.
    expect(await outcomeOf(theirs)).toMatchObject({ task: "running", session: "running", limit: null });
    expect(await stopCommands(theirs)).toHaveLength(0);
  });

  it("leaves nothing behind when the session ends first: the job is cancelled, and a late run is a no-op", async () => {
    const task = await runningTask();
    await task.send({ kind: "session.crashed", error: "the agent exited", cause: "agent_exited" });
    expect((await jobs.find("session.max-duration", sessionRef(task))).map((job) => job.state)).toEqual(["cancelled"]);
    await maxDurationHandler(limitDeps(clockAhead(120 * 60_000)))(jobContext("session.max-duration", sessionRef(task), logger));
    expect(await stopCommands(task)).toHaveLength(0);
    expect(await outcomeOf(task)).toMatchObject({ task: "needs_you", reason: "crashed", session: "crashed", limit: null });
  });

  it("leaves an idle session for the idle timer, and the next turn gets a fresh window", async () => {
    const task = await runningTask();
    await task.send({ kind: "turn.ended", turnId, stopReason: "end_turn" });
    await maxDurationHandler(limitDeps(clockAhead(120 * 60_000)))(jobContext("session.max-duration", sessionRef(task), logger));
    expect(await outcomeOf(task)).toMatchObject({ session: "idle", limit: null });
    await jobs.cancelInTx(null, "session.max-duration", sessionRef(task));
    await task.send({ kind: "turn.started", turnId });
    expect((await jobs.find("session.max-duration", sessionRef(task))).at(-1)).toMatchObject({ state: "created" });
  });
});

describe("the stall sweep (F-068)", () => {
  /** Moves a session's stored events `agoMs` into the past, as if its agent went silent then. */
  const silentFor = async (task: DrivenTask, agoMs: number): Promise<void> => {
    await test.db.event.updateMany({ where: { sessionId: task.sessionId }, data: { createdAt: new Date(Date.now() - agoMs) } });
  };

  it("stops a silent session within one minute of the limit, and leaves a waiting one and a recent one alone", async () => {
    const theirs = await runningTask("theirs");
    const silent = await runningTask();
    const edge = await runningTask();
    const waiting = await runningTask();
    const recent = await runningTask();
    await silentFor(silent, STALL_MS + 30_000);
    await silentFor(edge, STALL_MS - 5_000);
    await silentFor(waiting, STALL_MS + 30_000);
    await test.db.approval.create({
      data: {
        organizationId: waiting.organizationId,
        projectId: world.projectId,
        taskId: waiting.taskId,
        sessionId: waiting.sessionId,
        toolCallId: "call-1",
        options: [],
      },
    });
    await sweepStalledSessions(limitDeps(clockAhead(0)));
    expect(await outcomeOf(silent)).toEqual({ task: "needs_you", reason: "stalled", session: "stopped", limit: "stall" });
    expect(await stopCommands(silent)).toEqual([expect.objectContaining({ reason: "runaway" })]);
    expect(await test.db.event.findFirstOrThrow({ where: { taskId: silent.taskId, kind: "session.limit_reached" } })).toMatchObject({
      payload: { kind: "session.limit_reached", limit: "stall", observed: 11 },
    });
    // Just under the limit, it runs on; the next minute's tick stops it.
    expect(await outcomeOf(edge)).toMatchObject({ session: "running", limit: null });
    await sweepStalledSessions(limitDeps(clockAhead(60_000)));
    expect(await outcomeOf(edge)).toMatchObject({ task: "needs_you", session: "stopped", limit: "stall" });
    // A turn that waits on a person isn't a stall; a session that spoke just now isn't either.
    expect(await outcomeOf(waiting)).toMatchObject({ task: "running", session: "running", limit: null });
    expect(await outcomeOf(recent)).toMatchObject({ task: "running", session: "running", limit: null });
    expect(await stopCommands(waiting)).toHaveLength(0);
    // The sweep run again stops nothing twice.
    await sweepStalledSessions(limitDeps(clockAhead(60_000)));
    expect(await stopCommands(silent)).toHaveLength(1);
    expect(await test.db.needsYouItem.count({ where: { taskId: silent.taskId } })).toBe(1);
    // Another organization's session is judged by its own events only.
    expect(await outcomeOf(theirs)).toMatchObject({ task: "running", session: "running", limit: null });
  });

  it("F-068/c3: core sweeps its own tables once a minute, so a session silent for 10 minutes stops within 10 to 11", async () => {
    // The schedule core starts with: one tick a minute, one slot a minute however many replicas run.
    await ensureStallSweepSchedule(jobs);
    const schedules = z
      .array(z.object({ key: z.string(), cron: z.string(), options: z.looseObject({ singletonSeconds: z.number() }) }))
      .parse(await test.db.$queryRaw`SELECT key, cron, options FROM pgboss.schedule WHERE name = 'session.stall-sweep'`);
    expect(schedules.map((row) => [row.key, row.cron, row.options.singletonSeconds])).toEqual([["every-minute", "* * * * *", 60]]);
    // Starting again keeps the one schedule.
    await ensureStallSweepSchedule(jobs);
    expect(z.array(z.unknown()).parse(await test.db.$queryRaw`SELECT 1 FROM pgboss.schedule WHERE name = 'session.stall-sweep'`)).toHaveLength(1);

    // The handler that tick runs reads the session's last stored event: 9.5 minutes is no stall yet.
    const task = await runningTask();
    await silentFor(task, STALL_MS - 30_000);
    await stallSweepHandler(limitDeps(clockAhead(0)))(jobContext("session.stall-sweep", {}, logger));
    expect(await outcomeOf(task)).toMatchObject({ task: "running", session: "running", limit: null });
    // The next minute's tick finds it 10.5 minutes silent, and stops it: within 10 to 11.
    await stallSweepHandler(limitDeps(clockAhead(60_000)))(jobContext("session.stall-sweep", {}, logger));
    expect(await outcomeOf(task)).toEqual({ task: "needs_you", reason: "stalled", session: "stopped", limit: "stall" });
    const reached = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.limit_reached" } });
    const observed = z.looseObject({ limit: z.literal("stall"), observed: z.number() }).parse(reached.payload).observed;
    expect(observed).toBeGreaterThanOrEqual(10);
    expect(observed).toBeLessThanOrEqual(11);
    expect(await stopCommands(task)).toEqual([expect.objectContaining({ reason: "runaway", sessionId: task.sessionId })]);
  });
});

describe("spend (F-068, Q163)", () => {
  const usage = (modelId: string, tokens: { input: number; output: number; read: number; write: number }) => ({
    kind: "usage.recorded" as const,
    providerId: providerIdSchema.parse(world.providerId),
    modelId: modelIdSchema.parse(modelId),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.read,
    cacheWriteTokens: tokens.write,
    estimated: false,
  });

  it("prices usage on all four kinds and sums it across the task's sessions", async () => {
    const profile = await test.db.agentProfile.findUniqueOrThrow({ where: { id: world.profileId } });
    const modelId = profile.modelId ?? "";
    await test.db.model.update({
      where: { id: modelId },
      data: {
        inputPricePerMTok: new Prisma.Decimal(3),
        outputPricePerMTok: new Prisma.Decimal(15),
        cacheReadPricePerMTok: new Prisma.Decimal("0.3"),
        cacheWritePricePerMTok: new Prisma.Decimal("3.75"),
      },
    });
    try {
      const model = await test.db.model.findUniqueOrThrow({ where: { id: modelId } });
      const prices = modelTokenPrices(model);
      expect(prices).toEqual({ inputPerMTok: 3_000_000, outputPerMTok: 15_000_000, cacheReadPerMTok: 300_000, cacheWritePerMTok: 3_750_000 });
      const task = await runningTask();
      // 1M of each kind: 3 + 15 + 0.30 + 3.75 USD.
      await task.send(usage(modelId, { input: 1_000_000, output: 1_000_000, read: 1_000_000, write: 1_000_000 }));
      const first = 22_050_000;
      expect((await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).spentMicroUsd).toBe(first);
      expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).spentMicroUsd).toBe(first);
      // A second session of the same task (a reopen) adds to the task's total.
      await test.db.session.update({ where: { id: task.sessionId }, data: { state: "ended", outcome: "with_changes", endedAt: new Date() } });
      const second = await test.db.session.create({
        data: {
          organizationId: task.organizationId,
          projectId: world.projectId,
          taskId: task.taskId,
          agentProfileId: world.profileId,
          origin: "restored",
          state: "running",
          // What its start recorded (F-135): the provider and model row it runs on.
          providerId: world.providerId,
          modelId,
        },
      });
      const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
      await ingest(runner, {
        type: "events",
        events: [{ sessionId: sessionIdSchema.parse(second.id), sessionSeq: 1, leaseEpoch, at: Date.now(), event: usage(modelId, { input: 1000, output: 0, read: 0, write: 0 }) }],
      });
      expect((await test.db.session.findUniqueOrThrow({ where: { id: second.id } })).spentMicroUsd).toBe(3000);
      expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).spentMicroUsd).toBe(first + 3000);
      // The spec carries what the task spent, the cap and the prices.
      const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, state: "active" } });
      await test.db.session.update({ where: { id: second.id }, data: { boxId: lease.boxId } });
      const built = await buildTaskSpec(
        { db: test.db, codeHost, secretStore, settings: { idleMinutes: 15, spendCap: { capMicroUsd: 25_000_000, capTokens: 10_000_000 } } },
        { taskId: task.taskId, runnerId: runner.runnerId, leaseEpoch: leaseEpochSchema.parse(lease.epoch) },
      );
      expect(built.ok).toBe(true);
      if (built.ok) {
        expect(taskSpecSchema.parse(built.spec).limits).toEqual({
          turnMaxMinutes: 120,
          idleMinutes: 15,
          spendCap: { capMicroUsd: 25_000_000, spentMicroUsd: first + 3000, prices },
        });
      }
    } finally {
      await test.db.model.update({
        where: { id: modelId },
        data: { inputPricePerMTok: null, outputPricePerMTok: null, cacheReadPricePerMTok: null, cacheWritePricePerMTok: null },
      });
    }
  });

  it("counts a model with no price in tokens, and prices an unknown cache price at the input price", async () => {
    const task = await runningTask();
    const profile = await test.db.agentProfile.findUniqueOrThrow({ where: { id: world.profileId } });
    await task.send(usage(profile.modelId ?? "", { input: 100, output: 200, read: 300, write: 400 }));
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).spentMicroUsd).toBe(0);
    const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, state: "active" } });
    const built = await buildTaskSpec(
      { db: test.db, codeHost, secretStore, settings: { idleMinutes: 15, spendCap: { capMicroUsd: 25_000_000, capTokens: 10_000_000 } } },
      { taskId: task.taskId, runnerId: runner.runnerId, leaseEpoch: leaseEpochSchema.parse(lease.epoch) },
    );
    expect(built.ok && built.spec.limits.spendCap).toEqual({ capTokens: 10_000_000, spentTokens: 1000 });
    const half = modelTokenPrices({ inputPricePerMTok: new Prisma.Decimal(2), outputPricePerMTok: new Prisma.Decimal(8), cacheReadPricePerMTok: null, cacheWritePricePerMTok: null });
    expect(half).toEqual({ inputPerMTok: 2_000_000, outputPerMTok: 8_000_000, cacheReadPerMTok: 2_000_000, cacheWritePerMTok: 2_000_000 });
    expect(modelTokenPrices({ inputPricePerMTok: new Prisma.Decimal(2), outputPricePerMTok: null, cacheReadPricePerMTok: null, cacheWritePricePerMTok: null })).toBeNull();
    // A tiny call never rounds to nothing.
    expect(half === null ? 0 : priceTokens(half, { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(2);
    expect(spendCapReached({ capTokens: 1000, spentTokens: 1000 })).toBe(true);
    expect(spendCapReached({ capMicroUsd: 10, spentMicroUsd: 9, prices: { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 1, cacheWritePerMTok: 1 } })).toBe(false);
  });

  it("stops at the runner's spend cap with the spend_cap reason", async () => {
    const task = await runningTask();
    await task.send({ kind: "session.limit_reached", limit: "spend-cap", observed: 25_000_000 });
    expect(await outcomeOf(task)).toEqual({ task: "needs_you", reason: "spend_cap", session: "stopped", limit: "spend_cap" });
    expect(await stopCommands(task)).toEqual([expect.objectContaining({ reason: "spend-cap" })]);
    const capItem = await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId, reason: "spend_cap" } });
    expect(capItem).toMatchObject({ audience: "driver" });
    expect(await fanoutChangesOf(test.db, capItem.id)).toEqual(["created"]);
    // The runner sent the event: core adds none of its own.
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "session.limit_reached", sessionSeq: null } })).toBe(0);
  });
});
