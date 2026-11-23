"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, CircleDashedIcon, ListChecksIcon, LoaderCircleIcon, PlayIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { ProjectId, TicketId } from "@ostra/protocol";

import { CategorySquare } from "@/components/boards/jira-mapping";
import { rowAge } from "@/components/inbox/inbox-words";
import { TicketStatusIcon } from "@/components/inbox/ticket-icons";
import { trackerName } from "@/components/trackers/tracker-mark";
import { PageFrame, pageKeyLine, pageTitleGap, PropGroup, PropRow } from "@/components/shell/page-frame";
import { stateTone, taskStateText } from "@/components/tasks/task-words";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip, Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { partText, progressOf } from "./parent-progress";
import type { Child } from "./parent-progress";

// A parent ticket's page (ticket-parent.md, F-077): how far its sub-issues are, each one's task and
// what it needs, the children on no board of this project (never started here), and the parent's
// own refine task. The parent never runs code, so there's no thread here, only its children.

const LIVE_MS = 5_000;

// The picture's proportions (ticket-parent.webp): beside the panel, the title keeps about 180px at
// 1440. The build spec's `130px 260px 90px 50px 100px` left it 40px there; in the double sidebar the
// page is 70px narrower, so the title and `Now` share what's left, the title a little more.
const grid = "grid grid-cols-[84px_minmax(0,1fr)_120px] items-center gap-x-3 md:grid-cols-[84px_minmax(0,1.25fr)_104px_minmax(0,1fr)_56px_44px_76px]";

const TaskCell = ({ child }: { readonly child: Child }) =>
  child.task === null ? (
    <span className="flex items-center gap-1.5 text-ui text-faint">
      <CircleDashedIcon aria-hidden className="size-3 stroke-[1.75]" /> {t("ticketParent.noTask")}
    </span>
  ) : (
    <Status tone={stateTone(child.task.state)} className={cn("text-ui", child.task.state === "needs_you" ? "text-amber-text" : "text-text")}>
      {taskStateText(child.task.state)}
    </Status>
  );

type Refined = NonNullable<RouterOutputs["tickets"]["parent"]["refineTask"]>;

/** The Refined row's line: the draft applied (by whom, when, its sub-issues), ready, or the task stopped. */
export const refinedLine = (refine: Refined): string | null => {
  if (refine.draft?.kind === "applied") {
    const date = new Date(refine.draft.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    return plural(refine.draft.subTickets, "ticketParent.draftApplied.one", "ticketParent.draftApplied.other", {
      version: refine.draft.version,
      name: refine.draft.byName ?? t("ticketParent.draftAppliedNoOne"),
      date,
    });
  }
  if (refine.state === "stopped") return t("ticketParent.refineStopped");
  return refine.draft?.kind === "ready" ? t("ticketParent.draftReady") : null;
};

/** A child on no board of this project, as its row says where it is: `Board {name}` and `in {project}`. */
export const ElsewhereRow = ({ child, openIn = t("ticketParent.openIn", { tracker: t("inbox.panel.theTracker") }) }: { readonly child: Child; readonly openIn?: string }) => (
  <li className={cn(grid, "min-h-10 border-b border-line py-1")} data-testid="elsewhere-row" data-key={child.key}>
    <span className="font-mono text-[12.5px] text-faint">{child.key}</span>
    <span className="truncate text-ui text-muted" title={child.title}>{child.title}</span>
    <span className="truncate text-ui text-muted">{child.elsewhere === null ? "–" : t("ticketParent.elsewhereBoard", { board: child.elsewhere.board })}</span>
    <span className="hidden truncate text-[12.5px] text-muted md:block">
      {child.elsewhere === null ? (
        t("ticketParent.elsewhereNowhere")
      ) : (
        <>
          {t("ticketParent.elsewhereIn")} <span className="font-mono">{child.elsewhere.project}</span>
        </>
      )}
    </span>
    <span className="hidden md:block" />
    <span className="hidden md:block" />
    <span className="col-start-3 flex justify-end md:col-start-auto">
      <a href={child.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ui text-teal hover:underline">
        {openIn}
        <ArrowUpRightIcon aria-hidden className="size-3 stroke-[1.75]" />
      </a>
    </span>
  </li>
);

const nowText = (child: Child, anyStarted: boolean): string => {
  if (!child.open) return t("ticketParent.now.closed");
  if (!child.leaf) return t("ticketParent.now.parent");
  if (child.task === null) return anyStarted ? t("ticketParent.now.addedAfter") : t("ticketParent.now.notStarted");
  switch (child.task.state) {
    case "awaiting_approval":
      return t("ticketParent.now.awaitingApproval");
    case "queued":
    case "preparing":
      return t("ticketParent.now.queued");
    case "running":
      return t("ticketParent.now.running");
    case "needs_you":
      return t("ticketParent.now.needsYou");
    case "in_review":
      return t("ticketParent.now.inReview");
    case "merged":
      return t("ticketParent.now.merged");
    case "done":
      return t("ticketParent.now.done");
    case "stopped":
      return t("ticketParent.now.stopped");
    default:
      return child.task.state satisfies never;
  }
};

export const TicketParentView = ({ projectId, ticketId }: { readonly projectId: ProjectId; readonly ticketId: TicketId }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const parent = useQuery({ ...trpc.tickets.parent.queryOptions({ ticketId }), refetchInterval: LIVE_MS });
  const cached = useQuery(trpc.inbox.get.queryOptions({ projectId, ticketId }));
  const [requestKey] = useState(() => crypto.randomUUID());
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.tickets.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.projects.pathKey() });
  };
  const startAll = useMutation(trpc.tickets.startSubIssues.mutationOptions({ onSuccess: refresh }));
  const startOne = useMutation(trpc.tasks.startFromTicket.mutationOptions({ onSuccess: refresh }));

  const data = parent.data;
  // The ticket's tracker, from the Inbox's own read of it: `Jira` for a Jira sub-task page (ticket-chips.md).
  const tracker = cached.data === undefined || cached.data.board.connection === null ? null : trackerName[cached.data.board.connection.kind];
  const openIn = t("ticketParent.openIn", { tracker: tracker ?? t("inbox.panel.theTracker") });
  const projectName = project.data?.name ?? "";
  const children = data?.children ?? [];
  const onBoards = children.filter((child) => child.place === "board");
  const elsewhere = children.filter((child) => child.place === "elsewhere");
  const progress = progressOf(onBoards);
  const anyStarted = onBoards.some((child) => child.task !== null);
  const waiting = onBoards.filter((child) => child.leaf && child.open && child.task === null).length;
  const overLimit = data?.start.kind === "over-limit" ? data.start : null;
  const starting = startAll.isPending;
  const sentence = progress.parts.map(partText).join(" · ");
  const now = parent.dataUpdatedAt === 0 ? Date.now() : parent.dataUpdatedAt;
  const refined = data?.refineTask === null || data?.refineTask === undefined ? null : refinedLine(data.refineTask);

  return (
    <PageFrame
      crumbs={[
        { label: projectName, href: `/projects/${projectId}` },
        { label: t("inbox.title"), href: `/projects/${projectId}/inbox` },
        { label: data?.ticket.key ?? "" },
      ]}
      actions={
        waiting > 0 && data !== undefined ? (
          <Button
            variant={anyStarted ? "outline" : "primary"}
            disabled={starting || overLimit !== null}
            onClick={() => { startAll.mutate({ ticketId, requestKey }); }}
            data-testid="start-sub-issues"
          >
            {starting ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
            {starting ? t("ticketParent.starting") : plural(waiting, "ticketParent.startSubIssues.one", "ticketParent.startSubIssues.other")}
          </Button>
        ) : null
      }
      properties={
        data === undefined ? (
          <div className="space-y-3" aria-busy>
            <Skeleton className="w-[160px]" />
            <Skeleton className="w-[200px]" />
          </div>
        ) : (
          <div data-testid="parent-panel">
            <PropGroup title={t("ticketParent.panel.ticket")}>
              <PropRow label={t("ticketParent.panel.key")}>
                <a href={data.ticket.url} target="_blank" rel="noopener noreferrer" className="font-mono text-teal hover:underline">{data.ticket.key}</a>
              </PropRow>
              <PropRow label={t("ticketParent.panel.status")}>{cached.data?.status.name ?? "–"}</PropRow>
              <PropRow label={t("ticketParent.panel.board")}>{cached.data?.board.name ?? "–"}</PropRow>
            </PropGroup>
            <PropGroup title={t("ticketParent.panel.subIssues")}>
              <PropRow label={t("ticketParent.panel.onBoards")}><span className="font-mono">{onBoards.length}</span></PropRow>
              <PropRow label={t("ticketParent.panel.tasks")}><span className="font-mono" data-testid="panel-tasks">{onBoards.filter((child) => child.task !== null).length}</span></PropRow>
              <PropRow label={t("ticketParent.panel.elsewhere")}><span className="font-mono">{elsewhere.length}</span></PropRow>
              <PropRow label={t("ticketParent.panel.depth")}>{plural(Math.max(1, ...children.map((child) => child.depth)), "ticketParent.panel.levels.one", "ticketParent.panel.levels.other")}</PropRow>
            </PropGroup>
            <p className="text-xs text-faint">{data.source === "cache" ? t("ticketParent.fromCache") : t("ticketParent.fromTracker", { tracker: tracker ?? t("inbox.panel.theTracker") })}</p>
          </div>
        )
      }
    >
      {parent.isError ? (
        <p role="alert" className="text-sm text-red">
          {errorText(parent.error)}{" "}
          <Button variant="link" onClick={() => void parent.refetch()}>{t("ticketParent.tryAgain")}</Button>
        </p>
      ) : data === undefined ? (
        <div aria-busy className="flex flex-col gap-3">
          <Skeleton className="h-7 w-80" />
          <Skeleton className="h-[6px] w-full" />
          <Skeleton className="w-full" />
          <Skeleton className="w-full" />
        </div>
      ) : (
        <div className="max-w-[1120px]">
          <div className={pageKeyLine}>{t("ticketParent.keyLine", { key: data.ticket.key })}</div>
          <h1 className={cn("page-title break-words", pageTitleGap(true))}>{data.ticket.title}</h1>
          <p className="text-ui text-muted" data-testid="parent-status-line">
            {plural(onBoards.length, "ticketParent.statusLine.one", "ticketParent.statusLine.other", { project: projectName })}
            {" · "}
            {anyStarted ? plural(onBoards.filter((child) => child.task !== null).length, "ticketParent.started.one", "ticketParent.started.other") : t("ticketParent.noneStarted")}
            {progress.total > 0 && progress.merged === progress.total ? ` · ${t("ticketParent.allMerged")}` : ""}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-ui">
            {cached.data === undefined ? null : (
              <Chip className="text-text">
                {cached.data.board.connection?.kind === "jira" ? <CategorySquare category={cached.data.status.category ?? "open"} /> : <TicketStatusIcon category={cached.data.status.category} />}
                {cached.data.status.name ?? "–"}
              </Chip>
            )}
            {(cached.data?.labels ?? []).slice(0, 3).map((label) => <Chip key={label}>{label}</Chip>)}
            <a href={data.ticket.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-teal hover:underline">
              {openIn}
              <ArrowUpRightIcon aria-hidden className="size-3 stroke-[1.75]" />
            </a>
          </div>
          {overLimit === null ? null : (
            <p role="alert" className="mt-3 text-[12.5px] text-red">
              {t("ticketParent.overLimit", { key: data.ticket.key, n: overLimit.count, project: projectName, max: overLimit.max })}
            </p>
          )}
          {startAll.isError ? <p role="alert" className="mt-3 text-[12.5px] text-red">{errorText(startAll.error)}</p> : null}
          {startOne.isError ? <p role="alert" className="mt-3 text-[12.5px] text-red">{errorText(startOne.error)}</p> : null}

          <section className="mt-[18px] border-b border-line pb-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[13px] font-semibold text-text">{t("ticketParent.progress")}</h2>
              <span className="font-mono text-xs text-faint" data-testid="parent-merged">{t("ticketParent.merged", { n: progress.merged, total: progress.total })}</span>
            </div>
            <div role="img" aria-label={sentence} className="mt-2 flex h-1.5 w-full overflow-hidden rounded-[3px] bg-surface" data-testid="parent-progress">
              <span className="h-full bg-green" style={{ width: `${String(progress.total === 0 ? 0 : (progress.merged / progress.total) * 100)}%` }} />
              <span className="h-full bg-muted" style={{ width: `${String(progress.total === 0 ? 0 : (progress.moving / progress.total) * 100)}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted" data-testid="parent-progress-sentence">{sentence}</p>
          </section>

          <section className="mt-[22px]">
            <div className="mb-1 flex items-baseline gap-2">
              <h2 className="text-[13px] font-semibold text-text">{t("ticketParent.subIssues")}</h2>
              <span className="font-mono text-[11.5px] text-faint">{onBoards.length}</span>
            </div>
            {onBoards.length === 0 ? (
              <p className="h-10 text-sm text-faint">{t("ticketParent.noneHere", { key: data.ticket.key, project: projectName })}</p>
            ) : (
              <>
                <div className={cn(grid, "h-7 border-b border-line text-[11.5px] font-medium text-faint")}>
                  <span>{t("ticketParent.col.ticket")}</span>
                  <span>{t("ticketParent.col.title")}</span>
                  <span>{t("ticketParent.col.task")}</span>
                  <span className="hidden md:block">{t("ticketParent.col.now")}</span>
                  <span className="hidden md:block">{t("ticketParent.col.prs")}</span>
                  <span className="hidden md:block">{t("ticketParent.col.age")}</span>
                  <span className="hidden md:block" />
                </div>
                <ul data-testid="sub-issues">
                  {onBoards.map((child) => (
                    <li key={child.key} className={cn(grid, "min-h-10 border-b border-line py-1")} data-testid="sub-issue" data-key={child.key}>
                      {child.task === null ? (
                        <a href={child.url} target="_blank" rel="noopener noreferrer" className="font-mono text-[12.5px] text-faint hover:underline">{child.key}</a>
                      ) : (
                        <Link href={`/tasks/${child.task.id}`} className="font-mono text-[12.5px] text-faint hover:underline">{child.key}</Link>
                      )}
                      <span className="truncate text-ui text-text" title={child.title}>{child.title}</span>
                      <span data-testid="sub-issue-task"><TaskCell child={child} /></span>
                      <span className="hidden truncate text-[12.5px] text-muted md:block">{nowText(child, anyStarted)}</span>
                      <span className="hidden truncate font-mono text-ui md:block">
                        {child.task === null || child.task.prs.length === 0 ? (
                          <span className="text-faint">–</span>
                        ) : (
                          child.task.prs.slice(0, 2).map((pr) => (
                            <a key={`${pr.repo}#${String(pr.number)}`} href={pr.url ?? "#"} target="_blank" rel="noopener noreferrer" className="mr-2 text-teal hover:underline">#{pr.number}</a>
                          ))
                        )}
                      </span>
                      <span className="hidden font-mono text-xs text-faint md:block" data-testid="sub-issue-age">{child.task === null ? "" : rowAge(child.task.changedAt, now)}</span>
                      <span className="col-start-3 flex justify-end md:col-start-auto">
                        {child.task === null && child.leaf && child.open && child.ticketId !== null ? (
                          <Button size="sm" disabled={startOne.isPending} onClick={() => { if (child.ticketId !== null) startOne.mutate({ projectId, ticketId: child.ticketId }); }}>
                            {t("ticketParent.start")}
                          </Button>
                        ) : child.task?.state === "needs_you" ? (
                          <Link href={`/tasks/${child.task.id}`} className={buttonVariants({ size: "sm" })}>{t("ticketParent.open")}</Link>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {elsewhere.length === 0 ? null : (
            <section className="mt-[22px]" data-testid="elsewhere">
              <div className="flex items-baseline gap-2">
                <h2 className="text-[13px] font-semibold text-text">{t("ticketParent.elsewhere", { project: projectName })}</h2>
                <span className="font-mono text-[11.5px] text-faint">{elsewhere.length}</span>
              </div>
              <p className="mb-1 text-xs text-faint">{t("ticketParent.elsewhereNote")}</p>
              <ul>
                {elsewhere.map((child) => (
                  <ElsewhereRow key={child.key} child={child} openIn={openIn} />
                ))}
              </ul>
            </section>
          )}

          {data.refineTask === null ? null : (
            <section className="mt-[22px]" data-testid="refined">
              <h2 className="text-[13px] font-semibold text-text">{t("ticketParent.refined")}</h2>
              <div className="flex min-h-10 items-center gap-3 border-b border-line text-ui">
                <ListChecksIcon aria-hidden className="size-[14px] stroke-[1.75] text-faint" />
                <span className="font-mono text-faint">{data.refineTask.shortId}</span>
                <span className="text-text">{t("ticketParent.refineTask")}</span>
                <Status tone={stateTone(data.refineTask.state)}>{taskStateText(data.refineTask.state)}</Status>
                {refined === null ? null : <span className="min-w-0 truncate text-[12.5px] text-muted" data-testid="refined-line">{refined}</span>}
                <Link href={`/tasks/${data.refineTask.id}`} className="ml-auto shrink-0 text-teal hover:underline">{t("ticketParent.openTask")}</Link>
              </div>
            </section>
          )}
        </div>
      )}
    </PageFrame>
  );
};
