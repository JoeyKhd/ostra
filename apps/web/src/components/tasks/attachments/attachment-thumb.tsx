"use client";

import { ImageOffIcon, PlayIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { durationText, thumbWidth } from "./attachment-words";
import type { AttachmentView } from "./attachment-words";
import { useFrameReel } from "./recording-player";

// One picture's thumbnail (task-attachments.md, "The strip"): at its capture's own aspect, a 1px
// `--line-2` edge, a 6px radius and a white ground for the app; a recording carries a play disc and
// its length. It's a button that opens the viewer. Drawn from the panel's download route only; a
// blob the task's retention removed is a tile that says so, and the row stays.

/** A recording's first frame, from its reel (read once per page, shared with the viewer's player). */
const FirstFrame = ({ path, className }: { readonly path: string; readonly className: string }) => {
  const reel = useFrameReel(path);
  const url = reel.data?.urls[0];
  return url === undefined ? <span className={cn(className, "bg-surface")} /> : <img src={url} alt="" className={className} />;
};

export const AttachmentThumb = ({ view, size, height, caption, name, selected = false, onOpen, testid }: {
  /** The stored picture; `undefined` while the list is read (a placeholder shows). */
  readonly view: AttachmentView | undefined;
  readonly size: { readonly width: number; readonly height: number; readonly kind: "screenshot" | "recording"; readonly durationMs: number | null };
  readonly height: number;
  readonly caption: string;
  readonly name: string;
  readonly selected?: boolean;
  readonly onOpen: (() => void) | null;
  readonly testid?: string;
}) => {
  const [gone, setGone] = useState(false);
  const width = thumbWidth(size, height);
  const small = height < 100;
  const fill = "absolute inset-0 size-full object-cover object-top";
  const face =
    view === undefined ? (
      <span className="absolute inset-0 bg-surface" aria-hidden />
    ) : gone ? (
      <span className="absolute inset-0 grid place-items-center bg-surface p-1 text-center text-faint" data-testid="attachment-gone">
        <ImageOffIcon aria-hidden className="size-4 stroke-[1.75]" />
        {small ? null : <span className="text-xs">{t("task.attachments.gone")}</span>}
      </span>
    ) : size.kind === "screenshot" ? (
      <img src={view.downloadPath} alt="" loading="lazy" className={fill} onError={() => { setGone(true); }} />
    ) : (
      <FirstFrame path={view.downloadPath} className={fill} />
    );
  return (
    <div className="flex shrink-0 flex-col gap-[5px]" data-testid={testid} data-attachment={view?.attachmentId}>
      <button
        type="button"
        aria-label={name}
        disabled={onOpen === null || view === undefined}
        onClick={onOpen ?? undefined}
        className={cn(
          "relative block overflow-hidden rounded-[6px] border border-control-line bg-white hover:border-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal disabled:cursor-default",
          view === undefined && "border-line bg-surface",
          selected && "outline-2 outline-offset-1 outline-teal",
        )}
        style={{ width, height }}
      >
        {face}
        {size.kind === "recording" && view !== undefined && !gone ? (
          <>
            <span className="absolute inset-0 grid place-items-center">
              <span className={cn("grid place-items-center rounded-full bg-[rgba(13,14,16,0.78)] text-[#f2f3f4]", small ? "size-[26px]" : "size-[34px]")}>
                <PlayIcon aria-hidden className={cn("ml-0.5 fill-current", small ? "size-3" : "size-[15px]")} />
              </span>
            </span>
            {small ? null : <span className="absolute bottom-1.5 right-1.5 h-[18px] rounded-[4px] bg-[rgba(13,14,16,0.78)] px-[5px] font-mono text-[11.5px] font-medium leading-[18px] text-[#f2f3f4]">{durationText(size.durationMs)}</span>}
          </>
        ) : null}
      </button>
      <span className="whitespace-nowrap font-mono text-xs text-muted">{caption}</span>
    </div>
  );
};
