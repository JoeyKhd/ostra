import type { OrganizationId } from "@ostra/protocol";

// The rows the built-in blob store keeps (ADR 0043). The server backs these ports with Postgres in
// milestone 2, in their own table and in chunks, so they never share a table with the event log.
// This package never imports the database package, so the Apache-2.0 side stays clear of the
// restricted one (ADR 0045). `createMemoryBlobRows` is what tests and a one-process dev run use.

export type BlobRow = {
  readonly id: string;
  readonly organizationId: OrganizationId;
  /** What it's for, such as `session-archive`: words and IDs, never content. */
  readonly purpose: string;
  readonly contentType: string;
  readonly size: number;
  /** SHA-256 of the bytes, hex. */
  readonly sha256: string;
  readonly bytes: Uint8Array;
};

/** A chunked upload in flight. A drop leaves it here, and the next start resumes it. */
export type UploadRow = {
  readonly uploadId: string;
  readonly organizationId: OrganizationId;
  readonly purpose: string;
  readonly expectedSha256: string;
  readonly size: number;
  /** The bytes received so far, from offset 0, with no gap. */
  readonly received: Uint8Array;
  /** Set once the upload finished: its blob, so finishing twice answers the same. */
  readonly blobId: string | null;
};

export type BlobRows = {
  readonly insertBlob: (row: BlobRow) => Promise<void>;
  readonly getBlob: (id: string) => Promise<BlobRow | undefined>;
  readonly deleteBlob: (id: string) => Promise<boolean>;
  /** The open upload for this organization, purpose and digest, if one exists (a resume). */
  readonly findUpload: (organizationId: OrganizationId, purpose: string, expectedSha256: string) => Promise<UploadRow | undefined>;
  readonly getUpload: (uploadId: string) => Promise<UploadRow | undefined>;
  readonly putUpload: (row: UploadRow) => Promise<void>;
};

export const createMemoryBlobRows = (): BlobRows & { readonly blobs: ReadonlyMap<string, BlobRow> } => {
  const blobs = new Map<string, BlobRow>();
  const uploads = new Map<string, UploadRow>();
  return {
    blobs,
    insertBlob: (row) => {
      blobs.set(row.id, row);
      return Promise.resolve();
    },
    getBlob: (id) => Promise.resolve(blobs.get(id)),
    deleteBlob: (id) => Promise.resolve(blobs.delete(id)),
    findUpload: (organizationId, purpose, expectedSha256) =>
      Promise.resolve(
        [...uploads.values()].find(
          (row) =>
            row.organizationId === organizationId && row.purpose === purpose && row.expectedSha256 === expectedSha256 && row.blobId === null,
        ),
      ),
    getUpload: (uploadId) => Promise.resolve(uploads.get(uploadId)),
    putUpload: (row) => {
      uploads.set(row.uploadId, row);
      return Promise.resolve();
    },
  };
};
