"use client";

import { ChevronLeftIcon, InfoIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";

import type { SubagentNode, SubagentTree, TaskToolPart, TaskUIMessage } from "@ostra/task-view";

import { KeyCap } from "@/components/shell/actions/kbd-sequence";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTaskContext, useTaskMessage } from "@/task/task-context";

import { RootDetail, SubagentDetail } from "./subagent-detail";
import { Spinner, StateMark } from "./subagent-marks";
import { ROOT, SubagentTreePane, baseFor } from "./subagent-tree";
import type { RootCard } from "./subagent-tree";
import { badgeState, badgeStateText, callCount, initialSelection, nodeDurationMs, shortDuration } from "./subagent-words";

// F-138: the subagents window (task-subagents-tree.md): the badge or a `Subagent` row opens it over
// the task page, with no route of its own. At 900px and wider a dialog, the tree on the left and
// the selected node's details on the right; narrower, the panel's bottom sheet at full height, the
// tree as an indented list whose rows open their details. Built from the turn's message, which the
// fold rebuilds from the task's events, so it shows what a reload or a second tab shows.

export type SubagentsAt = { readonly messageId: string; readonly subagentId: string | null };

const NARROW = "(max-width: 899px)";

const useNarrow = (): boolean => {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(NARROW).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const update = () => { setNarrow(query.matches); };
    update();
    query.addEventListener("change", update);
    return () => { query.removeEventListener("change", update); };
  }, []);
  return narrow;
};

/** The time now, every second while something runs: a running subagent's time, live. */
const useTicking = (live: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [live]);
  return now;
};

/** The header's state words, in their colours: `· 1 running`. */
const SummaryState = ({ tree }: { readonly tree: SubagentTree }) => {
  const state = badgeState(tree.counts);
  if (state === null) return null;
  const tone = state.state === "needs-approval" ? "text-amber-text" : state.state === "failed" ? "text-red" : state.state === "running" ? "text-teal" : "text-faint";
  return (
    <>
      <span aria-hidden className="text-faint"> · </span>
      <span className={tone}>{badgeStateText(state)}</span>
    </>
  );
};

type Turn = {
  readonly tree: SubagentTree;
  readonly root: RootCard;
  readonly rootCalls: readonly TaskToolPart[];
  readonly startedAt: number | null;
  readonly byId: ReadonlyMap<string, SubagentNode>;
};

const isToolPart = (part: TaskUIMessage["parts"][number]): part is TaskToolPart =>
  part.type === "dynamic-tool" || part.type === "tool-read" || part.type === "tool-edit" || part.type === "tool-execute";

const turnOf = (message: TaskUIMessage | undefined, agent: { readonly name: string; readonly model: string | null }, now: number): Turn | null => {
  const meta = message?.metadata;
  const tree = meta?.subagents;
  if (message === undefined || meta === undefined || tree === undefined) return null;
  const owned = new Set(tree.nodes.flatMap((node) => node.rounds.flatMap((round) => round.calls.map((call) => call.toolCallId))));
  const rootCalls = message.parts.filter(isToolPart).filter((part) => !owned.has(part.toolCallId));
  const state = meta.turnState === "failed" ? "failed" : meta.turnState === "running" ? "running" : "ended";
  const startedAt = meta.at ?? null;
  const duration = startedAt === null ? "–" : shortDuration(Math.max(0, (meta.endedAt ?? now) - startedAt));
  return {
    tree,
    root: { agent: agent.name, model: agent.model, state, duration, calls: callCount(rootCalls.length) },
    rootCalls,
    startedAt,
    byId: new Map(tree.nodes.map((node) => [node.id, node] as const)),
  };
};

export const SubagentsWindow = ({
  at,
  onClose,
  opener,
  asked,
}: {
  readonly at: SubagentsAt;
  readonly onClose: () => void;
  /** What opened it: the focus goes back there when it closes. */
  readonly opener: HTMLElement | null;
  /** The member's message the turn answered, for the main agent's pane. */
  readonly asked: { readonly name: string; readonly text: string } | null;
}) => {
  const { agent } = useTaskContext();
  const message = useTaskMessage(at.messageId);
  const live = (message?.metadata?.subagents?.counts.running ?? 0) + (message?.metadata?.turnState === "running" ? 1 : 0) > 0;
  const now = useTicking(live);
  const turn = useMemo(() => turnOf(message, agent, now), [message, agent, now]);
  const narrow = useNarrow();
  const [selected, setSelected] = useState<string>(() => (turn === null ? ROOT : (initialSelection(turn.tree, at.subagentId) ?? ROOT)));
  const [base, setBase] = useState<string>(() => (turn === null ? ROOT : baseFor(turn.tree, ROOT, selected)));
  // On a phone: the list, or one node's details.
  const [phoneDetail, setPhoneDetail] = useState(false);

  if (turn === null) return null;
  const select = (id: string): void => {
    setSelected(id);
    setBase((current) => baseFor(turn.tree, current, id));
  };
  const node = selected === ROOT ? undefined : turn.byId.get(selected);
  const parentName = (child: SubagentNode): string => (child.parentId === null ? agent.name : (turn.byId.get(child.parentId)?.description ?? agent.name));
  const detail =
    node === undefined ? (
      <RootDetail agent={agent.name} state={turn.root.state} startedAt={turn.startedAt} duration={turn.root.duration} calls={turn.rootCalls} asked={asked} onSelect={select} />
    ) : (
      <SubagentDetail key={node.id} node={node} parentName={parentName(node)} agentName={agent.name} now={now} onSelect={select} />
    );
  const summary = (
    <span className="truncate text-[13px] text-faint">
      {t("task.subagents.summary", { n: turn.tree.counts.total, agent: agent.name, time: turn.startedAt === null ? "–" : formatClock(turn.startedAt) })}
      <SummaryState tree={turn.tree} />
    </span>
  );
  const closeFocus = (event: Event): void => {
    event.preventDefault();
    opener?.focus();
  };

  if (narrow) {
    return (
      <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
        <SheetContent side="bottom" title={t("task.subagents.title")} closeButton={false} data-testid="subagents-window" data-layout="sheet" className="h-dvh max-h-dvh rounded-none bg-raise" onCloseAutoFocus={closeFocus}>
          <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4">
            {phoneDetail ? (
              <button type="button" data-action="subagents-back" onClick={() => { setPhoneDetail(false); }} className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 text-[13px] text-teal">
                <ChevronLeftIcon aria-hidden className="size-4" />
                {t("task.subagents.back")}
              </button>
            ) : (
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="text-[15px] font-semibold text-text">{t("task.subagents.title")}</span>
                {summary}
              </div>
            )}
            <Dialog.Close className="ml-auto inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-faint hover:bg-sel hover:text-text">{t("task.subagents.close")}</Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {phoneDetail ? (
              <div className="p-4">{detail}</div>
            ) : (
              <PhoneList turn={turn} selected={selected} now={now} onOpen={(id) => { select(id); setPhoneDetail(true); }} />
            )}
          </div>
          <Footer />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-(--scrim)" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="subagents-window"
          data-layout="dialog"
          onOpenAutoFocus={(event) => {
            // The first focus is on the selected node, in the tree.
            event.preventDefault();
            requestAnimationFrame(() => {
              document.querySelector<HTMLElement>(`[data-testid="subagents-window"] [data-tree-card="${CSS.escape(selected)}"]`)?.focus();
            });
          }}
          onCloseAutoFocus={closeFocus}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(80vh,720px)] w-[min(1140px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line-2 bg-raise shadow-(--shadow-palette) focus:outline-none"
        >
          <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-5">
            <Dialog.Title className="shrink-0 text-[15px] font-semibold text-text">{t("task.subagents.title")}</Dialog.Title>
            {summary}
            <Dialog.Close className="ml-auto inline-flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-xs text-faint hover:bg-sel hover:text-text" aria-label={t("task.subagents.close")}>
              <KeyCap>esc</KeyCap>
              {t("task.subagents.close")}
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1">
            <SubagentTreePane tree={turn.tree} root={turn.root} selected={selected} onSelect={select} base={base} onBase={setBase} now={now} />
            <div className="w-[400px] shrink-0 overflow-y-auto border-l border-line p-5 max-[1179px]:w-[360px]">{detail}</div>
          </div>
          <Footer />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

const Footer = () => (
  <div className="flex min-h-11 shrink-0 items-center gap-1.5 border-t border-line px-5 py-2 text-[12.5px] text-faint">
    <InfoIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
    <span>{t("task.subagents.footer")}</span>
  </div>
);

/** On a phone: the tree as an indented list, one 56px row per node, 16px per level with a guide. */
const PhoneList = ({ turn, selected, now, onOpen }: { readonly turn: Turn; readonly selected: string; readonly now: number; readonly onOpen: (id: string) => void }) => {
  const rows = [{ id: ROOT, depth: 0 }, ...turn.tree.nodes.map((node) => ({ id: node.id, depth: node.depth }))];
  const onKey = (event: KeyboardEvent<HTMLElement>, index: number): void => {
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const id = rows[Math.max(0, Math.min(rows.length - 1, next))]?.id;
    if (id !== undefined) document.querySelector<HTMLElement>(`[data-list-row="${CSS.escape(id)}"]`)?.focus();
  };
  return (
    <div role="tree" aria-label={t("task.subagents.treeLabel", { agent: turn.root.agent })} className="py-1">
      {rows.map((row, index) => {
        const node = row.id === ROOT ? undefined : turn.byId.get(row.id);
        const ms = node === undefined ? null : nodeDurationMs(node, now);
        return (
          <button
            key={row.id}
            type="button"
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={row.id === selected}
            data-list-row={row.id}
            data-testid={node === undefined ? "subagent-row-root" : "subagent-list-row"}
            tabIndex={row.id === selected ? 0 : -1}
            onClick={() => { onOpen(row.id); }}
            onKeyDown={(event) => { onKey(event, index); }}
            className={cn("flex h-14 w-full items-stretch text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-text", row.id === selected && "bg-sel")}
          >
            {Array.from({ length: row.depth }, (_, level) => (
              <span key={level} aria-hidden className="ml-4 w-0 shrink-0 border-l border-line-2 first:ml-6" />
            ))}
            <span className="flex min-w-0 flex-1 items-center gap-2.5 pl-4 pr-4">
              {node === undefined ? (
                turn.root.state === "running" ? <Spinner size={9} /> : <span aria-hidden className={cn("size-[7px] shrink-0 rounded-full", turn.root.state === "failed" ? "bg-red" : "bg-green")} />
              ) : (
                <StateMark state={node.state} />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-text">
                  {node === undefined ? turn.root.agent : node.description}
                  {node === undefined ? <span className="font-normal text-faint"> {t("task.subagents.mainAgent")}</span> : null}
                </span>
                <span className="block truncate font-mono text-xs text-faint">
                  {node === undefined ? `${turn.root.model ?? ""}${turn.root.model === null ? "" : " · "}${turn.root.duration}` : `${node.type ?? ""}${node.type === null ? "" : " · "}${ms === null ? "–" : shortDuration(ms)}`}
                </span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
};
