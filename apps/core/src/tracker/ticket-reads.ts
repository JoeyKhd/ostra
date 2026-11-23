import { createHash } from "node:crypto";

import type { Logger, OwnWrites, TrackerAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { fetchTicketFiles, noTicketFiles, PARENT_COMMENT_MARKER, PROGRESS_COMMENT_MARKER, ticketFileLimits } from "@ostra/domain";
import type { FetchedTicketFiles, FileSettings, TicketReadPorts } from "@ostra/domain";
import { blobIdSchema, connectionIdSchema, externalTicketIdSchema, sha256HexSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, TaskId } from "@ostra/protocol";

import type { BlobService } from "../blobs/blob-service.ts";
import { TICKET_FILE_PURPOSE } from "../dispatch/restore-spec.ts";
import { ticketFileStore } from "../files/store-file.ts";
import type { DocumentTextReader } from "../files/text/index.ts";
import { DRAFT_ATTACHMENT_MARKER } from "../refine/apply.ts";
import type { ConnectionTrackers } from "./connections.ts";

// A ticket's files, read and stored by core (F-149, F-150, ADR 0070; ticket 12): the ports the
// domain's reads run on (`TicketReadPorts`), for the start's read (`ticket.fetch-context`), each
// later round (`ticket.read-changes`) and a Linear follow-up's files. The ticket's context and its
// files come through the connection's adapter, with its credential, which stays in core (ADR 0030):
// `downloadFile` sends it to the tracker's own file host only. Each file is stored by ticket 10's
// step (`ticketFileStore`): a blob of the task (`ticket-file`), its kind told by its bytes, and a
// document's text read in core's worker pool and stored beside it. A file's name, its bytes, its
// text and the tracker's URLs never reach a log line: IDs, sizes, kinds and codes only.

/**
 * What ostra's own writes on a ticket look like (ADR 0070): every comment of its app user, its
 * progress comments (a task's and a parent's), and the attachments a draft's "Update ticket"
 * made. A file in one is `byOstra`, and core leaves it out as it leaves out ostra's comments.
 */
export const ownWritesOf = (ownUserId: string | null): OwnWrites => ({
  userId: ownUserId,
  commentMarkers: [PROGRESS_COMMENT_MARKER, PARENT_COMMENT_MARKER],
  attachmentMarkers: [DRAFT_ATTACHMENT_MARKER],
});

/** What core stores a ticket's file with: the blob store, core's one text reader and the install's settings. */
export type TicketFileStoreDeps = {
  readonly db: Db;
  readonly blobs: Pick<BlobService, "put" | "delete">;
  /** Core's one reader of documents' text per process (`createDocumentTextReader`). */
  readonly text: Pick<DocumentTextReader, "read">;
  /** The settings' file limits and `OSTRA_FILE_TEXT_EXTRACTION` (`settings.files`). */
  readonly files: FileSettings;
  readonly logger: Logger;
};

export type TicketReadsDeps = TicketFileStoreDeps & {
  readonly trackers: Pick<ConnectionTrackers, "forConnection">;
  /**
   * Milestone 11 (F-008/c8): the tracker refused the connection's saved token (401): the connection
   * fails at once and its boards pause (`failRefusedToken`). The read is then `gone`, as any read of
   * a connection that isn't active: the start goes on from the ticket's cached row.
   */
  readonly tokenRefused?: (input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId }) => Promise<boolean>;
};

type TaskOwner = { readonly organizationId: OrganizationId; readonly projectId: string; readonly taskId: TaskId };

/**
 * The blob store, storing a task's ticket files once: a blob of the task with the same purpose and
 * bytes that no file holds yet (left by a run of the job that stopped before its transaction) is
 * taken again, a file's and its text's alike, so a retry after a partial run stores nothing twice.
 */
const blobsOnce = (db: Db, blobs: Pick<BlobService, "put" | "delete">): Pick<BlobService, "put" | "delete"> => ({
  delete: blobs.delete,
  put: async (owner, input) => {
    if (owner.task === null) {
      return blobs.put(owner, input);
    }
    const sha256 = sha256HexSchema.parse(createHash("sha256").update(input.bytes).digest("hex"));
    const unheld = input.purpose === TICKET_FILE_PURPOSE ? { messageFiles: { none: {} } } : { messageFileTexts: { none: {} } };
    const earlier = await db.blob.findFirst({
      where: { organizationId: owner.organizationId, taskId: owner.task.taskId, purpose: input.purpose, sha256, size: input.bytes.byteLength, ...unheld },
      select: { id: true },
    });
    return earlier === null ? blobs.put(owner, input) : { ok: true, value: { blobId: blobIdSchema.parse(earlier.id), size: input.bytes.byteLength, sha256 } };
  },
});

/**
 * Stores one of a ticket's files (ADR 0070) with ticket 10's step: a blob of the task (`ticket-file`)
 * of the bytes as the tracker gave them, its kind and type told by the bytes (never the tracker's
 * type or the name), its name made safe, and a document's text read (unless the install reads none)
 * and stored beside it. A store that doesn't answer throws, so the job retries; the retry takes
 * again what the stopped run stored.
 */
export const storeTicketFile = (deps: TicketFileStoreDeps): TicketReadPorts["storeFile"] =>
  ticketFileStore({ blobs: blobsOnce(deps.db, deps.blobs), text: deps.text, extraction: deps.files.textExtraction, logger: deps.logger });

/**
 * Downloads one of a ticket's files with the tracker's adapter, reading at most `maxBytes`: over it
 * is `too-big` (the adapter's `invalid-input`, nothing more read), anything else `download-failed`.
 */
export const downloadWith =
  (tracker: Pick<TrackerAdapter, "downloadFile">, logger: Logger): TicketReadPorts["downloadFile"] =>
  async (task, url, maxBytes) => {
    const file = await tracker.downloadFile(url, maxBytes);
    if (file.ok) {
      return { ok: true, bytes: file.value.bytes };
    }
    logger.info("ticket.file-download-failed", { taskId: task.taskId, code: file.error.code });
    return { ok: false, reason: file.error.code === "invalid-input" ? "too-big" : "download-failed" };
  };

type TaskTracker =
  | { readonly ok: true; readonly tracker: TrackerAdapter; readonly connectionId: ConnectionId; readonly ownUserId: string | null; readonly board: { readonly externalId: string }; readonly ticket: { readonly externalId: string } }
  | { readonly ok: false; readonly reason: "unavailable" | "gone" };

/**
 * The ports a ticket task's reads run on (`TicketReadPorts`), for one job's run: the task's ticket
 * through its board's connection (looked up once), its files downloaded with the same adapter, and
 * stored with `storeTicketFile`. A connection that's gone, revoked or no longer finds the ticket is
 * `gone`; one that doesn't answer is `unavailable`, and the job retries.
 */
export const ticketReadPorts = (deps: TicketReadsDeps): TicketReadPorts => {
  const found = new Map<TaskId, Promise<TaskTracker>>();
  const trackerOf = (task: { readonly organizationId: OrganizationId; readonly taskId: TaskId }): Promise<TaskTracker> => {
    const known = found.get(task.taskId);
    if (known !== undefined) {
      return known;
    }
    const looked = (async (): Promise<TaskTracker> => {
      const row = await deps.db.task.findFirst({ where: { id: task.taskId, organizationId: task.organizationId }, select: { ticketId: true, boardId: true } });
      const ticket = row?.ticketId === null || row === null ? null : await deps.db.ticket.findFirst({ where: { id: row.ticketId, organizationId: task.organizationId }, select: { externalId: true } });
      const board = row?.boardId === null || row === null ? null : await deps.db.board.findFirst({ where: { id: row.boardId, organizationId: task.organizationId }, select: { externalId: true, connectionId: true } });
      if (ticket === null || board === null) {
        return { ok: false, reason: "gone" };
      }
      const lookup = await deps.trackers.forConnection(task.organizationId, connectionIdSchema.parse(board.connectionId));
      if (!lookup.ok) {
        return { ok: false, reason: lookup.reason === "no-token" ? "unavailable" : "gone" };
      }
      return { ok: true, tracker: lookup.value.tracker, connectionId: lookup.value.connectionId, ownUserId: lookup.value.ownUserId, board, ticket };
    })();
    found.set(task.taskId, looked);
    return looked;
  };
  return {
    readTicket: async (task) => {
      const tracker = await trackerOf(task);
      if (!tracker.ok) {
        return tracker;
      }
      const read = await tracker.tracker.getTicketContext(
        { externalId: tracker.board.externalId },
        { externalId: externalTicketIdSchema.parse(tracker.ticket.externalId) },
        { own: ownWritesOf(tracker.ownUserId) },
      );
      if (!read.ok) {
        deps.logger.info("ticket.read-failed", { taskId: task.taskId, code: read.error.code });
        if (read.error.code === "unauthorized" && deps.tokenRefused !== undefined) {
          await deps.tokenRefused({ organizationId: task.organizationId, connectionId: tracker.connectionId });
        }
        return { ok: false, reason: read.error.code === "rate-limited" || read.error.code === "unavailable" ? "unavailable" : "gone" };
      }
      return { ok: true, context: read.value, capability: tracker.tracker.capabilities.ticketFiles, ownUserId: tracker.ownUserId };
    },
    downloadFile: async (task, url, maxBytes) => {
      const tracker = await trackerOf(task);
      return tracker.ok ? downloadWith(tracker.tracker, deps.logger)(task, url, maxBytes) : { ok: false, reason: "download-failed" };
    },
    storeFile: storeTicketFile(deps),
  };
};

/**
 * A Linear follow-up's files (ADR 0057, amended by ADR 0070): those its comment names
 * (`filesInText`, which needs the tracker's `ticketFiles`), fetched as a ticket's are, within the
 * ticket's limits, with the adapter that read the follow-up.
 */
export const fetchFollowUpFiles = async (deps: TicketFileStoreDeps, tracker: TrackerAdapter, task: TaskOwner, text: string): Promise<FetchedTicketFiles> => {
  const named = tracker.filesInText(text);
  if (named.length === 0) {
    return noTicketFiles;
  }
  return fetchTicketFiles(
    { reads: { downloadFile: downloadWith(tracker, deps.logger), storeFile: storeTicketFile(deps) }, limits: ticketFileLimits(deps.files) },
    task,
    named,
    tracker.capabilities.ticketFiles,
  );
};
