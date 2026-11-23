"use client";

import { CircleMinusIcon, ImageOffIcon } from "lucide-react";

import type { FileLimits } from "@ostra/domain/file-limits";
import type { FileLeftOutReason, FileSkipReason, ImagesNotSent } from "@ostra/protocol";

import { plural, t } from "@/lib/messages";

import { FileChipLink } from "./file-chip";
import { FileThumb, MoreThumb } from "./file-thumb";
import { imagesNotSentText, leftOutText, skippedText, stripOf } from "./file-words";
import type { LeftOutScope, ThreadFile } from "./file-words";

// A member's message's files in the thread (message-attachments.md, "The message"): its pictures in
// milestone 8's strip, each opening the viewer; its other files as chips that download, `text
// extracted` on a document ostra read; the line when its images went to the agent as files; and
// what was left out or not saved in the box, by name, with why.

/** A file left out, by name, with why, and its size when it's known. */
export type LeftOutNote = { readonly name: string; readonly reason: FileLeftOutReason; readonly size: number | null };

/** What was left out, and the agent was told which (ticket-context.md, "Some left out"). */
export const LeftOutList = ({ notes, scope, limits, tracker }: { readonly notes: readonly LeftOutNote[]; readonly scope: LeftOutScope; readonly limits: FileLimits; readonly tracker: string }) =>
  notes.length === 0 ? null : (
    <div className="mt-2.5 text-[13.5px] text-muted" data-part="files-left-out">
      <p className="flex items-center gap-2">
        <CircleMinusIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint" />
        {t("task.files.leftOut.heading", { n: notes.length })}
      </p>
      <ul className="ml-[22px] mt-1">
        {notes.map((note, index) => (
          <li key={`${note.name}-${String(index)}`} className="flex min-h-6 flex-wrap items-baseline gap-x-2">
            <span className="break-all font-mono text-ui text-text">{note.name}</span>
            <span>{leftOutText(note, scope, limits, tracker)}</span>
          </li>
        ))}
      </ul>
    </div>
  );

/** The files the runner couldn't save in the box (`files.written`'s skips), by name, with why. */
export const SkippedList = ({ skipped }: { readonly skipped: readonly { readonly name: string; readonly reason: FileSkipReason }[] }) =>
  skipped.length === 0 ? null : (
    <div className="mt-2.5 text-[13.5px] text-muted" data-part="files-skipped">
      <p className="flex items-center gap-2">
        <CircleMinusIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint" />
        {plural(skipped.length, "task.files.skippedOne", "task.files.skippedMany")}
      </p>
      <ul className="ml-[22px] mt-1">
        {skipped.map((note, index) => (
          <li key={`${note.name}-${String(index)}`} className="flex min-h-6 flex-wrap items-baseline gap-x-2">
            <span className="break-all font-mono text-ui text-text">{note.name}</span>
            <span>{skippedText(note.reason)}</span>
          </li>
        ))}
      </ul>
    </div>
  );

/** A thumbnail's height above a member's bubble (parts.md part 2; milestone 8's strip is 110px). */
const BUBBLE_THUMB_HEIGHT = 84;

/** A picture's button name: `Image history-panel-mock.png from Sam Rivera, open`. */
export const imageName = (name: string, from: string): string => t("task.files.openImage", { name, from });

export const MessageFiles = ({ files, author, agent, model, imagesNotSent, leftOut, skipped, limits, tracker = "", onOpenImage }: {
  readonly files: readonly ThreadFile[];
  /** Who sent them: the thumbnails' names. */
  readonly author: string;
  readonly agent: string;
  /** The task's model's name, for the line when its images went as files. */
  readonly model: string;
  readonly imagesNotSent: ImagesNotSent | null;
  readonly leftOut: readonly LeftOutNote[];
  readonly skipped: readonly { readonly name: string; readonly reason: FileSkipReason }[];
  readonly limits: FileLimits;
  /** The tracker's name, for a follow-up's file that didn't load from it. */
  readonly tracker?: string;
  readonly onOpenImage: ((fileId: ThreadFile["fileId"]) => void) | null;
}) => {
  const images = files.filter((file) => file.kind === "image");
  const others = files.filter((file) => file.kind !== "image");
  const { shown, more } = stripOf(images);
  const sixth = images[shown.length];
  return (
    // Milestone 10 (F-151, parts.md part 2): above the member's bubble, right-aligned, 8px apart: pictures as 84px thumbnails, then the chips at 48px on `--bg`.
    <div data-part="message-files" className="flex flex-col items-end">
      {images.length + others.length === 0 ? null : (
        <div className="flex flex-wrap items-end justify-end gap-2" data-testid="message-strip">
          {images.length === 0 ? null : (
            <div className="contents" data-testid="message-images">
              {shown.map((file) => (
                <FileThumb key={file.fileId} src={file.downloadPath} name={imageName(file.name, author)} height={BUBBLE_THUMB_HEIGHT} onOpen={onOpenImage === null ? null : () => { onOpenImage(file.fileId); }} />
              ))}
              {more === 0 ? null : <MoreThumb more={more} size={BUBBLE_THUMB_HEIGHT} onOpen={onOpenImage === null || sixth === undefined ? null : () => { onOpenImage(sixth.fileId); }} />}
            </div>
          )}
          {others.length === 0 ? null : (
            <div className="contents" data-testid="message-file-chips">
              {others.map((file) => (
                <FileChipLink key={file.fileId} file={file} agent={agent} inBubble />
              ))}
            </div>
          )}
        </div>
      )}
      {imagesNotSent === null || images.length === 0 ? null : (
        <p className="mt-2.5 flex items-start gap-2 text-[13.5px] text-muted" data-testid="images-not-sent" data-reason={imagesNotSent}>
          <ImageOffIcon aria-hidden className="mt-[3px] size-[14px] shrink-0 stroke-[1.75] text-faint" />
          <span className="min-w-0">{imagesNotSentText(imagesNotSent, { model, agent })}</span>
        </p>
      )}
      <LeftOutList notes={leftOut} scope="message" limits={limits} tracker={tracker} />
      <SkippedList skipped={skipped} />
    </div>
  );
};
