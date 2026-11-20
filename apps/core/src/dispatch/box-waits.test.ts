import { silentLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { systemClock } from "@ostra/domain";
import { boxIdSchema, organizationIdSchema, projectIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connect, registerPersonal, startGateway } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";
import { seedLeasedTask } from "../testing/seed.ts";
import type { LeasedTask } from "../testing/seed.ts";
import { applyBoxRunnerEvent } from "./box-waits.ts";

// Milestone 5's ticket 20 (F-093): a `kubernetes` runner's `box.waiting` and `box.scheduled`, sent
// as runner events over the real gateway, kept on the box's row (it stays `creating`) and on the
// task's timeline; once for a repeat; never from another runner, or for another organization's box.

let test: TestDatabase;
let fixture: IsolationFixture;
let harness: GatewayHarness;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  harness = await startGateway(test.db, test.url, {
    hooks: {
      runnerEvent: async (runner, frame) => {
        await applyBoxRunnerEvent({ db: test.db, clock: systemClock, logger: silentLogger }, runner, frame);
      },
    },
  });
});

afterAll(async () => {
  await harness.stop();
  await test.dispose();
});

/** A pool runner on `kubernetes` whose dispatch was accepted: its box is `creating`. */
const kubernetesTask = async (member: IsolationFixture["a"]["member"], projectId: string): Promise<{ readonly runner: RegisteredRunner; readonly task: LeasedTask }> => {
  const runner = await registerPersonal(harness, test.db, member);
  await test.db.runner.update({ where: { id: runner.runnerId }, data: { executor: "kubernetes" } });
  const task = await seedLeasedTask(test.db, { runnerId: runner.runnerId, organizationId: organizationIdSchema.parse(member.organizationId) }, projectIdSchema.parse(projectId));
  await test.db.box.update({ where: { id: task.boxId }, data: { state: "creating", executor: "kubernetes" } });
  return { runner, task };
};

const eventsOf = async (taskId: string): Promise<readonly string[]> =>
  (await test.db.event.findMany({ where: { taskId }, orderBy: { seq: "asc" }, select: { kind: true } })).map((row) => row.kind);

const until = async (check: () => Promise<boolean>, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`waited too long for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("a box's wait (ticket 20)", () => {
  it("F-093/c3: box.waiting and box.scheduled from the box's runner keep the wait on its row and the task's timeline, once each", async () => {
    const { runner, task } = await kubernetesTask(fixture.a.member, fixture.a.openProject.id);
    const peer = await connect(harness, runner, { executor: "kubernetes" });
    await peer.next("welcome");
    const boxId = boxIdSchema.parse(task.boxId);
    const since = Date.now() - 5_000;
    const waiting: TaskEvent = { kind: "box.waiting", boxId, reason: "node", since };
    peer.send({ type: "runner-event", at: Date.now(), event: waiting });
    // Sent again, as a runner does on each new connection: nothing more.
    peer.send({ type: "runner-event", at: Date.now(), event: waiting });
    await until(async () => (await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).waitingReason === "node", "the wait on the box's row");
    const waitingRow = await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } });
    expect(waitingRow).toMatchObject({ state: "creating", waitingReason: "node", scheduledAt: null });
    expect(waitingRow.waitingSince?.getTime()).toBe(since);

    peer.send({ type: "runner-event", at: Date.now(), event: { kind: "box.scheduled", boxId, afterMs: 5_000 } });
    peer.send({ type: "runner-event", at: Date.now(), event: { kind: "box.scheduled", boxId, afterMs: 5_000 } });
    await until(async () => (await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).scheduledAt !== null, "the scheduled box");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).toMatchObject({ state: "creating", waitingReason: null, waitingSince: null });
    expect((await eventsOf(task.taskId)).filter((kind) => kind === "box.waiting" || kind === "box.scheduled")).toEqual(["box.waiting", "box.scheduled"]);
    peer.close();
  });

  it("F-093/c3: another runner's word on a box moves nothing, in this organization or another", async () => {
    const { task } = await kubernetesTask(fixture.a.member, fixture.a.openProject.id);
    const stranger = await registerPersonal(harness, test.db, fixture.b.admin);
    const ours = await registerPersonal(harness, test.db, fixture.a.member);
    for (const runner of [stranger, ours]) {
      const peer = await connect(harness, runner, { executor: "kubernetes" });
      await peer.next("welcome");
      peer.send({ type: "runner-event", at: Date.now(), event: { kind: "box.waiting", boxId: boxIdSchema.parse(task.boxId), reason: "image-pull", since: Date.now() } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      peer.close();
    }
    expect(await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).toMatchObject({ waitingReason: null, waitingSince: null });
    expect((await eventsOf(task.taskId)).filter((kind) => kind === "box.waiting")).toEqual([]);
  });
});
