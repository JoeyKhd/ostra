import { clientMessageIdSchema, messageDeliveries, taskEventSchema, turnIdSchema } from "@ostra/protocol";
import type { ClientMessageId, ProjectId, RunnerId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendEvent, createApiHarness, seedConnectionAndModel, seedLease, seedPersonalRunner, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";

// Milestone 3's ticket 19 (F-024, ADR 0036, ADR 0032): steering finished. The race ADR 0036 asks
// for, a take-over and a send (or an interrupt) at the same moment, 50 times on a real Postgres;
// the watcher's refusals; a no-steer agent's queued message, delivered after the turn; intents.
// Ported from spikes/live-stream-and-task-view/src/harness/checks-api.ts (the watcher checks).

let harness: ApiHarness;
let projectId: ProjectId;
let runnerId: RunnerId;

const ROUNDS = 50;
const orgA = () => harness.fixture.a.organization.id;
const newMessageId = (): ClientMessageId => clientMessageIdSchema.parse(`client-${crypto.randomUUID()}`);

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "steering")).projectId;
  runnerId = await seedPersonalRunner(harness, harness.fixture.a.admin.id, "steering-runner");
});

afterAll(async () => {
  await harness.dispose();
});

/** A running task with its lease, driven by the member, its session on a profile of `adapter` (or none). */
const runningTask = async (adapter: string | null = null, sessionState: "running" | "idle" = "running"): Promise<SeededTask> => {
  const task = await seedTask(harness, { organizationId: orgA(), projectId, state: "running", driverMemberId: harness.fixture.a.member.id, sessionState });
  await seedLease(harness, task, orgA(), projectId, runnerId);
  if (adapter !== null) {
    const profile = await harness.test.db.agentProfile.create({ data: { organizationId: orgA(), name: `${adapter} ${task.taskId}`, adapter } });
    await harness.test.db.session.update({ where: { id: task.sessionId }, data: { agentProfileId: profile.id } });
    await harness.test.db.task.update({ where: { id: task.taskId }, data: { agentProfileId: profile.id } });
  }
  return task;
};

const logOf = async (task: SeededTask) =>
  (await harness.test.db.event.findMany({ where: { taskId: task.taskId }, orderBy: { seq: "asc" }, select: { seq: true, kind: true, payload: true, sessionId: true } })).map((row) => ({
    seq: row.seq,
    kind: row.kind,
    sessionId: row.sessionId,
    payload: row.payload,
  }));

/** Each message's delivery as every viewer folds it from the committed log. */
const deliveriesOf = async (task: SeededTask) => messageDeliveries((await logOf(task)).map((row) => ({ sessionId: row.sessionId, event: taskEventSchema.parse(row.payload) })));

const steersFor = (messageId: ClientMessageId) =>
  harness.fakes.outbox.commands.filter((command) => command.kind === "steer" && Reflect.get(command.body, "clientMessageId") === messageId);

describe("the driver race (ADR 0036)", () => {
  it("F-024: a take-over and a send at the same moment, 50 times: each send committed before the take-over, as the old driver's, or was refused", async () => {
    const { member, insider } = harness.fixture.a;
    const [driver, taker] = [await harness.as(member), await harness.as(insider)];
    const outcomes = { before: 0, refused: 0 };
    for (let round = 0; round < ROUNDS; round += 1) {
      const task = await runningTask();
      const messageId = newMessageId();
      const [sent, taken] = await Promise.allSettled([
        driver.tasks.send({ taskId: task.taskId, clientMessageId: messageId, text: `race ${String(round)}` }),
        taker.tasks.takeOver({ taskId: task.taskId }),
      ]);
      expect(taken).toMatchObject({ status: "fulfilled", value: { driver: insider.id, changed: true } });
      const log = await logOf(task);
      const messages = log.filter((event) => event.kind === "user.message");
      const change = log.find((event) => event.kind === "driver.changed");
      expect(change?.payload).toMatchObject({ memberId: insider.id, byMemberId: insider.id });
      if (sent.status === "fulfilled") {
        // The send held the lock first: its message is in the log before the take-over, as the old driver's.
        outcomes.before += 1;
        expect(messages).toHaveLength(1);
        expect(messages[0]?.payload).toMatchObject({ memberId: member.id, clientMessageId: messageId });
        expect(messages[0]?.seq).toBeLessThan(change?.seq ?? 0);
        expect(steersFor(messageId)).toHaveLength(1);
      } else {
        outcomes.refused += 1;
        expect(sent.reason).toMatchObject({ code: "FORBIDDEN" });
        expect(messages).toEqual([]);
        expect(steersFor(messageId)).toEqual([]);
      }
      expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).driverMemberId).toBe(insider.id);
    }
    expect(outcomes.before + outcomes.refused).toBe(ROUNDS);
  });

  it("F-024: a take-over and an interrupt at the same moment, 50 times: each interrupt committed before the take-over or was refused", async () => {
    const { member, insider } = harness.fixture.a;
    const [driver, taker] = [await harness.as(member), await harness.as(insider)];
    for (let round = 0; round < ROUNDS; round += 1) {
      const task = await runningTask();
      const before = harness.fakes.outbox.commands.filter((command) => command.kind === "interrupt" && Reflect.get(command.body, "sessionId") === task.sessionId).length;
      const [interrupted, taken] = await Promise.allSettled([driver.tasks.interrupt({ taskId: task.taskId }), taker.tasks.takeOver({ taskId: task.taskId })]);
      expect(taken.status).toBe("fulfilled");
      const log = await logOf(task);
      const cancels = log.filter((event) => event.kind === "turn.cancel_requested");
      const change = log.find((event) => event.kind === "driver.changed");
      const interrupts = harness.fakes.outbox.commands.filter((command) => command.kind === "interrupt" && Reflect.get(command.body, "sessionId") === task.sessionId).length - before;
      if (interrupted.status === "fulfilled") {
        expect(cancels).toHaveLength(1);
        expect(cancels[0]?.payload).toMatchObject({ memberId: member.id });
        expect(cancels[0]?.seq).toBeLessThan(change?.seq ?? 0);
        expect(interrupts).toBe(1);
      } else {
        expect(interrupted.reason).toMatchObject({ code: "FORBIDDEN" });
        expect(cancels).toEqual([]);
        expect(interrupts).toBe(0);
      }
    }
  });

  it("F-024: a watcher's send and interrupt are refused by the API, and write nothing", async () => {
    const task = await runningTask();
    const watcher = await harness.as(harness.fixture.a.insider);
    const before = (await logOf(task)).length;
    const commands = harness.fakes.outbox.commands.length;
    await expect(watcher.tasks.send({ taskId: task.taskId, clientMessageId: newMessageId(), text: "let me in" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(watcher.tasks.send({ taskId: task.taskId, clientMessageId: newMessageId(), text: "now", delivery: "interrupt" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(watcher.tasks.interrupt({ taskId: task.taskId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await logOf(task)).length).toBe(before);
    expect(harness.fakes.outbox.commands.length).toBe(commands);
    const seen = await watcher.tasks.get({ taskId: task.taskId });
    expect(seen.capabilities).toMatchObject({ send: false, interrupt: false, takeOver: true });
    // The driver's own send goes through.
    await expect((await harness.as(harness.fixture.a.member)).tasks.send({ taskId: task.taskId, clientMessageId: newMessageId(), text: "mine" })).resolves.toMatchObject({ duplicate: false });
  });
});

describe("queued messages and intents", () => {
  it("F-024: a no-steer agent's message is queued for every viewer, and delivered after the turn once the next one starts", async () => {
    const task = await runningTask("scripted-no-steer");
    const messageId = newMessageId();
    await (await harness.as(harness.fixture.a.member)).tasks.send({ taskId: task.taskId, clientMessageId: messageId, text: "Also mention the ticket's key" });
    const [message] = (await logOf(task)).filter((event) => event.kind === "user.message");
    expect(message?.payload).toMatchObject({ delivery: "queued" });
    expect(steersFor(messageId)).toMatchObject([{ body: { delivery: "queue" } }]);
    // Every viewer reads the same log: queued, until the runner starts the turn that carries it.
    expect((await deliveriesOf(task)).get(messageId)).toBe("queued");
    const watcher = await harness.as(harness.fixture.a.insider);
    expect((await watcher.tasks.get({ taskId: task.taskId })).capabilities).toMatchObject({ steersMidTurn: false });
    await appendEvent(harness, task, { organizationId: orgA(), projectId }, { kind: "turn.ended", turnId: turnIdSchema.parse("t-1"), stopReason: "end_turn" });
    expect((await deliveriesOf(task)).get(messageId)).toBe("queued");
    await appendEvent(harness, task, { organizationId: orgA(), projectId }, { kind: "turn.started", turnId: turnIdSchema.parse("t-2") });
    expect((await deliveriesOf(task)).get(messageId)).toBe("delivered-after-turn");
  });

  it("F-024: an agent that steers mid-turn takes the message at once, and the composer says so", async () => {
    const task = await runningTask("opencode");
    const messageId = newMessageId();
    const member = await harness.as(harness.fixture.a.member);
    await member.tasks.send({ taskId: task.taskId, clientMessageId: messageId, text: "Use the date format YYYY-MM-DD" });
    const [message] = (await logOf(task)).filter((event) => event.kind === "user.message");
    expect(message?.payload).toMatchObject({ delivery: "immediate" });
    expect((await deliveriesOf(task)).get(messageId)).toBe("delivered");
    expect((await member.tasks.get({ taskId: task.taskId })).capabilities).toMatchObject({ steersMidTurn: true });
    // Interrupt and send is its own delivery either way.
    const interruptId = newMessageId();
    await member.tasks.send({ taskId: task.taskId, clientMessageId: interruptId, text: "Stop. Use the date format YYYY-MM-DD.", delivery: "interrupt" });
    expect((await deliveriesOf(task)).get(interruptId)).toBe("after-interrupt");
    // Between turns the message is the next turn: queued until it starts.
    const idle = await runningTask("opencode", "idle");
    const nextId = newMessageId();
    await member.tasks.send({ taskId: idle.taskId, clientMessageId: nextId, text: "Next" });
    expect((await deliveriesOf(idle)).get(nextId)).toBe("queued");
  });

  it("F-024: an intent reaches the steer command and the message, and an unknown intent is refused", async () => {
    const task = await runningTask();
    const member = await harness.as(harness.fixture.a.member);
    const messageId = newMessageId();
    await member.tasks.send({ taskId: task.taskId, clientMessageId: messageId, text: "Merge main into the branch", intent: "update-branch" });
    expect(steersFor(messageId)).toMatchObject([{ body: { intent: "update-branch" } }]);
    const [message] = (await logOf(task)).filter((event) => event.kind === "user.message");
    expect(message?.payload).toMatchObject({ intent: "update-branch" });
    const unknownId = newMessageId();
    await expect(
      // @ts-expect-error -- an intent outside the protocol's set, as a hand-made request could send it
      member.tasks.send({ taskId: task.taskId, clientMessageId: unknownId, text: "x", intent: "take-over-the-world" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(steersFor(unknownId)).toEqual([]);
  });
});
