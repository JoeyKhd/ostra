import { randomBytes } from "node:crypto";

import type { Db } from "@ostra/db";
import { leaseEpochSchema, runnerIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { LeaseEpoch, OrganizationId, ProjectId, RunnerEvent, RunnerId, SessionId, TaskEvent, TaskId } from "@ostra/protocol";

import type { RunnerRef } from "../gateway/context.ts";

// Rows a test of core needs: a runner, and a task leased to it with its box and first session.

export const seedRunner = async (db: Db, organizationId: OrganizationId, ownerMemberId: string): Promise<RunnerRef> => {
  const row = await db.runner.create({
    data: {
      organizationId,
      kind: "personal",
      ownerMemberId,
      name: "laptop",
      publicKey: randomBytes(32).toString("base64url"),
      executor: "host",
      capacity: 1,
      labels: [],
      version: "0.0.0",
      state: "online",
    },
  });
  return { runnerId: runnerIdSchema.parse(row.id), organizationId };
};

export type LeasedTask = {
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly boxId: string;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly leaseEpoch: LeaseEpoch;
};

export const seedLeasedTask = async (
  db: Db,
  runner: RunnerRef,
  projectId: ProjectId,
  options: { readonly state?: "preparing" | "running"; readonly creatorMemberId?: string } = {},
): Promise<LeasedTask> => {
  const task = await db.task.create({
    data: {
      organizationId: runner.organizationId,
      projectId,
      kind: "code",
      source: "prompt",
      title: "Add CONTRIBUTING.md",
      prompt: "Add a short CONTRIBUTING.md that explains how to run the tests",
      branchName: `ostra/${randomBytes(4).toString("hex")}-add-contributing`,
      state: options.state ?? "preparing",
      runnerId: runner.runnerId,
      leaseEpoch: 1,
      ...(options.creatorMemberId === undefined ? {} : { creatorMemberId: options.creatorMemberId, driverMemberId: options.creatorMemberId }),
    },
  });
  const box = await db.box.create({
    data: { organizationId: runner.organizationId, projectId, taskId: task.id, runnerId: runner.runnerId, executor: "host", state: "preparing" },
  });
  await db.lease.create({
    data: { organizationId: runner.organizationId, projectId, taskId: task.id, epoch: 1, runnerId: runner.runnerId, boxId: box.id, state: "active" },
  });
  const session = await db.session.create({
    data: { organizationId: runner.organizationId, projectId, taskId: task.id, boxId: box.id, origin: "new", state: "starting" },
  });
  return {
    taskId: taskIdSchema.parse(task.id),
    sessionId: sessionIdSchema.parse(session.id),
    boxId: box.id,
    organizationId: runner.organizationId,
    projectId,
    leaseEpoch: leaseEpochSchema.parse(1),
  };
};

/** One event as a runner sends it. */
export const runnerEvent = (task: Pick<LeasedTask, "sessionId">, sessionSeq: number, event: TaskEvent, leaseEpoch = 1): RunnerEvent => ({
  sessionId: task.sessionId,
  sessionSeq,
  leaseEpoch,
  at: Date.now(),
  event,
});

export type { RunnerId };
