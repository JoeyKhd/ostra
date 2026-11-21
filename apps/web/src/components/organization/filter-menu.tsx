"use client";

import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

export type FilterOption = {
  readonly value: string;
  readonly label: string;
  /** Drawn in Plex Mono (actions, prefixes). */
  readonly mono?: boolean;
  /** A group's header row: drawn a step bolder, and a choice of its own. */
  readonly header?: boolean;
  readonly muted?: boolean;
};

export type FilterMenuProps = {
  readonly label: string;
  /** The chosen value, or `null` for the default. */
  readonly value: string | null;
  /** What the button shows for the default (`All`), or `null` for the label alone (search.md's `Repo`). */
  readonly defaultLabel: string | null;
  /**
   * How the label and the value read. `pair` (audit-log.md): `Actor  All`, a `--muted` label and a
   * `--text` value. `colon` (search.md): `Project: All`, one phrase, the value after a colon.
   */
  readonly look?: "pair" | "colon";
  readonly options: readonly FilterOption[];
  readonly onChange: (value: string | null) => void;
  /** A search field at the menu's top (audit-log.md: Actor and Action). */
  readonly searchable?: boolean;
  /** More inside the menu, under the options (the custom period's dates). */
  readonly extra?: ReactNode;
  readonly testId?: string;
};

/**
 * A filter button (audit-log.md, "Filters"): `Actor  All` with a chevron (or search.md's `Project:
 * All`); a set filter shows its value in `--text` and an `x` that resets it. The menu lists the
 * choices, with a search field on top for the long lists.
 */
export const FilterMenu = ({ label, value, defaultLabel, look = "pair", options, onChange, searchable = false, extra, testId }: FilterMenuProps) => {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const chosen = value === null ? undefined : options.find((option) => option.value === value);
  const shown = value === null ? defaultLabel : (chosen?.label ?? value);
  const needle = typed.trim().toLowerCase();
  const listed = needle === "" ? options : options.filter((option) => option.label.toLowerCase().includes(needle));
  return (
    <span className="relative inline-flex" data-testid={testId}>
      <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setTyped(""); }}>
        <PopoverTrigger
          className={cn(
            "inline-flex h-[30px] max-w-[260px] items-center gap-1.5 rounded-[7px] border border-control-line bg-surface pl-2.5 text-ui hover:bg-sel",
            value === null ? "pr-2" : "pr-7",
          )}
        >
          {look === "colon" ? (
            <span className="-mr-[2px] shrink-0 font-medium text-text">{shown === null ? label : `${label}:`}</span>
          ) : (
            <span className="shrink-0 text-muted">{label}</span>
          )}
          {shown === null ? null : (
            <span className={cn("min-w-0 truncate text-text", look === "colon" && "font-medium", chosen?.mono === true && "font-mono text-[13px]")} data-testid={testId === undefined ? undefined : `${testId}-value`}>
              {shown}
            </span>
          )}
          {value === null ? <ChevronDownIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint" /> : null}
        </PopoverTrigger>
        <PopoverContent className="w-[280px]">
          {searchable ? (
            <Input
              autoFocus
              aria-label={t("audit.filterSearch", { label })}
              placeholder={t("audit.filterSearch", { label })}
              value={typed}
              onChange={(event) => { setTyped(event.target.value); }}
              className="mb-1 h-8"
            />
          ) : null}
          <div role="listbox" aria-label={label}>
            {listed.length === 0 ? <p className="px-2 py-1.5 text-sm text-faint">{t("audit.filterNone")}</p> : null}
            {listed.map((option) => {
              const selected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                    setTyped("");
                  }}
                  className={cn(
                    "flex h-[28px] w-full items-center gap-2 rounded-sm px-2 text-left text-ui hover:bg-sel",
                    option.header === true ? "font-medium text-text" : option.muted === true ? "text-muted" : "text-text",
                    option.header !== true && options.some((other) => other.header === true) && "pl-5",
                    option.mono === true && "font-mono text-[12.5px]",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {selected ? <CheckIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75]" /> : null}
                </button>
              );
            })}
          </div>
          {extra}
        </PopoverContent>
      </Popover>
      {value === null ? null : (
        <button
          type="button"
          aria-label={t("audit.filterClear", { label })}
          onClick={() => { onChange(null); }}
          className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-faint hover:text-text"
        >
          <XIcon aria-hidden className="size-[14px] stroke-[1.75]" />
        </button>
      )}
    </span>
  );
};
