"use client";

import { useEffect, useRef, useState } from "react";

import { actionForShortcut, offeredPaletteActions } from "./registry";
import type { PaletteAction, PaletteContext } from "./registry";

// The panel's one key listener (F-081, ticket 13; shortcut-sheet.md, "How the shortcuts behave"):
// it reads the registry, so a key fires only what the palette would offer here. Never with a
// modifier (⌘K is the palette's own), never while typing in a field, a select or the composer, and
// never while a dialog is open. A two-key sequence waits one second for its second key.

/** How long a sequence's first key waits for its second (shortcut-sheet.md). */
export const SEQUENCE_MS = 1_000;

/** Where a key is text, not a shortcut: a field, a select, anything editable, the composer. */
export const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-part='composer']") !== null) return true;
  return false;
};

/** A dialog, sheet, menu or palette is open: its own keys win. */
const overlayOpen = (): boolean => document.querySelector("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox'][data-radix-select-viewport]") !== null;

export const useShortcuts = ({ context, fire }: { readonly context: PaletteContext; readonly fire: (action: PaletteAction) => void }): { readonly pending: string | null } => {
  const [pending, setPending] = useState<string | null>(null);
  const first = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const droppedAt = useRef(0);
  const latest = useRef({ context, fire });
  latest.current = { context, fire };

  useEffect(() => {
    const clear = (dropped: boolean) => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (first.current !== null && dropped) droppedAt.current = Date.now();
      first.current = null;
      setPending(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (event.key.length !== 1 || isTypingTarget(event.target) || overlayOpen()) {
        if (first.current !== null && event.key !== "Shift") clear(true);
        return;
      }
      const { context: now, fire: run } = latest.current;
      const key = event.key;
      const waiting = first.current;
      if (waiting !== null) {
        clear(false);
        const action = actionForShortcut([waiting, key], now);
        if (action === null) {
          droppedAt.current = Date.now();
          return;
        }
        event.preventDefault();
        run(action);
        return;
      }
      const starts = offeredPaletteActions(now).some((entry) => entry.shortcut !== null && entry.shortcut.length === 2 && entry.shortcut[0] === key);
      if (starts) {
        event.preventDefault();
        first.current = key;
        setPending(key);
        timer.current = setTimeout(() => { clear(true); }, SEQUENCE_MS);
        return;
      }
      // A `t` just after a dropped `g` was meant for Tasks, not take over (shortcut-sheet.md, open point 1).
      if (key === "t" && Date.now() - droppedAt.current < SEQUENCE_MS) return;
      const action = actionForShortcut([key], now);
      if (action === null) return;
      event.preventDefault();
      run(action);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  return { pending };
};
