"use client";

import { CircleDashedIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Dot } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import type { LiveMark, LiveTask } from "./live-tasks";
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
    default:
      return mark satisfies never;
  }
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
        {task.key}
        {" · "}
        {task.line.tone === "needs-you" ? <span className="font-sans font-medium text-amber-text">{task.line.text}</span> : task.line.text}
      </span>
    </Link>
  );
};

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
