import { createHash, randomUUID } from "node:crypto";

import { adapterError, BlobStoreAdapter, ok } from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterResult,
  BlobScope,
  BlobStoreCapabilities,
  HealthReport,
  StoredBlob,
  UploadSession,
} from "@ostra/adapter-sdk";
import { blobIdSchema, uploadIdSchema } from "@ostra/protocol";
import type { BlobId, OrganizationId, UploadId } from "@ostra/protocol";

import type { BlobRows, UploadRow } from "./blob-rows.ts";

// The built-in blob store (ADR 0043): bytes in Postgres rows the server provides through
// `BlobRows`, so a fresh install needs nothing else and one backup covers everything. A blob over
// the cap is refused: for a session archive that means the next reopen uses the rebuild template
// (ADR 0039), so a size limit never strands a task. Bytes are untrusted: they're stored and handed
// back as they are, and nothing here interprets them.
//
// Logs carry blob IDs, sizes and organizations, never content.

/** The cap per blob: a working value of ADR 0043. */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;

const STORE = "postgres";
const SHA256 = /^[0-9a-f]{64}$/;

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const keyOf = (id: BlobId): string => `${STORE}:${id}`;
const idOf = (key: string): BlobId | undefined => {
  if (!key.startsWith(`${STORE}:`)) {
    return undefined;
  }
  const parsed = blobIdSchema.safeParse(key.slice(STORE.length + 1));
  return parsed.success ? parsed.data : undefined;
};

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export class PostgresBlobStore extends BlobStoreAdapter {
  readonly name = STORE;
  readonly capabilities: BlobStoreCapabilities = { resumableUpload: true };

  readonly #rows: BlobRows;
  readonly #maxBytes: number;

  constructor(options: { readonly rows: BlobRows; readonly maxBytes?: number }, context?: AdapterContext) {
    super(context);
    this.#rows = options.rows;
    this.#maxBytes = options.maxBytes ?? MAX_BLOB_BYTES;
  }

  health(): Promise<HealthReport> {
    // The rows' database has its own health check; this store holds no state of its own.
    return Promise.resolve({ status: "ok" });
  }

  async put(scope: BlobScope, bytes: Uint8Array, contentType: string): Promise<AdapterResult<StoredBlob>> {
    if (bytes.length > this.#maxBytes) {
      return adapterError("invalid-input", `a blob over ${String(this.#maxBytes)} bytes is refused`);
    }
    return this.#store(scope.organizationId, scope.purpose, contentType, bytes, digest(bytes));
  }

  async get(organizationId: OrganizationId, key: string): Promise<AdapterResult<Uint8Array>> {
    const id = idOf(key);
    const row = id === undefined ? undefined : await this.#rows.getBlob(id).catch(() => undefined);
    // Another organization's blob answers as a missing one.
    return row?.organizationId === organizationId ? ok(row.bytes) : adapterError("not-found", "no such blob");
  }

  async delete(organizationId: OrganizationId, key: string): Promise<AdapterResult<void>> {
    const id = idOf(key);
    const row = id === undefined ? undefined : await this.#rows.getBlob(id).catch(() => undefined);
    if (id === undefined || row?.organizationId !== organizationId) {
      return adapterError("not-found", "no such blob");
    }
    try {
      await this.#rows.deleteBlob(id);
    } catch {
      return adapterError("unavailable", "the blob store could not delete the blob");
    }
    this.plumbing.logger.info("blob.deleted", { organizationId, blobId: id });
    return ok(undefined);
  }

  async startUpload(scope: BlobScope, expectedSha256: string, size: number): Promise<AdapterResult<UploadSession>> {
    if (!SHA256.test(expectedSha256)) {
      return adapterError("invalid-input", "an upload needs the SHA-256 of its bytes, in hex");
    }
    if (!Number.isInteger(size) || size < 0 || size > this.#maxBytes) {
      return adapterError("invalid-input", `a blob over ${String(this.#maxBytes)} bytes is refused`);
    }
    try {
      // The same upload again, after a drop: it resumes where the last chunk ended.
      const existing = await this.#rows.findUpload(scope.organizationId, scope.purpose, expectedSha256);
      if (existing?.size === size) {
        return ok({ uploadId: existing.uploadId, receivedBytes: existing.received.length });
      }
      const row: UploadRow = {
        uploadId: uploadIdSchema.parse(randomUUID()),
        organizationId: scope.organizationId,
        purpose: scope.purpose,
        expectedSha256,
        size,
        received: new Uint8Array(0),
        blobId: null,
      };
      await this.#rows.putUpload(row);
      return ok({ uploadId: row.uploadId, receivedBytes: 0 });
    } catch {
      return adapterError("unavailable", "the blob store could not start the upload");
    }
  }

  async appendUpload(uploadId: UploadId, offset: number, chunk: Uint8Array): Promise<AdapterResult<UploadSession>> {
    const upload = await this.#rows.getUpload(uploadId).catch(() => undefined);
    if (upload?.blobId !== null) {
      return adapterError("not-found", "no such open upload");
    }
    const have = upload.received.length;
    if (!Number.isInteger(offset) || offset < 0 || offset > have) {
      return adapterError("conflict", `the chunk starts at ${String(offset)}, but ${String(have)} bytes have arrived: send from there`);
    }
    if (offset + chunk.length > upload.size) {
      return adapterError("invalid-input", "the chunk runs past the size the upload was started with");
    }
    if (offset < have) {
      // A chunk sent twice is stored once: only a repeat of what's there is accepted.
      const overlap = Math.min(have - offset, chunk.length);
      const same = Buffer.from(upload.received.subarray(offset, offset + overlap)).equals(Buffer.from(chunk.subarray(0, overlap)));
      if (!same) {
        return adapterError("conflict", "the chunk differs from the bytes already received at that offset");
      }
      if (offset + chunk.length <= have) {
        return ok({ uploadId, receivedBytes: have });
      }
    }
    const next = concat(upload.received, chunk.subarray(have - offset));
    try {
      await this.#rows.putUpload({ ...upload, received: next });
    } catch {
      return adapterError("unavailable", "the blob store could not save the chunk");
    }
    return ok({ uploadId, receivedBytes: next.length });
  }

  async finishUpload(uploadId: UploadId): Promise<AdapterResult<StoredBlob>> {
    const upload = await this.#rows.getUpload(uploadId).catch(() => undefined);
    if (upload === undefined) {
      return adapterError("not-found", "no such upload");
    }
    if (upload.blobId !== null) {
      // Finishing twice answers the same.
      return ok({ key: keyOf(upload.blobId), size: upload.size, sha256: upload.expectedSha256 });
    }
    if (upload.received.length !== upload.size) {
      return adapterError("conflict", `${String(upload.received.length)} of ${String(upload.size)} bytes have arrived`);
    }
    const stored = await this.#store(upload.organizationId, upload.purpose, "application/octet-stream", upload.received, upload.expectedSha256);
    if (stored.ok) {
      // The store just made this key, so it always has an ID.
      const id = idOf(stored.value.key);
      if (id !== undefined) {
        await this.#rows.putUpload({ ...upload, received: new Uint8Array(0), blobId: id }).catch(() => undefined);
      }
    }
    return stored;
  }

  async #store(
    organizationId: OrganizationId,
    purpose: string,
    contentType: string,
    bytes: Uint8Array,
    expectedSha256: string,
  ): Promise<AdapterResult<StoredBlob>> {
    const actual = digest(bytes);
    if (actual !== expectedSha256) {
      this.plumbing.logger.warn("blob.digest_mismatch", { organizationId, purpose, size: bytes.length });
      return adapterError("conflict", "the bytes do not match their SHA-256");
    }
    const id = blobIdSchema.parse(randomUUID());
    try {
      await this.#rows.insertBlob({ id, organizationId, purpose, contentType, size: bytes.length, sha256: actual, bytes });
    } catch {
      return adapterError("unavailable", "the blob store could not save the blob");
    }
    this.plumbing.logger.info("blob.stored", { organizationId, purpose, blobId: id, size: bytes.length });
    return ok({ key: keyOf(id), size: bytes.length, sha256: actual });
  }
}
