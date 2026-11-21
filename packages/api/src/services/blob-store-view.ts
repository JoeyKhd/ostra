import type { HealthReport } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import type { PanelBlobPurpose } from "@ostra/domain";

// What the panel needs of the blob store (F-114, ADR 0043): its name and health for the storage page,
// and a way to read one blob for the member who may see it (a check's full output, F-054). The
// panel writes no blob itself: core's blob service does, and `upload` is the panel asking it to
// (ADR 0043; a skill's files, ticket 42). It reads only what its own database holds, the
// built-in store's chunks, and says so for a blob kept elsewhere.

/** A blob's bytes with what a download needs. */
export type BlobBytes = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly size: number;
};

/** Why a blob was not read: there is none for that owner, or it is kept in a store the panel does not reach. */
export type BlobReadResult =
  | { readonly kind: "found"; readonly blob: BlobBytes }
  | { readonly kind: "not-found" }
  | { readonly kind: "other-store"; readonly store: string };

/** Why core didn't store a member's file: it is over the cap, or core didn't take it. */
export type BlobUploadResult =
  | { readonly kind: "stored"; readonly blobId: string; readonly size: number }
  | { readonly kind: "too-large" }
  | { readonly kind: "unavailable" };

export type BlobStoreView = {
  readonly name: "postgres" | "s3";
  readonly health: () => Promise<HealthReport>;
  /**
   * A blob of one task of one organization, or (`taskId: null`) one of the organization's own with
   * no task, such as a library skill's file (ticket 30); another task's or organization's, or a
   * task's when `null` is asked, is `not-found`.
   */
  readonly read: (organizationId: string, taskId: string | null, blobId: string) => Promise<BlobReadResult>;
  /** Stores a member's file for the organization through core's blob service (never a task's blob). */
  readonly upload: (input: { readonly organizationId: string; readonly purpose: PanelBlobPurpose; readonly bytes: Uint8Array }) => Promise<BlobUploadResult>;
};

/** Reads a blob from the built-in store's tables, in the database the panel already uses. */
export const postgresBlobReader =
  (db: Db): BlobStoreView["read"] =>
  async (organizationId, taskId, blobId) => {
    const blob = await db.blob.findFirst({ where: { id: blobId, organizationId, taskId }, select: { id: true, store: true, contentType: true, size: true } });
    if (blob === null) {
      return { kind: "not-found" };
    }
    if (blob.store !== "postgres") {
      return { kind: "other-store", store: blob.store };
    }
    const chunks = await db.blobChunk.findMany({ where: { blobId: blob.id, organizationId }, orderBy: { ordinal: "asc" }, select: { bytes: true } });
    const bytes = new Uint8Array(blob.size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk.bytes, offset);
      offset += chunk.bytes.length;
    }
    return { kind: "found", blob: { bytes: bytes.subarray(0, offset), contentType: blob.contentType, size: offset } };
  };
