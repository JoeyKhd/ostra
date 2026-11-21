"use client";

import { InfoIcon } from "lucide-react";
import { Dialog } from "radix-ui";

import { t } from "@/lib/messages";

import { KbdSequence, KeyCap, isMac } from "./actions/kbd-sequence";
import { actionWords, scopeWords, sheetLines } from "./actions/registry";

// The `?` sheet (F-081, ticket 13; shortcut-sheet.md): every shortcut the panel has, by scope, drawn
// from the registry and never typed by hand. Escape, Close or a click outside closes it, and the
// focus goes back to what had it (Radix's dialog).

/**
 * The preview frame's own keys (milestone 8, ticket 26; task-preview.md, preview-native.md): they
 * aren't actions, so the registry doesn't hold them, as it doesn't hold ⌘K. ⌘. (Ctrl+. elsewhere)
 * hands the focus back from the box's browser; the panel can't catch it inside the app in your
 * browser, a cross-origin frame, so Tab and Shift+Tab, which leave either view, are the way out.
 */
export const PreviewFrameLines = ({ mac }: { readonly mac: boolean }) => (
  <>
    <div className="flex min-h-[34px] items-center gap-3 border-b border-line py-1" data-sheet-line="preview-focus-back" data-keys={mac ? "Meta+." : "Control+."}>
      <dt className="min-w-0 flex-1 text-ui text-text">
        {t("shortcuts.previewLeave")}
        <span className="text-[12.5px] text-faint"> {t("shortcuts.previewFocusBackNote")}</span>
      </dt>
      <dd><KbdSequence keys={[mac ? "⌘" : "Ctrl", "."]} chord /></dd>
    </div>
    <div className="flex min-h-[34px] items-center gap-3 border-b border-line py-1" data-sheet-line="preview-leave" data-keys="Tab Shift+Tab">
      <dt className="min-w-0 flex-1 text-ui text-text">
        {t("shortcuts.previewLeave")}
        <span className="text-[12.5px] text-faint"> {t("shortcuts.previewLeaveNote")}</span>
      </dt>
      <dd className="inline-flex shrink-0 items-center gap-1.5">
        <KbdSequence keys={["Tab"]} />
        <span className="text-[11px] text-faint">{t("shortcuts.or")}</span>
        <KbdSequence keys={["⇧", "Tab"]} chord />
      </dd>
    </div>
  </>
);

export const ShortcutSheet = ({
  open,
  onOpenChange,
  onOpenPalette,
  onCloseAutoFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenPalette: () => void;
  /** Gives the focus back to what had it before the sheet opened (ticket 16). */
  readonly onCloseAutoFocus?: (event: Event) => void;
}) => {
  const mac = isMac();
  const sections = sheetLines();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-(--scrim)" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="shortcut-sheet"
          {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
          className="fixed left-1/2 top-[12vh] z-50 flex max-h-[min(80vh,720px)] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line-2 bg-raise shadow-(--shadow-palette) focus:outline-none"
        >
          <div className="flex h-[52px] shrink-0 items-center border-b border-line px-5">
            <Dialog.Title className="text-[15px] font-semibold text-text">{t("shortcuts.title")}</Dialog.Title>
            <Dialog.Close className="ml-auto inline-flex h-7 items-center gap-2 rounded-md px-2 text-xs text-faint hover:bg-sel hover:text-text" aria-label={t("shortcuts.close")}>
              <KeyCap>esc</KeyCap>
              {t("shortcuts.close")}
            </Dialog.Close>
          </div>
          <div className="grid min-h-0 grid-cols-1 gap-x-10 overflow-y-auto px-5 pb-5 pt-4 min-[800px]:grid-cols-2">
            {sections.map((section, at) => {
              const words = scopeWords[section.scope];
              return (
              <section key={section.scope} data-scope={section.scope} className={at === 0 ? "min-[800px]:row-span-2" : "min-[800px]:mt-0 mt-5"}>
                <h3 className="flex h-7 items-center gap-1.5 text-xs font-medium text-faint">
                  {t(words.label)}
                  {words.note === null ? null : <span className="font-normal">{t(words.note)}</span>}
                </h3>
                <dl>
                  {section.scope === "global" ? (
                    <div className="flex h-[34px] items-center gap-3 border-b border-line" data-sheet-line="palette" data-keys={mac ? "Meta+k" : "Control+k"}>
                      <dt className="min-w-0 flex-1 truncate text-ui text-text">{t("shortcuts.openPalette")}</dt>
                      <dd><KbdSequence keys={[mac ? "⌘" : "Ctrl", "K"]} chord /></dd>
                    </div>
                  ) : null}
                  {section.lines.map((line) => (
                    <div key={line.id} className="flex h-[34px] items-center gap-3 border-b border-line" data-sheet-line={line.id} data-keys={line.shortcut.join(" ")}>
                      <dt className="min-w-0 flex-1 truncate text-ui text-text">
                        {t(actionWords[line.id].sheet)}
                        {line.confirm ? <span className="text-[12.5px] text-faint"> {t("shortcuts.asksToConfirm")}</span> : null}
                      </dt>
                      <dd><KbdSequence keys={line.shortcut} /></dd>
                    </div>
                  ))}
                  {section.scope === "task" ? <PreviewFrameLines mac={mac} /> : null}
                </dl>
              </section>
              );
            })}
          </div>
          <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-5 py-2">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] text-faint">
              <InfoIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
              {t("shortcuts.footnote")}
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-2 text-[13px] text-teal hover:underline"
              onClick={() => {
                onOpenChange(false);
                onOpenPalette();
              }}
            >
              {t("shortcuts.everyAction")}
              <KbdSequence keys={[mac ? "⌘" : "Ctrl", "K"]} chord />
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
