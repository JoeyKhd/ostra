import { randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import { Prisma } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  budgetMonthBounds,
  budgetMonthOf,
  budgetMonthStatusInTx,
  checkBudget,
  dispatchTask,
  dispatchWaitFromDb,
  modelTokenPrices,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  priceTokens,
  reopenTask,
  sendMemberMessageInTx,
  stopTask,
  systemClock,
  turnOrigins,
} from "@ostra/domain";
import type { MemberScope, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { budgetIdSchema, clientMessageIdSchema, leaseEpochSchema, memberIdSchema, modelIdSchema, projectIdSchema, providerIdSchema, sessionIdSchema, turnIdSchema } from "@ostra/protocol";
import type { BudgetId, ModelId, ProjectId, TaskEvent, TaskId } from "@ostra/protocol";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RunnerRef } from "../gateway/context.ts";
import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { acceptedTask } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { createIngest } from "./ingest.ts";
import type { Ingest } from "./ingest.ts";
import { createLiveTextWriter } from "./live-text.ts";
import type { LiveTextWriter } from "./live-text.ts";

// Ticket 12 (F-037, ADR 0055): spend rollups and the budget gate. Ingest's pricing of
// `usage.recorded` adds to `SpendDaily` per project, UTC day and model, and enqueues `budget.check`
// when a budget's month crosses a threshold; every turn start calls the gate inside the task's
// lock. The cases drive tasks through core's real ingest, dispatch, reopen and message paths
// against a real database.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let ingest: Ingest;
let liveText: LiveTextWriter;
let runner: RunnerRef;
let scope: MemberScope;
let modelId: ModelId;
let projectId: ProjectId;
let otherProjectId: ProjectId;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const logger = createLogger(() => undefined);

const PRICES = {
  inputPricePerMTok: new Prisma.Decimal(3),
  outputPricePerMTok: new Prisma.Decimal(15),
  cacheReadPricePerMTok: new Prisma.Decimal("0.3"),
  cacheWritePricePerMTok: new Prisma.Decimal("3.75"),
};
const UNPRICED = { inputPricePerMTok: null, outputPricePerMTok: null, cacheReadPricePerMTok: null, cacheWritePricePerMTok: null };

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  const timers: SessionTimers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox, budgetWarnPercent: 80 });
  runner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 50);
  scope = { organizationId: fixture.a.organization.id, memberId: memberIdSchema.parse(fixture.a.member.id), role: "member", projectRoles: new Map() };
  modelId = modelIdSchema.parse((await test.db.agentProfile.findUniqueOrThrow({ where: { id: world.profileId } })).modelId);
  await test.db.model.update({ where: { id: modelId }, data: PRICES });
  projectId = projectIdSchema.parse(world.projectId);
  otherProjectId = projectIdSchema.parse(fixture.a.restrictedProject.id);
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

beforeEach(async () => {
  await test.db.heldTurn.deleteMany({});
  await test.db.budget.deleteMany({});
  await test.db.spendDaily.deleteMany({});
  await test.db.model.update({ where: { id: modelId }, data: PRICES });
});

const organizationId = () => fixture.a.organization.id;

type Tokens = { readonly input: number; readonly output: number; readonly read: number; readonly write: number };

const usage = (tokens: Tokens): TaskEvent => ({
  kind: "usage.recorded",
  providerId: providerIdSchema.parse(world.providerId),
  modelId,
  inputTokens: tokens.input,
  outputTokens: tokens.output,
  cacheReadTokens: tokens.read,
  cacheWriteTokens: tokens.write,
  estimated: false,
});

const turnStarted = (n: number): TaskEvent => ({ kind: "turn.started", turnId: turnIdSchema.parse(`turn-${String(n)}`) });
const turnEnded = (n: number): TaskEvent => ({ kind: "turn.ended", turnId: turnIdSchema.parse(`turn-${String(n)}`), stopReason: "end_turn" });

/** Sends events of the task's first session at a time of the test's choosing. */
const sendAt = async (task: DrivenTask, at: number, ...events: TaskEvent[]): Promise<void> => {
  const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const replies = await ingest(task.runner, { type: "events", events: events.map((event) => ({ sessionId: task.sessionId, sessionSeq: task.next(), leaseEpoch, at, event })) });
  for (const reply of replies) {
    if (reply.type !== "ack" || reply.resendFrom !== undefined) {
      throw new Error(`the batch wasn't saved: ${JSON.stringify(reply)}`);
    }
  }
};

const freshTask = (): Promise<DrivenTask> => acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner);

/** A budget of `usd` dollars: the project's, or the organization's for `null`. */
const setBudget = async (target: ProjectId | null, usd: number): Promise<BudgetId> =>
  budgetIdSchema.parse(
    (await test.db.budget.create({ data: { organizationId: organizationId(), projectId: target, monthlyMicroUsd: BigInt(Math.round(usd * 1_000_000)) } })).id,
  );

/** This month's spend, written as ingest would have: `micro` micro-USD on the project's row for today. */
const seedSpend = async (target: ProjectId, micro: bigint): Promise<void> => {
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  await test.db.spendDaily.upsert({
    where: { projectId_day_modelId: { projectId: target, day, modelId } },
    create: { organizationId: organizationId(), projectId: target, day, modelId, spentMicroUsd: micro },
    update: { spentMicroUsd: { increment: micro } },
  });
};

const gate = (origin: (typeof turnOrigins)[number], target: ProjectId = projectId) =>
  test.db.$transaction((tx) => checkBudget(tx, { organizationId: organizationId(), projectId: target, modelId, origin, now: Date.now() }));

const budgetChecks = async (budgetId: BudgetId) =>
  z
    .array(z.object({ data: z.object({ month: z.string(), threshold: z.string() }) }))
    .parse(await test.db.$queryRaw`SELECT data FROM pgboss.job WHERE name = 'budget.check' AND data->>'budgetId' = ${budgetId} ORDER BY created_on`)
    .map((row) => `${row.data.month}:${row.data.threshold}`);

const dispatchJobs = async (taskId: TaskId): Promise<number> =>
  z.array(z.object({ id: z.string() })).parse(await test.db.$queryRaw`SELECT id::text FROM pgboss.job WHERE name = 'task.dispatch' AND data->>'taskId' = ${taskId}`).length;

const commandsOf = (taskId: TaskId, kind: "steer" | "stop") => test.db.command.count({ where: { taskId, kind } });

const ports = () => ({ jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock });

const message = (taskId: TaskId, text: string) =>
  test.db.$transaction((tx) =>
    sendMemberMessageInTx(ports(), tx, scope, { taskId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text, intent: "message", sender: "driver" }),
  );

const dispatch = async (taskId: TaskId, sessionId: DrivenTask["sessionId"]) => {
  const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: taskId } });
  return test.db.$transaction((tx) =>
    dispatchTask(
      { tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock },
      { organizationId: organizationId(), taskId, sessionId, leaseEpoch: leaseEpochSchema.parse(leaseEpoch + 1) },
    ),
  );
};

describe("the spend rollup (F-037)", () => {
  it("F-037: the rollup equals the sum of the tasks' spend for a month across sessions and a month's end", async () => {
    const first = await freshTask();
    const second = await freshTask();
    const lastOfMonth = Date.UTC(2026, 10, 30, 23, 59, 30);
    const firstOfNext = Date.UTC(2026, 11, 1, 0, 0, 30);
    const a: Tokens = { input: 120_000, output: 8_000, read: 40_000, write: 2_000 };
    const b: Tokens = { input: 3_000, output: 900, read: 0, write: 100 };
    const c: Tokens = { input: 70_000, output: 1_000, read: 5_000, write: 0 };
    await sendAt(first, lastOfMonth - 60_000, turnStarted(1), usage(a));
    await sendAt(second, lastOfMonth, turnStarted(1), usage(b));
    await sendAt(first, firstOfNext, usage(c), turnEnded(1));
    // A second session of the first task (a reopen) adds to the same rows.
    await test.db.session.update({ where: { id: first.sessionId }, data: { state: "ended", outcome: "with_changes", endedAt: new Date() } });
    const reSession = await test.db.session.create({
      data: { organizationId: organizationId(), projectId, taskId: first.taskId, agentProfileId: world.profileId, origin: "restored", state: "running" },
    });
    const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: first.taskId } });
    await ingest(first.runner, { type: "events", events: [{ sessionId: sessionIdSchema.parse(reSession.id), sessionSeq: 1, leaseEpoch, at: firstOfNext + 1000, event: usage(b) }] });

    const prices = modelTokenPrices(PRICES);
    if (prices === null) {
      throw new Error("the test's prices are incomplete");
    }
    const cost = (tokens: Tokens): bigint =>
      BigInt(priceTokens(prices, { inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.read, cacheWriteTokens: tokens.write }));
    const rows = await test.db.spendDaily.findMany({ where: { projectId } });
    const monthSum = (month: string) => {
      const { start, end } = budgetMonthBounds(month);
      return rows.filter((row) => row.day.getTime() >= start && row.day.getTime() < end).reduce((sum, row) => sum + row.spentMicroUsd, 0n);
    };
    expect(monthSum("2026-11")).toBe(cost(a) + cost(b));
    expect(monthSum("2026-12")).toBe(cost(c) + cost(b));
    // The months' rows add up to what the tasks' and sessions' own totals say.
    const tasks = await test.db.task.findMany({ where: { id: { in: [first.taskId, second.taskId] } }, select: { spentMicroUsd: true } });
    expect(monthSum("2026-11") + monthSum("2026-12")).toBe(tasks.reduce((sum, row) => sum + BigInt(row.spentMicroUsd), 0n));
    expect(rows.reduce((sum, row) => sum + row.inputTokens, 0n)).toBe(BigInt(a.input + b.input + c.input + b.input));
    // One row per project, UTC day and model.
    expect(rows.map((row) => row.day.toISOString().slice(0, 10)).sort()).toEqual(["2026-11-30", "2026-12-01"]);
  });

  it("F-037: an unpriced call is counted in unpricedTokens and moves no money", async () => {
    await test.db.model.update({ where: { id: modelId }, data: UNPRICED });
    const task = await freshTask();
    const at = Date.UTC(2026, 10, 19, 10, 0, 0);
    await sendAt(task, at, turnStarted(1), usage({ input: 1_000, output: 200, read: 30, write: 4 }));
    const [row] = await test.db.spendDaily.findMany({ where: { projectId, day: new Date(Date.UTC(2026, 10, 19)) } });
    expect(row?.unpricedTokens).toBe(1_234n);
    expect(row?.spentMicroUsd).toBe(0n);
  });

  it("F-037: a call that crosses the warn share and then 100% enqueues one budget.check each, keyed by budget, month and threshold", async () => {
    const budgetId = await setBudget(projectId, 1);
    const organizationBudget = await setBudget(null, 1000);
    const task = await freshTask();
    const at = Date.UTC(2026, 10, 19, 11, 0, 0);
    // 100k input tokens at $3/MTok is $0.30: 30%, then 90% (past the warn share), then 120%.
    await sendAt(task, at, turnStarted(1), usage({ input: 100_000, output: 0, read: 0, write: 0 }));
    expect(await budgetChecks(budgetId)).toEqual([]);
    await sendAt(task, at + 1, usage({ input: 200_000, output: 0, read: 0, write: 0 }));
    expect(await budgetChecks(budgetId)).toEqual(["2026-11:warn"]);
    await sendAt(task, at + 2, usage({ input: 100_000, output: 0, read: 0, write: 0 }));
    expect(await budgetChecks(budgetId)).toEqual(["2026-11:warn", "2026-11:reached"]);
    // Past 100%, more spend enqueues nothing more; the organization's budget is far from its share.
    await sendAt(task, at + 3, usage({ input: 100_000, output: 0, read: 0, write: 0 }));
    expect(await budgetChecks(budgetId)).toEqual(["2026-11:warn", "2026-11:reached"]);
    expect(await budgetChecks(organizationBudget)).toEqual([]);
    // The overshoot: what was counted after the month passed 100%.
    const status = await test.db.$transaction((tx) => budgetMonthStatusInTx(tx, { organizationId: organizationId(), budgetId, month: "2026-11" }));
    expect(status?.level).toBe("reached");
    expect(status?.overshootMicroUsd).toBe(500_000n);
  });
});

describe("the budget gate (F-037)", () => {
  it.each(["project", "organization"] as const)("F-037: every origin is held at 100%% and passes at 99%% (the %s's budget)", async (scopeOf) => {
    expect(turnOrigins).toContain("automatic-round");
    const budgetId = await setBudget(scopeOf === "project" ? projectId : null, 100);
    await seedSpend(projectId, 99_000_000n);
    for (const origin of turnOrigins) {
      expect(await gate(origin)).toEqual({ kind: "open" });
    }
    await seedSpend(otherProjectId, scopeOf === "project" ? 5_000_000n : 1_000_000n);
    for (const origin of turnOrigins) {
      expect(await gate(origin)).toEqual(
        scopeOf === "project" ? { kind: "open" } : { kind: "held", budgetId, scope: "organization", reason: "reached", origin },
      );
    }
    await seedSpend(projectId, 1_000_000n);
    for (const origin of turnOrigins) {
      expect(await gate(origin)).toEqual({ kind: "held", budgetId, scope: scopeOf, reason: "reached", origin });
    }
  });

  it("F-037: last month's spend counts nothing in this one", async () => {
    await setBudget(projectId, 1);
    const now = new Date();
    await test.db.spendDaily.create({
      data: { organizationId: organizationId(), projectId, day: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 28)), modelId, spentMicroUsd: 9_000_000n },
    });
    expect(await gate("dispatch")).toEqual({ kind: "open" });
    expect(budgetMonthOf(Date.now())).not.toBe(budgetMonthOf(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 28)));
  });

  it("F-037: another project's budget holds nothing here", async () => {
    await setBudget(otherProjectId, 0);
    await seedSpend(otherProjectId, 5_000_000n);
    expect(await gate("message")).toEqual({ kind: "open" });
    const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    const offered = await dispatch(task.taskId, task.sessionId);
    expect(offered.ok).toBe(true);
  });

  it("F-037: a new task stays queued with the dispatch note, and its dispatch offers nothing", async () => {
    await setBudget(projectId, 1);
    await seedSpend(projectId, 1_000_000n);
    const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    const offered = await dispatch(task.taskId, task.sessionId);
    expect(offered).toMatchObject({ ok: false, error: "no-runner", message: "budget-reached" });
    const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(row.state).toBe("queued");
    expect(dispatchWaitFromDb(row.dispatchWait)).toEqual({ code: "budget-reached", scope: "project" });
    expect(await test.db.lease.count({ where: { taskId: task.taskId } })).toBe(0);
  });

  it("F-037: an unpriced model waits only where a budget applies", async () => {
    await test.db.model.update({ where: { id: modelId }, data: UNPRICED });
    const free = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    expect((await dispatch(free.taskId, free.sessionId)).ok).toBe(true);
    await setBudget(null, 1_000_000);
    const held = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    expect(await dispatch(held.taskId, held.sessionId)).toMatchObject({ ok: false, message: "model-unpriced" });
    const row = await test.db.task.findUniqueOrThrow({ where: { id: held.taskId } });
    expect(dispatchWaitFromDb(row.dispatchWait)).toEqual({ code: "model-unpriced" });
    expect(row.dispatchNote).toBe("This model has no price, so the budget can't count it");
  });

  it("F-037: a running turn finishes past 100%, and a steer to it is still delivered", async () => {
    const budgetId = await setBudget(projectId, 1);
    const task = await freshTask();
    await task.send(turnStarted(1), usage({ input: 400_000, output: 0, read: 0, write: 0 }));
    expect((await gate("message")).kind).toBe("held");
    // The member's message joins the turn that's going: delivered, not held.
    const steered = await message(task.taskId, "Also update the README");
    expect(steered).toMatchObject({ ok: true, delivery: "steer" });
    expect(steered.ok && steered.held).toBeFalsy();
    expect(await commandsOf(task.taskId, "steer")).toBe(1);
    // The turn runs on and ends: nothing stopped it.
    await task.send(usage({ input: 10_000, output: 0, read: 0, write: 0 }), turnEnded(1));
    expect(await commandsOf(task.taskId, "stop")).toBe(0);
    const turn = await test.db.turn.findFirstOrThrow({ where: { taskId: task.taskId } });
    expect(turn.stopReason).toBe("end_turn");
    expect((await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).state).toBe("idle");
    expect(await test.db.heldTurn.count({ where: { budgetId } })).toBe(0);
  });

  it("F-037: a held message to an idle session is saved, holds the turn and starts nothing", async () => {
    const budgetId = await setBudget(projectId, 1);
    const task = await freshTask();
    await task.send(turnStarted(1), usage({ input: 400_000, output: 0, read: 0, write: 0 }), turnEnded(1));
    const steersBefore = await commandsOf(task.taskId, "steer");
    const sent = await message(task.taskId, "Now add a test");
    expect(sent).toMatchObject({ ok: true, delivery: "steer", held: true });
    expect(await commandsOf(task.taskId, "steer")).toBe(steersBefore);
    const held = await test.db.heldTurn.findFirstOrThrow({ where: { taskId: task.taskId } });
    expect(held).toMatchObject({ origin: "message", budgetId, releasedAt: null });
    const saved = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "user.message", seq: held.pendingMessageSeq ?? -1 } });
    expect(saved.payload).toMatchObject({ text: "Now add a test", delivery: "queued" });
    const event = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "turn.held" } });
    expect(event.payload).toMatchObject({ kind: "turn.held", origin: "message", budgetId, scope: "project" });
  });

  it("F-037: a reopen past 100% is saved and held, and dispatches nothing", async () => {
    const budgetId = await setBudget(null, 1);
    const task = await freshTask();
    await task.send(turnStarted(1), usage({ input: 400_000, output: 0, read: 0, write: 0 }), turnEnded(1));
    const stopped = await test.db.$transaction((tx) => stopTask({ tx, scope, ...ports() }, { taskId: task.taskId }));
    expect(stopped.ok).toBe(true);
    const dispatchesBefore = await dispatchJobs(task.taskId);
    const reopened = await test.db.$transaction((tx) =>
      reopenTask({ tx, scope, ...ports() }, { taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: "Pick it up again" }),
    );
    expect(reopened).toMatchObject({ ok: true, held: true });
    expect(await dispatchJobs(task.taskId)).toBe(dispatchesBefore);
    const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(row.state).toBe("queued");
    expect(dispatchWaitFromDb(row.dispatchWait)).toEqual({ code: "budget-reached", scope: "organization" });
    const held = await test.db.heldTurn.findFirstOrThrow({ where: { taskId: task.taskId } });
    expect(held).toMatchObject({ origin: "reopen", budgetId, releasedAt: null });
    const saved = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, seq: held.pendingMessageSeq ?? -1 } });
    expect(saved.payload).toMatchObject({ kind: "user.message", text: "Pick it up again", reopen: true });
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "turn.held" } })).toBe(1);
  });
});
