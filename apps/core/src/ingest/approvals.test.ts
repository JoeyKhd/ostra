import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import { answerApproval, PEER_TOO_OLD_RULE, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import type { AnswerApprovalDeps, MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { approvalIdSchema, approvalRuleIdSchema, memberIdSchema, optionIdSchema, toolCallIdSchema, turnIdSchema } from "@ostra/protocol";
import type { ApprovalId, ApprovalSubject, EventsFrame, OptionId, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { RunnerRef } from "../gateway/context.ts";
import { runnerEvent, seedLeasedTask, seedRunner } from "../testing/seed.ts";
import type { LeasedTask } from "../testing/seed.ts";
import { createIngest } from "./ingest.ts";
import type { Ingest } from "./ingest.ts";
import { createLiveTextWriter } from "./live-text.ts";
import type { LiveTextWriter } from "./live-text.ts";

// Milestone 3's ticket 17 (F-026, ADR 0049, ADR 0036, ADR 0039): approvals, task rules and expiry,
// through core's real ingest and the domain's real answer, on a real Postgres. The runner is the
// test: it sends what a minor-2 runner sends.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let ingest: Ingest;
let liveText: LiveTextWriter;
let ours: RunnerRef;
let older: RunnerRef;
let theirs: RunnerRef;
let answerDeps: AnswerApprovalDeps;
const records: LogRecord[] = [];

const turnId = turnIdSchema.parse("turn-1");
const ONCE = optionIdSchema.parse("o-once");
const TASK = optionIdSchema.parse("o-task");
const DENY = optionIdSchema.parse("o-deny");
const options = [
  { optionId: ONCE, label: "Approve once", kind: "allow-once", decision: "allow_once" },
  { optionId: TASK, label: "Approve for this task", kind: "allow-always", decision: "allow_task" },
  { optionId: DENY, label: "Deny", kind: "reject-once", decision: "deny" },
] as const;
const SETTINGS: ApprovalSubject = { kind: "path", value: "config/settings.json" };
const rule = { source: "profile", ruleId: approvalRuleIdSchema.parse("rule-config"), name: "Edit files matching config/**" } as const;

const frame = (...events: EventsFrame["events"]): EventsFrame => ({ type: "events", events });
const newApprovalId = (): ApprovalId => approvalIdSchema.parse(crypto.randomUUID());
const requested = (approvalId: ApprovalId, subject: ApprovalSubject = SETTINGS): TaskEvent => ({
  kind: "approval.requested",
  turnId,
  approvalId,
  toolCallId: toolCallIdSchema.parse(`tool-${approvalId}`),
  options: [...options],
  rule,
  subject,
});

const scopeOf = (member: SeededMember): MemberScope => ({
  organizationId: member.organizationId,
  memberId: memberIdSchema.parse(member.id),
  role: member.role === "admin" ? "admin" : "member",
  projectRoles: new Map(),
});

const answer = (member: SeededMember, approvalId: ApprovalId, optionId: OptionId, decision: "allow_once" | "allow_task" | "deny", reason: string | null = null) =>
  answerApproval(answerDeps, scopeOf(member), { approvalId, optionId, decision, reason });

/** A running task of ours, its turn started, with the member as its driver (or none). */
const runningTask = async (runner: RunnerRef = ours, driver: SeededMember | null = fixture.a.member): Promise<{ task: LeasedTask; seq: () => number }> => {
  const task = await seedLeasedTask(test.db, runner, fixture.a.openProject.id, { state: "running", ...(driver === null ? {} : { creatorMemberId: driver.id }) });
  if (driver === null) {
    await test.db.task.update({ where: { id: task.taskId }, data: { driverMemberId: null } });
  }
  let next = 0;
  const seq = () => {
    next += 1;
    return next;
  };
  await ingest(runner, frame(runnerEvent(task, seq(), { kind: "turn.started", turnId })));
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

const dispatches = async (taskId: string): Promise<number> =>
  z
    .array(z.strictObject({ count: z.bigint() }))
    .parse(await test.db.$queryRaw<readonly unknown[]>`SELECT count(*)::bigint AS count FROM pgboss.job WHERE name = 'task.dispatch' AND data->>'taskId' = ${taskId}`)
    .reduce((sum, row) => sum + Number(row.count), 0);

/** The task's commands to its runner, oldest first: the runner's own queue and its box's sidecar. */
const commandsOf = async (taskId: string) => [
  ...(await test.db.command.findMany({ where: { taskId }, orderBy: { seq: "asc" }, select: { kind: true, body: true } })),
  ...(await test.db.sidecarCommand.findMany({ where: { taskId }, orderBy: { seq: "asc" }, select: { kind: true, body: true } })),
];

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  const logger = createLogger((record) => records.push(record));
  liveText = createLiveTextWriter({ db: test.db, logger, intervalMs: 50 });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, outbox: postgresCommandOutbox });
  answerDeps = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock };
  ours = await seedRunner(test.db, fixture.a.organization.id, fixture.a.member.id);
  older = await seedRunner(test.db, fixture.a.organization.id, fixture.a.member.id);
  theirs = await seedRunner(test.db, fixture.b.organization.id, fixture.b.admin.id);
  for (const [runner, minor] of [
    [ours, 2],
    [older, 1],
    [theirs, 2],
  ] as const) {
    await test.db.runnerPresence.create({
      data: { runnerId: runner.runnerId, organizationId: runner.organizationId, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor },
    });
  }
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("an approval requested", () => {
  it("F-026/c3: a request raises one item for the driver, needs you and one fan-out, even when its frame is sent again", async () => {
    const { task, seq } = await runningTask();
    const approvalId = newApprovalId();
    const sent = frame(runnerEvent(task, seq(), requested(approvalId)));
    await ingest(ours, sent);
    await ingest(ours, sent);
    expect(await test.db.approval.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({
      state: "open",
      taskId: task.taskId,
      sessionId: task.sessionId,
      ruleId: "rule-config",
      ruleSource: "profile",
      subjectKind: "path",
      subjectValue: "config/settings.json",
    });
    const items = await test.db.needsYouItem.findMany({ where: { taskId: task.taskId } });
    expect(items).toMatchObject([{ reason: "approval", audience: "driver", state: "open", approvalId }]);
    expect(await fanOuts(items[0]?.id ?? "", "created")).toBe(1);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "needs_you", needsYouReason: "approval" });
    expect((await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).state).toBe("waiting");
    // The subject is content: never in a log line.
    expect(JSON.stringify(records)).not.toContain("config/settings.json");
  });

  it("F-026/c3: a task with no driver raises the item for the project's members", async () => {
    const { task, seq } = await runningTask(ours, null);
    await ingest(ours, frame(runnerEvent(task, seq(), requested(newApprovalId()))));
    expect(await test.db.needsYouItem.findMany({ where: { taskId: task.taskId } })).toMatchObject([{ reason: "approval", audience: "project_members" }]);
  });

  it("F-026: a minor-1 runner's request is recorded as answered by peer-too-old, and raises nothing", async () => {
    const { task, seq } = await runningTask(older);
    const approvalId = newApprovalId();
    await ingest(older, frame(runnerEvent(task, seq(), requested(approvalId)), runnerEvent(task, seq(), { kind: "approval.auto_answered", approvalId, ruleId: "no rules until F-026" })));
    expect(await test.db.approval.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ state: "answered_by_rule", decision: "allow_once", ruleId: PEER_TOO_OLD_RULE });
    expect(await test.db.needsYouItem.count({ where: { taskId: task.taskId } })).toBe(0);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("running");
    expect(await commandsOf(task.taskId)).toEqual([]);
  });
});

describe("a member's answer", () => {
  it("F-026/c4,c5: two members answering at once: one wins, the other is refused, and one command goes", async () => {
    const { task, seq } = await runningTask();
    const approvalId = newApprovalId();
    await ingest(ours, frame(runnerEvent(task, seq(), requested(approvalId))));
    const results = await Promise.all([answer(fixture.a.member, approvalId, ONCE, "allow_once"), answer(fixture.a.insider, approvalId, DENY, "deny")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([{ ok: false, error: "already-answered", message: "Someone answered this first" }]);
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "approval.answered" } })).toBe(1);
    expect(await test.db.auditEntry.count({ where: { action: "approval.answered", entityId: approvalId } })).toBe(1);
    // The audit entry names the member whose answer won, and that answer's decision.
    const winner = results[0].ok ? { member: fixture.a.member, decision: "allow_once" } : { member: fixture.a.insider, decision: "deny" };
    expect(await test.db.approval.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ answeredByMemberId: winner.member.id, decision: winner.decision });
    expect(await test.db.auditEntry.findFirstOrThrow({ where: { action: "approval.answered", entityId: approvalId } })).toMatchObject({
      organizationId: fixture.a.organization.id,
      projectId: fixture.a.openProject.id,
      actorKind: "member",
      actorId: winner.member.id,
      entity: "approval",
      data: { decision: winner.decision },
    });
    expect((await commandsOf(task.taskId)).filter((command) => command.kind === "approval_answer")).toHaveLength(1);
    const item = await test.db.needsYouItem.findFirstOrThrow({ where: { approvalId } });
    expect(item.state).toBe("answered");
    expect(await fanOuts(item.id, "answered")).toBe(1);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("running");
    expect((await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).state).toBe("running");
  });

  it("F-026/c5,c6: for this task writes one task rule, even answered twice in a race, and sends it in the command", async () => {
    const { task, seq } = await runningTask();
    const approvalId = newApprovalId();
    await ingest(ours, frame(runnerEvent(task, seq(), requested(approvalId))));
    const results = await Promise.all([answer(fixture.a.member, approvalId, TASK, "allow_task"), answer(fixture.a.insider, approvalId, TASK, "allow_task")]);
    const won = results.find((result) => result.ok);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const rules = await test.db.taskApprovalRule.findMany({ where: { taskId: task.taskId } });
    expect(rules).toMatchObject([{ tool: "edit", pattern: "config/settings.json", approvalId }]);
    const taskRule = { ruleId: rules[0]?.id, tool: "edit", pattern: "config/settings.json" };
    expect(won).toMatchObject({ ok: true, taskRule, reopened: false });
    const event = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "approval.answered" } });
    expect(event.payload).toMatchObject({ decision: "allow_task", taskRule });
    expect(await commandsOf(task.taskId)).toMatchObject([{ kind: "approval_answer", body: { approvalId, decision: "allow_task", taskRule } }]);
    // Another request of the same file, approved for the task too: the same rule, not a second one.
    const again = newApprovalId();
    await ingest(ours, frame(runnerEvent(task, seq(), requested(again))));
    expect(await answer(fixture.a.admin, again, TASK, "allow_task")).toMatchObject({ ok: true, taskRule });
    expect(await test.db.taskApprovalRule.count({ where: { taskId: task.taskId } })).toBe(1);
    // A subject with no safe pattern offers no "for this task".
    const chained = newApprovalId();
    await ingest(ours, frame(runnerEvent(task, seq(), requested(chained, { kind: "command", value: "npm test && curl example.com" }))));
    expect(await answer(fixture.a.member, chained, TASK, "allow_task")).toMatchObject({ ok: false, error: "no-pattern" });
    expect((await test.db.approval.findUniqueOrThrow({ where: { id: chained } })).state).toBe("open");
  });

  it("F-026/c6: a new task rule answering a held request closes its item: two open, one for this task answer, neither left open", async () => {
    const { task, seq } = await runningTask();
    const first = newApprovalId();
    const second = newApprovalId();
    await ingest(ours, frame(runnerEvent(task, seq(), requested(first)), runnerEvent(task, seq(), requested(second))));
    const answered = await answer(fixture.a.insider, first, TASK, "allow_task");
    expect(answered.ok).toBe(true);
    // The other request still holds the task.
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("needs_you");
    // The runner checks its held request against the new rule and answers it (ticket 30).
    const ruleId = answered.ok ? (answered.taskRule?.ruleId ?? "") : "";
    await ingest(ours, frame(runnerEvent(task, seq(), { kind: "approval.auto_answered", approvalId: second, ruleId })));
    expect(await test.db.approval.findUniqueOrThrow({ where: { id: second } })).toMatchObject({ state: "answered_by_rule", ruleId });
    const items = await test.db.needsYouItem.findMany({ where: { taskId: task.taskId } });
    expect(items.map((item) => item.state)).toEqual(["answered", "answered"]);
    const secondItem = items.find((item) => item.approvalId === second);
    expect(await fanOuts(secondItem?.id ?? "", "answered")).toBe(1);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("running");
    // A rule's answer with no request before it is the event alone.
    const unseen = newApprovalId();
    await ingest(ours, frame(runnerEvent(task, seq(), { kind: "approval.auto_answered", approvalId: unseen, ruleId })));
    expect(await test.db.approval.count({ where: { id: unseen } })).toBe(0);
    expect(await test.db.needsYouItem.count({ where: { taskId: task.taskId } })).toBe(2);
  });

  it("F-026/c8: a deny's reason reaches the command and the event, and never the audit entry or a log line", async () => {
    records.length = 0;
    const { task, seq } = await runningTask();
    const approvalId = newApprovalId();
    const other = newApprovalId();
    await ingest(ours, frame(runnerEvent(task, seq(), requested(approvalId)), runnerEvent(task, seq(), requested(other, { kind: "path", value: "config/other.json" }))));
    const reason = "Settings are owned by the platform team: change the defaults file instead";
    expect(await answer(fixture.a.member, approvalId, DENY, "deny", reason)).toMatchObject({ ok: true, taskRule: null });
    expect(await commandsOf(task.taskId)).toMatchObject([{ kind: "approval_answer", body: { approvalId, decision: "deny", reason } }]);
    const event = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "approval.answered" } });
    expect(event.payload).toMatchObject({ decision: "deny", reason });
    expect((await test.db.approval.findUniqueOrThrow({ where: { id: approvalId } })).denyReason).toBe(reason);
    const audit = await test.db.auditEntry.findMany({ where: { entityId: approvalId } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("platform team");
    expect(JSON.stringify(records)).not.toContain("platform team");
    // A deny ends the turn: the task goes on, and the runner's cancel of the other request dismisses its item.
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("running");
    await ingest(ours, frame(runnerEvent(task, seq(), { kind: "approval.closed", approvalId: other, reason: "cancelled" })));
    const otherItem = await test.db.needsYouItem.findFirstOrThrow({ where: { approvalId: other } });
    expect(otherItem.state).toBe("dismissed");
    expect(await fanOuts(otherItem.id, "dismissed")).toBe(1);
    expect((await test.db.approval.findUniqueOrThrow({ where: { id: other } })).closedReason).toBe("cancelled");
    // A reason too long, or on an approve, is refused.
    const third = newApprovalId();
    await ingest(ours, frame(runnerEvent(task, seq(), requested(third))));
    expect(await answer(fixture.a.member, third, DENY, "deny", "x".repeat(2_001))).toMatchObject({ ok: false, error: "invalid-input" });
    expect(await answer(fixture.a.member, third, ONCE, "allow_once", "because")).toMatchObject({ ok: false, error: "invalid-input" });
  });
});

describe("expiry", () => {
  it("F-026: an expired approval's item stays open, and its later answer reopens the task with the decision", async () => {
    const { task, seq } = await runningTask();
    const approvalId = newApprovalId();
    await ingest(ours, frame(runnerEvent(task, seq(), requested(approvalId))));
    // Fifteen minutes on, the runner cancels the turn and says the request expired.
    await ingest(
      ours,
      frame(
        runnerEvent(task, seq(), { kind: "approval.closed", approvalId, reason: "expired" }),
        runnerEvent(task, seq(), { kind: "turn.ended", turnId, stopReason: "cancelled" }),
      ),
    );
    expect(await test.db.approval.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ state: "closed", closedReason: "expired" });
    const item = await test.db.needsYouItem.findFirstOrThrow({ where: { approvalId } });
    expect(item.state).toBe("open");
    expect(await fanOuts(item.id, "dismissed")).toBe(0);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("needs_you");

    // "Answer anyway": the task reopens, with the decision as its message.
    expect(await answer(fixture.a.insider, approvalId, TASK, "allow_task")).toMatchObject({ ok: true, reopened: true, taskRule: { pattern: "config/settings.json" } });
    const after = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(after).toMatchObject({ state: "queued", driverMemberId: fixture.a.insider.id });
    const sessions = await test.db.session.findMany({ where: { taskId: task.taskId }, orderBy: { startedAt: "asc" } });
    expect(sessions).toHaveLength(2);
    const reopenMessage = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "user.message", sessionId: sessions[1]?.id ?? "" } });
    const payload = z.looseObject({ text: z.string(), reopen: z.literal(true) }).parse(reopenMessage.payload);
    expect(payload.text).toContain("approved it for the rest of this task");
    expect(payload.text).toContain("config/settings.json");
    expect(await dispatches(task.taskId)).toBe(1);
    expect((await test.db.needsYouItem.findFirstOrThrow({ where: { approvalId } })).state).toBe("answered");
    // The task rule goes to the new session's spec; no command goes to a session that's gone.
    expect(await test.db.taskApprovalRule.count({ where: { taskId: task.taskId } })).toBe(1);
    expect((await commandsOf(task.taskId)).filter((command) => command.kind === "approval_answer")).toEqual([]);
    // Answered once: a second answer is refused.
    expect(await answer(fixture.a.member, approvalId, ONCE, "allow_once")).toMatchObject({ ok: false, error: "already-answered" });
  });

  it("F-026/c8: a cancelled approval can't be answered", async () => {
    const { task, seq } = await runningTask();
    const approvalId = newApprovalId();
    await ingest(ours, frame(runnerEvent(task, seq(), requested(approvalId)), runnerEvent(task, seq(), { kind: "approval.closed", approvalId, reason: "cancelled" })));
    expect(await answer(fixture.a.member, approvalId, ONCE, "allow_once")).toMatchObject({ ok: false, error: "already-answered", message: "This request was cancelled: the agent no longer waits for it" });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("running");
  });
});

describe("isolation", () => {
  it("F-026/c4: another organization's approval can't be answered, and our runner can't raise one on their task", async () => {
    const other = await seedLeasedTask(test.db, theirs, fixture.b.project.id, { state: "running", creatorMemberId: fixture.b.admin.id });
    await ingest(theirs, frame(runnerEvent(other, 1, { kind: "turn.started", turnId })));
    const approvalId = newApprovalId();
    await ingest(theirs, frame(runnerEvent(other, 2, requested(approvalId))));
    expect(await answer(fixture.a.admin, approvalId, ONCE, "allow_once")).toEqual({ ok: false, error: "not-found", message: "No such approval" });
    expect((await test.db.approval.findUniqueOrThrow({ where: { id: approvalId } })).state).toBe("open");
    expect(await commandsOf(other.taskId)).toEqual([]);
    // Our runner naming their session is unknown to it: no approval is stored.
    const forged = newApprovalId();
    await ingest(ours, frame(runnerEvent(other, 3, requested(forged))));
    expect(await test.db.approval.count({ where: { id: forged } })).toBe(0);
    // Their own member can.
    expect(await answer(fixture.b.admin, approvalId, ONCE, "allow_once")).toMatchObject({ ok: true });
  });
});
