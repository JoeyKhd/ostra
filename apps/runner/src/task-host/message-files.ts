import { placeBoxFile, readBoxFile } from "@ostra/adapter-sdk";
import type { AgentPromptImage, AgentPromptInput, Logger } from "@ostra/adapter-sdk";
import { isPromptImageContentType, messageFilesBlock, parseFileBoxPath, runnerLimits, safeFileName, taskSpecMessageFileSchema, TICKET_FILES_FOLDER } from "@ostra/protocol";
import type {
  BlobId,
  FileNotSaved,
  FileSkipReason,
  ImagesAsFilesReason,
  ImagesNotSent,
  LeaseEpoch,
  MessageFileId,
  MessageFileOrigin,
  MessageFilesBlockFile,
  TaskEventOf,
  TaskId,
  TaskSpecMessageFile,
} from "@ostra/protocol";
import { sha256Of } from "../server/bulk.ts";
import type { ServerLink } from "./server-link.ts";

// A message's files in the box, and the prompt that names them (milestone 9, ticket 13, ADR 0070,
// F-148, F-149, F-150). Before a session starts, every file of the spec's `files`, and before a
// message reaches the agent, its own files, are written under the workspace root's `.ostra/` at the
// place core named (`attachments/<n>/<name>`, `ticket/<name>`), with a document's text beside it
// (`<name>.md`), outside every repo: downloaded on the bulk path and checked against the size and
// SHA-256 the spec names (a copy that differs is never written), the place checked again with the
// protocol's schemas and resolved inside `.ostra/` (`placeBoxFile`). The same code on `docker`,
// `kubernetes` and `host`, as the ticket's files (`ticket-files.ts`). A file a kept box still holds
// with its bytes isn't downloaded or written again.
//
// The prompt is the message's text, then `messageFilesBlock` with each file's absolute path as the
// agent sees it, then the images core marked, as images, when the session takes them
// (`AgentAdapter.promptsImages`); otherwise the block says they're files only, and `files.written`
// says why. A file that fails is skipped and named in the block; the turn starts anyway.
//
// A file's name, its content and its text are the member's or the ticket's data: never logged.
// Log lines carry IDs, counts and reasons only.

/** A message's files as its prompt names them: IDs of files the run knows, in the message's order, and those core marked to go as images. */
export type PromptMessageFiles = { readonly fileIds: readonly MessageFileId[]; readonly images: readonly MessageFileId[] };

/** One message of a turn's prompt: its text, and its files. Never logged. */
export type PromptMessage = { readonly text: string; readonly files: PromptMessageFiles | null };

/** How one file went into the box. */
export type FileOutcome = { readonly kind: "written"; readonly textWritten: boolean } | { readonly kind: "skipped"; readonly reason: FileSkipReason };

export type FilesWritten = TaskEventOf<"files.written">;

/** A turn's prompt with its files: what the agent gets, and the `files.written` to send, `null` when no message carried files. */
export type BuiltPrompt = { readonly input: AgentPromptInput; readonly written: FilesWritten | null };

export type PromptInput = {
  /** The box's workspace root, as the runner's process and the agent's both read it. */
  readonly workspaceDir: string;
  readonly messages: readonly PromptMessage[];
  /** The session carries images to the model (`AgentAdapter.promptsImages`): the adapter, the agent's advertisement and the model all take them. */
  readonly sessionTakesImages: boolean;
  /** The task's model takes images (the spec's `agent.inputModalities`). */
  readonly modelTakesImages: boolean;
};

export type MessageFiles = {
  /** Files a prompt may name by ID from now on: the spec's, a steer's. */
  readonly learn: (files: readonly TaskSpecMessageFile[]) => void;
  /** Writes each file and its text into the box, one at a time; each once, by its ID. */
  readonly place: (workspaceDir: string, files: readonly TaskSpecMessageFile[]) => Promise<ReadonlyMap<MessageFileId, FileOutcome>>;
  /** A turn's prompt, or a steer's, from its messages: their files written first, then the text, the blocks and the images. */
  readonly prompt: (input: PromptInput) => Promise<BuiltPrompt>;
};

export type MessageFilesDeps = {
  readonly link: Pick<ServerLink, "downloadBlob">;
  readonly taskId: TaskId;
  readonly leaseEpoch: LeaseEpoch;
  readonly logger: Logger;
};

/** The texts of a turn's messages, one after another, as the runner joins messages queued while a turn ran. */
const joinTexts = (texts: readonly string[]): string => texts.filter((text) => text !== "").join("\n\n");

/** `files.written` from what happened to each file. File IDs and reasons only: never a name. */
export const filesWrittenOf = (outcomes: ReadonlyMap<MessageFileId, FileOutcome>, imagesSent: number, imagesAsFiles: ImagesAsFilesReason | null): FilesWritten => {
  const files: FilesWritten["files"][number][] = [];
  const skipped: FilesWritten["skipped"][number][] = [];
  for (const [fileId, outcome] of outcomes) {
    if (outcome.kind === "written") {
      files.push({ fileId, textWritten: outcome.textWritten });
    } else {
      skipped.push({ fileId, reason: outcome.reason });
    }
  }
  return {
    kind: "files.written",
    files: files.slice(0, runnerLimits.taskFilesMax),
    skipped: skipped.slice(0, runnerLimits.taskFilesMax),
    imagesSent: Math.min(imagesSent, runnerLimits.promptImagesMax),
    imagesAsFiles,
  };
};

export const createMessageFiles = (deps: MessageFilesDeps): MessageFiles => {
  const known = new Map<MessageFileId, TaskSpecMessageFile>();
  const log = deps.logger;

  /** One blob at its place: there already with its bytes, or downloaded, checked and written. */
  const ensure = async (
    workspaceDir: string,
    blob: { readonly blobId: BlobId; readonly size: number; readonly sha256: string; readonly place: string },
    maxBytes: number,
  ): Promise<FileSkipReason | null> => {
    if ((await readBoxFile({ workspaceDir, place: blob.place, size: blob.size, sha256: blob.sha256 })) !== null) {
      return null;
    }
    const downloaded = await deps.link.downloadBlob({ taskId: deps.taskId, leaseEpoch: deps.leaseEpoch, blobId: blob.blobId, maxBytes: Math.min(blob.size, maxBytes) });
    if (!downloaded.ok) {
      return "download-failed";
    }
    const { bytes, sha256: named } = downloaded.value;
    // The size and digest the spec names, and the digest core named for what it sent: a copy that differs is never written.
    if (bytes.length !== blob.size || sha256Of(bytes) !== blob.sha256 || (named !== null && named !== blob.sha256)) {
      return "digest-mismatch";
    }
    const placed = await placeBoxFile({ workspaceDir, place: blob.place, bytes });
    switch (placed) {
      case "written":
      case "present":
        return null;
      case "path-refused":
      case "write-failed":
        return placed;
      default:
        return placed satisfies never;
    }
  };

  const placeOne = async (workspaceDir: string, file: TaskSpecMessageFile): Promise<FileOutcome> => {
    // The place, and the file's whole shape, checked again with the protocol's schemas.
    if (!taskSpecMessageFileSchema.safeParse(file).success) {
      return { kind: "skipped", reason: "path-refused" };
    }
    const failed = await ensure(workspaceDir, { blobId: file.blobId, size: file.size, sha256: file.sha256, place: file.path }, runnerLimits.messageFileMaxBytes);
    if (failed !== null) {
      return { kind: "skipped", reason: failed };
    }
    if (file.text === null) {
      return { kind: "written", textWritten: false };
    }
    const textFailed = await ensure(workspaceDir, { blobId: file.text.blobId, size: file.text.size, sha256: file.text.sha256, place: file.text.path }, runnerLimits.fileTextMaxBytes);
    if (textFailed !== null) {
      log.warn("a message file's text wasn't written", { fileId: file.fileId, reason: textFailed });
    }
    return { kind: "written", textWritten: textFailed === null };
  };

  const place = async (workspaceDir: string, files: readonly TaskSpecMessageFile[]): Promise<ReadonlyMap<MessageFileId, FileOutcome>> => {
    const outcomes = new Map<MessageFileId, FileOutcome>();
    for (const file of files) {
      if (outcomes.has(file.fileId)) {
        continue;
      }
      known.set(file.fileId, file);
      const outcome = await placeOne(workspaceDir, file);
      if (outcome.kind === "skipped") {
        log.warn("a message file was skipped", { fileId: file.fileId, reason: outcome.reason });
      }
      outcomes.set(file.fileId, outcome);
    }
    const written = [...outcomes.values()].filter((outcome) => outcome.kind === "written");
    log.info("message files in the box", {
      files: outcomes.size,
      written: written.length,
      texts: written.filter((outcome) => outcome.textWritten).length,
      skipped: outcomes.size - written.length,
    });
    return outcomes;
  };

  /** A file's name as the block names one it couldn't save: its safe name, from its place. */
  const nameOf = (file: TaskSpecMessageFile): FileNotSaved["name"] => parseFileBoxPath(file.path)?.name ?? safeFileName("file", null);

  const originOf = (file: TaskSpecMessageFile): MessageFileOrigin => (parseFileBoxPath(file.path)?.folder === TICKET_FILES_FOLDER ? "ticket" : "member");

  const prompt = async (input: PromptInput): Promise<BuiltPrompt> => {
    const filesOf = (message: PromptMessage): readonly TaskSpecMessageFile[] =>
      (message.files?.fileIds ?? []).flatMap((id) => {
        const file = known.get(id);
        return file === undefined ? [] : [file];
      });
    const named = input.messages.flatMap((message) => message.files?.fileIds ?? []);
    if (named.length === 0) {
      return { input: { text: joinTexts(input.messages.map((message) => message.text)), images: [] }, written: null };
    }
    const unknown = named.filter((id) => !known.has(id)).length;
    if (unknown > 0) {
      log.warn("a message named files the runner doesn't know: left out", { unknown });
    }
    // The images core marked: each a PNG, JPEG, GIF or WebP within the limit, at most `promptImagesMax` in the prompt.
    const marked: TaskSpecMessageFile[] = [];
    for (const message of input.messages) {
      for (const id of message.files?.images ?? []) {
        const file = known.get(id);
        if (file?.kind === "image" && isPromptImageContentType(file.contentType) && file.size <= runnerLimits.promptImageMaxBytes && !marked.includes(file)) {
          marked.push(file);
        }
      }
    }
    const outcomes = await place(input.workspaceDir, input.messages.flatMap(filesOf));
    // Each image read back from the box as written, checked against its digest: what the agent gets is what the spec names.
    const images: AgentPromptImage[] = [];
    const asImages = new Set<MessageFileId>();
    if (input.sessionTakesImages) {
      for (const file of marked.slice(0, runnerLimits.promptImagesMax)) {
        const mimeType = file.contentType;
        if (outcomes.get(file.fileId)?.kind !== "written" || !isPromptImageContentType(mimeType)) {
          continue;
        }
        const bytes = await readBoxFile({ workspaceDir: input.workspaceDir, place: file.path, size: file.size, sha256: file.sha256 });
        if (bytes !== null) {
          images.push({ mimeType, bytes, name: nameOf(file) });
          asImages.add(file.fileId);
        }
      }
    }
    // Why an image went as a file only: the model can't see images, or the agent takes none in its prompt.
    const imagesNotSent: ImagesNotSent | null = !input.modelTakesImages ? "model" : !input.sessionTakesImages ? "agent" : null;
    const root = input.workspaceDir.replaceAll("\\", "/");
    const blocksOf = (message: PromptMessage): string[] =>
      (["member", "ticket"] as const).map((origin) => {
        const files: MessageFilesBlockFile[] = [];
        const notSaved: FileNotSaved[] = [];
        for (const file of filesOf(message).filter((each) => originOf(each) === origin)) {
          const outcome = outcomes.get(file.fileId);
          if (outcome?.kind === "written") {
            const textPath = outcome.textWritten && file.text !== null ? file.text.path : null;
            files.push({ path: file.path, kind: file.kind, contentType: file.contentType, size: file.size, textPath, asImage: asImages.has(file.fileId) });
          } else if (outcome !== undefined) {
            notSaved.push({ name: nameOf(file), reason: outcome.reason });
          }
        }
        const imageAsFile = files.some((file) => file.kind === "image" && !file.asImage);
        return messageFilesBlock({ root, files, leftOut: [], imagesNotSent: imageAsFile ? imagesNotSent : null, origin, notSaved });
      });
    const text = joinTexts(input.messages.map((message) => (message.files === null ? message.text : joinTexts([message.text, ...blocksOf(message)]))));
    // Core marked images the session can't carry, although the model takes them: the agent's side refused.
    const markedAsFiles = !input.sessionTakesImages && input.modelTakesImages && marked.some((file) => outcomes.get(file.fileId)?.kind === "written");
    const written = filesWrittenOf(outcomes, images.length, markedAsFiles ? "agent-did-not-advertise" : null);
    log.info("a prompt's files", { files: outcomes.size, imagesSent: images.length, imagesAsFiles: written.imagesAsFiles });
    return { input: { text, images }, written };
  };

  return {
    learn: (files) => {
      for (const file of files) {
        known.set(file.fileId, file);
      }
    },
    place,
    prompt,
  };
};
