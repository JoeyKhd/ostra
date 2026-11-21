"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { KeyCap } from "@/components/shell/actions/kbd-sequence";
import { t } from "@/lib/messages";

// Milestone 8's viewer frame (task-attachments.md, "The viewer"), shared by the agent's captures and
// a member's or a ticket's images (message-attachments.md, "The viewer"): a dialog over the task page
// with its title and where the picture is from, the stage with ← and →, the filmstrip, and the
// facts beside them. ← and → move, Home and End jump, Escape closes and gives the focus back.

export const ViewerFrame = ({ title, where, kind, index, count, onGo, onClose, focusStage, stage, filmstrip, facts }: {
  readonly title: string;
  /** `CALC-192 · Sam Rivera's message at 14:52 · 1 of 2`. */
  readonly where: string;
  /** What the open picture is (`screenshot`, `recording`, `image`), for `data-kind`. */
  readonly kind: string;
  readonly index: number;
  readonly count: number;
  /** Moves to the picture at `to` in the set (kept in range by the frame). */
  readonly onGo: (to: number) => void;
  readonly onClose: () => void;
  /** The element the dialog focuses when it opens: the stage, or a recording's player. */
  readonly focusStage: () => HTMLElement | null;
  readonly stage: ReactNode;
  readonly filmstrip: ReactNode;
  readonly facts: ReactNode;
}) => {
  const opener = useRef<HTMLElement | null>(typeof document === "undefined" ? null : document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const go = (to: number) => { onGo(Math.max(0, Math.min(count - 1, to))); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || (event.target instanceof HTMLElement && event.target.getAttribute("role") === "slider")) return;
    if (event.key === "ArrowLeft") go(index - 1);
    else if (event.key === "ArrowRight") go(index + 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(count - 1);
    else return;
    event.preventDefault();
  };
  return (
    <Dialog.Root open onOpenChange={(value) => { if (!value) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-(--scrim)" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="attachment-viewer"
          data-kind={kind}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() => { focusStage()?.focus(); });
          }}
          onCloseAutoFocus={(event) => {
            const back = opener.current;
            if (back?.isConnected === true) {
              event.preventDefault();
              back.focus();
            }
          }}
          className="fixed left-1/2 top-1/2 z-50 flex h-[min(860px,calc(100dvh-48px))] w-[min(1240px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line-2 bg-raise shadow-(--shadow-palette) focus:outline-none max-sm:h-dvh max-sm:w-screen max-sm:rounded-none max-sm:border-0"
        >
          <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line pl-5 pr-4">
            <Dialog.Title className="shrink-0 text-[15px] font-semibold text-text max-sm:sr-only">{title}</Dialog.Title>
            <span className="min-w-0 truncate text-ui text-faint" data-testid="viewer-position">{where}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12.5px] text-faint max-sm:hidden">
              <KeyCap>←</KeyCap>
              <KeyCap>→</KeyCap>
              <span className="mr-2.5">{t("task.attachments.toMove")}</span>
            </span>
            <Dialog.Close className="inline-flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-[12.5px] text-faint hover:bg-sel hover:text-text max-sm:ml-auto" aria-label={t("common.close")}>
              <KeyCap>esc</KeyCap>
              {t("common.close")}
            </Dialog.Close>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] max-[1179px]:grid-cols-1 max-[1179px]:grid-rows-[minmax(0,1fr)_auto] max-[1179px]:overflow-y-auto">
            <div className="flex min-h-0 min-w-0 flex-col border-r border-line bg-surface max-[1179px]:min-h-[60vh] max-[1179px]:border-r-0">
              <div className="relative flex min-h-0 flex-1 flex-col">
                {stage}
                {count > 1 ? (
                  <>
                    <button type="button" aria-label={t("task.attachments.previous")} disabled={index <= 0} onClick={() => { go(index - 1); }} className="absolute left-3 top-1/2 grid size-[34px] -translate-y-1/2 place-items-center rounded-full border border-line-2 bg-raise text-muted hover:text-text disabled:opacity-40 max-sm:hidden">
                      <ChevronLeftIcon aria-hidden className="size-4" />
                    </button>
                    <button type="button" aria-label={t("task.attachments.next")} disabled={index >= count - 1} onClick={() => { go(index + 1); }} className="absolute right-3 top-1/2 grid size-[34px] -translate-y-1/2 place-items-center rounded-full border border-line-2 bg-raise text-muted hover:text-text disabled:opacity-40 max-sm:hidden">
                      <ChevronRightIcon aria-hidden className="size-4" />
                    </button>
                  </>
                ) : null}
              </div>
              <div className="flex h-[120px] shrink-0 items-center justify-center gap-3.5 overflow-x-auto border-t border-line bg-raise px-4 max-sm:h-[84px] max-sm:justify-start" data-testid="viewer-filmstrip">
                {filmstrip}
              </div>
            </div>
            <div className="overflow-y-auto p-[18px]" data-testid="viewer-facts">
              {facts}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

/** One property row of the facts: `Width  1280 × 800`. */
export const Fact = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <div className="grid min-h-7 grid-cols-[92px_minmax(0,1fr)] items-center gap-2 text-ui">
    <span className="text-muted">{label}</span>
    <span className="flex min-w-0 items-center gap-1.5 text-text">{children}</span>
  </div>
);
