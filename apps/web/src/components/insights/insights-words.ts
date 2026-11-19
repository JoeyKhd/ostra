import type { MessageKey } from "@/lib/messages";
import { t } from "@/lib/messages";

// Insights in the panel's words (insights.md): the period in the URL, and money, durations and
// token counts in the page's short forms.

const DAY_MS = 86_400_000;

export type Preset = 7 | 30 | 90;

/** The period the URL names: `?period=7d|30d|90d` or `?from=YYYY-MM-DD&to=YYYY-MM-DD`; 30 days by default. */
export type PeriodChoice = { readonly kind: "preset"; readonly days: Preset } | { readonly kind: "range"; readonly from: string; readonly to: string };

const isoDay = /^\d{4}-\d{2}-\d{2}$/;

const presetOf = (text: string | null): Preset | null => {
  switch (text) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case null:
    default:
      return null;
  }
};

/** Reads the period from the URL's search params; anything unreadable is the default, 30 days. */
export const periodFromParams = (params: { readonly get: (name: string) => string | null }): PeriodChoice => {
  const from = params.get("from");
  const to = params.get("to");
  if (from !== null && to !== null && isoDay.test(from) && isoDay.test(to) && from <= to) {
    return { kind: "range", from, to };
  }
  return { kind: "preset", days: presetOf(params.get("period")) ?? 30 };
};

/** The URL's query for a period. */
export const periodQuery = (period: PeriodChoice): string =>
  period.kind === "preset" ? `period=${String(period.days)}d` : `from=${period.from}&to=${period.to}`;

/** `19 Oct – 17 Nov`, with the year on both ends when they differ (`19 Dec 2025 – 17 Jan`). */
export const rangeText = (from: number, lastDay: number): string => {
  const sameYear = new Date(from).getUTCFullYear() === new Date(lastDay).getUTCFullYear();
  const short = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const long = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${(sameYear ? short : long).format(new Date(from))} – ${short.format(new Date(lastDay))}`;
};

/** The day's first instant of a period's last day (its end is exclusive). */
export const lastDayOf = (period: { readonly end: number }): number => period.end - DAY_MS;

/** `$4,212` from $100 up; `$12.40` under; `$0` for nothing. */
export const formatMoney = (microUsd: number): string => {
  const dollars = microUsd / 1_000_000;
  if (dollars === 0) return "$0";
  if (dollars >= 100) return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(dollars))}`;
  return `$${dollars.toFixed(2)}`;
};

/** `182.4M`, `9.1k`, `640`. */
export const formatTokenCount = (n: number): string => {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

/** A span: `52 min`, `2.4 h`, `1.2 d`; under a minute is `1 min`, and nothing is `0 min`. */
export const formatSpan = (ms: number): string => {
  if (ms <= 0) return "0 min";
  const minutes = ms / 60_000;
  if (minutes < 60) return `${String(Math.max(1, Math.round(minutes)))} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : String(Math.round(hours))} h`;
  return `${(hours / 24).toFixed(1)} d`;
};

/** The merge rate as `87%`, or `—` when no PR closed. */
export const formatRate = (rate: number | null): string => (rate === null ? "—" : `${String(Math.round(rate * 100))}%`);

/** `3 min`, `1 h`, `2 d`: how long ago the job ran. */
export const formatAgo = (since: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - since) / 60_000));
  if (minutes < 60) return `${String(Math.max(1, minutes))} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} h`;
  return `${String(Math.round(hours / 24))} d`;
};

/** Older than three of the job's intervals: the job hasn't run since (insights.md, "Stale"). */
export const isStale = (computedAt: number, intervalMinutes: number, now: number): boolean => now - computedAt > intervalMinutes * 3 * 60_000;

/** `PRs merged`'s note: one decimal under 10. */
export const perDay = (count: number, days: number): string => {
  const value = days <= 0 ? 0 : count / days;
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
};

const reasonKeys: Readonly<Record<string, MessageKey>> = {
  approval: "insights.reason.approval",
  plan: "insights.reason.plan",
  question: "insights.reason.question",
  draft_ready: "insights.reason.draftReady",
  stalled: "insights.reason.stalled",
  crashed: "insights.reason.crashed",
  setup_failed: "insights.reason.setupFailed",
  spend_cap: "insights.reason.spendCap",
  ticket_closed: "insights.reason.ticketClosed",
  budget: "insights.reason.budget",
};

/** A needs-you reason as the table shows it; one this page doesn't know shows as its own name. */
export const reasonName = (reason: string): string => {
  const key = reasonKeys[reason];
  return key === undefined ? reason.replaceAll("_", " ") : t(key);
};

/** At most six reasons; the rest fold into one `Other reasons` row. */
export const foldReasons = (
  rows: readonly { readonly reason: string; readonly totalMs: number; readonly count: number; readonly medianMs: number | null }[],
): readonly { readonly reason: string | null; readonly totalMs: number; readonly count: number; readonly medianMs: number | null }[] => {
  if (rows.length <= 6) return rows;
  const rest = rows.slice(5);
  return [
    ...rows.slice(0, 5),
    { reason: null, totalMs: rest.reduce((sum, row) => sum + row.totalMs, 0), count: rest.reduce((sum, row) => sum + row.count, 0), medianMs: null },
  ];
};
