"use client";

import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";

import { SearchDialog } from "./search-dialog";

/** True when focus is in a field, where `/` types a slash. */
const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

// Fumadocs' provider holds the search (docs-search.md): ⌘K or Ctrl+K anywhere, and `/` outside a
// field and outside the configuration reference, whose filter takes `/`. The theme is ostra's own
// small script and toggle, so next-themes is off.
// Fumadocs reads its hot keys as one combination, so both are one test.
const hotKey = [
  {
    display: "⌘K",
    key: (event: KeyboardEvent) =>
      ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") ||
      (event.key === "/" && !event.metaKey && !event.ctrlKey && !isTyping(event.target) && document.querySelector("[data-settings-filter]") === null),
  },
];

export const Providers = ({ children }: { readonly children: ReactNode }) => (
  <RootProvider theme={{ enabled: false }} search={{ SearchDialog, hotKey }}>
    {children}
  </RootProvider>
);
