import type { Logger } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { mapTask } from "@ostra/db";
import { leaseEpochSchema, memberIdSchema, poolIdSchema, projectIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { LeaseEpoch, OrganizationId, PoolId, ProjectId, RunnerId, SessionId, TaskId } from "@ostra/protocol";

import { requireOrganizationAdmin, requireProjectAccess } from "../access.ts";
import { dispatchWaitColumns, dispatchWaitFromDb } from "../dispatch-wait.ts";
import type { DispatchWait } from "../dispatch-wait.ts";
import type { AgentEffortLevels } from "../effort/levels.ts";
import { queuePriorityFor } from "../fleet/queue.ts";
import type { Ports } from "../ports.ts";
import { DEFAULT_PERSONAL_RUNNER_SLOTS, projectPoolsInTx } from "./fleet-rows.ts";
import { dispatchTask, TASK_BUSY } from "./dispatch-task.ts";
import type { ReopenDispatchSettings } from "./dispatch-task.ts";
import type { AdmitQueued, CancelQueuedTask, QueueTask } from "./m5-signatures.ts";
import { moveTaskInTx } from "./moves.ts";
import { appendServerEvent } from "./server-events.ts";

// The pool queue and its admission (F-067, ADR 0059, ticket 13).
//
// - A queued task waits in the queue of every pool of its project (or the organization's default
//   pool, for a project that lists none): a query over tasks, never a stored list, in `queueOrder`.
// - `queue.admit`, keyed by pool, walks that queue and, for each task in its own transaction,
//   counts the pool's and the project's boxes from `Box` rows under the pools' row locks, chooses a
//   runner (`chooseRunner`) and grants the lease and the offer, or records why the task waits and
//   its place (`dispatchTask` does each one). A project at its share is passed over, and the next
//   task considered.
// - A personal runner's tasks are admitted against that runner's slots, outside any pool: their
//   `task.dispatch` grants them under the runner's row lock.
// - A task that goes back to the queue (an offer declined or timed out, a revoked runner, a box
//   with no node or no room) keeps its first `queuedAt`, so it keeps its place.

/** How many queued tasks one pass of a pool's admission considers. */
export const ADMIT_PASS_MAX = 100;

/** Whether a task goes to its member's personal runner: a member started it and picked one. */
export const goesToPersonalRunner = (task: { readonly creatorMemberId: string | null; readonly runnerId: string | null }): boolean =>
  task.creatorMemberId !== null && task.runnerId !== null;

/** Sends `queue.admit` for each pool, in the caller's transaction (one job per pool at a time). */
export const enqueueAdmissionInTx = async (
  deps: Pick<Ports, "jobs">,
  tx: Tx,
  organizationId: OrganizationId,
  poolIds: readonly PoolId[],
): Promise<void> => {
  for (const poolId of [...new Set(poolIds)].sort()) {
    await deps.jobs.enqueueInTx(tx, "queue.admit", { organizationId, poolId });
  }
};

/** Sends `queue.admit` for the pools a project may use: a share changed, or a box of it freed room. */
export const enqueueProjectAdmissionInTx = async (deps: Pick<Ports, "jobs">, tx: Tx, organizationId: OrganizationId, projectId: ProjectId): Promise<void> => {
  const pools = await projectPoolsInTx(tx, organizationId, projectId);
  await enqueueAdmissionInTx(
    deps,
    tx,
    organizationId,
    pools.map((entry) => entry.poolId),
  );
};

/** Sends `queue.admit` for a runner's pool: it came online, reported more room, or a box on it freed. */
export const enqueueRunnerAdmissionInTx = async (deps: Pick<Ports, "jobs">, tx: Tx, organizationId: OrganizationId, runnerId: RunnerId): Promise<void> => {
  const runner = await tx.runner.findFirst({ where: { id: runnerId, organizationId }, select: { poolId: true } });
  const poolId = runner?.poolId ?? null;
  if (poolId !== null) {
    await enqueueAdmissionInTx(deps, tx, organizationId, [poolIdSchema.parse(poolId)]);
  }
};

export const queueTask: QueueTask = async (deps, input) => {
  const { tx } = deps;
  const row = await tx.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: {
      state: true,
      projectId: true,
      creatorMemberId: true,
      runnerId: true,
      queuedAt: true,
      agentProfileId: true,
      ticket: { select: { priority: true } },
      sessions: { where: { state: "starting" }, select: { agentProfileId: true, startedAt: true }, orderBy: { startedAt: "desc" }, take: 1 },
    },
  });
  if (row === null) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  if (row.state !== "queued") {
    return { ok: false, error: "not-queued", message: "The task isn't queued" };
  }
  const profileId = row.sessions[0]?.agentProfileId ?? row.agentProfileId;
  const profile = profileId === null ? null : await tx.agentProfile.findFirst({ where: { id: profileId, organizationId: input.organizationId }, select: { runnerLabels: true } });
  const queuePriority = queuePriorityFor(row.ticket?.priority);
  await tx.task.update({
    where: { id: input.taskId },
    data: {
      queuePriority,
      requiredLabels: [...new Set(profile?.runnerLabels ?? [])].sort(),
      // A requeue keeps its first time, so it keeps its place. A task's first time is when its start
      // was asked for (its starting session's), not when this job ran: dispatch jobs run late and in
      // any order, and the queue keeps the order tasks came in.
      ...(input.keepPlace && row.queuedAt !== null ? {} : { queuedAt: row.sessions[0]?.startedAt ?? new Date(deps.clock.now()) }),
    },
  });
  const poolIds = goesToPersonalRunner(row) ? [] : (await projectPoolsInTx(tx, input.organizationId, projectIdSchema.parse(row.projectId))).map((entry) => entry.poolId);
  await enqueueAdmissionInTx(deps, tx, input.organizationId, poolIds);
  return { ok: true, queuePriority, poolIds };
};

/** A task in a pool's queue, as the admission walks it. */
export type PoolQueueEntry = {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly sessionId: SessionId;
  readonly leaseEpoch: number;
  readonly queuePriority: number;
  readonly queuedAt: Date | null;
};

/**
 * A pool's queue (ADR 0059): the queued tasks of the projects that may use it, with no offer out
 * and a session waiting to start, that don't go to a personal runner, in `queueOrder`.
 */
export const poolQueueInTx = async (
  tx: Tx | Db,
  organizationId: OrganizationId,
  poolId: PoolId,
  limit = ADMIT_PASS_MAX,
): Promise<readonly PoolQueueEntry[]> => {
  const pool = await tx.runnerPool.findFirst({ where: { id: poolId, organizationId }, select: { isDefault: true } });
  if (pool === null) {
    return [];
  }
  const rows = await tx.task.findMany({
    where: {
      organizationId,
      state: "queued",
      leases: { none: { state: "active" } },
      sessions: { some: { state: "starting" } },
      NOT: { creatorMemberId: { not: null }, runnerId: { not: null } },
      project: pool.isDefault ? { OR: [{ pools: { some: { poolId } } }, { pools: { none: {} } }] } : { pools: { some: { poolId } } },
    },
    select: {
      id: true,
      projectId: true,
      leaseEpoch: true,
      queuePriority: true,
      queuedAt: true,
      sessions: { where: { state: "starting" }, select: { id: true }, orderBy: { startedAt: "desc" }, take: 1 },
    },
    orderBy: [{ queuePriority: "asc" }, { queuedAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
    take: limit,
  });
  return rows.flatMap((row) => {
    const [session] = row.sessions;
    return session === undefined
      ? []
      : [
          {
            taskId: taskIdSchema.parse(row.id),
            projectId: projectIdSchema.parse(row.projectId),
            sessionId: sessionIdSchema.parse(session.id),
            leaseEpoch: row.leaseEpoch,
            queuePriority: row.queuePriority,
            queuedAt: row.queuedAt,
          },
        ];
  });
};

/** What the admission needs beyond the ports: what `dispatchTask` reads. */
export type AdmitDeps = { readonly db: Db } & Pick<Ports, "jobs" | "outbox" | "notices" | "clock"> & {
  readonly logger?: Logger;
  readonly reopen?: ReopenDispatchSettings;
  readonly effortLevels?: AgentEffortLevels;
  /** `OSTRA_PERSONAL_RUNNER_CAPACITY`. */
  readonly personalSlots?: number;
};

/**
 * One pass of a pool's admission (`queue.admit`). Each task is its own transaction: it takes the
 * task's row (skipping one another writer holds), then the pools' rows, counts, chooses and grants
 * or records the reason, so a share or a cap holds across replicas.
 */
export const admitQueued = async (
  deps: AdmitDeps,
  input: Parameters<AdmitQueued>[1],
): ReturnType<AdmitQueued> => {
  const queue = await poolQueueInTx(deps.db, input.organizationId, input.poolId);
  const admitted: { readonly taskId: TaskId; readonly runnerId: RunnerId; readonly leaseEpoch: LeaseEpoch }[] = [];
  const passed: TaskId[] = [];
  // Once a task waits because this pool is full, or its project is at its share of this pool, no
  // task behind it in this pass takes that room: a slot that frees during the pass goes to the head
  // of the queue at the next pass, not to whichever task the pass reaches next.
  let poolFull = false;
  const atShare = new Set<string>();
  for (const entry of queue) {
    if (poolFull || atShare.has(entry.projectId)) {
      passed.push(entry.taskId);
      continue;
    }
    const payload = {
      organizationId: input.organizationId,
      taskId: entry.taskId,
      sessionId: entry.sessionId,
      leaseEpoch: leaseEpochSchema.parse(entry.leaseEpoch + 1),
    };
    const result = await deps.db
      .$transaction(
        (tx) =>
          dispatchTask(
            {
              tx,
              jobs: deps.jobs,
              outbox: deps.outbox,
              notices: deps.notices,
              clock: deps.clock,
              personalSlots: deps.personalSlots ?? DEFAULT_PERSONAL_RUNNER_SLOTS,
              // Its place among the tasks of this pass still waiting.
              places: new Map([[input.poolId, passed.length + 1]]),
              ...(deps.logger === undefined ? {} : { logger: deps.logger }),
              ...(deps.reopen === undefined ? {} : { reopen: deps.reopen }),
              ...(deps.effortLevels === undefined ? {} : { effortLevels: deps.effortLevels }),
            },
            payload,
          ),
        { timeout: 30_000 },
      )
      .catch((error: unknown) => {
        // Another writer holds the task (a dispatch from another pool's pass): it's theirs now.
        if (error instanceof Error && error.message === TASK_BUSY) {
          return null;
        }
        throw error;
      });
    if (result === null) {
      // The pass ends here: a task behind it in the queue never starts first. That writer grants
      // it or records its reason, and the next pass (the sweep, or the next change of room) goes on
      // from there. Found by milestone 5's demo: two pools' passes reordered a project's prompts.
      break;
    }
    if (result.ok) {
      admitted.push({ taskId: entry.taskId, runnerId: result.runnerId, leaseEpoch: result.leaseEpoch });
    } else if (result.error === "no-runner") {
      passed.push(entry.taskId);
      const row = await deps.db.task.findUnique({ where: { id: entry.taskId }, select: { dispatchWait: true } });
      const wait = row === null ? null : dispatchWaitFromDb(row.dispatchWait);
      if (wait?.code === "pool-full" && wait.poolId === input.poolId) {
        poolFull = true;
      } else if (wait?.code === "project-share-reached" && wait.poolId === input.poolId) {
        atShare.add(entry.projectId);
      }
    }
  }
  const reasons =
    passed.length === 0
      ? []
      : await deps.db.task.findMany({ where: { id: { in: passed }, organizationId: input.organizationId }, select: { id: true, dispatchWait: true } });
  const waiting = reasons.flatMap((row) => {
    const reason = dispatchWaitFromDb(row.dispatchWait);
    return reason === null ? [] : [{ taskId: taskIdSchema.parse(row.id), reason }];
  });
  deps.logger?.info("queue.admitted", { poolId: input.poolId, considered: queue.length, admitted: admitted.length, waiting: waiting.length });
  return { admitted, waiting };
};

/**
 * Puts a task that had a runner back in the queue, keeping its place (ADR 0059): its offer was
 * declined or timed out, its runner was revoked before it accepted, or its box was never placed
 * (`no-node`, `no-room`). The active lease ends with `endReason`, a box still being made fails,
 * a `preparing` task moves back to `queued`, and the next epoch's dispatch is sent.
 */
export const requeueTaskInTx = async (
  deps: Pick<Ports, "notices" | "clock"> & {
    /** Sends the next dispatch at once, and owes the fan-out of any item a move closes. */
    readonly jobs: Ports["jobs"];
    readonly logger?: Logger;
  },
  tx: Tx,
  input: {
    readonly organizationId: OrganizationId;
    readonly taskId: TaskId;
    readonly endReason: string;
    readonly boxReason: string;
    readonly wait: DispatchWait | null;
  },
): Promise<boolean> => {
  const row = await tx.task.findFirst({ where: { id: input.taskId, organizationId: input.organizationId } });
  if (row === null || (row.state !== "queued" && row.state !== "preparing")) {
    return false;
  }
  const now = new Date(deps.clock.now());
  const lease = await tx.lease.findFirst({ where: { taskId: input.taskId, state: "active" }, select: { id: true, boxId: true } });
  if (lease !== null) {
    await tx.lease.update({ where: { id: lease.id }, data: { state: "ended", endedAt: now, endReason: input.endReason } });
    await tx.box.updateMany({ where: { id: lease.boxId, state: { in: ["creating", "preparing"] } }, data: { state: "failed", failedReason: input.boxReason } });
  }
  if (row.state === "preparing") {
    const moved = await moveTaskInTx({ tx, notices: deps.notices, jobs: deps.jobs, ...(deps.logger === undefined ? {} : { logger: deps.logger }) }, mapTask(row), { type: "box_unplaced" });
    if (!moved) {
      return false;
    }
  }
  // As a declined offer: the next dispatch raises the epoch, which fences the old one (F-045).
  const fenced = await tx.task.update({ where: { id: input.taskId }, data: dispatchWaitColumns(input.wait), select: { leaseEpoch: true } });
  const session = await tx.session.findFirst({ where: { taskId: input.taskId, state: "starting" }, orderBy: { startedAt: "desc" }, select: { id: true } });
  if (session !== null) {
    await deps.jobs.enqueueInTx(tx, "task.dispatch", {
      organizationId: input.organizationId,
      taskId: input.taskId,
      sessionId: sessionIdSchema.parse(session.id),
      leaseEpoch: leaseEpochSchema.parse(fenced.leaseEpoch + 1),
    });
  }
  await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: projectIdSchema.parse(row.projectId), entity: "task", entityId: input.taskId });
  deps.logger?.info("task.requeued", { taskId: input.taskId, endReason: input.endReason });
  return true;
};

export const cancelQueuedTask: CancelQueuedTask = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  return deps.db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<readonly unknown[]>`
      SELECT 1 FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${organizationId} FOR UPDATE`;
    if (locked.length === 0) {
      return { ok: false, error: "not-found", message: "No such task" } as const;
    }
    const row = await tx.task.findUniqueOrThrow({ where: { id: input.taskId } });
    const project = await tx.project.findFirst({ where: { id: row.projectId, organizationId }, select: { id: true, access: true } });
    if (project === null) {
      return { ok: false, error: "not-found", message: "No such task" } as const;
    }
    const projectId = projectIdSchema.parse(project.id);
    const access = requireProjectAccess(scope, { id: projectId, organizationId, access: project.access }, "read");
    if (!access.ok) {
      return access.code === "not-found" ? ({ ok: false, error: "not-found", message: "No such task" } as const) : ({ ok: false, error: "forbidden", message: "You may not cancel this task" } as const);
    }
    // An admin cancels any queued task; a member only their own.
    const admin = requireOrganizationAdmin(scope, organizationId).ok;
    if (!admin && row.creatorMemberId !== scope.memberId) {
      return { ok: false, error: "forbidden", message: "Only an admin or the task's member may cancel it" } as const;
    }
    if (row.state !== "queued") {
      return { ok: false, error: "not-queued", message: "Only a queued task is cancelled" } as const;
    }
    const task = mapTask(row);
    const moved = await moveTaskInTx({ tx, notices: deps.notices, jobs: deps.jobs }, task, { type: "cancel" });
    if (!moved) {
      return { ok: false, error: "not-queued", message: "Only a queued task is cancelled" } as const;
    }
    const now = deps.clock.now();
    // An offer still out ends here, and the epoch goes up, so the runner's late answer is stale.
    const lease = await tx.lease.findFirst({ where: { taskId: task.id, state: "active" }, select: { id: true, boxId: true } });
    if (lease !== null) {
      await tx.lease.update({ where: { id: lease.id }, data: { state: "ended", endedAt: new Date(now), endReason: "cancelled" } });
      await tx.box.updateMany({ where: { id: lease.boxId, state: "creating" }, data: { state: "failed", failedReason: "the task was cancelled" } });
    }
    await tx.task.update({ where: { id: task.id }, data: { cancelledByMemberId: scope.memberId, leaseEpoch: { increment: 1 }, ...dispatchWaitColumns(null) } });
    const session = await tx.session.findFirst({ where: { taskId: task.id, state: "starting" }, orderBy: { startedAt: "desc" }, select: { id: true } });
    if (session !== null) {
      await tx.session.update({ where: { id: session.id }, data: { state: "stopped", endedAt: new Date(now) } });
      await appendServerEvent(tx, {
        organizationId,
        projectId,
        taskId: task.id,
        sessionId: sessionIdSchema.parse(session.id),
        event: { kind: "task.cancelled", memberId: memberIdSchema.parse(scope.memberId) },
        at: now,
      });
    }
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "task.cancelled",
      entity: "task",
      entityId: task.id,
      data: { byAdmin: admin && row.creatorMemberId !== scope.memberId, offerOut: lease !== null },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
    return { ok: true, state: "stopped" } as const;
  });
};

