"use client";

import { useState } from "react";
import type { KeyboardEvent } from "react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/format";
import { t } from "@/lib/messages";

// The page's hand-written SVG charts (insights.md; the dataviz guidance): one hue, Mist (`--chart`),
// with `--chart-2` for the quieter series; no gridlines, no y axis, direct labels only where they
// help, and a table view of the PR chart for screen readers and copying.

/** A 100×30 line of one point a day; `null` is a gap. Hidden under three points. */
export const Sparkline = ({ values }: { readonly values: readonly (number | null)[] }) => {
  const known = values.filter((value): value is number => value !== null);
  if (values.length < 3 || known.length === 0) return null;
  const width = 100;
  const height = 30;
  const pad = 3;
  const max = Math.max(...known);
  const min = Math.min(...known);
  const span = max - min;
  const x = (i: number): number => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (value: number): number => (span === 0 ? height / 2 : pad + (1 - (value - min) / span) * (height - pad * 2));
  const runs: string[] = [];
  let run: string[] = [];
  values.forEach((value, i) => {
    if (value === null) {
      if (run.length > 0) runs.push(run.join(" "));
      run = [];
      return;
    }
    run.push(`${x(i).toFixed(1)},${y(value).toFixed(1)}`);
  });
  if (run.length > 0) runs.push(run.join(" "));
  const lastIndex = values.length - 1;
  const last = values[lastIndex] ?? null;
  return (
    <svg aria-hidden viewBox={`0 0 ${String(width)} ${String(height)}`} className="h-[30px] w-16 shrink-0 overflow-visible sm:w-[100px]" preserveAspectRatio="none" data-testid="sparkline">
      {runs.map((points) =>
        points.includes(" ") ? (
          <polyline key={points} points={points} fill="none" stroke="var(--chart)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        ) : null,
      )}
      {last === null ? null : <circle cx={x(lastIndex)} cy={y(last)} r={2} fill="var(--chart)" />}
    </svg>
  );
};

export type PrDay = { readonly day: string; readonly prsOpened: number; readonly prsMerged: number };

const dayLabel = (iso: string): string => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
const dayLong = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
const weekdayLetter = (iso: string): string => new Intl.DateTimeFormat("en-GB", { weekday: "narrow", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

/** Which days get a label: the first, every 7th (14th at 90 days or on a phone), and the last; every day at 7 days. */
const labelled = (i: number, count: number, step: number): boolean => count <= 7 || i === 0 || i === count - 1 || (i % step === 0 && count - 1 - i >= step / 2);

/**
 * Pull requests by day: a pair of bars a day (`Opened` in `--chart-2`, `Merged` in `--chart`), one
 * zero-based scale. Past 60 days the pairs become `Merged` bars with `Opened` as a line over them.
 * Today, a partial day, is drawn at half opacity. Hover or ←/→ shows a day's counts.
 */
export const PrChart = ({ days, endsToday, narrow }: { readonly days: readonly PrDay[]; readonly endsToday: boolean; readonly narrow: boolean }) => {
  const [active, setActive] = useState<number | null>(null);
  const width = 760;
  const plot = 150;
  const top = 18;
  const base = top + plot;
  const height = base + 22;
  const count = days.length;
  const slot = width / Math.max(1, count);
  const lineForm = count > 60;
  const peak = Math.max(1, ...days.map((day) => Math.max(day.prsOpened, day.prsMerged)));
  const h = (n: number): number => (n === 0 ? 0 : Math.max(2, (n / peak) * plot));
  // A day's pair fills most of its slot, the two bars almost touching (insights.webp).
  const pairWidth = slot * 0.78;
  const pairGap = 1.5;
  const bar = lineForm ? pairWidth : Math.max(1, (pairWidth - pairGap) / 2);
  const step = lineForm || narrow ? 14 : 7;
  const tallest = days.reduce((best, day, i) => ((days[best]?.prsOpened ?? 0) < day.prsOpened ? i : best), 0);
  const totals = days.reduce((sum, day) => ({ opened: sum.opened + day.prsOpened, merged: sum.merged + day.prsMerged }), { opened: 0, merged: 0 });
  const empty = totals.opened === 0 && totals.merged === 0;
  const onKey = (event: KeyboardEvent<SVGSVGElement>): void => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setActive((current) => Math.min(count - 1, (current ?? -1) + 1));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setActive((current) => Math.max(0, (current ?? count) - 1));
    } else if (event.key === "Escape") {
      setActive(null);
    }
  };
  const activeDay = active === null ? undefined : days[active];
  const linePoints = days.map((day, i) => `${(i * slot + slot / 2).toFixed(1)},${(base - h(day.prsOpened)).toFixed(1)}`).join(" ");
  return (
    <div className="relative">
      <svg
        role="img"
        tabIndex={0}
        aria-label={t("insights.chartLabel", { opened: totals.opened, merged: totals.merged })}
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        className="block w-full focus-visible:outline-2 focus-visible:outline-teal"
        onKeyDown={onKey}
        onMouseLeave={() => {
          setActive(null);
        }}
        onBlur={() => {
          setActive(null);
        }}
        data-testid="pr-chart"
      >
        {activeDay === undefined || active === null ? null : <rect x={active * slot} y={top - 10} width={slot} height={plot + 10} fill="var(--raise)" />}
        {days.map((day, i) => {
          const today = endsToday && i === count - 1;
          const x0 = i * slot + (slot - pairWidth) / 2;
          const opacity = today ? 0.5 : 1;
          const mergedX = lineForm ? x0 : x0 + bar + pairGap;
          const labelHere = !lineForm && !empty && (i === tallest || i === count - 1) && day.prsOpened > 0;
          // Today's bars are at half opacity; its count over them stays whole (F-081: text at 4.5:1).
          return (
            <g key={day.day}>
              <g opacity={opacity}>
                {lineForm || h(day.prsOpened) === 0 ? null : <path d={barPath(x0, base, bar, h(day.prsOpened))} fill="var(--chart-2)" />}
                {h(day.prsMerged) === 0 ? null : <path d={barPath(mergedX, base, bar, h(day.prsMerged))} fill="var(--chart)" />}
              </g>
              {labelHere ? (
                <text x={x0 + bar / 2} y={base - h(day.prsOpened) - 6} textAnchor="middle" className="fill-muted font-mono text-[12.5px]">
                  {day.prsOpened}
                </text>
              ) : null}
              <rect
                x={i * slot}
                y={top - 10}
                width={slot}
                height={plot + 10}
                fill="transparent"
                onMouseEnter={() => {
                  setActive(i);
                }}
              />
            </g>
          );
        })}
        {days.map((day, i) =>
          labelled(i, count, step) ? (
            <text key={`label-${day.day}`} x={i * slot + slot / 2} y={base + 16} textAnchor={i === 0 ? "start" : i === count - 1 ? "end" : "middle"} className="fill-faint font-mono text-[12.5px]">
              {endsToday && i === count - 1 ? t("insights.today") : count <= 7 ? weekdayLetter(day.day) : dayLabel(day.day)}
            </text>
          ) : null,
        )}
        {lineForm ? <polyline points={linePoints} fill="none" stroke="var(--chart-2)" strokeWidth={1.5} strokeLinejoin="round" pointerEvents="none" /> : null}
        <line x1={0} x2={width} y1={base + 0.5} y2={base + 0.5} stroke="var(--line)" />
      </svg>
      {empty ? <p className="pointer-events-none absolute inset-x-0 top-[70px] text-center text-sm text-faint">{t("insights.noPrs")}</p> : null}
      {activeDay === undefined || active === null ? null : (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 rounded-md border border-line-2 bg-raise px-2.5 py-1.5 text-sm shadow-(--shadow-pop)"
          style={{ left: `${String(Math.min(82, Math.max(0, ((active + 0.5) / count) * 100 - 8)))}%` }}
          data-testid="pr-chart-tip"
        >
          <div className="font-semibold text-text">{dayLong(activeDay.day)}</div>
          <div className="text-muted">
            <span className="font-mono text-text">{activeDay.prsOpened}</span> {t("insights.openedLower")}
          </div>
          <div className="text-muted">
            <span className="font-mono text-text">{activeDay.prsMerged}</span> {t("insights.mergedLower")}
          </div>
        </div>
      )}
    </div>
  );
};

/** A bar with a 3px rounded top, standing on the baseline. */
const barPath = (x: number, base: number, width: number, height: number): string => {
  const r = Math.min(3, width / 2, height);
  const top = base - height;
  return `M${x.toFixed(1)},${base.toFixed(1)}V${(top + r).toFixed(1)}Q${x.toFixed(1)},${top.toFixed(1)} ${(x + r).toFixed(1)},${top.toFixed(1)}H${(x + width - r).toFixed(1)}Q${(x + width).toFixed(1)},${top.toFixed(1)} ${(x + width).toFixed(1)},${(top + r).toFixed(1)}V${base.toFixed(1)}Z`;
};

/** The chart's table view: Day, Opened, Merged. */
export const PrTable = ({ days }: { readonly days: readonly PrDay[] }) => (
  <div className="max-h-[260px] overflow-y-auto" data-testid="pr-table">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("insights.day")}</TableHead>
          <TableHead num>{t("insights.opened")}</TableHead>
          <TableHead num>{t("insights.merged")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {days.map((day) => (
          <TableRow key={day.day}>
            <TableCell className="font-mono">{day.day}</TableCell>
            <TableCell num>{formatCount(day.prsOpened)}</TableCell>
            <TableCell num>{formatCount(day.prsMerged)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);

/** A 4px meter: `--meter` on `--line-2`. */
export const Meter = ({ value, max, className }: { readonly value: number; readonly max: number; readonly className?: string }) => {
  const share = max <= 0 ? 0 : Math.min(1, value / max);
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-[2px] bg-line-2", className)} role="presentation">
      <div className="h-full rounded-[2px] bg-meter" style={{ width: `${String(Math.round(share * 1000) / 10)}%` }} />
    </div>
  );
};
