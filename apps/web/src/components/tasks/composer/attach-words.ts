import { checkMessageFiles } from "@ostra/domain/file-limits";
import type { FileLimits } from "@ostra/domain/file-limits";
import { isPromptImageContentType } from "@ostra/protocol";

import { bytesText } from "@/components/tasks/attachments/attachment-words";
import { limitText, roundSizeText } from "@/components/tasks/attachments/file-words";
import { plural, t } from "@/lib/messages";

// The message box's attachments (app-targets/m9/composer-attachments.md; F-148, ticket 15): what
// the tray takes as files arrive, what its note line and hint say, when Send waits, and which
// pastes and drags are files. Pure, so `use-attachments`, the tray and their tests read one place.
// The limits are the server's (`files.limits`), checked by the domain's own rule (`checkMessageFiles`),
// which the server runs again at send.

// ---------- what the tray takes ----------

/** A file arriving at the tray: its name, size, and whether it's a folder (a drop can hold one). */
export type Arrival = { readonly name: string; readonly size: number; readonly folder: boolean };

/**
 * Why a file didn't join the tray (composer-attachments.md, "Every state"): over one file's size,
 * past the count (several at once are one note), past the total, empty, or a folder.
 */
export type TrayRefusal =
  | { readonly kind: "too-big"; readonly name: string; readonly size: number; readonly max: number }
  | { readonly kind: "too-many"; readonly count: number; readonly max: number }
  | { readonly kind: "total-too-big"; readonly name: string; readonly total: number; readonly max: number }
  | { readonly kind: "empty"; readonly name: string }
  | { readonly kind: "folder"; readonly name: string };

/**
 * The files that join a tray holding `held`, in their order, and the refusal the note line shows:
 * a folder or an empty file first, then the limits as the server checks them (too big, then too
 * many, then past the total). The newest refusal wins; files past the count are counted as one.
 */
export const admitFiles = <F extends Arrival>(held: readonly { readonly size: number }[], arriving: readonly F[], limits: FileLimits): { readonly admitted: readonly F[]; readonly refusal: TrayRefusal | null } => {
  const refusals: TrayRefusal[] = [];
  const weighed: F[] = [];
  for (const file of arriving) {
    if (file.folder) refusals.push({ kind: "folder", name: file.name });
    else if (file.size === 0) refusals.push({ kind: "empty", name: file.name });
    else weighed.push(file);
  }
  const heldFiles = held.map((file, index) => ({ name: `held-${String(index)}`, size: file.size, held: true }));
  const checked = checkMessageFiles([...heldFiles, ...weighed.map((file) => ({ name: file.name, size: file.size, held: false, file }))], limits);
  const leftOut = new Map(checked.leftOut.flatMap((entry) => ("file" in entry.file ? [[entry.file.file, entry.reason] as const] : [])));
  const admitted: F[] = [];
  let total = held.reduce((sum, file) => sum + file.size, 0);
  let tooMany = 0;
  for (const file of weighed) {
    const reason = leftOut.get(file);
    switch (reason) {
      case undefined:
        admitted.push(file);
        total += file.size;
        break;
      case "too-big":
        refusals.push({ kind: "too-big", name: file.name, size: file.size, max: limits.maxFileBytes });
        break;
      case "too-many":
        tooMany += 1;
        refusals.push({ kind: "too-many", count: tooMany, max: limits.maxFiles });
        break;
      case "total-too-big":
        refusals.push({ kind: "total-too-big", name: file.name, total: total + file.size, max: limits.maxTotalBytes });
        break;
      default:
        return reason satisfies never;
    }
  }
  const newest = refusals.at(-1) ?? null;
  return { admitted, refusal: newest?.kind === "too-many" ? { ...newest, count: tooMany } : newest };
};

/** A refusal in the note line's words, naming the file. */
export const refusalText = (refusal: TrayRefusal): string => {
  switch (refusal.kind) {
    case "too-big":
      return t("task.composer.attach.tooBig", { name: refusal.name, size: roundSizeText(refusal.size), max: limitText(refusal.max) });
    case "too-many":
      return plural(refusal.count, "task.composer.attach.tooManyOne", "task.composer.attach.tooMany", { max: refusal.max });
    case "total-too-big":
      return t("task.composer.attach.totalTooBig", { name: refusal.name, total: roundSizeText(refusal.total), max: limitText(refusal.max) });
    case "empty":
      return t("task.composer.attach.empty", { name: refusal.name });
    case "folder":
      return t("task.composer.attach.folder", { name: refusal.name });
    default:
      return refusal satisfies never;
  }
};

/** The drop zone's line: where the dropped files go. */
export const dropToText = (agent: string, replying: boolean): string =>
  replying ? t("task.composer.attach.dropReply", { agent }) : t("task.composer.attach.dropNext", { agent });

/** The drop zone's limits line: `Up to 10 files · 10 MB each · 25 MB in all`. */
export const limitsText = (limits: FileLimits): string =>
  t("task.composer.attach.limits", { files: limits.maxFiles, each: limitText(limits.maxFileBytes), all: limitText(limits.maxTotalBytes) });

// ---------- a tray item ----------

/** How an item looks in the tray: a 52px picture, or a file's chip. */
export type TrayLook = "image" | "file";

/** An upload's state: going (with how far), in (core's answer), or failed (with the server's reason, when it gave one). */
export type TrayUpload<Uploaded> =
  | { readonly state: "uploading"; readonly progress: number }
  | { readonly state: "ready"; readonly uploaded: Uploaded }
  | { readonly state: "failed"; readonly reason: string | null };

/** What the tray needs of an item to decide its notes and Send. */
export type TrayEntry<Uploaded> = { readonly name: string; readonly size: number; readonly look: TrayLook; readonly upload: TrayUpload<Uploaded> };

/** An item's look from the browser's type, before core told its kind: the four a prompt can carry as pictures. */
export const lookOfType = (type: string): TrayLook => (isPromptImageContentType(type) ? "image" : "file");

/** A pasted screenshot's name: `Pasted image 14.51.08.png`, from the paste's time. */
export const pastedName = (at: Date, extension: string): string =>
  `${t("task.composer.attach.pastedName", { time: [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => String(part).padStart(2, "0")).join(".") })}.${extension}`;

/** A tray item's name for a screen reader: `spec.docx, DOCX, 48 KB`, with its upload's state. */
export const itemName = (entry: Pick<TrayEntry<unknown>, "name" | "size" | "upload">, type: string): string => {
  switch (entry.upload.state) {
    case "uploading":
      return t("task.composer.attach.itemUploading", { name: entry.name, type, size: bytesText(entry.size), n: Math.round(entry.upload.progress * 100) });
    case "ready":
      return t("task.composer.attach.item", { name: entry.name, type, size: bytesText(entry.size) });
    case "failed":
      return t("task.composer.attach.itemFailed", { name: entry.name, type, size: bytesText(entry.size) });
    default:
      return entry.upload satisfies never;
  }
};

// ---------- the note line and the hint ----------

/** Whether the task's model sees images (`tasks.get`'s and the new task's `model.imageInput`). */
export type ImageInput = "yes" | "no" | "unknown";

/**
 * The note line under the tray, one at a time, newest wins (composer-attachments.md, "The box"): a
 * file that wasn't added, the runner that can't take files yet, or the model that can't see the
 * tray's images. `null`: no line.
 */
export type TrayNote =
  | { readonly kind: "refused"; readonly refusal: TrayRefusal }
  | { readonly kind: "runner"; readonly runner: string }
  | { readonly kind: "model"; readonly model: string; readonly input: Exclude<ImageInput, "yes"> };

export const trayNoteOf = (input: {
  readonly refusal: TrayRefusal | null;
  readonly entries: readonly Pick<TrayEntry<unknown>, "look">[];
  readonly model: { readonly name: string; readonly imageInput: ImageInput } | null;
  /** The task's runner, when it runs a protocol too old for files (`runner-needs-upgrade`). */
  readonly oldRunner: string | null;
}): TrayNote | null => {
  if (input.refusal !== null) return { kind: "refused", refusal: input.refusal };
  if (input.oldRunner !== null && input.entries.length > 0) return { kind: "runner", runner: input.oldRunner };
  const model = input.model;
  if (model === null || !input.entries.some((entry) => entry.look === "image")) return null;
  switch (model.imageInput) {
    case "yes":
      return null;
    case "no":
    case "unknown":
      return { kind: "model", model: model.name, input: model.imageInput };
    default:
      return model.imageInput satisfies never;
  }
};

/** The note's words. */
export const noteText = (note: TrayNote): string => {
  switch (note.kind) {
    case "refused":
      return refusalText(note.refusal);
    case "runner":
      return t("task.composer.attach.oldRunner", { runner: note.runner });
    case "model":
      return note.input === "no" ? t("task.composer.attach.modelNo", { model: note.model }) : t("task.composer.attach.modelUnknown", { model: note.model });
    default:
      return note satisfies never;
  }
};

/** Once the tray holds this share of the total, the hint counts it (`21.2 MB of 25 MB` past 20 of 25). */
export const HEAVY_SHARE = 0.8;

/**
 * The controls row's hint (composer-attachments.md, states 4 to 6): a failed upload to retry or
 * remove; the tray full; the tray past 80% of the total; else the composer's own hint.
 */
export type TrayHint =
  | { readonly kind: "own" }
  | { readonly kind: "failed"; readonly name: string }
  | { readonly kind: "full"; readonly count: number; readonly max: number }
  | { readonly kind: "heavy"; readonly total: number; readonly max: number };

export const trayHintOf = (entries: readonly Pick<TrayEntry<unknown>, "name" | "size" | "upload">[], limits: FileLimits, refusal: TrayRefusal | null = null): TrayHint => {
  const failed = entries.find((entry) => entry.upload.state === "failed");
  if (failed !== undefined) return { kind: "failed", name: failed.name };
  if (entries.length >= limits.maxFiles) return { kind: "full", count: entries.length, max: limits.maxFiles };
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  // A file just refused for the total shows what room is left too (composer-states, state 5).
  if (total > limits.maxTotalBytes * HEAVY_SHARE || refusal?.kind === "total-too-big") return { kind: "heavy", total, max: limits.maxTotalBytes };
  return { kind: "own" };
};

/** The hint's words; `own` is the composer's, which the caller shows. */
export const hintText = (hint: Exclude<TrayHint, { readonly kind: "own" }>): string => {
  switch (hint.kind) {
    case "failed":
      return t("task.composer.attach.retryOrRemove", { name: hint.name });
    case "full":
      return t("task.composer.attach.full", { n: hint.count, max: hint.max });
    case "heavy":
      return t("task.composer.attach.heavy", { total: bytesText(hint.total), max: limitText(hint.max) });
    default:
      return hint satisfies never;
  }
};

// ---------- Send ----------

/**
 * What Send does now (composer-attachments.md, "Send"): sends, waits for uploads it was pressed
 * during (`Uploading 1 of 2…`), or can't, because an upload failed or there's nothing to send.
 * Files with no words are a message; the new task's box needs words (`wordsRequired`).
 */
export type SendState =
  | { readonly kind: "ready" }
  | { readonly kind: "empty" }
  | { readonly kind: "waiting"; readonly uploading: number; readonly of: number }
  | { readonly kind: "blocked"; readonly name: string };

export const sendStateOf = (input: {
  readonly entries: readonly Pick<TrayEntry<unknown>, "name" | "upload">[];
  readonly text: string;
  readonly pressed: boolean;
  readonly wordsRequired: boolean;
}): SendState => {
  const failed = input.entries.find((entry) => entry.upload.state === "failed");
  if (failed !== undefined) return { kind: "blocked", name: failed.name };
  const words = input.text.trim() !== "";
  if (!words && (input.wordsRequired || input.entries.length === 0)) return { kind: "empty" };
  const uploading = input.entries.filter((entry) => entry.upload.state === "uploading").length;
  if (input.pressed && uploading > 0) return { kind: "waiting", uploading, of: input.entries.length };
  return { kind: "ready" };
};

/** Whether a pressed Send goes now: every file is in and none failed. */
export const sendsNow = (entries: readonly Pick<TrayEntry<unknown>, "upload">[]): boolean => entries.every((entry) => entry.upload.state === "ready");

/** Send's label while it waits: `Uploading 1 of 2…`. */
export const waitingText = (state: Extract<SendState, { readonly kind: "waiting" }>): string => t("task.composer.attach.waiting", { n: state.uploading, of: state.of });

// ---------- paste and drag ----------

/**
 * What a paste does (composer-attachments.md, "Adding files"): its files join the tray, and its
 * text still pastes. An office app's copy (text, HTML and a picture of the cells) pastes as text
 * only; a picture alone (a screenshot, a browser's "Copy image") is attached and pastes nothing.
 */
export const pasteDecision = (clipboard: { readonly types: readonly string[]; readonly fileTypes: readonly string[] }): { readonly attach: boolean; readonly keepText: boolean } => {
  const plain = clipboard.types.includes("text/plain");
  const office = plain && clipboard.types.includes("text/html") && clipboard.fileTypes.length > 0 && clipboard.fileTypes.every(isPromptImageContentType);
  const attach = clipboard.fileTypes.length > 0 && !office;
  return { attach, keepText: !attach || plain };
};

/** A pasted file's name: a screenshot has none worth keeping (`image.png`), so it gets `Pasted image 14.51.08.png`. */
export const pasteName = (name: string, type: string, at: Date): string => {
  if (name !== "" && !/^image\.(png|jpe?g|gif|webp)$/i.test(name)) return name;
  const extension = /^image\/(png|jpeg|gif|webp)$/.exec(type)?.[1]?.replace("jpeg", "jpg") ?? "png";
  return pastedName(at, extension);
};

/**
 * Whether a drag shows the drop zone (composer-attachments.md, "Drop"): files from outside the
 * page. A drag of text, a link, or a picture from the page itself (which some browsers offer as a
 * file too) shows none.
 */
export const dragShowsZone = (drag: { readonly types: readonly string[]; readonly fromPage: boolean }): boolean => !drag.fromPage && drag.types.includes("Files");

/** The drag's depth over the window, counted on enter and leave, so a move between children never hides the zone. */
export type DragEvent = "enter" | "leave" | "drop" | "end" | "escape";

export const dragDepth = (depth: number, event: DragEvent): number => {
  switch (event) {
    case "enter":
      return depth + 1;
    case "leave":
      return Math.max(0, depth - 1);
    case "drop":
    case "end":
    case "escape":
      return 0;
    default:
      return event satisfies never;
  }
};

/** What marks the part of the page a drop never attaches on: the preview pane. */
export const DROP_EXCLUDED = "[data-drop-excluded]";

/** Whether a drop at `target` attaches: anywhere on the page but the preview pane, whose frame keeps its own drags. */
export const dropAttaches = (target: { readonly closest: (selector: string) => unknown } | null): boolean => target === null || target.closest(DROP_EXCLUDED) === null;
