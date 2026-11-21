"use client";

import { PaperclipIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

// The drop zone (composer-attachments.md, "Drop"; composer-states.md, state 1): while files are
// dragged over the window, the task page's chat column turns into it (inset 10px, never the preview
// pane), and the new-task page's box does. A dashed `--teal` edge, the page at 96% with a 3px blur,
// the paperclip's tile, `Drop to attach` and the limits. One per page; `use-drop-zone` shows it.

export const DropZone = ({ variant, to, limits, className }: {
  /** `column`: over the task page's chat column; `box`: the new-task box itself. */
  readonly variant: "column" | "box";
  /** Where the files go, for the column's line: `They go in your reply to OpenCode.` */
  readonly to?: string;
  /** `Up to 10 files · 10 MB each · 25 MB in all`. */
  readonly limits: string;
  readonly className?: string;
}) => {
  switch (variant) {
    case "column":
      return (
        <div
          aria-hidden
          data-testid="drop-zone"
          className={cn("pointer-events-none absolute inset-2.5 z-30 flex items-center justify-center rounded-[10px] border-[1.5px] border-dashed border-teal bg-bg/96 backdrop-blur-[3px]", className)}
        >
          <div className="flex flex-col items-center text-center">
            <span className="mb-3.5 grid size-10 place-items-center rounded-[10px] border border-line-2 bg-surface text-teal">
              <PaperclipIcon className="size-[18px] stroke-[1.75]" />
            </span>
            <p className="text-[16px] font-semibold text-text">{t("task.composer.attach.drop")}</p>
            {to === undefined ? null : <p className="mt-[3px] text-ui text-muted">{to}</p>}
            <p className="mt-2.5 font-mono text-[12.5px] text-faint">{limits}</p>
          </div>
        </div>
      );
    case "box":
      return (
        <div
          aria-hidden
          data-testid="drop-zone"
          className={cn("pointer-events-none absolute -inset-px z-10 flex items-center justify-center rounded-[10px] border-[1.5px] border-dashed border-teal bg-surface", className)}
        >
          <div className="flex flex-col items-center text-center">
            <span className="mb-2 grid size-8 place-items-center rounded-lg border border-line-2 text-teal">
              <PaperclipIcon className="size-4 stroke-[1.75]" />
            </span>
            <p className="text-[15px] font-semibold text-text">{t("task.composer.attach.drop")}</p>
            <p className="mt-1 font-mono text-[12.5px] text-faint">{limits}</p>
          </div>
        </div>
      );
    default:
      return variant satisfies never;
  }
};
