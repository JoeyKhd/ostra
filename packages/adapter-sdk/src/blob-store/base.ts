import type { OrganizationId } from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import type { BlobStoreCapabilities } from "./capabilities.ts";

// The blob store kind (ADR 0025, ADR 0043): built in (Postgres) for v1, any S3-compatible store as
// an option. Declared now; the first adapter comes in milestone 2 with session archives.

export type BlobScope = { readonly organizationId: OrganizationId; readonly purpose: string };

export type StoredBlob = {
  /** The store's key for it: safe to store and log. */
  readonly key: string;
  readonly size: number;
  /** SHA-256 of the bytes, hex. */
  readonly sha256: string;
};

export type UploadSession = { readonly uploadId: string; readonly receivedBytes: number };

export abstract class BlobStoreAdapter {
  readonly kind = "blob-store" as const;
  abstract readonly name: string;
  abstract readonly capabilities: BlobStoreCapabilities;

  readonly #context: AdapterContext;
  #plumbing: Plumbing | undefined;

  constructor(context: AdapterContext = defaultAdapterContext) {
    this.#context = context;
  }

  /** Retries, rate budgets, idempotency and the logger, shared by every adapter (ADR 0025). */
  protected get plumbing(): Plumbing {
    this.#plumbing ??= createPlumbing(this.#context, { kind: this.kind, name: this.name });
    return this.#plumbing;
  }

  abstract health(): Promise<HealthReport>;

  /** Stores bytes whole. Milestone 2. */
  abstract put(scope: BlobScope, bytes: Uint8Array, contentType: string): Promise<AdapterResult<StoredBlob>>;

  /** Milestone 2. Another organization's key answers `not-found`. */
  abstract get(organizationId: OrganizationId, key: string): Promise<AdapterResult<Uint8Array>>;

  /** Milestone 2. */
  abstract delete(organizationId: OrganizationId, key: string): Promise<AdapterResult<void>>;

  /** Starts or resumes a chunked upload, when the adapter has `resumableUpload`. Milestone 2. */
  abstract startUpload(scope: BlobScope, expectedSha256: string, size: number): Promise<AdapterResult<UploadSession>>;

  /** Appends a chunk at `offset`. Milestone 2. */
  abstract appendUpload(uploadId: string, offset: number, chunk: Uint8Array): Promise<AdapterResult<UploadSession>>;

  /** Checks the digest and stores the blob. Milestone 2. */
  abstract finishUpload(uploadId: string): Promise<AdapterResult<StoredBlob>>;
}
