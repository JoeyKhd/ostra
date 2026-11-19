"use client";

import { skipToken, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, ArrowUpIcon, ArrowUpRightIcon, BotIcon, ChevronDownIcon, CircleAlertIcon, InfoIcon, LoaderCircleIcon, PlusIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { runnerIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";

import { unprotectedRepos, unsupportedRepos } from "@/components/projects/repo-checks-words";
import type { RepoDetail } from "@/components/projects/repo-checks-words";
import { PageFrame, PageHeading, PropRow } from "@/components/shell/page-frame";
import { ProfilePicker, useStartProfile } from "@/components/agent-profiles/profile-picker";
import { POOLS, RunOnPicker, useRunOn } from "@/components/tasks/run-on";
import { stateTone, taskStateText } from "@/components/tasks/task-words";
import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip, Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC, useTRPCClient } from "@/lib/trpc";

import { cacheAge, contextLine, filtered, filtersFrom, filtersToSearch, ledeSource, listInputOf, priorityText, rowAge } from "./inbox-words";
import type { InboxDetail, InboxFilters, InboxSource, InboxTicket } from "./inbox-words";
import { SafeMarkdown } from "./safe-markdown";
import { PriorityIcon, TicketStatusIcon } from "./ticket-icons";

const LIVE_MS = 10_000;

/** The first page has no cursor. */
const firstPage = (): string | null => null;

/** The task a ticket has: its state's mark and word, then its short ID, linking to it. */
export const TaskMark = ({ task }: { readonly task: NonNullable<InboxTicket["task"]> }) => (
  <Link href={`/tasks/${task.id}`} className="flex min-w-0 items-center gap-2 text-ui hover:underline" onClick={(event) => { event.stopPropagation(); }}>
    <Status tone={stateTone(task.state)} className="min-w-0">
      <span className="truncate text-text">{taskStateText(task.state)}</span>
    </Status>
    <span className="font-mono text-xs text-faint">{task.shortId}</span>
  </Link>
);

/** One grid for every row, so each column starts at the same x. Board and Task columns come and go. */
const rowGrid = (several: boolean, tasks: boolean) =>
  cn(
    "grid min-h-10 w-full items-center gap-x-2.5 text-left",
    "grid-cols-[16px_72px_minmax(0,1fr)_36px] md:grid-cols-[16px_76px_minmax(0,1fr)_112px_110px_36px]",
    several && tasks
      ? "xl:grid-cols-[16px_76px_minmax(0,1fr)_112px_100px_110px_150px_36px]"
      : several
        ? "xl:grid-cols-[16px_76px_minmax(0,1fr)_112px_100px_110px_36px]"
        : tasks
          ? "xl:grid-cols-[16px_76px_minmax(0,1fr)_112px_110px_150px_36px]"
          : "xl:grid-cols-[16px_76px_minmax(0,1fr)_112px_110px_36px]",
  );

/** One ticket: priority, key, title, labels, (board), status, its task, and the age of its last change. */
export const TicketRow = ({ ticket, several, tasks = true, selected, onSelect, now }: { readonly ticket: InboxTicket; readonly several: boolean; readonly tasks?: boolean; readonly selected: boolean; readonly onSelect: () => void; readonly now: number }) => (
  <li className="border-b border-line" data-ticket={ticket.key} data-selected={selected}>
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === "Enter") onSelect(); }}
      className={cn(rowGrid(several, tasks), "cursor-default rounded-md px-2 outline-none hover:bg-raise focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-muted", selected && "bg-sel hover:bg-sel")}
    >
      <span title={priorityText(ticket.priority)} className="text-muted">
        <PriorityIcon priority={ticket.priority} />
      </span>
      <span className="font-mono text-ui text-faint">{ticket.key}</span>
      <span className="truncate text-body text-text">{ticket.title}</span>
      <span className="hidden min-w-0 items-center gap-1.5 md:flex">
        {ticket.labels.slice(0, 2).map((label) => (
          <Chip key={label} className="max-w-[100px] truncate">{label}</Chip>
        ))}
        {ticket.labels.length > 2 ? <span className="text-xs text-faint">+{ticket.labels.length - 2}</span> : null}
      </span>
      {several ? <span className="hidden truncate text-ui text-muted xl:block">{ticket.board.name}</span> : null}
      <span className="hidden min-w-0 items-center gap-2 text-ui text-muted md:flex">
        <TicketStatusIcon category={ticket.status.category} className="shrink-0" />
        <span className="truncate">{ticket.status.name ?? "–"}</span>
      </span>
      {tasks ? <span className="hidden min-w-0 xl:block">{ticket.task?.active === true ? <TaskMark task={ticket.task} /> : null}</span> : null}
      <span className="text-right font-mono text-xs text-faint">{rowAge(ticket.updatedAt, now)}</span>
    </div>
  </li>
);

type Option = { readonly value: string; readonly label: string };

/** A filter's trigger and its checklist: `Status: Open, started`. */
export const FilterMenu = ({ label, options, selected, onChange }: { readonly label: string; readonly options: readonly Option[]; readonly selected: readonly string[]; readonly onChange: (values: readonly string[]) => void }) => {
  const names = options.filter((option) => selected.includes(option.value)).map((option) => option.label);
  return (
    <Popover>
      <PopoverTrigger className={cn(buttonVariants({ size: "sm" }), "h-[30px] bg-transparent px-3 text-ui")}>
        {label}
        {names.length === 0 ? null : (
          <>
            :<span className="max-w-[160px] truncate text-text">{names.join(", ")}</span>
          </>
        )}
        <ChevronDownIcon aria-hidden className="size-3! text-faint" />
      </PopoverTrigger>
      <PopoverContent className="w-[240px]">
        {options.length === 0 ? <p className="px-2 py-1.5 text-ui text-faint">{t("inbox.filter.none")}</p> : null}
        {options.map((option) => {
          const on = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemcheckbox"
              aria-checked={on}
              onClick={() => { onChange(on ? selected.filter((value) => value !== option.value) : [...selected, option.value]); }}
              className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-ui text-text hover:bg-sel"
            >
              <span className={cn("grid size-3.5 place-items-center rounded-[3px] border", on ? "border-text bg-text text-bg" : "border-faint")}>{on ? "✓" : ""}</span>
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
};

/** The lede: where the tickets come from and how old the cache is, or that Linear isn't answering. */
export const InboxLede = ({ source, now }: { readonly source: InboxSource; readonly now: number }) => {
  if (source.boards.length === 0) return <>{t("inbox.ledeNoBoards")}</>;
  const { board, text } = ledeSource(source);
  const [before = "", after = ""] = text.split("{board}");
  const age = source.cacheUpdatedAt === null ? null : cacheAge(source.cacheUpdatedAt, now);
  return (
    <>
      {before}
      {board === null ? null : <span className="text-text">{board}</span>}
      {after}
      {source.stale ? (
        <span className="ml-1 inline-flex items-center gap-1.5 text-red">
          · <CircleAlertIcon aria-hidden className="size-[13px] stroke-[1.75]" />
          {t("inbox.stale", { age: age ?? "–" })}
        </span>
      ) : age === null ? null : (
        <>
          {" · "}
          {t("inbox.updated", { age })}
        </>
      )}
      {source.connection?.mode === "polling" && !source.stale ? ` · ${t("inbox.polling", { seconds: source.connection.pollSeconds })}` : null}
    </>
  );
};

/** The empty states: no connection, no boards, or nothing open. */
export const InboxEmpty = ({ kind, board, projectId, admin }: { readonly kind: "no-connection" | "no-boards" | "nothing-open"; readonly board: string | null; readonly projectId: ProjectId; readonly admin: boolean }) => (
  <div className="mx-auto mt-10 flex max-w-[560px] flex-col items-center text-center" data-testid={`inbox-empty-${kind}`}>
    <img src="/inbox-empty-illustration.webp" alt="" width={560} height={373} className="h-auto w-full max-w-[560px]" />
    <h2 className="mt-4 text-[15px] font-semibold text-text">
      {kind === "no-connection" ? t("inbox.empty.noConnection") : kind === "no-boards" ? t("inbox.empty.noBoards") : board === null ? t("inbox.empty.nothingOpenMany") : t("inbox.empty.nothingOpen", { board })}
    </h2>
    <p className="mt-2 text-body text-muted">
      {kind === "no-connection" ? t("inbox.empty.noConnectionBody") : kind === "no-boards" ? t("inbox.empty.noBoardsBody") : t("inbox.empty.nothingOpenBody")}
    </p>
    {admin && kind !== "nothing-open" ? (
      <Link href={kind === "no-connection" ? "/organization/linear" : `/projects/${projectId}/boards`} className={cn(buttonVariants({ variant: "primary", size: "lg" }), "mt-4")}>
        {kind === "no-boards" ? <PlusIcon aria-hidden /> : null}
        {kind === "no-connection" ? t("inbox.empty.connect") : t("inbox.empty.attach")}
      </Link>
    ) : null}
  </div>
);

const Description = ({ detail }: { readonly detail: InboxDetail }) => {
  const [open, setOpen] = useState(false);
  if (detail.description === null || detail.description.trim() === "") return <p className="text-ui text-faint">{t("inbox.panel.noDescription")}</p>;
  return (
    <div className="text-ui leading-[1.6] text-muted">
      <div className={cn(!open && "line-clamp-4")} data-testid="ticket-description">
        <SafeMarkdown markdown={detail.description} />
      </div>
      {detail.imageCount > 0 ? <p className="mt-1 text-xs text-faint">{plural(detail.imageCount, "inbox.panel.images.one", "inbox.panel.images.other")}</p> : null}
      <Button variant="link" className="mt-1 h-auto px-0 text-ui" onClick={() => { setOpen(!open); }}>
        {open ? t("inbox.panel.showLess") : t("inbox.panel.showMore")}
      </Button>
    </div>
  );
};

const Sep = () => <div className="my-3.5 h-px bg-line" />;

export type StartFormProps = {
  readonly detail: InboxDetail;
  readonly repos: readonly RepoDetail[];
  /** The profile picker (F-021), or `null` when no profile is offered: the task can't start. */
  readonly profile: ReactNode | null;
  readonly runOn: ReactNode;
  readonly onStart: () => void;
  readonly starting: boolean;
  readonly error: string | null;
};

/** The selected ticket: its rows, its description, and Start a task (or its active task). */
export const TicketPanel = ({ detail, several, now, start }: { readonly detail: InboxDetail; readonly several: boolean; readonly now: number; readonly start: StartFormProps }) => {
  const blocked = unsupportedRepos(start.repos)[0];
  const unprotected = unprotectedRepos(start.repos)[0];
  const active = detail.task?.active === true ? detail.task : null;
  const earlier = detail.task !== null && !detail.task.active ? detail.task : null;
  return (
    <div data-testid="ticket-panel">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-sm text-faint">{detail.key}</span>
        <a href={detail.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ui text-teal hover:underline">
          {t("inbox.panel.openInLinear")}
          <ArrowUpRightIcon aria-hidden className="size-3 stroke-[1.75]" />
        </a>
      </div>
      <h2 className="mb-2.5 mt-1 break-words text-[16px] font-semibold leading-snug text-text">{detail.title}</h2>
      <PropRow label={t("inbox.panel.status")}>
        <TicketStatusIcon category={detail.status.category} />
        {detail.status.name ?? "–"}
      </PropRow>
      <PropRow label={t("inbox.panel.priority")}>
        <PriorityIcon priority={detail.priority} />
        {priorityText(detail.priority)}
      </PropRow>
      {detail.labels.length === 0 ? null : (
        <PropRow label={t("inbox.panel.labels")}>
          <span className="flex flex-wrap gap-1.5 py-1">
            {detail.labels.map((label) => (
              <Chip key={label}>{label}</Chip>
            ))}
          </span>
        </PropRow>
      )}
      <PropRow label={t("inbox.panel.assignee")}>{detail.assignee === null ? <span className="text-muted">{t("inbox.panel.unassigned")}</span> : detail.assignee.name}</PropRow>
      {several ? <PropRow label={t("inbox.panel.board")}>{detail.board.name}</PropRow> : null}
      <PropRow label={t("inbox.panel.updated")}>
        <span className="font-mono" title={new Date(detail.updatedAt).toISOString()}>
          {cacheAge(detail.updatedAt, now)}
        </span>
      </PropRow>
      <Sep />
      <Description detail={detail} />
      <Sep />
      {active === null ? (
        <div data-testid="start-task">
          <h3 className="mb-2 text-xs font-medium text-faint">{t("inbox.panel.start")}</h3>
          <PropRow label={t("inbox.panel.kind")}>{t("inbox.panel.code")}</PropRow>
          <PropRow label={t("inbox.panel.profile")}>
            {start.profile ?? (
              <>
                <BotIcon aria-hidden />
                <span className="truncate">{t("inbox.panel.noProfile")}</span>
              </>
            )}
          </PropRow>
          <PropRow label={t("inbox.panel.runOn")}>{start.runOn}</PropRow>
          <p className="mt-2 flex items-start gap-2 text-xs text-faint">
            <InfoIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />
            {contextLine(detail)}
          </p>
          {blocked === undefined ? null : (
            <p id="inbox-repo-block" className="mt-2 flex items-start gap-2 text-xs text-muted">
              <CircleAlertIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75] text-red" />
              {t("inbox.panel.unsupported", { repo: blocked.fullName })}
            </p>
          )}
          {blocked !== undefined || unprotected === undefined ? null : (
            <p className="mt-2 flex items-start gap-2 text-xs text-muted">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />
              {t("inbox.panel.unprotected", { repo: unprotected.fullName })}
            </p>
          )}
          {earlier === null ? null : (
            <p className="mt-2 text-xs text-faint">
              {t("inbox.panel.earlier", { id: "\u0000", state: taskStateText(earlier.state).toLowerCase() })
                .split("\u0000")
                .map((part, i) => (
                  <span key={`${part}-${String(i)}`}>
                    {i > 0 ? (
                      <Link href={`/tasks/${earlier.id}`} className="font-mono text-teal hover:underline">
                        {earlier.shortId}
                      </Link>
                    ) : null}
                    {part}
                  </span>
                ))}
            </p>
          )}
          <Button
            variant="primary"
            className="mt-3 h-8 w-full"
            disabled={start.starting || blocked !== undefined || start.profile === null}
            onClick={start.onStart}
            {...(blocked === undefined ? {} : { "aria-describedby": "inbox-repo-block" })}
          >
            {start.starting ? <LoaderCircleIcon aria-hidden className="size-[13px] animate-spin" /> : <ArrowUpIcon aria-hidden />}
            {start.starting ? t("inbox.panel.starting") : t("inbox.panel.startTask")}
          </Button>
          {start.error === null ? null : (
            <p role="alert" className="mt-2 flex items-start gap-1.5 text-ui text-red">
              <CircleAlertIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
              {start.error}
            </p>
          )}
        </div>
      ) : (
        <div data-testid="active-task">
          <h3 className="mb-2 text-xs font-medium text-faint">{t("inbox.panel.task")}</h3>
          <PropRow label={t("inbox.panel.taskState")}>
            <Status tone={stateTone(active.state)}>{taskStateText(active.state)}</Status>
          </PropRow>
          <PropRow label={t("inbox.panel.taskId")}>
            <span className="font-mono">{active.shortId}</span>
          </PropRow>
          {detail.driver === null ? null : <PropRow label={t("inbox.panel.driver")}>{detail.driver.name}</PropRow>}
          <Link href={`/tasks/${active.id}`} className={cn(buttonVariants(), "mt-3 h-8 w-full")}>
            <ArrowRightIcon aria-hidden />
            {t("inbox.panel.openTask")}
          </Link>
        </div>
      )}
    </div>
  );
};

const LoadingRows = ({ rows }: { readonly rows: number }) => (
  <ul aria-busy>
    {Array.from({ length: rows }, (_, i) => (
      <li key={i} className="flex h-10 items-center gap-4 border-b border-line px-2">
        <Skeleton className="w-[60px]" />
        <Skeleton className="w-[280px]" />
        <Skeleton className="ml-auto w-[90px]" />
      </li>
    ))}
  </ul>
);

/** Project › Inbox (F-010; inbox.md): the project's open tickets, filtered, and Start task on one. */
export const InboxView = ({ projectId, admin }: { readonly projectId: ProjectId; readonly admin: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filters = filtersFrom(params);
  const [text, setText] = useState(filters.text);
  const [mounted] = useState(() => Date.now());
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const options = useQuery(trpc.inbox.filters.queryOptions({ projectId }));
  const runners = useQuery(trpc.runners.mine.queryOptions());
  const { chosen, runner, setRunOn } = useRunOn(runners.data);
  // The member's profiles for this project, its default first (F-021).
  const profiles = useStartProfile(projectId);
  // Paged by cursor. `inbox.list`'s input is strict, so the pages are fetched with the plain client
  // rather than tRPC's infinite options, which add a `direction` to the input.
  const client = useTRPCClient();
  const input = listInputOf(projectId, filters);
  const pages = useInfiniteQuery({
    queryKey: [...trpc.inbox.list.queryKey(input), "pages"],
    queryFn: ({ pageParam }) => client.inbox.list.query(pageParam === null ? input : { ...input, cursor: pageParam }),
    initialPageParam: firstPage(),
    getNextPageParam: (last) => last.nextCursor,
    // A ticket made in Linear shows without a reload.
    refetchInterval: LIVE_MS,
  });
  const tickets = pages.data?.pages.flatMap((page) => page.tickets) ?? [];
  const first = pages.data?.pages[0];
  const source = first?.source;
  const several = (source?.boards.length ?? 0) > 1;
  const withTasks = tickets.some((item) => item.task?.active === true);
  const selected = tickets.find((ticket) => ticket.key === params.get("ticket")) ?? tickets[0];
  const detail = useQuery({ ...trpc.inbox.get.queryOptions(selected === undefined ? skipToken : { projectId, ticketId: selected.id }), refetchInterval: LIVE_MS });
  const now = pages.dataUpdatedAt === 0 ? mounted : pages.dataUpdatedAt;
  const end = useRef<HTMLDivElement>(null);

  const navigate = (next: InboxFilters, keep: URLSearchParams = new URLSearchParams(params.toString())) => {
    keep.delete("ticket");
    router.replace(`${pathname}${filtersToSearch(next, keep)}`, { scroll: false });
  };
  const select = (ticket: InboxTicket) => {
    const next = new URLSearchParams(params.toString());
    next.set("ticket", ticket.key);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  // The text filter follows typing, 250ms after it stops.
  useEffect(() => {
    if (text === filters.text) return;
    const timer = setTimeout(() => { navigate({ ...filters, text }); }, 250);
    return () => { clearTimeout(timer); };
  });

  // The next page loads when the last row scrolls into view.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  useEffect(() => {
    const node = end.current;
    if (node === null || !hasNextPage) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const start = useMutation(
    trpc.tasks.startFromTicket.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() });
        await queryClient.invalidateQueries({ queryKey: trpc.projects.pathKey() });
      },
    }),
  );

  const statusOptions = [
    { value: "open", label: t("inbox.filter.open") },
    { value: "started", label: t("inbox.filter.started") },
    { value: "done", label: t("inbox.filter.done") },
    ...(options.data?.statuses ?? []).map((status) => ({ value: status.id, label: status.name })),
  ];
  const empty: "no-connection" | "no-boards" | "nothing-open" | null =
    source === undefined ? null : source.connection === null ? "no-connection" : source.boards.length === 0 ? "no-boards" : tickets.length === 0 && !filtered(filters) ? "nothing-open" : null;
  const panel =
    selected === undefined || empty !== null ? undefined : detail.data === undefined ? (
      <div className="space-y-3" aria-busy>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="w-[220px]" />
        ))}
      </div>
    ) : (
      <TicketPanel
        detail={detail.data}
        several={several}
        now={now}
        start={{
          detail: detail.data,
          repos: project.data?.repos ?? [],
          profile:
            profiles.options !== undefined && profiles.chosen === null ? null : (
              <ProfilePicker options={profiles.options} chosen={profiles.chosen} onPick={profiles.pick} disabled={start.isPending} className="-ml-2" />
            ),
          runOn: <RunOnPicker runners={runners.data} runner={runner} onPick={setRunOn} disabled={start.isPending} />,
          starting: start.isPending,
          error: errorText(start.error),
          onStart: () => {
            start.mutate({
              projectId,
              ticketId: detail.data.id,
              ...(profiles.chosen === null ? {} : { agentProfileId: profiles.chosen.profileId }),
              ...(chosen === POOLS ? {} : { runnerId: runnerIdSchema.parse(chosen) }),
            });
          },
        }}
      />
    );

  return (
    <PageFrame crumbs={[{ label: project.data?.name ?? "", href: `/projects/${projectId}` }, { label: t("inbox.title") }]} {...(panel === undefined ? {} : { properties: panel, wideProperties: true })}>
      <PageHeading title={t("inbox.title")} lede={source === undefined ? <Skeleton className="mt-1 w-[320px]" /> : <InboxLede source={source} now={now} />} />
      {empty === "no-connection" || empty === "no-boards" ? (
        <InboxEmpty kind={empty} board={null} projectId={projectId} admin={empty === "no-connection" ? admin : project.data?.role === "admin"} />
      ) : (
        <>
          <div className="mt-[18px] flex flex-wrap items-center gap-2" data-testid="inbox-filters">
            <label className="relative w-full sm:w-[240px]">
              <SearchIcon aria-hidden className="absolute left-2.5 top-1/2 size-[14px] -translate-y-1/2 stroke-[1.75] text-faint" />
              <input
                aria-label={t("inbox.filter.text")}
                placeholder={t("inbox.filter.text")}
                value={text}
                onChange={(event) => { setText(event.target.value); }}
                className="h-[30px] w-full rounded-md border border-line-2 bg-surface pl-8 pr-2.5 text-ui text-text placeholder:text-faint focus-visible:border-faint focus-visible:outline-none"
              />
            </label>
            <FilterMenu label={t("inbox.filter.status")} options={statusOptions} selected={filters.status} onChange={(status) => { navigate({ ...filters, status: status.length === 0 ? ["open"] : status }); }} />
            <FilterMenu label={t("inbox.filter.label")} options={(options.data?.labels ?? []).map((label) => ({ value: label, label }))} selected={filters.labels} onChange={(labels) => { navigate({ ...filters, labels }); }} />
            <FilterMenu
              label={t("inbox.filter.priority")}
              options={[1, 2, 3, 4, 0].map((n) => ({ value: String(n), label: priorityText(n === 0 ? null : n) }))}
              selected={filters.priorities.map(String)}
              onChange={(values) => { navigate({ ...filters, priorities: values.map(Number) }); }}
            />
            <FilterMenu
              label={t("inbox.filter.assignee")}
              options={[...(options.data?.assignees ?? []).map((person) => ({ value: person.id, label: person.name })), { value: "unassigned", label: t("inbox.filter.unassigned") }]}
              selected={filters.assignees}
              onChange={(assignees) => { navigate({ ...filters, assignees }); }}
            />
            {first === undefined ? null : <span className="ml-auto font-mono text-xs text-faint">{plural(first.total, "inbox.filter.total.one", "inbox.filter.total.other")}</span>}
          </div>
          {pages.isError ? (
            <p role="alert" className="mt-4 text-ui text-red">{errorText(pages.error)}</p>
          ) : pages.data === undefined ? (
            <div className="mt-3.5">
              <LoadingRows rows={8} />
            </div>
          ) : empty === "nothing-open" ? (
            <InboxEmpty kind="nothing-open" board={source?.boards.length === 1 ? (source.boards[0]?.name ?? null) : null} projectId={projectId} admin={false} />
          ) : tickets.length === 0 ? (
            <p className="mt-6 text-body text-muted">
              {t("inbox.filter.noMatch")}{" "}
              <Button variant="link" className="h-auto px-0" onClick={() => { setText(""); navigate({ status: ["open"], labels: [], priorities: [], assignees: [], text: "" }); }}>
                {t("inbox.filter.clear")}
              </Button>
            </p>
          ) : (
            <ul className="mt-3.5" data-testid="inbox-list">
              {tickets.map((ticket) => (
                <TicketRow key={ticket.id} ticket={ticket} several={several} tasks={withTasks} selected={ticket.id === selected?.id} onSelect={() => { select(ticket); }} now={now} />
              ))}
            </ul>
          )}
          <div ref={end} />
          {isFetchingNextPage ? <LoadingRows rows={3} /> : null}
        </>
      )}
    </PageFrame>
  );
};
