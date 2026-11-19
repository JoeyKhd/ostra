import { z } from "zod";

import { blobIdSchema, uploadIdSchema } from "../ids.ts";
import { leaseEpochSchema } from "../common.ts";
import { runnerLimits } from "./limits.ts";

// Blobs on the runner protocol (ADR 0043, protocol minor 1): what a stored blob looks like when an
// event or a task spec names it, and the bulk path's request and response bodies. The bulk path
// is plain HTTPS beside the socket: chunked, resumable, with a digest, and every call carries the
// task's lease epoch, answered `409 stale-lease` when it's old. The bytes themselves never pass
// through a frame, and they're never logged.

/** A SHA-256 digest in lower-case hex. */
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "a SHA-256 digest in lower-case hex");
export type Sha256Hex = z.infer<typeof sha256HexSchema>;

/** A blob's size in bytes, up to the blob cap. */
export const blobSizeSchema = z.number().int().nonnegative().max(runnerLimits.archiveMaxBytes);

/** A stored blob as an event or a spec names it: its ID, size and digest. Never its bytes. */
export const blobRefSchema = z.strictObject({
  blobId: blobIdSchema,
  size: blobSizeSchema,
  sha256: sha256HexSchema,
});
export type BlobRef = z.infer<typeof blobRefSchema>;

/**
 * What a runner uploads. Ticket files go the other way: core stores them, the runner downloads
 * them. Minor 2: a check's full output (F-054), sent only to a minor-2 server.
 */
export const blobUploadPurposeSchema = z.enum(["session-archive", "check-output"]);
export type BlobUploadPurpose = z.infer<typeof blobUploadPurposeSchema>;

/** A content type as a `Content-Type` header carries it, without parameters. */
export const contentTypeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/, "a type/subtype");

/** The session archive's content type: a gzipped export (ADR 0039). */
export const SESSION_ARCHIVE_CONTENT_TYPE = "application/gzip";

/** A check's output's content type: its stdout and stderr together, as text (minor 2). Never logged. */
export const CHECK_OUTPUT_CONTENT_TYPE = "text/plain";

// ---------- POST /runner/v1/tasks/:taskId/blobs ----------

/**
 * Starts an upload, or resumes one: the same purpose, digest and size for the same task answer
 * the upload already open, with the bytes it holds, so a runner that dropped mid-upload carries on.
 */
export const blobUploadStartRequestSchema = z.strictObject({
  purpose: blobUploadPurposeSchema,
  sha256: sha256HexSchema,
  size: blobSizeSchema,
  contentType: contentTypeSchema,
  leaseEpoch: leaseEpochSchema,
});
export type BlobUploadStartRequest = z.infer<typeof blobUploadStartRequestSchema>;

export const blobUploadStartResponseSchema = z.strictObject({
  uploadId: uploadIdSchema,
  /** The bytes already held: `0` for a new upload, more on a resume. The next chunk starts here. */
  receivedBytes: z.number().int().nonnegative(),
});
export type BlobUploadStartResponse = z.infer<typeof blobUploadStartResponseSchema>;

// ---------- PUT /runner/v1/tasks/:taskId/blobs/:uploadId?offset=&leaseEpoch= ----------

/**
 * One chunk's query. The body is the raw bytes (`application/octet-stream`), at most
 * `runnerLimits.uploadChunkMaxBytes`. An `offset` that isn't the bytes held answers `409` with
 * `offset-mismatch`, and the runner asks the start endpoint where to resume.
 */
export const blobChunkQuerySchema = z.strictObject({
  offset: z.coerce.number().pipe(z.number().int().nonnegative().max(runnerLimits.archiveMaxBytes)),
  leaseEpoch: z.coerce.number().pipe(leaseEpochSchema),
});
export type BlobChunkQuery = z.infer<typeof blobChunkQuerySchema>;

export const blobChunkResponseSchema = z.strictObject({
  receivedBytes: z.number().int().nonnegative(),
});
export type BlobChunkResponse = z.infer<typeof blobChunkResponseSchema>;

// ---------- POST /runner/v1/tasks/:taskId/blobs/:uploadId/finish ----------

/**
 * Seals the upload. The server checks the size and the digest it computed against the start's;
 * a mismatch answers `409` with `digest-mismatch`, and the upload is dropped.
 */
export const blobUploadFinishRequestSchema = z.strictObject({
  leaseEpoch: leaseEpochSchema,
});
export type BlobUploadFinishRequest = z.infer<typeof blobUploadFinishRequestSchema>;

export const blobUploadFinishResponseSchema = blobRefSchema;
export type BlobUploadFinishResponse = z.infer<typeof blobUploadFinishResponseSchema>;

// ---------- GET /runner/v1/tasks/:taskId/blobs/:blobId?leaseEpoch= ----------

/** The download's query. The answer is the bytes, only for a blob of that task; else `404`. */
export const blobDownloadQuerySchema = z.strictObject({
  leaseEpoch: z.coerce.number().pipe(leaseEpochSchema),
});
export type BlobDownloadQuery = z.infer<typeof blobDownloadQuerySchema>;
