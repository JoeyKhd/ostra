import type { Logger, SecretRef, SecretStoreAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { libraryVersionFilesSchema, storedServerInputsSchema, storedSkillFilesSchema } from "@ostra/domain";
import type { Clock, StoredServerInputs } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { blobIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { OrganizationId } from "@ostra/protocol";

import type { BlobService } from "../blobs/blob-service.ts";
import { LIBRARY_FILE_PURPOSE } from "./library.ts";

// `library.cleanup` (F-145, ADR 0069, a follow-up to ticket 28): once a day, what the library keeps
// and no version in use needs goes, for every organization.
//
// - A version is in use while its item is installed and it's `current` or `available` (waiting for
//   an admin). A `superseded` or `dismissed` one, and every version of a removed item, is out of use.
// - A library file (an organization's blob, `library-file`, no task) goes when no version in use
//   names it, and no profile's own skill does. That's a superseded or dismissed version's files, a
//   removed item's, and a file an install or an update check stored and never wrote a version for.
// - A secret input goes when a version out of use names it and no version in use does: a removed
//   server's, and one a dismissed update moved to the secret store. A version's row stays, so the
//   update check still knows what it found before and a dismissed update stays dismissed.
//
// What an open task needs stays: a dispatch copies a library skill's files into the task's own blobs
// (`profile-spec.ts`), so a running session never reads the library's again, and a task's blobs go
// only with the task. The one read in flight is a dispatch or a credentials request that read a
// version just before an admin moved it: so nothing of an item goes until the item and its versions
// have stood still for the grace, and no file goes in its first grace either, while the install or
// the check that stored it writes its version. Lines carry IDs and counts, never a file's content,
// a header's value or a secret's reference.

/** How long an item stands still, and a file is kept at least, before the clean-up takes anything of it: a working value. */
export const LIBRARY_CLEANUP_GRACE_MS = 15 * 60_000;

/** When the daily pass runs (UTC, as every connection runs). */
export const LIBRARY_CLEANUP_CRON = "53 3 * * *";

export type LibraryCleanupDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly blobs: Pick<BlobService, "delete">;
  readonly secretStore: Pick<SecretStoreAdapter, "delete">;
  readonly logger: Logger;
};

/** One pass, counted. `skipped`: organizations left alone because a version in use doesn't parse. */
export type LibraryCleanup = {
  readonly organizations: number;
  readonly blobsDeleted: number;
  readonly secretsDeleted: number;
  readonly failed: number;
  readonly skipped: number;
};

const secretRefsOf = (inputs: StoredServerInputs): readonly SecretRef[] =>
  [...Object.values(inputs.variables), ...Object.values(inputs.headers)].flatMap((input) => (input.kind === "secret" ? [input.ref] : []));

type OrganizationPass = { readonly blobsDeleted: number; readonly secretsDeleted: number; readonly failed: number; readonly skipped: boolean };

const cleanUpOrganization = async (deps: LibraryCleanupDeps, organizationId: OrganizationId, settledBefore: number): Promise<OrganizationPass> => {
  const items = await deps.db.libraryItem.findMany({
    where: { organizationId },
    select: { id: true, removedAt: true, updatedAt: true, versions: { select: { state: true, files: true, serverInputs: true, fetchedAt: true, decidedAt: true } } },
  });
  const keptBlobs = new Set<string>();
  const keptRefs = new Set<string>();
  const outOfUse = new Map<string, { readonly ref: SecretRef; readonly itemId: string }>();
  for (const item of items) {
    // Every move of a version stamps one of these: a find, an accept (the item's pin), a dismissal, a removal.
    const lastMove = Math.max(item.updatedAt.getTime(), item.removedAt?.getTime() ?? 0, ...item.versions.flatMap((version) => [version.fetchedAt.getTime(), version.decidedAt?.getTime() ?? 0]));
    const settled = lastMove < settledBefore;
    for (const version of item.versions) {
      const kept = !settled || (item.removedAt === null && (version.state === "current" || version.state === "available"));
      const files = libraryVersionFilesSchema.safeParse(version.files);
      const inputs = version.serverInputs === null ? null : storedServerInputsSchema.safeParse(version.serverInputs);
      if (!files.success || inputs?.success === false) {
        if (kept) {
          // What it names can't be told, so nothing of the organization's goes this pass.
          deps.logger.warn("library.cleanup.version-unreadable", { organizationId, itemId: item.id });
          return { blobsDeleted: 0, secretsDeleted: 0, failed: 0, skipped: true };
        }
        continue;
      }
      const refs = inputs === null ? [] : secretRefsOf(inputs.data);
      if (kept) {
        for (const file of files.data) {
          keptBlobs.add(file.blobId);
        }
        for (const ref of refs) {
          keptRefs.add(ref);
        }
      } else {
        for (const ref of refs) {
          outOfUse.set(ref, { ref, itemId: item.id });
        }
      }
    }
  }
  // A profile's own skill names blobs too: none of them goes, whatever its purpose.
  for (const skill of await deps.db.agentProfileSkill.findMany({ where: { organizationId }, select: { profileId: true, files: true } })) {
    const files = storedSkillFilesSchema.safeParse(skill.files);
    if (!files.success) {
      deps.logger.warn("library.cleanup.profile-skill-unreadable", { organizationId, profileId: skill.profileId });
      return { blobsDeleted: 0, secretsDeleted: 0, failed: 0, skipped: true };
    }
    for (const file of files.data) {
      keptBlobs.add(file.blobId);
    }
  }

  let blobsDeleted = 0;
  let secretsDeleted = 0;
  let failed = 0;
  const stored = await deps.db.blob.findMany({
    where: { organizationId, taskId: null, purpose: LIBRARY_FILE_PURPOSE, createdAt: { lt: new Date(settledBefore) } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  for (const blob of stored) {
    if (keptBlobs.has(blob.id)) {
      continue;
    }
    const deleted = await deps.blobs.delete(organizationId, blobIdSchema.parse(blob.id));
    if (deleted.ok) {
      blobsDeleted += 1;
    } else if (deleted.error !== "not-found") {
      // Kept for the next pass.
      deps.logger.warn("library.cleanup.blob-delete-failed", { organizationId, blobId: blob.id, error: deleted.error });
      failed += 1;
    }
  }
  for (const { ref, itemId } of outOfUse.values()) {
    if (keptRefs.has(ref)) {
      continue;
    }
    const deleted = await deps.secretStore.delete(organizationId, ref);
    if (deleted.ok) {
      secretsDeleted += 1;
    } else if (deleted.error.code !== "not-found") {
      // Gone already is done: a pass before took it. Anything else waits for the next pass.
      deps.logger.warn("library.cleanup.secret-delete-failed", { organizationId, itemId, code: deleted.error.code });
      failed += 1;
    }
  }
  return { blobsDeleted, secretsDeleted, failed, skipped: false };
};

/** One pass over every organization that has, or had, a library item. Idempotent: a second pass deletes nothing more. */
export const cleanUpLibrary = async (deps: LibraryCleanupDeps): Promise<LibraryCleanup> => {
  const settledBefore = deps.clock.now() - LIBRARY_CLEANUP_GRACE_MS;
  const organizations = await deps.db.organization.findMany({ where: { libraryItems: { some: {} } }, select: { id: true }, orderBy: { createdAt: "asc" } });
  let blobsDeleted = 0;
  let secretsDeleted = 0;
  let failed = 0;
  let skipped = 0;
  for (const organization of organizations) {
    const pass = await cleanUpOrganization(deps, organizationIdSchema.parse(organization.id), settledBefore);
    blobsDeleted += pass.blobsDeleted;
    secretsDeleted += pass.secretsDeleted;
    failed += pass.failed;
    skipped += pass.skipped ? 1 : 0;
  }
  return { organizations: organizations.length, blobsDeleted, secretsDeleted, failed, skipped };
};

export const libraryCleanupHandler =
  (deps: LibraryCleanupDeps): JobHandler<"library.cleanup"> =>
  async (context) => {
    const done = await cleanUpLibrary(deps);
    context.logger.info("library.cleanup", done);
  };

/** The daily schedule: one tick a day however many replicas run. */
export const ensureLibraryCleanupSchedule = async (jobs: Pick<Jobs, "schedule">): Promise<void> => {
  await jobs.schedule("library.cleanup", "daily", LIBRARY_CLEANUP_CRON, {});
};
