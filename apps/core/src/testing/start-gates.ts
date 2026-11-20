import { Prisma } from "@ostra/db";
import type { Db } from "@ostra/db";
import { dispatchTask, postgresChangeNotices, postgresCommandOutbox } from "@ostra/domain";
import type { Clock, JobQueue } from "@ostra/domain";
import { seedPool, seedQueuedTask, seedRunner } from "@ostra/domain/testing";
import { leaseEpochSchema, sessionIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, TaskId } from "@ostra/protocol";
import { expect } from "vitest";

// Milestone 6 (F-011, F-106, F-107; tickets 10 and 11): a task an automation or a bulk start made
// goes through the same gates as any start, at its dispatch (milestone 4's budget, milestone 5's
// labels and a project's share of a pool). Each gate is closed in turn, the real dispatch runs, and
// the task is left queued with that gate's reason, never refused. The rows each gate needs are
// removed after it.

export type GateEnv = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly clock: Clock;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
};

const dispatchOnce = async (env: GateEnv, taskId: TaskId): Promise<unknown> => {
  const session = await env.db.session.findFirstOrThrow({ where: { taskId, state: "starting" }, select: { id: true } });
  const result = await env.db.$transaction((tx) =>
    dispatchTask(
      { tx, jobs: env.jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: env.clock },
      { organizationId: env.organizationId, taskId, sessionId: sessionIdSchema.parse(session.id), leaseEpoch: leaseEpochSchema.parse(1) },
    ),
  );
  expect(result).toMatchObject({ ok: false, error: "no-runner" });
  const row = await env.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { state: true, dispatchWait: true } });
  expect(row.state).toBe("queued");
  return row.dispatchWait;
};

/**
 * Closes the budget, then (with `labels`) offers only a runner without them, then fills the
 * project's share of a pool, dispatching the task after each: it stays queued with each reason.
 * A ticket task's prompt is written first, as `ticket.fetch-context` leaves it.
 */
export const expectStartGates = async (env: GateEnv, taskId: TaskId, labels: readonly string[]): Promise<void> => {
  const { db, organizationId, projectId } = env;
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { prompt: true, state: true } });
  expect(task.state).toBe("queued");
  if (task.prompt === null) {
    await db.task.update({ where: { id: taskId }, data: { prompt: "The rendered ticket" } });
  }

  // 1. The budget (milestone 4, F-037): a project budget already spent holds the dispatch.
  const session = await db.session.findFirstOrThrow({ where: { taskId, state: "starting" }, select: { modelId: true } });
  expect(session.modelId).not.toBeNull();
  const prices = { inputPricePerMTok: new Prisma.Decimal(3), outputPricePerMTok: new Prisma.Decimal(15) };
  await db.model.update({ where: { id: session.modelId ?? "" }, data: prices });
  const budget = await db.budget.create({ data: { organizationId, projectId, monthlyMicroUsd: 0n } });
  try {
    expect(await dispatchOnce(env, taskId)).toMatchObject({ code: "budget-reached" });
  } finally {
    await db.budget.delete({ where: { id: budget.id } });
  }

  const pools: string[] = [];
  const runners: string[] = [];
  try {
    // 2. The labels (milestone 5, F-069): the automation's pool labels reach admission.
    if (labels.length > 0) {
      const { poolId } = await seedPool(db, { organizationId, projects: [{ projectId }] });
      pools.push(poolId);
      runners.push((await seedRunner(db, { organizationId, poolId, slots: 4, labels: [] })).runnerId);
      const wait = await dispatchOnce(env, taskId);
      expect(wait).toMatchObject({ code: "no-runner-with-labels" });
      expect(wait).toHaveProperty("labels", expect.arrayContaining([...labels]));
      await db.projectPool.deleteMany({ where: { poolId } });
    }
    // 3. A project's share of a pool (milestone 5, F-067): another task of the project holds it.
    const { poolId } = await seedPool(db, { organizationId, projects: [{ projectId, maxBoxes: 1 }] });
    pools.push(poolId);
    const { runnerId } = await seedRunner(db, { organizationId, poolId, slots: 4, labels: [...labels] });
    runners.push(runnerId);
    const filler = await seedQueuedTask(db, { organizationId, projectId });
    await db.task.update({ where: { id: filler.taskId }, data: { state: "running", runnerId } });
    await db.box.create({ data: { organizationId, projectId, taskId: filler.taskId, runnerId, executor: "docker", state: "ready" } });
    expect(await dispatchOnce(env, taskId)).toMatchObject({ code: "project-share-reached", poolId, cap: 1 });
    await db.box.updateMany({ where: { taskId: filler.taskId }, data: { state: "stopped", stoppedAt: new Date() } });
    await db.task.update({ where: { id: filler.taskId }, data: { state: "stopped", stoppedReason: "requested" } });
  } finally {
    await db.projectPool.deleteMany({ where: { poolId: { in: pools } } });
    await db.runner.updateMany({ where: { id: { in: runners } }, data: { state: "offline" } });
  }
};
