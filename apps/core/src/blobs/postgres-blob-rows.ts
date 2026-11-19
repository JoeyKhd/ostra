import type { BlobRow, BlobRows, UploadRow } from "@ostra/adapter-blob-postgres";
import type { Db, Tx } from "@ostra/db";
import { blobIdSchema, organizationIdSchema, uploadIdSchema } from "@ostra/protocol";
import type { BlobId, OrganizationId, ProjectId, TaskId, UploadId } from "@ostra/protocol";
import { z } from "zod";

// Core's Postgres implementation of the built-in blob store's port (ADR 0043, ticket 12): the
// `Blob`, `BlobUpload` and `BlobChunk` tables, the bytes in chunks of at most 1 MiB, every write in
// one transaction. A finished upload's chunks move to its blob instead of being written twice.
//
// The rows can be bound to an owner (a project and a task): every blob and upload they write then
// carries it, and a resume finds only that task's open upload, so two tasks uploading the same
// bytes never share an upload. Bytes are never logged; nothing here logs at all.

/** The most bytes in one `BlobChunk` row. */
export const BLOB_CHUNK_BYTES = 1024 * 1024;

/** The task a blob belongs to. Both or neither: the schema's composite key needs the project. */
export type BlobOwner = { readonly projectId: ProjectId; readonly taskId: TaskId };

const STORE = "postgres" as const;

const heldSchema = z.array(z.looseObject({ bytes: z.number() }));

const keyOf = (id: BlobId): string => `${STORE}:${id}`;

const concatChunks = (chunks: readonly { readonly bytes: Uint8Array }[], size: number): Uint8Array => {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk.bytes, offset);
    offset += chunk.bytes.length;
  }
  return offset === size ? out : out.subarray(0, offset);
};

/** Splits bytes into chunk rows starting at `ordinal` and `offset`. */
const chunkRows = (
  bytes: Uint8Array,
  start: { readonly ordinal: number; readonly offset: number },
): { readonly ordinal: number; readonly offset: number; readonly bytes: Uint8Array<ArrayBuffer> }[] => {
  const rows: { readonly ordinal: number; readonly offset: number; readonly bytes: Uint8Array<ArrayBuffer> }[] = [];
  for (let at = 0; at < bytes.length; at += BLOB_CHUNK_BYTES) {
    const slice = bytes.subarray(at, Math.min(bytes.length, at + BLOB_CHUNK_BYTES));
    // A copy: Prisma takes an ArrayBuffer-backed array, and a subarray may share a bigger buffer.
    rows.push({ ordinal: start.ordinal + rows.length, offset: start.offset + at, bytes: new Uint8Array(slice) });
  }
  return rows;
};

const lockUpload = async (tx: Tx, uploadId: string): Promise<void> => {
  await tx.$queryRaw`SELECT 1 FROM "blob_upload" WHERE "id" = ${uploadId} FOR UPDATE`;
};

const readUpload = async (
  db: Db | Tx,
  row: {
    readonly id: string;
    readonly organizationId: string;
    readonly purpose: string;
    readonly expectedSha256: string;
    readonly size: number;
    readonly receivedBytes: number;
    readonly blobId: string | null;
  },
): Promise<UploadRow> => {
  // A finished upload's chunks belong to its blob: it holds no bytes of its own.
  const chunks =
    row.blobId === null
      ? await db.blobChunk.findMany({ where: { uploadId: row.id }, orderBy: { ordinal: "asc" }, select: { bytes: true } })
      : [];
  return {
    uploadId: uploadIdSchema.parse(row.id),
    organizationId: organizationIdSchema.parse(row.organizationId),
    purpose: row.purpose,
    expectedSha256: row.expectedSha256,
    size: row.size,
    received: concatChunks(chunks, row.receivedBytes),
    blobId: row.blobId === null ? null : blobIdSchema.parse(row.blobId),
  };
};

const uploadSelect = {
  id: true,
  organizationId: true,
  purpose: true,
  expectedSha256: true,
  size: true,
  receivedBytes: true,
  blobId: true,
} as const;

/** The built-in store's rows on Postgres, bound to `owner` when given. */
export const postgresBlobRows = (db: Db, owner: BlobOwner | null = null): BlobRows => {
  const ownerColumns = owner === null ? {} : { projectId: owner.projectId, taskId: owner.taskId };
  return {
    insertBlob: async (row: BlobRow) => {
      await db.$transaction(
        async (tx) => {
          await tx.blob.create({
            data: {
              id: row.id,
              organizationId: row.organizationId,
              ...ownerColumns,
              store: STORE,
              key: keyOf(row.id),
              purpose: row.purpose,
              contentType: row.contentType,
              size: row.size,
              sha256: row.sha256,
            },
          });
          // A finished upload with these bytes: its chunks move to the blob instead of being copied.
          const upload = await tx.blobUpload.findFirst({
            where: {
              organizationId: row.organizationId,
              store: STORE,
              purpose: row.purpose,
              expectedSha256: row.sha256,
              size: row.size,
              receivedBytes: row.size,
              blobId: null,
              ...(owner === null ? {} : { taskId: owner.taskId }),
            },
            orderBy: { createdAt: "asc" },
            select: { id: true },
          });
          if (upload !== null) {
            await lockUpload(tx, upload.id);
            await tx.blobChunk.updateMany({ where: { uploadId: upload.id }, data: { uploadId: null, blobId: row.id } });
            const held = heldSchema.parse(
              await tx.$queryRaw<readonly unknown[]>`
                SELECT COALESCE(SUM(length("bytes")), 0)::int AS "bytes" FROM "blob_chunk" WHERE "blobId" = ${row.id}`,
            );
            if (held[0]?.bytes === row.size) {
              return;
            }
            // Not the same bytes after all (it can't happen through the adapter): write them.
            await tx.blobChunk.deleteMany({ where: { blobId: row.id } });
          }
          const rows = chunkRows(row.bytes, { ordinal: 0, offset: 0 });
          if (rows.length > 0) {
            await tx.blobChunk.createMany({
              data: rows.map((chunk) => ({ organizationId: row.organizationId, blobId: row.id, ...chunk })),
            });
          }
        },
        { timeout: 60_000 },
      );
    },

    getBlob: async (id: BlobId) => {
      const blob = await db.blob.findFirst({
        where: { id, store: STORE },
        select: { id: true, organizationId: true, purpose: true, contentType: true, size: true, sha256: true },
      });
      if (blob === null) {
        return undefined;
      }
      const chunks = await db.blobChunk.findMany({ where: { blobId: id }, orderBy: { ordinal: "asc" }, select: { bytes: true } });
      return {
        id: blobIdSchema.parse(blob.id),
        organizationId: organizationIdSchema.parse(blob.organizationId),
        purpose: blob.purpose,
        contentType: blob.contentType,
        size: blob.size,
        sha256: blob.sha256,
        bytes: concatChunks(chunks, blob.size),
      };
    },

    deleteBlob: async (id: BlobId) => {
      // The chunks go with it (the foreign key cascades).
      const deleted = await db.blob.deleteMany({ where: { id, store: STORE } });
      return deleted.count > 0;
    },

    findUpload: async (organizationId: OrganizationId, purpose: string, expectedSha256: string) => {
      const row = await db.blobUpload.findFirst({
        where: {
          organizationId,
          store: STORE,
          purpose,
          expectedSha256,
          blobId: null,
          ...(owner === null ? {} : { taskId: owner.taskId }),
        },
        orderBy: { createdAt: "asc" },
        select: uploadSelect,
      });
      return row === null ? undefined : readUpload(db, row);
    },

    getUpload: async (uploadId: UploadId) => {
      const row = await db.blobUpload.findFirst({ where: { id: uploadId, store: STORE }, select: uploadSelect });
      return row === null ? undefined : readUpload(db, row);
    },

    putUpload: async (row: UploadRow) => {
      await db.$transaction(
        async (tx) => {
          await lockUpload(tx, row.uploadId);
          const existing = await tx.blobUpload.findFirst({
            where: { id: row.uploadId },
            select: { receivedBytes: true, blobId: true, size: true },
          });
          if (existing === null) {
            await tx.blobUpload.create({
              data: {
                id: row.uploadId,
                organizationId: row.organizationId,
                ...ownerColumns,
                store: STORE,
                purpose: row.purpose,
                contentType: "application/octet-stream",
                expectedSha256: row.expectedSha256,
                size: row.size,
                receivedBytes: 0,
              },
            });
          }
          if (row.blobId !== null) {
            // Finished: the chunks moved to the blob; any left over are dropped.
            await tx.blobChunk.deleteMany({ where: { uploadId: row.uploadId } });
            await tx.blobUpload.update({ where: { id: row.uploadId }, data: { blobId: row.blobId, receivedBytes: existing?.size ?? row.size } });
            return;
          }
          const held = existing?.receivedBytes ?? 0;
          if (row.received.length <= held) {
            return;
          }
          // Only the bytes past what's held are new: the adapter hands the whole upload each time.
          const last = await tx.blobChunk.findFirst({ where: { uploadId: row.uploadId }, orderBy: { ordinal: "desc" }, select: { ordinal: true } });
          const rows = chunkRows(row.received.subarray(held), { ordinal: (last?.ordinal ?? -1) + 1, offset: held });
          await tx.blobChunk.createMany({
            data: rows.map((chunk) => ({ organizationId: row.organizationId, uploadId: row.uploadId, ...chunk })),
          });
          await tx.blobUpload.update({ where: { id: row.uploadId }, data: { receivedBytes: row.received.length } });
        },
        { timeout: 60_000 },
      );
    },
  };
};
