"use client";

import { ImageOffIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { THUMB_HEIGHT } from "./attachment-words";

// A member's or a ticket's picture in the thread (message-attachments.md, "The images"): milestone
// 8's strip, a thumbnail at the picture's own aspect, no caption (its name is the button's name and
// the viewer's), a button that opens the viewer. Its aspect is read from the picture once it loads,
// so the event needs no pixel size. A picture the task's retention removed is milestone 8's tile.

/** The widest a thumbnail grows, as a share of its height: a long strip of a page is cut, not shrunk. */
const MAX_ASPECT = 3;

export const FileThumb = ({ src, name, height = THUMB_HEIGHT, caption, selected = false, onOpen }: {
  /** The panel's download route, or the browser's copy while the message sends; `null` once removed. */
  readonly src: string | null;
  /** The button's name: `Image history-panel-mock.png from Sam Rivera, open`. */
  readonly name: string;
  readonly height?: number;
  /** The filmstrip's caption under it; the thread's have none. */
  readonly caption?: string;
  readonly selected?: boolean;
  readonly onOpen: (() => void) | null;
}) => {
  const [ratio, setRatio] = useState<number | null>(null);
  const [gone, setGone] = useState(false);
  const width = Math.round(height * Math.min(MAX_ASPECT, Math.max(0.22, ratio ?? 1.6)));
  const removed = src === null || gone;
  return (
    <div className="flex shrink-0 flex-col gap-[5px]" data-part="file-thumb">
      <button
        type="button"
        aria-label={name}
        disabled={onOpen === null || removed}
        onClick={onOpen ?? undefined}
        className={cn(
          "relative block overflow-hidden rounded-[6px] border border-control-line bg-white hover:border-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal disabled:cursor-default",
          removed && "border-line bg-surface",
          selected && "outline-2 outline-offset-1 outline-teal",
        )}
        style={{ width: removed ? height : width, height }}
      >
        {removed ? (
          <span className="absolute inset-0 grid place-items-center bg-surface p-1 text-center text-faint" data-testid="attachment-gone">
            <ImageOffIcon aria-hidden className="size-4 stroke-[1.75]" />
            {height < 100 ? null : <span className="text-xs">{t("task.attachments.gone")}</span>}
          </span>
        ) : (
          <img
            src={src}
            alt=""
            loading="lazy"
            draggable={false}
            className="absolute inset-0 size-full object-cover object-top"
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalHeight > 0) setRatio(image.naturalWidth / image.naturalHeight);
            }}
            onError={() => { setGone(true); }}
          />
        )}
      </button>
      {caption === undefined ? null : (
        <span className="truncate font-mono text-xs text-muted" style={{ maxWidth: Math.max(width, 60) }}>{caption}</span>
      )}
    </div>
  );
};

/** A ticket's picture that didn't load: its place kept, a dashed 110px tile with its name. */
export const MissingThumb = ({ name }: { readonly name: string }) => (
  <div
    className="grid size-[110px] shrink-0 place-items-center rounded-[6px] border border-dashed border-control-line p-1.5 text-center text-xs leading-[1.4] text-faint"
    data-part="thumb-missing"
  >
    <span className="min-w-0">
      <ImageOffIcon aria-hidden className="mx-auto mb-1 block size-4 stroke-[1.75] text-red" />
      <span className="block break-all">{name}</span>
      {t("task.ticketContext.didntLoad")}
    </span>
  </div>
);

/** The `+{n}` tile after five thumbnails, as milestone 8 draws it: it opens the viewer on the sixth. */
export const MoreThumb = ({ more, onOpen, size = THUMB_HEIGHT }: { readonly more: number; readonly onOpen: (() => void) | null; readonly size?: number }) => (
  <button
    type="button"
    disabled={onOpen === null}
    className="grid shrink-0 place-items-center rounded-[6px] border border-control-line bg-surface font-mono text-ui text-muted hover:border-faint focus-visible:outline-2 focus-visible:outline-teal"
    style={{ width: size, height: size }}
    aria-label={t("task.attachments.more", { n: more })}
    onClick={onOpen ?? undefined}
  >
    {`+${String(more)}`}
  </button>
);
