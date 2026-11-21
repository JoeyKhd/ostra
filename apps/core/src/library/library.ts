import { organizationsToSeed, seedSources } from "@ostra/domain";
import type { JobQueue, LibraryBlobs, LibraryDeps } from "@ostra/domain";
import type { Db } from "@ostra/db";
import type { JobHandler } from "@ostra/jobs";
import { organizationIdSchema } from "@ostra/protocol";

import type { BlobService } from "../blobs/blob-service.ts";

// The library in core (F-145, ADR 0069, ticket 27). The use cases are the domain's
// (`packages/domain/src/library/`), so the panel's procedures (ticket 30) and core's jobs run the
// same bodies. Core gives them its blob service for a skill's files (`library-file`: the
// organization's, with no task, which dispatch copies into each task that gets the skill, ticket
// 28), and runs `library.seed-sources`: GitHub's curated MCP registry on the list of every
// organization that existed before milestone 8, once (Q324). A new organization gets it when it's
// made. Lines carry IDs, never a file's content, a header's value or a secret.

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
