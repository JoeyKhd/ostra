import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import type { Clock } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";

// `blob.gc` (ticket 12): once a day, the uploads nobody finished within 24 h go, with their chunks
// (the foreign key cascades). A runner that dropped mid-upload resumes within minutes; one that
// never came back leaves bytes nothing refers to. A finished upload's record goes too after 24 h:
// its chunks already moved to its blob, which stays.

/** How long an upload may sit unfinished before `blob.gc` deletes it: a working value. */
export const STALE_UPLOAD_MS = 24 * 60 * 60_000;

/** When the daily pass runs (UTC, as every connection runs). */
export const BLOB_GC_CRON = "17 3 * * *";

export type BlobGcDeps = { readonly db: Db; readonly clock: Clock; readonly logger: Logger };

/** One pass: what it deleted, counted. */
export const collectStaleUploads = async (deps: BlobGcDeps): Promise<{ readonly unfinished: number; readonly finished: number }> => {
  const before = new Date(deps.clock.now() - STALE_UPLOAD_MS);
  const unfinished = await deps.db.blobUpload.deleteMany({ where: { blobId: null, updatedAt: { lt: before } } });
  const finished = await deps.db.blobUpload.deleteMany({ where: { blobId: { not: null }, updatedAt: { lt: before } } });
  return { unfinished: unfinished.count, finished: finished.count };
};

export const blobGcHandler =
  (deps: BlobGcDeps): JobHandler<"blob.gc"> =>
  async (context) => {
    const deleted = await collectStaleUploads(deps);
    context.logger.info("blob.gc", { unfinishedUploads: deleted.unfinished, finishedUploads: deleted.finished });
  };

/** The daily schedule: one tick a day however many replicas run. */
export const ensureBlobGcSchedule = async (jobs: Pick<Jobs, "schedule">): Promise<void> => {
  await jobs.schedule("blob.gc", "daily", BLOB_GC_CRON, {});
};
