"use client";

import { useCallback } from "react";
import type { ClipboardEvent } from "react";

import { pasteDecision, pasteName } from "./attach-words";

// Paste (composer-attachments.md, "Adding files"): Ctrl+V or ⌘V in the box adds each file on the
// clipboard; a screenshot, which has no name, becomes `Pasted image 14.51.08.png`. Pasted text still
// pastes as text, and an office app's copy of some cells pastes as text alone.

/** The `onPaste` handler for the box's field. */
export const usePasteFiles = ({ enabled, onFiles }: { readonly enabled: boolean; readonly onFiles: (files: readonly File[]) => void }) =>
  useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      if (!enabled) return;
      const data = event.clipboardData;
      const files = [...data.files];
      const decision = pasteDecision({ types: [...data.types], fileTypes: files.map((file) => file.type) });
      if (!decision.attach) return;
      if (!decision.keepText) event.preventDefault();
      const at = new Date();
      onFiles(
        files.map((file) => {
          const name = pasteName(file.name, file.type, at);
          return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
        }),
      );
    },
    [enabled, onFiles],
  );
