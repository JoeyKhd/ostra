import { createHash } from "node:crypto";

import type { HealthReport, Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { createPanelBlobReadTokens, PANEL_BLOB_READ_TOKEN_TTL_MS, panelBlobReadPath } from "@ostra/domain";
import type { PanelBlobPurpose } from "@ostra/domain";
import { blobIdSchema, organizationIdSchema, taskIdSchema } from "@ostra/protocol";

// What the panel needs of the blob store (F-114, ADR 0043): its name and health for the storage page,
// a way to read one blob for the member who may see it (a check's full output, F-054; a task's
// screenshot or recording, F-121; a library skill's file, F-145), and a way to store a member's
// file. The panel holds no blob store itself: core's blob service writes every blob (`upload`) and
// reads every one (`read`), from whichever store the blob's row names, through that store's adapter.
// So a blob kept in an S3-compatible store reads as one kept in Postgres does, with no store's
// settings in the panel.

/** A blob's bytes as they come from core, with the size its row records. */
export type BlobBody = {
  /** The size the blob's row records: what a download's `content-length` says. */
  readonly size: number;
  /**
   * The bytes as they arrive. They are checked as they pass: more bytes than `size`, fewer, or bytes
   * whose SHA-256 isn't the row's, and the stream errors instead of ending. Read it once.
   */
  readonly stream: ReadableStream<Uint8Array>;
};

/** Why a blob was not read: there is none for that owner, or core (or its store) didn't answer. */
export type BlobReadResult =
  | { readonly kind: "found"; readonly blob: BlobBody }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable" };

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

/** A blob's whole bytes, for a reader that needs them all (a library file's text). Rejects when the stream does. */
export const blobBytes = async (blob: BlobBody): Promise<Uint8Array> => new Uint8Array(await new Response(blob.stream).arrayBuffer());

/** The bytes of `body`, checked against the row as they pass. */
const checkedAgainst = (body: ReadableStream<Uint8Array>, row: { readonly size: number; readonly sha256: string }): ReadableStream<Uint8Array> => {
  const hash = createHash("sha256");
  let received = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        received += chunk.length;
        if (received > row.size) {
          throw new Error("core sent more bytes than the blob's row records");
        }
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush: () => {
        if (received !== row.size || hash.digest("hex") !== row.sha256) {
          throw new Error("core's bytes are not the blob its row records");
        }
      },
    }),
  );
};

export type CoreBlobReaderOptions = {
  /** The panel's database: the blob's row, its owner, size and digest, is read there first. */
  readonly db: Db;
  /** Core as the panel reaches it (`OSTRA_CORE_INTERNAL_URL`), without a trailing slash. */
  readonly coreUrl: string;
  /** The secrets key's text: the key both processes hold. */
  readonly secret: string;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  /** How long core may take to start answering: a working value. The bytes then flow at the reader's pace. */
  readonly timeoutMs?: number;
};

/**
 * Reads a blob through core's blob service. The panel first finds the blob's row for that owner in
 * its own database (so another organization's or task's is not found without asking core), then asks
 * core with a read token good for that blob for a minute, and hands back core's bytes as a stream,
 * checked against the row's size and SHA-256. Logs carry the organization, the task and the blob's
 * ID, never bytes or the token.
 */
export const coreBlobReader = (options: CoreBlobReaderOptions): BlobStoreView["read"] => {
  const tokens = createPanelBlobReadTokens(options.secret);
  const now = options.now ?? Date.now;
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  return async (organizationIdText, taskIdText, blobIdText) => {
    const organizationId = organizationIdSchema.safeParse(organizationIdText);
    const taskId = taskIdText === null ? null : taskIdSchema.safeParse(taskIdText);
    const blobId = blobIdSchema.safeParse(blobIdText);
    if (!organizationId.success || taskId?.success === false || !blobId.success) {
      return { kind: "not-found" };
    }
    const owner = taskId === null ? null : taskId.data;
    const row = await options.db.blob.findFirst({ where: { id: blobId.data, organizationId: organizationId.data, taskId: owner }, select: { size: true, sha256: true } });
    if (row === null) {
      return { kind: "not-found" };
    }
    const logger = options.logger.child({ component: "panel-blobs", organizationId: organizationId.data, taskId: owner, blobId: blobId.data });
    const token = tokens.issue({ organizationId: organizationId.data, taskId: owner, blobId: blobId.data, expiresAt: now() + PANEL_BLOB_READ_TOKEN_TTL_MS });
    // The deadline is for core's answer to start; a slow member's download then sets the pace.
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort();
    }, timeoutMs);
    let response: Response;
    try {
      response = await send(`${options.coreUrl}${panelBlobReadPath(blobId.data)}`, { headers: { authorization: `Bearer ${token}` }, signal: deadline.signal });
    } catch (error) {
      logger.warn("panel-blob.read-unreachable", { error: error instanceof Error ? error.name : "unknown" });
      return { kind: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 200 && response.body !== null) {
      logger.info("panel-blob.read", { size: row.size });
      return { kind: "found", blob: { size: row.size, stream: checkedAgainst(response.body, row) } };
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) {
      // The row is here and core has no blob for it: it went between the two reads.
      logger.info("panel-blob.read-missing", { status: response.status });
      return { kind: "not-found" };
    }
    logger.warn("panel-blob.read-refused", { status: response.status });
    return { kind: "unavailable" };
  };
};
