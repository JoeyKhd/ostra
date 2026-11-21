"use client";

import { BookOpenIcon, CircleArrowUpIcon, InfoIcon, KeyRoundIcon, LayersIcon, LockIcon, PlugIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Chip } from "@/components/ui/status";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { hashText } from "./library-model";
import type { ItemKind, ItemStatus } from "./library-model";

// The library's small parts, shared by its pages, its sheets and the profile editor
// (app-targets/m8/library*.md): the kind's square, the neutral update chip, the every-profile chip,
// a note with its left rule, and the hash with the whole of it on hover. No amber anywhere.

/** The kind's icon: `book-open` a skill, `plug` an MCP server. */
export const KindIcon = ({ kind, className }: { readonly kind: ItemKind; readonly className?: string }) =>
  kind === "skill" ? <BookOpenIcon aria-hidden className={cn("size-[15px] shrink-0 stroke-[1.75] text-faint", className)} /> : <PlugIcon aria-hidden className={cn("size-[15px] shrink-0 stroke-[1.75] text-faint", className)} />;

/** The 26px kind square of a library row (1px `--line-2`, radius 6px). */
export const KindSquare = ({ kind }: { readonly kind: ItemKind }) => (
  <span className="grid size-[26px] shrink-0 place-items-center rounded-[6px] border border-line-2" title={kind === "skill" ? t("library.kind.skill") : t("library.kind.server")}>
    <KindIcon kind={kind} className="size-[14px] text-muted" />
  </span>
);

/** The update chip: neutral, a teal icon, never amber (an admin's chore, not a person blocked). */
export const UpdateChip = ({ children }: { readonly children: ReactNode }) => (
  <Chip className="h-[22px] gap-1.5 px-2 text-sm text-text-2">
    <CircleArrowUpIcon aria-hidden className="!size-3 text-teal" />
    {children}
  </Chip>
);

export const EveryProfileChip = () => (
  <Chip className="h-[22px] gap-1.5 px-2 text-sm text-text-2">
    <LayersIcon aria-hidden className="!size-3" />
    {t("library.row.everyProfile")}
  </Chip>
);

/** The row's last cell, from `statusOf`. */
export const StatusCell = ({ status }: { readonly status: ItemStatus }) => {
  switch (status.kind) {
    case "needs-sign-in":
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-faint">
          <KeyRoundIcon aria-hidden className="size-3" />
          {t("library.row.needsSignIn")}
        </span>
      );
    case "source-not-allowed":
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-faint">
          <LockIcon aria-hidden className="size-3" />
          {t("library.row.sourceNotAllowed")}
        </span>
      );
    case "update":
      return <UpdateChip>{status.text}</UpdateChip>;
    case "up-to-date":
      return <span className="text-sm text-faint">{t("library.row.upToDate")}</span>;
    default:
      return status satisfies never;
  }
};

/** A note (allowlist, scripts, refusals): a 2px left rule, an icon and `--muted` words; an error's rule and icon are red. Never a card, never amber. */
export const Note = ({ icon, tone = "plain", children, className, role }: { readonly icon: ReactNode; readonly tone?: "plain" | "error"; readonly children: ReactNode; readonly className?: string; readonly role?: "alert" | "status" }) => (
  <div className={cn("flex gap-2.5 border-l-2 py-1.5 pl-3 text-[13.5px] leading-[1.5] text-muted [&>svg]:mt-[3px] [&>svg]:size-[15px] [&>svg]:shrink-0", tone === "error" ? "border-red [&>svg]:text-red" : "border-line-3 [&>svg]:text-faint", className)} {...(role === undefined ? {} : { role })}>
    {icon}
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

/** The page's quiet info line: Lucide `info` and 12.5px `--faint` words. */
export const InfoLine = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => (
  <p className={cn("flex items-start gap-2 text-[12.5px] text-faint", className)}>
    <InfoIcon aria-hidden className="mt-[2px] size-[13px] shrink-0" />
    <span>{children}</span>
  </p>
);

/** `sha256 7c1e…4b09`: the whole hash in its `title` and a tooltip on focus. */
export const HashText = ({ hash, className }: { readonly hash: string; readonly className?: string }) => (
  <Tooltip content={<span className="break-all font-mono text-[12px]">{hash}</span>}>
    <span tabIndex={0} title={hash} className={cn("font-mono", className)} data-hash={hash}>
      {hashText(hash)}
    </span>
  </Tooltip>
);

/**
 * A sheet opened by a plain button (its state is in the address, or the page's own): when it
 * closes, the focus goes back to that button, as a Radix trigger's would.
 */
export const focusBack =
  (selector: string | undefined) =>
  (event: Event): void => {
    if (selector === undefined) return;
    const trigger = document.querySelector<HTMLElement>(selector);
    if (trigger === null) return;
    event.preventDefault();
    trigger.focus();
  };

/** A 12px weight-500 `--faint` label over a properties group or a section of a sheet. */
export const SheetSection = ({ title, count, note, children, className }: { readonly title: string; readonly count?: number; readonly note?: ReactNode; readonly children: ReactNode; readonly className?: string }) => (
  <section className={cn("mt-3.5", className)} aria-label={title}>
    <div className="mb-1.5 flex min-h-[26px] items-baseline gap-2">
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      {count === undefined ? null : <span className="font-mono text-[12px] text-faint">{count}</span>}
      {note === undefined ? null : <span className="ml-auto text-[12.5px] text-faint">{note}</span>}
    </div>
    {children}
  </section>
);
