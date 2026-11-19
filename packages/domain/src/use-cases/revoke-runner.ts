import type { Logger } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { projectIdSchema, runnerIdSchema, taskIdSchema } from "@ostra/protocol";
import type { RunnerId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import { runnerFromColumns } from "../lifecycles/mapping.ts";
import { transitionRunner } from "../lifecycles/runner.ts";
import { notifyRunnerInTx } from "../postgres-outbox.ts";
import type { Ports } from "../ports.ts";
import { requeueTaskInTx } from "./admission.ts";
import type { UseCaseResult } from "./common.ts";
import { moveSessionInTx, moveTaskInTx } from "./moves.ts";

// Q131, F-091, F-045 (milestone 2's ticket 41): revoking a runner, at once and in one transaction.
//
// - The runner becomes `revoked`, with `revokedAt`, from any state but `revoked`.
// - Every active lease of it ends (`runner-revoked`) and its task's epoch goes up, so a late write
//   from the old lease is refused (F-045). There is no grace: a revoked runner can't come back.
// - Each of those tasks stops as `runner_lost`, its session stops, and its box moves as the
//   grace's end moves it (`apps/core/src/ingest/grace.ts`). Each is ready to reopen elsewhere.
// - The gateway is told (`revoked`): the replica that holds the runner sends `evict` and closes
//   with 4403.
// - An audit entry: who, which runner, how many tasks it stopped.
//
// An organization admin revokes any runner of the organization; a member, a personal runner they
// own. Another organization's runner is `not-found`. A runner already revoked answers the same
// and changes nothing.
//
// Locks are taken in the order the dispatch, a stop and the outbox take them: the task rows
// first, by ID, then the runner's row.

export const revokeRunnerInputSchema = z.strictObject({ runnerId: runnerIdSchema });
export type RevokeRunnerInput = z.infer<typeof revokeRunnerInputSchema>;

export type RevokeRunnerResult = UseCaseResult<
  {
    readonly runnerId: RunnerId;
    /** `true` when it was revoked already: nothing changed. */
    readonly alreadyRevoked: boolean;
    /** The tasks the revoke stopped. */
    readonly stoppedTaskIds: readonly TaskId[];
  },
  "not-found" | "forbidden"
>;

export type RevokeRunnerDeps = Pick<Ports, "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  /** Milestone 5: sends an unaccepted offer's next dispatch at once; without it, the queue's sweep does. */
  readonly jobs?: Ports["jobs"];
  readonly scope: MemberScope;
  readonly logger?: Logger;
};

export type RevokeRunner = (deps: RevokeRunnerDeps, input: RevokeRunnerInput) => Promise<RevokeRunnerResult>;

/** Why a revoked runner's lease ended (`Lease.endReason`). */
export const RUNNER_REVOKED_END_REASON = "runner-revoked";

const lockedRunnerSchema = z.looseObject({
  state: z.enum(["joining", "online", "offline", "draining", "revoked"]),
  revokedAt: z.date().nullable(),
});

const ACTIVE_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;

export const revokeRunner: RevokeRunner = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const runner = await tx.runner.findFirst({
    where: { id: input.runnerId, organizationId },
    select: { id: true, kind: true, ownerMemberId: true, state: true, revokedAt: true },
  });
  if (runner === null) {
    return { ok: false, error: "not-found", message: "No such runner" };
  }
  const mayRevoke = scope.role === "admin" || (runner.kind === "personal" && runner.ownerMemberId === scope.memberId);
  if (!mayRevoke) {
    return { ok: false, error: "forbidden", message: "Only an admin, or the member who owns a personal runner, may revoke it" };
  }

  // The tasks the runner holds a lease of, locked before the runner's row.
  const leased = await tx.lease.findMany({ where: { runnerId: runner.id, organizationId, state: "active" }, select: { taskId: true } });
  const lockedTaskIds = new Set<string>();
  const lockTasks = async (taskIds: readonly string[]): Promise<void> => {
    for (const taskId of [...new Set(taskIds)].filter((id) => !lockedTaskIds.has(id)).sort()) {
      await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${taskId} AND "organizationId" = ${organizationId} FOR UPDATE`;
      lockedTaskIds.add(taskId);
    }
  };
  await lockTasks(leased.map((lease) => lease.taskId));
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT "state", "revokedAt" FROM "runner" WHERE "id" = ${runner.id} AND "organizationId" = ${organizationId} FOR NO KEY UPDATE`;
  const current = lockedRunnerSchema.parse(locked[0]);
  const runnerId = runnerIdSchema.parse(runner.id);
  if (current.revokedAt !== null || current.state === "revoked") {
    return { ok: true, runnerId, alreadyRevoked: true, stoppedTaskIds: [] };
  }
  const before = runnerFromColumns({ state: current.state });
  const moved = before.ok ? transitionRunner(before.value, { type: "revoke" }) : null;
  if (moved?.ok !== true) {
    throw new Error("a runner that isn't revoked refused the revoke");
  }

  const now = new Date(deps.clock.now());
  await tx.runner.update({ where: { id: runner.id }, data: { state: moved.state.state, revokedAt: now } });

  // A lease granted between the first read and the runner's lock: its task is locked now too.
  const leases = await tx.lease.findMany({
    where: { runnerId: runner.id, organizationId, state: "active" },
    select: { id: true, taskId: true, epoch: true, boxId: true },
    orderBy: { taskId: "asc" },
  });
  await lockTasks(leases.map((lease) => lease.taskId));

  const moveDeps = { tx, notices: deps.notices, ...(deps.logger === undefined ? {} : { logger: deps.logger }) };
  const stoppedTaskIds: TaskId[] = [];
  for (const lease of leases) {
    await tx.lease.update({ where: { id: lease.id }, data: { state: "ended", endedAt: now, endReason: RUNNER_REVOKED_END_REASON } });
    // The fence: from here on, a write carrying the old epoch is refused (F-045).
    const row = await tx.task.update({ where: { id: lease.taskId }, data: { leaseEpoch: { increment: 1 } } });
    const task = mapTask(row);
    if (row.state === "queued" && runner.kind === "pool") {
      // Milestone 5 (F-067, ADR 0059): an offer a pool runner never accepted. The task goes back to
      // its pools' queue with its first time, so it keeps its place; nothing of it ran on this
      // runner. A personal runner's task has nowhere else to go, so it stops, as before.
      await requeueTaskInTx(deps, tx, { organizationId, taskId: task.id, endReason: RUNNER_REVOKED_END_REASON, boxReason: "the runner was revoked", wait: null });
      continue;
    }
    await moveTaskInTx(moveDeps, task, { type: "stop", reason: "runner_lost" });
    const session = await tx.session.findFirst({
      where: { taskId: task.id, state: { in: [...ACTIVE_SESSION_STATES] } },
      orderBy: { startedAt: "desc" },
    });
    if (session !== null) {
      await moveSessionInTx(moveDeps, session, { type: "stop" });
    }
    await tx.box.updateMany({ where: { id: lease.boxId, state: { in: ["ready", "idle"] } }, data: { state: "stopped" } });
    await tx.box.updateMany({
      where: { id: lease.boxId, state: { in: ["creating", "preparing"] } },
      data: { state: "failed", failedReason: "the runner was revoked" },
    });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: projectIdSchema.parse(row.projectId),
      actor: { kind: "member", id: scope.memberId },
      action: "task.stopped",
      entity: "task",
      entityId: taskIdSchema.parse(task.id),
      data: { reason: "runner_lost", runnerRevoked: true, leaseEpoch: lease.epoch },
    });
    stoppedTaskIds.push(taskIdSchema.parse(task.id));
  }

  // The replica that holds its connection sends `evict` and closes with 4403.
  await notifyRunnerInTx(tx, { kind: "revoked", runnerId });
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: null,
    actor: { kind: "member", id: scope.memberId },
    action: "runner.revoked",
    entity: "runner",
    entityId: runnerId,
    data: { kind: runner.kind, from: current.state, stoppedTasks: stoppedTaskIds.length },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "runner", entityId: runnerId });
  deps.logger?.info("runner.revoked", { runnerId, stoppedTasks: stoppedTaskIds.length });
  return { ok: true, runnerId, alreadyRevoked: false, stoppedTaskIds };
};
