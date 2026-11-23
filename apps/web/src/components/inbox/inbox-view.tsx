"use client";

import { skipToken, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, ArrowUpIcon, ArrowUpRightIcon, BotIcon, ChevronDownIcon, CircleAlertIcon, InfoIcon, ListTreeIcon, LoaderCircleIcon, PauseIcon, PlusIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { runnerIdSchema } from "@ostra/protocol";
import type { AgentProfileId, ProjectId } from "@ostra/protocol";

import { CategorySquare } from "@/components/boards/jira-mapping";
import { unprotectedRepos, unsupportedRepos } from "@/components/projects/repo-checks-words";
import type { RepoDetail } from "@/components/projects/repo-checks-words";
import { PageFrame, PageHeading, PropRow } from "@/components/shell/page-frame";
import { ProfilePicker, useStartProfile } from "@/components/agent-profiles/profile-picker";
import { POOLS, RunOnPicker, useRunOn } from "@/components/tasks/run-on";
import { budgetWaitText } from "@/components/tasks/budget-reason";
import { usePhone } from "@/components/tasks/take-it-local";
import { stateTone, taskStateText } from "@/components/tasks/task-words";
import { TrackerMark, trackerMarkAt, trackerName } from "@/components/trackers/tracker-mark";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip, Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC, useTRPCClient } from "@/lib/trpc";

import { cacheAge, contextLine, filtered, filtersFrom, filtersToSearch, ledeSource, listInputOf, priorityText, rowAge } from "./inbox-words";
import type { InboxDetail, InboxFilters, InboxSource, InboxTicket } from "./inbox-words";

import { BulkStartPanel, SelectionBar, planOf, useBulkStart } from "./bulk-start";
import { noTicks, tickAll, tickedRows, toggleTick, untick } from "./inbox-selection";
import type { Ticks } from "./inbox-selection";
import type { BulkKind } from "./bulk-start";
import { SafeMarkdown } from "./safe-markdown";
import { PriorityIcon, TicketStatusIcon } from "./ticket-icons";

const LIVE_MS = 10_000;

/** A ticket's tracker's kind, from the board's connection (`Jira`, `Linear`): its mark and its words. */
export type InboxTicketKind = NonNullable<InboxTicket["board"]["connection"]>["kind"];

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
    // A phone: two lines (phone-inbox.md), the priority, key and age over the title, 56px.
    // The key's column holds its 14px mark and 6px gap as well as the key (ticket-chips.md, "Inbox row").
    "grid-cols-[16px_minmax(0,1fr)_auto] max-md:min-h-14 max-md:gap-y-0.5 max-md:py-2 md:grid-cols-[16px_96px_minmax(0,1fr)_112px_110px_36px]",
    // With the Task column, the labels, status and task columns are narrower, so the title keeps room beside
    // the panel: the double sidebar leaves the page 70px less than the target's single one (inbox-bulk-start).
    several && tasks
      ? "xl:grid-cols-[16px_92px_minmax(0,1fr)_72px_92px_92px_136px_32px]"
      : several
        ? "xl:grid-cols-[16px_92px_minmax(0,1fr)_100px_92px_104px_32px]"
        : tasks
          ? "xl:grid-cols-[16px_92px_minmax(0,1fr)_72px_92px_136px_32px]"
          : "xl:grid-cols-[16px_92px_minmax(0,1fr)_100px_104px_32px]",
  );

/** F-107: a row's tick for a bulk start, and what a ticked parent's code start starts (F-077). */
export type RowTick = {
  readonly ticked: boolean;
  readonly disabled: boolean;
  readonly onTick: (range: boolean) => void;
  /** A ticked parent's "starts N tasks", or `null`. */
  readonly startsTasks: number | null;
  /** A parent's page (F-077), for its "N sub-issues" chip. */
  readonly parentHref: string | null;
};

/**
 * A parent's `{n} sub-issues` chip (inbox-bulk-start.md). It gives way before the title does: in a
 * narrow title cell (a phone, or the bulk panel beside the list) it keeps only its count, and the words
 * move to its tooltip and its accessible name.
 */
export const SubIssueChip = ({ count, kind, className }: { readonly count: number; readonly kind: InboxTicketKind | null; readonly className?: string }) => {
  // A Jira parent counts its sub-tasks, a Linear one its sub-issues (ticket-chips.md, "Inbox row").
  const words = kind === "jira" ? plural(count, "inbox.subTasks.one", "inbox.subTasks.other") : plural(count, "bulkStart.subIssueChip.one", "bulkStart.subIssueChip.other");
  return (
    <Chip className={cn("shrink-0 text-faint", className)} title={words}>
      <span className="hidden @min-[22rem]:inline">{words}</span>
      <span className="inline-flex items-center gap-1 @min-[22rem]:hidden" data-compact>
        <ListTreeIcon aria-hidden className="stroke-[1.75]" />
        <span aria-hidden>{count}</span>
        <span className="sr-only">{words}</span>
      </span>
    </Chip>
  );
};

/** One ticket: priority, key, title, labels, (board), status, its task, and the age of its last change. */
export const TicketRow = ({ ticket, several, tasks = true, selected, onSelect, now, tick }: { readonly ticket: InboxTicket; readonly several: boolean; readonly tasks?: boolean; readonly selected: boolean; readonly onSelect: () => void; readonly now: number; readonly tick?: RowTick }) => (
  <li className="flex items-center border-b border-line" data-ticket={ticket.key} data-selected={selected} data-ticked={tick?.ticked === true}>
    {tick === undefined ? null : (
      <span className="grid w-9 shrink-0 place-items-center">
        <Checkbox
          tone="teal"
          checked={tick.ticked}
          disabled={tick.disabled}
          aria-label={t("bulkStart.tick", { key: ticket.key })}
          onClick={(event) => {
            event.preventDefault();
            tick.onTick(event.shiftKey);
          }}
          className="size-4"
        />
      </span>
    )}
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect();
        if (event.key === "x" && tick !== undefined && !tick.disabled) {
          event.preventDefault();
          tick.onTick(false);
        }
      }}
      className={cn(rowGrid(several, tasks), "min-w-0 flex-1 cursor-default rounded-md px-2 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-muted", (selected || tick?.ticked === true) && "bg-sel hover:bg-sel")}
    >
      <span title={priorityText(ticket.priority)} className="text-muted">
        <PriorityIcon priority={ticket.priority} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-ui text-faint">
        {ticket.board.connection === null ? null : (
          // One colour, in the key's own `--faint`; its tooltip names the tracker and the connection
          // (ticket-chips.md, "Inbox row").
          <span className="inline-flex shrink-0 items-center" title={`${trackerName[ticket.board.connection.kind]} · ${ticket.board.connection.name}`}>
            <TrackerMark kind={ticket.board.connection.kind} size={trackerMarkAt.inboxRow.size} mono />
          </span>
        )}
        <span className="truncate">{ticket.key}</span>
        {/* A phone has no Task column: the task's mark and word sit after the key (phone-inbox.md). */}
        {ticket.task?.active === true ? (
          <Status tone={stateTone(ticket.task.state)} className="min-w-0 font-sans md:hidden">
            <span className="truncate text-muted">{taskStateText(ticket.task.state)}</span>
          </Status>
        ) : null}
      </span>
      {/* A container: a parent's chip reads the title cell's width, and gives way before the title does. */}
      <span className="@container flex min-w-0 items-center gap-2 max-md:col-span-2 max-md:col-start-2 max-md:row-start-2">
        <span className="min-w-0 flex-1 truncate text-body text-text">{ticket.title}</span>
        {ticket.subIssues > 0 ? (
          tick?.parentHref === null || tick?.parentHref === undefined ? (
            <SubIssueChip count={ticket.subIssues} kind={ticket.board.connection?.kind ?? null} />
          ) : (
            <Link href={tick.parentHref} onClick={(event) => { event.stopPropagation(); }} className="shrink-0" data-testid="parent-link">
              <SubIssueChip count={ticket.subIssues} kind={ticket.board.connection?.kind ?? null} className="hover:text-text" />
            </Link>
          )
        ) : null}
      </span>
      <span className="hidden min-w-0 items-center gap-1.5 overflow-hidden md:flex">
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
      {tasks ? (
        <span className="hidden min-w-0 xl:block">
          {ticket.task?.active === true ? <TaskMark task={ticket.task} /> : tick?.startsTasks === null || tick?.startsTasks === undefined ? null : <span className="text-ui text-muted">{t("bulkStart.startsTasks", { n: tick.startsTasks })}</span>}
        </span>
      ) : null}
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
      {/* Nothing to pick (no ticket has a label yet): the button rests, and says so, rather than open an empty panel that holds the focus. */}
      <PopoverTrigger disabled={options.length === 0} title={options.length === 0 ? t("inbox.filter.none") : undefined} className={cn(buttonVariants({ size: "sm" }), "h-[30px] bg-transparent px-3 text-ui")}>
        {label}
        {names.length === 0 ? null : (
          <>
            :<span className="max-w-[160px] truncate text-text">{names.join(", ")}</span>
          </>
        )}
        <ChevronDownIcon aria-hidden className="size-3! text-faint" />
      </PopoverTrigger>
      <PopoverContent className="w-[240px]">
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
      {source.connections.some((connection) => connection.mode === "polling") && !source.stale ? ` · ${t("inbox.polling", { seconds: source.pollSeconds })}` : null}
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
  /** F-037: why the task would wait at the budget gate, before Start; it still starts, queued. */
  readonly budgetWait?: string | null;
  /** F-077: a parent's code start starts one task per sub-issue, as its page's start does. */
  readonly subIssues?: { readonly tasks: number; readonly href: string } | null;
};

/** The selected ticket: its rows, its description, and Start a task (or its active task). */
export const TicketPanel = ({ detail, several, now, start }: { readonly detail: InboxDetail; readonly several: boolean; readonly now: number; readonly start: StartFormProps }) => {
  const blocked = unsupportedRepos(start.repos)[0];
  const unprotected = unprotectedRepos(start.repos)[0];
  const active = detail.task?.active === true ? detail.task : null;
  const earlier = detail.task !== null && !detail.task.active ? detail.task : null;
  const phone = usePhone();
  /** A phone's start row (phone-inbox.md): a 40px box with its label inside, full width. */
  const startRow = (label: string, value: ReactNode) =>
    phone ? (
      <div className="mb-2 flex h-10 min-w-0 items-center gap-2 rounded-md border border-control-line bg-surface pl-3 pr-1 [&_svg]:size-[14px] [&_svg]:text-muted">
        <span className="w-[96px] shrink-0 text-ui text-muted">{label}</span>
        <span className="flex min-w-0 flex-1 items-center gap-[7px] text-text">{value}</span>
      </div>
    ) : (
      <PropRow label={label}>{value}</PropRow>
    );
  return (
    <div data-testid="ticket-panel">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-sm text-faint">
          {detail.board.connection === null ? null : <TrackerMark kind={detail.board.connection.kind} size={trackerMarkAt.inboxRow.size} mono label={false} />}
          <span className="truncate">{detail.key}</span>
        </span>
        <a href={detail.url} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 text-ui text-teal hover:underline">
          {t("inbox.panel.openIn", { tracker: detail.board.connection === null ? t("inbox.panel.theTracker") : trackerName[detail.board.connection.kind] })}
          <ArrowUpRightIcon aria-hidden className="size-3 stroke-[1.75]" />
        </a>
      </div>
      <h2 className="mb-2.5 mt-1 break-words text-[16px] font-semibold leading-snug text-text max-sm:text-[17px]">{detail.title}</h2>
      {phone ? (
        // The meta line replaces the key/value rows on a phone (phone-inbox.md, "Bottom sheet").
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-muted [&_svg]:size-[14px]" data-testid="ticket-meta">
          <span className="inline-flex items-center gap-1.5">
            {detail.board.connection?.kind === "jira" ? <CategorySquare category={detail.status.category ?? "open"} /> : <TicketStatusIcon category={detail.status.category} />}
            {detail.status.name ?? "–"}
          </span>
          <span aria-hidden className="text-faint">·</span>
          <span className="inline-flex items-center gap-1.5">
            <PriorityIcon priority={detail.priority} />
            {priorityText(detail.priority)}
          </span>
          {detail.labels.map((label) => (
            <Chip key={label}>{label}</Chip>
          ))}
          <span aria-hidden className="text-faint">·</span>
          <span>{detail.assignee === null ? t("inbox.panel.unassigned") : detail.assignee.name}</span>
        </p>
      ) : null}
      <div className={phone ? "hidden" : undefined}>
      <PropRow label={t("inbox.panel.status")}>
        {detail.board.connection?.kind === "jira" ? <CategorySquare category={detail.status.category ?? "open"} /> : <TicketStatusIcon category={detail.status.category} />}
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
      </div>
      <Sep />
      <Description detail={detail} />
      <Sep />
      {active === null ? (
        <div data-testid="start-task">
          <h3 className="mb-2 text-xs font-medium text-faint">{t("inbox.panel.start")}</h3>
          {startRow(t("inbox.panel.kind"), t("inbox.panel.code"))}
          {startRow(
            t("inbox.panel.profile"),
            start.profile ?? (
              <>
                <BotIcon aria-hidden />
                <span className="truncate">{t("inbox.panel.noProfile")}</span>
              </>
            ),
          )}
          {startRow(t("inbox.panel.runOn"), start.runOn)}
          <p className="mt-2 flex items-start gap-2 text-xs text-faint">
            <InfoIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />
            {contextLine(detail)}
          </p>
          {start.subIssues === undefined || start.subIssues === null ? null : (
            <p className="mt-2 text-ui text-text" data-testid="starts-sub-issues">
              {plural(start.subIssues.tasks, "bulkStart.startsSubIssues.one", "bulkStart.startsSubIssues.other")}{" "}
              <Link href={start.subIssues.href} className="text-teal hover:underline">{t("bulkStart.openParent")}</Link>
            </p>
          )}
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
          {start.budgetWait === undefined || start.budgetWait === null ? null : (
            <p id="inbox-budget-wait" role="status" className="mt-2 flex items-start gap-2 text-xs text-muted" data-testid="budget-reason">
              <PauseIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />
              <span>
                <span className="text-text">{start.budgetWait}</span> {t("budgetWait.startsQueued")}
              </span>
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
            {start.starting
              ? t("inbox.panel.starting")
              : start.subIssues === undefined || start.subIssues === null
                ? t("inbox.panel.startTask")
                : plural(start.subIssues.tasks, "bulkStart.start.one", "bulkStart.start.other")}
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
  // A phone (phone-inbox.md): the text filter hides behind the top bar's search button, and the
  // selected ticket opens as a bottom sheet, only once a row is tapped (`?ticket=`).
  const phone = usePhone();
  const [searching, setSearching] = useState(false);
  const [mounted] = useState(() => Date.now());
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const options = useQuery(trpc.inbox.filters.queryOptions({ projectId }));
  const runners = useQuery(trpc.runners.mine.queryOptions());
  // The member's profiles for this project, its default first (F-021).
  const profiles = useStartProfile(projectId);
  // Milestone 5 (F-069): whether "A pool" and each "Your machine" can take it now, and why not.
  const choices = useQuery(
    trpc.tasks.runnerChoices.queryOptions(profiles.options === undefined ? skipToken : { projectId, ...(profiles.chosen === null ? {} : { profileId: profiles.chosen.profileId }) }),
  );
  const { chosen, runner, setRunOn } = useRunOn(runners.data, choices.data);
  // F-037: the budget gate's reason before Start, for the chosen profile.
  const check = useQuery(
    trpc.tasks.startCheck.queryOptions(profiles.options === undefined ? skipToken : { projectId, ...(profiles.chosen === null ? {} : { profileId: profiles.chosen.profileId }) }, { retry: false }),
  );
  const budgetWait =
    check.data?.kind !== "wait" || project.data === undefined
      ? null
      : check.data.reason === "budget-reached"
        ? budgetWaitText({ reason: "budget-reached", scope: check.data.scope, month: check.data.month }, project.data.name)
        : check.data.reason === "unpriced"
          ? budgetWaitText({ reason: "unpriced" }, project.data.name)
          : null;
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

  // F-107: the ticked tickets, the kind and profile for all, and the bulk start they become.
  // The ticks are kept by ticket, not by row: the list refreshes under them (inbox-selection.ts).
  const [ticks, setTicks] = useState<Ticks>(noTicks);
  const [bulkKind, setBulkKind] = useState<BulkKind>("code");
  const [bulkProfile, setBulkProfile] = useState<AgentProfileId | null>(null);
  const bulk = useBulkStart(projectId, project.data?.name ?? "");
  const limits = useQuery(trpc.automations.list.queryOptions({ projectId }));
  const bulkMax = limits.data?.limits.bulkStartMax ?? 50;
  const tickedList = tickedRows(ticks, tickets);
  // The tickets a press started, as they were ticked: the panel keeps their results after the
  // started rows untick, until Done or a new tick.
  const [pressedTickets, setPressedTickets] = useState<readonly InboxTicket[]>([]);
  const pressedList = pressedTickets.map((ticket) => tickets.find((one) => one.id === ticket.id) ?? ticket);
  const selecting = tickedList.length > 0 || bulk.pressed !== null;
  const busy = bulk.pressed !== null && !bulk.done;
  const toggleRow = (ticket: InboxTicket, range: boolean) => {
    if (busy) return;
    if (bulk.done) {
      // Ticking something else after a start ends its results: the bar and panel preview again.
      bulk.reset();
      setPressedTickets([]);
    }
    setTicks((current) => toggleTick(current, tickets, ticket, range));
  };
  const clearTicks = () => {
    if (busy) return;
    setTicks(noTicks);
    setPressedTickets([]);
    bulk.reset();
  };
  const startTicked = () => {
    setPressedTickets(tickedList);
    void bulk.start(tickedList, bulkKind, bulkProfile);
  };
  // A started row unticks as its result lands (inbox-bulk-start.md's results).
  const startedIds = [...bulk.results].flatMap(([id, result]) => (result.kind === "started" ? [id] : [])).join(",");
  useEffect(() => {
    if (startedIds === "") return;
    setTicks((current) => untick(current, startedIds.split(",")));
  }, [startedIds]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (event.key === "Escape" && ticks.byId.size > 0 && !typing) clearTicks();
      if ((event.metaKey || event.ctrlKey) && event.key === "a" && !typing && tickets.length > 0 && !busy) {
        event.preventDefault();
        setTicks(tickAll(tickets));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  });

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

  const startParent = useMutation(
    trpc.tickets.startSubIssues.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() });
        await queryClient.invalidateQueries({ queryKey: trpc.projects.pathKey() });
      },
    }),
  );
  const [parentKey] = useState(() => crypto.randomUUID());
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
    source === undefined ? null : source.connections.length === 0 ? "no-connection" : source.boards.length === 0 ? "no-boards" : tickets.length === 0 && !filtered(filters) ? "nothing-open" : null;
  const parentOf = (ticket: { readonly subIssues: number; readonly codeStart: { readonly tasks: number; readonly overLimit: boolean }; readonly id: string }) =>
    ticket.subIssues > 0 && ticket.codeStart.tasks > 0 && !ticket.codeStart.overLimit ? { tasks: ticket.codeStart.tasks, href: `/projects/${projectId}/tickets/${ticket.id}` } : null;
  const panel = selecting ? (
    <BulkStartPanel
      ticked={bulk.pressed === null ? tickedList : pressedList}
      max={bulkMax}
      kind={bulkKind}
      profile={bulkProfile}
      projectId={projectId}
      bulk={bulk}
      onKind={(kind) => { setBulkKind(kind); setBulkProfile(null); }}
      onProfile={setBulkProfile}
      onStart={startTicked}
      onDone={clearTicks}
    />
  ) : selected === undefined || empty !== null ? undefined : detail.data === undefined ? (
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
          runOn: <RunOnPicker runners={runners.data} runner={runner} onPick={setRunOn} disabled={start.isPending} choices={choices.data} project={project.data?.name ?? ""} />,
          starting: start.isPending || startParent.isPending,
          error: errorText(start.error) ?? errorText(startParent.error),
          budgetWait,
          subIssues: parentOf(detail.data),
          onStart: () => {
            if (parentOf(detail.data) !== null) {
              startParent.mutate({ ticketId: detail.data.id, requestKey: `${parentKey}:${String(detail.data.id)}`, agentProfileId: profiles.chosen?.profileId ?? null });
              return;
            }
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

  const closeSheet = () => {
    const next = new URLSearchParams(params.toString());
    next.delete("ticket");
    router.replace(next.size === 0 ? pathname : `${pathname}?${next.toString()}`, { scroll: false });
  };
  const searchButton = (
    <button
      type="button"
      aria-label={t("inbox.filter.text")}
      aria-expanded={searching || text !== ""}
      onClick={() => { setSearching(true); }}
      className="relative grid size-11 place-items-center rounded-sm text-muted hover:bg-hover hover:text-text sm:hidden"
    >
      <SearchIcon aria-hidden className="size-[18px] stroke-[1.75]" />
      {text === "" ? null : <span aria-hidden className="absolute right-2.5 top-2.5 size-1.5 rounded-full bg-muted" />}
    </button>
  );

  return (
    <PageFrame
      crumbs={[{ label: project.data?.name ?? "", href: `/projects/${projectId}` }, { label: t("inbox.title") }]}
      {...(phone ? { actions: searchButton } : {})}
      {...(panel === undefined || phone ? {} : { properties: panel, wideProperties: true })}
    >
      {phone && panel !== undefined ? (
        // While rows are ticked, the selection bar holds the bulk start: the sheet stays shut, so more rows can be ticked.
        <Sheet open={params.has("ticket") && !selecting} onOpenChange={(open) => { if (!open) closeSheet(); }}>
          <SheetContent
            side="bottom"
            title={selected?.title ?? t("inbox.title")}
            closeButton={false}
            className="p-4 pt-6 pb-[max(16px,env(safe-area-inset-bottom))]"
            // The sheet itself takes the focus, not its grab handle: a tap opened it, not a key.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
            }}
          >
            <button type="button" onClick={closeSheet} aria-label={t("common.close")} className="absolute left-1/2 top-0 grid h-5 w-14 -translate-x-1/2 place-items-center rounded-sm">
              <span aria-hidden className="h-1 w-9 rounded-sm bg-line-2" />
            </button>
            {panel}
          </SheetContent>
        </Sheet>
      ) : null}
      <PageHeading title={t("inbox.title")} lede={source === undefined ? <Skeleton className="mt-1 w-[320px]" /> : <InboxLede source={source} now={now} />} />
      {empty === "no-connection" || empty === "no-boards" ? (
        <InboxEmpty kind={empty} board={null} projectId={projectId} admin={empty === "no-connection" ? admin : project.data?.role === "admin"} />
      ) : (
        <>
          {selecting ? (
            <SelectionBar
              ticked={tickedList}
              allTicked={tickedList.length === tickets.length}
              max={bulkMax}
              kind={bulkKind}
              profile={bulkProfile}
              projectId={projectId}
              bulk={bulk}
              onKind={(kind) => { setBulkKind(kind); setBulkProfile(null); }}
              onProfile={setBulkProfile}
              onClear={clearTicks}
              onStart={startTicked}
            />
          ) : (
          <div className="mt-[18px] flex items-center gap-2 max-sm:-mx-4 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:px-4 max-sm:[scrollbar-width:none] sm:flex-wrap" data-testid="inbox-filters">
            <label className={cn("relative w-full shrink-0 sm:w-[240px]", !searching && text === "" && "max-sm:hidden")}>
              <SearchIcon aria-hidden className="absolute left-2.5 top-1/2 size-[14px] -translate-y-1/2 stroke-[1.75] text-faint" />
              <input
                aria-label={t("inbox.filter.text")}
                placeholder={t("inbox.filter.text")}
                value={text}
                autoFocus={searching}
                onBlur={() => { if (text === "") setSearching(false); }}
                onChange={(event) => { setText(event.target.value); }}
                className="h-[30px] w-full rounded-md border border-control-line bg-surface pl-8 pr-2.5 text-ui text-text placeholder:text-faint focus-visible:border-faint"
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
          )}
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
              {tickets.map((ticket) => {
                const isTicked = ticks.byId.has(String(ticket.id));
                const plan = planOf(ticket, bulkKind);
                return (
                  <TicketRow
                    key={ticket.id}
                    ticket={ticket}
                    several={several}
                    tasks={withTasks || tickedList.some((one) => planOf(one, bulkKind).kind === "sub-issues")}
                    selected={!selecting && ticket.id === selected?.id}
                    onSelect={() => { select(ticket); }}
                    now={now}
                    tick={{
                      ticked: isTicked,
                      disabled: busy,
                      onTick: (range) => { toggleRow(ticket, range); },
                      startsTasks: isTicked && plan.kind === "sub-issues" ? plan.tasks : null,
                      parentHref: ticket.subIssues > 0 ? `/projects/${projectId}/tickets/${ticket.id}` : null,
                    }}
                  />
                );
              })}
            </ul>
          )}
          <div ref={end} />
          {isFetchingNextPage ? <LoadingRows rows={3} /> : null}
        </>
      )}
    </PageFrame>
  );
};
