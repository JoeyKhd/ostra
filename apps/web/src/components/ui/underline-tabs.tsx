"use client";

import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "@/lib/cn";

// The underline tabs (task-changes.md, "The header, on every tab"; github-view.tsx's own tabs):
// 13px weight 500 `--muted`, the selected one `--text` with a 2px underline sitting on a full-width
// `--line` hairline. `role="tablist"`, and the arrow keys, Home and End move between tabs.

export type UnderlineTab<T extends string> = {
  readonly id: T;
  readonly label: string;
  /** After the label, 6px apart: a count or a status mark. */
  readonly extra?: ReactNode;
};

export type UnderlineTabsProps<T extends string> = {
  readonly tabs: readonly UnderlineTab<T>[];
  readonly selected: T;
  readonly onSelect: (id: T) => void;
  readonly label: string;
  /** The tab panel's id prefix, for `aria-controls`. */
  readonly idPrefix: string;
  readonly className?: string;
};

/** The tab one key press moves to from `index`, wrapping at both ends; `null` for any other key. */
export const nextTabIndex = (key: string, index: number, count: number): number | null => {
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
};

export const UnderlineTabs = <T extends string,>({ tabs, selected, onSelect, label, idPrefix, className }: UnderlineTabsProps<T>) => {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextTabIndex(event.key, index, tabs.length);
    const tab = next === null ? undefined : tabs[next];
    if (next === null || tab === undefined) return;
    event.preventDefault();
    onSelect(tab.id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={cn("flex gap-5 border-b border-line", className)}>
      {tabs.map((tab, index) => {
        const active = tab.id === selected;
        return (
          <button
            key={tab.id}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={active ? 0 : -1}
            data-tab={tab.id}
            onClick={() => { onSelect(tab.id); }}
            onKeyDown={(event) => { onKeyDown(event, index); }}
            className={cn(
              "-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 border-transparent text-sm font-medium text-muted hover:text-text",
              active && "border-text text-text",
            )}
          >
            {tab.label}
            {tab.extra}
          </button>
        );
      })}
    </div>
  );
};
