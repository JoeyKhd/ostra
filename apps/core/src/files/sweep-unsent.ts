import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { FILES_SWEEP_CRON, UNSENT_UPLOAD_TTL_MS } from "@ostra/domain";
import type { Clock } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { blobIdSchema, organizationIdSchema } from "@ostra/protocol";

import type { BlobService } from "../blobs/blob-service.ts";

// `files.sweep-unsent` (F-148, ADR 0070, Q338, ticket 10): every hour, the uploads no message took
// within 24 hours go. Each such file is marked `expired` first, guarded on its state, so a send
// that took it a moment before keeps it, and a member can't send it from then on; then its blob and
// its text's blob are deleted from whichever store holds them, and the row keeps its record with
// no blob. A store that doesn't answer stops the pass: the files whose blobs it still holds stay
// `expired` with their blobs named, and the next hour's pass deletes them. A sent file is the
// task's, and goes only with the task. Every time comes from the `Clock`. Lines carry counts and
// IDs: never a file's name.

/** The most expired files one pass deletes the blobs of: the rest wait for the next hour. A working value. */
export const UNSENT_SWEEP_FILES_MAX = 2000;

const PAGE = 100;

export type UnsentSweepDeps = {
  readonly db: Db;
  readonly blobs: Pick<BlobService, "delete">;
  readonly clock: Clock;
  readonly logger: Logger;
};

/** One pass, counted: files expired, blobs deleted, and deletes a store refused (the pass stopped at the first). */
export type UnsentSweep = { readonly expired: number; readonly blobsDeleted: number; readonly failed: number };

/** One pass. Idempotent: a second one at the same time expires and deletes nothing more. */
export const sweepUnsentUploads = async (deps: UnsentSweepDeps): Promise<UnsentSweep> => {
  const before = new Date(deps.clock.now() - UNSENT_UPLOAD_TTL_MS);
  // Only a member's upload no message took: a sent file, a ticket's and one younger than a day stay.
  const expired = await deps.db.messageFile.updateMany({
    where: { origin: "member", state: "uploaded", taskId: null, createdAt: { lt: before } },
    data: { state: "expired" },
  });
  let blobsDeleted = 0;
  let seen = 0;
  let after: string | null = null;
  while (seen < UNSENT_SWEEP_FILES_MAX) {
    const rows: readonly { readonly id: string; readonly organizationId: string; readonly blobId: string | null; readonly textBlobId: string | null }[] =
      await deps.db.messageFile.findMany({
        where: {
          origin: "member",
          state: "expired",
          taskId: null,
          OR: [{ blobId: { not: null } }, { textBlobId: { not: null } }],
          ...(after === null ? {} : { id: { gt: after } }),
        },
        orderBy: { id: "asc" },
        take: PAGE,
        select: { id: true, organizationId: true, blobId: true, textBlobId: true },
      });
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      seen += 1;
      const organizationId = organizationIdSchema.parse(row.organizationId);
      for (const id of [row.blobId, row.textBlobId]) {
        if (id === null) {
          continue;
        }
        const blobId = blobIdSchema.parse(id);
        // The row's blob column clears with the blob's row (its foreign key sets it null).
        const deleted = await deps.blobs.delete(organizationId, blobId);
        if (deleted.ok) {
          blobsDeleted += 1;
        } else if (deleted.error !== "not-found") {
          deps.logger.warn("files.sweep-unsent.delete-failed", { organizationId, fileId: row.id, blobId, error: deleted.error });
          return { expired: expired.count, blobsDeleted, failed: 1 };
        }
      }
    }
    after = rows.at(-1)?.id ?? null;
  }
  return { expired: expired.count, blobsDeleted, failed: 0 };
};

export const sweepUnsentHandler =
  (deps: UnsentSweepDeps): JobHandler<"files.sweep-unsent"> =>
  async (context) => {
    const done = await sweepUnsentUploads(deps);
    if (done.expired + done.blobsDeleted + done.failed > 0) {
      context.logger.info("files.sweep-unsent", { ...done });
    }
  };

/** The hourly schedule: one tick an hour however many replicas run. */
export const ensureUnsentSweepSchedule = async (jobs: Pick<Jobs, "schedule">): Promise<void> => {
  await jobs.schedule("files.sweep-unsent", "hourly", FILES_SWEEP_CRON, {});
};
