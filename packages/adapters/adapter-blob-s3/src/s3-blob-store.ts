import { createHash, randomUUID } from "node:crypto";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { CompletedPart } from "@aws-sdk/client-s3";
import { adapterError, BlobStoreAdapter, ok } from "@ostra/adapter-sdk";
import type { AdapterContext, AdapterResult, BlobScope, BlobStoreCapabilities, HealthReport, StoredBlob, UploadSession } from "@ostra/adapter-sdk";
import { uploadIdSchema } from "@ostra/protocol";
import type { OrganizationId, UploadId } from "@ostra/protocol";
import { z } from "zod";

import { isNotFound, toAdapterError } from "./s3-errors.ts";

// The S3-compatible blob store (ADR 0043, ticket 11): any bucket that speaks the S3 API. Every
// server process is stateless and any replica serves any request (ADR 0016), so everything an
// upload needs is in the bucket, and nothing is kept in memory between calls.
//
// Layout, all under the bucket's root:
//   blobs/<org>/<id>                      a finished blob, whole
//   uploads/<uploadId>/meta.json          what the upload is for, and its blob once finished
//   uploads/<uploadId>/c/<offset>         one received chunk, named by where it starts
//   upload-index/<org>/<purpose>/<sha>-<size>   the open upload for these bytes: a start with the
//                                         same digest finds it and says where it stopped
//
// A chunk is its own object because S3 refuses a multipart part under 5 MiB unless it is the last,
// and the runner sends 1 MiB chunks. A finish reads the chunks back once, hashes them as they pass,
// and writes the blob: whole when it fits one part, as an S3 multipart upload when it doesn't, and
// completes only when the digest matches. Bytes are untrusted: stored and handed back as they are.
//
// Logs carry blob IDs, sizes and organizations, never content. A bucket should expire the
// `uploads/` prefix after a few days, as a backstop for `abortUpload` (docs/configuration.md).

/** The cap per blob: a working value of ADR 0043. */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
/** The size of a multipart part. S3's floor is 5 MiB. */
export const DEFAULT_PART_BYTES = 8 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_REGION = "us-east-1";

export type S3BlobStoreOptions = {
  /** The store's endpoint, such as a MinIO or R2 URL. Absent: AWS S3's own. */
  readonly endpoint?: string | null;
  readonly bucket: string;
  readonly region?: string | null;
  readonly accessKeyId: string;
  /** Never logged, never in an error. */
  readonly secretAccessKey: string;
  /** The cap per blob. Default 64 MiB. */
  readonly maxBytes?: number;
  /** The multipart part size. Default 8 MiB; a real store refuses under 5 MiB. */
  readonly partBytes?: number;
  /** Time to connect and to wait for an answer, in ms. */
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** How many times the SDK tries a call that fails in a way worth retrying. Default 4. */
  readonly maxAttempts?: number;
};

const uploadMetaSchema = z.strictObject({
  organizationId: z.string().min(1),
  purpose: z.string().min(1),
  expectedSha256: z.string().regex(SHA256),
  size: z.number().int().nonnegative(),
  /** Set once the upload finished: the blob it became, so finishing twice answers the same. */
  blobKey: z.string().nullable(),
});
type UploadMeta = z.infer<typeof uploadMetaSchema>;

const indexSchema = z.strictObject({ uploadId: z.string().min(1) });

type Chunk = { readonly key: string; readonly offset: number; readonly size: number };

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const segment = (organizationId: string): string => encodeURIComponent(organizationId);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const blobPrefix = (organizationId: string): string => `blobs/${segment(organizationId)}/`;
const uploadPrefix = (uploadId: string): string => `uploads/${uploadId}/`;
const metaKey = (uploadId: string): string => `${uploadPrefix(uploadId)}meta.json`;
const chunkPrefix = (uploadId: string): string => `${uploadPrefix(uploadId)}c/`;
const chunkKey = (uploadId: string, offset: number): string => `${chunkPrefix(uploadId)}${String(offset).padStart(12, "0")}`;
const indexKey = (organizationId: string, purpose: string, sha256: string, size: number): string =>
  `upload-index/${segment(organizationId)}/${createHash("sha256").update(purpose).digest("hex").slice(0, 32)}/${sha256}-${String(size)}`;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** Failures of ostra's own making that unwind a call to its public method: the answer they stand for. */
const failures = new WeakMap<Error, AdapterResult<never>>();
const storeFailure = (result: AdapterResult<never>): Error => {
  const error = new Error("the blob store call failed");
  failures.set(error, result);
  return error;
};

export class S3BlobStore extends BlobStoreAdapter {
  readonly name = "s3";
  readonly capabilities: BlobStoreCapabilities = { resumableUpload: true };

  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #maxBytes: number;
  readonly #partBytes: number;

  constructor(options: S3BlobStoreOptions, context?: AdapterContext) {
    super(context);
    const endpoint = options.endpoint ?? undefined;
    this.#bucket = options.bucket;
    this.#maxBytes = options.maxBytes ?? MAX_BLOB_BYTES;
    this.#partBytes = options.partBytes ?? DEFAULT_PART_BYTES;
    this.#client = new S3Client({
      region: options.region ?? DEFAULT_REGION,
      ...(endpoint === undefined ? {} : { endpoint }),
      // A store at its own address (MinIO, the fake) is addressed by path; AWS by virtual host.
      forcePathStyle: endpoint !== undefined,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      maxAttempts: options.maxAttempts ?? 4,
      // Third-party stores reject the SDK's newer default checksums; send them only where S3 requires.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: { connectionTimeout: options.connectTimeoutMs ?? 10_000, requestTimeout: options.requestTimeoutMs ?? 120_000 },
    });
  }

  /** Ends the client's open connections. */
  close(): void {
    this.#client.destroy();
  }

  async health(): Promise<HealthReport> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
      return { status: "ok" };
    } catch (error) {
      const failed = toAdapterError("the bucket check", error);
      return { status: "down", reason: failed.error.message };
    }
  }

  // ---------- whole blobs ----------

  async put(scope: BlobScope, bytes: Uint8Array, contentType: string): Promise<AdapterResult<StoredBlob>> {
    if (bytes.length > this.#maxBytes) {
      return adapterError("invalid-input", `a blob over ${String(this.#maxBytes)} bytes is refused`);
    }
    const key = `${blobPrefix(scope.organizationId)}${randomUUID()}`;
    const sha256 = sha256Of(bytes);
    try {
      await this.#client.send(new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: bytes, ContentType: contentType }));
    } catch (error) {
      return toAdapterError("storing the blob", error);
    }
    this.plumbing.logger.info("blob.stored", { organizationId: scope.organizationId, purpose: scope.purpose, key, size: bytes.length });
    return ok({ key, size: bytes.length, sha256 });
  }

  async get(organizationId: OrganizationId, key: string): Promise<AdapterResult<Uint8Array>> {
    if (!this.#ownsKey(organizationId, key)) {
      return adapterError("not-found", "no such blob");
    }
    try {
      const response = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      if (response.Body === undefined || (response.ContentLength ?? 0) > this.#maxBytes) {
        return adapterError("invalid-response", "the store's answer for the blob could not be used");
      }
      return ok(await response.Body.transformToByteArray());
    } catch (error) {
      return toAdapterError("reading the blob", error);
    }
  }

  async delete(organizationId: OrganizationId, key: string): Promise<AdapterResult<void>> {
    if (!this.#ownsKey(organizationId, key)) {
      return adapterError("not-found", "no such blob");
    }
    try {
      // S3 answers a delete of a missing key with success; ostra's contract says not-found.
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
    } catch (error) {
      return toAdapterError("deleting the blob", error);
    }
    this.plumbing.logger.info("blob.deleted", { organizationId, key });
    return ok(undefined);
  }

  // ---------- chunked uploads ----------

  async startUpload(scope: BlobScope, expectedSha256: string, size: number): Promise<AdapterResult<UploadSession>> {
    if (!SHA256.test(expectedSha256)) {
      return adapterError("invalid-input", "an upload needs the SHA-256 of its bytes, in hex");
    }
    if (!Number.isInteger(size) || size < 0 || size > this.#maxBytes) {
      return adapterError("invalid-input", `a blob over ${String(this.#maxBytes)} bytes is refused`);
    }
    try {
      const pointer = indexKey(scope.organizationId, scope.purpose, expectedSha256, size);
      // The same upload again, after a drop: it resumes where the last chunk ended.
      const found = await this.#readJson(pointer, indexSchema);
      if (found !== undefined) {
        const uploadId = uploadIdSchema.parse(found.uploadId);
        const meta = await this.#readMeta(uploadId);
        if (meta?.blobKey === null && meta.size === size && meta.expectedSha256 === expectedSha256) {
          const { received } = await this.#chunks(uploadId);
          return ok({ uploadId, receivedBytes: received });
        }
      }
      const uploadId = uploadIdSchema.parse(randomUUID());
      const meta: UploadMeta = { organizationId: scope.organizationId, purpose: scope.purpose, expectedSha256, size, blobKey: null };
      await this.#writeJson(metaKey(uploadId), meta);
      await this.#writeJson(pointer, { uploadId });
      return ok({ uploadId, receivedBytes: 0 });
    } catch (error) {
      return this.#failed("starting the upload", error);
    }
  }

  async appendUpload(uploadId: UploadId, offset: number, chunk: Uint8Array): Promise<AdapterResult<UploadSession>> {
    if (!SAFE_NAME.test(uploadId)) {
      return adapterError("not-found", "no such open upload");
    }
    try {
      const meta = await this.#readMeta(uploadId);
      if (meta?.blobKey !== null) {
        return adapterError("not-found", "no such open upload");
      }
      const { chunks, received: have } = await this.#chunks(uploadId);
      if (!Number.isInteger(offset) || offset < 0 || offset > have) {
        return adapterError("conflict", `the chunk starts at ${String(offset)}, but ${String(have)} bytes have arrived: send from there`);
      }
      if (offset + chunk.length > meta.size) {
        return adapterError("invalid-input", "the chunk runs past the size the upload was started with");
      }
      if (offset < have) {
        // A chunk sent twice is stored once: only a repeat of what's there is accepted.
        const overlap = Math.min(have - offset, chunk.length);
        const held = await this.#readRange(chunks, offset, offset + overlap);
        if (!Buffer.from(held).equals(Buffer.from(chunk.subarray(0, overlap)))) {
          return adapterError("conflict", "the chunk differs from the bytes already received at that offset");
        }
        if (offset + chunk.length <= have) {
          return ok({ uploadId, receivedBytes: have });
        }
      }
      const tail = chunk.subarray(have - offset);
      if (tail.length > 0) {
        await this.#client.send(new PutObjectCommand({ Bucket: this.#bucket, Key: chunkKey(uploadId, have), Body: tail }));
      }
      return ok({ uploadId, receivedBytes: have + tail.length });
    } catch (error) {
      return this.#failed("saving the chunk", error);
    }
  }

  async finishUpload(uploadId: UploadId): Promise<AdapterResult<StoredBlob>> {
    if (!SAFE_NAME.test(uploadId)) {
      return adapterError("not-found", "no such upload");
    }
    try {
      const meta = await this.#readMeta(uploadId);
      if (meta === undefined) {
        return adapterError("not-found", "no such upload");
      }
      if (meta.blobKey !== null) {
        // Finishing twice answers the same.
        return ok({ key: meta.blobKey, size: meta.size, sha256: meta.expectedSha256 });
      }
      const { chunks, received } = await this.#chunks(uploadId);
      if (received !== meta.size) {
        return adapterError("conflict", `${String(received)} of ${String(meta.size)} bytes have arrived`);
      }
      // The key follows from the upload, so a finish that dies and runs again writes the same object.
      const blobKey = `${blobPrefix(meta.organizationId)}${uploadId}`;
      const written = await this.#assemble(meta, chunks, blobKey);
      if (!written.ok) {
        if (written.error.code === "conflict") {
          // The bytes are wrong: nothing of the upload stays, so a retry starts clean.
          this.plumbing.logger.warn("blob.digest_mismatch", { organizationId: meta.organizationId, purpose: meta.purpose, size: meta.size });
          await this.#dropUpload(uploadId, meta);
        }
        return written;
      }
      await this.#writeJson(metaKey(uploadId), { ...meta, blobKey } satisfies UploadMeta);
      await this.#dropChunks(chunks);
      await this.#dropIndex(uploadId, meta);
      this.plumbing.logger.info("blob.stored", { organizationId: meta.organizationId, purpose: meta.purpose, key: blobKey, size: meta.size });
      return ok({ key: blobKey, size: meta.size, sha256: meta.expectedSha256 });
    } catch (error) {
      return this.#failed("finishing the upload", error);
    }
  }

  override async abortUpload(uploadId: UploadId): Promise<AdapterResult<void>> {
    if (!SAFE_NAME.test(uploadId)) {
      return ok(undefined);
    }
    try {
      const meta = await this.#readMeta(uploadId);
      const { chunks } = await this.#chunks(uploadId);
      await this.#dropChunks(chunks);
      if (meta !== undefined) {
        await this.#dropIndex(uploadId, meta);
      }
      await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: metaKey(uploadId) }));
      this.plumbing.logger.info("blob.upload_aborted", { uploadId });
      return ok(undefined);
    } catch (error) {
      return this.#failed("dropping the upload", error);
    }
  }

  // ---------- internals ----------

  /** Whether `key` is a blob key of this organization's: another's is read as a missing one. */
  #ownsKey(organizationId: OrganizationId, key: string): boolean {
    const prefix = blobPrefix(organizationId);
    return key.startsWith(prefix) && SAFE_NAME.test(key.slice(prefix.length));
  }

  #failed(operation: string, error: unknown): AdapterResult<never> {
    const own = error instanceof Error ? failures.get(error) : undefined;
    if (own !== undefined) {
      return own;
    }
    this.plumbing.logger.warn("blob.store_failed", { operation });
    return toAdapterError(operation, error);
  }

  async #readBytes(key: string): Promise<Uint8Array | undefined> {
    try {
      const response = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      return response.Body === undefined ? undefined : await response.Body.transformToByteArray();
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async #readJson<S extends z.ZodType>(key: string, schema: S): Promise<z.infer<S> | undefined> {
    const bytes = await this.#readBytes(key);
    if (bytes === undefined) {
      return undefined;
    }
    let json: unknown;
    try {
      json = JSON.parse(decoder.decode(bytes));
    } catch {
      throw storeFailure(adapterError("invalid-response", "the store holds an upload record that could not be read"));
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw storeFailure(adapterError("invalid-response", "the store holds an upload record that could not be read"));
    }
    return parsed.data;
  }

  async #writeJson(key: string, value: unknown): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: encoder.encode(JSON.stringify(value)), ContentType: "application/json" }),
    );
  }

  async #readMeta(uploadId: string): Promise<UploadMeta | undefined> {
    return this.#readJson(metaKey(uploadId), uploadMetaSchema);
  }

  /** The upload's chunks in order, and how many bytes they cover from offset 0 with no gap. */
  async #chunks(uploadId: string): Promise<{ readonly chunks: readonly Chunk[]; readonly received: number }> {
    const prefix = chunkPrefix(uploadId);
    const found: Chunk[] = [];
    let token: string | undefined;
    do {
      const page = await this.#client.send(
        new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: prefix, ...(token === undefined ? {} : { ContinuationToken: token }) }),
      );
      for (const object of page.Contents ?? []) {
        const name = object.Key?.slice(prefix.length) ?? "";
        if (/^\d{12}$/.test(name) && object.Size !== undefined) {
          found.push({ key: object.Key ?? "", offset: Number(name), size: object.Size });
        }
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    found.sort((a, b) => a.offset - b.offset);
    const contiguous: Chunk[] = [];
    let received = 0;
    for (const chunk of found) {
      if (chunk.offset !== received) {
        break;
      }
      contiguous.push(chunk);
      received += chunk.size;
    }
    return { chunks: contiguous, received };
  }

  /** The bytes `[start, end)` of the upload, from the chunks that cover them. */
  async #readRange(chunks: readonly Chunk[], start: number, end: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (const chunk of chunks) {
      if (chunk.offset + chunk.size <= start || chunk.offset >= end) {
        continue;
      }
      const bytes = await this.#readBytes(chunk.key);
      if (bytes?.length !== chunk.size) {
        throw storeFailure(adapterError("unavailable", "a chunk of the upload could not be read back"));
      }
      parts.push(bytes.subarray(Math.max(start - chunk.offset, 0), Math.min(end - chunk.offset, chunk.size)));
    }
    return Buffer.concat(parts);
  }

  /**
   * Writes the finished blob from its chunks, hashing them as they pass. Whole when it fits one
   * part, as a multipart upload when it doesn't; completed only when the digest matches.
   */
  async #assemble(meta: UploadMeta, chunks: readonly Chunk[], blobKey: string): Promise<AdapterResult<void>> {
    const hash = createHash("sha256");
    const read = async (chunk: Chunk): Promise<Uint8Array> => {
      const bytes = await this.#readBytes(chunk.key);
      if (bytes?.length !== chunk.size) {
        throw storeFailure(adapterError("unavailable", "a chunk of the upload could not be read back"));
      }
      hash.update(bytes);
      return bytes;
    };
    const mismatch = adapterError("conflict", "the bytes do not match their SHA-256");

    if (meta.size <= this.#partBytes) {
      const parts: Uint8Array[] = [];
      for (const chunk of chunks) {
        parts.push(await read(chunk));
      }
      if (hash.digest("hex") !== meta.expectedSha256) {
        return mismatch;
      }
      await this.#client.send(new PutObjectCommand({ Bucket: this.#bucket, Key: blobKey, Body: Buffer.concat(parts), ContentType: "application/octet-stream" }));
      return ok(undefined);
    }

    const created = await this.#client.send(new CreateMultipartUploadCommand({ Bucket: this.#bucket, Key: blobKey, ContentType: "application/octet-stream" }));
    const multipartId = created.UploadId;
    if (multipartId === undefined) {
      return adapterError("invalid-response", "the store started no multipart upload");
    }
    const abort = async (): Promise<void> => {
      await this.#client.send(new AbortMultipartUploadCommand({ Bucket: this.#bucket, Key: blobKey, UploadId: multipartId })).catch(() => undefined);
    };
    try {
      const done: CompletedPart[] = [];
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      const flush = async (): Promise<void> => {
        const partNumber = done.length + 1;
        const sent = await this.#client.send(
          new UploadPartCommand({ Bucket: this.#bucket, Key: blobKey, UploadId: multipartId, PartNumber: partNumber, Body: Buffer.concat(pending) }),
        );
        if (sent.ETag === undefined) {
          throw storeFailure(adapterError("invalid-response", "the store accepted a part and gave no ETag"));
        }
        done.push({ PartNumber: partNumber, ETag: sent.ETag });
        pending = [];
        pendingBytes = 0;
      };
      for (const chunk of chunks) {
        pending.push(await read(chunk));
        pendingBytes += chunk.size;
        if (pendingBytes >= this.#partBytes) {
          await flush();
        }
      }
      if (pendingBytes > 0) {
        await flush();
      }
      if (hash.digest("hex") !== meta.expectedSha256) {
        await abort();
        return mismatch;
      }
      await this.#client.send(
        new CompleteMultipartUploadCommand({ Bucket: this.#bucket, Key: blobKey, UploadId: multipartId, MultipartUpload: { Parts: done } }),
      );
      return ok(undefined);
    } catch (error) {
      await abort();
      throw error;
    }
  }

  async #dropChunks(chunks: readonly Chunk[]): Promise<void> {
    for (let start = 0; start < chunks.length; start += 8) {
      await Promise.all(
        chunks.slice(start, start + 8).map((chunk) => this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: chunk.key }))),
      );
    }
  }

  /** Removes the pointer, if it still points at this upload (a newer upload of the same bytes may own it). */
  async #dropIndex(uploadId: string, meta: UploadMeta): Promise<void> {
    const pointer = indexKey(meta.organizationId, meta.purpose, meta.expectedSha256, meta.size);
    const held = await this.#readJson(pointer, indexSchema);
    if (held?.uploadId === uploadId) {
      await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: pointer }));
    }
  }

  async #dropUpload(uploadId: string, meta: UploadMeta): Promise<void> {
    const { chunks } = await this.#chunks(uploadId);
    await this.#dropChunks(chunks);
    await this.#dropIndex(uploadId, meta);
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: metaKey(uploadId) }));
  }
}
