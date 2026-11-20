"use client";

import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import { CalendarIcon, ClockIcon, InfoIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import type { ProjectId } from "@ostra/protocol";

import { projectColour } from "@/components/shell/project-colour";
import { PageFrame, PageHeading, PropGroup, Section } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatCount } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { Meter, PrChart, PrTable, Sparkline } from "./insights-charts";
import {
  foldReasons,
  formatAgo,
  formatMoney,
  formatRate,
  formatSpan,
  formatTokenCount,
  isStale,
  lastDayOf,
  perDay,
  periodFromParams,
  periodQuery,
  rangeText,
  reasonName,
} from "./insights-words";
import type { PeriodChoice } from "./insights-words";

// Insights (insights.md, F-108): an organization's or a project's six figures over a period, the PRs
// by day, waiting by reason, and tokens and spend in the panel. Nothing here is live: the numbers
// are what `insights.compute` last wrote, and the page says when.

type Insights = RouterOutputs["insights"]["get"];
type Figures = Insights["tokens"]["total"];

const DAY_MS = 86_400_000;

const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
};

const todayIso = (now: number): string => new Date(now - (now % DAY_MS)).toISOString().slice(0, 10);

const PeriodPicker = ({ period, onChange, now }: { readonly period: PeriodChoice; readonly onChange: (period: PeriodChoice) => void; readonly now: number }) => {
  const [open, setOpen] = useState(false);
  const today = todayIso(now);
  const [from, setFrom] = useState(period.kind === "range" ? period.from : "");
  const [to, setTo] = useState(period.kind === "range" ? period.to : today);
  const valid = from !== "" && to !== "" && from <= to && to <= today && (Date.parse(to) - Date.parse(from)) / DAY_MS + 1 <= 366;
  const value = period.kind === "preset" ? `${String(period.days)}d` : "dates";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ToggleGroup
        type="single"
        value={value}
        aria-label={t("insights.period")}
        onValueChange={(next) => {
          if (next === "7d") onChange({ kind: "preset", days: 7 });
          else if (next === "30d") onChange({ kind: "preset", days: 30 });
          else if (next === "90d") onChange({ kind: "preset", days: 90 });
        }}
      >
        <ToggleGroupItem value="7d" className="px-3.5">
          {t("insights.period7")}
        </ToggleGroupItem>
        <ToggleGroupItem value="30d" className="px-3.5">
          {t("insights.period30")}
        </ToggleGroupItem>
        <ToggleGroupItem value="90d" className="px-3.5">
          {t("insights.period90")}
        </ToggleGroupItem>
        <PopoverTrigger asChild>
          <ToggleGroupItem value="dates" className="flex items-center gap-1.5 px-3.5" onClick={(event) => {
            event.preventDefault();
            setOpen(true);
          }}>
            <CalendarIcon aria-hidden className="size-[14px] stroke-[1.75]" />
            {t("insights.dates")}
          </ToggleGroupItem>
        </PopoverTrigger>
      </ToggleGroup>
      <PopoverContent className="w-[280px] p-3">
        <form
          className="space-y-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            onChange({ kind: "range", from, to });
            setOpen(false);
          }}
        >
          <label className="block text-sm text-muted">
            {t("insights.from")}
            <input
              type="date"
              value={from}
              max={to === "" ? today : to}
              onChange={(event) => {
                setFrom(event.target.value);
              }}
              className="mt-1 block h-[30px] w-full rounded-md border border-line-2 bg-surface px-2 font-mono text-ui text-text [color-scheme:dark]"
            />
          </label>
          <label className="block text-sm text-muted">
            {t("insights.to")}
            <input
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(event) => {
                setTo(event.target.value);
              }}
              className="mt-1 block h-[30px] w-full rounded-md border border-line-2 bg-surface px-2 font-mono text-ui text-text [color-scheme:dark]"
            />
          </label>
          <p className="text-xs text-faint">{t("insights.datesHint")}</p>
          <Button type="submit" variant="outline" size="sm" disabled={!valid}>
            {t("insights.apply")}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
};

const Computed = ({ data, now }: { readonly data: Insights; readonly now: number }) => {
  if (data.computedAt === null) return null;
  const stale = isStale(data.computedAt, data.intervalMinutes, now);
  const age = formatAgo(data.computedAt, now);
  return (
    <Tooltip content={new Date(data.computedAt).toLocaleString("en-GB")}>
      <span className={cn("ml-auto flex items-center gap-1.5 text-sm", stale ? "text-red" : "text-muted")} data-testid="insights-computed">
        <ClockIcon aria-hidden className="size-[14px] stroke-[1.75]" />
        {stale ? t("insights.stale", { age }) : t("insights.computed", { age })}
      </span>
    </Tooltip>
  );
};

type Cell = { readonly id: string; readonly label: string; readonly figure: string; readonly note: string; readonly series: readonly (number | null)[] };

const cellsOf = (data: Insights, projectScope: boolean): readonly Cell[] => {
  const days = data.series.length;
  return [
    {
      id: "prs-opened",
      label: t("insights.prsOpened"),
      figure: formatCount(data.prsOpened),
      note: projectScope && data.repoCount === 1 ? t("insights.inOneRepo") : t("insights.acrossRepos", { n: data.repoCount }),
      series: data.series.map((day) => day.prsOpened),
    },
    {
      id: "prs-merged",
      label: t("insights.prsMerged"),
      figure: formatCount(data.prsMerged),
      note: t("insights.perDay", { n: perDay(data.prsMerged, days) }),
      series: data.series.map((day) => day.prsMerged),
    },
    {
      id: "merge-rate",
      label: t("insights.mergeRate"),
      figure: formatRate(data.mergeRate),
      note: data.prsMerged + data.prsClosedUnmerged === 0 ? t("insights.noneClosed") : t("insights.ofClosed", { n: formatCount(data.prsMerged + data.prsClosedUnmerged) }),
      series: data.series.map((day) => day.mergeRate),
    },
    {
      id: "first-pr",
      label: t("insights.firstPr"),
      figure: data.timeToFirstPr.medianMs === null ? "—" : formatSpan(data.timeToFirstPr.medianMs),
      note: plural(data.timeToFirstPr.count, "insights.overTasks.one", "insights.overTasks.other", { n: formatCount(data.timeToFirstPr.count) }),
      series: data.series.map((day) => day.firstPrMedianMs),
    },
    {
      id: "waiting",
      label: t("insights.waiting"),
      figure: formatSpan(data.waiting.totalMs),
      note: data.waiting.medianMs === null ? t("insights.noWaiting") : t("insights.medianPerItem", { d: formatSpan(data.waiting.medianMs) }),
      series: data.series.map((day) => day.waitingMs),
    },
    {
      id: "spend",
      label: t("insights.tokensSpend"),
      figure: formatMoney(data.tokens.total.spentMicroUsd),
      note: t("insights.tokens", { n: formatTokenCount(tokensOf(data.tokens.total)) }),
      series: data.series.map((day) => day.spentMicroUsd),
    },
  ];
};

const tokensOf = (figures: Figures): number => figures.inputTokens + figures.outputTokens + figures.cacheReadTokens + figures.cacheWriteTokens;

const FigureGrid = ({ cells }: { readonly cells: readonly Cell[] | null }) => (
  <div className="mt-5 grid grid-cols-2 border-y border-line xl:grid-cols-3" data-testid="insights-figures">
    {(cells ?? skeletonCells).map((cell, i) => (
      <div
        key={cell.id}
        data-figure={cell.id}
        aria-label={cells === null ? undefined : `${cell.label}: ${cell.figure}, ${cell.note}`}
        className={cn(
          "min-h-[100px] min-w-0 border-line py-4 pr-3 sm:pr-[18px]",
          i % 2 === 1 ? "border-l pl-3 sm:pl-[18px]" : "pl-0",
          i >= 2 && "border-t",
          "xl:border-l xl:border-t-0 xl:pl-[18px]",
          i % 3 === 0 && "xl:border-l-0 xl:pl-0",
          i >= 3 && "xl:border-t",
        )}
      >
        <div className="truncate text-sm text-muted">{cell.label}</div>
        {cells === null ? (
          <>
            <Skeleton className="mt-2 h-7 w-20" />
            <Skeleton className="mt-2 h-3.5 w-28" />
          </>
        ) : (
          <>
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <div className="whitespace-nowrap font-title text-[28px] font-bold leading-[1.1] tabular-nums text-text" data-testid="figure-value">
                {cell.figure}
              </div>
              <Sparkline values={cell.series} />
            </div>
            <div className="mt-1 truncate text-sm text-muted" data-testid="figure-note">
              {cell.note}
            </div>
          </>
        )}
      </div>
    ))}
  </div>
);

const skeletonCells: readonly Cell[] = [
  { id: "prs-opened", label: t("insights.prsOpened"), figure: "", note: "", series: [] },
  { id: "prs-merged", label: t("insights.prsMerged"), figure: "", note: "", series: [] },
  { id: "merge-rate", label: t("insights.mergeRate"), figure: "", note: "", series: [] },
  { id: "first-pr", label: t("insights.firstPr"), figure: "", note: "", series: [] },
  { id: "waiting", label: t("insights.waiting"), figure: "", note: "", series: [] },
  { id: "spend", label: t("insights.tokensSpend"), figure: "", note: "", series: [] },
];

const Legend = ({ table, onTable }: { readonly table: boolean; readonly onTable: () => void }) => (
  <>
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="size-2 rounded-[2px] bg-[var(--chart-2)]" />
      {t("insights.opened")}
    </span>
    <span className="ml-2 flex items-center gap-1.5">
      <span aria-hidden className="size-2 rounded-[2px] bg-[var(--chart)]" />
      {t("insights.merged")}
    </span>
    <button type="button" onClick={onTable} className="ml-2 text-teal hover:underline" aria-pressed={table}>
      {table ? t("insights.chart") : t("insights.table")}
    </button>
  </>
);

const WaitingByReason = ({ data }: { readonly data: Insights }) => {
  const rows = foldReasons(data.waiting.byReason);
  const max = Math.max(1, ...rows.map((row) => row.totalMs));
  return (
    <Section title={t("insights.byReason")} {...(rows.length === 0 ? {} : { end: <span className="font-mono text-faint">{plural(data.waiting.count, "insights.items.one", "insights.items.other", { n: formatCount(data.waiting.count) })}</span> })}>
      {rows.length === 0 ? (
        <p className="py-2 text-sm text-faint">{t("insights.nothingWaited")}</p>
      ) : (
        <ul data-testid="insights-reasons">
          {rows.map((row) => (
            <li
              key={row.reason ?? "other"}
              className="grid min-h-[38px] grid-cols-[minmax(0,1fr)_80px] items-center gap-x-6 border-b border-line py-1.5 md:grid-cols-[190px_minmax(0,1fr)_80px_90px_120px]"
            >
              <span className="min-w-0 truncate text-ui text-text">
                {row.reason === null ? t("insights.otherReasons") : reasonName(row.reason)}
                <span className="block font-mono text-xs text-faint md:hidden">
                  {plural(row.count, "insights.items.one", "insights.items.other", { n: formatCount(row.count) })}
                  {row.medianMs === null ? "" : ` · ${t("insights.median", { d: formatSpan(row.medianMs) })}`}
                </span>
              </span>
              <span className="hidden h-2 rounded-[4px] bg-line-2 md:block">
                <span className="block h-2 rounded-[4px] bg-[var(--chart)]" style={{ width: `${String(Math.round((row.totalMs / max) * 1000) / 10)}%` }} />
              </span>
              <span className="text-right font-mono text-ui text-text">{formatSpan(row.totalMs)}</span>
              <span className="hidden text-right font-mono text-sm text-faint md:block">
                {plural(row.count, "insights.items.one", "insights.items.other", { n: formatCount(row.count) })}
              </span>
              <span className="hidden text-right font-mono text-sm text-faint md:block">{row.medianMs === null ? "" : t("insights.median", { d: formatSpan(row.medianMs) })}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
};

const kindsTip = (figures: Figures): ReactNode => (
  <div className="font-mono text-xs">
    <div>
      {t("insights.freshInput")} {formatTokenCount(figures.inputTokens)}
    </div>
    <div>
      {t("insights.output")} {formatTokenCount(figures.outputTokens)}
    </div>
    <div>
      {t("insights.cacheReads")} {formatTokenCount(figures.cacheReadTokens)}
    </div>
    <div>
      {t("insights.cacheWrites")} {formatTokenCount(figures.cacheWriteTokens)}
    </div>
  </div>
);

const MoneyRow = ({ name, square, figures, max, mono = false, muted = false, href }: {
  readonly name: string;
  readonly square: string | null;
  readonly figures: Figures;
  readonly max: number;
  readonly mono?: boolean;
  readonly muted?: boolean;
  readonly href?: string;
}) => {
  const label = <span className={cn("min-w-0 truncate", mono ? "font-mono text-ui" : "text-ui", muted ? "text-muted" : "text-text")}>{name}</span>;
  return (
    <Tooltip content={kindsTip(figures)}>
      <li className="min-h-12 py-1.5" data-testid="spend-row">
        <div className="flex items-center gap-2">
          {square === null ? null : <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: square }} />}
          {href === undefined ? label : <Link href={href} className="min-w-0 truncate hover:underline">{label}</Link>}
          <span className="ml-auto font-mono text-ui text-text">{formatMoney(figures.spentMicroUsd)}</span>
        </div>
        <Meter value={figures.spentMicroUsd} max={max} className="mt-2" />
      </li>
    </Tooltip>
  );
};

const sumFigures = (rows: readonly Figures[]): Figures =>
  rows.reduce<Figures>(
    (sum, row) => ({
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
      unpricedTokens: sum.unpricedTokens + row.unpricedTokens,
      spentMicroUsd: sum.spentMicroUsd + row.spentMicroUsd,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unpricedTokens: 0, spentMicroUsd: 0 },
  );

const periodName = (period: PeriodChoice, data: Insights | undefined): string => {
  if (period.kind === "range") return data === undefined ? "" : rangeText(data.period.start, lastDayOf(data.period));
  switch (period.days) {
    case 7:
      return t("insights.last7");
    case 30:
      return t("insights.last30");
    case 90:
      return t("insights.last90");
    default:
      return period.days satisfies never;
  }
};

const SpendPanel = ({ data, period, projectScope, admin }: { readonly data: Insights | undefined; readonly period: PeriodChoice; readonly projectScope: boolean; readonly admin: boolean }) => {
  const total = data?.tokens.total;
  const named = data?.tokens.byProject.flatMap((row) => (row.line.kind === "project" ? [{ ...row, line: row.line }] : [])) ?? [];
  const other = data?.tokens.byProject.find((row) => row.line.kind === "other");
  const models = data?.tokens.byModel ?? [];
  const max = Math.max(1, ...(data?.tokens.byProject.map((row) => row.spentMicroUsd) ?? []));
  const modelMax = Math.max(1, ...models.map((row) => row.spentMicroUsd));
  const label = t("insights.spendFor", { period: periodName(period, data) });
  const kinds: readonly [string, number | undefined][] = [
    [t("insights.freshInput"), total?.inputTokens],
    [t("insights.output"), total?.outputTokens],
    [t("insights.cacheReads"), total?.cacheReadTokens],
    [t("insights.cacheWrites"), total?.cacheWriteTokens],
    ...(total !== undefined && total.unpricedTokens > 0 ? [[t("insights.unpriced"), total.unpricedTokens] satisfies [string, number]] : []),
  ];
  const restProjects = named.slice(4);
  const restModels = models.slice(4);
  return (
    <div data-testid="insights-spend">
      <PropGroup title={label}>
        <div className="font-title text-[30px] font-bold leading-[1.15] tracking-[-0.015em]" data-testid="spend-total">
          {total === undefined ? "–" : formatMoney(total.spentMicroUsd)}
        </div>
        <div className="mt-0.5 text-ui text-muted">
          {total === undefined ? "–" : `${t("insights.tokens", { n: formatTokenCount(tokensOf(total)) })} · ${plural(models.length, "insights.models.one", "insights.models.other", { n: models.length })}`}
        </div>
        <dl className="mt-2">
          {kinds.map(([key, value]) => (
            <div key={key} className="flex h-7 items-center justify-between text-ui">
              <dt className="text-muted">{key}</dt>
              <dd className="font-mono text-text">{value === undefined ? "–" : formatTokenCount(value)}</dd>
            </div>
          ))}
        </dl>
        {total !== undefined && total.unpricedTokens > 0 ? (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-muted">
            <InfoIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />
            <span>
              {t("insights.unpricedNote", { n: formatTokenCount(total.unpricedTokens) })}
              {admin ? (
                <>
                  {" "}
                  <Link href="/organization/models" className="text-teal hover:underline">
                    {t("insights.modelsLink")}
                  </Link>
                </>
              ) : null}
            </span>
          </p>
        ) : null}
      </PropGroup>
      {projectScope || data === undefined || data.tokens.byProject.length === 0 ? null : (
        <div className="mb-3.5 border-b border-line pb-3.5">
          <h3 className="mb-1 flex text-xs font-medium text-faint">
            {t("insights.byProject")}
            <span className="ml-auto font-mono">{named.length + (other === undefined ? 0 : 1)}</span>
          </h3>
          <ul>
            {named.slice(0, 4).map((row) => (
              <MoneyRow key={row.line.projectId} name={row.line.name} square={projectColour(row.line.projectId)} figures={row} max={max} href={`/projects/${row.line.projectId}/insights`} />
            ))}
            {restProjects.length === 0 ? null : (
              <MoneyRow name={t("insights.more", { n: restProjects.length })} square={null} figures={sumFigures(restProjects)} max={max} muted />
            )}
            {other === undefined ? null : <MoneyRow name={t("insights.otherProjects")} square={null} figures={other} max={max} muted />}
          </ul>
        </div>
      )}
      {data === undefined || models.length === 0 ? null : (
        <div className="mb-3.5 pb-3.5">
          <h3 className="mb-1 text-xs font-medium text-faint">{t("insights.byModel")}</h3>
          <ul>
            {models.slice(0, 4).map((row) => (
              <MoneyRow key={row.modelId} name={row.name} square={null} figures={row} max={modelMax} mono />
            ))}
            {restModels.length === 0 ? null : <MoneyRow name={t("insights.more", { n: restModels.length })} square={null} figures={sumFigures(restModels)} max={modelMax} muted />}
          </ul>
        </div>
      )}
    </div>
  );
};

export type InsightsViewProps =
  | { readonly scope: "organization"; readonly organizationName: string; readonly admin: boolean }
  | { readonly scope: "project"; readonly projectId: ProjectId; readonly admin: boolean };

/** The Insights page, for the organization or one project. The period lives in the URL. */
export const InsightsView = (props: InsightsViewProps) => {
  const trpc = useTRPC();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const now = useNow();
  const period = periodFromParams(params);
  const [table, setTable] = useState(false);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    setNarrow(query.matches);
    const onChange = (): void => {
      setNarrow(query.matches);
    };
    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
    };
  }, []);
  const projectId = props.scope === "project" ? props.projectId : null;
  const project = useQuery(trpc.projects.get.queryOptions(projectId === null ? skipToken : { projectId }));
  const insights = useQuery({
    ...trpc.insights.get.queryOptions({ projectId, period: period.kind === "preset" ? { kind: "preset", days: period.days } : { kind: "range", from: period.from, to: period.to } }),
    placeholderData: keepPreviousData,
  });
  const data = insights.data;
  const changing = insights.isPlaceholderData;
  const scopeName = props.scope === "organization" ? props.organizationName : (project.data?.name ?? "");
  const projectScope = props.scope === "project";
  const count = data === undefined ? null : data.tokens.byProject.length;

  const setPeriod = (next: PeriodChoice): void => {
    router.replace(`${pathname}?${periodQuery(next)}`, { scroll: false });
  };

  const crumbs = props.scope === "organization" ? [{ label: props.organizationName }, { label: t("insights.title") }] : [{ label: scopeName, href: `/projects/${props.projectId}` }, { label: t("insights.title") }];
  const neverComputed = data?.computedAt === null;

  return (
    <PageFrame crumbs={crumbs} {...(neverComputed ? {} : { properties: <SpendPanel data={data} period={period} projectScope={projectScope} admin={props.admin} /> })}>
      <PageHeading
        title={t("insights.title")}
        lede={projectScope ? t("insights.ledeProject", { project: scopeName }) : count === null ? t("insights.ledeOrganizationLoading") : t("insights.ledeOrganization", { n: Math.max(count, 1) })}
      />
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="insights-period">
        <PeriodPicker period={period} onChange={setPeriod} now={now} />
        {data === undefined ? null : (
          <span className="font-mono text-sm text-faint" data-testid="insights-range">
            {rangeText(data.period.start, lastDayOf(data.period))}
          </span>
        )}
        {data === undefined ? null : <Computed data={data} now={now} />}
      </div>
      {insights.error === null ? null : (
        <p role="alert" className="mt-3 text-sm text-red">
          {errorText(insights.error)}{" "}
          <button type="button" className="text-teal hover:underline" onClick={() => void insights.refetch()}>
            {t("insights.retry")}
          </button>
        </p>
      )}
      {neverComputed ? (
        <div className="mx-auto mt-10 flex max-w-[560px] flex-col items-center text-center" data-testid="insights-empty">
          <img src="/inbox-empty-illustration.webp" alt="" width={560} height={373} className="h-auto w-full max-w-[560px]" />
          <h2 className="mt-4 text-[15px] font-semibold">{t("insights.empty")}</h2>
          <p className="mt-1 text-sm text-muted">{t("insights.emptyBody", { n: data.intervalMinutes })}</p>
        </div>
      ) : (
        <div className={cn("transition-opacity", changing && "opacity-60")}>
          <FigureGrid cells={data === undefined ? null : cellsOf(data, projectScope)} />
          <Section title={t("insights.prsByDay")} end={<Legend table={table} onTable={() => { setTable((on) => !on); }} />}>
            {data === undefined ? (
              <Skeleton className="h-[150px] w-full" />
            ) : table ? (
              <PrTable days={data.series} />
            ) : (
              <PrChart days={data.series} endsToday={data.series.at(-1)?.day === todayIso(now)} narrow={narrow} />
            )}
          </Section>
          {data === undefined ? (
            <Section title={t("insights.byReason")}>
              <SkeletonRows rows={4} />
            </Section>
          ) : (
            <WaitingByReason data={data} />
          )}
        </div>
      )}
    </PageFrame>
  );
};
