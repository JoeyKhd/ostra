"use client";

import { PaperclipIcon } from "lucide-react";
import { useRef } from "react";

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

// The paperclip (composer-attachments.md, "Adding files"): it opens the system's file picker,
// several files at once and any type, with no `accept` filter and no `capture`, so a phone's picker
// offers the photo library, the camera and files on its own. Full, it turns off at 40% and its
// tooltip says why. It's a 28px ghost on a desktop, pulled 6px left so its glyph lines up with the
// words; the dock's is a 44px outlined button (the new task's 36px).

export type AttachButtonLayout = "composer" | "new-task";

export const AttachButton = ({ onFiles, full, max, disabled = false, layout = "composer", className }: {
  readonly onFiles: (files: readonly File[]) => void;
  /** The tray holds as many files as a message may. */
  readonly full: boolean;
  readonly max: number;
  /** Send waits for uploads: the box is locked. */
  readonly disabled?: boolean;
  readonly layout?: AttachButtonLayout;
  readonly className?: string;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const off = full || disabled;
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="attach-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <Tooltip content={full ? t("task.composer.attach.fullTip", { max }) : t("task.composer.attach.tip")}>
        <button
          type="button"
          aria-label={t("task.composer.attach.label")}
          aria-disabled={off}
          onClick={() => { if (!off) input.current?.click(); }}
          className={cn(
            "grid shrink-0 place-items-center text-muted hover:bg-sel hover:text-text aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted",
            layout === "composer"
              ? "-ml-1.5 size-7 rounded-md max-md:ml-0 max-md:size-11 max-md:rounded-[10px] max-md:border max-md:border-line-2 max-md:bg-surface"
              : "-ml-1.5 size-7 rounded-md max-md:ml-0 max-md:size-9",
            className,
          )}
          data-action="attach"
        >
          <PaperclipIcon aria-hidden className={cn("size-4 stroke-[1.75]", layout === "composer" && "max-md:size-[19px]")} />
        </button>
      </Tooltip>
    </>
  );
};
