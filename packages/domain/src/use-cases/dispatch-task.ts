import type { Logger } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { boxIdSchema, organizationIdSchema, poolIdSchema, projectIdSchema, runnerIdSchema, runnerLimits } from "@ostra/protocol";
import type { BoxId, CommandId, LeaseEpoch, OrganizationId, PoolId, RunnerId } from "@ostra/protocol";

import type { JobPayload } from "../jobs.ts";
import type { Ports } from "../ports.ts";
import { dispatchWaitColumns, dispatchWaitFromDb } from "../dispatch-wait.ts";
import type { DispatchWait } from "../dispatch-wait.ts";
import type { UseCaseResult } from "./common.ts";

// ADR 0034, F-045: the `task.dispatch` job. It picks the runner (the member's personal runner in
// milestone 1), raises the task's lease epoch under the task row's lock, creates the box and the
// lease, writes a `dispatch` command to the outbox (with its NOTIFY), and enqueues the offer
// timeout. Written by ticket 26.
//
// The task stays `queued` while the offer is out: the domain's lifecycle moves it to `preparing`
// when the runner accepts (`acceptOffer`), so a rejected or timed-out offer needs no way back.
// When no runner fits, the task stays queued and `dispatchWait` says why, as a code the panel
// words (Q132, milestone 2's ticket 43); core's requeue sweep tries again.

export type DispatchTaskInput = JobPayload<"task.dispatch">;

export type DispatchTaskResult = UseCaseResult<
  { readonly runnerId: RunnerId; readonly boxId: BoxId; readonly leaseEpoch: LeaseEpoch; readonly commandId: CommandId },
  /** The task moved on (stopped, or dispatched by a newer job): nothing to do. */
  | "stale"
  /** No runner can take it now; the task stays queued, and `dispatchWait` says why. */
  | "no-runner"
>;

export type DispatchTaskDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "clock"> & {
  readonly tx: Tx;
  readonly logger?: Logger;
};

export type DispatchTask = (deps: DispatchTaskDeps, input: DispatchTaskInput) => Promise<DispatchTaskResult>;

const ACTIVE_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;

/** Thrown when another transaction holds the task: the job is retried, nothing is lost. */
export const TASK_BUSY = "the task is locked by another transaction; the job retries";

type Candidate = { readonly id: RunnerId; readonly executor: "docker" | "host" | "kubernetes"; readonly freeSlots: number };

/** The runners among `ids` that can take a task now: online, present, with a free slot. */
const available = async (
  tx: Tx,
  organizationId: OrganizationId,
  where: { readonly ids?: readonly RunnerId[]; readonly poolIds?: readonly PoolId[] },
  now: number,
): Promise<readonly Candidate[]> => {
  const runners = await tx.runner.findMany({
    where: {
      organizationId,
      state: "online",
      revokedAt: null,
      ...(where.ids === undefined ? {} : { id: { in: [...where.ids] } }),
      ...(where.poolIds === undefined ? {} : { kind: "pool", poolId: { in: [...where.poolIds] } }),
      presence: { is: { disconnectedAt: null, lastSeenAt: { gt: new Date(now - runnerLimits.offlineMs) } } },
    },
    select: { id: true, executor: true, capacity: true, _count: { select: { leases: { where: { state: "active" } } } } },
  });
  return runners
    .map((runner) => ({ id: runnerIdSchema.parse(runner.id), executor: runner.executor, freeSlots: runner.capacity - runner._count.leases }))
    .filter((runner) => runner.freeSlots > 0)
    .sort((a, b) => b.freeSlots - a.freeSlots);
};

export const dispatchTask: DispatchTask = async (deps, input) => {
  const { tx } = deps;
  const now = deps.clock.now();
  const stale = (message: string): DispatchTaskResult => ({ ok: false, error: "stale", message });

  // `SKIP LOCKED`: a dispatch never waits behind another writer of the task. A locked task is
  // retried by the queue; a missing one is stale.
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT 1 FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${input.organizationId} FOR UPDATE SKIP LOCKED`;
  if (locked.length === 0) {
    const exists = await tx.task.findFirst({ where: { id: input.taskId, organizationId: input.organizationId }, select: { id: true } });
    if (exists !== null) {
      throw new Error(TASK_BUSY);
    }
    return stale("no such task");
  }
  const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.taskId } }));
  if (task.state !== "queued" || task.leaseEpoch + 1 !== input.leaseEpoch) {
    return stale("the task isn't waiting for this dispatch");
  }
  const session = await tx.session.findFirst({ where: { id: input.sessionId, taskId: task.id, state: "starting" } });
  if (session === null) {
    return stale("the session isn't waiting to start");
  }

  const noRunner = async (wait: DispatchWait): Promise<DispatchTaskResult> => {
    // A notice only when the reason changed: the sweep retries every queued task.
    if (JSON.stringify(dispatchWaitFromDb(task.dispatchWait)) !== JSON.stringify(wait)) {
      await tx.task.update({ where: { id: task.id }, data: dispatchWaitColumns(wait) });
      await deps.notices.emitInTx(tx, {
        organizationId: organizationIdSchema.parse(task.organizationId),
        projectId: projectIdSchema.parse(task.projectId),
        entity: "task",
        entityId: task.id,
      });
    }
    deps.logger?.info("dispatch.no-runner", { taskId: task.id, reason: wait.code });
    return { ok: false, error: "no-runner", message: wait.code };
  };

  const profile =
    session.agentProfileId === null
      ? null
      : await tx.agentProfile.findFirst({
          where: { id: session.agentProfileId, organizationId: task.organizationId },
          include: { model: { include: { provider: true } } },
        });
  const provider = profile?.model?.provider;
  if (provider === undefined) {
    return noRunner({ code: "no-model" });
  }
  if (provider.dispatchHeldUntil !== null && provider.dispatchHeldUntil.getTime() > now) {
    return noRunner({ code: "provider-held", until: provider.dispatchHeldUntil.getTime() });
  }
  if (provider.sessionsAtOnce !== null) {
    // Sessions name their profile, not their provider: the provider's profiles first, then one count.
    const profiles = await tx.agentProfile.findMany({
      where: { organizationId: task.organizationId, model: { providerId: provider.id } },
      select: { id: true },
    });
    const sameProvider = await tx.session.count({
      where: {
        organizationId: task.organizationId,
        id: { not: session.id },
        state: { in: [...ACTIVE_SESSION_STATES] },
        agentProfileId: { in: profiles.map((row) => row.id) },
        task: { leases: { some: { state: "active" } } },
      },
    });
    if (sameProvider >= provider.sessionsAtOnce) {
      return noRunner({ code: "provider-cap", cap: provider.sessionsAtOnce });
    }
  }

  let candidates: readonly Candidate[];
  if (task.runnerId !== null) {
    // The member picked their own personal runner: only it, and only theirs.
    const chosen = await tx.runner.findFirst({
      where: { id: task.runnerId, organizationId: task.organizationId, kind: "personal", ownerMemberId: task.creatorMemberId ?? "" },
      select: { id: true },
    });
    if (chosen === null) {
      return noRunner({ code: "personal-runner-unavailable" });
    }
    if (!provider.allowOnPersonalRunners) {
      return noRunner({ code: "personal-runner-not-allowed" });
    }
    candidates = await available(tx, task.organizationId, { ids: [runnerIdSchema.parse(chosen.id)] }, now);
    if (candidates.length === 0) {
      return noRunner({ code: "personal-runner-unavailable" });
    }
  } else {
    const listed = await tx.projectPool.findMany({ where: { projectId: task.projectId }, select: { poolId: true } });
    const poolIds =
      listed.length > 0
        ? listed.map((row) => poolIdSchema.parse(row.poolId))
        : (await tx.runnerPool.findMany({ where: { organizationId: task.organizationId, isDefault: true }, select: { id: true } })).map((row) =>
            poolIdSchema.parse(row.id),
          );
    candidates = poolIds.length === 0 ? [] : await available(tx, task.organizationId, { poolIds }, now);
    if (candidates.length === 0) {
      return noRunner({ code: "no-runner-online" });
    }
  }
  const [runner] = candidates;
  const unavailable: DispatchWait = { code: task.runnerId === null ? "no-runner-online" : "personal-runner-unavailable" };
  if (runner === undefined) {
    return noRunner(unavailable);
  }

  // The grant, in this one transaction: box, lease (the epoch goes up), the command, the timer.
  const organizationId = organizationIdSchema.parse(task.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  const runnerId = runner.id;
  const box = await tx.box.create({
    data: { organizationId, projectId, taskId: task.id, runnerId, executor: runner.executor, state: "creating" },
    select: { id: true },
  });
  const boxId = boxIdSchema.parse(box.id);
  await tx.lease.create({
    data: { organizationId, projectId, taskId: task.id, epoch: input.leaseEpoch, runnerId, boxId, state: "active" },
  });
  await tx.task.update({ where: { id: task.id }, data: { leaseEpoch: input.leaseEpoch, ...dispatchWaitColumns(null) } });
  await tx.session.update({ where: { id: session.id }, data: { boxId } });
  const command = await deps.outbox.enqueueInTx(tx, organizationId, runnerId, {
    kind: "dispatch",
    body: { taskId: task.id, sessionId: input.sessionId, boxId, leaseEpoch: input.leaseEpoch },
    notAfter: now + runnerLimits.offerTimeoutMs,
    task: { taskId: task.id, projectId },
  });
  await deps.jobs.enqueueInTx(
    tx,
    "task.offer-timeout",
    { organizationId, taskId: task.id, leaseEpoch: input.leaseEpoch },
    { startAfterMs: runnerLimits.offerTimeoutMs },
  );
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
  deps.logger?.info("dispatch.offered", { taskId: task.id, runnerId, leaseEpoch: input.leaseEpoch });
  return { ok: true, runnerId, boxId, leaseEpoch: input.leaseEpoch, commandId: command.commandId };
};
