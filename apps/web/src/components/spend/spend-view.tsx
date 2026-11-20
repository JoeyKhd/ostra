"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import { CalendarIcon, CircleAlertIcon, CpuIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { modelIdSchema } from "@ostra/protocol";
import type { ModelId, ProjectId } from "@ostra/protocol";

import { projectColour } from "@/components/shell/project-colour";
import { PageFrame, PageHeading, Section } from "@/components/shell/page-frame";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { formatTokenCount } from "@/components/insights/insights-words";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { BudgetForm, PriceForm } from "./spend-forms";
import { dayMonth, formatShare, formatUsd, monthName, monthSoFar, monthsBack, resetsOn } from "./spend-words";

// Spend (spend-budgets.md, F-037): the month's spend against the organization's budget and each
// project's, each model's tokens and money, and the forms that set a budget or a model's price. Every
// figure is `spend.month`'s, which reads the one rollup, `SpendDaily`. The month and the selection
// live in the URL (`?month=2026-11`, `?project=<id>`, `?project=organization`, `?model=<id>`).

export type SpendMonth = RouterOutputs["spend"]["month"];
export type Budget = SpendMonth["budgets"][number];
type ModelLine = SpendMonth["byModel"][number];

export type Selection =
  | { readonly kind: "organization" }
  | { readonly kind: "project"; readonly projectId: ProjectId; readonly name: string }
  | { readonly kind: "model"; readonly modelId: ModelId }
  | null;

/** One row of the Projects table: a project with spend or a budget this month. */
export type ProjectRow = {
  readonly projectId: ProjectId | null;
  readonly name: string;
  readonly spentMicroUsd: number;
  readonly budget: Budget | null;
};

const shareText = (budget: Budget | null): string => {
  const share = budget?.share ?? null;
  return share === null ? "" : formatShare(share);
};

const tokensOf = (figures: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number }): number =>
  figures.inputTokens + figures.outputTokens + figures.cacheReadTokens + figures.cacheWriteTokens;

const useWide = (query: string): boolean => {
  const [matches, setMatches] = useState(true);
  useEffect(() => {
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (): void => {
      setMatches(list.matches);
    };
    list.addEventListener("change", onChange);
    return () => {
      list.removeEventListener("change", onChange);
    };
  }, [query]);
  return matches;
};

export const projectRowsOf = (data: SpendMonth): readonly ProjectRow[] => {
  const rows = new Map<string, ProjectRow>();
  for (const line of data.byProject) {
    const key = line.line.kind === "project" ? line.line.projectId : "other";
    rows.set(key, {
      projectId: line.line.kind === "project" ? line.line.projectId : null,
      name: line.line.kind === "project" ? line.line.name : t("spend.otherProjects"),
      spentMicroUsd: line.spentMicroUsd,
      budget: null,
    });
  }
  for (const budget of data.budgets) {
    if (budget.scope.kind !== "project") continue;
    const seen = rows.get(budget.scope.projectId);
    rows.set(budget.scope.projectId, { projectId: budget.scope.projectId, name: budget.scope.name, spentMicroUsd: seen?.spentMicroUsd ?? budget.spentMicroUsd, budget });
  }
  return [...rows.values()].sort((x, y) => {
    if ((x.projectId === null) !== (y.projectId === null)) return x.projectId === null ? 1 : -1;
    return y.spentMicroUsd - x.spentMicroUsd || x.name.localeCompare(y.name);
  });
};

/**
 * The budget bar (spend-budgets.md): Mist to the share under 100%, with the warn line's tick; at 100%
 * and past, red across the track, whose scale becomes the spend, and a tick at the budget.
 */
export const BudgetBar = ({ spent, budget, warnPercent, height, label }: { readonly spent: number; readonly budget: number | null; readonly warnPercent: number; readonly height: 6 | 8; readonly label: string }) => {
  const reached = budget !== null && spent >= budget && budget > 0;
  const share = budget === null || budget === 0 ? 0 : Math.min(1, spent / budget);
  const tick = budget === null ? null : reached ? budget / spent : warnPercent / 100;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={budget ?? 0}
      aria-valuenow={spent}
      className={cn("relative w-full bg-line", height === 8 ? "h-2 rounded-[4px]" : "h-1.5 rounded-[3px]")}
      data-state={budget === null ? "none" : reached ? "reached" : "under"}
    >
      {budget === null ? null : (
        <span className={cn("absolute inset-y-0 left-0", height === 8 ? "rounded-[4px]" : "rounded-[3px]", reached ? "w-full bg-red" : "bg-meter")} style={reached ? undefined : { width: `${String(Math.round(share * 1000) / 10)}%` }} />
      )}
      {tick === null ? null : (
        <span aria-hidden className={cn("absolute -inset-y-[3px] w-px", reached ? "bg-text" : "bg-faint")} style={{ left: `${String(Math.round(tick * 1000) / 10)}%` }} />
      )}
    </div>
  );
};

const StatusCell = ({ row, past, onSet }: { readonly row: ProjectRow; readonly past: boolean; readonly onSet: () => void }) => {
  const budget = row.budget;
  if (budget === null) {
    if (row.projectId === null || past) return <span className="text-faint">–</span>;
    return (
      <button
        type="button"
        className="text-teal hover:underline"
        onClick={(event) => {
          event.stopPropagation();
          onSet();
        }}
      >
        {t("spend.setBudget")}
      </button>
    );
  }
  switch (budget.state) {
    case "reached": {
      const text = budget.overshootMicroUsd > 0 ? t("spend.reachedOver", { amount: formatUsd(budget.overshootMicroUsd) }) : past && budget.reachedAt !== null ? t("spend.reachedOn", { date: dayMonth(budget.reachedAt) }) : t("spend.reached");
      return (
        <Tooltip content={t("spend.overTooltip", { on: budget.reachedAt === null ? "" : t("spend.overTooltipOn", { date: dayMonth(budget.reachedAt) }) })}>
          <span className="truncate text-red" data-testid="budget-status">
            {text}
          </span>
        </Tooltip>
      );
    }
    case "warn":
      return (
        <span className="flex items-center gap-1.5 truncate text-muted" data-testid="budget-status">
          <TriangleAlertIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
          {budget.warnedAt === null ? t("spend.warnedNoDate") : t("spend.warned", { date: dayMonth(budget.warnedAt) })}
        </span>
      );
    case "under":
      return (
        <span className="text-faint" data-testid="budget-status">
          –
        </span>
      );
    default:
      return budget.state satisfies never;
  }
};

const ProjectsTable = ({ rows, selected, onSelect, warnPercent, past }: {
  readonly rows: readonly ProjectRow[];
  readonly selected: Selection;
  readonly onSelect: (selection: Selection) => void;
  readonly warnPercent: number;
  readonly past: boolean;
}) => (
  <>
    <Table className="hidden md:table" data-testid="spend-projects">
      <colgroup>
        <col className="w-[30%]" />
        <col className="w-[96px]" />
        <col className="w-[96px]" />
        <col />
        <col className="w-[150px]" />
      </colgroup>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-1">{t("spend.colProject")}</TableHead>
          <TableHead num className="pr-4">{t("spend.colSpent")}</TableHead>
          <TableHead num className="pr-4">{t("spend.colBudget")}</TableHead>
          <TableHead>{t("spend.colUsed")}</TableHead>
          <TableHead>{t("spend.colStatus")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const id = row.projectId;
          const isSelected = id !== null && selected?.kind === "project" && selected.projectId === id;
          const budget = row.budget;
          const select = (): void => {
            if (id !== null) onSelect({ kind: "project", projectId: id, name: row.name });
          };
          return (
            <TableRow
              key={id ?? "other"}
              data-project={row.name}
              aria-pressed={id === null ? undefined : isSelected}
              tabIndex={id === null ? undefined : 0}
              onClick={select}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  select();
                }
              }}
              className={cn("h-10", id !== null && "cursor-pointer hover:bg-hover", isSelected && "bg-sel hover:bg-sel")}
            >
              <TableCell className="pl-1">
                <span className="flex min-w-0 items-center gap-2.5">
                  {id === null ? null : <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(id) }} />}
                  <span className={cn("truncate text-ui", id === null ? "text-muted" : "text-text")}>{row.name}</span>
                </span>
              </TableCell>
              <TableCell num className="pr-4" data-testid="project-spent">
                {formatUsd(row.spentMicroUsd)}
              </TableCell>
              <TableCell num className="pr-4">
                {budget === null ? <span className="font-sans text-sm text-faint">{t("spend.noBudget")}</span> : formatUsd(budget.monthlyMicroUsd)}
              </TableCell>
              <TableCell>
                <span className="flex items-center gap-3 pr-4">
                  <BudgetBar spent={row.spentMicroUsd} budget={budget?.monthlyMicroUsd ?? null} warnPercent={warnPercent} height={6} label={row.name} />
                  <span className={cn("w-12 shrink-0 text-right font-mono text-ui", budget?.state === "reached" ? "text-red" : "text-text")} data-testid="project-share">
                    {shareText(budget)}
                  </span>
                </span>
              </TableCell>
              <TableCell className="text-ui">
                <StatusCell row={row} past={past} onSet={select} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
    {/* Phone and narrow: two-line rows, the bar full width under the name. */}
    <ul className="md:hidden" data-testid="spend-projects-narrow">
      {rows.map((row) => {
        const id = row.projectId;
        const budget = row.budget;
        return (
          <li key={id ?? "other"} className="border-b border-line">
            <button
              type="button"
              disabled={id === null}
              onClick={() => {
                if (id !== null) onSelect({ kind: "project", projectId: id, name: row.name });
              }}
              className="block w-full py-2.5 text-left"
            >
              <span className="flex items-center gap-2.5 text-ui">
                {id === null ? null : <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(id) }} />}
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                <span className="font-mono">{formatUsd(row.spentMicroUsd)}</span>
                <span className={cn("w-11 text-right font-mono", budget?.state === "reached" ? "text-red" : "text-muted")}>{shareText(budget)}</span>
              </span>
              <span className="mt-2 block">
                <BudgetBar spent={row.spentMicroUsd} budget={budget?.monthlyMicroUsd ?? null} warnPercent={warnPercent} height={6} label={row.name} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  </>
);

const ModelName = ({ line }: { readonly line: Pick<ModelLine, "name" | "custom" | "logoPath"> }) => (
  <span className="flex min-w-0 items-center gap-2.5">
    {line.logoPath === null ? <CpuIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" /> : <img src={line.logoPath} alt="" className="size-[15px] shrink-0 opacity-75 invert" />}
    <span className={cn("truncate text-ui text-text", line.custom && "font-mono")}>{line.name}</span>
    {line.custom ? <Chip className="shrink-0">{t("spend.custom")}</Chip> : null}
  </span>
);

const tokenCell = (n: number): string => (n === 0 ? "–" : formatTokenCount(n));

const ModelsTable = ({ lines, selected, onSelect }: { readonly lines: readonly ModelLine[]; readonly selected: Selection; readonly onSelect: (selection: Selection) => void }) => {
  const ordered = [...lines].sort((x, y) => {
    const xPriced = x.unpricedTokens === 0 || x.spentMicroUsd > 0;
    const yPriced = y.unpricedTokens === 0 || y.spentMicroUsd > 0;
    if (xPriced !== yPriced) return xPriced ? -1 : 1;
    return y.spentMicroUsd - x.spentMicroUsd || x.name.localeCompare(y.name);
  });
  return (
    <Table data-testid="spend-models">
      <colgroup>
        <col />
        <col className="hidden w-[96px] min-[1100px]:table-column" />
        <col className="hidden w-[96px] min-[1100px]:table-column" />
        <col className="hidden w-[96px] min-[1100px]:table-column" />
        <col className="hidden w-[96px] min-[1100px]:table-column" />
        <col className="w-[96px] min-[1100px]:hidden" />
        <col className="w-[96px]" />
      </colgroup>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-1">{t("spend.colModel")}</TableHead>
          <TableHead num className="hidden min-[1100px]:table-cell">{t("spend.colFresh")}</TableHead>
          <TableHead num className="hidden min-[1100px]:table-cell">{t("spend.colOutput")}</TableHead>
          <TableHead num className="hidden min-[1100px]:table-cell">{t("spend.colCacheRead")}</TableHead>
          <TableHead num className="hidden min-[1100px]:table-cell">{t("spend.colCacheWrite")}</TableHead>
          <TableHead num className="min-[1100px]:hidden">{t("spend.colTokens")}</TableHead>
          <TableHead num className="pr-1">{t("spend.colSpent")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.map((line) => {
          const isSelected = selected?.kind === "model" && selected.modelId === line.modelId;
          const select = (): void => {
            onSelect({ kind: "model", modelId: line.modelId });
          };
          const unpriced = line.unpricedTokens > 0 && line.spentMicroUsd === 0;
          return (
            <TableRow
              key={line.modelId}
              data-model={line.name}
              aria-pressed={isSelected}
              tabIndex={0}
              onClick={select}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  select();
                }
              }}
              className={cn("h-9 cursor-pointer hover:bg-hover", isSelected && "bg-sel hover:bg-sel")}
            >
              <TableCell className="pl-1">
                <ModelName line={line} />
              </TableCell>
              <TableCell num className="hidden min-[1100px]:table-cell">{tokenCell(line.inputTokens)}</TableCell>
              <TableCell num className="hidden min-[1100px]:table-cell">{tokenCell(line.outputTokens)}</TableCell>
              <TableCell num className="hidden min-[1100px]:table-cell">{tokenCell(line.cacheReadTokens)}</TableCell>
              <TableCell num className="hidden min-[1100px]:table-cell">{tokenCell(line.cacheWriteTokens)}</TableCell>
              <TableCell num className="min-[1100px]:hidden">{tokenCell(tokensOf(line))}</TableCell>
              <TableCell num className="pr-1" data-testid="model-spent">
                {unpriced ? <span className="font-sans text-red">{t("spend.noPrice")}</span> : formatUsd(line.spentMicroUsd)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};

const NoPriceWarning = ({ data, onPrice, past }: { readonly data: SpendMonth; readonly onPrice: (modelId: ModelId) => void; readonly past: boolean }) => {
  const unpriced = data.unpriced;
  const first = unpriced[0];
  if (first === undefined) return null;
  const tokens = formatTokenCount(unpriced.reduce((sum, line) => sum + line.unpricedTokens, 0));
  return (
    <div role="status" className="mt-7 border-l-2 border-red py-0.5 pl-3.5" data-testid="spend-no-price">
      <p className="flex items-start gap-2 text-ui font-medium text-text">
        <CircleAlertIcon aria-hidden className="mt-0.5 size-[15px] shrink-0 stroke-[1.75] text-red" />
        <span>{unpriced.length === 1 ? t("spend.warnOne", { model: first.name }) : t("spend.warnMany", { n: unpriced.length })}</span>
      </p>
      <p className="mt-0.5 text-sm text-muted sm:pl-[23px]">
        {past ? t("spend.warnTokensPast", { tokens, month: monthName(data.month) }) : t("spend.warnTokens", { tokens })}{" "}
        {unpriced.length === 1 ? (
          <button type="button" className="text-teal hover:underline" onClick={() => { onPrice(first.modelId); }}>
            {t("spend.enterPrice")}
          </button>
        ) : (
          <a href="#spend-models" className="text-teal hover:underline">
            {t("spend.seeModels")}
          </a>
        )}
      </p>
    </div>
  );
};

const Summary = ({ data, organization, warnPercent, now, current, onSet }: {
  readonly data: SpendMonth;
  readonly organization: Budget | undefined;
  readonly warnPercent: number;
  readonly now: number;
  readonly current: boolean;
  readonly onSet: () => void;
}) => {
  const spent = data.total.spentMicroUsd;
  const tokens = formatTokenCount(tokensOf(data.total));
  return (
    <div className="mt-6" data-testid="spend-summary">
      <div className="font-mono text-[12.5px] text-faint">{current ? t("spend.thisMonth", { range: monthSoFar(data.month, now) }) : monthName(data.month)}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="font-mono text-[28px] font-semibold leading-tight text-text" data-testid="spend-total">
          {formatUsd(spent)}
        </span>
        <span className="text-body text-muted">
          {organization === undefined ? (
            t("spend.noOrgBudget")
          ) : (
            <>
              {t("spend.of", { amount: "\u0000" }).split("\u0000")[0]}
              <span className="font-mono">{formatUsd(organization.monthlyMicroUsd)}</span>
              {t("spend.of", { amount: "\u0000" }).split("\u0000")[1]}
            </>
          )}
        </span>
        {organization === undefined || organization.share === null ? null : (
          <span className={cn("ml-auto font-mono text-lg font-semibold", organization.state === "reached" ? "text-red" : "text-text")} data-testid="spend-org-share">
            {formatShare(organization.share)}
          </span>
        )}
      </div>
      {organization === undefined ? null : (
        <div className="mt-2.5">
          <BudgetBar spent={spent} budget={organization.monthlyMicroUsd} warnPercent={warnPercent} height={8} label={t("budgets.eyebrowOrg")} />
        </div>
      )}
      <div className="mt-2 flex items-center gap-3 font-mono text-[12.5px] text-faint">
        <span>{current ? t("spend.meta", { tokens, date: resetsOn(data.month) }) : t("spend.metaPast", { tokens })}</span>
        {current ? (
          <button type="button" onClick={onSet} className="ml-auto font-sans text-ui text-teal hover:underline">
            {organization === undefined ? t("spend.setBudget") : t("spend.changeBudget")}
          </button>
        ) : null}
      </div>
    </div>
  );
};

const selectionOf = (params: { readonly get: (name: string) => string | null }, rows: readonly ProjectRow[]): Selection => {
  const project = params.get("project");
  const model = params.get("model");
  if (project === "organization") return { kind: "organization" };
  if (project !== null) {
    const row = rows.find((candidate) => candidate.projectId === project);
    return row === undefined || row.projectId === null ? null : { kind: "project", projectId: row.projectId, name: row.name };
  }
  if (model !== null) {
    const parsed = modelIdSchema.safeParse(model);
    return parsed.success ? { kind: "model", modelId: parsed.data } : null;
  }
  return null;
};

/** The Spend page, for organization admins. */
export const SpendView = ({ organizationName, warnPercent }: { readonly organizationName: string; readonly warnPercent: number }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const wide = useWide("(min-width: 1280px)");
  const phone = !useWide("(min-width: 640px)");
  const current = useQuery(trpc.spend.currentMonth.queryOptions());
  const month = params.get("month") ?? current.data;
  const spend = useQuery({ ...trpc.spend.month.queryOptions(month === undefined ? skipToken : { month }), refetchInterval: 15_000 });
  const projects = useQuery(trpc.projects.list.queryOptions());
  const data = spend.data;
  const isCurrent = month !== undefined && month === current.data;
  const rows = data === undefined ? [] : projectRowsOf(data);
  const organization = data?.budgets.find((budget) => budget.scope.kind === "organization");
  const explicit = selectionOf(params, rows);
  // Nothing is selected by default, unless a budget is reached: then the first reached project.
  const firstReached = rows.find((row) => row.budget?.state === "reached" && row.projectId !== null);
  const reachedId = firstReached?.projectId ?? null;
  const selection: Selection =
    params.has("project") || params.has("model")
      ? explicit
      : reachedId !== null && firstReached !== undefined && wide
        ? { kind: "project", projectId: reachedId, name: firstReached.name }
        : null;
  const idle = projects.data === undefined || data === undefined ? 0 : projects.data.filter((project) => !rows.some((row) => row.projectId === project.id)).length;
  const neverSpent = data !== undefined && isCurrent && data.byModel.length === 0 && data.budgets.length === 0;

  const go = (next: { readonly month?: string; readonly selection?: Selection }): void => {
    const query = new URLSearchParams();
    const m = next.month ?? month;
    if (m !== undefined && m !== current.data) query.set("month", m);
    const s = next.selection === undefined ? selection : next.selection;
    if (s?.kind === "organization") query.set("project", "organization");
    if (s?.kind === "project") query.set("project", s.projectId);
    if (s?.kind === "model") query.set("model", s.modelId);
    const text = query.toString();
    router.replace(text === "" ? pathname : `${pathname}?${text}`, { scroll: false });
  };
  const select = (next: Selection): void => {
    go({ selection: next });
  };

  const panel =
    data === undefined || month === undefined ? (
      <div className="space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-[34px] w-full" />
      </div>
    ) : selection === null ? (
      <p className="text-sm text-muted" data-testid="spend-hint">
        {t("spend.pick")}
      </p>
    ) : selection.kind === "model" ? (
      <PriceForm key={selection.modelId} modelId={selection.modelId} month={month} />
    ) : (
      <BudgetForm
        key={`${month}:${selection.kind === "project" ? selection.projectId : "organization"}`}
        current={isCurrent}
        target={selection.kind === "project" ? { kind: "project", projectId: selection.projectId, name: selection.name } : { kind: "organization", name: organizationName }}
        budget={selection.kind === "project" ? (rows.find((row) => row.projectId === selection.projectId)?.budget ?? null) : (organization ?? null)}
        spentMicroUsd={selection.kind === "project" ? (rows.find((row) => row.projectId === selection.projectId)?.spentMicroUsd ?? 0) : data.total.spentMicroUsd}
      />
    );

  return (
    <PageFrame
      crumbs={[{ label: organizationName }, { label: t("spend.title") }]}
      wideProperties
      actions={
        month === undefined ? null : (
          <Select value={month} onValueChange={(value) => { go({ month: value, selection: null }); }}>
            <SelectTrigger aria-label={t("spend.month")} className="font-medium" data-testid="spend-month">
              <CalendarIcon aria-hidden className="text-muted" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {monthsBack(current.data ?? month).map((value) => (
                <SelectItem key={value} value={value}>
                  {monthName(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      }
      {...(wide ? { properties: <div data-testid="spend-panel">{panel}</div> } : {})}
    >
      <PageHeading title={t("spend.title")} lede={t("spend.lede", { warn: warnPercent })} />
      {spend.error === null ? null : (
        <p role="alert" className="mt-3 text-sm text-red">
          {errorText(spend.error)}
        </p>
      )}
      {data === undefined ? (
        <div className="mt-6 space-y-3">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-2 w-full" />
          <Section title={t("spend.projects")}>
            <SkeletonRows rows={5} />
          </Section>
          <Section title={t("spend.models")}>
            <SkeletonRows rows={5} />
          </Section>
        </div>
      ) : neverSpent ? (
        <p className="mt-6 max-w-[720px] text-ui text-muted" data-testid="spend-never">
          {t("spend.noSpendEver")}{" "}
          <Link href="/organization/models" className="text-teal hover:underline">
            {t("spend.modelsLink")}
          </Link>
        </p>
      ) : (
        <>
          <Summary data={data} organization={organization} warnPercent={warnPercent} now={Date.now()} current={isCurrent} onSet={() => { select({ kind: "organization" }); }} />
          <Section title={t("spend.projects")} count={rows.length} className="mt-7">
            {rows.length === 0 ? (
              <p className="border-y border-line py-2.5 text-ui text-muted">{t("spend.nothingSpent", { month: monthName(data.month).split(" ")[0] ?? "" })}</p>
            ) : (
              <ProjectsTable rows={rows} selected={selection} onSelect={select} warnPercent={warnPercent} past={!isCurrent} />
            )}
            {idle === 0 || !isCurrent ? null : <p className="mt-2.5 text-sm text-faint">{idle === 1 ? t("spend.idleOne") : t("spend.idleMany", { n: idle })}</p>}
          </Section>
          <NoPriceWarning data={data} past={!isCurrent} onPrice={(modelId) => { select({ kind: "model", modelId }); }} />
          <Section title={t("spend.models")} count={data.byModel.length} className="mt-5">
            <div id="spend-models">
              {data.byModel.length === 0 ? (
                <p className="border-y border-line py-2.5 text-ui text-muted">{t("spend.nothingSpent", { month: monthName(data.month).split(" ")[0] ?? "" })}</p>
              ) : (
                <ModelsTable lines={data.byModel} selected={selection} onSelect={select} />
              )}
            </div>
          </Section>
        </>
      )}
      {wide ? null : (
        <Sheet
          open={selection !== null}
          onOpenChange={(open) => {
            if (!open) select(null);
          }}
        >
          <SheetContent side={phone ? "bottom" : "right"} title={t("spend.title")} className={cn("p-5", phone ? "" : "w-[min(380px,92vw)]")}>
            <div data-testid="spend-panel">{panel}</div>
          </SheetContent>
        </Sheet>
      )}
    </PageFrame>
  );
};
