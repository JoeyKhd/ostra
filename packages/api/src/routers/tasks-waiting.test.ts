import { acceptOffer, dispatchTask, dispatchWaitColumns, postgresCommandOutbox } from "@ostra/domain";
import type { DispatchWait } from "@ostra/domain";
import { commandIdSchema, commandSeqSchema, leaseEpochSchema } from "@ostra/protocol";
import type { ProjectId, RunnerId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedPersonalRunner, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";

// Milestone 2's ticket 43 (Q132): `tasks.get` and the task list say why a queued task waits, as
// data the panel words (F-083): the runner its open offer went to, or the reason no runner fits.
// Which path stores which reason is core's test (`apps/core/src/dispatch/waiting.test.ts`).

let harness: ApiHarness;
let projectId: ProjectId;

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "waits")).projectId;
  await harness.test.db.modelProvider.update({ where: { id: world.providerId }, data: { allowOnPersonalRunners: true } });
});

afterAll(async () => {
  await harness.dispose();
});

const reasons: readonly DispatchWait[] = [
  { code: "no-model" },
  { code: "provider-held", until: Date.UTC(2026, 10, 19, 12, 0) },
  { code: "provider-cap", cap: 4 },
  { code: "personal-runner-not-allowed" },
  { code: "personal-runner-unavailable" },
  { code: "no-runner-online" },
  { code: "offer-declined" },
  { code: "offer-timed-out" },
];

const queued = (runnerId: RunnerId | null = null) =>
  seedTask(harness, {
    organizationId: harness.fixture.a.organization.id,
    projectId,
    state: "queued",
    sessionState: "starting",
    creatorMemberId: harness.fixture.a.member.id,
    driverMemberId: harness.fixture.a.member.id,
    runnerId,
  });

const listed = async (task: SeededTask) => {
  const groups = await (await harness.as(harness.fixture.a.member)).tasks.list({ projectId });
  return groups.flatMap((group) => group.tasks).find((row) => row.id === task.taskId);
};

const got = async (task: SeededTask) => (await (await harness.as(harness.fixture.a.member)).tasks.get({ taskId: task.taskId })).waiting;

/** Gives the session the project's profile, so a dispatch finds the model. */
const withProfile = async (task: SeededTask): Promise<void> => {
  const project = await harness.test.db.project.findUniqueOrThrow({ where: { id: projectId } });
  await harness.test.db.session.update({ where: { id: task.sessionId }, data: { agentProfileId: project.defaultCodeProfileId } });
};

const dispatch = (task: SeededTask, epoch = 1) =>
  harness.test.db.$transaction((tx) =>
    dispatchTask(
      { tx, jobs: harness.fakes.jobs, outbox: postgresCommandOutbox, notices: harness.deps.ports.notices, clock: harness.deps.ports.clock },
      { organizationId: harness.fixture.a.organization.id, taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: leaseEpochSchema.parse(epoch) },
    ),
  );

describe("why a queued task waits (Q132)", () => {
  it.each(reasons.map((reason) => [reason.code, reason] as const))("F-014: returns the %s reason, from the task and in the list", async (_code, reason) => {
    const task = await queued();
    await harness.test.db.task.update({ where: { id: task.taskId }, data: dispatchWaitColumns(reason) });
    expect(await got(task)).toEqual({ kind: "no-runner", reason });
    expect((await listed(task))?.waiting).toEqual({ kind: "no-runner", reason });
  });

  it("F-014: returns null just after a task was made, and for a task that isn't queued", async () => {
    const fresh = await queued();
    expect(await got(fresh)).toBeNull();
    expect((await listed(fresh))?.waiting).toBeNull();
    const running = await seedTask(harness, { organizationId: harness.fixture.a.organization.id, projectId, state: "running" });
    await harness.test.db.task.update({ where: { id: running.taskId }, data: dispatchWaitColumns({ code: "no-runner-online" }) });
    expect(await got(running)).toBeNull();
  });

  it("F-014: an open offer reads as offered, with the runner's name; an accepted one reads as nothing, and a declined one as its reason", async () => {
    const runnerId = await seedPersonalRunner(harness, harness.fixture.a.member.id, "build-01");
    await harness.test.db.runnerPresence.create({
      data: { runnerId, organizationId: harness.fixture.a.organization.id, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor: 0 },
    });
    await harness.test.db.runner.update({ where: { id: runnerId }, data: { capacity: 2 } });
    const accepting = await queued(runnerId);
    const declining = await queued(runnerId);
    await withProfile(accepting);
    await withProfile(declining);
    const first = await dispatch(accepting);
    const second = await dispatch(declining);
    if (!first.ok || !second.ok) {
      throw new Error("a dispatch found no runner");
    }
    const lease = await harness.test.db.lease.findFirstOrThrow({ where: { taskId: accepting.taskId, state: "active" } });
    const offered = { kind: "offered", runner: { id: runnerId, name: "build-01" }, since: lease.grantedAt.getTime() };
    expect(await got(accepting)).toEqual(offered);
    expect((await listed(accepting))?.waiting).toEqual(offered);

    const answer = async (commandId: string, result: "accepted" | "rejected") => {
      const command = await harness.test.db.command.findUniqueOrThrow({ where: { id: commandId } });
      return harness.test.db.$transaction((tx) =>
        acceptOffer(
          { tx, jobs: harness.fakes.jobs, notices: harness.deps.ports.notices, clock: harness.deps.ports.clock },
          { runnerId, commandId: commandIdSchema.parse(command.id), seq: commandSeqSchema.parse(command.seq), result },
        ),
      );
    };
    expect(await answer(first.commandId, "accepted")).toMatchObject({ ok: true, outcome: "accepted" });
    expect(await got(accepting)).toBeNull();
    expect(await answer(second.commandId, "rejected")).toMatchObject({ ok: true, outcome: "requeued" });
    expect(await got(declining)).toEqual({ kind: "no-runner", reason: { code: "offer-declined" } });
    expect((await listed(declining))?.waiting).toEqual({ kind: "no-runner", reason: { code: "offer-declined" } });
  });

  it("F-014: another organization's task returns nothing", async () => {
    const task = await queued();
    await harness.test.db.task.update({ where: { id: task.taskId }, data: dispatchWaitColumns({ code: "no-runner-online" }) });
    const outsider = await harness.as(harness.fixture.b.admin);
    await expect(outsider.tasks.get({ taskId: task.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.tasks.list({ projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-014: carries no sentence: a reason is a code and its values only", async () => {
    const task = await queued();
    await harness.test.db.task.update({ where: { id: task.taskId }, data: dispatchWaitColumns({ code: "provider-cap", cap: 2 }) });
    const waiting = await got(task);
    expect(waiting).toEqual({ kind: "no-runner", reason: { code: "provider-cap", cap: 2 } });
    // Milestone 1's English note is still stored for one release, and never returned.
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).dispatchNote).toContain("cap of 2");
    const whole = JSON.stringify(await (await harness.as(harness.fixture.a.member)).tasks.get({ taskId: task.taskId }));
    expect(whole).not.toContain("cap of 2");
    expect(whole).not.toContain("dispatchNote");
  });
});
