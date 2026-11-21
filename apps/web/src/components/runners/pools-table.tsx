"use client";

import Link from "next/link";
import type { KeyboardEvent } from "react";

import { Chip } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { poolChips } from "./fleet-words";
import { versionRange } from "./runner-words";

export type Pool = RouterOutputs["pools"]["list"][number];

/** The busy meter (graphite.css `.meter`): 96 × 4px, `--muted` on `--line-2`. */
const Meter = ({ value, max }: { readonly value: number; readonly max: number }) => (
  <span
    role="meter"
    aria-valuemin={0}
    aria-valuemax={max}
    aria-valuenow={value}
    className="relative inline-block h-1 w-[44px] shrink-0 overflow-hidden rounded-full bg-line-2"
  >
    <span className="absolute inset-y-0 left-0 rounded-full bg-muted" style={{ width: `${String(max === 0 ? 0 : Math.min(100, (value / max) * 100))}%` }} />
  </span>
);

const th = "h-[30px] pr-3 text-left text-[12.5px] font-medium text-faint";

/** Organization › Runners › Pools: a selectable row per pool (runners.md, "Pools"). */
export const PoolsTable = ({ pools, selectedId, onSelect }: { readonly pools: readonly Pool[]; readonly selectedId: string | null; readonly onSelect: (poolId: string) => void }) => {
  const keyed = (poolId: string) => (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(poolId);
    }
  };
  return (
    <div className="overflow-x-auto">
      {/* At 1440 the page column is 744px (the double sidebar): every column fits it, and it scrolls only narrower. */}
      <table className="w-full min-w-[740px] border-collapse text-body">
        <colgroup>
          <col className="w-[168px]" />
          <col className="w-[72px]" />
          <col className="w-[92px]" />
          <col className="w-[112px]" />
          <col className="w-[56px]" />
          <col className="w-[64px]" />
          <col className="w-[76px]" />
          <col className="w-[60px]" />
          <col />
        </colgroup>
        <thead>
          <tr className="border-b border-line">
            <th className={cn(th, "pl-2.5")}>{t("runners.col.pool")}</th>
            <th className={th}>{t("runners.col.executor")}</th>
            <th className={th}>{t("runners.col.runners")}</th>
            <th className={th}>{t("runners.col.busy")}</th>
            <th className={th}>{t("runners.col.queue")}</th>
            <th className={th}>{t("runners.col.labels")}</th>
            <th className={th}>{t("runners.col.joinTokens")}</th>
            <th className={th}>{t("runners.col.projects")}</th>
            <th className={cn(th, "pr-2.5")}>{t("runners.col.version")}</th>
          </tr>
        </thead>
        <tbody>
          {pools.length === 0 ? (
            <tr className="border-b border-line">
              <td colSpan={9} className="h-10 px-2.5 text-muted">{t("runners.noPools")}</td>
            </tr>
          ) : null}
          {pools.map((pool) => {
            const selected = pool.id === selectedId;
            return (
              <tr
                key={pool.id}
                data-pool={pool.name}
                tabIndex={0}
                aria-selected={selected}
                data-state={selected ? "selected" : undefined}
                onClick={() => { onSelect(pool.id); }}
                onKeyDown={keyed(pool.id)}
                className={cn("h-10 cursor-pointer border-b border-line hover:bg-hover", selected && "bg-sel hover:bg-sel")}
              >
                <td className="pl-2.5 pr-3">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Link href={`/organization/runners/pools/${pool.id}`} onClick={(event) => { event.stopPropagation(); }} className="truncate font-medium hover:underline">{pool.name}</Link>
                    {pool.isDefault ? <Chip className="shrink-0">{t("runners.defaultPool")}</Chip> : null}
                    {poolChips(pool.lines).map((chip) => <Chip key={chip} className="shrink-0">{chip}</Chip>)}
                  </span>
                </td>
                <td className="pr-3 font-mono text-ui">{pool.executors.length === 0 ? "—" : pool.executors.join(", ")}</td>
                <td className="whitespace-nowrap pr-3 text-text">{t("runners.onlineCount", { online: pool.onlineCount, total: pool.runnerCount })}</td>
                <td className="pr-3">
                  {pool.slots === 0 ? (
                    <span className="text-faint">—</span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Meter value={pool.busy} max={pool.slots} />
                      <span className="shrink-0 whitespace-nowrap font-mono text-ui">{pool.busy} / {pool.slots}</span>
                    </span>
                  )}
                </td>
                <td className="pr-3 font-mono text-ui">{pool.queueLength === 0 ? <span className="text-faint">—</span> : pool.queueLength}</td>
                <td className="pr-3">
                  {pool.labels.length === 0 ? <span className="text-faint">—</span> : (
                    <span className="flex items-center gap-1.5">
                      {pool.labels.slice(0, 2).map((label) => <Chip key={label} className="font-mono text-[12.5px] text-text">{label}</Chip>)}
                      {pool.labels.length > 2 ? <span className="font-mono text-[12.5px] text-faint">+{pool.labels.length - 2}</span> : null}
                    </span>
                  )}
                </td>
                <td className="pr-3">
                  {pool.activeJoinTokens === 0 ? <span className="text-faint">{t("runners.noTokens")}</span> : t("runners.activeTokens", { n: pool.activeJoinTokens })}
                </td>
                <td className="pr-3 font-mono text-ui">{pool.projectCount}</td>
                <td className="pr-2.5 font-mono text-ui">{versionRange(pool.versions)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
