import { randomUUID } from "node:crypto";

import { mapTask } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import type { JobPayload } from "@ostra/domain";
import { leaseEpochSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, TaskId } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createJobs } from "./jobs.ts";
import type { Jobs } from "./jobs.ts";
import { onCurrentTask } from "./task-job.ts";
import type { TaskJobOutcome } from "./task-job.ts";

// Ticket 23's cases, ported from spikes/durable-queue-choice/src/scenarios/c1-transactional-enqueue.ts,
// c5-delayed-jobs.ts and c6-panel-no-workers.ts.

let test: TestDatabase;
let fixture: IsolationFixture;
const running: Jobs[] = [];

const start = async (role: "worker" | "enqueue-only"): Promise<Jobs> => {
  const jobs = createJobs({ databaseUrl: test.url, role, pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 5 });
  await jobs.start();
  running.push(jobs);
  return jobs;
};

const stopAll = async (): Promise<void> => {
  for (const jobs of running.splice(0)) {
    await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) {
      throw new Error("timed out");
    }
    await sleep(100);
  }
};

const newTask = async (organizationId: OrganizationId, projectId: ProjectId) =>
  mapTask(
    await test.db.task.create({
      data: {
        organizationId,
        projectId,
        kind: "code",
        source: "prompt",
        title: "Add CONTRIBUTING.md",
        prompt: "never logged",
        branchName: `ostra/${randomUUID().slice(0, 8)}-add-contributing`,
        state: "preparing",
        leaseEpoch: 1,
      },
    }),
  );

const offerTimeout = (organizationId: OrganizationId, taskId: TaskId, epoch = 1): JobPayload<"task.offer-timeout"> => ({
  organizationId,
  taskId,
  leaseEpoch: leaseEpochSchema.parse(epoch),
});

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  // The first worker installs pg-boss's schema and the queues, as core does at start.
  await start("worker");
  await stopAll();
});

afterEach(stopAll);

afterAll(async () => {
  await stopAll();
  await test.dispose();
});

describe("enqueueInTx", () => {
  it("a job enqueued in a rolled-back transaction doesn't exist", async () => {
    const panel = await start("enqueue-only");
    const task = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    const payload = offerTimeout(task.organizationId, task.id);
    await expect(
      test.db.$transaction(async (tx) => {
        await panel.enqueueInTx(tx, "task.offer-timeout", payload);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect(await panel.find("task.offer-timeout", payload)).toEqual([]);

    await test.db.$transaction(async (tx) => {
      await panel.enqueueInTx(tx, "task.offer-timeout", payload);
    });
    const found = await panel.find("task.offer-timeout", payload);
    expect(found.map((job) => job.state)).toEqual(["created"]);
    expect(found[0]?.key).toBe(`task:${task.id}:offer-timeout:1`);
  });

  it("a duplicate key returns the first job", async () => {
    const panel = await start("enqueue-only");
    const task = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    const payload = offerTimeout(task.organizationId, task.id);
    const first = await test.db.$transaction((tx) => panel.sendInTx(tx, "task.offer-timeout", payload, { startAfterMs: 60_000 }));
    const second = await test.db.$transaction((tx) => panel.sendInTx(tx, "task.offer-timeout", payload, { startAfterMs: 60_000 }));
    expect(first.kind).toBe("enqueued");
    expect(second.kind).toBe("existing");
    expect(first.kind === "enqueued" ? first.jobId : null).toBe(second.jobId);
    expect(await panel.find("task.offer-timeout", payload)).toHaveLength(1);

    // Another epoch is another key, so another job.
    const next = await test.db.$transaction((tx) =>
      panel.sendInTx(tx, "task.offer-timeout", offerTimeout(task.organizationId, task.id, 2)),
    );
    expect(next.kind).toBe("enqueued");
  });

  it("refuses a payload that doesn't match its job's schema", async () => {
    const panel = await start("enqueue-only");
    const task = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    // A lease epoch is positive: 0 passes the type but not the schema.
    const bad = { ...offerTimeout(task.organizationId, task.id), leaseEpoch: 0 };
    await expect(
      test.db.$transaction(async (tx) => {
        await panel.enqueueInTx(tx, "task.offer-timeout", bad);
      }),
    ).rejects.toThrow("doesn't match its schema");
  });
});

describe("workers", () => {
  it("a delayed job survives a worker restart, and another can be cancelled", async () => {
    const first = await start("worker");
    const seen: TaskId[] = [];
    await first.work("task.offer-timeout", async ({ payload }) => {
      seen.push(payload.taskId);
      await Promise.resolve();
    });
    const kept = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    const cancelled = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    await test.db.$transaction(async (tx) => {
      await first.enqueueInTx(tx, "task.offer-timeout", offerTimeout(kept.organizationId, kept.id), { startAfterMs: 2_000 });
      await first.enqueueInTx(tx, "task.offer-timeout", offerTimeout(cancelled.organizationId, cancelled.id), {
        startAfterMs: 2_000,
      });
    });
    // The worker goes away before either is due.
    await first.stop({ graceful: true, timeoutMs: 2_000 });
    running.splice(running.indexOf(first), 1);

    const second = await start("worker");
    expect(await test.db.$transaction((tx) => second.cancelInTx(tx, "task.offer-timeout", offerTimeout(cancelled.organizationId, cancelled.id)))).toBe(true);
    await second.work("task.offer-timeout", async ({ payload }) => {
      seen.push(payload.taskId);
      await Promise.resolve();
    });
    await waitFor(() => seen.includes(kept.id));
    await sleep(1_500);
    // Earlier tests leave jobs on this queue too: only this test's two tasks count here.
    expect(seen.filter((id) => id === kept.id || id === cancelled.id)).toEqual([kept.id]);
    const states = await second.find("task.offer-timeout", offerTimeout(cancelled.organizationId, cancelled.id));
    expect(states.map((job) => job.state)).toEqual(["cancelled"]);
    // Nothing left to cancel.
    expect(await second.cancelInTx(null, "task.offer-timeout", offerTimeout(cancelled.organizationId, cancelled.id))).toBe(false);
  });

  it("an enqueue-only instance runs no handler", async () => {
    const panel = await start("enqueue-only");
    await expect(panel.work("task.offer-timeout", () => Promise.resolve())).rejects.toThrow("enqueue-only");
    await expect(panel.schedule("catalog.refresh", "daily", "0 4 * * *", {})).rejects.toThrow("enqueue-only");
    const task = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    const payload = offerTimeout(task.organizationId, task.id);
    await test.db.$transaction((tx) => panel.enqueueInTx(tx, "task.offer-timeout", payload));
    // No worker: the job waits, through several polling intervals.
    await sleep(2_000);
    expect((await panel.find("task.offer-timeout", payload)).map((job) => job.state)).toEqual(["created"]);

    // A worker picks it up.
    const core = await start("worker");
    const seen: TaskId[] = [];
    await core.work("task.offer-timeout", async ({ payload: got }) => {
      seen.push(got.taskId);
      await Promise.resolve();
    });
    await waitFor(() => seen.includes(task.id));
  });

  it("a failing handler is retried", async () => {
    const core = await start("worker");
    const task = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    let calls = 0;
    await core.work("task.offer-timeout", async ({ payload }) => {
      if (payload.taskId === task.id) {
        calls += 1;
        if (calls === 1) {
          throw new Error("the first try fails");
        }
      }
      await Promise.resolve();
    });
    await test.db.$transaction((tx) => core.enqueueInTx(tx, "task.offer-timeout", offerTimeout(task.organizationId, task.id)));
    await waitFor(() => calls >= 2, 30_000);
    await waitFor(async () => {
      const found = await core.find("task.offer-timeout", offerTimeout(task.organizationId, task.id));
      return found[0]?.state === "completed";
    });
    expect(calls).toBe(2);
  });
});

describe("onCurrentTask", () => {
  it("acts on a task still where the job expects it, and skips one that moved on", async () => {
    const core = await start("worker");
    const current = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    const movedOn = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    const otherOrg = await newTask(fixture.b.organization.id, fixture.b.project.id);
    await test.db.task.update({ where: { id: movedOn.id }, data: { leaseEpoch: 2 } });
    const outcomes = new Map<TaskId, TaskJobOutcome>();
    await core.work(
      "task.offer-timeout",
      onCurrentTask(test.db, {
        isCurrent: (task, payload) => task.leaseEpoch === payload.leaseEpoch && task.state === "preparing",
        act: async (tx, task) => {
          await tx.task.update({ where: { id: task.id }, data: { state: "queued" } });
        },
        onOutcome: (outcome, context) => {
          outcomes.set(context.payload.taskId, outcome);
        },
      }),
    );
    await test.db.$transaction(async (tx) => {
      await core.enqueueInTx(tx, "task.offer-timeout", offerTimeout(current.organizationId, current.id));
      await core.enqueueInTx(tx, "task.offer-timeout", offerTimeout(movedOn.organizationId, movedOn.id));
      // A payload that names organization A with organization B's task finds nothing.
      await core.enqueueInTx(tx, "task.offer-timeout", offerTimeout(fixture.a.organization.id, otherOrg.id));
    });
    await waitFor(() => outcomes.size === 3);
    expect(outcomes.get(current.id)).toBe("acted");
    expect(outcomes.get(movedOn.id)).toBe("skipped");
    expect(outcomes.get(otherOrg.id)).toBe("missing");
    const rows = await test.db.task.findMany({ where: { id: { in: [current.id, movedOn.id, otherOrg.id] } } });
    const state = (id: TaskId) => rows.find((row) => row.id === id)?.state;
    expect(state(current.id)).toBe("queued");
    expect(state(movedOn.id)).toBe("preparing");
    expect(state(otherOrg.id)).toBe("preparing");
  });
});

describe("schedules", () => {
  it("stores a schedule under its key and removes it", async () => {
    const core = await start("worker");
    await core.schedule("catalog.refresh", "daily", "0 4 * * *", {});
    const rows = await test.db.$queryRaw<{ name: string; key: string; cron: string }[]>`
      SELECT name, key, cron FROM pgboss.schedule WHERE name = 'catalog.refresh'`;
    expect(rows).toEqual([{ name: "catalog.refresh", key: "daily", cron: "0 4 * * *" }]);
    await core.unschedule("catalog.refresh", "daily");
    const after = await test.db.$queryRaw<unknown[]>`SELECT 1 FROM pgboss.schedule WHERE name = 'catalog.refresh'`;
    expect(after).toEqual([]);
  });
});
