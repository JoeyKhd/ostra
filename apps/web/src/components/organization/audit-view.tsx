"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUpRightIcon, DownloadIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import type { RouterInputs, RouterOutputs } from "@/lib/trpc";
import { projectIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";

import { actionPrefix, dayKey, dayLabel, entityHref, flattenData, fullTime, isAuditPeriod, periodLabel, periodRange, auditPeriods, shortId, timeOfDay } from "./audit-words";
import type { AuditPeriod } from "./audit-words";
import { FilterMenu } from "./filter-menu";
import type { FilterOption } from "./filter-menu";

type Entry = RouterOutputs["audit"]["list"]["entries"][number];
type ListInput = RouterInputs["audit"]["list"];

const PAGE = 100;
/** The first page has no cursor (a function, so the type stays the cursor's, not `null`'s). */
const firstCursor = (): RouterOutputs["audit"]["list"]["next"] => null;
const ROW = 38;
const BAND = 28;

/** The rows the virtual list draws: a day's band, then its entries. */
type Row = { readonly kind: "band"; readonly key: string; readonly label: string; readonly count: number } | { readonly kind: "entry"; readonly entry: Entry };

const ActorName = ({ entry }: { readonly entry: Entry }): ReactNode => {
  switch (entry.actor.kind) {
    case "member":
      return entry.actor.removed ? (
        <span className="truncate text-muted">{t("audit.removedName", { name: entry.actor.name ?? "" })}</span>
      ) : (
        <span className="truncate text-text">{entry.actor.name ?? "—"}</span>
      );
    case "runner":
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="text-faint">{t("audit.runner")}</span>
          <span className="truncate font-mono text-[13px] text-text">{entry.actor.name ?? entry.actor.id ?? ""}</span>
        </span>
      );
    case "system":
      return <span className="text-muted">{t("audit.system")}</span>;
    default:
      return entry.actor.kind satisfies never;
  }
};

const EntityCell = ({ entry }: { readonly entry: Entry }) =>
  entry.entity === null ? (
    <span className="text-faint">—</span>
  ) : (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-faint">{entry.entity}</span>
      <span className="truncate font-mono text-[13px] text-text">{entry.entityId === null ? "" : shortId(entry.entityId)}</span>
    </span>
  );

/** The selected entry (audit-log.md, "Properties panel"). */
const EntryPanel = ({ entry, onEntity }: { readonly entry: Entry; readonly onEntity: () => void }) => {
  const href = entityHref(entry);
  const lines = flattenData(entry.data);
  const entityText = entry.entity === null ? "—" : `${entry.entity} ${entry.entityId === null ? "" : shortId(entry.entityId)}`;
  return (
    <div data-testid="audit-panel">
      <PropGroup title={entry.action}>
        <PropRow label={t("audit.when")} labelWidth={96}>
          <span title={new Date(entry.at).toISOString()}>{fullTime(entry.at)}</span>
        </PropRow>
        <PropRow label={t("audit.actor")} labelWidth={96}>
          <ActorName entry={entry} />
          {entry.actor.kind === "runner" ? <span className="text-faint"> · {t("audit.runner")}</span> : null}
        </PropRow>
        <PropRow label={t("audit.entity")} labelWidth={96}>
          {href === null ? (
            <span className="truncate">{entityText}</span>
          ) : (
            <Link href={href} className="truncate text-teal" data-testid="audit-entity-link">{entityText}</Link>
          )}
        </PropRow>
        <PropRow label={t("audit.project")} labelWidth={96}>
          {entry.project === null ? <span className="text-faint">—</span> : <Link href={`/projects/${entry.project.id}`} className="truncate text-teal">{entry.project.name}</Link>}
        </PropRow>
      </PropGroup>
      {entry.entity === null || entry.entityId === null ? null : (
        <Button variant="link" className="-mt-2 mb-3.5 text-sm" onClick={onEntity}>
          {t("audit.entriesAbout", { entity: entry.entity })}
        </Button>
      )}
      <div className="mb-3.5 border-b border-line pb-3.5">
        <h3 className="mb-2 text-xs font-medium text-faint">{t("audit.data")}</h3>
        {lines.length === 0 ? (
          <p className="text-sm text-faint">{t("audit.noData")}</p>
        ) : (
          <div className="rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs leading-relaxed" data-testid="audit-data">
            {lines.map(([key, value]) => (
              <div key={key} className="break-all">
                <span className="text-muted">{key}</span> <span className="text-text">{value}</span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-1.5 text-xs text-faint">{t("audit.dataNote")}</p>
      </div>
      {entry.taskId === null ? null : (
        <div className="mb-3.5 border-b border-line pb-3.5">
          <h3 className="mb-2 text-xs font-medium text-faint">{t("audit.eventLog")}</h3>
          <p className="text-sm text-muted">{t("audit.eventLogLede")}</p>
          <Link href={`/tasks/${entry.taskId}?tab=events`} className="mt-1.5 inline-flex items-center gap-1 text-sm text-teal hover:underline" data-testid="audit-open-event-log">
            {t("audit.openEventLog")} <ArrowUpRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
          </Link>
        </div>
      )}
      <div className="flex items-center gap-2 font-mono text-xs text-faint">
        <span title={entry.id} className="truncate">{entry.id}</span>
        <CopyButton text={entry.id} />
      </div>
    </div>
  );
};

export type AuditViewProps = {
  readonly organization: string;
  /** The project's own view, in its settings: fixed to it, with no Project filter or column. */
  readonly project?: { readonly id: ProjectId; readonly name: string };
  /** ADR 0054: the export is for organization admins. */
  readonly canExport: boolean;
  /** Tabs above the heading, on the project's view. */
  readonly tabs?: ReactNode;
};

/**
 * The audit log (F-073, ADR 0054; audit-log.md): who did what, newest first, by actor, action, project
 * and period, all in the URL. A virtual list of day bands and 38px rows, the selected entry in the
 * panel, and the same filters exported as CSV.
 */
export const AuditView = ({ organization, project, canExport, tabs }: AuditViewProps) => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [now] = useState(() => Date.now());

  const actor = params.get("actor");
  const action = params.get("action");
  const projectParam = project === undefined ? params.get("project") : null;
  const periodParam = params.get("period");
  const period: AuditPeriod = isAuditPeriod(periodParam) ? periodParam : "7d";
  const customFrom = params.get("from");
  const customTo = params.get("to");
  const entity = params.get("entity");
  const entityId = params.get("entityId");

  const setParams = (changes: Readonly<Record<string, string | null>>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  const pickedProject = projectIdSchema.safeParse(projectParam);
  const range = periodRange(period, now, { from: customFrom, to: customTo });
  const input: ListInput = {
    ...(project === undefined ? (pickedProject.success ? { projectId: pickedProject.data } : {}) : { projectId: project.id }),
    ...(actor === null ? {} : { actorId: actor }),
    ...(action === null ? {} : { action }),
    ...(entity === null ? {} : { entity }),
    ...(entityId === null ? {} : { entityId }),
    ...range,
    limit: PAGE,
  };

  const pages = useInfiniteQuery({
    queryKey: [...trpc.audit.list.queryKey(input), "pages"],
    queryFn: ({ pageParam }) => client.audit.list.query(pageParam === null ? input : { ...input, cursor: pageParam }),
    initialPageParam: firstCursor(),
    getNextPageParam: (last) => last.next,
  });
  const members = useQuery(trpc.members.list.queryOptions({ includeRemoved: true }));
  const actions = useQuery(trpc.audit.actions.queryOptions());
  const projects = useQuery({ ...trpc.projects.list.queryOptions(), enabled: project === undefined });

  const entries = useMemo(() => pages.data?.pages.flatMap((page) => page.entries) ?? [], [pages.data]);
  const more = pages.hasNextPage;
  const rows = useMemo<readonly Row[]>(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(dayKey(entry.at), (counts.get(dayKey(entry.at)) ?? 0) + 1);
    const out: Row[] = [];
    let last: string | null = null;
    for (const entry of entries) {
      const key = dayKey(entry.at);
      if (key !== last) {
        out.push({ kind: "band", key, label: dayLabel(entry.at, now), count: counts.get(key) ?? 0 });
        last = key;
      }
      out.push({ kind: "entry", entry });
    }
    return out;
  }, [entries, now]);

  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length + (more ? 1 : 0),
    getScrollElement: () => scroller.current,
    estimateSize: (index) => (rows[index]?.kind === "band" ? BAND : ROW),
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const lastItem = items.at(-1);
  useEffect(() => {
    if (lastItem !== undefined && lastItem.index >= rows.length - 1 && more && !pages.isFetchingNextPage) void pages.fetchNextPage();
  }, [lastItem, rows.length, more, pages]);

  const entryParam = params.get("entry");
  const selected = entries.find((entry) => entry.id === entryParam) ?? (entryParam === null ? entries[0] : undefined);
  const select = (entry: Entry) => { setParams({ entry: entry.id }); };

  const onRowKey = (event: KeyboardEvent<HTMLButtonElement>, entry: Entry) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const at = entries.findIndex((candidate) => candidate.id === entry.id);
    const next = entries[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (next === undefined) return;
    select(next);
    const rowIndex = rows.findIndex((row) => row.kind === "entry" && row.entry.id === next.id);
    virtualizer.scrollToIndex(rowIndex);
    requestAnimationFrame(() => { document.querySelector<HTMLButtonElement>(`[data-entry="${next.id}"]`)?.focus(); });
  };

  // The filters' choices.
  const activeMembers = (members.data ?? []).filter((member) => member.state !== "removed");
  const removedMembers = (members.data ?? []).filter((member) => member.state === "removed");
  const actorOptions: FilterOption[] = [
    ...activeMembers.map((member) => ({ value: member.memberId, label: member.name })),
    ...removedMembers.map((member) => ({ value: member.memberId, label: member.name, muted: true })),
  ];
  const actionOptions: FilterOption[] = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const row of actions.data ?? []) {
      const prefix = actionPrefix(row.action);
      groups.set(prefix, [...(groups.get(prefix) ?? []), row.action]);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([prefix, names]) => [
        { value: prefix, label: `${prefix}*`, mono: true, header: true },
        ...names.sort().map((name) => ({ value: name, label: name, mono: true })),
      ]);
  }, [actions.data]);
  const projectOptions: FilterOption[] = (projects.data ?? []).map((candidate) => ({ value: candidate.id, label: candidate.name }));
  const periodOptions: FilterOption[] = auditPeriods.filter((value) => value !== "custom").map((value) => ({ value, label: periodLabel(value) }));

  const filtered = actor !== null || action !== null || projectParam !== null || period !== "7d" || entity !== null;
  const clearFilters = () => { setParams({ actor: null, action: null, project: null, period: null, from: null, to: null, entity: null, entityId: null, entry: null }); };

  const exportHref = (() => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) {
      if (key !== "limit" && (typeof value === "string" || typeof value === "number")) query.set(key, String(value));
    }
    const rest = query.toString();
    return rest === "" ? "/api/audit/export" : `/api/audit/export?${rest}`;
  })();

  const countText =
    pages.data === undefined ? null : more ? t("audit.countMore", { n: entries.length }) : plural(entries.length, "audit.countOne", "audit.countOther");

  const grid = project === undefined ? "md:grid-cols-[80px_190px_220px_minmax(0,1fr)_140px]" : "md:grid-cols-[80px_190px_220px_minmax(0,1fr)]";

  return (
    <PageFrame
      crumbs={project === undefined ? [{ label: organization }, { label: t("audit.title") }] : [{ label: project.name, href: `/projects/${project.id}` }, { label: t("projectSettings.settings") }, { label: t("audit.title") }]}
      {...(canExport
        ? {
            actions: entries.length === 0 ? (
              <Button variant="primary" disabled><DownloadIcon className="stroke-[1.75]" />{t("audit.export")}</Button>
            ) : (
              <Button variant="primary" asChild>
                <a href={exportHref} download data-testid="audit-export"><DownloadIcon className="stroke-[1.75]" />{t("audit.export")}</a>
              </Button>
            ),
          }
        : {})}
      properties={
        pages.isPending ? (
          <div className="space-y-3" aria-busy><Skeleton className="w-[120px]" /><Skeleton className="w-[220px]" /><Skeleton className="w-[180px]" /></div>
        ) : selected === undefined ? (
          <p className="text-ui text-faint">{t("audit.noneSelected")}</p>
        ) : (
          <EntryPanel entry={selected} onEntity={() => { setParams({ entity: selected.entity, entityId: selected.entityId, entry: null }); }} />
        )
      }
    >
      {tabs}
      <PageHeading
        title={t("audit.title")}
        lede={project === undefined ? t("audit.lede", { organization }) : t("audit.ledeProject", { project: project.name })}
      />
      <div className="mt-5 flex flex-wrap items-center gap-2" data-testid="audit-filters">
        <FilterMenu testId="audit-filter-actor" label={t("audit.actor")} value={actor} defaultLabel={t("audit.all")} options={actorOptions} searchable onChange={(value) => { setParams({ actor: value, entry: null }); }} />
        <FilterMenu testId="audit-filter-action" label={t("audit.action")} value={action} defaultLabel={t("audit.all")} options={actionOptions} searchable onChange={(value) => { setParams({ action: value, entry: null }); }} />
        {project === undefined ? (
          <FilterMenu testId="audit-filter-project" label={t("audit.project")} value={projectParam} defaultLabel={t("audit.all")} options={projectOptions} onChange={(value) => { setParams({ project: value, entry: null }); }} />
        ) : null}
        <FilterMenu
          testId="audit-filter-period"
          label={t("audit.period.label")}
          value={period === "7d" ? null : period}
          defaultLabel={periodLabel("7d")}
          options={[...periodOptions, { value: "custom", label: periodLabel("custom") }]}
          onChange={(value) => { setParams({ period: value, entry: null, ...(value === "custom" ? {} : { from: null, to: null }) }); }}
          extra={
            period === "custom" ? (
              <div className="mt-1 flex items-center gap-2 border-t border-line px-1 pt-2">
                <Input type="date" aria-label={t("audit.from")} value={customFrom ?? ""} onChange={(event) => { setParams({ from: event.target.value === "" ? null : event.target.value }); }} className="h-8" />
                <Input type="date" aria-label={t("audit.to")} value={customTo ?? ""} onChange={(event) => { setParams({ to: event.target.value === "" ? null : event.target.value }); }} className="h-8" />
              </div>
            ) : null
          }
        />
        {entity === null ? null : (
          <span className="inline-flex h-[30px] items-center gap-1.5 rounded-[7px] border border-line-2 pl-2.5 pr-1.5 text-ui" data-testid="audit-entity-chip">
            <span className="text-faint">{entity}</span>
            <span className="font-mono text-[13px] text-text">{entityId === null ? "" : shortId(entityId)}</span>
            <button type="button" aria-label={t("audit.filterClear", { label: entity })} onClick={() => { setParams({ entity: null, entityId: null }); }} className="grid size-5 place-items-center text-faint hover:text-text">
              <XIcon aria-hidden className="size-[14px] stroke-[1.75]" />
            </button>
          </span>
        )}
        {countText === null ? null : <span className="w-full text-sm text-faint sm:ml-auto sm:w-auto" data-testid="audit-count">{countText}</span>}
      </div>

      {pages.isError ? (
        <p role="alert" className="mt-5 text-sm text-red">{errorText(pages.error)}</p>
      ) : pages.data !== undefined && entries.length === 0 ? (
        <p className="mt-6 text-ui text-muted">
          {t("audit.noMatch")}{" "}
          {filtered ? <Button variant="link" onClick={clearFilters}>{t("audit.clearFilters")}</Button> : null}
        </p>
      ) : (
        <div className="mt-[18px]">
          <div className={cn("hidden h-[30px] items-center gap-x-3 border-b border-line text-[12.5px] font-medium text-faint md:grid", grid)}>
            <span className="pl-2">{t("audit.time")}</span>
            <span>{t("audit.actor")}</span>
            <span>{t("audit.action")}</span>
            <span>{t("audit.entity")}</span>
            {project === undefined ? <span>{t("audit.project")}</span> : null}
          </div>
          {pages.data === undefined ? (
            <div aria-busy>{Array.from({ length: 8 }, (_, i) => <div key={i} className="flex h-[38px] items-center border-b border-line"><Skeleton className="w-[360px] max-w-full" /></div>)}</div>
          ) : (
            <div ref={scroller} className="h-[60vh] overflow-y-auto xl:h-[calc(100dvh-300px)]" data-testid="audit-table" role="listbox" aria-label={t("audit.title")}>
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {items.map((item) => {
                  const row = rows[item.index];
                  const style = { transform: `translateY(${String(item.start)}px)` } as const;
                  if (row === undefined) {
                    return (
                      <div key="more" className="absolute left-0 top-0 flex h-[38px] w-full items-center border-b border-line" style={style}>
                        <Skeleton className="w-[320px]" />
                      </div>
                    );
                  }
                  if (row.kind === "band") {
                    return (
                      <div key={`band-${row.key}`} className="absolute left-0 top-0 flex h-[28px] w-full items-center gap-2 bg-surface px-2 text-[12.5px]" style={style} data-testid="audit-band">
                        <span className="font-medium text-muted">{row.label}</span>
                        <span className="font-mono text-faint">{row.count}</span>
                      </div>
                    );
                  }
                  const entry = row.entry;
                  const picked = selected?.id === entry.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="option"
                      aria-selected={picked}
                      data-entry={entry.id}
                      data-testid="audit-row"
                      data-action={entry.action}
                      data-entity-id={entry.entityId ?? ""}
                      onClick={() => { select(entry); }}
                      onKeyDown={(event) => { onRowKey(event, entry); }}
                      className={cn("absolute left-0 top-0 grid h-[38px] w-full grid-cols-[56px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 border-b border-line text-left text-ui hover:bg-raise", grid, picked && "bg-sel hover:bg-sel")}
                      style={style}
                    >
                      <span className="pl-2 font-mono text-[13px] text-faint">{timeOfDay(entry.at)}</span>
                      <span className="flex min-w-0"><ActorName entry={entry} /></span>
                      <span className="truncate font-mono text-[13px] text-muted">{entry.action}</span>
                      <span className="hidden min-w-0 md:flex"><EntityCell entry={entry} /></span>
                      {project === undefined ? <span className={cn("hidden truncate md:inline", entry.project === null ? "text-faint" : "text-muted")}>{entry.project?.name ?? "—"}</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </PageFrame>
  );
};
