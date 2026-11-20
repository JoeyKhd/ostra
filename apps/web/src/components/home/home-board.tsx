"use client";

import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, Columns3Icon, GitMergeIcon, GitPullRequestIcon, ListIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { projectColour } from "@/components/shell/project-colour";
import { Avatar } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";

import { boardColumns, boardEmpty, cardStatusParts, columnChip, columnEmpty, columnTitle, moreWords } from "./board-words";
import type { BoardCard, BoardColumnData, BoardColumnId, BoardData, HomeView } from "./board-words";
import type { Part } from "./home-words";

// Home's board view (home-board.md, F-062): every task the member can open, as cards in five
// columns by lifecycle state. The board is for looking: a card links to its task, and nothing on
// it answers, approves or drags.

const icon = "size-[15px] shrink-0 stroke-[1.75]";

const ColumnMark = ({ column }: { readonly column: BoardColumnId }) => {
  switch (column) {
    case "needs-you":
      return <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-amber shadow-(--dot-amber)" />;
    case "queued":
      return <CircleDashedIcon aria-hidden className={cn(icon, "text-muted")} />;
    case "running":
      return <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-green" />;
    case "in-review":
      return <GitPullRequestIcon aria-hidden className={cn(icon, "text-muted")} />;
    case "finished":
      return <GitMergeIcon aria-hidden className={cn(icon, "text-muted")} />;
    default:
      return column satisfies never;
  }
};

const StatusMark = ({ card }: { readonly card: BoardCard }) => {
  const small = "size-[13px] shrink-0 stroke-[1.75]";
  switch (card.status.kind) {
    case "merged":
      return <GitMergeIcon aria-hidden className={cn(small, "text-green")} />;
    case "done":
      return <CircleCheckIcon aria-hidden className={cn(small, "text-green")} />;
    case "stopped":
      return <CircleXIcon aria-hidden className={cn(small, "text-muted")} />;
    case "preparing":
      return <LoaderCircleIcon aria-hidden className={cn(small, "text-muted motion-safe:animate-spin")} />;
    case "needs-you":
    case "queued":
    case "running":
    case "in-review":
      return null;
    default:
      return card.status satisfies never;
  }
};

const Parts = ({ parts }: { readonly parts: readonly Part[] }) => (
  <>
    {parts.map((part, i) =>
      part.code === true ? (
        <code key={i} className="font-mono text-[11.5px] text-text">{part.text}</code>
      ) : (
        <span key={i}>{part.text}</span>
      ),
    )}
  </>
);

const partsText = (parts: readonly Part[]): string => parts.map((part) => part.text).join("");

/** One task, a link to its page: key and age, title, status line, project and driver. */
export const TaskCard = ({ card, now }: { readonly card: BoardCard; readonly now: number }) => {
  const parts = cardStatusParts(card.status);
  const line = partsText(parts);
  return (
    <Tooltip content={<><span className="block font-medium">{card.title}</span><span className="block text-muted">{line}</span></>}>
      <Link
        href={`/tasks/${card.taskId}`}
        data-card={card.taskId}
        className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-3 hover:border-line-2 hover:bg-hover"
      >
        <span className="flex h-5 items-center gap-2">
          <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(card.project.id) }} />
          <span className="min-w-0 truncate font-mono text-xs text-faint">{card.key ?? t("home.board.prompt")}</span>
          <span className="ml-auto shrink-0 font-mono text-xs text-faint tabular-nums" suppressHydrationWarning>{formatAge(card.since, now)}</span>
        </span>
        <span className="line-clamp-2 text-sm leading-[18px] text-text">{card.title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <StatusMark card={card} />
          <span className="min-w-0 truncate" data-status={card.status.kind}>
            <Parts parts={parts} />
          </span>
        </span>
        <span className="flex h-5 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-faint">{card.project.name}</span>
          {card.driver === null ? null : <Avatar name={card.driver} className="size-[18px] text-[9px]" />}
        </span>
      </Link>
    </Tooltip>
  );
};

export type ColumnLoad = { readonly kind: "loading" } | { readonly kind: "error"; readonly retry: () => void } | { readonly kind: "ready"; readonly data: BoardColumnData };

/** A header band and its cards; no box around the column (app-design.md, rule 3). */
export const BoardColumn = ({
  column,
  load,
  now,
  onMore,
  loadingMore = false,
}: {
  readonly column: BoardColumnId;
  readonly load: ColumnLoad;
  readonly now: number;
  readonly onMore: (column: BoardColumnId) => void;
  readonly loadingMore?: boolean;
}) => {
  const more = load.kind === "ready" ? moreWords(load.data) : null;
  return (
    <section aria-label={columnTitle(column)} data-column={column} className="min-w-0 snap-start">
      <h2 className="flex h-8 items-center gap-2 rounded-md bg-surface px-3">
        <ColumnMark column={column} />
        <span className="text-sm font-semibold text-text">{columnTitle(column)}</span>
        <span className="ml-auto font-mono text-xs text-faint tabular-nums" data-count>
          {load.kind === "ready" ? load.data.total : "–"}
        </span>
      </h2>
      <div className="mt-2 flex flex-col gap-2">
        {load.kind === "loading" ? (
          Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[100px] animate-none rounded-lg" />)
        ) : load.kind === "error" ? (
          <p role="alert" className="text-[12.5px] text-faint">
            {t("home.loadFailed")}{" "}
            <button type="button" onClick={load.retry} className="text-teal hover:underline">{t("home.retry")}</button>
          </p>
        ) : load.data.total === 0 ? (
          <p className="text-[12.5px] text-faint">{columnEmpty(column)}</p>
        ) : (
          load.data.cards.map((card) => <TaskCard key={card.taskId} card={card} now={now} />)
        )}
        {more === null ? null : (
          <button type="button" disabled={loadingMore} onClick={() => { onMore(column); }} className="self-start text-sm text-teal hover:underline disabled:opacity-60">
            {more}
          </button>
        )}
      </div>
    </section>
  );
};

export type BoardLoad = { readonly kind: "loading" } | { readonly kind: "error"; readonly retry: () => void } | { readonly kind: "ready"; readonly data: BoardData };

const columnLoad = (load: BoardLoad, column: BoardColumnId): ColumnLoad => (load.kind === "ready" ? { kind: "ready", data: load.data[column] } : load);

/** The five columns, side by side; sideways scroll below 1280px, one column at a time on a phone. */
export const HomeBoard = ({
  load,
  now,
  onMore,
  projectName,
}: {
  readonly load: BoardLoad;
  readonly now: number;
  readonly onMore: (column: BoardColumnId) => void;
  /** The picked project's name, for its own empty line; `null` for all projects. */
  readonly projectName: string | null;
}) => {
  const [phoneColumn, setPhoneColumn] = useState<BoardColumnId>("needs-you");
  const empty = load.kind === "ready" && boardEmpty(load.data);
  return (
    <div data-board>
      <div className="mb-3 overflow-x-auto sm:hidden">
        <ToggleGroup
          type="single"
          value={phoneColumn}
          onValueChange={(value) => {
            const picked = boardColumns.find((column) => column === value);
            if (picked !== undefined) setPhoneColumn(picked);
          }}
          aria-label={t("home.board.pickState")}
        >
          {boardColumns.map((column) => (
            <ToggleGroupItem key={column} value={column} className="whitespace-nowrap">
              {columnChip(column, load.kind === "ready" ? load.data : null)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scroll-snap-type:x_mandatory] xl:[scroll-snap-type:none]">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(5,240px)] xl:grid-cols-[repeat(5,minmax(0,1fr))]">
          {boardColumns.map((column) => (
            <div key={column} className={cn(column === phoneColumn ? "block" : "hidden", "sm:block")}>
              <BoardColumn column={column} load={columnLoad(load, column)} now={now} onMore={onMore} />
            </div>
          ))}
        </div>
      </div>
      {empty ? (
        <p className="mt-10 text-center text-sm text-muted">
          {projectName === null ? t("home.board.noTasks") : t("home.board.noTasksIn", { project: projectName })}
        </p>
      ) : null}
    </div>
  );
};

/** The filter's "every project" value: a Select item can't hold the empty string. */
const ALL = "all";

export type ProjectOption = { readonly id: string; readonly name: string };

/** The toolbar on both views: Overview or Board, the project filter (board only), the window note. */
export const HomeToolbar = ({
  view,
  onView,
  projects,
  project,
  onProject,
}: {
  readonly view: HomeView;
  readonly onView: (view: HomeView) => void;
  readonly projects: readonly ProjectOption[];
  readonly project: string | null;
  readonly onProject: (project: string | null) => void;
}) => {
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3" data-home-toolbar>
      <ToggleGroup
        type="single"
        value={view}
        aria-label={t("home.board.viewLabel")}
        onValueChange={(value) => {
          if (value === "overview" || value === "board") onView(value);
        }}
        className="h-7"
      >
        <ToggleGroupItem value="overview" className="flex items-center gap-1.5 text-sm font-medium">
          <ListIcon aria-hidden className="size-[15px] stroke-[1.75]" /> {t("home.board.overview")}
        </ToggleGroupItem>
        <ToggleGroupItem value="board" className="flex items-center gap-1.5 text-sm font-medium">
          <Columns3Icon aria-hidden className="size-[15px] stroke-[1.75]" /> {t("home.board.board")}
        </ToggleGroupItem>
      </ToggleGroup>
      {view === "board" ? (
        <Select value={project ?? ALL} onValueChange={(value) => { onProject(value === ALL ? null : value); }}>
          <SelectTrigger aria-label={t("home.board.filterLabel")} className="h-7 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("home.board.allProjects")}</SelectItem>
            {sorted.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                <span className="flex items-center gap-2">
                  <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(option.id) }} />
                  {option.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {view === "board" ? <span className="ml-auto text-[12.5px] text-faint">{t("home.board.window")}</span> : null}
    </div>
  );
};
