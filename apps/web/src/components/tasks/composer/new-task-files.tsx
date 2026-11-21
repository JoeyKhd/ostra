"use client";

import { InfoIcon, PaperclipIcon } from "lucide-react";

import type { FileLimits } from "@ostra/domain/file-limits";
import { FILES_ROOT_DIR, MESSAGE_FILES_FOLDER } from "@ostra/protocol";

import { bytesText } from "@/components/tasks/attachments/attachment-words";
import { extensionOf, limitText, peopleText } from "@/components/tasks/attachments/file-words";
import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { t } from "@/lib/messages";

import type { ImageInput, TrayEntry } from "./attach-words";

// The new task's files (new-task-attachments.md): `What happens next` gains a row for them while the
// tray holds any, the properties panel an `Attachments` group, and the profile's group a `Takes` row
// that always says what the model reads, before anything is attached.

/** The extensions core reads the text of (F-150): Word, PDF, Excel and PowerPoint. */
const DOCUMENTS: readonly string[] = ["docx", "pdf", "xlsx", "pptx"];

/** A new task's first message is the task's first event: its files go under `.ostra/attachments/1/`. */
export const FIRST_FOLDER = `${FILES_ROOT_DIR}/${MESSAGE_FILES_FOLDER}/1/`;

/** Whether an item is a document whose text core reads: its kind once uploaded, its extension before. */
const isDocument = (entry: Pick<TrayEntry<{ readonly kind: string }>, "name" | "upload">): boolean =>
  entry.upload.state === "ready" ? entry.upload.uploaded.kind === "document" : DOCUMENTS.includes(extensionOf(entry.name));

/** The row's words around the path: `The 4 files go into the box under` … `, and the text of the docx beside it`. */
export const filesNextWords = (entries: readonly Pick<TrayEntry<{ readonly kind: string }>, "name" | "upload">[]): { readonly before: string; readonly after: string } => {
  const documents = entries.filter(isDocument);
  const [only] = documents;
  const after =
    documents.length === 0 ? "" : documents.length === 1 && only !== undefined ? t("newTask.attach.nextText", { type: extensionOf(only.name) }) : t("newTask.attach.nextTexts");
  return { before: entries.length === 1 ? t("newTask.attach.nextOne") : t("newTask.attach.next", { n: entries.length }), after };
};

/** `What happens next`'s files row; on a phone, the `--faint` line under the box. */
export const FilesNextRow = ({ entries, variant }: { readonly entries: readonly Pick<TrayEntry<{ readonly kind: string }>, "name" | "upload">[]; readonly variant: "row" | "line" }) => {
  if (entries.length === 0) return null;
  const words = filesNextWords(entries);
  const text = (
    <span className="min-w-0 break-words">
      {words.before} <span className={variant === "row" ? "font-mono text-ui text-text" : "font-mono text-[12.5px] text-text"}>{FIRST_FOLDER}</span>
      {words.after}
      {variant === "line" ? "." : null}
    </span>
  );
  switch (variant) {
    case "row":
      return (
        <li className="flex min-h-[38px] items-center gap-3 py-1.5 text-body" data-testid="next-files">
          <span className="flex w-[15px] shrink-0 text-muted [&_svg]:size-[15px] [&_svg]:stroke-[1.75]"><PaperclipIcon aria-hidden /></span>
          {text}
        </li>
      );
    case "line":
      return (
        <p className="mt-2.5 flex gap-[7px] text-sm text-faint" data-testid="next-files">
          <InfoIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
          {text}
        </p>
      );
    default:
      return variant satisfies never;
  }
};

/** The properties panel's `Attachments` group, while the tray holds files: how many of each, and the size against the limit. */
export const NewTaskAttachmentsGroup = ({ entries, limits }: { readonly entries: readonly Pick<TrayEntry<unknown>, "look" | "size">[]; readonly limits: FileLimits }) => {
  if (entries.length === 0) return null;
  const images = entries.filter((entry) => entry.look === "image").length;
  return (
    <div data-testid="new-task-attachments">
      <PropGroup title={t("newTask.attach.group")}>
        <PropRow label={t("newTask.attach.files")}><span className="truncate">{peopleText(images, entries.length - images)}</span></PropRow>
        <PropRow label={t("newTask.attach.size")}>
          <span className="font-mono">
            {bytesText(entries.reduce((sum, entry) => sum + entry.size, 0))}
            <span className="text-muted">{t("newTask.attach.ofMax", { max: limitText(limits.maxTotalBytes) })}</span>
          </span>
        </PropRow>
      </PropGroup>
    </div>
  );
};

/** What the model reads, in the profile's group: `text and images`, or `text only` (unknown counts as no). */
export const takesText = (input: ImageInput): string => {
  switch (input) {
    case "yes":
      return t("newTask.attach.takesImages");
    case "no":
    case "unknown":
      return t("newTask.attach.takesText");
    default:
      return input satisfies never;
  }
};

export const TakesRow = ({ input }: { readonly input: ImageInput }) => (
  <PropRow label={t("newTask.attach.takes")}><span className="truncate" data-testid="model-takes" data-input={input}>{takesText(input)}</span></PropRow>
);
