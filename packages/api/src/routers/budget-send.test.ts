import { clientMessageIdSchema } from "@ostra/protocol";
import type { ClientMessageId, ProjectId, RunnerId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedLease, seedPersonalRunner, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";

// Ticket 12 (F-037, ADR 0055): the composer's message is a turn start when the session is idle, so
// `tasks.send` calls the budget gate in the task's lock. A closed gate saves the message and holds
// the turn; a message to a turn that's going is still delivered, since it's part of that turn.

let harness: ApiHarness;
let projectId: ProjectId;
let runnerId: RunnerId;

const orgA = () => harness.fixture.a.organization.id;
const newMessageId = (): ClientMessageId => clientMessageIdSchema.parse(`client-${crypto.randomUUID()}`);

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "budget-send")).projectId;
  runnerId = await seedPersonalRunner(harness, harness.fixture.a.admin.id, "budget-runner");
});

afterAll(async () => {
  await harness.dispose();
});

beforeEach(async () => {
  await harness.test.db.heldTurn.deleteMany({});
  await harness.test.db.budget.deleteMany({});
  // A budget of nothing is reached at once: every new turn waits.
  await harness.test.db.budget.create({ data: { organizationId: orgA(), projectId: null, monthlyMicroUsd: 0n } });
});

const taskWith = async (sessionState: "running" | "idle"): Promise<SeededTask> => {
  const task = await seedTask(harness, { organizationId: orgA(), projectId, state: "running", driverMemberId: harness.fixture.a.member.id, sessionState });
  await seedLease(harness, task, orgA(), projectId, runnerId);
  return task;
};

const steersFor = (messageId: ClientMessageId) =>
  harness.fakes.outbox.commands.filter((command) => command.kind === "steer" && Reflect.get(command.body, "clientMessageId") === messageId);

describe("the composer's message and the budget gate (F-037)", () => {
  it("F-037: a message to an idle session past the budget is saved and held, and no steer goes out", async () => {
    const task = await taskWith("idle");
    const messageId = newMessageId();
    const sent = await (await harness.as(harness.fixture.a.member)).tasks.send({ taskId: task.taskId, clientMessageId: messageId, text: "One more thing" });
    expect(sent).toMatchObject({ duplicate: false, held: true });
    expect(steersFor(messageId)).toHaveLength(0);
    const held = await harness.test.db.heldTurn.findFirstOrThrow({ where: { taskId: task.taskId } });
    expect(held).toMatchObject({ origin: "message", pendingMessageSeq: sent.seq, releasedAt: null });
    const saved = await harness.test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, seq: sent.seq } });
    expect(saved.payload).toMatchObject({ kind: "user.message", clientMessageId: messageId, delivery: "queued" });
    expect(await harness.test.db.event.count({ where: { taskId: task.taskId, kind: "turn.held" } })).toBe(1);
  });

  it("F-037: a message to a running turn is delivered whatever the budget says", async () => {
    const task = await taskWith("running");
    const messageId = newMessageId();
    const sent = await (await harness.as(harness.fixture.a.member)).tasks.send({ taskId: task.taskId, clientMessageId: messageId, text: "Also this" });
    expect(sent).toMatchObject({ duplicate: false, held: false });
    expect(steersFor(messageId)).toHaveLength(1);
    expect(await harness.test.db.heldTurn.count({ where: { taskId: task.taskId } })).toBe(0);
  });
});
