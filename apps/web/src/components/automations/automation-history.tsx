"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, CirclePauseIcon, PencilIcon, PlayIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useState } from "react";
import type { KeyboardEvent } from "react";

import type { AutomationId, ProjectId } from "@ostra/protocol";

import { FilterMenu } from "@/components/organization/filter-menu";
import { Mark } from "@/components/projects/project-view";
import { taskMark } from "@/components/projects/task-row-words";
import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { taskStateText } from "@/components/tasks/task-words";
import { Button, buttonVariants } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { useFilterNames } from "./automation-data";
import { clockText, dayText, filterWords, occurrenceText, secondsText, skipReasonText, webhookWords, weekdayText } from "./automation-words";
import type { Automation, HistoryRun } from "./automation-words";
import { bandsOf, matchCount, occurrenceCount, requestCount, rowsOfBand, shownRuns } from "./history-bands";
import type { Band } from "./history-bands";

// An automation's history (automation-history.md, F-011, F-106, F-139): each occurrence, match, "Start
// all" press and webhook request, with what it started, skipped or missed, the pause notice with "Resume", and the
// selected run's details. Anyone who can open the project reads it; a deleted automation's stays.

type Outcome = "all" | "started" | "skipped" | "missed";
type Period = "d7" | "d30" | "d90" | "all";
const outcomes: readonly Outcome[] = ["all", "started", "skipped", "missed"];
const periods: readonly Period[] = ["d7", "d30", "d90", "all"];
const periodDays: Record<Period, number | null> = { d7: 7, d30: 30, d90: 90, all: null };

const outcomeWord = (outcome: Outcome): string => {
  switch (outcome) {
    case "all":
      return t("automations.history.outcomes.all");
    case "started":
      return t("automations.history.outcomes.started");
    case "skipped":
      return t("automations.history.outcomes.skipped");
    case "missed":
      return t("automations.history.outcomes.missed");
    default:
      return outcome satisfies never;
  }
};

const periodWord = (period: Period): string => {
  switch (period) {
    case "d7":
      return t("automations.history.periods.d7");
    case "d30":
      return t("automations.history.periods.d30");
    case "d90":
      return t("automations.history.periods.d90");
    case "all":
      return t("automations.history.periods.all");
    default:
      return period satisfies never;
  }
};

const isOutcome = (value: string | null): value is Outcome => outcomes.some((one) => one === value);
const isPeriod = (value: string | null): value is Period => periods.some((one) => one === value);

const dayLabel = (at: number, now: number): string => {
  const day = (time: number) => new Date(time).toDateString();
  if (day(at) === day(now)) return t("automations.history.today");
  if (day(at) === day(now - 86_400_000)) return t("automations.history.yesterday");
  return weekdayText(at);
};

export const AutomationHistory = ({ projectId, automationId }: { readonly projectId: ProjectId; readonly automationId: AutomationId }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const list = useQuery(trpc.automations.list.queryOptions({ projectId }));
  const { names } = useFilterNames(projectId);
  // Keyset pages of 100: the first, then each "Load more" adds the next page's cursor.
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const pages = useQueries({
    queries: [undefined, ...cursors].map((cursor) => trpc.automations.history.queryOptions(cursor === undefined ? { automationId } : { automationId, cursor })),
  });
  const first = pages[0];
  const lastPage = pages.at(-1)?.data;
  const history = {
    data: first?.data === undefined ? undefined : { pages: pages.flatMap((page) => (page.data === undefined ? [] : [page.data])) },
    isError: first?.isError === true,
    error: first?.error ?? null,
    dataUpdatedAt: first?.dataUpdatedAt ?? 0,
    hasNextPage: lastPage?.nextCursor !== null && lastPage?.nextCursor !== undefined,
    isFetchingNextPage: pages.some((page) => page.isFetching),
    fetchNextPage: () => {
      const next = lastPage?.nextCursor;
      if (next !== null && next !== undefined) setCursors((current) => [...current, next]);
    },
  };
  const resume = useMutation(trpc.automations.resume.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.automations.pathKey() }) }));

  const automation: Automation | undefined = list.data?.automations.find((row) => row.id === automationId);
  const canEdit = list.data?.canEdit === true;
  const deleted = history.data?.pages[0]?.deleted === true;
  const limits = list.data?.limits ?? { startsPerHour: 20, bulkStartMax: 50, missedHours: 6, minIntervalMinutes: 60, webhookStartsPerHour: 20, webhookRequestsPerMinute: 60, webhookBodyMaxBytes: 65_536 };
  const zone = automation?.schedule?.timeZone;
  const isSchedule = automation?.kind === "schedule";
  const isWebhook = automation?.kind === "webhook";
  const kind = automation?.kind ?? "intake_rule";
  const outcomeParam = params.get("outcome");
  const periodParam = params.get("period");
  const outcome: Outcome = isOutcome(outcomeParam) ? outcomeParam : "all";
  const period: Period = isPeriod(periodParam) ? periodParam : "d30";
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    const query = next.toString();
    router.replace(`/projects/${projectId}/automations/${automationId}/history${query === "" ? "" : `?${query}`}`, { scroll: false });
  };

  const now = history.dataUpdatedAt === 0 ? 0 : history.dataUpdatedAt;
  const allRuns = (history.data?.pages ?? []).flatMap((page) => page.runs);
  const days = periodDays[period];
  const runs = allRuns.filter((run) => (days === null || now === 0 || run.at >= now - days * 86_400_000) && (outcome === "all" || run.state === outcome));
  const bands = bandsOf(runs, (at) => new Date(at).toDateString());
  const flat = shownRuns(bands);
  const selectedId = params.get("run");
  const selected = flat.find((run) => run.id === selectedId) ?? flat[0] ?? null;
  const filtered = outcome !== "all" || period !== "d30";

  const name = automation?.name ?? "";
  const filterText = automation?.filter === null || automation === undefined ? "" : filterWords(automation.filter, names);
  const lede =
    automation === undefined
      ? undefined
      : automation.webhook !== null
        ? `${t("automations.history.ledeWebhook")} ${webhookWords(automation.webhook.filter)}.`
        : automation.schedule === null
        ? t("automations.history.ledeRule", { filter: filterText })
        : automation.schedule.does === "prompt"
          ? t("automations.history.ledePrompt", { sentence: automation.schedule.sentence, title: automation.schedule.title ?? "" })
          : t("automations.history.ledeFilter", { sentence: automation.schedule.sentence, filter: filterText });

  const onKey = (run: HistoryRun) => (event: KeyboardEvent<HTMLTableRowElement>) => {
    const index = flat.findIndex((one) => one.id === run.id);
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setParam("run", run.id);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = flat[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next !== undefined) {
        setParam("run", next.id);
        document.querySelector<HTMLElement>(`[data-run="${next.id}"]`)?.focus();
      }
    }
  };

  return (
    <PageFrame
      crumbs={[
        { label: project.data?.name ?? "", href: `/projects/${projectId}` },
        { label: t("automations.title"), href: `/projects/${projectId}/automations` },
        { label: name },
      ]}
      actions={
        canEdit && !deleted && automation !== undefined ? (
          <Link href={`/projects/${projectId}/automations/${automationId}`} className={buttonVariants()}>
            <PencilIcon /> {isWebhook ? t("automations.panel.editWebhook") : isSchedule ? t("automations.panel.editSchedule") : t("automations.panel.editRule")}
          </Link>
        ) : null
      }
      properties={selected === null ? null : <RunPanel run={selected} automation={automation} limits={limits} kind={kind} />}
    >
      <PageHeading title={deleted ? `${name} ${t("automations.history.deleted")}` : name} lede={lede} />
      {automation?.paused === null || automation?.paused === undefined || deleted ? null : (
        <div className="mt-[18px] flex min-h-14 flex-wrap items-center gap-3 rounded-lg border border-line-2 bg-surface py-2 pl-3.5 pr-3" data-testid="pause-notice">
          <CirclePauseIcon aria-hidden className="size-[18px] shrink-0 stroke-[1.75] text-muted" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-text">
              {automation.paused.reason === "hourly_limit"
                ? t("automations.history.pausedLimit", { time: clockText(automation.paused.at), n: limits.startsPerHour })
                : automation.paused.byName === null
                  ? t("automations.history.pausedSomeone", { date: `${dayText(automation.paused.at)} ${clockText(automation.paused.at)}` })
                  : t("automations.history.pausedMember", { name: automation.paused.byName, date: `${dayText(automation.paused.at)} ${clockText(automation.paused.at)}` })}
            </p>
            <p className="text-sm text-muted">
              {automation.paused.reason === "hourly_limit" ? t("automations.history.pausedLimitNote") : isSchedule ? t("automations.history.pausedScheduleNote") : t("automations.history.pausedRuleNote")}
            </p>
          </div>
          {canEdit ? (
            <Button variant="primary" disabled={resume.isPending} onClick={() => { resume.mutate({ automationId }); }}>
              <PlayIcon /> {t("automations.history.resume")}
            </Button>
          ) : null}
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <FilterMenu
          label={t("automations.history.outcome")}
          value={outcome === "all" ? null : outcome}
          defaultLabel={outcomeWord("all")}
          options={outcomes.filter((one) => one !== "all" && (one !== "missed" || isSchedule)).map((one) => ({ value: one, label: outcomeWord(one) }))}
          onChange={(value) => { setParam("outcome", value); }}
          testId="history-outcome"
        />
        <FilterMenu
          label={t("automations.history.period")}
          value={period === "d30" ? null : period}
          defaultLabel={periodWord("d30")}
          options={periods.filter((one) => one !== "d30").map((one) => ({ value: one, label: periodWord(one) }))}
          onChange={(value) => { setParam("period", value); }}
          testId="history-period"
        />
        <span className="ml-auto text-sm text-faint">
          {isWebhook
            ? plural(requestCount(runs), "automations.history.requestCount.one", "automations.history.requestCount.other")
            : isSchedule
              ? `${plural(occurrenceCount(runs), "automations.history.occurrenceCount.one", "automations.history.occurrenceCount.other")} · ${plural(matchCount(runs), "automations.history.matchCount.one", "automations.history.matchCount.other")}`
              : plural(matchCount(runs), "automations.history.matchCount.one", "automations.history.matchCount.other")}
        </span>
      </div>
      {history.isError ? (
        <p role="alert" className="mt-4 text-sm text-red">{t("automations.history.loadFailed", { error: errorText(history.error) ?? "" })}</p>
      ) : history.data === undefined ? (
        <div className="mt-4"><SkeletonRows rows={8} /></div>
      ) : allRuns.length === 0 ? (
        <p className="mt-4 text-sm text-muted">
          {isSchedule
            ? automation.nextOccurrenceAt === null
              ? t("automations.history.emptyScheduleNone")
              : t("automations.history.emptySchedule", { date: occurrenceText(automation.nextOccurrenceAt, zone) })
            : isWebhook
              ? t("automations.history.emptyWebhook")
              : t("automations.history.emptyRule")}
        </p>
      ) : runs.length === 0 && filtered ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted">
          {t("automations.history.noRunMatch")}
          <Button variant="link" onClick={() => { router.replace(`/projects/${projectId}/automations/${automationId}/history`, { scroll: false }); }}>{t("automations.history.clearFilters")}</Button>
        </p>
      ) : (
        <>
          <table className="mt-4 w-full table-fixed border-collapse text-body" data-testid="history-table">
            <colgroup>
              <col className="w-[80px]" />
              <col />
              <col className="w-[150px] max-sm:w-[110px]" />
              <col className="w-[300px] max-lg:w-[200px] max-sm:hidden" />
            </colgroup>
            <thead>
              <tr className="border-b border-line">
                <th className="h-[30px] pl-2 text-left text-[12.5px] font-medium text-faint">{t("automations.history.col.time")}</th>
                <th className="h-[30px] pr-3 text-left text-[12.5px] font-medium text-faint">{t("automations.history.col.ticket")}</th>
                <th className="h-[30px] pr-3 text-left text-[12.5px] font-medium text-faint">{t("automations.history.col.outcome")}</th>
                <th className="h-[30px] pr-2 text-left text-[12.5px] font-medium text-faint max-sm:hidden">{t("automations.history.col.task")}</th>
              </tr>
            </thead>
            <tbody>
              {bands.map((band) => (
                <Fragment key={band.key}>
                  <tr className="sticky top-0 h-[30px] bg-surface" data-testid="history-band">
                    <td colSpan={4} className="truncate px-2.5 text-[13px] font-medium text-muted">
                      <BandLabel band={band} zone={zone} now={now} />
                    </td>
                  </tr>
                  {rowsOfBand(band).map((run) => (
                    <RunRow key={run.id} run={run} zone={zone} selected={selected?.id === run.id} limits={limits} kind={kind} onSelect={() => { setParam("run", run.id); }} onKey={onKey(run)} />
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
          {history.hasNextPage ? (
            <div className="mt-3">
              <Button onClick={history.fetchNextPage} disabled={history.isFetchingNextPage}>{t("automations.history.loadMore")}</Button>
            </div>
          ) : null}
        </>
      )}
    </PageFrame>
  );
};

const BandLabel = ({ band, zone, now }: { readonly band: Band; readonly zone: string | undefined; readonly now: number }) => {
  switch (band.kind) {
    case "day":
      return (
        <>
          {dayLabel(band.at, now === 0 ? band.at : now)}
          <span className="text-faint"> · {plural(band.rows.length, "automations.history.matchCount.one", "automations.history.matchCount.other")}</span>
        </>
      );
    case "start-all":
      return (
        <>
          {t("automations.history.byHand", { date: `${dayText(band.run.at)} ${clockText(band.run.at)}` })}
          <span className="text-faint"> · {plural(band.rows.length, "automations.history.matchCount.one", "automations.history.matchCount.other")}</span>
        </>
      );
    case "occurrence": {
      const run = band.run;
      const tail =
        run.state === "missed"
          ? t("automations.history.band.missed")
          : run.state === "skipped"
            ? run.skipReason === "last_open"
              ? t("automations.history.band.skippedOpen")
              : run.skipReason === "paused"
                ? t("automations.history.band.skippedPaused")
                : t("automations.history.band.skippedOther")
            : run.task !== null
              ? null
              : band.rows.length === 0
                ? t("automations.history.band.noMatch")
                : plural(band.rows.length, "automations.history.matchCount.one", "automations.history.matchCount.other");
      return (
        <>
          {occurrenceText(run.occurrenceAt ?? run.at, zone)}
          {tail === null ? null : <span className="text-faint"> · {tail}</span>}
        </>
      );
    }
    default:
      return band satisfies never;
  }
};

type HistoryLimits = { readonly startsPerHour: number; readonly bulkStartMax: number; readonly missedHours: number; readonly webhookStartsPerHour: number };

const RunRow = ({
  run,
  zone,
  selected,
  limits,
  kind,
  onSelect,
  onKey,
}: {
  readonly run: HistoryRun;
  readonly zone: string | undefined;
  readonly selected: boolean;
  readonly limits: HistoryLimits;
  readonly kind: Automation["kind"];
  readonly onSelect: () => void;
  readonly onKey: (event: KeyboardEvent<HTMLTableRowElement>) => void;
}) => {
  const missed = run.state === "missed";
  return (
    <tr
      tabIndex={0}
      aria-selected={selected}
      data-run={run.id}
      data-testid="history-row"
      onClick={onSelect}
      onKeyDown={onKey}
      className={cn("h-[38px] cursor-pointer border-b border-line hover:bg-hover", selected && "bg-sel hover:bg-sel")}
    >
      <td className="pl-2 font-mono text-[13px] text-faint">{missed ? "—" : clockText(run.at, zone)}</td>
      <td className="truncate pr-3">
        {run.ticket !== null ? (
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="shrink-0 font-mono text-[13px] text-muted">{run.ticket.key}</span>
            <span className="truncate text-text">{run.ticket.title}</span>
          </span>
        ) : run.task !== null ? (
          <span className="truncate text-text">{run.task.title}</span>
        ) : run.kind === "request" ? (
          <span className="text-faint">{t("automations.history.request")}</span>
        ) : (
          <span className="text-faint">{t("automations.history.noTickets")}</span>
        )}
      </td>
      <td className={cn("pr-3", run.state === "started" ? "text-text" : "text-muted")} data-testid="history-run-outcome">
        {run.state === "started" ? t("automations.history.started") : run.state === "skipped" ? t("automations.history.skipped") : t("automations.history.missed")}
      </td>
      <td className="truncate pr-2 text-ui max-sm:hidden">
        <TaskCell run={run} limits={limits} kind={kind} />
      </td>
    </tr>
  );
};

const TaskCell = ({ run, limits, kind }: { readonly run: HistoryRun; readonly limits: HistoryLimits; readonly kind: Automation["kind"] }) => {
  if (run.task !== null) {
    const state = taskStateOf(run.task.state);
    return (
      <Link href={`/tasks/${run.task.id}`} onClick={(event) => { event.stopPropagation(); }} className="inline-flex min-w-0 items-center gap-2 hover:underline">
        {state === null ? null : <Mark mark={taskMark(state)} />}
        {state === null ? null : <span className="text-text">{taskStateText(state)}</span>}
        <span className="font-mono text-[12.5px] text-faint">{run.task.shortId}</span>
      </Link>
    );
  }
  if (run.state === "missed") return <span className="text-faint">{missedText(run, limits.missedHours)}</span>;
  if (run.skipReason !== null) return <SkipReason run={run} limits={limits} kind={kind} />;
  return null;
};

/**
 * A skip's reason, with the task it was about a link (automation-history.md): `It already has a
 * task, a17be093`, `Waited for 7c1e04d2, still in review`.
 */
export const SkipReason = ({
  run,
  limits,
  kind = "intake_rule",
}: {
  readonly run: Pick<HistoryRun, "skipReason" | "blockedBy">;
  readonly limits: { readonly startsPerHour: number; readonly bulkStartMax: number; readonly webhookStartsPerHour?: number };
  readonly kind?: Automation["kind"];
}) => {
  if (run.skipReason === null) return null;
  const blocking = run.blockedBy;
  const link =
    blocking === null ? null : (
      <Link href={`/tasks/${blocking.id}`} onClick={(event) => { event.stopPropagation(); }} className="font-mono text-[12.5px] text-teal hover:underline">
        {blocking.shortId}
      </Link>
    );
  if (run.skipReason === "has_task" && link !== null) {
    return (
      <span className="text-faint" data-testid="skip-reason">
        {t("automations.history.reason.hasTaskLinked")} {link}
      </span>
    );
  }
  if (run.skipReason === "duplicate" && link !== null) {
    return (
      <span className="text-faint" data-testid="skip-reason">
        {t("automations.history.reason.duplicateOf")} {link}
      </span>
    );
  }
  if (run.skipReason === "last_open" && link !== null && blocking !== null) {
    const state = taskStateOf(blocking.state);
    return (
      <span className="text-faint" data-testid="skip-reason">
        {t("automations.history.reason.waitedFor")} {link}
        {state === null ? null : `, ${t("automations.history.reason.stillState", { state: taskStateText(state).toLowerCase() })}`}
      </span>
    );
  }
  return <span className="text-faint" data-testid="skip-reason">{skipReasonText(run.skipReason, limits, kind)}</span>;
};

const taskStates = ["queued", "preparing", "running", "awaiting_approval", "needs_you", "in_review", "stopped", "merged", "done"] as const;
type KnownState = (typeof taskStates)[number];
const taskStateOf = (state: string): KnownState | null => taskStates.find((one) => one === state) ?? null;

const missedText = (run: HistoryRun, limit: number): string =>
  t("automations.history.reason.missed", { h: Math.max(limit, Math.round((run.at - (run.occurrenceAt ?? run.at)) / 3_600_000)), limit });

const RunPanel = ({ run, automation, limits, kind }: { readonly run: HistoryRun; readonly automation: Automation | undefined; readonly limits: HistoryLimits; readonly kind: Automation["kind"] }) => {
  const zone = automation?.schedule?.timeZone;
  const outcomeText = run.state === "started" ? t("automations.history.started") : run.state === "skipped" ? t("automations.history.skipped") : t("automations.history.missed");
  return (
    <div data-testid="run-panel">
      <PropGroup
        title={
          <span className="font-mono text-[12.5px]">
            {run.ticket?.key ?? (run.kind === "start_all" ? t("automations.history.startAllBy") : run.kind === "request" ? t("automations.history.panelRequest") : t("automations.history.panelOccurrence"))}
          </span>
        }
      >
        <PropRow label={t("automations.history.panelOutcome")}>{outcomeText}</PropRow>
        <PropRow label={t("automations.history.panelWhen")}>
          <span title={new Date(run.at).toISOString()} className="truncate">{secondsText(run.at, zone)}</span>
        </PropRow>
        {run.occurrenceAt === null ? null : <PropRow label={t("automations.history.panelOccurrence")}>{occurrenceText(run.occurrenceAt, zone)}</PropRow>}
        {run.bulkStartId === null ? null : <PropRow label={t("automations.history.panelStartedBy")}>{t("automations.history.startAllBy")}</PropRow>}
        {automation === undefined ? null : (
          <>
            <PropRow label={t("automations.panel.profile")}><span className="truncate">{automation.agentProfile?.name ?? t("automations.defaultProfile")}</span></PropRow>
            <PropRow label={t("automations.panel.poolLabels")}>
              {automation.poolLabels.length === 0 ? <span className="text-faint">—</span> : automation.poolLabels.map((label) => <Chip key={label} className="font-mono text-[12.5px] text-text">{label}</Chip>)}
            </PropRow>
          </>
        )}
        {run.state === "missed" ? <PropRow label={t("automations.history.panelReason")}><span className="whitespace-normal">{missedText(run, limits.missedHours)}</span></PropRow> : null}
        {run.skipReason === null ? null : <PropRow label={t("automations.history.panelReason")}><span className="whitespace-normal"><SkipReason run={run} limits={limits} kind={kind} /></span></PropRow>}
      </PropGroup>
      {run.task === null ? null : (
        <PropGroup title={t("automations.history.panelTasks")}>
          <div className="flex items-center gap-3 text-ui">
            <Link href={`/tasks/${run.task.id}`} className="font-mono text-teal hover:underline">{run.task.shortId}</Link>
            <span className="truncate text-muted">
              {run.ticket === null ? "" : `${run.ticket.key} · `}
              {(() => {
                const state = taskStateOf(run.task.state);
                return state === null ? run.task.state : taskStateText(state);
              })()}
            </span>
            <ArrowUpRightIcon aria-hidden className="ml-auto size-[14px] stroke-[1.75] text-faint" />
          </div>
        </PropGroup>
      )}
    </div>
  );
};
