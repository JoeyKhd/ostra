import type { Tx } from "@ostra/db";
import { leaseEpochSchema, projectIdSchema, runnerIdSchema, runnerLimits, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { CommandId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { taskFromColumns, taskToColumns } from "../lifecycles/mapping.ts";
import { transitionTask } from "../lifecycles/task.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import { closeItemsOfEndedTaskInTx } from "./needs-you-items.ts";

// F-025: a member stops a task. In the panel's transaction: the task moves to stopped, a `stop`
// command goes to the outbox for the runner holding its lease (the panel never calls core, ADR
// 0016), and a change notice. The runner ends the agent, and pushes the branch and the hidden ref,
// which keep the unfinished work on GitHub. The panel half is written with ticket 33's router, which
// needs it; ticket 27 (core) writes what happens after: the runner's side of the stop and the
// session's end.

export const stopTaskInputSchema = z.strictObject({ taskId: taskIdSchema });
export type StopTaskInput = z.infer<typeof stopTaskInputSchema>;

export type StopTaskResult = UseCaseResult<
  { readonly commandId: CommandId | null },
  "not-found" | "forbidden" | "already-stopped"
>;

export type StopTaskDeps = Pick<Ports, "outbox" | "notices" | "audit" | "clock" | "jobs"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
};

export type StopTask = (deps: StopTaskDeps, input: StopTaskInput) => Promise<StopTaskResult>;

const refuse = (error: Exclude<StopTaskResult, { readonly ok: true }>["error"], message: string): StopTaskResult => ({
  ok: false,
  error,
  message,
});

export const stopTask: StopTask = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  // The task row is locked for this transaction: a stop and a dispatch or a send can't interleave.
  const locked: unknown = await tx.$queryRaw`
    SELECT "id" FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (!Array.isArray(locked) || locked.length === 0) {
    return refuse("not-found", "No such task");
  }
  const task = await tx.task.findUniqueOrThrow({ where: { id: input.taskId } });
  const project = await tx.project.findFirst({ where: { id: task.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return refuse("not-found", "No such task");
  }
  // "Members of the project only": whoever can open the project may stop its tasks.
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read");
  if (!access.ok) {
    return access.code === "not-found" ? refuse("not-found", "No such task") : refuse("forbidden", "You may not stop this task");
  }

  const current = taskFromColumns(task);
  if (!current.ok) {
    throw new Error(`a task row breaks its lifecycle: ${current.reason}`);
  }
  const moved = transitionTask(current.value, { type: "stop", reason: "requested" });
  if (!moved.ok) {
    return refuse("already-stopped", "The task is already stopped");
  }
  await tx.task.update({ where: { id: task.id }, data: taskToColumns(moved.state) });

  const now = deps.clock.now();
  // A stopped task waits on nobody: its open items (no changes, a crash, an approval…) close with it.
  await closeItemsOfEndedTaskInTx(deps, tx, task.id, { at: new Date(now), byMemberId: scope.memberId });
  const lease = await tx.lease.findFirst({ where: { taskId: task.id, state: "active" }, select: { runnerId: true, epoch: true } });
  const session = await tx.session.findFirst({
    where: { taskId: task.id, state: { in: ["starting", "running", "waiting", "idle"] } },
    select: { id: true },
  });
  let commandId: CommandId | null = null;
  if (lease !== null && session !== null) {
    // The runner holding the lease ends the agent and pushes what is there.
    const taskId = taskIdSchema.parse(task.id);
    const queued = await deps.outbox.enqueueInTx(tx, organizationId, runnerIdSchema.parse(lease.runnerId), {
      kind: "stop",
      body: { taskId, sessionId: sessionIdSchema.parse(session.id), leaseEpoch: leaseEpochSchema.parse(lease.epoch), reason: "requested" },
      notAfter: now + runnerLimits.graceMs,
      task: { taskId, projectId: projectIdSchema.parse(task.projectId) },
    });
    commandId = queued.commandId;
  } else if (session !== null) {
    // Never dispatched: no runner has it, so nothing will end the session but this.
    await tx.session.update({ where: { id: session.id }, data: { state: "stopped", endedAt: new Date(now) } });
  }

  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: projectIdSchema.parse(task.projectId),
    actor: { kind: "member", id: scope.memberId },
    action: "task.stopped",
    entity: "task",
    entityId: input.taskId,
    data: { dispatched: lease !== null },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId: projectIdSchema.parse(task.projectId), entity: "task", entityId: input.taskId });
  return { ok: true, commandId };
};
