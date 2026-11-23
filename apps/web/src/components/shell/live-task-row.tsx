"use client";

import { CircleDashedIcon, GitPullRequestIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { TrackerMark, trackerMarkAt } from "@/components/trackers/tracker-mark";
import { Dot } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import type { LiveFamily, LiveMark, LiveTask } from "./live-tasks";
import { useDensity } from "./nav-link";

const Mark = ({ mark }: { readonly mark: LiveMark }) => {
  switch (mark) {
    case "amber":
      return <Dot tone="amber" />;
    case "green":
      return <Dot tone="green" />;
    case "preparing":
      return <LoaderCircleIcon aria-hidden className="size-[11px] stroke-[1.75] text-faint" />;
    case "queued":
      return <CircleDashedIcon aria-hidden className="size-[11px] stroke-[1.75] text-faint" />;
    case "in-review":
      return <GitPullRequestIcon aria-hidden className="size-[13px] stroke-[1.75] text-muted" />;
    default:
      return mark satisfies never;
  }
};

/** A follow-up's tag (F-147/c8): its kind, in a hairline box, as the task page's own `review` chip. */
const followUpTagWords: Readonly<Record<NonNullable<LiveTask["followUp"]>, () => string>> = { review: () => t("draft.chipReview") };

const FollowUpTag = ({ kind }: { readonly kind: NonNullable<LiveTask["followUp"]> }) => (
  <span className="shrink-0 rounded-[3px] border border-line-2 px-1 font-mono text-[11px] leading-[14px] text-muted">{followUpTagWords[kind]()}</span>
);

/**
 * A follow-up under its code task (F-147/c8; ADR 0059 amended 2026-11-21): one line, indented to the
 * code task's title, with its tag and what it does now. One link, as every live row.
 */
const FollowUpRow = ({ task, kind, onNavigate }: { readonly task: LiveTask; readonly kind: NonNullable<LiveTask["followUp"]>; readonly onNavigate: () => void }) => {
  const pathname = usePathname();
  const sheet = useDensity() === "sheet";
  const open = pathname === `/tasks/${task.taskId}` || pathname.startsWith(`/tasks/${task.taskId}/`);
  return (
    <Link
      href={`/tasks/${task.taskId}`}
      onClick={onNavigate}
      data-roving-item=""
      data-live-task={task.taskId}
      data-follow-up={kind}
      title={`${task.title} · ${task.key} · ${task.line.text}`}
      aria-current={open ? "page" : undefined}
      className={cn(
        "grid grid-cols-[14px_minmax(0,1fr)] items-center gap-x-2 rounded-sm hover:bg-hover",
        sheet ? "py-[6px] pl-[34px] pr-2.5" : "py-[3px] pl-[30px] pr-2",
        open && "bg-sel hover:bg-sel",
      )}
    >
      <span className="flex justify-center">
        <Mark mark={task.mark} />
      </span>
      <span className={cn("flex min-w-0 items-center gap-1.5", sheet ? "text-[12.5px] leading-[18px]" : "text-xs leading-[17px]")}>
        <FollowUpTag kind={kind} />
        <span className={cn("truncate", task.line.tone === "needs-you" ? "font-medium text-amber-text" : "text-faint")}>{task.line.text}</span>
      </span>
    </Link>
  );
};

/**
 * A live task in the panel (app-shell.md, "A live task row"): its state mark, its title, then its
 * key and what the agent does now, or what waits on the member in `--amber-text`. The full line is
 * the row's title. A click opens the task.
 */
export const LiveTaskRow = ({ task, onNavigate }: { readonly task: LiveTask; readonly onNavigate: () => void }) => {
  const pathname = usePathname();
  const density = useDensity();
  const open = pathname === `/tasks/${task.taskId}` || pathname.startsWith(`/tasks/${task.taskId}/`);
  const sheet = density === "sheet";
  return (
    <Link
      href={`/tasks/${task.taskId}`}
      onClick={onNavigate}
      data-roving-item=""
      data-live-task={task.taskId}
      title={`${task.title} · ${task.key} · ${task.line.text}`}
      aria-current={open ? "page" : undefined}
      className={cn("grid grid-cols-[14px_minmax(0,1fr)] gap-x-2 rounded-sm hover:bg-hover", sheet ? "px-2.5 py-[7px]" : "px-2 py-[5px]", open && "bg-sel hover:bg-sel")}
    >
      <span className={cn("flex justify-center", sheet ? "mt-[7px]" : "mt-[6px]")}>
        <Mark mark={task.mark} />
      </span>
      <span className={cn("truncate font-medium", sheet ? "text-[15px] leading-[21px]" : "text-ui leading-5", open ? "text-text" : "text-text-2")}>{task.title}</span>
      <span className={cn("col-start-2 truncate font-mono text-faint", sheet ? "text-[12.5px] leading-[18px]" : "text-xs leading-[17px]")}>
        {/* A follow-up whose code task isn't in the list keeps its tag on a row of its own. */}
        {task.followUp === null ? null : <><FollowUpTag kind={task.followUp} />{" "}</>}
        {/* Milestone 11 (ticket-chips.md, "Sidebar, live"): the ticket's tracker, one colour, before its key. */}
        {task.connection === null ? null : (
          <>
            <TrackerMark kind={task.connection.kind} size={trackerMarkAt.sidebar.size} mono label={false} className="mr-1 align-[-1px]" />
            {" "}
          </>
        )}
        {task.key}
        {" · "}
        {task.line.tone === "needs-you" ? <span className="font-sans font-medium text-amber-text">{task.line.text}</span> : task.line.text}
      </span>
    </Link>
  );
};

/** A row of a live list and its follow-ups under it (F-147/c8). */
export const LiveFamilyRows = ({ family, onNavigate }: { readonly family: LiveFamily; readonly onNavigate: () => void }) => (
  <>
    <LiveTaskRow task={family.task} onNavigate={onNavigate} />
    {family.followUps.map((task) => (
      <FollowUpRow key={task.taskId} task={task} kind={task.followUp ?? "review"} onNavigate={onNavigate} />
    ))}
  </>
);

/** A live list while its query loads: two quiet bars, never a spinner (app-shell.md, "Loading"). */
export const LiveSkeleton = () => (
  <div aria-hidden className="flex flex-col gap-2 px-2 py-1.5">
    <span className="h-3 w-4/5 rounded-sm bg-surface" />
    <span className="h-3 w-3/5 rounded-sm bg-surface" />
  </div>
);

/** A live list whose query failed: one quiet line and a teal Retry (app-shell.md, "A count fails"). */
export const LiveFailed = ({ retry }: { readonly retry: () => void }) => (
  <p className="flex items-center gap-2 px-2 py-1 text-sm text-faint">
    {t("shell.panel.couldntLoad")}
    <button type="button" onClick={retry} className="text-teal hover:underline">
      {t("shell.panel.retry")}
    </button>
  </p>
);
