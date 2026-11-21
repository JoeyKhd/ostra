import type { Logger } from "@ostra/adapter-sdk";
import { fileKindOf, fileTextOf, readsTextOf } from "@ostra/domain";
import type { FileTextLifecycle, StoredTicketFile, TicketFileSource, TicketReadPorts, UploadText } from "@ostra/domain";
import { projectIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, TaskId } from "@ostra/protocol";

import type { BlobScopeOwner, BlobService } from "../blobs/blob-service.ts";
import { TICKET_FILE_PURPOSE } from "../dispatch/restore-spec.ts";
import type { DocumentTextReader } from "./text/index.ts";

// Storing a file as it comes in (F-148, F-150, ADR 0070), the one step a member's upload (ticket 10,
// core's `POST /panel/v1/files`) and a ticket's file (ticket 12, `ticket.fetch-context` and
// `ticket.read-changes`) share: its kind and type told from its bytes and its name made safe
// (`fileKindOf`), its bytes stored as a blob in whichever store is the default, and a document's
// text read in the worker pool (unless `OSTRA_FILE_TEXT_EXTRACTION` is off) and stored beside it as
// a second blob (`message-file-text`). A document whose text can't be read is still stored, its
// text `failed` with the reader's reason. The caller writes the `MessageFile`. Lines carry IDs,
// sizes, kinds and states: never a file's name, bytes or text.

/** A member's file's blob purpose. A ticket's keeps F-064's, `TICKET_FILE_PURPOSE`. */
export const MESSAGE_FILE_PURPOSE = "message-file";
/** A file's text's blob purpose, a member's file's and a ticket's alike. */
export const MESSAGE_FILE_TEXT_PURPOSE = "message-file-text";

/** The type a text blob is stored as: ostra's Markdown. */
const TEXT_CONTENT_TYPE = "text/markdown; charset=utf-8";

export type FileBlobPurpose = typeof MESSAGE_FILE_PURPOSE | typeof TICKET_FILE_PURPOSE;

/**
 * Whose a file's blobs are: a project's with no task yet (a member's upload, until a message takes
 * it and makes them the task's), or a task's (a ticket's file).
 */
export type FileBlobOwner = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId | null;
};

/** A file stored: its safe name, kind, detected type, size, digest, blob and text, as the `MessageFile` row takes them. */
export type StoredFile = Omit<StoredTicketFile, keyof TicketFileSource>;

export type StoreFileResult =
  | { readonly ok: true; readonly file: StoredFile }
  /** `too-large`: over the blob cap. `unavailable`: the store didn't answer; nothing is kept. */
  | { readonly ok: false; readonly error: "too-large" | "unavailable"; readonly message: string };

export type StoreFileDeps = {
  readonly blobs: Pick<BlobService, "put" | "delete">;
  /** Core's one reader per process (`createDocumentTextReader`). */
  readonly text: Pick<DocumentTextReader, "read">;
  /** `OSTRA_FILE_TEXT_EXTRACTION`: with it off no document's text is read, and its state is `off`. */
  readonly extraction: boolean;
  readonly logger: Logger;
};

export type StoreFileInput = {
  readonly owner: FileBlobOwner;
  readonly purpose: FileBlobPurpose;
  readonly bytes: Uint8Array;
  /** The member's or the tracker's name, made safe here. Never logged. */
  readonly name: string;
};

/** A text state with no blob to name: a `ready` one without its blob can't be, so it's a text not read. */
const withoutBlob = (state: FileTextLifecycle): UploadText => (state.state === "ready" ? { state: "failed", reason: "not-read" } : state);

const blobOwnerOf = (owner: FileBlobOwner): BlobScopeOwner =>
  owner.taskId === null
    ? { organizationId: owner.organizationId, task: null, projectId: owner.projectId }
    : { organizationId: owner.organizationId, task: { projectId: owner.projectId, taskId: owner.taskId } };

/** Stores a file and, for a document, its text (see above). Never throws for a store's refusal: it answers it. */
export const storeFile = async (deps: StoreFileDeps, input: StoreFileInput): Promise<StoreFileResult> => {
  const { owner } = input;
  const ids = { organizationId: owner.organizationId, projectId: owner.projectId, taskId: owner.taskId };
  const detected = await fileKindOf(input.bytes, input.name);
  const blobOwner = blobOwnerOf(owner);
  const stored = await deps.blobs.put(blobOwner, { purpose: input.purpose, contentType: detected.contentType, bytes: input.bytes });
  if (!stored.ok) {
    deps.logger.warn("files.store-refused", { ...ids, purpose: input.purpose, size: input.bytes.byteLength, error: stored.error });
    return { ok: false, error: stored.error === "too-large" ? "too-large" : "unavailable", message: stored.message };
  }
  const file = stored.value;
  let text = withoutBlob(fileTextOf({ kind: detected.kind, extraction: deps.extraction, reading: null }));
  if (readsTextOf(detected.kind, deps.extraction)) {
    const read = await deps.text.read({ bytes: input.bytes, contentType: detected.contentType, name: detected.name });
    const reading = read.state === "ready" || read.state === "failed" ? read : null;
    const state = fileTextOf({ kind: detected.kind, extraction: deps.extraction, reading });
    if (state.state === "ready" && read.state === "ready") {
      const textStored = await deps.blobs.put(blobOwner, { purpose: MESSAGE_FILE_TEXT_PURPOSE, contentType: TEXT_CONTENT_TYPE, bytes: Buffer.from(read.markdown, "utf8") });
      if (textStored.ok) {
        text = { ...state, blobId: textStored.value.blobId };
      } else if (textStored.error === "too-large") {
        // A text past the blob cap is as good as none: the file goes without it.
        text = { state: "failed", reason: "too-big" };
      } else {
        // Nothing is kept half: the file's blob goes too, and the caller answers that the store didn't answer.
        await deps.blobs.delete(owner.organizationId, file.blobId);
        deps.logger.warn("files.store-refused", { ...ids, purpose: MESSAGE_FILE_TEXT_PURPOSE, size: read.markdown.length, error: textStored.error });
        return { ok: false, error: "unavailable", message: textStored.message };
      }
    } else {
      text = withoutBlob(state);
    }
  }
  deps.logger.info("files.stored", {
    ...ids,
    purpose: input.purpose,
    blobId: file.blobId,
    kind: detected.kind,
    size: file.size,
    textState: text.state,
    textReason: text.state === "failed" ? text.reason : null,
    textBlobId: text.state === "ready" ? text.blobId : null,
  });
  return { ok: true, file: { name: detected.name, kind: detected.kind, contentType: detected.contentType, size: file.size, sha256: file.sha256, blobId: file.blobId, text } };
};

/**
 * The domain's `storeFile` port for a ticket's reads (`TicketReadPorts`, ticket 06): a ticket's file
 * as a blob of its task (`ticket-file`) with its text. A store that doesn't answer throws, so the
 * job that reads the ticket retries.
 */
export const ticketFileStore =
  (deps: StoreFileDeps): TicketReadPorts["storeFile"] =>
  async (task, file) => {
    const stored = await storeFile(deps, {
      owner: { organizationId: task.organizationId, projectId: projectIdSchema.parse(task.projectId), taskId: task.taskId },
      purpose: TICKET_FILE_PURPOSE,
      bytes: file.bytes,
      name: file.name,
    });
    if (!stored.ok) {
      throw new Error(`a ticket's file couldn't be stored: ${stored.error}`);
    }
    return stored.file;
  };
