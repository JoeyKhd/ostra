import { createHash, randomUUID } from "node:crypto";

import type { Db } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { fileKindOf, MESSAGE_FILE_FORM_FIELD, MESSAGE_FILE_TASK_FIELD, recordedUploadSchema, recordUploadWithinCapInTx, unsentUploadsMax } from "@ostra/domain";
import type { RecordedUpload, UploadText } from "@ostra/domain";
import { blobIdSchema, sha256HexSchema } from "@ostra/protocol";
import type { FileTextFailureReason, MessageFileKind } from "@ostra/protocol";

import { serveMessageFileUpload } from "../services/message-file-upload.ts";
import type { MessageFileUploader, MessageFileUploadInput } from "../services/panel-files.ts";
import type { BareHarness } from "./harness.ts";

// Milestone 9 (ticket 14): core's side of a member's upload, in the test's own process, for the
// harness (`deps.fileUploader`): what `POST /panel/v1/files` does once the token checks out (ticket
// 10). The file's kind and safe name from its bytes (`fileKindOf`, the domain's, as core runs it),
// its bytes a built-in blob of the project (so the panel's reader reads them back), a document's
// text as the test says core read it, and the `MessageFile` recorded within the unsent cap. A test
// of the HTTP hand-over itself runs `corePanelFileUploader` against a fake core instead.

/** What core's reader makes of a document, as a test wants it: its text and words, why none, or nothing read. */
export type FakeTextReading = { readonly state: "ready"; readonly markdown: string; readonly words: number } | { readonly state: "failed"; readonly reason: FileTextFailureReason };

export type FakeCoreUploads = {
  readonly uploader: MessageFileUploader;
  /** Every upload core was asked for, in order: a test checks one was never asked. */
  readonly asked: MessageFileUploadInput[];
};

/** A blob of the project's in the built-in store, its bytes one chunk. */
const putBlob = async (db: Db, owner: Pick<MessageFileUploadInput, "organizationId" | "projectId">, purpose: string, contentType: string, bytes: Uint8Array): Promise<string> => {
  const row = await db.blob.create({
    data: {
      organizationId: owner.organizationId,
      projectId: owner.projectId,
      store: "postgres",
      key: `upload-${randomUUID()}`,
      purpose,
      contentType,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    select: { id: true },
  });
  await db.blobChunk.create({ data: { organizationId: owner.organizationId, blobId: row.id, ordinal: 0, offset: 0, bytes: Uint8Array.from(bytes) } });
  return row.id;
};

/**
 * Core's upload, faked at its port. `textOf` says what core's reader made of a document; without
 * it, documents' text is `off`, as with `OSTRA_FILE_TEXT_EXTRACTION=false`.
 */
export const fakeCoreUploads = (
  db: Db,
  options: { readonly maxFiles: number; readonly textOf?: (kind: MessageFileKind, name: string) => FakeTextReading | null } = { maxFiles: 10 },
): FakeCoreUploads => {
  const asked: MessageFileUploadInput[] = [];
  const uploader: MessageFileUploader = async (input) => {
    asked.push(input);
    const detected = await fileKindOf(input.bytes, input.name);
    const blobId = blobIdSchema.parse(await putBlob(db, input, "message-file", detected.contentType, input.bytes));
    const reading = detected.kind === "document" ? (options.textOf?.(detected.kind, detected.name) ?? null) : null;
    let text: UploadText;
    if (detected.kind !== "document") {
      text = { state: "none" };
    } else if (reading === null) {
      text = { state: "off" };
    } else if (reading.state === "failed") {
      text = { state: "failed", reason: reading.reason };
    } else {
      const markdown = new TextEncoder().encode(reading.markdown);
      text = { state: "ready", words: reading.words, truncated: false, blobId: blobIdSchema.parse(await putBlob(db, input, "message-file-text", "text/markdown; charset=utf-8", markdown)) };
    }
    const recorded = await db.$transaction((tx) =>
      recordUploadWithinCapInTx(
        tx,
        {
          organizationId: input.organizationId,
          projectId: input.projectId,
          memberId: input.memberId,
          name: detected.name,
          kind: detected.kind,
          contentType: detected.contentType,
          size: input.bytes.length,
          sha256: sha256HexSchema.parse(createHash("sha256").update(input.bytes).digest("hex")),
          blobId,
          text,
        },
        unsentUploadsMax({ maxFiles: options.maxFiles }),
      ),
    );
    if (!recorded.ok) {
      return { kind: "refused", code: recorded.error, message: recorded.message };
    }
    return { kind: "stored", file: { fileId: recorded.fileId, name: recorded.name, kind: recorded.kind, contentType: recorded.contentType, size: recorded.size, text: recorded.text } };
  };
  return { uploader, asked };
};

/**
 * A member's file through the upload route, as the message box sends it (`FormData`, from the
 * panel's origin): core's view of it, or the route's refusal thrown. `uploader` stands in for core.
 */
export const uploadThroughRoute = async (
  harness: Pick<BareHarness, "contextOf">,
  member: SeededMember,
  projectId: string,
  file: { readonly name: string; readonly bytes: Uint8Array },
  options: { readonly taskId?: string; readonly uploader?: MessageFileUploader } = {},
): Promise<RecordedUpload> => {
  const form = new FormData();
  form.append(MESSAGE_FILE_FORM_FIELD, new File([Buffer.from(file.bytes)], file.name));
  if (options.taskId !== undefined) {
    form.append(MESSAGE_FILE_TASK_FIELD, options.taskId);
  }
  const context = await harness.contextOf(member);
  const request = new Request(`http://localhost:3000/api/projects/${projectId}/files`, { method: "POST", body: form, headers: { origin: "http://localhost:3000" } });
  const response = await serveMessageFileUpload(options.uploader === undefined ? context : { ...context, deps: { ...context.deps, fileUploader: options.uploader } }, request, projectId);
  const body: unknown = await response.json();
  const stored = recordedUploadSchema.safeParse(body);
  if (!stored.success) {
    throw new Error(`the upload was refused: ${String(response.status)} ${JSON.stringify(body)}`);
  }
  return stored.data;
};
