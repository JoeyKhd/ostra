import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { endGraceInTx, startGraceInTx } from "../ingest/grace.ts";
import type { GraceDeps } from "../ingest/grace.ts";
import { startGateway } from "../testing/harness.ts";
import { waitFor } from "../testing/restart.ts";
import { seedLeasedTask, seedRunner } from "../testing/seed.ts";

// Ticket 21 (F-043, F-045): a replica killed with `kill -9` never runs its sockets' close handlers,
// so the presence rows of the runners it held still say "connected" and no task grace starts. A
// runner that comes back reconnects, but one that doesn't would leave its tasks running forever.
// Every replica's presence pass now closes a presence no replica has refreshed within the dead
// time, as a disconnect would, and the grace starts; it's a job in the database, so it outlives
// the restart and still fires.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let graceDeps: GraceDeps;
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  graceDeps = { jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, logger, graceMs: 60_000 };
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("a runner whose replica died (F-043)", () => {
  it("is marked gone by the next replica's presence pass, and its task's grace starts and fires", async () => {
    const runner = await seedRunner(test.db, fixture.a.organization.id, fixture.a.member.id);
    const task = await seedLeasedTask(test.db, runner, fixture.a.openProject.id, { state: "running" });
    // The dead replica's row: connected, last refreshed a minute ago.
    await test.db.runnerPresence.create({
      data: { runnerId: runner.runnerId, organizationId: runner.organizationId, replicaId: "core:dead", connectionEpoch: 3, carrier: "websocket", minor: 1, lastSeenAt: new Date(Date.now() - 60_000) },
    });
    // Another organization's runner, refreshed just now by its live replica: left alone.
    const live = await seedRunner(test.db, fixture.b.organization.id, fixture.b.admin.id);
    await test.db.runnerPresence.create({
      data: { runnerId: live.runnerId, organizationId: live.organizationId, replicaId: "core:alive", connectionEpoch: 1, carrier: "websocket", minor: 1 },
    });
    const harness = await startGateway(test.db, test.url, {
      hooks: { onDisconnectedInTx: (tx, ref) => startGraceInTx(graceDeps, tx, ref) },
      timers: { presenceMs: 100, deadMs: 5_000 },
    });
    try {
      await waitFor("the dead replica's presence closed", async () => (await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId: runner.runnerId } })).disconnectedAt !== null, 20_000);
    } finally {
      await harness.stop();
    }
    const grace = await jobs.find("task.grace", { organizationId: task.organizationId, taskId: task.taskId, leaseEpoch: task.leaseEpoch });
    expect(grace).toHaveLength(1);
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "runner.lost" } })).toBe(1);
    expect((await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId: live.runnerId } })).disconnectedAt).toBeNull();
    // The grace is a row of the queue: it fires after any restart, and stops the task cleanly.
    const outcome = await test.db.$transaction(async (tx) => {
      const row = await tx.task.findUniqueOrThrow({ where: { id: task.taskId } });
      return endGraceInTx(graceDeps, tx, row, { organizationId: task.organizationId, taskId: task.taskId, leaseEpoch: task.leaseEpoch });
    });
    expect(outcome).toBe("stopped");
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "stopped", stoppedReason: "runner_lost" });
  });
});
