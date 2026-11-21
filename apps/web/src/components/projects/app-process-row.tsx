"use client";

import { AppWindowIcon, FileSearchIcon, GripVerticalIcon, XIcon } from "lucide-react";
import Link from "next/link";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dot } from "@/components/ui/status";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { lastBoxWhere, lastBoxWords, readyWords, whereText } from "./environment-app-words";

// A row of the App tab's table (environment-app-processes.md, "App processes"): a declared process,
// one kept from a task waiting on a project admin, or one detection found in the repo and the list
// lacks. One union, one exhaustive switch. A process's command is the repo's own: shown to the
// project's members as text, never logged.

type List = RouterOutputs["environments"]["appProcesses"]["list"];
export type DeclaredProcess = List["processes"][number];
export type KeptProcess = List["kept"][number];
export type FoundProcess = RouterOutputs["environments"]["appProcesses"]["detected"]["processes"][number];

export type AppRow =
  | { readonly kind: "declared"; readonly process: DeclaredProcess; readonly index: number; readonly count: number }
  | { readonly kind: "kept"; readonly kept: KeptProcess }
  | { readonly kind: "found"; readonly found: FoundProcess };

/** The table's column count: handle, process, port, ready when, last box, remove. */
export const APP_COLUMNS = 6;

export type RowActions = {
  /** A project admin edits; a member reads. */
  readonly canEdit: boolean;
  readonly repoName: (repoId: string) => string;
  readonly now: number;
  readonly onOpen: () => void;
  readonly onRemove?: () => void;
  readonly onMove?: (to: number) => void;
  readonly onDragStart?: () => void;
  readonly onDragEnd?: () => void;
  /** A row dragged onto this one moves to its place. */
  readonly onDropHere?: () => void;
  readonly dragging?: boolean;
  /** The kept row's `Dismiss`, the found row's `Ignore`. */
  readonly onSecondary?: () => void;
  readonly busy?: boolean;
};

/** Line 1: the name in mono, the label, and the `primary` chip. */
const NameLine = ({ name, label, primary }: { readonly name: string; readonly label: string; readonly primary: boolean }) => (
  <span className="flex min-w-0 items-center gap-2">
    <span className="shrink-0 font-mono text-[14px] font-medium text-text">{name}</span>
    <span className="min-w-0 truncate text-ui text-muted">{label}</span>
    {primary ? <span className="inline-flex h-[22px] shrink-0 items-center rounded-[5px] border border-line-2 px-2 text-xs text-muted" data-testid="primary-chip">{t("environment.app.primary")}</span> : null}
  </span>
);

const ReadyCell = ({ ready }: { readonly ready: DeclaredProcess["ready"] }) => {
  const words = readyWords(ready);
  return (
    <span className="block truncate text-ui text-muted" title={words.mono ?? undefined}>
      {words.words}
      {words.mono === null ? null : <span className="ml-1 font-mono text-text">{words.mono}</span>}
    </span>
  );
};

/** The `Kept from a task` and `Found in the repo, not added` bands, inside the table. */
export const BandRow = ({ icon, title, count }: { readonly icon: "kept" | "found"; readonly title: string; readonly count: number }) => (
  <tr>
    <td colSpan={APP_COLUMNS} className="pt-1.5">
      <div className="flex h-[30px] items-center gap-2 rounded-[6px] bg-surface px-3">
        {icon === "kept" ? <AppWindowIcon aria-hidden className="size-[14px] stroke-[1.75] text-muted" /> : <FileSearchIcon aria-hidden className="size-[14px] stroke-[1.75] text-muted" />}
        <span className="text-[13.5px] font-semibold text-text">{title}</span>
        <span className="font-mono text-sm text-faint">{count}</span>
      </div>
    </td>
  </tr>
);

/** The two buttons at a band row's end, across the last two columns. */
const RowButtons = ({ secondary, primary, onSecondary, onPrimary, busy, testid }: { readonly secondary: string; readonly primary: string; readonly onSecondary: (() => void) | undefined; readonly onPrimary: () => void; readonly busy: boolean; readonly testid: string }) => (
  <TableCell colSpan={2} className="h-[52px] text-right">
    <span className="inline-flex items-center gap-1.5" data-testid={testid}>
      <Button size="sm" variant="ghost" className="max-sm:h-11" disabled={busy || onSecondary === undefined} onClick={onSecondary}>{secondary}</Button>
      <Button size="sm" className="max-sm:h-11" disabled={busy} onClick={onPrimary}>{primary}</Button>
    </span>
  </TableCell>
);

/** Moves the focus to the next or the previous declared row (↑ and ↓ in the table). */
const moveFocus = (event: KeyboardEvent<HTMLTableRowElement>, step: number): void => {
  const rows = [...(event.currentTarget.closest("tbody")?.querySelectorAll<HTMLTableRowElement>("tr[data-process]") ?? [])];
  const at = rows.indexOf(event.currentTarget);
  rows[at + step]?.focus();
};

export const AppProcessRow = ({ row, actions }: { readonly row: AppRow; readonly actions: RowActions }) => {
  switch (row.kind) {
    case "declared": {
      const { process, index, count } = row;
      const last = lastBoxWords(process.lastBox);
      const where = whereText(actions.repoName(process.repoId), process.folder);
      const reorderable = actions.canEdit && count > 1 && actions.onMove !== undefined;
      const lastCell: ReactNode = (
        <span className="inline-flex min-w-0 items-center gap-[7px] whitespace-nowrap" data-last-box={process.lastBox?.state ?? "none"}>
          {last.tone === null ? null : <Dot tone={last.tone} />}
          <span className={cn("text-ui", last.tone === null ? "text-faint" : "text-text")}>{last.word}</span>
          {last.extra === null ? null : <span className="font-mono text-[12.5px] text-faint">{last.extra}</span>}
        </span>
      );
      return (
        <TableRow
          data-process={process.name}
          tabIndex={0}
          aria-label={t("environment.app.openProcess", { name: process.name })}
          className={cn("cursor-pointer hover:bg-hover focus-visible:bg-hover focus-visible:-outline-offset-2", actions.dragging === true && "opacity-50")}
          onClick={actions.onOpen}
          {...(reorderable
            ? {
                onDragOver: (event: DragEvent<HTMLTableRowElement>) => { event.preventDefault(); },
                onDrop: (event: DragEvent<HTMLTableRowElement>) => {
                  event.preventDefault();
                  actions.onDropHere?.();
                },
              }
            : {})}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter") {
              event.preventDefault();
              actions.onOpen();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(event, event.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          <TableCell className="h-[52px] max-sm:h-16">
            {reorderable ? (
              <button
                type="button"
                draggable
                aria-label={t("environment.app.handle", { name: process.name })}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                className="hidden size-5 cursor-grab place-items-center rounded-sm align-middle text-faint hover:text-muted sm:inline-grid"
                onClick={(event) => { event.stopPropagation(); }}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  actions.onDragStart?.();
                }}
                onDragEnd={actions.onDragEnd}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                  event.preventDefault();
                  actions.onMove?.(event.key === "ArrowUp" ? index - 1 : index + 1);
                }}
              >
                <GripVerticalIcon aria-hidden className="size-[14px] stroke-[1.75]" />
              </button>
            ) : null}
          </TableCell>
          <TableCell className="h-[52px] pr-3 max-sm:h-16">
            <span className="block min-w-0" title={process.command}>
              <NameLine name={process.name} label={process.label} primary={process.primary} />
              <span className="mt-0.5 block truncate font-mono text-[12.5px] text-faint">
                {where}
                <span aria-hidden> · </span>
                <span className="text-muted">{process.command}</span>
              </span>
              {/* Phone: the port and the ready check under the name, in mono. */}
              <span className="mt-0.5 block truncate font-mono text-xs text-faint sm:hidden">
                {process.port} · {readyWords(process.ready).words} {readyWords(process.ready).mono ?? ""}
              </span>
              <span className="mt-0.5 block lg:hidden">{lastCell}</span>
            </span>
          </TableCell>
          <TableCell className="h-[52px] font-mono text-[13.5px] text-text max-sm:hidden">{process.port}</TableCell>
          <TableCell className="h-[52px] pr-3 max-sm:hidden"><ReadyCell ready={process.ready} /></TableCell>
          <TableCell className="h-[52px] max-lg:hidden">
            {process.lastBox === null ? lastCell : <Tooltip content={lastBoxWhere(process.lastBox.runnerName, process.lastBox.at, actions.now)}><span className="inline-flex">{lastCell}</span></Tooltip>}
          </TableCell>
          <TableCell className="h-[52px] text-right">
            {actions.canEdit && actions.onRemove !== undefined ? (
              <button
                type="button"
                aria-label={t("environment.app.remove", { name: process.name })}
                className="inline-grid size-6 place-items-center rounded-sm text-faint hover:bg-hover hover:text-red"
                onClick={(event) => {
                  event.stopPropagation();
                  actions.onRemove?.();
                }}
                onKeyDown={(event) => { event.stopPropagation(); }}
              >
                <XIcon aria-hidden className="size-[14px] stroke-[1.75]" />
              </button>
            ) : null}
          </TableCell>
        </TableRow>
      );
    }
    case "kept": {
      const { kept } = row;
      const age = formatAge(kept.createdAt, actions.now);
      return (
        <TableRow data-kept={kept.process.name} className="border-b-0">
          <TableCell className="h-[52px]">
            {/* The project admins' needs-you (an `environment_proposal`); members see none. */}
            {actions.canEdit ? <Dot tone="amber" className="ml-1.5" /> : null}
          </TableCell>
          <TableCell className="h-[52px] pr-3">
            <span className="block min-w-0">
              <NameLine name={kept.process.name} label={kept.process.label} primary={false} />
              <span className="mt-0.5 block truncate text-ui text-muted">
                {t("environment.app.keptBy", { name: kept.keptBy?.name ?? t("environment.app.someone") })}{" "}
                <Link href={`/tasks/${kept.task.taskId}`} className="font-mono text-[12.5px] text-muted hover:underline" onClick={(event) => { event.stopPropagation(); }}>{kept.task.key}</Link>
                <span aria-hidden> · </span>
                {age === t("units.now") ? t("environment.justNow") : t("environment.ago", { age })}
              </span>
            </span>
          </TableCell>
          <TableCell className="h-[52px] font-mono text-[13.5px] text-text max-sm:hidden">{kept.process.port}</TableCell>
          <TableCell className="h-[52px] pr-3 max-sm:hidden"><ReadyCell ready={kept.process.ready} /></TableCell>
          {actions.canEdit ? (
            <RowButtons secondary={t("environment.app.dismiss")} primary={t("environment.app.review")} onSecondary={actions.onSecondary} onPrimary={actions.onOpen} busy={actions.busy === true} testid="kept-actions" />
          ) : (
            <TableCell colSpan={2} className="h-[52px]" />
          )}
        </TableRow>
      );
    }
    case "found": {
      const { found } = row;
      const where = whereText(actions.repoName(found.repoId), found.process.folder);
      return (
        <TableRow data-found={found.process.name} className="border-b-0">
          <TableCell className="h-[52px]" />
          <TableCell className="h-[52px] pr-3">
            <span className="block min-w-0" title={where}>
              <NameLine name={found.process.name} label={found.process.label} primary={false} />
              <span className="mt-0.5 block truncate font-mono text-[12.5px] text-faint">
                {found.process.source}
                {found.process.command === null ? null : (
                  <>
                    <span aria-hidden> · </span>
                    <span className="text-muted">{found.process.command}</span>
                  </>
                )}
              </span>
            </span>
          </TableCell>
          <TableCell className="h-[52px] font-mono text-[13.5px] text-text max-sm:hidden">{found.process.port}</TableCell>
          <TableCell className="h-[52px] pr-3 text-muted max-sm:hidden">{t("environment.app.none")}</TableCell>
          {actions.canEdit ? (
            <RowButtons secondary={t("environment.app.ignore")} primary={t("environment.app.add")} onSecondary={actions.onSecondary} onPrimary={actions.onOpen} busy={actions.busy === true} testid="found-actions" />
          ) : (
            <TableCell colSpan={2} className="h-[52px]" />
          )}
        </TableRow>
      );
    }
    default:
      return row satisfies never;
  }
};
