import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import { answerPlan, answerQuestion, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, releaseHeldTurnsInTx, systemClock } from "@ostra/domain";
import type { AnswerDeps, MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { budgetIdSchema, memberIdSchema, questionIdSchema, readMarkedBlocks, turnIdSchema } from "@ostra/protocol";
import type { EventsFrame, PlanEntry, QuestionId, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { profileSpecParts } from "../dispatch/profile-spec.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { runnerEvent, seedLeasedTask, seedRunner } from "../testing/seed.ts";
import type { LeasedTask } from "../testing/seed.ts";
import { createIngest } from "./ingest.ts";
import type { Ingest } from "./ingest.ts";
import { createLiveTextWriter } from "./live-text.ts";
import type { LiveTextWriter } from "./live-text.ts";

// Milestone 3's ticket 18 (F-063, F-024, ADR 0049): plan first and the agent's questions, through
// core's real ingest and the domain's real answers, on a real Postgres. The runner is the test.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let ingest: Ingest;
let liveText: LiveTextWriter;
let ours: RunnerRef;
let theirs: RunnerRef;
let deps: AnswerDeps;
const records: LogRecord[] = [];

const turnId = turnIdSchema.parse("turn-plan");
const entries: PlanEntry[] = [
  { content: "Read config/settings.json", priority: "high", status: "pending" },
  { content: "Add releaseName from the release-names tool", priority: "medium", status: "pending" },
];
const MESSAGE = "I'll add one key and touch nothing else.";
const proposed: TaskEvent = { kind: "plan.proposed", turnId, entries, message: MESSAGE };

const frame = (...events: EventsFrame["events"]): EventsFrame => ({ type: "events", events });

const scopeOf = (member: SeededMember): MemberScope => ({
  organizationId: member.organizationId,
  memberId: memberIdSchema.parse(member.id),
  role: member.role === "admin" ? "admin" : "member",
  projectRoles: new Map(),
});

/** A running task of ours, its turn started, with the member as its driver. */
const runningTask = async (runner: RunnerRef = ours, driver: SeededMember = fixture.a.member, projectId = fixture.a.openProject.id) => {
  const task = await seedLeasedTask(test.db, runner, projectId, { state: "running", creatorMemberId: driver.id });
  let next = 0;
  const seq = () => {
    next += 1;
    return next;
  };
  await ingest(runner, frame(runnerEvent(task, seq(), { kind: "turn.started", turnId, mode: "plan" })));
  return { task, seq };
};

/** A task whose plan turn proposed its plan and ended. */
const planned = async () => {
  const { task, seq } = await runningTask();
  await ingest(ours, frame(runnerEvent(task, seq(), proposed), runnerEvent(task, seq(), { kind: "turn.ended", turnId, stopReason: "end_turn" })));
  return { task, seq };
};

const fanOuts = async (itemId: string, change: string): Promise<number> =>
  z
    .array(z.strictObject({ count: z.bigint() }))
    .parse(
      await test.db.$queryRaw<readonly unknown[]>`
        SELECT count(*)::bigint AS count FROM pgboss.job WHERE name = 'notify.fanout' AND data->>'needsYouItemId' = ${itemId} AND data->>'change' = ${change}`,
    )
    .reduce((sum, row) => sum + Number(row.count), 0);

const commandsOf = async (taskId: string) => [
  ...(await test.db.command.findMany({ where: { taskId }, orderBy: { seq: "asc" }, select: { kind: true, body: true } })),
  ...(await test.db.sidecarCommand.findMany({ where: { taskId }, orderBy: { seq: "asc" }, select: { kind: true, body: true } })),
];

const commandText = (body: unknown): string => z.looseObject({ text: z.string() }).parse(body).text;

const eventsOf = async (taskId: string, kind: string) =>
  (await test.db.event.findMany({ where: { taskId, kind }, orderBy: { seq: "asc" }, select: { payload: true, sessionId: true } })).map((row) => ({ ...row }));

/** The box idled out while the plan or the question waited: no session going, no lease. */
const idleOut = async (task: LeasedTask): Promise<void> => {
  await test.db.session.updateMany({ where: { taskId: task.taskId }, data: { state: "stopped" } });
  await test.db.lease.updateMany({ where: { taskId: task.taskId, state: "active" }, data: { state: "ended", endedAt: new Date(), endReason: "superseded" } });
};

/** The new session's first turn mode, as the spec would carry it for a plan-first profile. */
const firstTurnModeOf = async (taskId: string, sessionId: string) => {
  const task = await test.db.task.findUniqueOrThrow({ where: { id: taskId } });
  const profile = await test.db.agentProfile.create({
    data: { organizationId: task.organizationId, name: `Plan first ${sessionId}`, adapter: "opencode", planFirst: true },
  });
  const parts = await profileSpecParts({ db: test.db }, task, { id: sessionId }, profile);
  return parts.ok ? parts.parts.firstTurnMode : null;
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  const logger = createLogger((record) => records.push(record));
  liveText = createLiveTextWriter({ db: test.db, logger, intervalMs: 50 });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, outbox: postgresCommandOutbox });
  deps = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock };
  ours = await seedRunner(test.db, fixture.a.organization.id, fixture.a.member.id);
  theirs = await seedRunner(test.db, fixture.b.organization.id, fixture.b.admin.id);
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("plan first", () => {
  it("F-037/c4: a plan's approval past 100% of the budget holds the build turn, and the release sends the answer", async () => {
    const { task } = await planned();
    const organizationId = fixture.a.organization.id;
    const provider = await test.db.modelProvider.create({
      data: { organizationId, name: `Gate provider ${task.taskId}`, baseUrl: "https://models.example.com/v1", apiFormat: "openai_compatible", authScheme: "bearer", tokenSecretRef: `secret:${task.taskId}` },
    });
    const model = await test.db.model.create({ data: { organizationId, providerId: provider.id, endpointModelId: `gate-${task.taskId}` } });
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    await test.db.spendDaily.create({ data: { organizationId, projectId: fixture.a.openProject.id, day, modelId: model.id, spentMicroUsd: 2_000_000n } });
    const budget = await test.db.budget.create({ data: { organizationId, projectId: fixture.a.openProject.id, monthlyMicroUsd: 1_000_000n } });
    try {
      expect(await answerPlan(deps, scopeOf(fixture.a.member), { taskId: task.taskId, decision: "approve", entries, message: MESSAGE })).toEqual({ ok: true, reopened: false, held: true });
      // Held: no plan-answer goes to the runner, the turn is held under the budget, the answer saved.
      expect(await commandsOf(task.taskId)).toEqual([]);
      const held = await test.db.heldTurn.findFirstOrThrow({ where: { taskId: task.taskId } });
      expect(held).toMatchObject({ budgetId: budget.id, releasedAt: null });
      const saved = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, seq: held.pendingMessageSeq ?? -1 } });
      expect(saved.kind).toBe("plan.answered");
      expect(await eventsOf(task.taskId, "turn.held")).toHaveLength(1);
      expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).planState).toBe("approved");
      // Raised: the release sends the answer as a plan-answer, so the session leaves plan mode.
      await test.db.budget.update({ where: { id: budget.id }, data: { monthlyMicroUsd: 100_000_000n } });
      const released = await test.db.$transaction((tx) =>
        releaseHeldTurnsInTx({ jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock }, tx, { organizationId, budgetId: budgetIdSchema.parse(budget.id) }),
      );
      expect(released.released).toBe(1);
      const commands = await commandsOf(task.taskId);
      expect(commands).toMatchObject([{ kind: "plan_answer", body: { sessionId: task.sessionId, decision: "approve" } }]);
      expect(commandText(commands[0]?.body)).toContain("A member approved your plan. It is below.");
    } finally {
      await test.db.heldTurn.deleteMany({ where: { taskId: task.taskId } });
      await test.db.budget.delete({ where: { id: budget.id } });
      await test.db.spendDaily.deleteMany({ where: { modelId: model.id } });
    }
  });

  it("F-063/c2: a plan raises one item for the driver, sets planState to proposed, and the task needs you", async () => {
    const { task, seq } = await planned();
    const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(row).toMatchObject({ planState: "proposed", state: "needs_you", needsYouReason: "plan" });
    const items = await test.db.needsYouItem.findMany({ where: { taskId: task.taskId } });
    expect(items).toMatchObject([{ reason: "plan", audience: "driver", state: "open", planTurnId: "turn-plan" }]);
    expect(await fanOuts(items[0]?.id ?? "", "created")).toBe(1);
    // A second proposal before an answer raises no second item: the plan shown is the newest one.
    await ingest(ours, frame(runnerEvent(task, seq(), { kind: "plan.proposed", turnId: turnIdSchema.parse("turn-again"), entries, message: MESSAGE })));
    expect(await test.db.needsYouItem.findMany({ where: { taskId: task.taskId } })).toMatchObject([{ reason: "plan", state: "open" }]);
    // The plan's text is content: never in a log line.
    expect(JSON.stringify(records)).not.toContain("releaseName");
  });

  it("F-063/c2: approve as shown writes plan.answered and a plan-answer with the approved plan in a marked block", async () => {
    const { task } = await planned();
    expect(await answerPlan(deps, scopeOf(fixture.a.member), { taskId: task.taskId, decision: "approve", entries, message: MESSAGE })).toEqual({ ok: true, reopened: false });
    const [answered] = await eventsOf(task.taskId, "plan.answered");
    expect(answered?.payload).toMatchObject({ decision: "approve", entries, message: MESSAGE, memberId: fixture.a.member.id });
    const text = z.looseObject({ text: z.string() }).parse(answered?.payload).text;
    expect(text).toContain("1. Read config/settings.json");
    const commands = await commandsOf(task.taskId);
    expect(commands).toMatchObject([{ kind: "plan_answer", body: { sessionId: task.sessionId, decision: "approve" } }]);
    const prompt = commandText(commands[0]?.body);
    expect(prompt).toContain("A member approved your plan. It is below.");
    expect(readMarkedBlocks(prompt)).toMatchObject([{ label: "approved-plan", text }]);
    const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(row).toMatchObject({ planState: "approved", state: "running" });
    const item = await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId, reason: "plan" } });
    expect(item.state).toBe("answered");
    expect(await fanOuts(item.id, "answered")).toBe(1);
    // Answered: a second answer finds no plan waiting.
    expect(await answerPlan(deps, scopeOf(fixture.a.member), { taskId: task.taskId, decision: "approve", entries, message: MESSAGE })).toMatchObject({ ok: false, error: "no-plan" });
  });

  it("F-063/c2: edit and approve sends the edited plan, marked as edited", async () => {
    const { task } = await planned();
    const edited: PlanEntry[] = [entries[0] ?? { content: "", priority: "high", status: "pending" }, { content: "Add releaseName, sorted with the other keys", priority: "medium", status: "pending" }];
    expect(await answerPlan(deps, scopeOf(fixture.a.member), { taskId: task.taskId, decision: "approve", entries: edited, message: MESSAGE })).toMatchObject({ ok: true });
    const [answered] = await eventsOf(task.taskId, "plan.answered");
    expect(answered?.payload).toMatchObject({ decision: "approve", entries: edited });
    const prompt = commandText((await commandsOf(task.taskId))[0]?.body);
    expect(prompt).toContain("A member approved your plan with edits.");
    expect(prompt).toContain("sorted with the other keys");
  });

  it("F-063/c2: ask for changes writes a revise and its command, and leaves planState proposed until the next plan", async () => {
    const { task, seq } = await planned();
    const request = "Also say which tool gave the name";
    expect(await answerPlan(deps, scopeOf(fixture.a.member), { taskId: task.taskId, decision: "revise", request })).toEqual({ ok: true, reopened: false });
    const [answered] = await eventsOf(task.taskId, "plan.answered");
    expect(answered?.payload).toMatchObject({ decision: "revise", text: request });
    const commands = await commandsOf(task.taskId);
    expect(commands).toMatchObject([{ kind: "plan_answer", body: { decision: "revise" } }]);
    expect(readMarkedBlocks(commandText(commands[0]?.body))).toMatchObject([{ label: "plan-revision-request", text: request }]);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ planState: "proposed", state: "running" });
    // The revised plan raises a new item.
    await ingest(ours, frame(runnerEvent(task, seq(), { kind: "plan.proposed", turnId: turnIdSchema.parse("turn-2"), entries, message: "Revised." })));
    const items = await test.db.needsYouItem.findMany({ where: { taskId: task.taskId, reason: "plan" }, orderBy: { createdAt: "asc" } });
    expect(items.map((item) => item.state)).toEqual(["answered", "open"]);
    expect(await answerPlan(deps, scopeOf(fixture.a.member), { taskId: task.taskId, decision: "revise", request: "   " })).toMatchObject({ ok: false, error: "invalid-input" });
  });

  it("F-063/c2: a member who isn't the driver is refused, and nothing is written", async () => {
    const { task } = await planned();
    expect(await answerPlan(deps, scopeOf(fixture.a.insider), { taskId: task.taskId, decision: "approve", entries, message: MESSAGE })).toEqual({
      ok: false,
      error: "not-driver",
      message: "Only the driver answers. Take over to answer",
    });
    expect(await eventsOf(task.taskId, "plan.answered")).toEqual([]);
    expect(await commandsOf(task.taskId)).toEqual([]);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).planState).toBe("proposed");
  });

  it("F-063/c2: an answer after the box idled out reopens the task, an approve in build mode and a revise in plan mode", async () => {
    const approving = await planned();
    await idleOut(approving.task);
    expect(await answerPlan(deps, scopeOf(fixture.a.member), { taskId: approving.task.taskId, decision: "approve", entries, message: MESSAGE })).toEqual({ ok: true, reopened: true });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: approving.task.taskId } })).toMatchObject({ state: "queued", planState: "approved" });
    const approvedSessions = await test.db.session.findMany({ where: { taskId: approving.task.taskId }, orderBy: { startedAt: "asc" } });
    expect(approvedSessions).toHaveLength(2);
    const [approveMessage] = await test.db.event.findMany({ where: { taskId: approving.task.taskId, kind: "user.message", sessionId: approvedSessions[1]?.id ?? "" } });
    expect(z.looseObject({ text: z.string(), reopen: z.literal(true) }).parse(approveMessage?.payload).text).toContain("A member approved your plan.");
    expect(await firstTurnModeOf(approving.task.taskId, approvedSessions[1]?.id ?? "")).toBe("build");
    expect(await commandsOf(approving.task.taskId)).toEqual([]);

    const revising = await planned();
    await idleOut(revising.task);
    expect(await answerPlan(deps, scopeOf(fixture.a.member), { taskId: revising.task.taskId, decision: "revise", request: "Smaller steps, please" })).toEqual({ ok: true, reopened: true });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: revising.task.taskId } })).planState).toBe("proposed");
    const revisedSessions = await test.db.session.findMany({ where: { taskId: revising.task.taskId }, orderBy: { startedAt: "asc" } });
    const [reviseMessage] = await test.db.event.findMany({ where: { taskId: revising.task.taskId, kind: "user.message", sessionId: revisedSessions[1]?.id ?? "" } });
    expect(reviseMessage?.payload).toMatchObject({ intent: "plan-revision", reopen: true });
    expect(await firstTurnModeOf(revising.task.taskId, revisedSessions[1]?.id ?? "")).toBe("plan");
  });

  it("F-063/c2: another organization's task is untouched", async () => {
    const task = await seedLeasedTask(test.db, theirs, fixture.b.project.id, { state: "running", creatorMemberId: fixture.b.admin.id });
    await ingest(theirs, frame(runnerEvent(task, 1, { kind: "turn.started", turnId }), runnerEvent(task, 2, proposed)));
    const outsider = scopeOf(fixture.a.admin);
    expect(await answerPlan(deps, outsider, { taskId: task.taskId, decision: "approve", entries, message: MESSAGE })).toEqual({ ok: false, error: "not-found", message: "No such task" });
    expect(await answerQuestion(deps, outsider, { taskId: task.taskId, questionId: questionIdSchema.parse("q-none"), answers: {} })).toMatchObject({ ok: false, error: "not-found" });
    expect(await eventsOf(task.taskId, "plan.answered")).toEqual([]);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ planState: "proposed", state: "needs_you" });
  });
});

describe("questions", () => {
  const asked = (questionId: QuestionId): TaskEvent => ({
    kind: "question.asked",
    turnId,
    questionId,
    message: "Which name should the release get?",
    fields: [
      { id: "name", label: "Release name", type: "text" },
      { id: "channel", label: "Channel", type: "select", options: ["stable", "beta"] },
    ],
  });

  it("F-024, F-026: a question's answer is checked against its fields and its command sent once", async () => {
    const { task, seq } = await runningTask();
    const questionId = questionIdSchema.parse(crypto.randomUUID());
    await ingest(ours, frame(runnerEvent(task, seq(), asked(questionId))));
    const item = await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId } });
    expect(item).toMatchObject({ reason: "question", audience: "driver", questionId, state: "open" });
    expect(await fanOuts(item.id, "created")).toBe(1);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "needs_you", needsYouReason: "question" });
    expect((await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).state).toBe("waiting");

    const answer = (member: SeededMember, answers: Record<string, string>) => answerQuestion(deps, scopeOf(member), { taskId: task.taskId, questionId, answers });
    expect(await answer(fixture.a.insider, { name: "Aurora", channel: "stable" })).toMatchObject({ ok: false, error: "not-driver" });
    expect(await answer(fixture.a.member, { name: "Aurora" })).toMatchObject({ ok: false, error: "invalid-input" });
    expect(await answer(fixture.a.member, { name: "Aurora", channel: "nightly" })).toMatchObject({ ok: false, error: "invalid-input" });
    expect(await answer(fixture.a.member, { name: "Aurora", channel: "stable", extra: "x" })).toMatchObject({ ok: false, error: "invalid-input" });
    expect(await commandsOf(task.taskId)).toEqual([]);

    const results = await Promise.all([answer(fixture.a.member, { name: "Aurora", channel: "stable" }), answer(fixture.a.member, { name: "Borealis", channel: "beta" })]);
    expect(results.filter((result) => result.ok)).toEqual([{ ok: true, reopened: false }]);
    expect(results.filter((result) => !result.ok)).toMatchObject([{ ok: false, error: "already-answered" }]);
    const commands = await commandsOf(task.taskId);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ kind: "question_answer", body: { sessionId: task.sessionId, questionId } });
    expect(await eventsOf(task.taskId, "question.answered")).toHaveLength(1);
    expect((await test.db.needsYouItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe("answered");
    expect(await fanOuts(item.id, "answered")).toBe(1);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "running" });
    expect((await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).state).toBe("running");
    // The answers are content: never in a log line.
    expect(JSON.stringify(records)).not.toContain("Aurora");
  });

  it("F-024, F-026: a question the turn's end closed keeps its item, and its answer reopens the task with the answer", async () => {
    const { task, seq } = await runningTask();
    const questionId = questionIdSchema.parse(crypto.randomUUID());
    await ingest(
      ours,
      frame(
        runnerEvent(task, seq(), asked(questionId)),
        runnerEvent(task, seq(), { kind: "question.closed", questionId, reason: "expired" }),
        runnerEvent(task, seq(), { kind: "turn.ended", turnId, stopReason: "cancelled" }),
      ),
    );
    const item = await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId } });
    expect(item.state).toBe("open");
    expect(await answerQuestion(deps, scopeOf(fixture.a.member), { taskId: task.taskId, questionId, answers: { name: "Aurora", channel: "beta" } })).toEqual({ ok: true, reopened: true });
    expect(await commandsOf(task.taskId)).toEqual([]);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("queued");
    const sessions = await test.db.session.findMany({ where: { taskId: task.taskId }, orderBy: { startedAt: "asc" } });
    const [message] = await test.db.event.findMany({ where: { taskId: task.taskId, kind: "user.message", sessionId: sessions[1]?.id ?? "" } });
    const text = z.looseObject({ text: z.string() }).parse(message?.payload).text;
    expect(readMarkedBlocks(text)).toMatchObject([
      { label: "question", text: "Which name should the release get?" },
      { label: "answers", text: "Release name: Aurora\nChannel: beta" },
    ]);
    expect((await test.db.needsYouItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe("answered");
  });
});
