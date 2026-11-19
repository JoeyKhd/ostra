"use client";

import type { ReactNode } from "react";

import { Chip } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { runnerAge, runnerDot, runnerStateText } from "./runner-words";
import type { RunnerDot } from "./runner-words";

type Listed = RouterOutputs["runners"]["list"][number];
type Mine = RouterOutputs["runners"]["mine"][number];

/**
 * The one column template of every runner row, in Runners and Your machine alike, so the columns
 * line up across both sections: state, name, pool or owner, executor, busy, version, age.
 */
export const runnerGrid = "grid grid-cols-[124px_122px_minmax(0,166px)_92px_112px_minmax(80px,1fr)_104px] items-center";

const dotClass: Record<RunnerDot, string> = {
  green: "bg-green shadow-[0_0_0_3px_rgba(79,178,134,0.15)]",
  half: "border border-faint bg-[linear-gradient(90deg,var(--faint)_50%,transparent_50%)]",
  ring: "border-[1.5px] border-faint bg-transparent",
  grey: "bg-faint",
};

/** A runner's state: its dot and its word, always both (colour never stands alone). */
export const RunnerStatus = ({ state }: { readonly state: Listed["state"] }) => (
  <span className="inline-flex items-center gap-2.5">
    <span aria-hidden className={cn("inline-block size-[9px] shrink-0 rounded-full", dotClass[runnerDot(state)])} />
    <span className="text-text">{runnerStateText(state)}</span>
  </span>
);

const busyText = (runner: Pick<Listed, "state" | "busy" | "capacity">): string =>
  runner.state === "joining" || runner.state === "offline" ? "—" : t("runners.busyOf", { busy: runner.busy, slots: runner.capacity });

const Row = ({ runner, where, now }: { readonly runner: Listed | Mine; readonly where: ReactNode; readonly now: number }) => (
  <li data-runner={runner.name} className={cn(runnerGrid, "h-[38px] px-2")}>
    <RunnerStatus state={runner.state} />
    <span className="truncate pr-3 font-mono text-[12.5px] text-text" title={runner.name}>{runner.name}</span>
    <span className="flex min-w-0 items-center gap-2 pr-3 text-muted">{where}</span>
    <span className="font-mono text-[12.5px] text-text">{runner.executor}</span>
    <span className="font-mono text-[12.5px] text-muted">{busyText(runner)}</span>
    <span className="font-mono text-[12.5px] text-muted">v{runner.version}</span>
    <span className="truncate text-right text-muted">{runnerAge(runner.state, runner.lastSeenAt, now)}</span>
  </li>
);

const NotIsolated = ({ isolated }: { readonly isolated: boolean }) => (isolated ? null : <Chip className="shrink-0">{t("runners.notIsolated")}</Chip>);

/** Pool runners and other members' personal runners. */
export const RunnerRows = ({ runners, now }: { readonly runners: readonly Listed[]; readonly now: number }) => (
  <ul className="rows">
    {runners.map((runner) => (
      <Row
        key={runner.id}
        runner={runner}
        now={now}
        where={
          runner.kind === "personal" ? (
            <>
              <span className="truncate">{t("runners.personalOf", { name: runner.owner?.name ?? t("common.unknown") })}</span>
              <NotIsolated isolated={runner.isolated} />
            </>
          ) : (
            <span className="truncate">{runner.pool?.name ?? "—"}</span>
          )
        }
      />
    ))}
  </ul>
);

/** The member's own personal runners. */
export const MyRunnerRows = ({ runners, now }: { readonly runners: readonly Mine[]; readonly now: number }) => (
  <ul className="rows" data-testid="my-runners">
    {runners.map((runner) => (
      <Row
        key={runner.id}
        runner={runner}
        now={now}
        where={
          <>
            <span className="truncate">{t("runners.personal")}</span>
            <NotIsolated isolated={runner.isolated} />
          </>
        }
      />
    ))}
  </ul>
);
