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

import { waitReasonText } from "./task-waiting-words";

// "Run on", shared by New task and the Inbox's Start task (ticket 35, "Decided 2026-11-19"): the
// project's pools and the member's personal runners. Milestone 5 (ticket 33, app-targets/m1/task-new
// grown): "A pool" and "Your machine", each with whether it can take the task now and why not, from
// `tasks.runnerChoices`; one that can't is disabled with its reason, except a busy machine, which
// takes the task when a slot frees.

export type Runner = RouterOutputs["runners"]["mine"][number];
export type Choices = RouterOutputs["tasks"]["runnerChoices"];
type Personal = Choices["personal"][number];

/** The choice that means "the project's pools". */
export const POOLS = "pools";

/** A personal runner the member can't send this task to: offline, no services, the provider refused. */
export const personalBlocked = (choice: Personal | undefined): boolean => choice !== undefined && choice.reason !== null && choice.reason !== "busy";

/** Why "Your machine" can't take the task now, or `null` when it can. */
export const personalReasonText = (choice: Personal): string | null => {
  switch (choice.reason) {
    case null:
      return null;
    case "offline":
      return t("runPicker.offline");
    case "busy":
      return t("runPicker.busy", { busy: choice.busy, slots: choice.slots });
    case "needs-services":
      return t("runPicker.needsServices");
    case "provider-not-allowed":
      return t("runPicker.providerNotAllowed");
    default:
      return choice.reason satisfies never;
  }
};

/** Why "A pool" can't start the task now (it still queues), or `null`. */
export const poolReasonText = (choices: Choices, project: string): string | null => {
  if (choices.pool.pools.length === 0) return t("runPicker.noPools", { project });
  if (choices.pool.reason === null) return null;
  return t("runPicker.poolWaits", {
    reason: waitReasonText(choices.pool.reason, {
      project,
      poolNames: choices.pool.pools.map((pool) => pool.name),
      poolName: (poolId) => choices.pool.pools.find((pool) => pool.poolId === poolId)?.name ?? "",
      personal: null,
    }),
  });
};

/**
 * The run-on choice: what the member picked, else "A pool" when one of the project's pools can take
 * the task now, else the member's first personal runner that can, else "A pool" (it queues).
 */
export const useRunOn = (runners: readonly Runner[] | undefined, choices?: Choices) => {
  const [runOn, setRunOn] = useState<string | null>(null);
  const firstPersonal = choices === undefined ? runners?.find((runner) => runner.state === "online")?.id : choices.personal.find((choice) => choice.canRun)?.runnerId;
  const fallback = choices?.pool.canRun === true ? POOLS : (firstPersonal ?? POOLS);
  const picked = runOn !== null && (runOn === POOLS || !personalBlocked(choices?.personal.find((choice) => choice.runnerId === runOn))) ? runOn : null;
  const chosen = picked ?? fallback;
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

/** The Run on picker: "A pool", then the member's personal runners as "Your machine", each with its reason. */
export const RunOnPicker = ({ runners, runner, onPick, disabled, choices, project = "" }: {
  readonly runners: readonly Runner[] | undefined;
  readonly runner: Runner | null;
  readonly onPick: (value: string) => void;
  readonly disabled: boolean;
  /** Milestone 5: whether each can take the task now; without it the picker shows the runners' states. */
  readonly choices?: Choices | undefined;
  readonly project?: string;
}) => {
  const poolReason = choices === undefined ? null : poolReasonText(choices, project);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Trigger aria-label={t("newTask.runOnPick")} disabled={disabled || runners === undefined} data-testid="run-on">
          {runners === undefined ? <Skeleton className="w-[110px]" /> : runner === null ? (
            <>
              <ServerIcon aria-hidden />
              <span className="truncate">{t("runPicker.aPool")}</span>
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
      <DropdownMenuContent align="start" className="min-w-[320px] max-w-[380px]">
        <DropdownMenuItem
          onSelect={() => { onPick(POOLS); }}
          data-runner={POOLS}
          disabled={choices?.pool.pools.length === 0}
          className="h-auto min-h-[28px] flex-wrap py-1"
        >
          <ServerIcon aria-hidden />
          <span>{t("runPicker.aPool")}</span>
          <span className="ml-auto pl-3 text-sm text-faint">{choices?.pool.pools.map((pool) => pool.name).join(", ")}</span>
          {poolReason === null ? null : <span className="basis-full pl-[23px] text-xs text-muted" data-testid="run-on-pool-reason">{poolReason}</span>}
        </DropdownMenuItem>
        {(runners ?? []).length === 0 ? null : <DropdownMenuSeparator />}
        {(runners ?? []).map((item) => {
          const choice = choices?.personal.find((entry) => entry.runnerId === item.id);
          const reason = choice === undefined ? null : personalReasonText(choice);
          return (
            <DropdownMenuItem
              key={item.id}
              onSelect={() => { onPick(item.id); }}
              data-runner={item.name}
              disabled={personalBlocked(choice)}
              className="h-auto min-h-[28px] flex-wrap py-1"
            >
              <LaptopIcon aria-hidden />
              <span>{t("runPicker.yourMachine")}</span>
              <span className="font-mono text-ui text-muted">{item.name}</span>
              {reason === null ? (
                <span className="ml-auto pl-3 text-sm">
                  {item.state === "online" ? <Status tone="green" className="text-muted">{t("newTask.online")}</Status> : <span className="text-faint">{runnerStateText(item.state)}</span>}
                </span>
              ) : null}
              {reason === null ? null : <span className="basis-full pl-[23px] text-xs text-muted" data-testid="run-on-personal-reason">{reason}</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
