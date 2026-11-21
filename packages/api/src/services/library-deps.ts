import type { LibraryBlobs, LibraryDeps } from "@ostra/domain";
import { blobIdSchema } from "@ostra/protocol";

import type { ApiDeps } from "../trpc/context.ts";
import type { BlobStoreView } from "./blob-store-view.ts";

// The library's use cases in the panel (milestone 8, ticket 30; ADR 0069). Their bodies are the
// domain's (`packages/domain/src/library/`), which core's jobs run too: the panel hands them its
// database and ports, the fetch its calls out go through, the library's settings, and a blob writer
// that asks core's blob service to store each file of a skill an admin installs (ADR 0043: the
// panel writes no blob itself), as the organization's blob with no task, under `library-file`.

/** A library skill's file, written through core's panel blob endpoint. Words, never content. */
export const panelLibraryBlobs = (blobStore: Pick<BlobStoreView, "upload">): LibraryBlobs => ({
  put: async (organizationId, bytes) => {
    const stored = await blobStore.upload({ organizationId, purpose: "library-file", bytes });
    switch (stored.kind) {
      case "stored":
        return { ok: true, blobId: blobIdSchema.parse(stored.blobId) };
      case "too-large":
        return { ok: false, message: "it is over a library file's limit" };
      case "unavailable":
        return { ok: false, message: "core's blob service didn't take it" };
      default:
        return stored satisfies never;
    }
  },
});

/** What the library's use cases take, from the panel's own dependencies. */
export const libraryDepsOf = (deps: ApiDeps): LibraryDeps => ({
  db: deps.db,
  ...deps.ports,
  fetch: deps.library.fetch,
  settings: deps.settings.library,
  blobs: panelLibraryBlobs(deps.blobStore),
  serverVersion: deps.library.serverVersion,
  logger: deps.logger,
});
