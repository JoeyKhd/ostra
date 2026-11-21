import type { Db, Tx } from "@ostra/db";
import {
  blobIdSchema,
  canSendFiles,
  fileTextFailureReasonSchema,
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
  FileLeftOutReason,
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
import type { RecordedUpload } from "./upload-answer.ts";

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

// What the upload answers the box is `RecordedUpload` (`recordedUploadSchema`, `upload-answer.ts`):
// the file, and its text's state, a failed one's reason, and a ready one's words.

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
    text: {
      state: text.state,
      // The reader's reasons are the protocol's (`fileTextFailureReasonSchema`); one it doesn't name is a text never stored.
      reason: text.state === "failed" ? fileTextFailureReasonSchema.catch("not-read").parse(text.reason) : null,
      words: text.state === "ready" ? text.words : null,
    },
  };
};

/**
 * How many unsent uploads a member may hold in one project at once (ticket 10, a working value):
 * twice a message's files, so the tray can't fill the store. The next upload is refused.
 */
export const unsentUploadsMax = (limits: Pick<FileLimits, "maxFiles">): number => 2 * limits.maxFiles;

/** The member's unsent uploads in the project. */
export const unsentUploadsOfInTx = (
  tx: Pick<Tx, "messageFile">,
  who: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly memberId: MemberId },
): Promise<number> =>
  tx.messageFile.count({ where: { organizationId: who.organizationId, projectId: who.projectId, memberId: who.memberId, origin: "member", state: "uploaded", taskId: null } });

export type RecordUploadWithinCapResult = UseCaseResult<RecordedUpload, "too-many-unsent">;

/**
 * Records a member's upload unless they hold `cap` unsent ones in the project already
 * (`unsentUploadsMax`). The member's uploads in a project are counted under one lock, so two
 * uploads at once can't both take the last place.
 */
export const recordUploadWithinCapInTx = async (tx: Tx, input: RecordUploadInput, cap: number): Promise<RecordUploadWithinCapResult> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`unsent-uploads:${input.projectId}:${input.memberId}`}))`;
  if ((await unsentUploadsOfInTx(tx, input)) >= cap) {
    return { ok: false, error: "too-many-unsent", message: `You have ${String(cap)} files waiting to be sent in this project: send or remove some first` };
  }
  return { ok: true, ...(await recordUpload(tx, input)) };
};

export type DiscardUploadDeps = {
  readonly db: Db;
  readonly scope: MemberScope;
};

export type DiscardUploadResult = UseCaseResult<{ readonly fileId: MessageFileId }, "not-found">;

/**
 * A member's "remove" before sending (ticket 14): their own unsent upload is `expired` at once,
 * guarded on its state, so no message can take it from then on and it no longer counts against
 * the member's unsent cap. Its blobs go with core's next `files.sweep-unsent` pass, which deletes
 * every expired upload's blobs from whichever store holds them (the panel deletes no blob, ADR
 * 0043). Another member's, a sent one, an expired one or an unknown one is the same `not-found`.
 */
export const discardUpload = async (deps: DiscardUploadDeps, input: { readonly fileId: MessageFileId }): Promise<DiscardUploadResult> => {
  const { scope } = deps;
  const expired = await deps.db.messageFile.updateMany({
    where: { id: input.fileId, organizationId: scope.organizationId, memberId: scope.memberId, origin: "member", state: "uploaded", taskId: null },
    data: { state: "expired" },
  });
  if (expired.count === 0) {
    return { ok: false, error: "not-found", message: "No such file" };
  }
  return { ok: true, fileId: input.fileId };
};

// ---------- a file's text, as the thread shows it ----------

/** A file's text facts as its message records them (ticket 14): a `ready` text's words, a `failed` one's reason. */
export const textFactsOf = (text: { readonly state: FileTextLifecycle["state"]; readonly words: number | null; readonly reason: string | null }): Pick<UserMessageFile, "textWords" | "textReason"> => {
  switch (text.state) {
    case "ready":
      return text.words === null ? {} : { textWords: text.words };
    case "failed": {
      const reason = fileTextFailureReasonSchema.safeParse(text.reason);
      return reason.success ? { textReason: reason.data } : {};
    }
    case "none":
    case "off":
      return {};
    default:
      return text.state satisfies never;
  }
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
  textWords: true,
  textReason: true,
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
  readonly textWords: number | null;
  readonly textReason: string | null;
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
      ...textFactsOf({ state: file.row.textState, words: file.row.textWords, reason: file.row.textReason }),
    });
    const boxFile = boxFileOf(file.row, boxPath);
    if (boxFile !== null) {
      boxFiles.push(boxFile);
    }
  }
  return {
    ok: true,
    files,
    // Ticket 14: each with its size, so the thread's note says how big it was.
    filesLeftOut: checked.leftOut.slice(0, runnerLimits.fileNotesMax).map((left) => ({ name: left.name, reason: left.reason, size: left.file.size })),
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

/**
 * Whether a runner may be sent a message with files (ADR 0070, Q340, `canSendFiles`): its
 * connection's minor, else the minor it last spoke. Core asks before it writes a steer with files.
 */
export const runnerTakesFilesInTx = async (tx: Pick<Tx, "runnerPresence" | "runner">, runnerId: string): Promise<boolean> => {
  const presence = await tx.runnerPresence.findUnique({ where: { runnerId }, select: { minor: true } });
  const minor = presence?.minor ?? (await tx.runner.findUnique({ where: { id: runnerId }, select: { minor: true } }))?.minor ?? 0;
  return canSendFiles(minor);
};

/** The rows the box gets: the task's sent files, each with a blob and a place (the spec's `files`, a steer's). */
const specFileWhere = (taskId: TaskId) => ({ taskId, state: "sent" as const, blobId: { not: null }, boxPath: { not: null } });

/**
 * A sent message's files as its steer carries them, read back from their rows by the message's
 * number: for a message steered after it was written (a held turn's, released by its budget,
 * F-037). The images are those its send decided on (`asImage`). A file whose blob is gone is left
 * out, as the spec leaves it out.
 */
export const steerFilesOfMessageInTx = async (tx: Pick<Tx, "messageFile">, taskId: TaskId, eventSeq: number): Promise<BoundMessageFiles["steer"]> => {
  const rows = await tx.messageFile.findMany({
    where: { ...specFileWhere(taskId), eventSeq },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { ...uploadSelect, boxPath: true, asImage: true },
  });
  const files = rows.flatMap((row) => {
    const file = row.boxPath === null ? null : boxFileOf(row, row.boxPath);
    return file === null ? [] : [file];
  });
  const images = rows.filter((row) => row.asImage && files.some((file) => file.fileId === row.id)).map((row) => messageFileIdSchema.parse(row.id));
  return { files, images: images.slice(0, runnerLimits.promptImagesMax) };
};

// ---------- the spec ----------

/**
 * Whether the spec of the task carries files (`taskSpecFilesOf`): a task with one goes only to a
 * runner at protocol minor 8 (ADR 0070, Q340), since an older one would never write them into the
 * box. The dispatch reads it before it picks a runner, from the rows the spec reads.
 */
export const taskHasFilesInTx = async (tx: Pick<Tx, "messageFile">, taskId: TaskId): Promise<boolean> =>
  (await tx.messageFile.findFirst({ where: { ...specFileWhere(taskId), sha256: { not: null } }, select: { id: true } })) !== null;

/** How much a spec's `files` holds: the protocol's `taskFilesMax` and `taskFilesTotalBytes`, or smaller ones a test passes. */
export type TaskSpecFilesCaps = { readonly maxFiles: number; readonly maxBytes: number };

const taskSpecFilesCaps: TaskSpecFilesCaps = { maxFiles: runnerLimits.taskFilesMax, maxBytes: runnerLimits.taskFilesTotalBytes };

/** A file the spec carries, with its place in the task's log to put the list back in order. */
type ChosenSpecFile = { readonly seq: number; readonly position: number; readonly createdAt: number; readonly file: TaskSpecMessageFile };

const oldestFirst = (a: ChosenSpecFile, b: ChosenSpecFile): number => a.seq - b.seq || a.position - b.position || a.createdAt - b.createdAt;

/**
 * Every sent file of the task, for the spec's `files` (ADR 0070): oldest first (by its message,
 * then its place in it), each with its blob and its text's, within `taskFilesMax` and
 * `taskFilesTotalBytes`. When the task holds more, the newest stay (the lead, 2026-11-21): the
 * files of `keep` always (the first prompt's and every pending message's, so a reopen's own files
 * are written and named on a fresh box), then the others newest first, and the oldest past a cap
 * are left out. A file whose blob is gone is left out: the runner can't write it.
 */
export const taskSpecFilesOf = async (
  tx: Pick<Tx, "messageFile">,
  taskId: TaskId,
  options: { readonly keep?: ReadonlySet<string>; readonly caps?: TaskSpecFilesCaps } = {},
): Promise<readonly TaskSpecMessageFile[]> => {
  const caps = options.caps ?? taskSpecFilesCaps;
  const keep = [...(options.keep ?? [])];
  const select = { ...uploadSelect, boxPath: true, eventSeq: true, position: true, createdAt: true } as const;
  // Newest first each, the kept files before the others: a cap drops the oldest.
  const kept =
    keep.length === 0
      ? []
      : await tx.messageFile.findMany({
          where: { ...specFileWhere(taskId), id: { in: keep } },
          orderBy: [{ eventSeq: "desc" }, { position: "desc" }, { createdAt: "desc" }],
          select,
          take: caps.maxFiles,
        });
  const others = await tx.messageFile.findMany({
    where: { ...specFileWhere(taskId), ...(keep.length === 0 ? {} : { id: { notIn: keep } }) },
    orderBy: [{ eventSeq: "desc" }, { position: "desc" }, { createdAt: "desc" }],
    select,
    take: caps.maxFiles,
  });
  const chosen: ChosenSpecFile[] = [];
  let total = 0;
  for (const row of [...kept, ...others]) {
    if (chosen.length >= caps.maxFiles) {
      break;
    }
    const file = row.boxPath === null ? null : boxFileOf(row, row.boxPath);
    if (file === null) {
      continue;
    }
    const bytes = file.size + (file.text?.size ?? 0);
    if (total + bytes > caps.maxBytes) {
      break;
    }
    total += bytes;
    chosen.push({ seq: row.eventSeq ?? Number.MAX_SAFE_INTEGER, position: row.position ?? Number.MAX_SAFE_INTEGER, createdAt: row.createdAt.getTime(), file });
  }
  return chosen.sort(oldestFirst).map(({ file }) => file);
};

// ---------- a member's message with its files ----------

/** What a message's files are bound with: the uploads (or a ticket's files), and the session's model and agent. */
export type MessageFilesToBind = {
  readonly fileIds: readonly MessageFileId[];
  readonly model: ImageModel | null;
  readonly agentTakesImages: boolean;
  readonly limits: FileLimits;
  /** Ticket 06: a ticket's files core fetched (a ticket update's, a follow-up's), instead of uploads. */
  readonly ticket?: TicketFilesToBind | undefined;
};

/**
 * What a member's message binds its files with, from the session's model and agent profile; `null`
 * for a message without files.
 */
export const filesToBindInTx = async (
  tx: Pick<Tx, "model" | "agentProfile">,
  organizationId: OrganizationId,
  deps: MessageFilesDeps,
  input: { readonly fileIds: readonly MessageFileId[]; readonly modelId: string | null; readonly agentProfileId: string | null; readonly ticket?: TicketFilesToBind | undefined },
): Promise<MessageFilesToBind | null> => {
  const ticket = input.ticket === undefined || (input.ticket.stored.length === 0 && input.ticket.notes.length === 0) ? undefined : input.ticket;
  if (input.fileIds.length === 0 && ticket === undefined) {
    return null;
  }
  const model = input.modelId === null ? null : await tx.model.findFirst({ where: { id: input.modelId, organizationId }, select: { adminImageInput: true, catalogInputModalities: true } });
  const profile = input.agentProfileId === null ? null : await tx.agentProfile.findFirst({ where: { id: input.agentProfileId, organizationId }, select: { adapter: true } });
  return { fileIds: input.fileIds, model, agentTakesImages: profile !== null && deps.agentTakesImages(profile.adapter), limits: deps.limits, ...(ticket === undefined ? {} : { ticket }) };
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
  if (files === null || (files.fileIds.length === 0 && files.ticket === undefined)) {
    return { seq: await appendServerEvent(tx, { ...where, event }), bound: noBoundFiles };
  }
  let bound: BoundMessageFiles = noBoundFiles;
  const ticket = files.ticket;
  if (ticket !== undefined) {
    const numbered = await appendServerEventNumbered(tx, where, async (eventSeq) => {
      bound = await bindTicketFilesInTx(
        tx,
        { organizationId: where.organizationId, projectId: where.projectId, taskId: where.taskId, sessionId: where.sessionId, clientMessageId: event.clientMessageId, eventSeq, now: where.at },
        ticket,
        { model: files.model, agentTakesImages: files.agentTakesImages },
      );
      return { ...event, ...userMessageFileFields(bound) };
    });
    return { seq: numbered.seq, bound };
  }
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

// ---------- a ticket's files, bound to the message that gives them (ticket 06) ----------

/** Where a ticket's file was, and its source key (the SHA-256 of its URL): never the URL. */
export type TicketFileSource = {
  readonly where: "description" | "comment" | "attachment";
  readonly commentId: string | null;
  readonly sourceKey: string;
  /** The failed file a Retry fetched again. */
  readonly retryOfId?: MessageFileId | undefined;
  /**
   * Ticket 14: its place among the files of the read, in the ticket's order, so the thread lists
   * given, left-out and failed files where the ticket has them. Missing: after the stored ones.
   */
  readonly place?: number | undefined;
};

/** A ticket's file core fetched and stored as a blob of the task: what detection made of it, and its text. */
export type StoredTicketFile = TicketFileSource & {
  readonly name: SafeFileName;
  readonly kind: MessageFileKind;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: Sha256Hex;
  readonly blobId: BlobId;
  readonly text: UploadText;
};

/** A ticket's file that didn't come: left out (over a limit, not fetched) or failed (its download). */
export type TicketFileNote = TicketFileSource & {
  readonly name: SafeFileName;
  readonly state: "left_out" | "failed";
  readonly reason: FileLeftOutReason;
  /** The size the tracker said, when it said. */
  readonly size: number | null;
};

/** A ticket's files for one message: the stored ones, and the notes of those that didn't come. */
export type TicketFilesToBind = { readonly stored: readonly StoredTicketFile[]; readonly notes: readonly TicketFileNote[] };

/**
 * Writes a ticket's files as the message's (ADR 0070): each stored one `sent`, at `ticket/<name>`
 * unique in the task's ticket folder across its reads, its blobs the task's, and marked when it
 * goes to the model as an image; each note `left_out` or `failed` with its reason, so the thread
 * and a Retry find it. Origin `ticket`: no member's.
 */
export const bindTicketFilesInTx = async (
  tx: Tx,
  where: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly taskId: TaskId;
    readonly sessionId: SessionId;
    readonly clientMessageId: ClientMessageId;
    readonly eventSeq: TaskSeq;
    readonly now: number;
  },
  files: TicketFilesToBind,
  decision: { readonly model: ImageModel | null; readonly agentTakesImages: boolean },
): Promise<BoundMessageFiles> => {
  const taken = (await tx.messageFile.findMany({ where: { taskId: where.taskId, boxPath: { startsWith: "ticket/" } }, select: { boxPath: true } })).flatMap((row) =>
    row.boxPath === null ? [] : [row.boxPath.slice("ticket/".length)],
  );
  const places = boxPathFor("ticket", where.eventSeq, files.stored.map((file) => file.name), taken);
  const rows = await Promise.all(
    files.stored.map(async (file, position) => {
      const created = await tx.messageFile.create({
        data: {
          organizationId: where.organizationId,
          projectId: where.projectId,
          taskId: where.taskId,
          origin: "ticket",
          state: "sent",
          sessionId: where.sessionId,
          clientMessageId: where.clientMessageId,
          eventSeq: where.eventSeq,
          position: file.place ?? position,
          name: file.name,
          kind: file.kind,
          contentType: file.contentType,
          size: file.size,
          sha256: file.sha256,
          blobId: file.blobId,
          boxPath: places[position] ?? "",
          textState: file.text.state,
          ...(file.text.state === "ready" ? { textBlobId: file.text.blobId, textWords: file.text.words, textTruncated: file.text.truncated } : {}),
          ...(file.text.state === "failed" ? { textReason: file.text.reason } : {}),
          ticketWhere: file.where,
          ticketCommentId: file.commentId,
          ticketSourceKey: file.sourceKey,
          retryOfId: file.retryOfId ?? null,
          sentAt: new Date(where.now),
        },
        select: { id: true },
      });
      const blobIds = [file.blobId, ...(file.text.state === "ready" ? [file.text.blobId] : [])];
      await tx.blob.updateMany({ where: { id: { in: blobIds }, organizationId: where.organizationId }, data: { projectId: where.projectId, taskId: where.taskId } });
      return { id: messageFileIdSchema.parse(created.id), file };
    }),
  );
  for (const [index, note] of files.notes.entries()) {
    await tx.messageFile.create({
      data: {
        organizationId: where.organizationId,
        projectId: where.projectId,
        taskId: where.taskId,
        origin: "ticket",
        state: note.state,
        reason: note.reason,
        sessionId: where.sessionId,
        clientMessageId: where.clientMessageId,
        eventSeq: where.eventSeq,
        position: note.place ?? files.stored.length + index,
        name: note.name,
        kind: "file",
        contentType: "application/octet-stream",
        size: note.size ?? 0,
        ticketWhere: note.where,
        ticketCommentId: note.commentId,
        ticketSourceKey: note.sourceKey,
        retryOfId: note.retryOfId ?? null,
      },
    });
  }
  const decided = promptImagesFor(
    rows.map((row) => ({ fileId: row.id, kind: row.file.kind, contentType: row.file.contentType, size: row.file.size })),
    { agentTakesImages: decision.agentTakesImages, modelImageInput: decision.model === null ? "unknown" : modelImageInput(decision.model) },
  );
  const asImage = new Set<string>(decided.images);
  if (decided.images.length > 0) {
    await tx.messageFile.updateMany({ where: { id: { in: [...decided.images] } }, data: { asImage: true } });
  }
  // As the box gets them, read back with their text blobs' sizes and digests, in the message's order.
  const written = rows.length === 0 ? [] : await tx.messageFile.findMany({ where: { id: { in: rows.map((row) => row.id) } }, orderBy: { position: "asc" }, select: { ...uploadSelect, boxPath: true } });
  const allBoxFiles = written.flatMap((row) => {
    const file = row.boxPath === null ? null : boxFileOf(row, row.boxPath);
    return file === null ? [] : [file];
  });
  return {
    files: rows.map((row) => ({
      fileId: row.id,
      name: row.file.name,
      kind: row.file.kind,
      contentType: row.file.contentType,
      size: row.file.size,
      origin: "ticket",
      asImage: asImage.has(row.id),
      text: row.file.text.state,
      ...textFactsOf(
        row.file.text.state === "ready"
          ? { state: "ready", words: row.file.text.words, reason: null }
          : { state: row.file.text.state, words: null, reason: row.file.text.state === "failed" ? row.file.text.reason : null },
      ),
    })),
    filesLeftOut: files.notes.slice(0, runnerLimits.fileNotesMax).map((note) => ({ name: note.name, reason: note.reason, ...(note.size === null ? {} : { size: note.size }) })),
    imagesNotSent: decided.notSent,
    steer: { files: allBoxFiles, images: decided.images.filter((id) => allBoxFiles.some((file) => file.fileId === id)) },
  };
};
