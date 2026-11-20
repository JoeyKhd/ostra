"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleStopIcon,
  CircleXIcon,
  CopyIcon,
  FileTextIcon,
  FileXIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  GlobeIcon,
  InfoIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  MoveIcon,
  PencilIcon,
  PlayIcon,
  PlugIcon,
  SearchIcon,
  ShieldCheckIcon,
  ShieldIcon,
  ShieldQuestionIcon,
  ShieldXIcon,
  SquareIcon,
  SquareTerminalIcon,
  Trash2Icon,
  UnplugIcon,
  UserIcon,
  UserRoundCogIcon,
  WrenchIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";
import type { TaskId } from "@ostra/protocol";

import { buildRows, chipOf, clockText, durationText, eventChips, INPUT_LINES, isFailed } from "./event-log-words";
import type { EventChip, LogRow } from "./event-log-words";

const icons: Readonly<Record<string, LucideIcon>> = {
  "file-text": FileTextIcon,
  "file-x": FileXIcon,
  pencil: PencilIcon,
  "trash-2": Trash2Icon,
  move: MoveIcon,
  search: SearchIcon,
  "square-terminal": SquareTerminalIcon,
  globe: GlobeIcon,
  wrench: WrenchIcon,
  user: UserIcon,
  "message-square": MessageSquareIcon,
  "message-circle-question": MessageCircleQuestionIcon,
  "shield-question": ShieldQuestionIcon,
  "shield-check": ShieldCheckIcon,
  "shield-x": ShieldXIcon,
  shield: ShieldIcon,
  "list-checks": ListChecksIcon,
  play: PlayIcon,
  square: SquareIcon,
  "circle-x": CircleXIcon,
  plug: PlugIcon,
  unplug: UnplugIcon,
  "user-round-cog": UserRoundCogIcon,
  "git-commit-horizontal": GitCommitHorizontalIcon,
  "git-pull-request": GitPullRequestIcon,
  "circle-stop": CircleStopIcon,
  "circle-dot": CircleDotIcon,
  "circle-dashed": CircleDashedIcon,
};

const PAGE = 200;
const firstAfter = (): RouterOutputs["tasks"]["eventLog"]["nextAfterSeq"] => null;

type ListRow = { readonly kind: "band"; readonly turn: number | null } | { readonly kind: "event"; readonly row: LogRow };

const chipWord = (chip: EventChip): string => t(`eventLog.chips.${chip}`);

/** The open body of a row: the input as stored (40 lines, then `Show all`), the error, a message's text. */
const RowBody = ({ row, taskId }: { readonly row: LogRow; readonly taskId: TaskId }) => {
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const body = row.body;
  if (body === null) return null;
  const lines = body.input?.split("\n") ?? [];
  const shown = all || lines.length <= INPUT_LINES ? body.input : lines.slice(0, INPUT_LINES).join("\n");
  return (
    <div className="bg-sel pb-3.5 pl-[16px] pr-3 pt-1 md:pl-[300px]" data-testid="event-body">
      {body.text === undefined ? null : <p className="whitespace-pre-wrap break-words text-ui text-muted">{body.text}</p>}
      {body.input === undefined ? null : (
        <>
          <div className="mb-1.5 flex items-center text-xs text-faint">
            {t("eventLog.input")}
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1 text-teal hover:underline"
              onClick={() => {
                void navigator.clipboard.writeText(body.input ?? "").then(() => {
                  setCopied(true);
                  setTimeout(() => { setCopied(false); }, 1500);
                });
              }}
            >
              <CopyIcon aria-hidden className="size-[13px] stroke-[1.75]" />
              {copied ? t("eventLog.copied") : t("eventLog.copyInput")}
            </button>
          </div>
          <pre className="whitespace-pre-wrap break-all rounded-lg border border-line bg-surface px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed text-muted" data-testid="event-input">{shown}</pre>
          {all || lines.length <= INPUT_LINES ? null : (
            <Button variant="link" className="mt-1 text-xs" onClick={() => { setAll(true); }}>{t("eventLog.showAll", { n: lines.length })}</Button>
          )}
        </>
      )}
      {body.error === undefined ? null : (
        <>
          <div className="mb-1.5 mt-2.5 text-xs text-faint">{t("eventLog.error")}</div>
          <p className="whitespace-pre-wrap break-all font-mono text-[12.5px] text-muted" data-testid="event-error">{body.error}</p>
        </>
      )}
      {row.word === "execute" && row.endSeq !== null ? (
        <p className="mt-2 text-xs text-faint">
          {t("eventLog.outputIn")} <a href={`/tasks/${taskId}?event=${String(row.seq)}`} className="text-teal hover:underline">{t("eventLog.inActivity")}</a>
        </p>
      ) : null}
    </div>
  );
};

/**
 * The task's Event log tab (F-073, ADR 0054; task-event-log.md): every event in order, filtered by kind,
 * each tool call with its full input, status and error. It reads what's stored and never re-runs it.
 */
export const EventLogTab = ({ taskId, names, executor, seq }: { readonly taskId: TaskId; readonly names: ReadonlyMap<string, string>; readonly executor: string | null; readonly seq: number | null }) => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const pages = useInfiniteQuery({
    queryKey: [...trpc.tasks.eventLog.queryKey({ taskId }), "pages"],
    queryFn: ({ pageParam }) => client.tasks.eventLog.query(pageParam === null ? { taskId, limit: PAGE } : { taskId, limit: PAGE, afterSeq: pageParam }),
    initialPageParam: firstAfter(),
    getNextPageParam: (last) => last.nextAfterSeq,
  });
  const events = useMemo(() => pages.data?.pages.flatMap((page) => page.events) ?? [], [pages.data]);
  const rows = useMemo(() => buildRows(events, names), [events, names]);
  const [chip, setChip] = useState<EventChip>("all");
  const [failedOnly, setFailedOnly] = useState(false);
  const [newestFirst, setNewestFirst] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set(seq === null ? [] : [seq]));
  const [picked, setPicked] = useState<number | null>(seq);
  const more = pages.hasNextPage;

  // A link to one event (`&seq=`) loads pages until it's there.
  const target = seq === null ? null : rows.find((row) => row.seq === seq || row.endSeq === seq);
  useEffect(() => {
    if (seq !== null && target === undefined && more && !pages.isFetchingNextPage) void pages.fetchNextPage();
  }, [seq, target, more, pages]);

  const counts = useMemo(() => {
    const out = new Map<EventChip, number>(eventChips.map((value) => [value, 0]));
    for (const row of rows) {
      out.set("all", (out.get("all") ?? 0) + 1);
      out.set(row.chip, (out.get(row.chip) ?? 0) + 1);
    }
    return out;
  }, [rows]);
  const failedCount = rows.filter((row) => chipOf(row, chip) && isFailed(row)).length;
  const shown = rows.filter((row) => chipOf(row, chip) && (!failedOnly || isFailed(row)));
  const ordered = newestFirst ? [...shown].reverse() : shown;
  const list = useMemo<readonly ListRow[]>(() => {
    const out: ListRow[] = [];
    let last: number | null | undefined = undefined;
    for (const row of ordered) {
      if (row.turn !== last) {
        out.push({ kind: "band", turn: row.turn });
        last = row.turn;
      }
      out.push({ kind: "event", row });
    }
    return out;
  }, [ordered]);

  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: list.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => (list[index]?.kind === "band" ? 32 : 34),
    overscan: 10,
  });
  const items = virtualizer.getVirtualItems();
  const lastItem = items.at(-1);
  useEffect(() => {
    if (lastItem !== undefined && lastItem.index >= list.length - 8 && more && !pages.isFetchingNextPage) void pages.fetchNextPage();
  }, [lastItem, list.length, more, pages]);

  // Scroll to the linked event once it's loaded.
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || target === undefined || target === null) return;
    const index = list.findIndex((entry) => entry.kind === "event" && entry.row.seq === target.seq);
    if (index < 0) return;
    scrolled.current = true;
    setPicked(target.seq);
    setOpen((previous) => new Set(previous).add(target.seq));
    virtualizer.scrollToIndex(index, { align: "center" });
  }, [target, list, virtualizer]);

  const toggle = (row: LogRow) => {
    setPicked(row.seq);
    if (row.body === null) return;
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(row.seq)) next.delete(row.seq);
      else next.add(row.seq);
      return next;
    });
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, row: LogRow) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const at = ordered.findIndex((candidate) => candidate.seq === row.seq);
    const next = ordered[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (next === undefined) return;
    setPicked(next.seq);
    const index = list.findIndex((entry) => entry.kind === "event" && entry.row.seq === next.seq);
    virtualizer.scrollToIndex(index);
    requestAnimationFrame(() => { document.querySelector<HTMLButtonElement>(`[data-seq="${String(next.seq)}"]`)?.focus(); });
  };

  const recordLine = executor === "host" ? t("eventLog.recordHost") : t("eventLog.recordBox");
  const loading = pages.isPending;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="event-log">
      <div className="sticky top-0 z-10 mt-2.5 flex min-h-10 flex-wrap items-center gap-1.5 bg-bg py-1" role="toolbar" aria-label={t("eventLog.filters")}>
        {eventChips.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={chip === value}
            data-chip={value}
            onClick={() => { setChip(value); }}
            className={cn("inline-flex h-[26px] items-center gap-1.5 rounded-md border border-line-2 px-2.5 text-[13px]", chip === value ? "bg-raise text-text" : "text-muted hover:bg-hover")}
          >
            {chipWord(value)}
            <span className="font-mono text-xs text-faint">{loading ? "–" : (counts.get(value) ?? 0)}</span>
          </button>
        ))}
        <span aria-hidden className="mx-3 h-[18px] w-px bg-line-2" />
        <button
          type="button"
          aria-pressed={failedOnly}
          disabled={failedCount === 0 && !failedOnly}
          data-chip="failed"
          onClick={() => { setFailedOnly((value) => !value); }}
          className={cn("inline-flex h-[26px] items-center gap-1.5 rounded-md border border-line-2 px-2.5 text-[13px] text-muted disabled:opacity-60", failedOnly && "bg-raise text-text")}
        >
          <CircleXIcon aria-hidden className={cn("size-[13px] stroke-[1.75]", failedCount === 0 ? "text-faint" : "text-red")} />
          {t("eventLog.failedOrRefused")}
          <span className={cn("font-mono text-xs", failedCount === 0 ? "text-faint" : "text-red")}>{failedCount}</span>
        </button>
        <Button variant="ghost" size="sm" className="ml-auto text-[13px] text-faint" onClick={() => { setNewestFirst((value) => !value); }}>
          {newestFirst ? t("eventLog.newestFirst") : t("eventLog.oldestFirst")}
        </Button>
      </div>
      <p className="flex min-h-8 items-center gap-2.5 border-b border-line text-[13px] text-faint">
        <InfoIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
        {recordLine}
      </p>

      {pages.isError ? (
        <p role="alert" className="mt-3 text-[13px] text-red">
          {t("eventLog.loadFailed", { error: errorText(pages.error) ?? "" })} <Button variant="link" onClick={() => { void pages.refetch(); }}>{t("eventLog.tryAgain")}</Button>
        </p>
      ) : loading ? (
        <div aria-busy>{Array.from({ length: 8 }, (_, i) => <div key={i} className="flex h-[34px] items-center border-b border-line"><Skeleton className="w-[420px] max-w-full" /></div>)}</div>
      ) : rows.length === 0 ? (
        <div className="mt-6">
          <p className="text-ui text-muted">{t("eventLog.nothingYet")}</p>
          <p className="mt-1 text-[13px] text-faint">{t("eventLog.nothingYetHint")}</p>
        </div>
      ) : ordered.length === 0 ? (
        <p className="mt-6 text-ui text-muted">{failedOnly ? t("eventLog.nothingFailed") : t("eventLog.noKind", { kind: chipWord(chip).toLowerCase() })}</p>
      ) : (
        <div ref={scroller} className="h-[65vh] overflow-y-auto xl:h-[calc(100dvh-320px)]" data-testid="event-log-rows">
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const entry = list[item.index];
              if (entry === undefined) return null;
              const style = { transform: `translateY(${String(item.start)}px)` } as const;
              if (entry.kind === "band") {
                return (
                  <div key={`band-${String(entry.turn)}-${String(item.index)}`} ref={virtualizer.measureElement} data-index={item.index} className="absolute left-0 top-0 flex h-8 w-full items-center bg-raise px-3 text-ui font-semibold text-text" style={style}>
                    {entry.turn === null ? t("eventLog.beforeTurn") : t("eventLog.turn", { n: entry.turn })}
                  </div>
                );
              }
              const row = entry.row;
              const isOpen = open.has(row.seq) && row.body !== null;
              const Icon = icons[row.icon] ?? CircleDotIcon;
              return (
                <div key={row.seq} ref={virtualizer.measureElement} data-index={item.index} className="absolute left-0 top-0 w-full border-b border-line" style={style}>
                  <button
                    type="button"
                    data-seq={row.seq}
                    data-testid="event-row"
                    data-word={row.word}
                    aria-expanded={row.body === null ? undefined : isOpen}
                    onClick={() => { toggle(row); }}
                    onKeyDown={(event) => { onKey(event, row); }}
                    className={cn(
                      "grid min-h-[34px] w-full grid-cols-[16px_44px_minmax(0,1fr)_auto] items-center gap-x-2 text-left md:grid-cols-[16px_44px_84px_112px_minmax(0,1fr)_120px_56px]",
                      isOpen || picked === row.seq ? "bg-sel" : "hover:bg-hover",
                    )}
                  >
                    <span className="flex justify-center text-muted">
                      {row.body === null ? null : isOpen ? <ChevronDownIcon aria-hidden className="size-[14px]" /> : <ChevronRightIcon aria-hidden className="size-[14px]" />}
                    </span>
                    <span className="text-right font-mono text-xs text-faint">{row.seq}</span>
                    <span className="hidden pl-2 font-mono text-xs text-faint md:inline" title={new Date(row.at).toISOString()}>{clockText(row.at)}</span>
                    <span className="hidden items-center gap-2.5 md:flex">
                      <Icon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
                      <span className="truncate font-mono text-[12.5px] text-muted">{row.word}</span>
                    </span>
                    <span className="min-w-0 truncate text-ui" data-testid="event-text">
                      {row.text.strong === undefined ? null : <span className="font-semibold text-text">{row.text.strong} </span>}
                      {row.text.lead === undefined ? null : <span className="text-muted">{row.text.lead}</span>}
                      {row.text.mono === undefined ? null : <span className="font-mono text-[13px] text-text">{row.text.lead === undefined ? "" : " "}{row.text.mono}</span>}
                      {row.text.tail === undefined ? null : <span className="text-faint">{row.text.tail}</span>}
                    </span>
                    <span className={cn("flex items-center justify-end gap-1 pr-1 text-[13px]", row.status?.tone === "ok" ? "text-green" : row.status?.tone === "failed" ? "text-red" : "text-muted")} data-testid="event-status">
                      {row.status?.tone === "running" ? <LoaderCircleIcon aria-hidden className="size-[13px] animate-spin" /> : null}
                      {row.status?.word ?? ""}
                    </span>
                    <span className="hidden pr-2 text-right font-mono text-xs text-faint md:inline">{row.chip === "tool" || row.durationMs !== null ? durationText(row.durationMs) : ""}</span>
                  </button>
                  {isOpen ? <RowBody row={row} taskId={taskId} /> : null}
                </div>
              );
            })}
          </div>
          <p className="py-4 text-xs text-faint">
            {t("eventLog.showing", { shown: ordered.length })}
            {more ? ` ${t("eventLog.scrollForMore")}` : ""}
          </p>
        </div>
      )}
    </div>
  );
};
