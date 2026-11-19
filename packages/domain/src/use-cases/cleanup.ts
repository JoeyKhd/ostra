import { boxReleaseReasonFromDb, LIVE_TEXT_TABLE, Prisma } from "@ostra/db";
import type { Db, Tx } from "@ostra/db";
import { blobIdSchema, boxIdSchema, organizationIdSchema, projectIdSchema, runnerIdSchema, taskIdSchema } from "@ostra/protocol";
import type { BlobId, BoxId, OrganizationId, TaskId } from "@ostra/protocol";

import { transitionBox } from "../lifecycles/box.ts";
import type { BoxInput, BoxReleaseReason } from "../lifecycles/box.ts";
import { boxFromColumns, boxToColumns } from "../lifecycles/mapping.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";

// Cleanup and retention (F-079, spec section 11, item 11; ticket 20). A box is released when its
// task's last PR merges or closes, or after the idle days: a `release` command to its runner
// (protocol minor 1), and the box counts as released at once, so a reopen goes to a fresh one. The
// runner acks once the box and its workspace are gone, which sets `releasedAt`; an offline runner
// gets the same command from the outbox when it reconnects, never a second one. Retention, when an
// admin or `OSTRA_RETENTION_DAYS` sets one, deletes a finished task's history and blobs and keeps
// the task row, its task repos and an audit entry.

// ---------- releasing a box ----------

export type ReleaseBoxInput = {
  readonly organizationId: OrganizationId;
  readonly taskId: TaskId;
  readonly boxId: BoxId;
  readonly reason: BoxReleaseReason;
};

export type ReleaseBoxResult = UseCaseResult<
  {
    /** `command`: the runner was sent `release`; `already`: the box is gone; `minor-0`: its runner can't take one. */
    readonly outcome: "command" | "already" | "minor-0";
  },
  "not-found"
>;

export type ReleaseBoxDeps = Pick<Ports, "outbox" | "jobs" | "notices" | "clock"> & { readonly tx: Tx };

/**
 * Sends the box's runner the `release` command (protocol minor 1 only), moves the box to released
 * with its reason, and ends its lease. The task's hidden refs are deleted on the code host by the
 * caller, outside the transaction, once `hiddenRefsToDelete` names them.
 */
export type ReleaseBox = (deps: ReleaseBoxDeps, input: ReleaseBoxInput) => Promise<ReleaseBoxResult>;

/** How long an offline runner's `release` waits in the outbox for it: a week. */
const RELEASE_NOT_AFTER_MS = 7 * 24 * 3_600_000;

const STOP_THEN_RELEASE = (reason: BoxReleaseReason): readonly BoxInput[] => [{ type: "stop" }, { type: "release", reason }];

export const releaseBox: ReleaseBox = async (deps, input) => {
  const { tx } = deps;
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT 1 FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${input.organizationId} FOR UPDATE`;
  if (locked.length === 0) {
    return { ok: false, error: "not-found", message: "no such task" };
  }
  const box = await tx.box.findFirst({
    where: { id: input.boxId, taskId: input.taskId, organizationId: input.organizationId },
    select: { id: true, state: true, failedReason: true, releaseReason: true, runnerId: true, projectId: true },
  });
  if (box === null) {
    return { ok: false, error: "not-found", message: "no such box of the task" };
  }
  const decoded = boxFromColumns(box);
  if (!decoded.ok || box.state === "released" || box.state === "failed") {
    return { ok: true, outcome: "already" };
  }
  // A ready or idle box stops first: the lifecycle releases only a stopped one (ADR 0029).
  let next = decoded.value;
  for (const step of STOP_THEN_RELEASE(input.reason)) {
    const moved = transitionBox(next, step);
    if (moved.ok) {
      next = moved.state;
    }
  }
  if (next.state !== "released") {
    // Still being made: the dispatch's own failure path ends it.
    return { ok: true, outcome: "already" };
  }
  const now = new Date(deps.clock.now());
  const runnerId = box.runnerId === null ? null : runnerIdSchema.parse(box.runnerId);
  const presence = runnerId === null ? null : await tx.runnerPresence.findUnique({ where: { runnerId }, select: { minor: true } });
  const canRelease = runnerId !== null && (presence?.minor ?? 0) >= 1;
  await tx.box.update({
    where: { id: box.id },
    data: {
      ...boxToColumns(next),
      ...(box.state === "ready" || box.state === "idle" ? { stoppedAt: now } : {}),
      // A minor-0 runner removed the workspace at the session's end: no ack will come.
      ...(canRelease ? {} : { releasedAt: now }),
    },
  });
  await tx.lease.updateMany({ where: { boxId: box.id, state: "active" }, data: { state: "ended", endedAt: now, endReason: "released" } });
  const projectId = projectIdSchema.parse(box.projectId);
  if (canRelease) {
    // One command per box: a retry of the job, or a second reason, finds the first one.
    const sent = await tx.command.findFirst({
      where: { runnerId, kind: "release", taskId: input.taskId, body: { path: ["boxId"], equals: box.id } },
      select: { id: true },
    });
    if (sent === null) {
      await deps.outbox.enqueueInTx(tx, input.organizationId, runnerId, {
        kind: "release",
        body: { taskId: input.taskId, boxId: input.boxId, reason: boxReleaseReasonFromDb[input.reason] },
        notAfter: now.getTime() + RELEASE_NOT_AFTER_MS,
        task: { taskId: input.taskId, projectId },
      });
    }
  }
  await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId, entity: "task", entityId: input.taskId });
  return { ok: true, outcome: canRelease ? "command" : "minor-0" };
};

/** The runner's ack of a `release`: the box and its workspace are gone. */
export const recordBoxReleasedInTx = async (tx: Tx, organizationId: OrganizationId, boxId: string, at: Date): Promise<void> => {
  await tx.box.updateMany({ where: { id: boxId, organizationId, state: "released", releasedAt: null }, data: { releasedAt: at } });
};

/**
 * The task repos whose hidden ref goes now (ADR 0039, Q120): only once the task is merged, or
 * stopped with its PRs closed, and none of its boxes is kept. A task that can still be reopened
 * keeps its ref. Cleanup deletes refs, never LFS objects.
 */
export const hiddenRefsToDelete = async (
  db: Pick<Db, "task" | "box" | "taskRepo">,
  organizationId: OrganizationId,
  taskId: TaskId,
): Promise<readonly { readonly taskRepoId: string; readonly repoId: string }[]> => {
  const task = await db.task.findFirst({ where: { id: taskId, organizationId }, select: { state: true, stoppedReason: true } });
  const finished = task !== null && (task.state === "merged" || (task.state === "stopped" && task.stoppedReason === "prs_closed"));
  if (!finished) {
    return [];
  }
  const kept = await db.box.count({ where: { taskId, state: { in: ["creating", "preparing", "ready", "idle", "stopped"] } } });
  if (kept > 0) {
    return [];
  }
  const rows = await db.taskRepo.findMany({ where: { taskId, hiddenRefSha: { not: null } }, select: { id: true, repoId: true } });
  return rows.map((row) => ({ taskRepoId: row.id, repoId: row.repoId }));
};

// ---------- the sweeps ----------

export type SweepCleanupInput = {
  readonly now: number;
  /** `OSTRA_BOX_RELEASE_IDLE_DAYS`, in ms. */
  readonly releaseAfterIdleMs: number;
};

export type SweepCleanupResult = UseCaseResult<{ readonly releaseQueued: number }, never>;

/** Finds stopped boxes idle past the limit whose timer was lost, and enqueues their release. */
export type SweepCleanup = (deps: Pick<Ports, "jobs" | "clock"> & { readonly db: Db }, input: SweepCleanupInput) => Promise<SweepCleanupResult>;

export const sweepCleanup: SweepCleanup = async (deps, input) => {
  const cutoff = new Date(input.now - input.releaseAfterIdleMs);
  const boxes = await deps.db.box.findMany({
    where: {
      state: { in: ["idle", "stopped"] },
      OR: [{ idleSince: { lt: cutoff } }, { idleSince: null, stoppedAt: { lt: cutoff } }],
    },
    select: { id: true, taskId: true, organizationId: true },
    take: 500,
  });
  for (const box of boxes) {
    await deps.db.$transaction(async (tx) => {
      await deps.jobs.enqueueInTx(tx, "box.release", {
        organizationId: organizationIdSchema.parse(box.organizationId),
        taskId: taskIdSchema.parse(box.taskId),
        boxId: boxIdSchema.parse(box.id),
        reason: "idle-expired",
      });
    });
  }
  return { ok: true, releaseQueued: boxes.length };
};

export type SweepRetentionInput = {
  readonly now: number;
  /** The retention in effect (`retentionDaysInEffect`); `null` keeps everything, and the sweep does nothing. */
  readonly retentionDays: number | null;
};

export type SweepRetentionResult = UseCaseResult<
  { readonly tasks: number; readonly events: number; readonly blobs: number },
  "blob-store-failed"
>;

/**
 * Deletes, for tasks ended more than the retention ago, their event history, session archives and
 * other blobs (through the blob store), and records `retention.swept` in the audit log.
 */
export type SweepRetention = (
  deps: Pick<Ports, "audit" | "clock"> & {
    readonly db: Db;
    /** The blob store's delete (core's blob service). Without it the rows go, and a Postgres blob's chunks with them. */
    readonly deleteBlob?: (organizationId: OrganizationId, blobId: BlobId) => Promise<boolean>;
  },
  input: SweepRetentionInput,
) => Promise<SweepRetentionResult>;

/** How many finished tasks one run looks at: the next run takes the rest. */
const RETENTION_BATCH = 500;

type Counts = { readonly tasks: number; readonly events: number; readonly blobs: number };

export const sweepRetention: SweepRetention = async (deps, input) => {
  if (input.retentionDays === null) {
    return { ok: true, tasks: 0, events: 0, blobs: 0 };
  }
  const retentionDays = input.retentionDays;
  const cutoff = new Date(input.now - retentionDays * 24 * 3_600_000);
  // Finished before the cutoff, with something left to delete: the task row's last change is its end.
  const finished = await deps.db.task.findMany({
    where: {
      state: { in: ["stopped", "merged", "done"] },
      updatedAt: { lt: cutoff },
      OR: [{ events: { some: {} } }, { blobs: { some: {} } }],
    },
    select: { id: true, organizationId: true, projectId: true },
    orderBy: { updatedAt: "asc" },
    take: RETENTION_BATCH,
  });
  const totals = new Map<string, Counts>();
  let failed = 0;
  for (const task of finished) {
    const organizationId = organizationIdSchema.parse(task.organizationId);
    const taskId = taskIdSchema.parse(task.id);
    const blobs = await deps.db.blob.findMany({ where: { taskId, organizationId }, select: { id: true } });
    let blobsDeleted = 0;
    for (const blob of blobs) {
      const blobId = blobIdSchema.parse(blob.id);
      const deleted =
        deps.deleteBlob === undefined
          ? (await deps.db.blob.deleteMany({ where: { id: blobId, organizationId } })).count > 0
          : await deps.deleteBlob(organizationId, blobId);
      if (deleted) {
        blobsDeleted += 1;
      } else {
        failed += 1;
      }
    }
    const events = await deps.db.$transaction(async (tx) => {
      const removed = await tx.event.deleteMany({ where: { taskId, organizationId } });
      await tx.$executeRaw`DELETE FROM ${Prisma.raw(LIVE_TEXT_TABLE)} WHERE "taskId" = ${taskId}`;
      await tx.session.updateMany({ where: { taskId }, data: { archiveBlobId: null, archiveTurnOrdinal: null } });
      // The task keeps a record that its history went, and when (F-079).
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId: projectIdSchema.parse(task.projectId),
        actor: { kind: "system", id: null },
        action: "task.history_removed",
        entity: "task",
        entityId: taskId,
        data: { events: removed.count, blobs: blobsDeleted, retentionDays },
      });
      return removed.count;
    });
    const sum = totals.get(organizationId) ?? { tasks: 0, events: 0, blobs: 0 };
    totals.set(organizationId, { tasks: sum.tasks + 1, events: sum.events + events, blobs: sum.blobs + blobsDeleted });
  }
  // Each organization's run with its counts, zero included: the storage page's "last run".
  const organizations = await deps.db.organization.findMany({ select: { id: true } });
  await deps.db.$transaction(async (tx) => {
    for (const organization of organizations) {
      const organizationId = organizationIdSchema.parse(organization.id);
      const sum = totals.get(organizationId) ?? { tasks: 0, events: 0, blobs: 0 };
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId: null,
        actor: { kind: "system", id: null },
        action: "retention.swept",
        entity: null,
        entityId: null,
        data: { tasks: sum.tasks, events: sum.events, blobs: sum.blobs, retentionDays },
      });
    }
  });
  if (failed > 0) {
    return { ok: false, error: "blob-store-failed", message: `${String(failed)} blobs couldn't be deleted; the next run tries again` };
  }
  let all: Counts = { tasks: 0, events: 0, blobs: 0 };
  for (const sum of totals.values()) {
    all = { tasks: all.tasks + sum.tasks, events: all.events + sum.events, blobs: all.blobs + sum.blobs };
  }
  return { ok: true, ...all };
};
