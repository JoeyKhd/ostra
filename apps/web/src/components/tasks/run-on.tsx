"use client";

import { ChevronDownIcon, LaptopIcon, ServerIcon } from "lucide-react";
import { useState } from "react";
import type { ComponentProps } from "react";

import { runnerStateText } from "@/components/runners/runner-words";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// "Run on", shared by New task and the Inbox's Start task (ticket 35, "Decided 2026-11-19"): the
// member's personal runners, then the project's pools; by default the first online personal
// runner, else the pools (milestone 1, task-new.md).

export type Runner = RouterOutputs["runners"]["mine"][number];

/** The choice that means "the project's pools". */
export const POOLS = "pools";

/** The run-on choice: what the member picked, else the first online personal runner, else the pools. */
export const useRunOn = (runners: readonly Runner[] | undefined) => {
  const [runOn, setRunOn] = useState<string | null>(null);
  const firstOnline = runners?.find((runner) => runner.state === "online")?.id;
  const chosen = runOn ?? firstOnline ?? POOLS;
  const runner = chosen === POOLS ? null : (runners?.find((item) => item.id === chosen) ?? null);
  return { chosen, runner, setRunOn };
};

/** A composer's ghost trigger: 30px, an icon, the value and a faint chevron. */
export const Trigger = ({ className, children, chevron = true, ...props }: ComponentProps<"button"> & { readonly chevron?: boolean }) => (
  <button
    type="button"
    className={cn(
      "inline-flex h-[30px] min-w-0 items-center gap-[7px] rounded-md px-2 text-ui font-medium text-text enabled:hover:bg-raise disabled:cursor-default data-[state=open]:bg-raise [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg]:text-muted",
      className,
    )}
    {...props}
  >
    {children}
    {chevron ? <ChevronDownIcon aria-hidden className="!size-3 !text-faint" /> : null}
  </button>
);

/** The Run on picker: a dropdown of the member's personal runners and the project's pools. */
export const RunOnPicker = ({ runners, runner, onPick, disabled }: {
  readonly runners: readonly Runner[] | undefined;
  readonly runner: Runner | null;
  readonly onPick: (value: string) => void;
  readonly disabled: boolean;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Trigger aria-label={t("newTask.runOnPick")} disabled={disabled || runners === undefined} data-testid="run-on">
        {runners === undefined ? <Skeleton className="w-[110px]" /> : runner === null ? (
          <>
            <ServerIcon aria-hidden />
            <span className="truncate">{t("newTask.pools")}</span>
          </>
        ) : (
          <>
            <LaptopIcon aria-hidden />
            <span className="truncate">{runner.name}</span>
            <span className="font-normal text-muted">· {t("newTask.yoursShort")}</span>
          </>
        )}
      </Trigger>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-[260px]">
      {(runners ?? []).map((item) => (
        <DropdownMenuItem key={item.id} onSelect={() => { onPick(item.id); }} data-runner={item.name}>
          <LaptopIcon aria-hidden />
          <span className="font-mono text-ui">{item.name}</span>
          <span className="text-muted">· {t("newTask.yoursShort")}</span>
          <span className="ml-auto pl-3 text-sm">
            {item.state === "online" ? <Status tone="green" className="text-muted">{t("newTask.online")}</Status> : <span className="text-faint">{runnerStateText(item.state)}</span>}
          </span>
        </DropdownMenuItem>
      ))}
      {(runners ?? []).length === 0 ? null : <DropdownMenuSeparator />}
      <DropdownMenuItem onSelect={() => { onPick(POOLS); }} data-runner={POOLS}>
        <ServerIcon aria-hidden />
        {t("newTask.pools")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);
