"use client";

import { CircleAlertIcon, HardDriveIcon, ImageOffIcon, InfoIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { hintText, noteText } from "./attach-words";
import type { TrayHint, TrayNote } from "./attach-words";
import { TrayItem } from "./tray-item";
import type { TrayItemView } from "./tray-item";

// The tray, its note line and the controls row's hint (composer-attachments.md, "The box"): the
// files in the order they came, wrapping on a desktop and scrolling sideways in one row on a phone;
// a polite live region that says what joined, uploaded or failed; under it one line, newest wins.

/** Whether the screen is touched rather than pointed at: the `x` buttons join the tab order there. */
export const useTouchScreen = (): boolean => {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => { setTouch(query.matches); };
    update();
    query.addEventListener("change", update);
    return () => { query.removeEventListener("change", update); };
  }, []);
  return touch;
};

export const ComposerTray = ({ items, announcement, onRemove, onRetry, onOpen, returnFocus, className }: {
  readonly items: readonly TrayItemView[];
  readonly announcement: string;
  readonly onRemove: (key: string) => void;
  readonly onRetry: (key: string) => void;
  /** Opens a picture in the viewer; `null` where there's none. */
  readonly onOpen: ((key: string) => void) | null;
  /** Where the focus goes when the last item is removed by its key: the words. */
  readonly returnFocus: () => void;
  readonly className?: string;
}) => {
  const touch = useTouchScreen();
  const list = useRef<HTMLDivElement>(null);
  // Delete on an item moves the focus to the next one (or back to the words) once it's gone.
  const [focusAfter, setFocusAfter] = useState<number | null>(null);
  useEffect(() => {
    if (focusAfter === null) return;
    setFocusAfter(null);
    const next = list.current?.querySelectorAll<HTMLElement>("[data-tray-item]")[focusAfter];
    if (next === undefined) returnFocus();
    else next.focus();
  }, [focusAfter, items, returnFocus]);
  return (
    <>
      {items.length === 0 ? null : (
        <div
          ref={list}
          role="list"
          aria-label={t("task.composer.attach.tray", { n: items.length })}
          data-testid="composer-tray"
          className={cn("flex flex-wrap gap-2 max-md:-mr-2.5 max-md:flex-nowrap max-md:overflow-x-auto max-md:pb-2.5 max-md:pl-0.5 max-md:pr-2.5 max-md:pt-[7px]", className)}
        >
          {items.map((item, index) => (
            <TrayItem
              key={item.key}
              item={item}
              touch={touch}
              onRemove={() => { onRemove(item.key); }}
              onRetry={() => { onRetry(item.key); }}
              onOpen={onOpen === null || item.look !== "image" ? null : () => { onOpen(item.key); }}
              onKeyRemove={() => {
                onRemove(item.key);
                setFocusAfter(index);
              }}
            />
          ))}
        </div>
      )}
      <p className="sr-only" aria-live="polite" data-testid="composer-tray-live">{announcement}</p>
    </>
  );
};

/** The line under the tray: a file that wasn't added (red, dismissible), the runner, or the model's note (muted). */
export const TrayNoteLine = ({ note, onDismiss, className }: { readonly note: TrayNote | null; readonly onDismiss: () => void; readonly className?: string }) => {
  if (note === null) return null;
  const red = note.kind !== "model";
  return (
    <p className={cn("flex items-start gap-[7px] text-sm", red ? "text-red" : "text-muted", className)} data-testid="composer-note" data-note={note.kind}>
      {note.kind === "model" ? (
        <ImageOffIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75] text-faint" />
      ) : (
        <CircleAlertIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
      )}
      <span className="min-w-0 flex-1">{noteText(note)}</span>
      {note.kind === "refused" ? (
        <button type="button" aria-label={t("task.composer.attach.dismiss")} onClick={onDismiss} className="-my-1 ml-auto grid size-6 shrink-0 place-items-center rounded-sm text-faint hover:bg-sel hover:text-text" data-action="dismiss-note">
          <XIcon aria-hidden className="size-[14px] stroke-[1.75]" />
        </button>
      ) : null}
    </p>
  );
};

/** The controls row's hint: the tray's own (a failed upload, full, heavy) over the composer's words. */
export const TrayHintLine = ({ hint, own, className }: { readonly hint: TrayHint; readonly own: string; readonly className?: string }) => (
  <span className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-sm text-faint", className)} data-testid="composer-hint" data-hint={hint.kind}>
    {(() => {
      switch (hint.kind) {
        case "own":
          return (
            <>
              <InfoIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" /> <span className="truncate">{own}</span>
            </>
          );
        case "failed":
          return (
            <>
              <CircleAlertIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75] text-red" /> <span className="truncate">{hintText(hint)}</span>
            </>
          );
        case "full":
          return (
            <>
              <InfoIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" /> <span className="truncate">{hintText(hint)}</span>
            </>
          );
        case "heavy":
          return (
            <>
              <HardDriveIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" /> <span className="truncate font-mono text-[12.5px]">{hintText(hint)}</span>
            </>
          );
        default:
          return hint satisfies never;
      }
    })()}
  </span>
);
