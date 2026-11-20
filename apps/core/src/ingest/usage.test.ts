import { createLogger } from "@ostra/adapter-sdk";
import { Prisma } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { modelTokenPrices, postgresChangeNotices, postgresCommandOutbox, priceTokens, readTaskUsage, systemClock } from "@ostra/domain";
import type { SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { modelIdSchema, organizationIdSchema, providerIdSchema, sessionIdSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "./ingest.ts";
import type { Ingest } from "./ingest.ts";
import { createLiveTextWriter } from "./live-text.ts";
import type { LiveTextWriter } from "./live-text.ts";
import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { acceptedTask } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { seedOnlineRunner, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

// Ticket 28 (F-084, ADR 0042, Q163): usage per turn and per task. Ingest keeps each turn's four
// token kinds, spend and agent time as `usage.recorded` and the turn's end arrive; the read gives a
// task's totals and its turns in one query. The cases drive a task through core's real ingest, with
// the events at times of the test's choosing, against a real database.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let otherWorld: World;
let ingest: Ingest;
let liveText: LiveTextWriter;
let runner: RunnerRef;
let otherRunner: RunnerRef;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const logger = createLogger(() => undefined);
const T0 = Date.UTC(2026, 10, 19, 9, 0, 0);

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  otherWorld = await seedWorld(test.db, { codeHost, secretStore }, fixture.b.organization.id, fixture.b.project.id, { fullName: "ostra-test/other" });
  const timers: SessionTimers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
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

const PRICES = {
  inputPricePerMTok: new Prisma.Decimal(3),
  outputPricePerMTok: new Prisma.Decimal(15),
  cacheReadPricePerMTok: new Prisma.Decimal("0.3"),
  cacheWritePricePerMTok: new Prisma.Decimal("3.75"),
};

const modelOf = async (target: World): Promise<string> => (await test.db.agentProfile.findUniqueOrThrow({ where: { id: target.profileId } })).modelId ?? "";

const setPrices = async (modelId: string, priced: boolean): Promise<void> => {
  await test.db.model.update({
    where: { id: modelId },
    data: priced ? PRICES : { inputPricePerMTok: null, outputPricePerMTok: null, cacheReadPricePerMTok: null, cacheWritePricePerMTok: null },
  });
};

type Tokens = { readonly input: number; readonly output: number; readonly read: number; readonly write: number };

const usage = (target: World, modelId: string, tokens: Tokens, estimated = false): TaskEvent => ({
  kind: "usage.recorded",
  providerId: providerIdSchema.parse(target.providerId),
  modelId: modelIdSchema.parse(modelId),
  inputTokens: tokens.input,
  outputTokens: tokens.output,
  cacheReadTokens: tokens.read,
  cacheWriteTokens: tokens.write,
  estimated,
});

const turnStarted = (n: number): TaskEvent => ({ kind: "turn.started", turnId: turnIdSchema.parse(`turn-${String(n)}`) });
const turnEnded = (n: number): TaskEvent => ({ kind: "turn.ended", turnId: turnIdSchema.parse(`turn-${String(n)}`), stopReason: "end_turn" });

/** Sends events of the task's first session at a time of the test's choosing. */
const sendAt = async (task: DrivenTask, at: number, ...events: TaskEvent[]): Promise<void> => {
  const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const replies = await ingest(task.runner, {
    type: "events",
    events: events.map((event) => ({ sessionId: task.sessionId, sessionSeq: task.next(), leaseEpoch, at, event })),
  });
  for (const reply of replies) {
    if (reply.type !== "ack" || reply.resendFrom !== undefined) {
      throw new Error(`the batch wasn't saved: ${JSON.stringify(reply)}`);
    }
  }
};

/** A second session of the same task (a reopen), driven the same way. */
const secondSession = async (task: DrivenTask, target: World) => {
  await test.db.session.update({ where: { id: task.sessionId }, data: { state: "ended", outcome: "with_changes", endedAt: new Date() } });
  const row = await test.db.session.create({
    data: { organizationId: task.organizationId, projectId: target.projectId, taskId: task.taskId, agentProfileId: target.profileId, origin: "restored", state: "running" },
  });
  const sessionId = sessionIdSchema.parse(row.id);
  let seq = 0;
  return async (at: number, ...events: TaskEvent[]): Promise<void> => {
    const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    await ingest(task.runner, {
      type: "events",
      events: events.map((event) => {
        seq += 1;
        return { sessionId, sessionSeq: seq, leaseEpoch, at, event };
      }),
    });
  };
};

const freshTask = async (target: "ours" | "theirs" = "ours"): Promise<DrivenTask> =>
  target === "ours"
    ? acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner)
    : acceptedTask({ db: test.db, jobs, ingest, logger }, otherWorld, fixture.b.admin, otherRunner);

/** The sum of a task's stored `usage.recorded` events, read from the log, as the totals must equal. */
const eventSums = async (taskId: string) => {
  const rows = await test.db.event.findMany({ where: { taskId, kind: "usage.recorded" } });
  const parsed = rows.map((row) =>
    z.looseObject({ inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(), cacheWriteTokens: z.number(), estimated: z.boolean() }).parse(row.payload),
  );
  return {
    count: parsed.length,
    inputTokens: parsed.reduce((sum, event) => sum + event.inputTokens, 0),
    outputTokens: parsed.reduce((sum, event) => sum + event.outputTokens, 0),
    cacheReadTokens: parsed.reduce((sum, event) => sum + event.cacheReadTokens, 0),
    cacheWriteTokens: parsed.reduce((sum, event) => sum + event.cacheWriteTokens, 0),
  };
};

const usageOf = async (task: DrivenTask) => {
  const read = await readTaskUsage(test.db, organizationIdSchema.parse(task.organizationId), taskIdSchema.parse(task.taskId));
  if (read === null) throw new Error("no usage");
  return read;
};

describe("usage per turn and per task (F-084)", () => {
  it("F-084/c1,c2: the totals equal the sum of the task's usage events across two sessions, and each turn keeps its own", async () => {
    const modelId = await modelOf(world);
    await setPrices(modelId, true);
    const task = await freshTask();
    // Session one: two turns, three usage events.
    await sendAt(task, T0, turnStarted(1));
    await sendAt(task, T0 + 10_000, usage(world, modelId, { input: 1_000_000, output: 100_000, read: 2_000_000, write: 0 }));
    await sendAt(task, T0 + 40_000, usage(world, modelId, { input: 500_000, output: 50_000, read: 0, write: 400_000 }));
    await sendAt(task, T0 + 90_000, turnEnded(1));
    await sendAt(task, T0 + 500_000, turnStarted(2));
    await sendAt(task, T0 + 520_000, usage(world, modelId, { input: 10_000, output: 2_000, read: 0, write: 0 }));
    await sendAt(task, T0 + 560_000, turnEnded(2));
    // Session two, after a reopen: one turn.
    const second = await secondSession(task, world);
    await second(T0 + 900_000, turnStarted(3));
    await second(T0 + 910_000, usage(world, modelId, { input: 7_000, output: 300, read: 100, write: 50 }));
    await second(T0 + 960_000, turnEnded(3));

    const read = await usageOf(task);
    const sums = await eventSums(task.taskId);
    expect(sums.count).toBe(4);
    expect(read.totals).toMatchObject({
      inputTokens: sums.inputTokens,
      outputTokens: sums.outputTokens,
      cacheReadTokens: sums.cacheReadTokens,
      cacheWriteTokens: sums.cacheWriteTokens,
      estimated: false,
    });
    expect(sums.inputTokens).toBe(1_517_000);
    // Spend: each event priced on its four kinds, then added, as the cap reads it.
    const prices = modelTokenPrices(await test.db.model.findUniqueOrThrow({ where: { id: modelId } }));
    if (prices === null) throw new Error("the model has no price");
    const eventCosts = [
      { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 },
      { inputTokens: 500_000, outputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 400_000 },
      { inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 7_000, outputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 50 },
    ].map((tokens) => priceTokens(prices, tokens));
    // Worked by hand, each kind at its own price per million ($3 in, $15 out, $0.30 cache read,
    // $3.75 cache write), in micro-USD, a part of one rounded up: so a wrong price can't move both sides.
    expect(eventCosts).toEqual([3_000_000 + 1_500_000 + 600_000, 1_500_000 + 750_000 + 1_500_000, 30_000 + 30_000, 25_718]);
    expect(read.totals.spentMicroUsd).toBe(8_935_718);
    expect(read.totals.spentMicroUsd).toBe(eventCosts.reduce((sum, cost) => sum + cost, 0));
    expect(read.totals.spentMicroUsd).toBe((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).spentMicroUsd);

    // The turns: each its own figures, oldest first, across both sessions.
    expect(read.turns.map((turn) => [turn.ordinal, turn.inputTokens, turn.outputTokens, turn.cacheReadTokens, turn.cacheWriteTokens, turn.spentMicroUsd])).toEqual([
      [1, 1_500_000, 150_000, 2_000_000, 400_000, (eventCosts[0] ?? 0) + (eventCosts[1] ?? 0)],
      [2, 10_000, 2_000, 0, 0, eventCosts[2]],
      [1, 7_000, 300, 100, 50, eventCosts[3]],
    ]);
    expect(read.turns.map((turn) => turn.sessionId)).toEqual([task.sessionId, task.sessionId, read.turns[2]?.sessionId]);
    expect(read.turns[2]?.sessionId).not.toBe(task.sessionId);
    await setPrices(modelId, false);
  });

  it("F-084/c1: agent time is each turn's start to its end, and leaves out the time between turns", async () => {
    const task = await freshTask();
    await sendAt(task, T0, turnStarted(1));
    await sendAt(task, T0 + 90_000, turnEnded(1));
    // Nobody works for eight minutes; then a second turn of one minute.
    await sendAt(task, T0 + 570_000, turnStarted(2));
    await sendAt(task, T0 + 630_000, turnEnded(2));
    const read = await usageOf(task);
    expect(read.turns.map((turn) => turn.agentMs)).toEqual([90_000, 60_000]);
    expect(read.totals.agentMs).toBe(150_000);

    // A turn still running has no agent time yet, and adds none to the total.
    await sendAt(task, T0 + 700_000, turnStarted(3));
    const running = await usageOf(task);
    expect(running.turns.map((turn) => turn.agentMs)).toEqual([90_000, 60_000, null]);
    expect(running.turns[2]?.endedAt).toBeNull();
    expect(running.totals.agentMs).toBe(150_000);
  });

  it("F-084/c3: an estimated count marks its turn and the task, and no other turn", async () => {
    const modelId = await modelOf(world);
    const task = await freshTask();
    await sendAt(task, T0, turnStarted(1));
    await sendAt(task, T0 + 1_000, usage(world, modelId, { input: 100, output: 10, read: 0, write: 0 }));
    await sendAt(task, T0 + 5_000, turnEnded(1));
    expect((await usageOf(task)).totals.estimated).toBe(false);
    await sendAt(task, T0 + 10_000, turnStarted(2));
    await sendAt(task, T0 + 11_000, usage(world, modelId, { input: 200, output: 20, read: 0, write: 0 }, true));
    await sendAt(task, T0 + 12_000, usage(world, modelId, { input: 5, output: 5, read: 0, write: 0 }));
    await sendAt(task, T0 + 15_000, turnEnded(2));
    const read = await usageOf(task);
    expect(read.turns.map((turn) => turn.estimated)).toEqual([false, true]);
    expect(read.totals.estimated).toBe(true);
    // The estimate still counts: the figures are tokens as the proxy reckoned them.
    expect(read.totals).toMatchObject({ inputTokens: 305, outputTokens: 35 });
  });

  it("F-084/c1, F-037/c1: a call that ends after its turn, a subagent still working, counts to the task, its session, that turn and the project's day", async () => {
    // OpenCode runs every subagent in the background: the main agent may end its turn while the
    // subagent's calls go on through the key proxy (`context/research/opencode-subagents.md`).
    const modelId = await modelOf(world);
    await setPrices(modelId, true);
    // A day of its own, so the project's rollup holds this task's spend alone.
    const T1 = Date.UTC(2026, 10, 24, 9, 0, 0);
    const day = new Date(Date.UTC(2026, 10, 24));
    const task = await freshTask();
    const inTurn = { input: 100_000, output: 10_000, read: 0, write: 0 };
    const afterTurn = { input: 200_000, output: 20_000, read: 50_000, write: 0 };
    await sendAt(task, T1, turnStarted(1));
    await sendAt(task, T1 + 5_000, usage(world, modelId, inTurn));
    await sendAt(task, T1 + 9_000, turnEnded(1));
    await sendAt(task, T1 + 40_000, usage(world, modelId, afterTurn));

    const prices = modelTokenPrices(await test.db.model.findUniqueOrThrow({ where: { id: modelId } }));
    if (prices === null) throw new Error("the model has no price");
    const cost = (tokens: Tokens): number => priceTokens(prices, { inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.read, cacheWriteTokens: tokens.write });
    const spent = cost(inTurn) + cost(afterTurn);
    const read = await usageOf(task);
    expect(read.totals).toMatchObject({ inputTokens: 300_000, outputTokens: 30_000, cacheReadTokens: 50_000, spentMicroUsd: spent });
    expect(read.turns).toHaveLength(1);
    expect(read.turns[0]).toMatchObject({ inputTokens: 300_000, outputTokens: 30_000, cacheReadTokens: 50_000, spentMicroUsd: spent, agentMs: 9_000 });
    const session = await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } });
    expect({ input: session.inputTokens, spent: session.spentMicroUsd }).toEqual({ input: 300_000, spent });
    // Budgets and Insights read the project's day: the call after the turn is in it.
    const rollup = await test.db.spendDaily.findUniqueOrThrow({ where: { projectId_day_modelId: { projectId: world.projectId, day, modelId } } });
    expect({ input: Number(rollup.inputTokens), read: Number(rollup.cacheReadTokens), spent: Number(rollup.spentMicroUsd) }).toEqual({ input: 300_000, read: 50_000, spent });
    await setPrices(modelId, false);
  });

  it("F-084/c1: a model with no price shows its tokens and no spend", async () => {
    const modelId = await modelOf(world);
    await setPrices(modelId, false);
    const task = await freshTask();
    await sendAt(task, T0, turnStarted(1));
    await sendAt(task, T0 + 1_000, usage(world, modelId, { input: 1_000, output: 500, read: 0, write: 0 }));
    await sendAt(task, T0 + 2_000, turnEnded(1));
    const read = await usageOf(task);
    expect(read.totals).toMatchObject({ inputTokens: 1_000, outputTokens: 500, spentMicroUsd: null });
    expect(read.turns[0]).toMatchObject({ inputTokens: 1_000, outputTokens: 500, spentMicroUsd: null });
    // A task that used nothing yet has a spend of nothing, not an unknown one.
    const quiet = await freshTask();
    expect((await usageOf(quiet)).totals).toMatchObject({ inputTokens: 0, spentMicroUsd: 0, agentMs: 0, estimated: false });
  });

  it("F-084/c1: another organization's usage is invisible, and its own never mixes into ours", async () => {
    const modelId = await modelOf(world);
    const otherModelId = await modelOf(otherWorld);
    const ours = await freshTask();
    const theirs = await freshTask("theirs");
    await sendAt(ours, T0, turnStarted(1));
    await sendAt(ours, T0 + 1_000, usage(world, modelId, { input: 111, output: 11, read: 0, write: 0 }));
    await sendAt(theirs, T0, turnStarted(1));
    await sendAt(theirs, T0 + 1_000, usage(otherWorld, otherModelId, { input: 999, output: 99, read: 0, write: 0 }));
    // Reading our task as the other organization finds nothing; reading theirs as them finds only theirs.
    expect(await readTaskUsage(test.db, organizationIdSchema.parse(fixture.b.organization.id), taskIdSchema.parse(ours.taskId))).toBeNull();
    expect(await readTaskUsage(test.db, organizationIdSchema.parse(fixture.a.organization.id), taskIdSchema.parse(theirs.taskId))).toBeNull();
    expect((await usageOf(ours)).totals).toMatchObject({ inputTokens: 111, outputTokens: 11 });
    expect((await usageOf(theirs)).totals).toMatchObject({ inputTokens: 999, outputTokens: 99 });
  });
});
