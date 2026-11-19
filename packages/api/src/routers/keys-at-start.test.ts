import { dispatchTask, dispatchWaitFromDb, releaseProviderBoxes } from "@ostra/domain";
import { clientMessageIdSchema, leaseEpochSchema, organizationIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedBoard, seedConnectionAndModel, seedLease, seedLinearConnection, seedPersonalRunner, seedProject, seedTask, seedTicket } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 48 (F-135, ADR 0065): the "no key" reason where a member starts a task, and the queued
// ticket task's needs-you item, which organization admins see and members don't.

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
});

afterAll(async () => {
  await harness.dispose();
});

/** Gives a project its own list with these providers (an organization admin's save, written directly). */
const setOwnList = async (projectId: ProjectId, providerIds: readonly string[]): Promise<void> => {
  const organizationId = harness.fixture.a.organization.id;
  await harness.test.db.providerListEntry.deleteMany({ where: { organizationId, projectId } });
  await harness.test.db.project.update({ where: { id: projectId }, data: { ownProviders: true } });
  for (const providerId of providerIds) {
    await harness.test.db.providerListEntry.create({ data: { organizationId, projectId, providerId } });
  }
};

describe("keys per project at a task's start", () => {
  it("F-135: New task is refused with the no-key reason when nothing on the project's list serves the model, before anything is made", async () => {
    const { projectId } = await seedProject(harness, world, "keys-new-task");
    // The organization's first provider is on the default list, so the project serves the model.
    expect(await harness.test.db.providerListEntry.count({ where: { organizationId: harness.fixture.a.organization.id, projectId: null, providerId: world.providerId } })).toBe(1);
    const member = await harness.as(harness.fixture.a.member);
    await setOwnList(projectId, []);
    const tasksBefore = await harness.test.db.task.count({ where: { projectId } });
    const refused = member.tasks.create({ projectId, prompt: "Add a CONTRIBUTING.md" });
    await expect(refused).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(refused).rejects.toThrow(/No provider on this project's list serves/);
    expect(await harness.test.db.task.count({ where: { projectId } })).toBe(tasksBefore);
    expect(await harness.test.db.session.count({ where: { projectId } })).toBe(0);
    // With the provider on its list again, the same start goes, and the session records it.
    await setOwnList(projectId, [world.providerId]);
    const created = await member.tasks.create({ projectId, prompt: "Add a CONTRIBUTING.md" });
    expect(await harness.test.db.session.findUniqueOrThrow({ where: { id: created.sessionId } })).toMatchObject({ providerId: world.providerId, modelId: world.modelId });
  });

  it("F-135: a ticket task no provider serves any more waits queued with the reason, and its needs-you item is for organization admins, not members", async () => {
    const { projectId } = await seedProject(harness, world, "keys-ticket");
    const linear = await seedLinearConnection(harness);
    const boardId = await seedBoard(harness, { projectId, connectionId: linear, key: "KEY" });
    const ticketId = await seedTicket(harness, { projectId, boardId, connectionId: linear, key: "KEY-1", title: "Fix the cart total" });
    const member = await harness.as(harness.fixture.a.member);
    const admin = await harness.as(harness.fixture.a.admin);
    // The start refuses with the same reason before it makes anything.
    await setOwnList(projectId, []);
    const refused = member.tasks.startFromTicket({ projectId, ticketId });
    await expect(refused).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(refused).rejects.toThrow(/No provider on this project's list serves/);
    expect(await harness.test.db.task.count({ where: { ticketId } })).toBe(0);

    await setOwnList(projectId, [world.providerId]);
    const started = await member.tasks.startFromTicket({ projectId, ticketId });
    // `ticket.fetch-context` renders the ticket first: a ticket task's dispatch waits for its prompt.
    await harness.test.db.task.update({ where: { id: started.taskId }, data: { prompt: "Fix the cart total" } });
    // An admin takes the provider off the project's list before the dispatch: the release job
    // (`providers.release-boxes`) clears what the waiting session recorded, and the dispatch resolves again.
    await setOwnList(projectId, []);
    const organizationId = organizationIdSchema.parse(harness.fixture.a.organization.id);
    const { ports } = harness.deps;
    expect(await releaseProviderBoxes({ db: harness.test.db, ...ports }, { organizationId, projectId })).toMatchObject({ reset: 1 });
    const result = await harness.test.db.$transaction((tx) =>
      dispatchTask(
        { tx, ...ports },
        { organizationId, taskId: taskIdSchema.parse(started.taskId), sessionId: sessionIdSchema.parse(started.sessionId), leaseEpoch: leaseEpochSchema.parse(1) },
      ),
    );
    expect(result).toMatchObject({ ok: false, error: "no-runner", message: "no-provider-for-model" });
    const task = await harness.test.db.task.findUniqueOrThrow({ where: { id: started.taskId } });
    expect(task.state).toBe("queued");
    expect(dispatchWaitFromDb(task.dispatchWait)).toEqual({ code: "no-provider-for-model", modelName: "world-model" });
    expect(await harness.test.db.lease.count({ where: { taskId: started.taskId } })).toBe(0);
    const item = await harness.test.db.needsYouItem.findFirstOrThrow({ where: { taskId: started.taskId, state: "open" } });
    expect(item).toMatchObject({ reason: "no_provider_for_model", audience: "organization_admins" });
    // The sweep tries again: still one item.
    await harness.test.db.$transaction((tx) =>
      dispatchTask(
        { tx, ...ports },
        { organizationId, taskId: taskIdSchema.parse(started.taskId), sessionId: sessionIdSchema.parse(started.sessionId), leaseEpoch: leaseEpochSchema.parse(1) },
      ),
    );
    expect(await harness.test.db.needsYouItem.count({ where: { taskId: started.taskId, state: "open" } })).toBe(1);

    const adminRows = (await admin.home.needsYou({})).rows.map((row) => row.taskId);
    const memberRows = (await member.home.needsYou({})).rows.map((row) => row.taskId);
    expect(adminRows).toContain(started.taskId);
    expect(memberRows).not.toContain(started.taskId);
    // Ticket 50: the row names the model, for "No key for {model}".
    expect((await admin.home.needsYou({})).rows.find((row) => row.taskId === started.taskId)?.detail).toEqual({ reason: "no_provider_for_model", modelName: "world-model" });
    // Another organization's admin sees nothing of it.
    const outsider = await harness.as(harness.fixture.b.admin);
    expect((await outsider.home.needsYou({})).rows.map((row) => row.taskId)).not.toContain(started.taskId);

    // An admin puts the provider back: the next dispatch resolves it, and the item is closed.
    await setOwnList(projectId, [world.providerId]);
    await harness.test.db.$transaction((tx) =>
      dispatchTask(
        { tx, ...ports },
        { organizationId, taskId: taskIdSchema.parse(started.taskId), sessionId: sessionIdSchema.parse(started.sessionId), leaseEpoch: leaseEpochSchema.parse(1) },
      ),
    );
    expect(await harness.test.db.needsYouItem.count({ where: { taskId: started.taskId, state: "open" } })).toBe(0);
    expect(await harness.test.db.session.findUniqueOrThrow({ where: { id: started.sessionId } })).toMatchObject({ providerId: world.providerId, modelId: world.modelId });
  });

  it("F-135: the composer's message at a turn start on a provider the project dropped starts a fresh session, and a running turn still takes it", async () => {
    const organizationId = organizationIdSchema.parse(harness.fixture.a.organization.id);
    const { projectId } = await seedProject(harness, world, "keys-send");
    const runnerId = await seedPersonalRunner(harness, harness.fixture.a.admin.id, "keys-send-runner");
    const member = await harness.as(harness.fixture.a.member);
    const taskWith = async (sessionState: "running" | "idle") => {
      const task = await seedTask(harness, { organizationId, projectId, state: "running", driverMemberId: harness.fixture.a.member.id, sessionState });
      await seedLease(harness, task, organizationId, projectId, runnerId);
      await harness.test.db.session.update({ where: { id: task.sessionId }, data: { providerId: world.providerId, modelId: world.modelId } });
      return task;
    };
    const idle = await taskWith("idle");
    const running = await taskWith("running");
    await setOwnList(projectId, []);
    const steersFor = (clientMessageId: string) =>
      harness.fakes.outbox.commands.filter((command) => command.kind === "steer" && Reflect.get(command.body, "clientMessageId") === clientMessageId);

    // Idle: the message would start a turn on a key the project no longer allows, so no steer goes to that box.
    const idleMessage = clientMessageIdSchema.parse(`client-${crypto.randomUUID()}`);
    const sent = await member.tasks.send({ taskId: idle.taskId, clientMessageId: idleMessage, text: "One more thing" });
    expect(sent).toMatchObject({ duplicate: false });
    expect(steersFor(idleMessage)).toHaveLength(0);
    expect((await harness.test.db.session.findUniqueOrThrow({ where: { id: idle.sessionId } })).state).toBe("stopped");
    const fresh = await harness.test.db.session.findFirstOrThrow({ where: { taskId: idle.taskId, state: "starting" } });
    expect(fresh).toMatchObject({ providerId: null, modelId: null });
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: idle.taskId } })).state).toBe("queued");
    expect(await harness.test.db.event.findFirst({ where: { taskId: idle.taskId, seq: sent.seq } })).toMatchObject({ sessionId: fresh.id, kind: "user.message" });

    // Running: the turn going finishes on the key it started with, so the message is part of it.
    const runningMessage = clientMessageIdSchema.parse(`client-${crypto.randomUUID()}`);
    await member.tasks.send({ taskId: running.taskId, clientMessageId: runningMessage, text: "Also this" });
    expect(steersFor(runningMessage)).toHaveLength(1);
    expect(await harness.test.db.session.count({ where: { taskId: running.taskId } })).toBe(1);
  });
});
