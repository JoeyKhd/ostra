import { createHash } from "node:crypto";
import {
  blobChunkResponseSchema,
  blobUploadFinishResponseSchema,
  blobUploadStartResponseSchema,
  parseJson,
  runnerHeaders,
  runnerHttpErrorSchema,
  runnerLimits,
  runnerPaths,
  sha256HexSchema,
} from "@ostra/protocol";
import type { BlobId, BlobRef, BlobUploadPurpose, LeaseEpoch, Sha256Hex, TaskId } from "@ostra/protocol";
import type { z } from "zod";
import { userAgent } from "../version.ts";
import { describeFailure, joinUrl } from "./http.ts";
import type { CallFailure, CallResult } from "./http.ts";

// The bulk path (ADR 0043, protocol minor 1): plain HTTPS beside the socket, for what's too big
// for a frame. Uploads go in chunks of at most 1 MiB with the whole blob's SHA-256 named first, so
// core checks the digest when the upload is sealed; a drop mid-upload asks the start endpoint how
// much core holds and carries on from there. Every call carries the lease epoch, and a stale one
// ends the upload at once. The bytes are never logged, and neither is anything core answers.

/** Bytes as a blob's digest: lower-case hex SHA-256. */
export const sha256Of = (bytes: Uint8Array): Sha256Hex => sha256HexSchema.parse(createHash("sha256").update(bytes).digest("hex"));

export type BulkFailure =
  /** The lease epoch is behind the task's (409 `stale-lease`): the task moved on. */
  | { readonly kind: "stale-lease"; readonly message: string }
  /** Core refused the blob itself: its digest, its size, or a blob of another task. Not retried. */
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

export type BulkResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: BulkFailure };

export type UploadInput = {
  readonly taskId: TaskId;
  readonly leaseEpoch: LeaseEpoch;
  readonly purpose: BlobUploadPurpose;
  readonly contentType: string;
  readonly bytes: Uint8Array;
};

export type DownloadInput = {
  readonly taskId: TaskId;
  readonly leaseEpoch: LeaseEpoch;
  readonly blobId: BlobId;
  /** A longer answer is refused before it's all read. */
  readonly maxBytes: number;
};

export type Downloaded = {
  readonly bytes: Buffer;
  /** The digest core named in `x-ostra-sha256`, when it did. The caller checks it. */
  readonly sha256: Sha256Hex | null;
};

export type BulkClient = {
  readonly upload: (input: UploadInput) => Promise<BulkResult<BlobRef>>;
  readonly download: (input: DownloadInput) => Promise<BulkResult<Downloaded>>;
};

export type BulkClientOptions = {
  readonly serverUrl: string;
  /** The runner's access token, or a box's task token. Never logged. */
  readonly bearer: () => Promise<{ readonly ok: true; readonly token: string } | { readonly ok: false; readonly message: string }>;
  /** The largest chunk of one `PUT`. Default: the protocol's 1 MiB. */
  readonly chunkBytes?: number;
  /** How many times an upload starts over (resuming) after a drop. */
  readonly attempts?: number;
  /** The wait before the next try, by the try's number from 1. */
  readonly backoffMs?: (attempt: number) => number;
  readonly timeoutMs?: number;
};

const DEFAULT_ATTEMPTS = 6;
const DEFAULT_TIMEOUT_MS = 60_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

const networkMessage = (error: unknown): string => {
  if (error instanceof Error) {
    const cause: unknown = error.cause;
    if (typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string") {
      return `${error.name}: ${cause.code}`;
    }
    return error.name === "TimeoutError" ? "the server didn't answer in time" : error.name;
  }
  return "unknown error";
};

type Request = {
  readonly url: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly bearer: string;
  readonly json?: unknown;
  readonly bytes?: Uint8Array;
  readonly timeoutMs: number;
};

/** One call; the answer's body as bytes, or a failure in `http.ts`'s shape. Never throws. */
const call = async (request: Request): Promise<{ readonly ok: true; readonly response: Response; readonly body: Buffer } | { readonly ok: false; readonly failure: CallFailure }> => {
  const headers: Record<string, string> = { "user-agent": userAgent(), authorization: `Bearer ${request.bearer}` };
  let body: string | Uint8Array | undefined;
  if (request.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(request.json);
  } else if (request.bytes !== undefined) {
    headers["content-type"] = "application/octet-stream";
    body = request.bytes;
  }
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(request.timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    return { ok: false, failure: { kind: "network", message: networkMessage(error) } };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { ok: false, failure: { kind: "network", message: networkMessage(error) } };
  }
  if (!response.ok) {
    const json = parseJson(bytes.toString("utf8"));
    const parsed = runnerHttpErrorSchema.safeParse(json.ok ? json.value : null);
    return { ok: false, failure: { kind: "refused", status: response.status, error: parsed.success ? parsed.data.error : null, body: null } };
  }
  return { ok: true, response, body: bytes };
};

const jsonOf = <Schema extends z.ZodType>(body: Buffer, status: number, schema: Schema): CallResult<z.infer<Schema>> => {
  const json = parseJson(body.toString("utf8"));
  const parsed = schema.safeParse(json.ok ? json.value : undefined);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, failure: { kind: "invalid-response", status, detail: "the answer isn't the protocol's shape" } };
};

/** Whether a failure is worth a resume: a drop, a timeout, a server error, or an offset core moved past. */
const retryable = (failure: CallFailure): boolean =>
  failure.kind === "network" ||
  (failure.kind === "refused" && (failure.status >= 500 || failure.status === 429 || failure.error?.code === "offset-mismatch"));

const toBulk = (failure: CallFailure): BulkFailure => {
  if (failure.kind === "refused" && failure.error?.code === "stale-lease") {
    return { kind: "stale-lease", message: "the server says the lease epoch is stale" };
  }
  if (retryable(failure)) {
    return { kind: "unavailable", message: describeFailure(failure) };
  }
  return { kind: "refused", message: describeFailure(failure) };
};

export const createBulkClient = (options: BulkClientOptions): BulkClient => {
  const chunkBytes = Math.min(options.chunkBytes ?? runnerLimits.uploadChunkMaxBytes, runnerLimits.uploadChunkMaxBytes);
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const backoff = options.backoffMs ?? ((attempt: number) => Math.min(5_000, 200 * 2 ** (attempt - 1)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const token = async (): Promise<BulkResult<string>> => {
    const got = await options.bearer();
    return got.ok ? { ok: true, value: got.token } : { ok: false, failure: { kind: "unavailable", message: got.message } };
  };

  const upload = async (input: UploadInput): Promise<BulkResult<BlobRef>> => {
    const size = input.bytes.length;
    if (size > runnerLimits.archiveMaxBytes) {
      return { ok: false, failure: { kind: "refused", message: `the blob is over the cap (${String(size)} bytes)` } };
    }
    const sha256 = sha256Of(input.bytes);
    const blobs = joinUrl(options.serverUrl, runnerPaths.taskBlobs(input.taskId));
    let last: BulkFailure = { kind: "unavailable", message: "the upload didn't start" };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) {
        await sleep(backoff(attempt - 1));
      }
      const bearer = await token();
      if (!bearer.ok) {
        last = bearer.failure;
        continue;
      }
      // Starting again with the same digest and size resumes the upload core already holds.
      const started = await call({
        url: blobs,
        method: "POST",
        bearer: bearer.value,
        json: { purpose: input.purpose, sha256, size, contentType: input.contentType, leaseEpoch: input.leaseEpoch },
        timeoutMs,
      });
      const start = started.ok ? jsonOf(started.body, started.response.status, blobUploadStartResponseSchema) : started;
      if (!start.ok) {
        last = toBulk(start.failure);
        if (last.kind !== "unavailable") {
          return { ok: false, failure: last };
        }
        continue;
      }
      let offset = start.value.receivedBytes;
      const uploadUrl = joinUrl(options.serverUrl, runnerPaths.taskBlobUpload(input.taskId, start.value.uploadId));
      let dropped = false;
      while (offset < size) {
        const chunk = input.bytes.subarray(offset, Math.min(size, offset + chunkBytes));
        const put = await call({
          url: `${uploadUrl}?offset=${String(offset)}&leaseEpoch=${String(input.leaseEpoch)}`,
          method: "PUT",
          bearer: bearer.value,
          bytes: chunk,
          timeoutMs,
        });
        const answered = put.ok ? jsonOf(put.body, put.response.status, blobChunkResponseSchema) : put;
        if (!answered.ok) {
          last = toBulk(answered.failure);
          if (last.kind !== "unavailable") {
            return { ok: false, failure: last };
          }
          dropped = true;
          break;
        }
        if (answered.value.receivedBytes <= offset || answered.value.receivedBytes > size) {
          last = { kind: "unavailable", message: "the server's byte count didn't move" };
          dropped = true;
          break;
        }
        offset = answered.value.receivedBytes;
      }
      if (dropped) {
        continue;
      }
      const sealed = await call({
        url: joinUrl(options.serverUrl, runnerPaths.taskBlobUploadFinish(input.taskId, start.value.uploadId)),
        method: "POST",
        bearer: bearer.value,
        json: { leaseEpoch: input.leaseEpoch },
        timeoutMs,
      });
      const finished = sealed.ok ? jsonOf(sealed.body, sealed.response.status, blobUploadFinishResponseSchema) : sealed;
      if (!finished.ok) {
        last = toBulk(finished.failure);
        if (last.kind !== "unavailable") {
          return { ok: false, failure: last };
        }
        continue;
      }
      if (finished.value.sha256 !== sha256 || finished.value.size !== size) {
        return { ok: false, failure: { kind: "refused", message: "the server sealed another blob than the one sent" } };
      }
      return { ok: true, value: finished.value };
    }
    return { ok: false, failure: last };
  };

  const download = async (input: DownloadInput): Promise<BulkResult<Downloaded>> => {
    let last: BulkFailure = { kind: "unavailable", message: "the download didn't start" };
    for (let attempt = 1; attempt <= Math.min(attempts, 3); attempt += 1) {
      if (attempt > 1) {
        await sleep(backoff(attempt - 1));
      }
      const bearer = await token();
      if (!bearer.ok) {
        last = bearer.failure;
        continue;
      }
      const got = await call({
        url: `${joinUrl(options.serverUrl, runnerPaths.taskBlob(input.taskId, input.blobId))}?leaseEpoch=${String(input.leaseEpoch)}`,
        method: "GET",
        bearer: bearer.value,
        timeoutMs,
      });
      if (!got.ok) {
        last = toBulk(got.failure);
        if (last.kind !== "unavailable") {
          return { ok: false, failure: last };
        }
        continue;
      }
      if (got.body.length > input.maxBytes) {
        return { ok: false, failure: { kind: "refused", message: `the blob is over its expected size (${String(got.body.length)} bytes)` } };
      }
      const named = sha256HexSchema.safeParse(got.response.headers.get(runnerHeaders.blobSha256));
      return { ok: true, value: { bytes: got.body, sha256: named.success ? named.data : null } };
    }
    return { ok: false, failure: last };
  };

  return { upload, download };
};
