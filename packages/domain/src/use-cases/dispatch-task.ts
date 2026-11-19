import type { Logger } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { blobIdSchema, boxIdSchema, organizationIdSchema, poolIdSchema, projectIdSchema, runnerIdSchema, runnerLimits, sha256HexSchema } from "@ostra/protocol";
import type { BlobRef, BoxId, CommandId, LeaseEpoch, OrganizationId, PoolId, RunnerId, TaskId } from "@ostra/protocol";

import type { JobPayload } from "../jobs.ts";
import type { Ports } from "../ports.ts";
import { dispatchWaitColumns, dispatchWaitFromDb } from "../dispatch-wait.ts";
import type { DispatchWait } from "../dispatch-wait.ts";
import type { UseCaseResult } from "./common.ts";
import { chooseReopenStep } from "./reopen.ts";
import type { ReopenStep } from "./reopen.ts";

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

/** What a reopen's dispatch needs to know beyond the rows (milestone 2, ticket 18). */
export type ReopenDispatchSettings = {
  /** Whether an agent adapter, by its name, can import a session archive (its `sessionArchive` capability). */
  readonly agentImportsArchives: (adapter: string) => boolean;
  /** The blob cap: an archive over it is never restored (`OSTRA_BLOB_MAX_MIB`). */
  readonly archiveMaxBytes: number;
};

export type DispatchTaskDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "clock"> & {
  readonly tx: Tx;
  readonly logger?: Logger;
  /** Milestone 2: without it a reopen never restores an archive, and falls back to the template. */
  readonly reopen?: ReopenDispatchSettings;
};

/** How a dispatch starts its session: fresh (the task's first), or by one of ADR 0039's steps. */
export type DispatchPlan = { readonly step: "new" } | (ReopenStep & { readonly keptRunnerId?: RunnerId });

const KEPT_BOX_STATES: ReadonlySet<string> = new Set(["ready", "idle", "stopped"]);

/**
 * A reopen's step, chosen at dispatch (ADR 0039, ticket 18): the task's last box while its runner,
 * online at minor 1 or above, still holds it; else the newest archive the blob store still has,
 * under the cap and made by the same agent, when the agent imports archives; else the template.
 * A task with no earlier session is new.
 */
export const reopenPlanInTx = async (
  tx: Tx,
  task: { readonly id: TaskId; readonly organizationId: string },
  session: { readonly id: string; readonly agentProfileId: string | null },
  adapter: string | null,
  settings: ReopenDispatchSettings | undefined,
  now: number,
): Promise<DispatchPlan> => {
  const previous = await tx.session.findFirst({
    where: { taskId: task.id, id: { not: session.id } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { boxId: true },
  });
  if (previous === null) {
    return { step: "new" };
  }
  let keptBox: Parameters<typeof chooseReopenStep>[0]["keptBox"] = null;
  let keptRunnerId: RunnerId | undefined;
  const box = previous.boxId === null ? null : await tx.box.findUnique({ where: { id: previous.boxId }, select: { id: true, state: true, runnerId: true } });
  const boxRunnerId = box?.runnerId ?? null;
  if (box !== null && boxRunnerId !== null && KEPT_BOX_STATES.has(box.state)) {
    const runner = await tx.runner.findFirst({
      where: { id: boxRunnerId, organizationId: task.organizationId, state: "online", revokedAt: null },
      select: { presence: { select: { minor: true, disconnectedAt: true, lastSeenAt: true } } },
    });
    const presence = runner?.presence ?? null;
    const online = presence !== null && presence.disconnectedAt === null && presence.lastSeenAt.getTime() > now - runnerLimits.offlineMs;
    keptBox = { boxId: boxIdSchema.parse(box.id), runnerOnline: online, runnerMinor: presence?.minor ?? 0 };
    keptRunnerId = runnerIdSchema.parse(boxRunnerId);
  }
  // The newest archive of the task's sessions, if the store still holds it (retention may not).
  const archived = await tx.session.findFirst({
    where: { taskId: task.id, archiveBlobId: { not: null } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { archiveBlobId: true, agentProfileId: true },
  });
  let archive: BlobRef | null = null;
  let sameAgent = true;
  if (archived !== null && archived.archiveBlobId !== null) {
    const blob = await tx.blob.findFirst({
      where: { id: archived.archiveBlobId, organizationId: task.organizationId, taskId: task.id },
      select: { id: true, size: true, sha256: true },
    });
    const maxBytes = Math.min(settings?.archiveMaxBytes ?? runnerLimits.archiveMaxBytes, runnerLimits.archiveMaxBytes);
    const digest = sha256HexSchema.safeParse(blob?.sha256);
    if (blob !== null && blob.size <= maxBytes && digest.success) {
      archive = { blobId: blobIdSchema.parse(blob.id), size: blob.size, sha256: digest.data };
    }
    if (archived.agentProfileId !== session.agentProfileId && archived.agentProfileId !== null) {
      const maker = await tx.agentProfile.findFirst({ where: { id: archived.agentProfileId, organizationId: task.organizationId }, select: { adapter: true } });
      sameAgent = maker !== null && maker.adapter === adapter;
    }
  }
  const step = chooseReopenStep({
    keptBox,
    archive,
    agentImportsArchives: adapter !== null && settings?.agentImportsArchives(adapter) === true,
    sameAgent,
  });
  return keptRunnerId === undefined ? step : { ...step, keptRunnerId };
};

/** The step when the kept box can't be used after all: the archive's, or the template's. */
const withoutKeptBox = async (
  tx: Tx,
  task: { readonly id: TaskId; readonly organizationId: string },
  session: { readonly id: string; readonly agentProfileId: string | null },
  adapter: string | null,
  settings: ReopenDispatchSettings | undefined,
): Promise<DispatchPlan> => {
  // The same choice with the box taken away: the clock doesn't matter once there's no box.
  const plan = await reopenPlanInTx(tx, task, session, adapter, settings, Number.NEGATIVE_INFINITY);
  return plan.step === "resumed" ? { step: "rebuilt", reason: "no-archive" } : plan;
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

  // Milestone 2 (ticket 18): a reopen's step. The same box goes back to its own runner.
  let plan = await reopenPlanInTx(tx, task, session, profile?.adapter ?? null, deps.reopen, now);
  let candidates: readonly Candidate[] = [];
  if (plan.step === "resumed" && plan.keptRunnerId !== undefined) {
    candidates = await available(tx, task.organizationId, { ids: [plan.keptRunnerId] }, now);
    if (candidates.length === 0) {
      plan = await withoutKeptBox(tx, task, session, profile?.adapter ?? null, deps.reopen);
    }
  }
  if (candidates.length > 0) {
    // The kept box's runner, already chosen.
  } else if (task.runnerId !== null) {
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
    if (candidates.length === 0 && plan.step !== "new") {
      // A reopen goes anywhere (F-033): the owner's other personal runners, when the one picked is gone.
      const owned = await tx.runner.findMany({
        where: { organizationId: task.organizationId, kind: "personal", ownerMemberId: task.creatorMemberId ?? "" },
        select: { id: true },
      });
      candidates = await available(tx, task.organizationId, { ids: owned.map((row) => runnerIdSchema.parse(row.id)) }, now);
    }
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
  // The runner's row, locked before the grant (the outbox takes the same lock for its counter). A
  // revoke that committed while this read the candidates is seen here, so no lease goes to a
  // revoked runner (Q131).
  const fresh = await tx.$queryRaw<readonly unknown[]>`
    SELECT 1 FROM "runner" WHERE "id" = ${runner.id} AND "state" = 'online' AND "revokedAt" IS NULL FOR NO KEY UPDATE`;
  if (fresh.length === 0) {
    return noRunner(unavailable);
  }

  // A runner below minor 1 can't restore an archive or a hidden ref: it gets the template (ticket 18).
  if (plan.step === "restored") {
    const presence = await tx.runnerPresence.findUnique({ where: { runnerId: runner.id }, select: { minor: true } });
    if ((presence?.minor ?? 0) < 1) {
      plan = { step: "rebuilt", reason: "archive-unsupported" };
    }
  }

  // The grant, in this one transaction: box, lease (the epoch goes up), the command, the timer.
  const organizationId = organizationIdSchema.parse(task.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  const runnerId = runner.id;
  // `resumed`: the same box, on the runner that kept it. Every other step makes a fresh one.
  const boxId =
    plan.step === "resumed"
      ? plan.boxId
      : boxIdSchema.parse(
          (
            await tx.box.create({
              data: { organizationId, projectId, taskId: task.id, runnerId, executor: runner.executor, state: "creating" },
              select: { id: true },
            })
          ).id,
        );
  // One active lease per task: an earlier grant still open (a reopen that raced its own) ends here.
  await tx.lease.updateMany({
    where: { taskId: task.id, state: "active" },
    data: { state: "ended", endedAt: new Date(now), endReason: "superseded" },
  });
  await tx.lease.create({
    data: { organizationId, projectId, taskId: task.id, epoch: input.leaseEpoch, runnerId, boxId, state: "active" },
  });
  await tx.task.update({ where: { id: task.id }, data: { leaseEpoch: input.leaseEpoch, ...dispatchWaitColumns(null) } });
  await tx.session.update({ where: { id: session.id }, data: { boxId, origin: plan.step } });
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
  deps.logger?.info("dispatch.offered", { taskId: task.id, runnerId, leaseEpoch: input.leaseEpoch, step: plan.step });
  return { ok: true, runnerId, boxId, leaseEpoch: input.leaseEpoch, commandId: command.commandId };
};
