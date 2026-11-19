import { hiddenRefFor, secretRefSchema } from "@ostra/adapter-sdk";
import type { Logger } from "@ostra/adapter-sdk";
import { boxReleaseReasonToDb } from "@ostra/db";
import type { Db, Tx } from "@ostra/db";
import { hiddenRefsToDelete, recordBoxReleasedInTx, releaseBox, retentionDaysInEffect, sweepCleanup, sweepRetention } from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock, CommandOutbox, JobQueue, ServerAdapters } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { organizationIdSchema, releaseBodySchema, repoFullNameSchema } from "@ostra/protocol";
import type { BlobId, OrganizationId, TaskId } from "@ostra/protocol";

import type { AckedCommand, RunnerRef } from "../gateway/context.ts";

// Cleanup and retention on the server (ticket 20, F-079, ADR 0039). `box.release` (the task's last
// PR merged or closed: ticket 16 sends it) and `box.release-after-idle` (ticket 17 sends it when a
// box goes idle, and cancels it when a turn starts in it) both end in `releaseBox`: the box counts as
// released at once and its runner gets one `release` command, kept in the outbox for an offline
// runner. Then, outside the transaction, the hidden ref goes from each repo once the task is done
// with it (merged, or stopped with its PRs closed). Cleanup deletes refs, never LFS objects (Q120).
// `retention.sweep` runs daily and does nothing unless a retention is in effect.

export type CleanupDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore">;
  readonly logger: Logger;
  /** The blob store's delete, for retention. */
  readonly deleteBlob?: (organizationId: OrganizationId, blobId: BlobId) => Promise<boolean>;
  /** `OSTRA_RETENTION_DAYS`, or `null`. A retention saved in the panel wins. */
  readonly retentionDays: number | null;
  /** `OSTRA_BOX_RELEASE_IDLE_DAYS`, in ms: the sweep's backstop for a lost idle timer. */
  readonly releaseAfterIdleMs: number;
};

/** Thrown so the queue retries: the code host didn't delete a ref, and the rest waits. */
export const REF_DELETE_FAILED = "the code host didn't delete a hidden ref; the job retries";

/** When the daily retention pass runs (UTC, as every connection runs). */
export const RETENTION_CRON = "41 3 * * *";

/** Deletes the task's hidden ref from each repo, once the task is done with it. */
export const deleteHiddenRefs = async (deps: CleanupDeps, organizationId: OrganizationId, taskId: TaskId): Promise<number> => {
  const repos = await hiddenRefsToDelete(deps.db, organizationId, taskId);
  let deleted = 0;
  for (const { taskRepoId, repoId } of repos) {
    const repo = await deps.db.repo.findFirst({ where: { id: repoId, organizationId }, include: { connection: true } });
    const keyRef = repo?.connection.privateKeySecretRef ?? null;
    if (repo === null || keyRef === null) {
      continue;
    }
    const key = await deps.adapters.secretStore.get(organizationId, secretRefSchema.parse(keyRef));
    if (!key.ok) {
      throw new Error(REF_DELETE_FAILED);
    }
    const access = {
      app: { appId: repo.connection.appId, privateKey: key.value },
      installationId: repo.installationId,
      repo: repoFullNameSchema.parse(repo.fullName),
    };
    const result = await deps.adapters.codeHost.deleteRef(access, hiddenRefFor(taskId));
    if (!result.ok) {
      if (result.error.code === "unsupported") {
        deps.logger.warn("cleanup.ref-delete-unsupported", { taskId, repoId });
        continue;
      }
      deps.logger.warn("cleanup.ref-delete-failed", { taskId, repoId, code: result.error.code });
      throw new Error(REF_DELETE_FAILED);
    }
    // Gone, or already gone: a second delete isn't an error.
    await deps.db.taskRepo.update({ where: { id: taskRepoId }, data: { hiddenRefSha: null, hiddenRefBaseSha: null } });
    deleted += 1;
  }
  return deleted;
};

const releaseDeps = (deps: CleanupDeps, tx: Tx) => ({ tx, outbox: deps.outbox, jobs: deps.jobs, notices: deps.notices, clock: deps.clock });

export const boxReleaseHandler =
  (deps: CleanupDeps): JobHandler<"box.release"> =>
  async (context) => {
    const { payload } = context;
    const released = await deps.db.$transaction((tx) =>
      releaseBox(releaseDeps(deps, tx), { organizationId: payload.organizationId, taskId: payload.taskId, boxId: payload.boxId, reason: boxReleaseReasonToDb[payload.reason] }),
    );
    const refs = released.ok ? await deleteHiddenRefs(deps, payload.organizationId, payload.taskId) : 0;
    context.logger.info("box.release", { taskId: payload.taskId, boxId: payload.boxId, outcome: released.ok ? released.outcome : released.error, refsDeleted: refs });
  };

/**
 * `box.release-after-idle`: the box's idle days ran out. It's released only if it's still idle or
 * stopped (ADR 0037: re-read the subject); a box a turn runs in is left alone.
 */
export const releaseAfterIdleHandler =
  (deps: CleanupDeps): JobHandler<"box.release-after-idle"> =>
  async (context) => {
    const { payload } = context;
    const box = await deps.db.box.findFirst({ where: { id: payload.boxId, taskId: payload.taskId, organizationId: payload.organizationId }, select: { state: true } });
    if (box === null || (box.state !== "idle" && box.state !== "stopped")) {
      context.logger.info("box.release-after-idle", { taskId: payload.taskId, boxId: payload.boxId, outcome: box === null ? "missing" : "in-use" });
      return;
    }
    const released = await deps.db.$transaction((tx) =>
      releaseBox(releaseDeps(deps, tx), { organizationId: payload.organizationId, taskId: payload.taskId, boxId: payload.boxId, reason: "idle_expired" }),
    );
    const refs = released.ok ? await deleteHiddenRefs(deps, payload.organizationId, payload.taskId) : 0;
    context.logger.info("box.release-after-idle", { taskId: payload.taskId, boxId: payload.boxId, outcome: released.ok ? released.outcome : released.error, refsDeleted: refs });
  };

/** One retention pass and the idle-box backstop: what they did, counted. */
export const runRetention = async (deps: CleanupDeps) => {
  const now = deps.clock.now();
  const saved = await deps.db.instanceSetting.findUnique({ where: { id: "instance" }, select: { retentionDays: true, retentionSetAt: true } });
  const retentionDays = retentionDaysInEffect(saved, deps.retentionDays);
  const swept = await sweepRetention(
    { db: deps.db, audit: deps.audit, clock: deps.clock, ...(deps.deleteBlob === undefined ? {} : { deleteBlob: deps.deleteBlob }) },
    { now, retentionDays },
  );
  const boxes = await sweepCleanup({ db: deps.db, jobs: deps.jobs, clock: deps.clock }, { now, releaseAfterIdleMs: deps.releaseAfterIdleMs });
  return { retentionDays, swept, releaseQueued: boxes.ok ? boxes.releaseQueued : 0 };
};

export const retentionSweepHandler =
  (deps: CleanupDeps): JobHandler<"retention.sweep"> =>
  async (context) => {
    const { retentionDays, swept, releaseQueued } = await runRetention(deps);
    context.logger.info("retention.sweep", {
      retentionDays,
      outcome: swept.ok ? "done" : swept.error,
      tasks: swept.ok ? swept.tasks : 0,
      events: swept.ok ? swept.events : 0,
      blobs: swept.ok ? swept.blobs : 0,
      releaseQueued,
    });
  };

/** The daily schedule: one tick a day however many replicas run. */
export const ensureRetentionSchedule = async (jobs: Pick<Jobs, "schedule">): Promise<void> => {
  await jobs.schedule("retention.sweep", "daily", RETENTION_CRON, {});
};

/** A runner's answers to `release` (ticket 20): `done` sets the box's `releasedAt`. */
export const applyReleaseResultsInTx = async (deps: Pick<CleanupDeps, "clock" | "logger">, tx: Tx, runner: RunnerRef, results: readonly AckedCommand[]): Promise<void> => {
  for (const result of results) {
    if (result.kind !== "release") {
      continue;
    }
    const body = releaseBodySchema.safeParse(result.body);
    if (!body.success) {
      continue;
    }
    if (result.result === "done") {
      await recordBoxReleasedInTx(tx, organizationIdSchema.parse(runner.organizationId), body.data.boxId, new Date(deps.clock.now()));
    }
    deps.logger.info("box.release-answered", { taskId: body.data.taskId, boxId: body.data.boxId, runnerId: runner.runnerId, result: result.result });
  }
};
