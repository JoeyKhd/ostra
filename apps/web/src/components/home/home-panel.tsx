"use client";

import type { ReactNode } from "react";

import { PropGroup } from "@/components/shell/page-frame";
import { cn } from "@/lib/cn";
import { formatCount, formatElapsed } from "@/lib/format";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { formatSpend, monthLong } from "./home-words";

type Overview = RouterOutputs["home"]["overview"];
type Day = Overview["prsMerged"]["days"][number];

const CHART_HEIGHT = 64;
const LABEL_SPACE = 16;

const dayLetter = (day: number): string => new Intl.DateTimeFormat("en-GB", { weekday: "narrow", timeZone: "UTC" }).format(new Date(day));

/**
 * The PRs-per-day chart (home.md, the right panel; the dataviz skill): seven Mist bars, today's in
 * `--line-2` as a partial day, a `--line` baseline, day letters under it, and direct labels only on
 * the peak and today. No gridlines and no axis numbers.
 */
export const PrChart = ({ days }: { readonly days: readonly Day[] }) => {
  const peak = Math.max(1, ...days.map((day) => day.count));
  const peakIndex = days.findIndex((day) => day.count === peak);
  const width = 264;
  const slot = width / days.length;
  const bar = Math.round(slot * 0.58);
  const top = 14;
  const base = top + CHART_HEIGHT;
  return (
    <svg
      role="img"
      aria-label={t("home.panel.chart", { counts: days.map((day) => String(day.count)).join(", ") })}
      viewBox={`0 0 ${String(width)} ${String(base + LABEL_SPACE)}`}
      className="mt-3 block w-full"
    >
      {days.map((day, i) => {
        const today = i === days.length - 1;
        const h = day.count === 0 ? 0 : Math.max(3, Math.round((day.count / peak) * CHART_HEIGHT));
        const x = Math.round(i * slot + (slot - bar) / 2);
        const labelled = today || (i === peakIndex && day.count > 0);
        return (
          <g key={day.day}>
            {h === 0 ? null : <rect x={x} y={base - h} width={bar} height={h} rx={2} fill={today ? "var(--chart-now)" : "var(--chart)"} />}
            {labelled ? (
              <text x={x + bar / 2} y={base - h - 4} textAnchor="middle" className="fill-muted font-mono text-xs">
                {day.count}
              </text>
            ) : null}
            <text x={x + bar / 2} y={base + 13} textAnchor="middle" className="fill-faint font-mono text-xs">
              {today ? t("home.panel.today") : dayLetter(day.day)}
            </text>
          </g>
        );
      })}
      <line x1={0} x2={width} y1={base + 0.5} y2={base + 0.5} stroke="var(--line)" />
    </svg>
  );
};

const Meter = ({ value, max, warn = false }: { readonly value: number; readonly max: number; readonly warn?: boolean }) => {
  const share = max <= 0 ? 0 : Math.min(1, value / max);
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-line-2" role="presentation">
      <div className={cn("h-full rounded-full", warn && share > 0.9 ? "bg-red" : "bg-muted")} style={{ width: `${String(Math.round(share * 100))}%` }} />
    </div>
  );
};

/** A group of the panel whose title line carries a figure on the right, split like `PropGroup`. */
const Group = ({ children }: { readonly children: ReactNode }) => <div className="mb-3.5 border-b border-line pb-3.5 last:border-b-0">{children}</div>;

/** "1,042 opened · 23 min median to first PR", or only the opened count with no first PR this week. */
const prLine = (prs: Overview["prsMerged"], opened: number): string => {
  const count = t("home.panel.prsOpened", { n: formatCount(opened) });
  return prs.firstPrMedianMs === null ? count : t("home.panel.firstPr", { opened: count, median: formatElapsed(0, prs.firstPrMedianMs) });
};

/**
 * Home's right panel (home.md, "The right panel"): the PRs merged this week with the median time to
 * a first PR, the month's spend against the organization's budget, and the runner pools.
 */
export const HomePanel = ({ overview, now }: { readonly overview: Overview | undefined; readonly now: Date }) => {
  const busy = overview?.pools.reduce((sum, pool) => sum + pool.busy, 0);
  return (
    <div data-testid="home-panel">
      <PropGroup title={t("home.panel.prsMerged")}>
        <div className="font-title text-[31px] leading-[1.15] font-bold tracking-[-0.015em]">{overview === undefined ? "–" : formatCount(overview.prsMerged.total)}</div>
        <div className="mt-0.5 text-ui text-muted">{overview === undefined ? "–" : prLine(overview.prsMerged, overview.prsOpened.total)}</div>
        {overview === undefined ? null : <PrChart days={overview.prsMerged.days} />}
      </PropGroup>
      <Group>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-faint" suppressHydrationWarning>
            {t("home.panel.spend", { month: monthLong(now) })}
          </h3>
          <span className="font-mono text-ui text-text">
            {overview === undefined
              ? "–"
              : overview.spendCap === null
                ? formatSpend(overview.spendMonth)
                : t("home.panel.spendOf", { spent: formatSpend(overview.spendMonth ?? 0), cap: formatSpend(overview.spendCap) })}
          </span>
        </div>
        {/* Over 90% the fill turns red, never amber (amber means only "needs you"). */}
        {overview === undefined || overview.spendCap === null ? null : <Meter value={overview.spendMonth ?? 0} max={overview.spendCap} warn />}
      </Group>
      <Group>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-faint">{t("home.panel.pools")}</h3>
          <span className="font-mono text-sm text-faint">
            {overview === undefined || busy === undefined ? "–" : t("home.panel.poolsFigure", { busy, queued: overview.summary.queued })}
          </span>
        </div>
        {overview === undefined ? null : overview.pools.length === 0 ? (
          <p className="py-1 text-ui text-faint">{t("home.panel.noRunners")}</p>
        ) : (
          <ul className="space-y-3 pt-1.5" data-testid="home-pools">
            {overview.pools.map((pool) => (
              <li key={pool.id}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-ui">{pool.name}</span>
                  <span className="ml-auto font-mono text-ui text-muted tabular-nums">{t("home.panel.poolFigure", { busy: pool.busy, slots: pool.slots })}</span>
                </div>
                <Meter value={pool.busy} max={pool.slots} />
              </li>
            ))}
          </ul>
        )}
      </Group>
    </div>
  );
};
