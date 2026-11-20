"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, ChevronDownIcon, ClockIcon, FilterIcon, PencilIcon, PlayIcon, PlusIcon, ShieldIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { KeyboardEvent } from "react";

import type { AutomationId, ProjectId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip, Dot } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { useFilterNames } from "./automation-data";
import { assigneeValue, dayText, listWords, nextText, occurrenceText, startsWhenText, statusValues, taskKindLong, taskKindWord } from "./automation-words";
import type { Automation, FilterNames } from "./automation-words";

// A project's Automations (automations.md, F-011, F-106): its intake rules and schedules in one list,
// each with what starts it, what it starts, its last start and its next, and a switch that pauses and
// resumes it at once. The selected one fills the properties panel. Members read; project admins act.

type KindFilter = "all" | "rules" | "schedules" | "paused";
const kindFilters: readonly KindFilter[] = ["all", "rules", "schedules", "paused"];
const isKindFilter = (value: string | null): value is KindFilter => kindFilters.some((kind) => kind === value);

const kindFilterLabel = (kind: KindFilter): string => {
  switch (kind) {
    case "all":
      return t("automations.kinds.all");
    case "rules":
      return t("automations.kinds.rules");
    case "schedules":
      return t("automations.kinds.schedules");
    case "paused":
      return t("automations.kinds.paused");
    default:
      return kind satisfies never;
  }
};

const keep = (automation: Automation, kind: KindFilter): boolean => {
  switch (kind) {
    case "all":
      return true;
    case "rules":
      return automation.kind === "intake_rule";
    case "schedules":
      return automation.kind === "schedule";
    case "paused":
      return automation.paused !== null;
    default:
      return kind satisfies never;
  }
};

/** Enabled first, then paused, each by name. */
const ordered = (rows: readonly Automation[]): Automation[] =>
  [...rows].sort((a, b) => Number(a.paused !== null) - Number(b.paused !== null) || a.name.localeCompare(b.name));

const th = "h-[30px] pr-3 text-left text-[12.5px] font-medium text-faint";

export const AutomationsView = ({ projectId }: { readonly projectId: ProjectId }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const list = useQuery(trpc.automations.list.queryOptions({ projectId }));
  const { names, boards, boardsLoaded } = useFilterNames(projectId);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const kindParam = params.get("kind");
  const kind: KindFilter = isKindFilter(kindParam) ? kindParam : "all";

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    const query = next.toString();
    router.replace(`/projects/${projectId}/automations${query === "" ? "" : `?${query}`}`, { scroll: false });
  };

  const listKey = trpc.automations.list.queryKey({ projectId });
  const optimistic = (id: AutomationId, on: boolean) => {
    queryClient.setQueryData(listKey, (old) =>
      old === undefined
        ? old
        : { ...old, automations: old.automations.map((row) => (row.id === id ? { ...row, paused: on ? null : { at: Date.now(), reason: "member" as const, byName: null } } : row)) },
    );
  };
  const settle = {
    onError: (error: Parameters<typeof errorText>[0]) => {
      setToggleError(errorText(error));
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
    onSuccess: () => {
      setToggleError(null);
      void queryClient.invalidateQueries({ queryKey: trpc.automations.pathKey() });
    },
  };
  const pause = useMutation(trpc.automations.pause.mutationOptions(settle));
  const resume = useMutation(trpc.automations.resume.mutationOptions(settle));
  const toggle = (automation: Automation, on: boolean) => {
    optimistic(automation.id, on);
    if (on) resume.mutate({ automationId: automation.id });
    else pause.mutate({ automationId: automation.id });
  };

  const data = list.data;
  const canEdit = data?.canEdit ?? false;
  const rows = ordered((data?.automations ?? []).filter((row) => keep(row, kind)));
  const all = data?.automations ?? [];
  const selectedParam = params.get("automation");
  const selected = rows.find((row) => row.id === selectedParam) ?? rows[0] ?? null;
  const projectName = project.data?.name ?? "";
  const empty = data !== undefined && all.length === 0;
  const noBoard = boardsLoaded && (boards?.length ?? 0) === 0;
  const startsPerHour = data?.limits.startsPerHour ?? 20;

  const onKey = (index: number) => (event: KeyboardEvent<HTMLTableRowElement>) => {
    const row = rows[index];
    if (row === undefined) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setParam("automation", row.id);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next !== undefined) {
        setParam("automation", next.id);
        const element = event.currentTarget.parentElement?.children[index + (event.key === "ArrowDown" ? 1 : -1)];
        if (element instanceof HTMLElement) element.focus();
      }
    }
  };

  const actions =
    canEdit && !empty ? (
      <>
        <Link href={`/projects/${projectId}/automations/new?starts=schedule`} className={buttonVariants()}>
          <ClockIcon /> {t("automations.newSchedule")}
        </Link>
        <Link href={`/projects/${projectId}/automations/new?starts=match`} className={buttonVariants({ variant: "primary" })}>
          <PlusIcon /> {t("automations.newRule")}
        </Link>
      </>
    ) : null;

  return (
    <PageFrame
      crumbs={[{ label: projectName, href: `/projects/${projectId}` }, { label: t("automations.title") }]}
      actions={actions}
      {...(empty || data === undefined ? {} : { properties: selected === null ? null : <AutomationPanel automation={selected} canEdit={canEdit} names={names} startsPerHour={startsPerHour} projectId={projectId} onToggle={toggle} /> })}
    >
      <PageHeading title={t("automations.title")} lede={t("automations.lede", { project: projectName })} />
      {list.isError ? (
        <p role="alert" className="mt-6 text-sm text-red">{errorText(list.error)}</p>
      ) : data === undefined ? (
        <div className="mt-[26px]" aria-busy>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex h-14 items-center gap-4 border-b border-line">
              <Skeleton className="h-[18px] w-8" />
              <Skeleton className="w-[160px]" />
              <Skeleton className="w-[240px]" />
              <Skeleton className="w-[100px]" />
            </div>
          ))}
        </div>
      ) : empty ? (
        <EmptyState projectId={projectId} canEdit={canEdit} noBoard={noBoard} />
      ) : (
        <section className="mt-[26px]">
          <div className="mb-1 flex h-[30px] items-center gap-2">
            <h2 className="text-body font-semibold">{t("automations.title")}</h2>
            <span className="font-mono text-[12.5px] text-faint">{all.length}</span>
            <DropdownMenu>
              <DropdownMenuTrigger className="ml-auto inline-flex h-[28px] items-center gap-1.5 rounded-md px-2 text-ui text-muted hover:bg-sel hover:text-text" aria-label={t("automations.kindFilter")}>
                {kindFilterLabel(kind)}
                <ChevronDownIcon aria-hidden className="size-[14px] stroke-[1.75]" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup value={kind} onValueChange={(value) => { setParam("kind", value === "all" ? null : value); }}>
                  {kindFilters.map((one) => (
                    <DropdownMenuRadioItem key={one} value={one}>
                      {kindFilterLabel(one)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {rows.length === 0 ? (
            <p className="flex h-12 items-center gap-2 text-sm text-muted">
              {t("automations.noMatch")}
              <Button variant="link" onClick={() => { setParam("kind", null); }}>{t("automations.showAll")}</Button>
            </p>
          ) : (
            <table className="w-full table-fixed border-collapse text-body" data-testid="automations-table">
              <colgroup>
                <col className="w-[48px]" />
                <col className="w-[170px] max-sm:w-auto" />
                <col className="max-sm:hidden" />
                <col className="w-[112px] max-lg:hidden" />
                <col className="w-[100px] max-[900px]:hidden" />
                <col className="w-[100px] max-[900px]:hidden" />
                <col className="w-[124px] max-sm:hidden" />
              </colgroup>
              <thead>
                <tr className="border-b border-line">
                  <th className={th}><span className="sr-only">{t("automations.col.switch")}</span></th>
                  <th className={th}>{t("automations.col.name")}</th>
                  <th className={cn(th, "max-sm:hidden")}>{t("automations.col.startsWhen")}</th>
                  <th className={cn(th, "max-lg:hidden")}>{t("automations.col.profile")}</th>
                  <th className={cn(th, "max-[900px]:hidden")}>{t("automations.col.poolLabels")}</th>
                  <th className={cn(th, "max-[900px]:hidden")}>{t("automations.col.lastStart")}</th>
                  <th className={cn(th, "max-sm:hidden")}>{t("automations.col.next")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((automation, index) => (
                  <AutomationRow
                    key={automation.id}
                    automation={automation}
                    selected={automation.id === selected?.id}
                    canEdit={canEdit}
                    names={names}
                    startsPerHour={startsPerHour}
                    onSelect={() => { setParam("automation", automation.id); }}
                    onOpen={() => { if (canEdit) router.push(`/projects/${projectId}/automations/${automation.id}`); }}
                    onKey={onKey(index)}
                    onToggle={(on) => { toggle(automation, on); }}
                  />
                ))}
              </tbody>
            </table>
          )}
          {toggleError === null ? null : <p role="alert" className="mt-2 text-sm text-red">{toggleError}</p>}
          <p className="mt-[18px] flex items-start gap-2 text-sm text-faint">
            <ShieldIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
            {t("automations.note", { n: startsPerHour })}
          </p>
        </section>
      )}
    </PageFrame>
  );
};

const AutomationSwitch = ({ automation, canEdit, onToggle, label }: { readonly automation: Automation; readonly canEdit: boolean; readonly onToggle: (on: boolean) => void; readonly label: string }) => {
  const control = (
    <Switch
      checked={automation.paused === null}
      disabled={!canEdit}
      aria-disabled={!canEdit}
      aria-label={label}
      onClick={(event) => { event.stopPropagation(); }}
      onCheckedChange={onToggle}
    />
  );
  return canEdit ? control : (
    <Tooltip content={t("automations.switchMembers")}>
      <span className="inline-flex">{control}</span>
    </Tooltip>
  );
};

const AutomationRow = ({
  automation,
  selected,
  canEdit,
  names,
  startsPerHour,
  onSelect,
  onOpen,
  onKey,
  onToggle,
}: {
  readonly automation: Automation;
  readonly selected: boolean;
  readonly canEdit: boolean;
  readonly names: FilterNames;
  readonly startsPerHour: number;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
  readonly onKey: (event: KeyboardEvent<HTMLTableRowElement>) => void;
  readonly onToggle: (on: boolean) => void;
}) => {
  const startsWhen = startsWhenText(automation, names);
  const next = nextText(automation, startsPerHour);
  const zone = automation.schedule?.timeZone;
  return (
    <tr
      tabIndex={0}
      aria-selected={selected}
      data-automation={automation.name}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={onKey}
      className={cn("h-14 cursor-pointer border-b border-line hover:bg-hover", selected && "bg-sel hover:bg-sel [&>td:first-child]:rounded-l-md [&>td:last-child]:rounded-r-md")}
    >
      <td className="pl-2 pr-3">
        <AutomationSwitch automation={automation} canEdit={canEdit} onToggle={onToggle} label={t("automations.switchLabel", { name: automation.name })} />
      </td>
      <td className="pr-3">
        <span className="block truncate text-[14px] font-medium text-text">{automation.name}</span>
        <span className="flex items-center gap-1.5 text-sm text-faint">
          {automation.kind === "schedule" ? <ClockIcon aria-hidden className="size-[13px] stroke-[1.75]" /> : <FilterIcon aria-hidden className="size-[13px] stroke-[1.75]" />}
          {automation.kind === "schedule" ? t("automations.schedule") : t("automations.rule")}
        </span>
        {/* Below 640px the row's second line is "Starts when · Next". */}
        <span className="block truncate text-sm text-muted sm:hidden">{`${startsWhen} · ${next.text}`}</span>
      </td>
      <td className="pr-3 max-sm:hidden">
        <span className="line-clamp-2 text-ui text-muted" title={startsWhen}>{startsWhen}</span>
      </td>
      <td className="truncate pr-3 text-ui max-lg:hidden">
        {taskKindWord(automation.taskKind)}
        <span className="text-faint"> · </span>
        {automation.agentProfile?.name ?? t("automations.defaultProfile")}
      </td>
      <td className="pr-3 max-[900px]:hidden">
        {automation.poolLabels.length === 0 ? <span className="text-faint">—</span> : (
          <span className="flex items-center gap-1.5">
            <Chip className="font-mono text-[12.5px] text-text">{automation.poolLabels[0]}</Chip>
            {automation.poolLabels.length > 1 ? <span className="font-mono text-[12.5px] text-faint">+{automation.poolLabels.length - 1}</span> : null}
          </span>
        )}
      </td>
      <td className="pr-3 text-ui max-[900px]:hidden">
        <LastStart automation={automation} zone={zone} />
      </td>
      <td className="pr-2 text-ui max-sm:hidden">
        <span className={cn("flex items-center gap-1.5", next.tone === "text" ? "text-text" : next.tone === "muted" ? "text-muted" : "text-faint")} data-testid="automation-next">
          {next.limit ? <Dot tone="amber" className="size-1.5" /> : null}
          <span className="line-clamp-2">{next.text}</span>
        </span>
      </td>
    </tr>
  );
};

const LastStart = ({ automation, zone }: { readonly automation: Automation; readonly zone: string | undefined }) => {
  const run = automation.lastRun;
  if (run === null) return <span className="text-faint">—</span>;
  if (automation.kind === "schedule") {
    return <span className="text-faint">{occurrenceText(automation.lastOccurrenceAt ?? run.at, zone)}</span>;
  }
  return (
    <span className="flex flex-col leading-tight">
      {run.ticketKey === null ? null : run.taskId === null ? (
        <span className="font-mono text-[13px] text-text">{run.ticketKey}</span>
      ) : (
        <Link href={`/tasks/${run.taskId}`} onClick={(event) => { event.stopPropagation(); }} className="font-mono text-[13px] text-text hover:underline">
          {run.ticketKey}
        </Link>
      )}
      <span className="text-faint" suppressHydrationWarning>{Date.now() - run.at < 45_000 ? t("automations.justNow") : t("automations.ago", { age: formatAge(run.at) })}</span>
    </span>
  );
};

const EmptyState = ({ projectId, canEdit, noBoard }: { readonly projectId: ProjectId; readonly canEdit: boolean; readonly noBoard: boolean }) => (
  <div className="mx-auto mt-10 flex max-w-[560px] flex-col items-center text-center" data-testid="automations-empty">
    <img src="/inbox-empty-illustration.webp" alt="" width={560} height={373} className="h-auto w-full max-w-[560px]" />
    <h2 className="mt-4 text-body font-semibold text-text">{t("automations.emptyTitle")}</h2>
    <p className="mt-2 text-sm text-muted">{noBoard ? t("automations.noBoard") : t("automations.emptyBody")}</p>
    {canEdit ? (
      <>
        <div className="mt-4 flex gap-2">
          {noBoard ? (
            <Link href={`/projects/${projectId}/boards`} className={buttonVariants({ variant: "primary" })}>{t("automations.attachBoard")}</Link>
          ) : (
            <Link href={`/projects/${projectId}/automations/new?starts=match`} className={buttonVariants({ variant: "primary" })}>
              <PlusIcon /> {t("automations.newRule")}
            </Link>
          )}
          <Link href={`/projects/${projectId}/automations/new?starts=schedule`} className={buttonVariants()}>
            <ClockIcon /> {t("automations.newSchedule")}
          </Link>
        </div>
        <p className="mt-[18px] text-xs text-faint">{t("automations.emptyAdmins")}</p>
      </>
    ) : (
      <p className="mt-4 text-sm text-faint">{t("automations.emptyMember")}</p>
    )}
  </div>
);

const AutomationPanel = ({
  automation,
  canEdit,
  names,
  startsPerHour,
  projectId,
  onToggle,
}: {
  readonly automation: Automation;
  readonly canEdit: boolean;
  readonly names: FilterNames;
  readonly startsPerHour: number;
  readonly projectId: ProjectId;
  readonly onToggle: (automation: Automation, on: boolean) => void;
}) => {
  const filter = automation.schedule?.does === "prompt" ? null : automation.filter;
  const base = `/projects/${projectId}/automations/${automation.id}`;
  return (
    <div data-testid="automation-panel">
      <PropGroup
        title={
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-[13px] font-medium text-muted">{automation.name}</span>
            <AutomationSwitch automation={automation} canEdit={canEdit} onToggle={(on) => { onToggle(automation, on); }} label={t("automations.switchLabel", { name: automation.name })} />
          </span>
        }
      >
        <PropRow label={t("automations.panel.kind")}>
          <span className="truncate">{automation.schedule === null ? t("automations.panel.ruleKind") : t("automations.panel.scheduleKind", { sentence: automation.schedule.sentence })}</span>
        </PropRow>
        {filter === null ? (
          automation.schedule?.prompt === null || automation.schedule === null ? null : (
            <PropRow label={t("automations.panel.prompt")}>
              <span className="truncate text-muted">{automation.schedule.prompt.split("\n")[0]}</span>
            </PropRow>
          )
        ) : (
          <>
            {filter.labels === null ? null : (
              <PropRow label={t("automations.panel.labels")}>
                <span className="shrink-0 text-muted">{filter.labels.mode === "all" ? t("automations.editor.op.all") : t("automations.editor.op.any")}</span>
                <span className="flex min-w-0 flex-wrap gap-1">{filter.labels.names.map((name) => <Chip key={name} className="text-text">{name}</Chip>)}</span>
              </PropRow>
            )}
            {filter.excludeLabels.length === 0 ? null : (
              <PropRow label={t("automations.panel.notLabels")}>
                <span className="flex min-w-0 flex-wrap gap-1">{filter.excludeLabels.map((name) => <Chip key={name} className="text-text">{name}</Chip>)}</span>
              </PropRow>
            )}
            {filter.status === null ? null : <PropRow label={t("automations.panel.status")}><span className="truncate">{listWords(statusValues(filter.status, names), "or")}</span></PropRow>}
            {filter.assignees.length === 0 ? null : (
              <PropRow label={t("automations.panel.assignee")}><span className="truncate">{listWords(filter.assignees.map((one) => assigneeValue(one, names)), "or")}</span></PropRow>
            )}
            {filter.boardIds.length === 0 ? null : (
              <PropRow label={t("automations.panel.board")}><span className="truncate">{listWords(filter.boardIds.map((id) => names.boards.get(id) ?? id), "or")}</span></PropRow>
            )}
            {filter.trackerProjectIds.length === 0 ? null : <PropRow label={t("automations.panel.project")}><span className="truncate">{listWords(filter.trackerProjectIds, "or")}</span></PropRow>}
          </>
        )}
      </PropGroup>
      <PropGroup title={t("automations.panel.starts")}>
        <PropRow label={t("automations.panel.kind")}>{taskKindLong(automation.taskKind)}</PropRow>
        <PropRow label={t("automations.panel.profile")}>
          <span className="truncate">{automation.agentProfile?.name ?? t("automations.defaultProfile")}</span>
        </PropRow>
        <PropRow label={t("automations.panel.poolLabels")}>
          {automation.poolLabels.length === 0 ? <span className="text-faint">—</span> : automation.poolLabels.map((label) => <Chip key={label} className="font-mono text-[12.5px] text-text">{label}</Chip>)}
        </PropRow>
        <PropRow label={t("automations.panel.approval")}>{automation.requireApproval ? t("automations.panel.approvalMember") : t("automations.panel.approvalNone")}</PropRow>
        {automation.kind === "intake_rule" ? (
          <PropRow label={t("automations.panel.limit")}>
            <span data-testid="automation-limit">{t("automations.panel.limitValue", { n: automation.counts.lastHour, max: startsPerHour })}</span>
          </PropRow>
        ) : null}
      </PropGroup>
      <PropGroup title={t("automations.panel.history")}>
        <PropRow label={t("automations.panel.started")}>
          <span data-testid="automation-started">{plural(automation.counts.started, "automations.panel.startedTasks.one", "automations.panel.startedTasks.other")}</span>
        </PropRow>
        <PropRow label={t("automations.panel.skipped")}>{automation.counts.skipped}</PropRow>
        {automation.kind === "schedule" && automation.counts.missed > 0 ? <PropRow label={t("automations.panel.missed")}>{automation.counts.missed}</PropRow> : null}
        <Link href={`${base}/history`} className="mt-1.5 inline-flex items-center gap-1.5 text-ui text-teal hover:underline">
          {t("automations.panel.openHistory")}
          <ArrowRightIcon aria-hidden className="size-[14px] stroke-[1.75]" />
        </Link>
      </PropGroup>
      {canEdit ? (
        <div className="mb-3.5 grid grid-cols-2 gap-2">
          <Link href={base} className={buttonVariants()}>
            <PencilIcon /> {automation.kind === "schedule" ? t("automations.panel.editSchedule") : t("automations.panel.editRule")}
          </Link>
          {automation.schedule?.does === "prompt" ? null : (
            <Link href={`${base}#dry-run`} className={buttonVariants()}>
              <PlayIcon /> {t("automations.panel.dryRun")}
            </Link>
          )}
        </div>
      ) : null}
      <p className="text-[12.5px] text-faint" suppressHydrationWarning>
        {t("automations.panel.created", { date: dayText(automation.createdAt) })}
        {automation.updatedAt - automation.createdAt > 60_000 ? ` · ${t("automations.panel.edited", { age: formatAge(automation.updatedAt) })}` : ""}
      </p>
    </div>
  );
};
