import type { FileLimits } from "@ostra/domain/file-limits";
import type { FileLeftOutReason, FileSkipReason, ImagesNotSent } from "@ostra/protocol";
import type { MessageFileView } from "@ostra/task-view";

import { formatCount } from "@/lib/format";
import { plural, t } from "@/lib/messages";

import { bytesText } from "./attachment-words";

// One look for a file everywhere (app-targets/m9/README.md, "Rules"; F-148, F-150): the type's
// icon, the name cut in the middle so its extension stays, and `DOCX · 48 KB`, the same in the
// message box's tray, under a member's message and in a ticket's context. Pure, so the tray, the
// thread and their tests read one place.

/** Which type icon a file shows (composer-attachments.md, "The tray"): by its name's extension. */
export type FileLook = "text" | "spreadsheet" | "code" | "archive" | "video" | "mail" | "file";

const looks: readonly (readonly [Exclude<FileLook, "file">, readonly string[]])[] = [
  ["text", ["docx", "doc", "pdf", "md", "txt", "rtf", "odt", "pptx", "ppt", "odp"]],
  ["spreadsheet", ["csv", "xlsx", "xls", "ods", "tsv"]],
  ["code", ["log", "json", "har", "yaml", "yml", "sql", "xml", "html", "css", "js", "jsx", "ts", "tsx", "py", "go", "rs", "java", "rb", "php", "sh", "c", "h", "cpp", "cs", "kt", "swift", "toml", "ini"]],
  ["archive", ["zip", "gz", "tgz", "7z", "tar", "rar", "bz2", "xz"]],
  ["video", ["mp4", "mov", "webm", "mkv", "avi", "m4v"]],
  ["mail", ["eml", "msg"]],
];

/** A name's extension, lower case, without the dot: `spec.DOCX` is `docx`; none is `""`. */
export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase();
};

/** The icon a file's tile shows. */
export const fileLookOf = (name: string): FileLook => {
  const extension = extensionOf(name);
  return looks.find(([, extensions]) => extensions.includes(extension))?.[0] ?? "file";
};

/** A file's type as its chip says it: `DOCX`, `CSV`; `File` for a name with no extension. */
export const typeLabel = (name: string): string => {
  const extension = extensionOf(name);
  return extension === "" || extension.length > 6 ? t("task.files.typeNone") : extension.toUpperCase();
};

/** The longest name a tray's chip shows whole, and a thread's (its chip is wider). */
export const TRAY_NAME_CHARS = 24;
export const THREAD_NAME_CHARS = 34;

/**
 * A name cut in the middle so the extension stays (`history-pan…-spec.docx`): the start, `…`, the
 * stem's last five characters and the extension. A name that fits is whole.
 */
export const middleCut = (name: string, max: number): string => {
  if (name.length <= max) return name;
  const extension = extensionOf(name);
  const suffix = extension === "" ? "" : `.${name.slice(name.length - extension.length)}`;
  const stem = name.slice(0, name.length - suffix.length);
  const tail = stem.slice(-Math.min(5, Math.max(0, stem.length - 1)));
  const head = stem.slice(0, Math.max(1, max - suffix.length - tail.length - 1));
  return `${head}…${tail}${suffix}`;
};

/** A limit in whole megabytes, as the box words it: `10 MB`, `25 MB`; a part of one with a decimal. */
export const limitText = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? t("task.attachments.mb", { n: mb }) : bytesText(bytes);
};

/** A size in a sentence: `48 MB`, `27.4 MB`, `212 KB`; a whole megabyte count drops its `.0`. */
export const roundSizeText = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return mb < 1 ? bytesText(bytes) : t("task.attachments.mb", { n: mb.toFixed(1).replace(/\.0$/, "") });
};

/** A chip's second line: `DOCX · 48 KB`. */
export const fileMeta = (name: string, size: number): string => `${typeLabel(name)} · ${bytesText(size)}`;

/**
 * A member's or a ticket's file as the thread draws it: what the `user.message` event recorded
 * (`UserMessageFile`), the panel's download route for it (`null` once its blob is gone), its text's
 * word count when core read one, and why core couldn't read a document's text (its reader's code,
 * for `no text`'s tooltip). The fold's and the API's own type (ticket 14), `MessageFileView`.
 */
export type ThreadFile = MessageFileView;

/** `text extracted`'s tooltip: what ostra read out of the file, and what the agent got. */
export const textExtractedTip = (file: Pick<ThreadFile, "name" | "textWords">, agent: string): string =>
  t("task.files.textTip", { n: formatCount(file.textWords ?? 0), agent, type: typeLabel(file.name) });

/** Why core couldn't read a document's text, from its reader's code (spec section 5.3, `extractText`). */
export const textReasonText = (reason: string | null): string => {
  switch (reason) {
    case "encrypted":
      return t("task.files.textReason.encrypted");
    case "damaged":
      return t("task.files.textReason.damaged");
    case "too-big":
      return t("task.files.textReason.tooBig");
    case "too-many-parts":
      return t("task.files.textReason.tooManyParts");
    case "doctype":
      return t("task.files.textReason.doctype");
    case "timeout":
      return t("task.files.textReason.timeout");
    case "no-text":
      return t("task.files.textReason.noText");
    case "busy":
      return t("task.files.textReason.busy");
    case null:
    default:
      return t("task.files.textReason.other");
  }
};

/** The tooltip of a document whose text core couldn't read: why, and that the agent got the file alone. */
export const textFailedTip = (reason: string | null, agent: string): string => t("task.files.textFailedTip", { reason: textReasonText(reason), agent });

/** A chip's link name for a screen reader: `Download spec.docx, DOCX, 48 KB, text extracted`. */
export const chipName = (file: Pick<ThreadFile, "name" | "size" | "text">): string =>
  file.text === "ready"
    ? t("task.files.downloadExtracted", { name: file.name, type: typeLabel(file.name), size: bytesText(file.size) })
    : t("task.files.download", { name: file.name, type: typeLabel(file.name), size: bytesText(file.size) });

/** The properties panel's and the new task's count of files: `2 images · 3 files`. */
export const peopleText = (images: number, files: number): string =>
  [images === 0 ? null : plural(images, "task.files.imagesOne", "task.files.images"), files === 0 ? null : plural(files, "task.files.filesOne", "task.files.files")]
    .filter((part) => part !== null)
    .join(" · ");

/** The most thumbnails before a `+n` tile, as milestone 8's strip. */
export const STRIP_MAX = 6;

/** The strip's thumbnails: all of up to six, else the first five and how many more. */
export const stripOf = <T>(images: readonly T[]): { readonly shown: readonly T[]; readonly more: number } =>
  images.length > STRIP_MAX ? { shown: images.slice(0, STRIP_MAX - 1), more: images.length - (STRIP_MAX - 1) } : { shown: images, more: 0 };

/**
 * Whose pictures the viewer shows (message-attachments.md, "The viewer"): the agent's captures,
 * a member's message's, the ticket's, or the tray's before they're sent. Its title differs.
 */
export type ViewerSource = "capture" | "message" | "ticket" | "unsent";

export const viewerTitle = (source: ViewerSource): string => {
  switch (source) {
    case "capture":
      return t("task.attachments.viewerTitle");
    case "message":
      return t("task.files.viewerTitle");
    case "ticket":
      return t("task.files.viewerTicketTitle");
    case "unsent":
      return t("task.files.viewerUnsentTitle");
    default:
      return source satisfies never;
  }
};

/** The line under a message whose images went as files: the model can't see them, or the agent takes none. */
export const imagesNotSentText = (notSent: ImagesNotSent, names: { readonly model: string; readonly agent: string }): string => {
  switch (notSent) {
    case "model":
      return t("task.files.modelNoImages", { model: names.model, agent: names.agent });
    case "agent":
      return t("task.files.agentNoImages", { agent: names.agent });
    default:
      return notSent satisfies never;
  }
};

/** The viewer's `Agent got`: the image, or a file and why. */
export const agentGotText = (asImage: boolean, notSent: ImagesNotSent | null, agent: string): string => {
  if (asImage) return t("task.files.gotImage");
  switch (notSent) {
    case "model":
      return t("task.files.gotFileModel");
    case "agent":
      return t("task.files.gotFileAgent", { agent });
    case null:
      return t("task.files.gotFile");
    default:
      return notSent satisfies never;
  }
};

/** Where a file was left out of: a member's message, or a read of the ticket. Their limits word differently. */
export type LeftOutScope = "message" | "ticket";

/** Why a file was left out, after its name: `84 MB, over the 10 MB a file can be`. */
export const leftOutText = (note: { readonly reason: FileLeftOutReason; readonly size: number | null }, scope: LeftOutScope, limits: FileLimits, tracker: string): string => {
  const sized = (words: string) => (note.size === null ? words : t("task.files.leftOut.sized", { size: roundSizeText(note.size), words }));
  switch (note.reason) {
    case "too-big":
      return sized(t("task.files.leftOut.tooBig", { max: limitText(limits.maxFileBytes) }));
    case "too-many":
      return scope === "ticket" ? t("task.files.leftOut.tooManyTicket", { max: limits.maxFiles }) : t("task.files.leftOut.tooManyMessage", { max: limits.maxFiles });
    case "total-too-big":
      return sized(scope === "ticket" ? t("task.files.leftOut.tooMuchTicket", { max: limitText(limits.maxTotalBytes) }) : t("task.files.leftOut.tooMuchMessage", { max: limitText(limits.maxTotalBytes) }));
    case "unreadable":
      return t("task.files.leftOut.unreadable");
    case "download-failed":
      return t("task.files.leftOut.downloadFailed", { tracker });
    case "not-fetched":
      return t("task.files.leftOut.notFetched", { tracker });
    default:
      return note.reason satisfies never;
  }
};

/** Why the runner didn't save a file in the box (`files.written`'s skips), after its name. */
export const skippedText = (reason: FileSkipReason): string => {
  switch (reason) {
    case "download-failed":
      return t("task.files.skipped.downloadFailed");
    case "digest-mismatch":
      return t("task.files.skipped.digestMismatch");
    case "write-failed":
      return t("task.files.skipped.writeFailed");
    case "path-refused":
      return t("task.files.skipped.pathRefused");
    default:
      return reason satisfies never;
  }
};
