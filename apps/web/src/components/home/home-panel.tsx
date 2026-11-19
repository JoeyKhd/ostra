"use client";

import type { ReactNode } from "react";

import { PropGroup } from "@/components/shell/page-frame";
import { Status } from "@/components/ui/status";
import { formatCount } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { formatSpend, monthLong } from "./home-words";

type Overview = RouterOutputs["home"]["overview"];
type Day = Overview["prsOpened"]["days"][number];

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
            {h === 0 ? null : <rect x={x} y={base - h} width={bar} height={h} rx={2} fill={today ? "var(--line-2)" : "var(--mist)"} />}
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

const Meter = ({ value, max }: { readonly value: number; readonly max: number }) => {
  const share = max <= 0 ? 0 : Math.min(1, value / max);
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-line-2" role="presentation">
      <div className="h-full rounded-full bg-muted" style={{ width: `${String(Math.round(share * 100))}%` }} />
    </div>
  );
};

/** A group of the panel whose title line carries a figure on the right, split like `PropGroup`. */
const Group = ({ children }: { readonly children: ReactNode }) => <div className="mb-3.5 border-b border-line pb-3.5 last:border-b-0">{children}</div>;

/** Home's right panel in milestone 1 (home.md): PRs opened, spend this month, and the runners. */
export const HomePanel = ({ overview, now }: { readonly overview: Overview | undefined; readonly now: Date }) => {
  const busy = overview?.runners.filter((runner) => runner.running > 0).length;
  return (
    <div data-testid="home-panel">
      <PropGroup title={t("home.panel.prsOpened")}>
        <div className="font-title text-[31px] leading-[1.15] font-bold tracking-[-0.015em]">{overview === undefined ? "–" : formatCount(overview.prsOpened.total)}</div>
        <div className="mt-0.5 text-ui text-muted">
          {overview === undefined ? "–" : plural(overview.summary.prsToday, "home.panel.prsToday.one", "home.panel.prsToday.other")}
        </div>
        {overview === undefined ? null : <PrChart days={overview.prsOpened.days} />}
      </PropGroup>
      <Group>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-faint" suppressHydrationWarning>
            {t("home.panel.spend", { month: monthLong(now) })}
          </h3>
          <span className="font-mono text-ui text-text">{overview === undefined ? "–" : formatSpend(overview.spendMonth)}</span>
        </div>
      </Group>
      <Group>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-faint">{t("home.panel.runners")}</h3>
          <span className="font-mono text-sm text-faint">
            {overview === undefined || busy === undefined ? "–" : t("home.panel.runnersFigure", { busy, queued: overview.summary.queued })}
          </span>
        </div>
        {overview === undefined ? null : overview.runners.length === 0 ? (
          <p className="py-1 text-ui text-faint">{t("home.panel.noRunners")}</p>
        ) : (
          <ul className="space-y-2.5 pt-1" data-testid="home-runners">
            {overview.runners.map((runner) => (
              <li key={runner.id}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate">{runner.name}</span>
                  <Status tone={runner.online ? "green" : "grey"} className="text-sm text-muted">
                    {runner.online ? t("home.panel.online") : t("home.panel.offline")}
                  </Status>
                  <span className="ml-auto font-mono text-ui text-muted tabular-nums">
                    {runner.running} / {runner.capacity}
                  </span>
                </div>
                <Meter value={runner.running} max={runner.capacity} />
              </li>
            ))}
          </ul>
        )}
      </Group>
    </div>
  );
};
