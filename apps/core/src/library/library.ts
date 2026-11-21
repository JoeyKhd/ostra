import { checkUpdates, libraryUpdateWindowStart, organizationsToSeed, seedSources } from "@ostra/domain";
import type { Clock, JobQueue, LibraryBlobRead, LibraryBlobs, LibraryCheckDeps, LibraryDeps } from "@ostra/domain";
import type { Db } from "@ostra/db";
import type { JobHandler } from "@ostra/jobs";
import { libraryItemIdSchema, organizationIdSchema } from "@ostra/protocol";

import type { BlobService } from "../blobs/blob-service.ts";

// The library in core (F-145, ADR 0069, ticket 27). The use cases are the domain's
// (`packages/domain/src/library/`), so the panel's procedures (ticket 30) and core's jobs run the
// same bodies. Core gives them its blob service for a skill's files (`library-file`: the
// organization's, with no task, which dispatch copies into each task that gets the skill, ticket
// 28), and runs `library.seed-sources`: GitHub's curated MCP registry on the list of every
// organization that existed before milestone 8, once (Q324). A new organization gets it when it's
// made. Lines carry IDs, never a file's content, a header's value or a secret.
//
// Ticket 28: `library.check-updates`, with core's reader of the organization's blobs for the diff.
// Each organization with an installed item gets one check per window of `OSTRA_LIBRARY_UPDATE_HOURS`
// (keyed by the organization and the window's start): the schedules' pass sends the next window's,
// held until it begins, so a restart or a second replica sends it again only as the same key. An
// admin's "Check for updates" sends one keyed by the item, at once.

/** A library file's blob purpose (spec section 5.3). */
export const LIBRARY_FILE_PURPOSE = "library-file";

/** The library's writes through core's blob service: the organization's blob, with no task. */
export const libraryBlobs = (blobs: Pick<BlobService, "put">): LibraryBlobs => ({
  put: async (organizationId, bytes) => {
    const stored = await blobs.put({ organizationId, task: null }, { purpose: LIBRARY_FILE_PURPOSE, contentType: "application/octet-stream", bytes });
    return stored.ok ? { ok: true, blobId: stored.value.blobId } : { ok: false, message: stored.message };
  },
});

/** `library.seed-sources`: the seed, for the organization the job names. */
export const seedSourcesHandler =
  (deps: LibraryDeps): JobHandler<"library.seed-sources"> =>
  async (context) => {
    const organizationId = organizationIdSchema.parse(context.payload.organizationId);
    const seeded = await seedSources(deps, { organizationId });
    if (seeded.added) {
      context.logger.info("library.sources-seeded", { organizationId });
    }
  };

/** Once at start: `library.seed-sources` for each organization whose list nobody touched (one per organization, by its key). */
export const enqueueLibrarySourceSeeds = async (deps: { readonly db: Db; readonly jobs: JobQueue }): Promise<number> => {
  const organizations = await organizationsToSeed(deps.db);
  for (const organizationId of organizations) {
    await deps.db.$transaction((tx) => deps.jobs.enqueueInTx(tx, "library.seed-sources", { organizationId }));
  }
  return organizations.length;
};

/** The update check's reader of a library file: the organization's blob, with no task. */
export const libraryBlobRead =
  (blobs: Pick<BlobService, "read">): LibraryBlobRead =>
  async (organizationId, blobId) => {
    const read = await blobs.read(organizationId, blobId);
    return read.ok ? { ok: true, bytes: read.value.bytes } : { ok: false, message: read.message };
  };

/** `library.check-updates`: an organization's window, or one item an admin asked for. */
export const checkUpdatesHandler =
  (deps: LibraryCheckDeps): JobHandler<"library.check-updates"> =>
  async (context) => {
    const organizationId = organizationIdSchema.parse(context.payload.organizationId);
    const itemId = "itemId" in context.payload ? libraryItemIdSchema.parse(context.payload.itemId) : null;
    const result = await checkUpdates(deps, { organizationId, itemId });
    context.logger.info("library.check-updates", {
      organizationId,
      itemId,
      checked: result.checked,
      found: result.found.filter((entry) => entry.update.kind !== "none").length,
      refused: result.refused,
      failed: result.failed,
    });
  };

/**
 * The schedules' pass: for each organization with an installed item, the next window's check,
 * held until the window begins. One per organization and window, by its key; an organization with
 * no item makes no call (ADR 0021, amended by ADR 0069).
 */
export const enqueueLibraryUpdateChecks = async (deps: { readonly db: Db; readonly jobs: JobQueue; readonly clock: Clock; readonly updateHours: number }): Promise<number> => {
  const now = deps.clock.now();
  const next = libraryUpdateWindowStart(now, deps.updateHours) + deps.updateHours * 3_600_000;
  const organizations = await deps.db.organization.findMany({ where: { libraryItems: { some: { removedAt: null } } }, select: { id: true }, orderBy: { createdAt: "asc" } });
  for (const organization of organizations) {
    const organizationId = organizationIdSchema.parse(organization.id);
    await deps.db.$transaction((tx) => deps.jobs.enqueueInTx(tx, "library.check-updates", { organizationId, windowStart: next }, { startAfterMs: next - now }));
  }
  return organizations.length;
};
