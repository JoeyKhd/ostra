"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Chip } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { carrierText, versionChip } from "./fleet-words";
import { RunnerRowMenu } from "./runner-actions";
import { runnerAge, runnerDot, runnerStateText } from "./runner-words";
import type { RunnerDot, RunnerState } from "./runner-words";

type Listed = RouterOutputs["runners"]["list"][number];
type Mine = RouterOutputs["runners"]["mine"][number];

/**
 * The one column template of every runner row, in Runners and Your machine alike, so the columns
 * line up across both sections: state, name, pool or owner, executor, carrier, busy, version, age,
 * and the row menu.
 */
export const runnerGrid = "grid grid-cols-[100px_minmax(0,112px)_minmax(0,1fr)_68px_minmax(0,84px)_92px_minmax(64px,auto)_minmax(0,92px)_24px] items-center";

const dotClass: Record<RunnerDot, string> = {
  green: "bg-green shadow-(--dot-green)",
  half: "border border-faint bg-[linear-gradient(90deg,var(--faint)_50%,transparent_50%)]",
  ring: "border-[1.5px] border-faint bg-transparent",
  grey: "bg-faint",
};

/** A runner's state: its dot and its word, always both (colour never stands alone). */
export const RunnerStatus = ({ state, text }: { readonly state: RunnerState; readonly text?: string }) => (
  <span className="inline-flex items-center gap-2.5">
    <span aria-hidden className={cn("inline-block size-[9px] shrink-0 rounded-full", dotClass[runnerDot(state)])} />
    <span className="whitespace-nowrap text-text">{text ?? runnerStateText(state)}</span>
  </span>
);

const busyText = (runner: { readonly state: RunnerState; readonly busy: number; readonly capacity: number }): string =>
  runner.state === "joining" || runner.state === "offline" ? "—" : t("runners.busyOf", { busy: runner.busy, slots: runner.capacity });

type RowRunner = {
  readonly id: string;
  readonly name: string;
  readonly state: RunnerState;
  readonly executor: string;
  readonly busy: number;
  readonly capacity: number;
  readonly version: string;
  readonly lastSeenAt: number | null;
};

const Row = ({ runner, where, carrier, chip, menu, now }: {
  readonly runner: RowRunner;
  readonly where: ReactNode;
  readonly carrier: string;
  readonly chip: string | null;
  readonly menu: ReactNode;
  readonly now: number;
}) => (
  <li data-runner={runner.name} className={cn(runnerGrid, "group h-[38px] px-2 hover:bg-sel")}>
    <RunnerStatus state={runner.state} />
    <Link href={`/organization/runners/${runner.id}`} className="truncate pr-3 font-mono text-ui text-text hover:underline" title={runner.name}>{runner.name}</Link>
    <span className="flex min-w-0 items-center gap-2 pr-3 text-muted">{where}</span>
    <span className="font-mono text-ui text-text">{runner.executor}</span>
    <span className="text-ui text-muted">{carrier}</span>
    <span className="font-mono text-ui text-muted">{busyText(runner)}</span>
    <span className="flex items-center gap-2 font-mono text-ui text-muted">
      v{runner.version}
      {chip === null ? null : <Chip className="font-sans text-[12px]">{chip}</Chip>}
    </span>
    <span className="truncate text-right text-muted">{runnerAge(runner.state, runner.lastSeenAt, now)}</span>
    <span className="text-right">{menu}</span>
  </li>
);

const NotIsolated = ({ isolated }: { readonly isolated: boolean }) => (isolated ? null : <Chip className="shrink-0">{t("runners.notIsolated")}</Chip>);

/** Pool runners and other members' personal runners, each with its row menu (ticket 31). */
export const RunnerRows = ({ runners, now }: { readonly runners: readonly Listed[]; readonly now: number }) => (
  <ul className="rows">
    {runners.map((runner) => (
      <Row
        key={runner.id}
        runner={runner}
        now={now}
        carrier={runner.connection === null ? "—" : carrierText(runner.connection.carrier)}
        chip={versionChip(runner.versionState)}
        menu={
          <span className="opacity-100 xl:opacity-0 xl:group-focus-within:opacity-100 xl:group-hover:opacity-100">
            <RunnerRowMenu runner={{ id: runner.id, name: runner.name, kind: runner.kind, state: runner.state, busy: runner.busy, minor: runner.minor, awaitingApproval: runner.awaitingApproval, poolName: runner.pool?.name ?? null }} />
          </span>
        }
        where={
          runner.kind === "personal" ? (
            <>
              <span className="truncate">{t("runners.personalOf", { name: runner.owner?.name ?? t("common.unknown") })}</span>
              <NotIsolated isolated={runner.isolated} />
            </>
          ) : runner.pool === null ? (
            <span className="truncate">—</span>
          ) : (
            <Link href={`/organization/runners/pools/${runner.pool.id}`} className="truncate hover:text-text hover:underline">{runner.pool.name}</Link>
          )
        }
      />
    ))}
  </ul>
);

/** The member's own personal runners (Your machine): each row opens its page, where Revoke is. */
export const MyRunnerRows = ({ runners, now }: { readonly runners: readonly Mine[]; readonly now: number }) => (
  <ul className="rows" data-testid="my-runners">
    {runners.map((runner) => (
      <Row
        key={runner.id}
        runner={runner}
        now={now}
        carrier="—"
        chip={null}
        menu={null}
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
