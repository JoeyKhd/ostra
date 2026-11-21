import { z } from "zod";

import { blobIdSchema, messageFileIdSchema } from "../ids.ts";
import { epochMsSchema, httpUrlSchema } from "../common.ts";
import { utf8ByteLength } from "../json.ts";
import { contentTypeSchema, sha256HexSchema } from "../runner/blobs.ts";
import { runnerLimits } from "../runner/limits.ts";

// Files for the agent (milestone 9, protocol minor 8, ADR 0070, F-148, F-149, F-150): a member's
// files in a message and a ticket's files, each written by the runner under the workspace's root,
// outside every repo, at a place core names, with a document's text beside it. A leaf module: the
// task spec, the events, the commands and the fixed words import it, and it imports none of them.
//
// A file's name, its content and its text are the member's or the ticket's data: never logged,
// never in a shell command, a process's arguments or a URL ostra builds. Its name is made safe
// (`safeFileName`) before it touches a disk or a prompt.

/** The folder under the workspace's root that holds every file for the agent: outside every repo. */
export const FILES_ROOT_DIR = ".ostra";

/** The folder under `FILES_ROOT_DIR` a message's files go to, one folder per message: `attachments/<n>/`. */
export const MESSAGE_FILES_FOLDER = "attachments";

/** The folder under `FILES_ROOT_DIR` a ticket's files go to: `ticket/`. */
export const TICKET_FILES_FOLDER = "ticket";

/** What a document's text adds to its file's path: `spec.docx` has its text in `spec.docx.md`. */
export const FILE_TEXT_SUFFIX = ".md";

// ---------- a safe name ----------

/** The longest name a file may have in the box, in characters. */
export const SAFE_FILE_NAME_MAX_CHARS = 124;

/**
 * The longest name `safeFileName` makes (ADR 0070: 120), so a name made unique in its folder with
 * ` (n)` (`boxPathFor`) still fits `SAFE_FILE_NAME_MAX_CHARS`.
 */
export const SAFE_FILE_NAME_MADE_MAX_CHARS = 120;

/** The characters a safe name holds: ASCII letters, digits, spaces and `._-()`. */
const SAFE_CHARACTER = /^[A-Za-z0-9 ._()-]$/;
const SAFE_NAME = /^[A-Za-z0-9 ._()-]+$/;

/** An extension a name keeps: 1 to 10 letters or digits. */
const EXTENSION = /^[A-Za-z0-9]{1,10}$/;

/** Windows' reserved device names, which no file may take even with an extension (`CON.txt`). */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Whether a name's first part (before its first `.`, trailing spaces dropped) is one of Windows' reserved names. */
const isWindowsReserved = (name: string): boolean => WINDOWS_RESERVED.test((name.split(".")[0] ?? "").trimEnd());

/**
 * A file's name in the box (ADR 0070): ASCII letters, digits, spaces and `._-()`, 1 to 124
 * characters, never starting with `.` or a space, never ending with `.` or a space (which Windows
 * drops), and never one of Windows' reserved names (`CON`, `NUL`, `COM1` …, with or without an
 * extension). So it holds no separator, no `..`, no quote, no line break and nothing a shell
 * reads. Made by `safeFileName`. The member's or the ticket's: never logged.
 */
export const safeFileNameSchema = z
  .string()
  .min(1)
  .max(SAFE_FILE_NAME_MAX_CHARS)
  .regex(SAFE_NAME, "letters, digits, spaces and ._-()")
  .refine((name) => !name.startsWith(".") && !name.startsWith(" "), "no leading dot or space")
  .refine((name) => !name.endsWith(".") && !name.endsWith(" "), "no trailing dot or space")
  .refine((name) => !isWindowsReserved(name), "not one of Windows' reserved names")
  .describe("A file's safe name. Never logged.");
export type SafeFileName = z.infer<typeof safeFileNameSchema>;

/** Drops leading dots and spaces, and trailing ones. */
const trimName = (text: string): string => text.replace(/^[. ]+/, "").replace(/[. ]+$/, "");

/**
 * A safe name made from a member's or a tracker's name (ADR 0070), the same in core and in the
 * runner's check:
 * - only the last part of a path is kept (`../../etc/passwd` is `passwd`);
 * - accents are dropped (`Spécification` is `Specification`), and every other character outside
 *   `safeFileNameSchema`'s becomes `_`, a run of them one `_`;
 * - leading and trailing dots and spaces are dropped, and an empty name is `file`;
 * - the extension is kept when it's 1 to 10 letters or digits, else `fallbackExtension` (the
 *   detected kind's, such as `png`) is added, when given;
 * - a Windows reserved name gets a leading `_` (`CON.txt` is `_CON.txt`);
 * - at most `SAFE_FILE_NAME_MADE_MAX_CHARS`, cut in the name, never in the extension.
 */
export const safeFileName = (raw: string, fallbackExtension: string | null): SafeFileName => {
  const base = raw.split(/[/\\]/).filter((part) => part !== "").at(-1) ?? "";
  const plain = base.normalize("NFKD").replace(/\p{M}+/gu, "");
  const dot = plain.lastIndexOf(".");
  const ownExtension = dot > 0 ? plain.slice(dot + 1) : "";
  const keepsOwn = EXTENSION.test(ownExtension);
  const extension = keepsOwn ? ownExtension : fallbackExtension !== null && EXTENSION.test(fallbackExtension) ? fallbackExtension : "";
  const stemRaw = keepsOwn ? plain.slice(0, dot) : plain;
  let stem = "";
  let replaced = false;
  for (const char of stemRaw) {
    if (SAFE_CHARACTER.test(char)) {
      stem += char;
      replaced = false;
    } else if (!replaced) {
      stem += "_";
      replaced = true;
    }
  }
  stem = trimName(stem);
  if (stem === "") {
    stem = "file";
  }
  if (isWindowsReserved(stem)) {
    stem = `_${stem}`;
  }
  const suffix = extension === "" ? "" : `.${extension}`;
  stem = trimName(stem.slice(0, SAFE_FILE_NAME_MADE_MAX_CHARS - suffix.length));
  return safeFileNameSchema.parse(`${stem === "" ? "file" : stem}${suffix}`);
};

// ---------- a file's place in the box ----------

/** A file's place, as `fileBoxPathSchema` reads it: a message's folder by its number, or the ticket's. */
export type FileBoxPlace =
  | { readonly folder: typeof MESSAGE_FILES_FOLDER; readonly seq: number; readonly name: SafeFileName }
  | { readonly folder: typeof TICKET_FILES_FOLDER; readonly name: SafeFileName };

/** The number of a message's folder: its event's number in the task's log, from 1. */
const FOLDER_SEQ = /^[1-9][0-9]{0,15}$/;

/** Reads a file's path under `FILES_ROOT_DIR`, or `null` when it isn't one: no `..`, no separator in a name. */
export const parseFileBoxPath = (path: string): FileBoxPlace | null => {
  const parts = path.split("/");
  if (parts.length === 3 && parts[0] === MESSAGE_FILES_FOLDER) {
    const [, seqText = "", nameText = ""] = parts;
    const name = safeFileNameSchema.safeParse(nameText);
    const seq = Number(seqText);
    return FOLDER_SEQ.test(seqText) && Number.isSafeInteger(seq) && name.success ? { folder: MESSAGE_FILES_FOLDER, seq, name: name.data } : null;
  }
  if (parts.length === 2 && parts[0] === TICKET_FILES_FOLDER) {
    const name = safeFileNameSchema.safeParse(parts[1]);
    return name.success ? { folder: TICKET_FILES_FOLDER, name: name.data } : null;
  }
  return null;
};

/** A file's path from its place: `attachments/<n>/<name>` or `ticket/<name>`. */
export const fileBoxPathOf = (place: FileBoxPlace): string =>
  place.folder === MESSAGE_FILES_FOLDER ? `${MESSAGE_FILES_FOLDER}/${String(place.seq)}/${place.name}` : `${TICKET_FILES_FOLDER}/${place.name}`;

/**
 * A file's path under the workspace root's `FILES_ROOT_DIR` (ADR 0070): `attachments/<n>/<name>`
 * for a message's, where `<n>` is the message's number in the task's log, or `ticket/<name>` for a
 * ticket's. Each name a `safeFileNameSchema`, so no part is `..` and none holds a separator.
 * Never logged: it holds the file's name.
 */
export const fileBoxPathSchema = z
  .string()
  .min(1)
  .max(MESSAGE_FILES_FOLDER.length + 18 + SAFE_FILE_NAME_MAX_CHARS)
  .refine((path) => parseFileBoxPath(path) !== null, "attachments/<n>/<name> or ticket/<name>, each name a safe one")
  .describe("A file's place under .ostra/. Never logged: it holds the file's name.");
export type FileBoxPath = z.infer<typeof fileBoxPathSchema>;

/** A document's text's path: its file's, with `.md` added (`spec.docx` → `spec.docx.md`). */
export const fileTextPathOf = (path: string): string => `${path}${FILE_TEXT_SUFFIX}`;

/** A document's text's path under `FILES_ROOT_DIR`: a file's path with `.md` added. Never logged. */
export const fileTextPathSchema = z
  .string()
  .min(1)
  .max(MESSAGE_FILES_FOLDER.length + 18 + SAFE_FILE_NAME_MAX_CHARS + FILE_TEXT_SUFFIX.length)
  .refine((path) => path.endsWith(FILE_TEXT_SUFFIX) && parseFileBoxPath(path.slice(0, -FILE_TEXT_SUFFIX.length)) !== null, "a file's path with .md added")
  .describe("A document's text's place under .ostra/. Never logged.");

// ---------- the vocabularies ----------

/**
 * What a file is, told by core from its bytes, never its name or the browser's type (Q339): a
 * PNG, JPEG, GIF or WebP `image`; a PDF, `.docx`, `.xlsx` or `.pptx` `document`; UTF-8 `text`; and
 * any other `file` (an SVG, a HEIC, a video).
 */
export const messageFileKindSchema = z.enum(["image", "document", "text", "file"]);
export type MessageFileKind = z.infer<typeof messageFileKindSchema>;

/** The types an `image` has: the four a prompt can carry as an image (Q339). */
export const promptImageContentTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type PromptImageContentType = (typeof promptImageContentTypes)[number];

/** Whether a type is one a prompt can carry as an image. */
export const isPromptImageContentType = (contentType: string): contentType is PromptImageContentType =>
  promptImageContentTypes.some((type) => type === contentType);

/** Whose file it is: a member's, attached to a message, or a ticket's, fetched by core. */
export const messageFileOriginSchema = z.enum(["member", "ticket"]);
export type MessageFileOrigin = z.infer<typeof messageFileOriginSchema>;

/**
 * A file's text (F-150): `ready` beside it; `none` for a kind with no text to read (an image, a
 * text file, any other file); `failed` for a document core couldn't read (still attached); `off`
 * when the install reads no text (`OSTRA_FILE_TEXT_EXTRACTION=false`).
 */
export const fileTextStateSchema = z.enum(["ready", "none", "failed", "off"]);
export type FileTextState = z.infer<typeof fileTextStateSchema>;

/**
 * Why a file didn't reach the agent: over one file's limit, past the count, past the total,
 * unreadable, a ticket's file whose download failed, or a ticket's file not fetched (a tracker
 * whose `ticketFiles` leaves it out).
 */
export const fileLeftOutReasonSchema = z.enum(["too-big", "too-many", "total-too-big", "unreadable", "download-failed", "not-fetched"]);
export type FileLeftOutReason = z.infer<typeof fileLeftOutReasonSchema>;

/** Why a message's images went as files only: the model can't see images, or the agent takes none in its prompt. */
export const imagesNotSentSchema = z.enum(["model", "agent"]);
export type ImagesNotSent = z.infer<typeof imagesNotSentSchema>;

/** A model's input, as models.dev names it (ADR 0070, Q335), for the agent's config. */
export const inputModalitySchema = z.enum(["text", "image", "pdf", "audio", "video"]);
export type InputModality = z.infer<typeof inputModalitySchema>;

/** Whether each item of a list is there once. */
const eachOnce = (items: readonly unknown[]): boolean => new Set(items).size === items.length;

// ---------- a file for the box (the spec's `files`, a steer's `files`) ----------

/** A document's text, as a blob of the task beside its file. Never logged. */
export const taskSpecFileTextSchema = z.strictObject({
  blobId: blobIdSchema,
  size: z.number().int().nonnegative().max(runnerLimits.fileTextMaxBytes),
  sha256: sha256HexSchema,
  path: fileTextPathSchema,
});
export type TaskSpecFileText = z.infer<typeof taskSpecFileTextSchema>;

/**
 * A file the runner writes into the box (ADR 0070), at `FILES_ROOT_DIR/<path>` under the workspace's
 * root, checked against its size and SHA-256 from the bulk path, never executable; and its text
 * beside it at `<path>.md` when core read one. Named `taskSpecFileSchema` in the spec (section
 * 5.1): `taskSpecFileSchema` already names a repo's environment file (`spec.ts`), so this one is a
 * message file's. Its name, content and text are never logged.
 */
export const taskSpecMessageFileSchema = z
  .strictObject({
    fileId: messageFileIdSchema,
    blobId: blobIdSchema,
    size: z.number().int().nonnegative().max(runnerLimits.messageFileMaxBytes),
    sha256: sha256HexSchema,
    kind: messageFileKindSchema,
    /** The type core detected from the bytes. An `image`'s is one of `promptImageContentTypes`. */
    contentType: contentTypeSchema,
    path: fileBoxPathSchema,
    text: taskSpecFileTextSchema.nullable(),
  })
  .refine((file) => file.kind !== "image" || isPromptImageContentType(file.contentType), "an image is a PNG, JPEG, GIF or WebP")
  .refine((file) => file.text === null || file.text.path === fileTextPathOf(file.path), "a text's path is its file's with .md added")
  .describe("A file for the box. Its name, its content and its text are never logged.");
export type TaskSpecMessageFile = z.infer<typeof taskSpecMessageFileSchema>;

/** The files of one message as the box gets them: at most a ticket read's count, each once by its ID and its place. */
export const messageBoxFilesSchema = z
  .array(taskSpecMessageFileSchema)
  .min(1)
  .max(runnerLimits.ticketContextFilesMax)
  .refine((files) => eachOnce(files.map((file) => file.fileId)), "each file once")
  .refine((files) => eachOnce(files.map((file) => file.path)), "each place once");

/**
 * A prompt's files (ADR 0070): the message's files in its order, as IDs of the spec's `files`, and
 * those that go to the model as images too (a subset, at most `promptImagesMax`, each an image).
 * The runner names every one in `messageFilesBlock` and sends the images as ACP `image` blocks.
 */
export const promptFilesSchema = z
  .strictObject({
    fileIds: z.array(messageFileIdSchema).min(1).max(runnerLimits.ticketContextFilesMax),
    images: z.array(messageFileIdSchema).max(runnerLimits.promptImagesMax),
  })
  .refine((files) => eachOnce(files.fileIds) && eachOnce(files.images), "each file once")
  .refine((files) => files.images.every((id) => files.fileIds.includes(id)), "an image is one of the prompt's files");
export type PromptFiles = z.infer<typeof promptFilesSchema>;

// ---------- a message's files, as the thread shows them (`user.message`) ----------

/**
 * One file of a member's message, as the `user.message` event records it for the thread: its safe
 * name (never the raw one), kind, detected type, size, whose it is, whether it went as an image,
 * and its text's state. Never logged.
 */
export const userMessageFileSchema = z
  .strictObject({
    fileId: messageFileIdSchema,
    name: safeFileNameSchema,
    kind: messageFileKindSchema,
    contentType: contentTypeSchema,
    size: z.number().int().nonnegative().max(runnerLimits.messageFileMaxBytes),
    origin: messageFileOriginSchema,
    asImage: z.boolean(),
    text: fileTextStateSchema,
  })
  .describe("A message's file. Its name is never logged.");
export type UserMessageFile = z.infer<typeof userMessageFileSchema>;

/** A file left out of a message or a ticket's read, by its safe name, with why. Never logged. */
export const fileLeftOutSchema = z
  .strictObject({ name: safeFileNameSchema, reason: fileLeftOutReasonSchema })
  .describe("A file left out. Its name is never logged.");
export type FileLeftOut = z.infer<typeof fileLeftOutSchema>;

/** A message's left-out or failed files: at most `fileNotesMax` named. */
export const fileNotesSchema = z.array(fileLeftOutSchema).max(runnerLimits.fileNotesMax);

// ---------- one read of a ticket (`ticket.context_read`, F-149) ----------

/**
 * Why ostra read the ticket for the task: the task's start, a reopen, a member's "Send ticket
 * updates", or a Retry of its failed files.
 */
export const ticketReadReasonSchema = z.enum(["start", "reopen", "member", "retry"]);
export type TicketReadReason = z.infer<typeof ticketReadReasonSchema>;

/** Text within a number of UTF-8 bytes. */
const textWithinBytes = (maxBytes: number) =>
  z
    .string()
    .max(maxBytes)
    .refine((text) => utf8ByteLength(text) <= maxBytes, `at most ${String(maxBytes)} bytes`);

/** A comment of the ticket the agent got: its author's name, when, its body, and whether it was edited. Never logged. */
export const ticketContextCommentSchema = z.strictObject({
  author: z.string().min(1).max(200),
  at: epochMsSchema,
  body: textWithinBytes(runnerLimits.ticketCommentMaxBytes),
  edited: z.boolean(),
});
export type TicketContextComment = z.infer<typeof ticketContextCommentSchema>;

/** A link of the ticket (a PR, a Figma frame): its title and URL, given and never fetched (Q337). Never logged. */
export const ticketContextLinkSchema = z.strictObject({
  title: z.string().max(1024),
  url: httpUrlSchema,
});
export type TicketContextLink = z.infer<typeof ticketContextLinkSchema>;

/**
 * What one read of the ticket gave the agent (F-149), for the thread's "What the agent got": the
 * round (1 at the start), why, the description (`null` when it didn't change since the last
 * round), the comments, the links, the files given, and those left out and failed. Every string is
 * the ticket's: never logged.
 */
export const ticketContextReadSchema = z.strictObject({
  round: z.number().int().positive(),
  reason: ticketReadReasonSchema,
  description: textWithinBytes(runnerLimits.ticketDescriptionMaxBytes).nullable(),
  comments: z.array(ticketContextCommentSchema).max(runnerLimits.ticketCommentsMax),
  links: z.array(ticketContextLinkSchema).max(runnerLimits.ticketLinksMax),
  files: z.array(messageFileIdSchema).max(runnerLimits.ticketContextFilesMax),
  leftOut: fileNotesSchema,
  failed: fileNotesSchema,
});
export type TicketContextRead = z.infer<typeof ticketContextReadSchema>;

// ---------- what the runner wrote (`files.written`) ----------

/** Why the runner didn't write a file: the bulk path didn't give it, its bytes didn't match, the write failed, or its path was refused. */
export const fileSkipReasonSchema = z.enum(["download-failed", "digest-mismatch", "write-failed", "path-refused"]);
export type FileSkipReason = z.infer<typeof fileSkipReasonSchema>;

/** Why a prompt's images went as files although core marked them as images: the agent didn't advertise `promptCapabilities.image`. */
export const imagesAsFilesReasonSchema = z.enum(["agent-did-not-advertise"]);
export type ImagesAsFilesReason = z.infer<typeof imagesAsFilesReasonSchema>;
