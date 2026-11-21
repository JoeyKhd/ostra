import type { Db, Tx } from "@ostra/db";
import {
  blobIdSchema,
  fileTextPathOf,
  isPromptImageContentType,
  messageFileIdSchema,
  runnerLimits,
  safeFileNameSchema,
  sha256HexSchema,
  taskSpecMessageFileSchema,
} from "@ostra/protocol";
import type {
  BlobId,
  ClientMessageId,
  FileLeftOut,
  ImagesNotSent,
  MemberId,
  MessageFileId,
  MessageFileKind,
  OrganizationId,
  ProjectId,
  PromptFiles,
  SafeFileName,
  SessionId,
  Sha256Hex,
  TaskId,
  TaskSeq,
  TaskEventOf,
  TaskSpecMessageFile,
  UserMessageFile,
} from "@ostra/protocol";

import type { MemberScope } from "../access.ts";
import type { FileTextLifecycle } from "../lifecycles/m9-files.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import { appendServerEvent, appendServerEventNumbered } from "../use-cases/server-events.ts";
import { modelImageInput, promptImagesFor } from "./images.ts";
import { checkMessageFiles } from "./limits.ts";
import type { FileLimits } from "./limits.ts";
import { boxPathFor } from "./places.ts";

// A member's files (F-148, ADR 0070, spec section 5.4): an upload is recorded as the member's in a
// project (core's `POST /panel/v1/files`, ticket 10), discarded by its member before sending, and
// bound to its message at send, in the transaction that writes the `user.message`: only the
// sender's own unsent uploads of that project, checked against the limits again, each placed in
// the box under `attachments/<n>/` (`<n>` the message's number), its blob and text made the task's
// so they follow its retention, and marked when it goes to the model as an image. A file's name,
// content and text are never logged.

const MiB = 1024 * 1024;

/** What the message use cases need of the install for files: the limits, and which agents take images. */
export type MessageFilesDeps = {
  readonly limits: FileLimits;
  /** Whether an agent adapter takes images in its prompt (its `promptImages`), by its registered name. */
  readonly agentTakesImages: (adapter: string) => boolean;
};

/**
 * The defaults, for a caller that names none: the settings' defaults (10 files, 10 MiB each, 25
 * MiB in all), and no agent taking images, so every image goes as a file until the caller says
 * its agent takes them.
 */
export const defaultMessageFilesDeps: MessageFilesDeps = {
  limits: { maxFiles: 10, maxFileBytes: 10 * MiB, maxTotalBytes: 25 * MiB },
  agentTakesImages: () => false,
};

// ---------- an upload ----------

/** An upload's text, as core read it: a `ready` one names its blob. */
export type UploadText = Exclude<FileTextLifecycle, { readonly state: "ready" }> | (Extract<FileTextLifecycle, { readonly state: "ready" }> & { readonly blobId: BlobId });

export type RecordUploadInput = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly memberId: MemberId;
  /** Its safe name, kind and detected type (`fileKindOf`). */
  readonly name: SafeFileName;
  readonly kind: MessageFileKind;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: Sha256Hex;
  /** Its bytes, a blob of the project (`message-file`). */
  readonly blobId: BlobId;
  readonly text: UploadText;
};

/** What the upload answers the box: the file, and its text's state and words. */
export type RecordedUpload = {
  readonly fileId: MessageFileId;
  readonly name: SafeFileName;
  readonly kind: MessageFileKind;
  readonly contentType: string;
  readonly size: number;
  readonly text: { readonly state: FileTextLifecycle["state"]; readonly words: number | null };
};

/** Records a member's upload, `uploaded`, no task's (core's endpoint, after it stored the blobs). */
export const recordUpload = async (tx: Tx, input: RecordUploadInput): Promise<RecordedUpload> => {
  const text = input.text;
  const created = await tx.messageFile.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      memberId: input.memberId,
      origin: "member",
      state: "uploaded",
      name: input.name,
      kind: input.kind,
      contentType: input.contentType,
      size: input.size,
      sha256: input.sha256,
      blobId: input.blobId,
      textState: text.state,
      ...(text.state === "ready" ? { textBlobId: text.blobId, textWords: text.words, textTruncated: text.truncated } : {}),
      ...(text.state === "failed" ? { textReason: text.reason } : {}),
    },
    select: { id: true },
  });
  return {
    fileId: messageFileIdSchema.parse(created.id),
    name: input.name,
    kind: input.kind,
    contentType: input.contentType,
    size: input.size,
    text: { state: text.state, words: text.state === "ready" ? text.words : null },
  };
};

export type DiscardUploadDeps = {
  readonly db: Db;
  readonly scope: MemberScope;
  /** Deletes a blob from its store and its row; by default its row (the Postgres store's chunks go with it). */
  readonly deleteBlob?: (organizationId: OrganizationId, blobId: BlobId) => Promise<boolean>;
};

export type DiscardUploadResult = UseCaseResult<{ readonly fileId: MessageFileId }, "not-found">;

/**
 * Deletes a member's own unsent upload, the "remove" before sending, and its blobs with it.
 * Another member's, a sent one or an unknown one is the same `not-found`.
 */
export const discardUpload = async (deps: DiscardUploadDeps, input: { readonly fileId: MessageFileId }): Promise<DiscardUploadResult> => {
  const { scope } = deps;
  const blobs = await deps.db.$transaction(async (tx) => {
    const file = await tx.messageFile.findFirst({
      where: { id: input.fileId, organizationId: scope.organizationId, memberId: scope.memberId, origin: "member", state: "uploaded" },
      select: { id: true, blobId: true, textBlobId: true },
    });
    if (file === null) {
      return null;
    }
    await tx.messageFile.delete({ where: { id: file.id } });
    return [file.blobId, file.textBlobId].flatMap((id) => (id === null ? [] : [blobIdSchema.parse(id)]));
  });
  if (blobs === null) {
    return { ok: false, error: "not-found", message: "No such file" };
  }
  for (const blobId of blobs) {
    if (deps.deleteBlob === undefined) {
      await deps.db.blob.deleteMany({ where: { id: blobId, organizationId: scope.organizationId } });
    } else {
      await deps.deleteBlob(scope.organizationId, blobId);
    }
  }
  return { ok: true, fileId: input.fileId };
};

// ---------- binding at send ----------

/** The model a message's images are decided for: its image input, as the model row keeps it. */
export type ImageModel = { readonly adminImageInput: boolean | null; readonly catalogInputModalities: unknown };

export type BindMessageFilesInput = {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly sessionId: SessionId;
  readonly clientMessageId: ClientMessageId;
  /** The `user.message`'s number in the task's log: the files' folder, `attachments/<n>/`. */
  readonly eventSeq: TaskSeq;
  readonly fileIds: readonly MessageFileId[];
  /** The session's model; `null` when it has none yet, so its image input is unknown (no image). */
  readonly model: ImageModel | null;
  /** The session's agent takes images in its prompt (its adapter's `promptImages`). */
  readonly agentTakesImages: boolean;
  readonly limits: FileLimits;
  readonly now: number;
};

/** A message's files once bound: the event's fields and the steer's. */
export type BoundMessageFiles = {
  /** The `user.message`'s `files`, in the message's order. */
  readonly files: readonly UserMessageFile[];
  /** The files over a limit, with why: still the member's uploads, swept after a day. */
  readonly filesLeftOut: readonly FileLeftOut[];
  readonly imagesNotSent: ImagesNotSent | null;
  /** The steer's `files` and `images` (and a spec's prompt's, by their IDs). */
  readonly steer: { readonly files: readonly TaskSpecMessageFile[]; readonly images: readonly MessageFileId[] };
};

export type BindMessageFilesResult = UseCaseResult<BoundMessageFiles, "file-not-found">;

/** No files: what a message without any binds to. */
export const noBoundFiles: BoundMessageFiles = { files: [], filesLeftOut: [], imagesNotSent: null, steer: { files: [], images: [] } };

/** The member's uploads among `fileIds`: their own, unsent, of the project. Any other ID makes it `null`. */
export const uploadsOfInTx = async (
  tx: Tx,
  scope: Pick<MemberScope, "organizationId" | "memberId">,
  projectId: ProjectId,
  fileIds: readonly MessageFileId[],
): Promise<readonly UploadRow[] | null> => {
  const unique = [...new Set(fileIds)];
  if (unique.length === 0) {
    return [];
  }
  if (unique.length > runnerLimits.messageFilesMax * 4) {
    return null;
  }
  const rows = await tx.messageFile.findMany({
    where: { id: { in: unique }, organizationId: scope.organizationId, projectId, memberId: scope.memberId, origin: "member", state: "uploaded", taskId: null },
    select: uploadSelect,
  });
  if (rows.length !== unique.length) {
    return null;
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return unique.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
};

const uploadSelect = {
  id: true,
  name: true,
  kind: true,
  contentType: true,
  size: true,
  sha256: true,
  blobId: true,
  textState: true,
  textBlobId: true,
  textBlob: { select: { id: true, size: true, sha256: true } },
} as const;

type UploadRow = {
  readonly id: string;
  readonly name: string;
  readonly kind: MessageFileKind;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string | null;
  readonly blobId: string | null;
  readonly textState: FileTextLifecycle["state"];
  readonly textBlobId: string | null;
  readonly textBlob: { readonly id: string; readonly size: number; readonly sha256: string } | null;
};

/** A row as the box gets it, or `null` when its blob is gone. */
const boxFileOf = (row: UploadRow, boxPath: string): TaskSpecMessageFile | null => {
  if (row.blobId === null || row.sha256 === null) {
    return null;
  }
  const text =
    row.textState === "ready" && row.textBlob !== null
      ? { blobId: blobIdSchema.parse(row.textBlob.id), size: row.textBlob.size, sha256: sha256HexSchema.parse(row.textBlob.sha256), path: fileTextPathOf(boxPath) }
      : null;
  return taskSpecMessageFileSchema.parse({
    fileId: row.id,
    blobId: row.blobId,
    size: row.size,
    sha256: row.sha256,
    kind: row.kind,
    contentType: row.contentType,
    path: boxPath,
    text,
  });
};

/**
 * Binds a message's files at send (ADR 0070), in the transaction that writes its `user.message`:
 * the sender's own unsent uploads of the task's project only (another member's, another project's
 * or a sent one is `file-not-found`, and nothing is bound); the limits checked again, what's over
 * left out with why and kept as an upload; each kept file sent: its task, message, position and
 * place, its blob and its text's blob made the task's; and the images decided (`promptImagesFor`).
 */
export const bindMessageFilesInTx = async (tx: Tx, scope: Pick<MemberScope, "organizationId" | "memberId">, input: BindMessageFilesInput): Promise<BindMessageFilesResult> => {
  if (input.fileIds.length === 0) {
    return { ok: true, ...noBoundFiles };
  }
  const uploads = await uploadsOfInTx(tx, scope, input.projectId, input.fileIds);
  if (uploads === null) {
    return { ok: false, error: "file-not-found", message: "One of the files isn't one of your unsent uploads in this project" };
  }
  const named = uploads.map((row) => ({ row, name: safeFileNameSchema.parse(row.name), size: row.size }));
  const checked = checkMessageFiles(named, input.limits);
  const places = boxPathFor("member", input.eventSeq, checked.kept.map((file) => file.name));
  const decision = promptImagesFor(
    checked.kept.map((file) => ({ fileId: messageFileIdSchema.parse(file.row.id), kind: file.row.kind, contentType: file.row.contentType, size: file.row.size })),
    { agentTakesImages: input.agentTakesImages, modelImageInput: input.model === null ? "unknown" : modelImageInput(input.model) },
  );
  const asImage = new Set<string>(decision.images);
  const files: UserMessageFile[] = [];
  const boxFiles: TaskSpecMessageFile[] = [];
  for (const [position, file] of checked.kept.entries()) {
    const boxPath = places[position] ?? "";
    // Guarded on the upload's state, so a send racing another of the same file binds it once.
    const sent = await tx.messageFile.updateMany({
      where: { id: file.row.id, state: "uploaded", taskId: null },
      data: {
        state: "sent",
        taskId: input.taskId,
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId,
        eventSeq: input.eventSeq,
        position,
        boxPath,
        asImage: asImage.has(file.row.id),
        sentAt: new Date(input.now),
      },
    });
    if (sent.count !== 1) {
      throw new Error("a message file was bound by another send in the meantime");
    }
    // Its blobs become the task's, so they follow its retention (F-079).
    const blobIds = [file.row.blobId, file.row.textBlobId].flatMap((id) => (id === null ? [] : [id]));
    if (blobIds.length > 0) {
      await tx.blob.updateMany({ where: { id: { in: blobIds }, organizationId: scope.organizationId }, data: { projectId: input.projectId, taskId: input.taskId } });
    }
    files.push({
      fileId: messageFileIdSchema.parse(file.row.id),
      name: file.name,
      kind: file.row.kind,
      contentType: file.row.contentType,
      size: file.row.size,
      origin: "member",
      asImage: asImage.has(file.row.id),
      text: file.row.textState,
    });
    const boxFile = boxFileOf(file.row, boxPath);
    if (boxFile !== null) {
      boxFiles.push(boxFile);
    }
  }
  return {
    ok: true,
    files,
    filesLeftOut: checked.leftOut.slice(0, runnerLimits.fileNotesMax).map((left) => ({ name: left.name, reason: left.reason })),
    imagesNotSent: decision.notSent,
    steer: { files: boxFiles, images: decision.images.filter((id) => boxFiles.some((file) => file.fileId === id)) },
  };
};

/** A bound message's fields of its `user.message`, each only when it has something. */
export const userMessageFileFields = (bound: BoundMessageFiles): { readonly files?: UserMessageFile[]; readonly filesLeftOut?: FileLeftOut[]; readonly imagesNotSent?: ImagesNotSent | null } => ({
  ...(bound.files.length === 0 ? {} : { files: [...bound.files] }),
  ...(bound.filesLeftOut.length === 0 ? {} : { filesLeftOut: [...bound.filesLeftOut] }),
  ...(bound.files.some((file) => file.kind === "image" && isPromptImageContentType(file.contentType)) ? { imagesNotSent: bound.imagesNotSent } : {}),
});

/** A bound message's fields of its `steer`, each only when it has something. */
export const steerFileFields = (bound: BoundMessageFiles): { readonly files?: TaskSpecMessageFile[]; readonly images?: MessageFileId[] } =>
  bound.steer.files.length === 0 ? {} : { files: [...bound.steer.files], images: [...bound.steer.images] };

/** A message's files as a pending message carries them (F-047): from its `user.message`'s `files`. */
export const promptFilesOfMessage = (files: readonly UserMessageFile[] | undefined): PromptFiles | undefined =>
  files === undefined || files.length === 0 ? undefined : { fileIds: files.map((file) => file.fileId), images: files.filter((file) => file.asImage).map((file) => file.fileId) };

// ---------- the spec ----------

/**
 * Every sent file of the task, for the spec's `files` (ADR 0070): oldest first (by its message,
 * then its place in it), each with its blob and its text's, at most `taskFilesMax` and
 * `taskFilesTotalBytes`. A file whose blob is gone is left out: the runner can't write it.
 */
export const taskSpecFilesOf = async (tx: Pick<Tx, "messageFile">, taskId: TaskId): Promise<readonly TaskSpecMessageFile[]> => {
  const rows = await tx.messageFile.findMany({
    where: { taskId, state: "sent", blobId: { not: null }, boxPath: { not: null } },
    orderBy: [{ eventSeq: "asc" }, { position: "asc" }, { createdAt: "asc" }],
    select: { ...uploadSelect, boxPath: true },
    take: runnerLimits.taskFilesMax,
  });
  const files: TaskSpecMessageFile[] = [];
  let total = 0;
  for (const row of rows) {
    const file = row.boxPath === null ? null : boxFileOf(row, row.boxPath);
    if (file === null) {
      continue;
    }
    const bytes = file.size + (file.text?.size ?? 0);
    if (total + bytes > runnerLimits.taskFilesTotalBytes) {
      break;
    }
    total += bytes;
    files.push(file);
  }
  return files;
};

// ---------- a member's message with its files ----------

/** What a message's files are bound with: the uploads, and the session's model and agent. */
export type MessageFilesToBind = {
  readonly fileIds: readonly MessageFileId[];
  readonly model: ImageModel | null;
  readonly agentTakesImages: boolean;
  readonly limits: FileLimits;
};

/**
 * What a member's message binds its files with, from the session's model and agent profile; `null`
 * for a message without files.
 */
export const filesToBindInTx = async (
  tx: Pick<Tx, "model" | "agentProfile">,
  organizationId: OrganizationId,
  deps: MessageFilesDeps,
  input: { readonly fileIds: readonly MessageFileId[]; readonly modelId: string | null; readonly agentProfileId: string | null },
): Promise<MessageFilesToBind | null> => {
  if (input.fileIds.length === 0) {
    return null;
  }
  const model = input.modelId === null ? null : await tx.model.findFirst({ where: { id: input.modelId, organizationId }, select: { adminImageInput: true, catalogInputModalities: true } });
  const profile = input.agentProfileId === null ? null : await tx.agentProfile.findFirst({ where: { id: input.agentProfileId, organizationId }, select: { adapter: true } });
  return { fileIds: input.fileIds, model, agentTakesImages: profile !== null && deps.agentTakesImages(profile.adapter), limits: deps.limits };
};

/** A member's `user.message` as it's written, before its files. */
export type MemberMessageEvent = Omit<TaskEventOf<"user.message">, "files" | "filesLeftOut" | "imagesNotSent">;

/**
 * Appends a member's `user.message`, its files bound to its number in the same transaction
 * (`bindMessageFilesInTx`) and their fields in the event. The caller checked the uploads first
 * (`uploadsOfInTx`), before anything was written: a file that's gone by now throws, and the
 * transaction rolls back.
 */
export const appendMemberMessageInTx = async (
  tx: Tx,
  where: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly taskId: TaskId; readonly sessionId: SessionId; readonly at: number },
  event: MemberMessageEvent,
  files: MessageFilesToBind | null,
): Promise<{ readonly seq: TaskSeq; readonly bound: BoundMessageFiles }> => {
  if (files === null || files.fileIds.length === 0) {
    return { seq: await appendServerEvent(tx, { ...where, event }), bound: noBoundFiles };
  }
  let bound: BoundMessageFiles = noBoundFiles;
  const { seq } = await appendServerEventNumbered(tx, where, async (eventSeq) => {
    const result = await bindMessageFilesInTx(
      tx,
      { organizationId: where.organizationId, memberId: event.memberId },
      {
        taskId: where.taskId,
        projectId: where.projectId,
        sessionId: where.sessionId,
        clientMessageId: event.clientMessageId,
        eventSeq,
        fileIds: files.fileIds,
        model: files.model,
        agentTakesImages: files.agentTakesImages,
        limits: files.limits,
        now: where.at,
      },
    );
    if (!result.ok) {
      throw new Error(`a message's files couldn't be bound: ${result.error}`);
    }
    bound = result;
    return { ...event, ...userMessageFileFields(result) };
  });
  return { seq, bound };
};
