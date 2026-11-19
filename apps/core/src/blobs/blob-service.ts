import { PostgresBlobStore } from "@ostra/adapter-blob-postgres";
import type { AdapterContext, AdapterResult, BlobStoreAdapter, Logger, StoredBlob } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import type { BlobStoreSettings } from "@ostra/domain";
import { blobIdSchema } from "@ostra/protocol";
import type { BlobId, BlobRef, OrganizationId, Sha256Hex, TaskId, UploadId } from "@ostra/protocol";
import { sha256HexSchema } from "@ostra/protocol";

import { postgresBlobRows } from "./postgres-blob-rows.ts";
import type { BlobOwner } from "./postgres-blob-rows.ts";

// The blob service (ADR 0043, ticket 12): the one place on the server that stores and reads blobs.
// It picks the store from OSTRA_BLOB_STORE (`postgres`, the built-in one, by default), keeps a
// `Blob` row for every blob with its organization, project, task and store, refuses a blob over
// OSTRA_BLOB_MAX_MIB with a clear error, and reads a blob only for its own organization (and, when
// asked, its own task). Bytes are never logged: log lines carry blob IDs, sizes and digests.

/** Who a blob belongs to: its organization, and the task it was made for when there is one. */
export type BlobScopeOwner = {
  readonly organizationId: OrganizationId;
  readonly task: BlobOwner | null;
};

export type BlobServiceError =
  /** Over the blob cap. The caller carries on without it (a session archive: the next reopen rebuilds). */
  | "too-large"
  /** No such blob or upload, or it's another organization's or task's. */
  | "not-found"
  /** A chunk's offset isn't the bytes held, or it differs from what's held there. */
  | "offset-mismatch"
  /** The finished bytes don't match the digest or the size the upload started with. */
  | "digest-mismatch"
  | "bad-request"
  /** The store didn't answer. */
  | "unavailable";

export type BlobServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BlobServiceError; /** Words and IDs, never content. */ readonly message: string };

export type StoredBlobRow = {
  readonly blobId: BlobId;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly purpose: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
};

export type BlobService = {
  readonly kind: BlobStoreSettings["kind"];
  /** The cap per blob, in bytes. */
  readonly maxBytes: number;
  /** Stores bytes whole (ticket images, which core fetches itself). */
  readonly put: (
    owner: BlobScopeOwner,
    input: { readonly purpose: string; readonly contentType: string; readonly bytes: Uint8Array },
  ) => Promise<BlobServiceResult<BlobRef>>;
  /** Starts an upload, or resumes the open one of the same task, purpose and digest. */
  readonly startUpload: (
    owner: BlobScopeOwner,
    input: { readonly purpose: string; readonly sha256: Sha256Hex; readonly size: number; readonly contentType: string },
  ) => Promise<BlobServiceResult<{ readonly uploadId: UploadId; readonly receivedBytes: number }>>;
  readonly appendUpload: (
    owner: BlobScopeOwner,
    uploadId: UploadId,
    offset: number,
    chunk: Uint8Array,
  ) => Promise<BlobServiceResult<{ readonly receivedBytes: number }>>;
  readonly finishUpload: (owner: BlobScopeOwner, uploadId: UploadId) => Promise<BlobServiceResult<BlobRef>>;
  /** A blob's row, only for its own organization, and its own task when `taskId` is given. */
  readonly find: (organizationId: OrganizationId, blobId: BlobId, taskId?: TaskId) => Promise<StoredBlobRow | null>;
  /** A blob's bytes, only for its own organization, and its own task when `taskId` is given. */
  readonly read: (
    organizationId: OrganizationId,
    blobId: BlobId,
    taskId?: TaskId,
  ) => Promise<BlobServiceResult<StoredBlobRow & { readonly bytes: Uint8Array }>>;
  readonly delete: (organizationId: OrganizationId, blobId: BlobId) => Promise<BlobServiceResult<void>>;
};

export type BlobServiceDeps = {
  readonly db: Db;
  readonly settings: BlobStoreSettings;
  readonly context: AdapterContext;
  /**
   * The S3-compatible store (ticket 11), used when OSTRA_BLOB_STORE=s3. It keeps its own upload
   * state; the service still writes each blob's row.
   */
  readonly s3?: BlobStoreAdapter;
};

const mib = (bytes: number): string => `${String(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MiB`;

const fromAdapter = <T>(result: AdapterResult<T>, what: string): BlobServiceResult<T> => {
  if (result.ok) {
    return result;
  }
  switch (result.error.code) {
    case "not-found":
      return { ok: false, error: "not-found", message: `${what}: no such blob or upload` };
    case "conflict":
      return { ok: false, error: "offset-mismatch", message: `${what}: ${result.error.message}` };
    case "invalid-input":
      return { ok: false, error: "bad-request", message: `${what}: ${result.error.message}` };
    case "unauthorized":
    case "forbidden":
    case "rate-limited":
    case "unavailable":
    case "invalid-response":
    case "unsupported":
    case "aborted":
      return { ok: false, error: "unavailable", message: `${what}: the blob store did not answer (${result.error.code})` };
    default:
      return result.error.code satisfies never;
  }
};

const POSTGRES_KEY = /^postgres:(.+)$/;

export const createBlobService = (deps: BlobServiceDeps): BlobService => {
  const { db, settings } = deps;
  const logger: Logger = deps.context.logger.child({ component: "blobs", store: settings.kind });
  const maxBytes = settings.maxBytes;
  const s3 = deps.s3;
  if (settings.kind === "s3" && s3 === undefined) {
    throw new Error("OSTRA_BLOB_STORE=s3 needs the S3-compatible blob store adapter");
  }

  /** The store for one owner: the built-in one is bound to it, so its rows carry the task. */
  const storeFor = (owner: BlobScopeOwner): BlobStoreAdapter =>
    settings.kind === "postgres" || s3 === undefined
      ? new PostgresBlobStore({ rows: postgresBlobRows(db, owner.task), maxBytes }, deps.context)
      : s3;

  const tooLarge = (size: number): BlobServiceResult<never> => ({
    ok: false,
    error: "too-large",
    message: `a blob of ${mib(size)} is over the cap of ${mib(maxBytes)} (OSTRA_BLOB_MAX_MIB)`,
  });

  /** Writes or completes the blob's row, and answers its reference. */
  const recordBlob = async (
    owner: BlobScopeOwner,
    stored: StoredBlob,
    purpose: string,
    contentType: string,
  ): Promise<BlobServiceResult<BlobRef>> => {
    const sha256 = sha256HexSchema.safeParse(stored.sha256);
    if (!sha256.success) {
      return { ok: false, error: "unavailable", message: "the blob store answered a digest that isn't SHA-256" };
    }
    const builtIn = POSTGRES_KEY.exec(stored.key);
    let blobId: BlobId;
    if (settings.kind === "postgres" && builtIn?.[1] !== undefined) {
      // The built-in store wrote the row with the bytes; the service sets what the port can't carry.
      blobId = blobIdSchema.parse(builtIn[1]);
      await db.blob.updateMany({ where: { id: blobId, organizationId: owner.organizationId }, data: { contentType } });
    } else {
      const row = await db.blob.upsert({
        where: { store_key: { store: settings.kind, key: stored.key } },
        create: {
          organizationId: owner.organizationId,
          ...(owner.task === null ? {} : { projectId: owner.task.projectId, taskId: owner.task.taskId }),
          store: settings.kind,
          key: stored.key,
          purpose,
          contentType,
          size: stored.size,
          sha256: sha256.data,
        },
        update: {},
        select: { id: true },
      });
      blobId = blobIdSchema.parse(row.id);
    }
    logger.info("blob.recorded", {
      organizationId: owner.organizationId,
      taskId: owner.task?.taskId ?? null,
      blobId,
      purpose,
      size: stored.size,
      sha256: sha256.data,
    });
    return { ok: true, value: { blobId, size: stored.size, sha256: sha256.data } };
  };

  /** The upload's row, only for its owner: another task's or organization's answers not found. */
  const ownedUpload = async (owner: BlobScopeOwner, uploadId: UploadId) =>
    db.blobUpload.findFirst({
      where: { id: uploadId, organizationId: owner.organizationId, taskId: owner.task?.taskId ?? null },
      select: { id: true, purpose: true, contentType: true, size: true, expectedSha256: true, receivedBytes: true, blobId: true },
    });

  const find: BlobService["find"] = async (organizationId, blobId, taskId) => {
    const row = await db.blob.findFirst({
      where: { id: blobId, organizationId, ...(taskId === undefined ? {} : { taskId }) },
      select: { id: true, projectId: true, taskId: true, purpose: true, contentType: true, size: true, sha256: true, store: true, key: true },
    });
    return row === null
      ? null
      : {
          blobId: blobIdSchema.parse(row.id),
          projectId: row.projectId,
          taskId: row.taskId,
          purpose: row.purpose,
          contentType: row.contentType,
          size: row.size,
          sha256: row.sha256,
        };
  };

  return {
    kind: settings.kind,
    maxBytes,

    put: async (owner, input) => {
      if (input.bytes.length > maxBytes) {
        logger.info("blob.too-large", { organizationId: owner.organizationId, taskId: owner.task?.taskId ?? null, purpose: input.purpose, size: input.bytes.length });
        return tooLarge(input.bytes.length);
      }
      const stored = fromAdapter(await storeFor(owner).put({ organizationId: owner.organizationId, purpose: input.purpose }, input.bytes, input.contentType), "put");
      return stored.ok ? recordBlob(owner, stored.value, input.purpose, input.contentType) : stored;
    },

    startUpload: async (owner, input) => {
      if (input.size > maxBytes) {
        logger.info("blob.too-large", { organizationId: owner.organizationId, taskId: owner.task?.taskId ?? null, purpose: input.purpose, size: input.size });
        return tooLarge(input.size);
      }
      const started = fromAdapter(
        await storeFor(owner).startUpload({ organizationId: owner.organizationId, purpose: input.purpose }, input.sha256, input.size),
        "start",
      );
      if (!started.ok) {
        return started;
      }
      // The port has no content type: the service keeps it on the upload, for the blob it becomes.
      await db.blobUpload.updateMany({
        where: { id: started.value.uploadId, organizationId: owner.organizationId, receivedBytes: 0, blobId: null },
        data: { contentType: input.contentType },
      });
      logger.info("blob.upload-started", {
        organizationId: owner.organizationId,
        taskId: owner.task?.taskId ?? null,
        uploadId: started.value.uploadId,
        purpose: input.purpose,
        size: input.size,
        sha256: input.sha256,
        receivedBytes: started.value.receivedBytes,
      });
      return started;
    },

    appendUpload: async (owner, uploadId, offset, chunk) => {
      const upload = await ownedUpload(owner, uploadId);
      if (upload?.blobId !== null) {
        return { ok: false, error: "not-found", message: "no such open upload for this task" };
      }
      if (offset + chunk.length > upload.size) {
        return { ok: false, error: "too-large", message: "the chunk runs past the size the upload was started with" };
      }
      if (offset > upload.receivedBytes) {
        // A gap. A resend that starts earlier is the adapter's to check against what's held.
        return {
          ok: false,
          error: "offset-mismatch",
          message: `the chunk starts at ${String(offset)}, but ${String(upload.receivedBytes)} bytes have arrived: send from there`,
        };
      }
      const appended = fromAdapter(await storeFor(owner).appendUpload(uploadId, offset, chunk), "append");
      return appended.ok ? { ok: true, value: { receivedBytes: appended.value.receivedBytes } } : appended;
    },

    finishUpload: async (owner, uploadId) => {
      const upload = await ownedUpload(owner, uploadId);
      if (upload === null) {
        return { ok: false, error: "not-found", message: "no such upload for this task" };
      }
      if (upload.blobId !== null) {
        // Finishing twice answers the same.
        const done = await find(owner.organizationId, blobIdSchema.parse(upload.blobId));
        const sha256 = sha256HexSchema.safeParse(done?.sha256);
        return done !== null && sha256.success
          ? { ok: true, value: { blobId: done.blobId, size: done.size, sha256: sha256.data } }
          : { ok: false, error: "not-found", message: "the upload's blob is gone" };
      }
      if (upload.receivedBytes !== upload.size) {
        return {
          ok: false,
          error: "digest-mismatch",
          message: `${String(upload.receivedBytes)} of ${String(upload.size)} bytes have arrived`,
        };
      }
      const finished = await storeFor(owner).finishUpload(uploadId);
      if (!finished.ok) {
        if (finished.error.code === "conflict") {
          // The bytes don't match the digest: the upload is dropped, so a retry starts clean.
          await db.blobUpload.deleteMany({ where: { id: uploadId, organizationId: owner.organizationId, blobId: null } });
          logger.warn("blob.digest-mismatch", { organizationId: owner.organizationId, taskId: owner.task?.taskId ?? null, uploadId, size: upload.size });
          return { ok: false, error: "digest-mismatch", message: "the bytes do not match the SHA-256 the upload started with; the upload is dropped" };
        }
        return fromAdapter(finished, "finish");
      }
      return recordBlob(owner, finished.value, upload.purpose, upload.contentType);
    },

    find,

    read: async (organizationId, blobId, taskId) => {
      const row = await db.blob.findFirst({
        where: { id: blobId, organizationId, ...(taskId === undefined ? {} : { taskId }) },
        select: { store: true, key: true },
      });
      const found = await find(organizationId, blobId, taskId);
      if (row === null || found === null) {
        return { ok: false, error: "not-found", message: "no such blob" };
      }
      const owner: BlobScopeOwner = { organizationId, task: null };
      const bytes = fromAdapter(await storeFor(owner).get(organizationId, row.key), "read");
      return bytes.ok ? { ok: true, value: { ...found, bytes: bytes.value } } : bytes;
    },

    delete: async (organizationId, blobId) => {
      const row = await db.blob.findFirst({ where: { id: blobId, organizationId }, select: { key: true } });
      if (row === null) {
        return { ok: false, error: "not-found", message: "no such blob" };
      }
      const deleted = fromAdapter(await storeFor({ organizationId, task: null }).delete(organizationId, row.key), "delete");
      if (!deleted.ok && deleted.error !== "not-found") {
        return deleted;
      }
      // The built-in store's row went with its bytes; another store's row is the service's to drop.
      await db.blob.deleteMany({ where: { id: blobId, organizationId } });
      logger.info("blob.deleted", { organizationId, blobId });
      return { ok: true, value: undefined };
    },
  };
};
