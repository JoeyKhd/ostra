import type { BlobStoreAdapter, Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import type { Clock } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { uploadIdSchema } from "@ostra/protocol";

// `blob.gc` (ticket 12): once a day, the uploads nobody finished within 24 h go, with their chunks
// (the foreign key cascades). A runner that dropped mid-upload resumes within minutes; one that
// never came back leaves bytes nothing refers to. A finished upload's record goes too after 24 h:
// its chunks already moved to its blob, which stays.

/** How long an upload may sit unfinished before `blob.gc` deletes it: a working value. */
export const STALE_UPLOAD_MS = 24 * 60 * 60_000;

/** When the daily pass runs (UTC, as every connection runs). */
export const BLOB_GC_CRON = "17 3 * * *";

export type BlobGcDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * The S3-compatible store, when this install has one: an upload it holds is dropped with its
   * record, so no chunk stays in the bucket. The bucket's own expiry on `uploads/` is the backstop.
   */
  readonly s3?: BlobStoreAdapter;
};

/** One pass: what it deleted, counted. */
export const collectStaleUploads = async (deps: BlobGcDeps): Promise<{ readonly unfinished: number; readonly finished: number }> => {
  const before = new Date(deps.clock.now() - STALE_UPLOAD_MS);
  // An S3-compatible store holds the bytes of its uploads itself: it lets go of them first, and a
  // record whose bytes it could not drop stays for the next pass.
  const kept: string[] = [];
  if (deps.s3 !== undefined) {
    const stale = await deps.db.blobUpload.findMany({ where: { blobId: null, store: "s3", updatedAt: { lt: before } }, select: { id: true } });
    for (const upload of stale) {
      const dropped = await deps.s3.abortUpload(uploadIdSchema.parse(upload.id));
      if (!dropped.ok) {
        deps.logger.warn("blob.gc.abort-failed", { uploadId: upload.id, code: dropped.error.code });
        kept.push(upload.id);
      }
    }
  }
  const unfinished = await deps.db.blobUpload.deleteMany({ where: { blobId: null, updatedAt: { lt: before }, id: { notIn: kept } } });
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
