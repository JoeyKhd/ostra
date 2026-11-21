"use client";

import { BoxIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";

import { orderedPreviews, originOf } from "./preview-pane-state";
import type { PreviewItem, PreviewOrigin } from "./preview-pane-state";

// The service switcher and its menu (task-preview.md, "The services menu"; `task-preview-services`):
// the task's previews, primary first, each with its source, and for the agent's own `Keep it for
// {project}`, which turns it into an environment proposal (F-140). Detected ports come later
// (Q313), so the menu lists none.

/** The state dot: `--green` live, `--faint` starting, asleep or stopped. */
export const StateDot = ({ live, className }: { readonly live: boolean; readonly className?: string }) => (
  <span aria-hidden className={cn("inline-block size-[7px] shrink-0 rounded-full", live ? "bg-green" : "bg-faint", className)} />
);

const Chip = ({ children }: { readonly children: string }) => (
  <span className="inline-flex h-[22px] shrink-0 items-center rounded-[5px] border border-line-2 px-1.5 text-[12px] text-muted">{children}</span>
);

const originKey = { declared: "task.preview.services.declared", service: "task.preview.services.service", announced: "task.preview.services.announced" } as const satisfies Record<PreviewOrigin, MessageKey>;
const subKey = { declared: "task.preview.services.declaredNote", service: "task.preview.services.serviceNote", announced: "task.preview.services.announcedNote" } as const satisfies Record<PreviewOrigin, MessageKey>;

export type ServicesMenuProps = {
  readonly taskKey: string;
  readonly projectName: string;
  readonly previews: readonly PreviewItem[];
  readonly selected: PreviewItem | null;
  readonly live: boolean;
  readonly onSelect: (item: PreviewItem) => void;
  /** "Keep it" on an agent's preview; `null` when the member can't. */
  readonly onKeep: ((item: PreviewItem) => void) | null;
  /** The environment's page, for a project admin; `null` for anyone else. */
  readonly environmentHref: string | null;
  /** The phone's toolbar shows the label alone. */
  readonly compact?: boolean;
};

export const PreviewServicesMenu = ({ taskKey, projectName, previews, selected, live, onSelect, onKeep, environmentHref, compact = false }: ServicesMenuProps) => {
  const ordered = orderedPreviews(previews);
  if (selected === null) {
    return (
      <span className="inline-flex h-[30px] shrink-0 items-center gap-[7px] rounded-md border border-line-2 bg-surface px-2.5 text-[13.5px] text-faint max-lg:h-11" data-testid="preview-switcher">
        {t("task.preview.noPreview")}
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="preview-switcher"
        aria-label={t("task.preview.services.trigger", { label: selected.label, port: selected.port })}
        className="inline-flex h-[30px] shrink-0 items-center gap-[7px] rounded-md border border-control-line bg-surface pl-2.5 pr-2 font-mono text-[13.5px] text-text hover:bg-sel data-[state=open]:border-control-line data-[state=open]:bg-sel max-lg:h-11"
      >
        <StateDot live={live} />
        <span className="max-w-[140px] truncate">{selected.label}</span>
        {compact ? null : <span className="text-faint">:{selected.port}</span>}
        <ChevronDownIcon aria-hidden className="size-[14px] text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[380px] max-w-[calc(100vw-24px)] rounded-[10px] p-1.5" data-testid="preview-services">
        <DropdownMenuLabel className="px-2.5 text-[12px]">{t("task.preview.services.title", { key: taskKey })}</DropdownMenuLabel>
        {ordered.map((item) => {
          const origin = originOf(item);
          const current = item.key === selected.key;
          return (
            <DropdownMenuItem
              key={item.key}
              data-preview-key={item.key}
              onSelect={() => { onSelect(item); }}
              className={cn("grid h-auto grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-2.5 py-[7px]", current && "bg-sel")}
            >
              <StateDot live={live && current} />
              <span className="flex min-w-0 items-center gap-2 font-mono text-[14px] text-text">
                <span className="truncate">{item.label}</span>
                <span className="shrink-0 text-faint">:{item.port}</span>
                {item.primary ? <Chip>{t("task.preview.services.primary")}</Chip> : null}
              </span>
              <span className="flex items-center gap-1.5">
                <Chip>{t(originKey[origin])}</Chip>
                {current ? <CheckIcon aria-hidden className="text-text" /> : null}
              </span>
              <span className="col-start-2 col-end-4 text-[12.5px] text-faint">
                {t(subKey[origin])}
                {origin === "announced" && onKeep !== null ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="text-teal hover:underline"
                      onPointerDown={(event) => { event.stopPropagation(); }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onKeep(item);
                      }}
                    >
                      {t("task.preview.services.keep", { project: projectName })}
                    </button>
                  </>
                ) : null}
              </span>
            </DropdownMenuItem>
          );
        })}
        {environmentHref === null ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={environmentHref}>
                <BoxIcon aria-hidden className="text-faint" />
                {t("task.preview.services.environment")}
              </Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
