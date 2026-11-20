import { Fragment } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

// A shortcut drawn as keys (command-palette.md, shortcut-sheet.md): one key; a sequence as two keys
// with "then" between them, a real word so a screen reader reads "g then n"; a chord as two keys 4px
// apart with no word. The palette and the sheet both draw with it.

const keyClass = "inline-grid h-5 min-w-5 place-items-center rounded-[4px] border border-line-2 bg-bg px-1 font-mono text-[11.5px] leading-none text-muted";

export const KeyCap = ({ children, className }: { readonly children: string; readonly className?: string }) => <kbd className={cn(keyClass, className)}>{children}</kbd>;

/** Keys pressed one after the other (`g` then `n`), or a chord held together (`⌘` `K`). */
export const KbdSequence = ({ keys, chord = false, className }: { readonly keys: readonly string[]; readonly chord?: boolean; readonly className?: string }) => (
  <span className={cn("inline-flex shrink-0 items-center", chord ? "gap-1" : "gap-1.5", className)} data-keys={keys.join(chord ? "+" : " ")}>
    {keys.map((key, at) => (
      <Fragment key={`${key}-${String(at)}`}>
        {at > 0 && !chord ? <span className="text-[11px] text-faint">{t("shortcuts.then")}</span> : null}
        <KeyCap>{key}</KeyCap>
      </Fragment>
    ))}
  </span>
);

/** ⌘ on macOS, Ctrl elsewhere (shortcut-sheet.md, "macOS / elsewhere"). */
export const isMac = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
