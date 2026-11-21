"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { Tooltip } from "./tooltip";

/** How long `Copied` shows (take-it-local.md, "Copied"). */
export const COPIED_MS = 1500;

export type CopyOutcome = "idle" | "copied" | "refused";

/**
 * Writes `text` to the clipboard. When the browser refuses (an insecure origin), the element named by
 * `selectId` has its text selected instead, so the member can copy it by hand.
 */
export const copyText = async (text: string, selectId: string | undefined): Promise<Exclude<CopyOutcome, "idle">> => {
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    const node = selectId === undefined ? null : document.getElementById(selectId);
    const selection = window.getSelection();
    if (node !== null && selection !== null) {
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return "refused";
  }
};

export type CopyButtonProps = {
  readonly text: string;
  /** The element holding the text, selected when the clipboard refuses. */
  readonly selectId?: string;
  readonly disabled?: boolean;
  readonly className?: string;
};

/**
 * A 24px ghost icon button that copies a line (take-it-local.md; account.md): its icon turns to a
 * green check for 1.5s with a `Copied` tooltip, and a polite live region says it.
 */
export const CopyButton = ({ text, selectId, disabled = false, className }: CopyButtonProps) => {
  const [outcome, setOutcome] = useState<CopyOutcome>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const label = outcome === "copied" ? t("takeLocal.copied") : outcome === "refused" ? t("takeLocal.copyRefused") : t("takeLocal.copy");
  return (
    <>
      {/* Its name is `Copy` and its outcome is announced below, so the tooltip is for the pointer:
          on keyboard focus it would take a popover's first Escape (Take it local, F-081). */}
      <Tooltip content={label} hoverOnly>
        <button
          type="button"
          aria-label={t("takeLocal.copy")}
          disabled={disabled}
          data-copy={text}
          className={cn("inline-grid size-6 shrink-0 place-items-center rounded-sm text-muted hover:bg-sel hover:text-text disabled:opacity-50", className)}
          onClick={() => {
            void copyText(text, selectId).then((result) => {
              setOutcome(result);
              if (timer.current !== null) clearTimeout(timer.current);
              timer.current = setTimeout(() => {
                setOutcome("idle");
              }, COPIED_MS);
            });
          }}
        >
          {outcome === "copied" ? <CheckIcon aria-hidden className="size-[14px] stroke-[1.75] text-green" /> : <CopyIcon aria-hidden className="size-[14px] stroke-[1.75]" />}
        </button>
      </Tooltip>
      <span role="status" aria-live="polite" className="sr-only">
        {outcome === "idle" ? "" : label}
      </span>
    </>
  );
};
