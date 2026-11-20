"use client";

import { ChevronRightIcon } from "lucide-react";
import { useMemo } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import type { SubagentNode, SubagentTree } from "@ostra/task-view";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { Spinner, StateMark } from "./subagent-marks";
import { cardName, descendantCount, nodeLine, stateWord } from "./subagent-words";

// F-138: the tree pane of the subagents window (task-subagents-tree.md, "2. The window"): cards in
// columns read left to right, the main agent in the first, its subagents in the second, theirs in
// the third; a parent level with the middle of its children, joined by 1px square elbows drawn
// with borders. At most three columns: a deeper subtree folds into a `+n below` chip, and opening it
// starts the tree at that subagent's parent, with a breadcrumb back. A WAI tree for the keyboard.

/** The main agent's card, by its ID in the tree. */
export const ROOT = "root";

export type RootCard = {
  readonly agent: string;
  readonly model: string | null;
  readonly state: "running" | "ended" | "failed";
  /** The turn's time so far, or its whole time. */
  readonly duration: string;
  readonly calls: string;
};

type Props = {
  readonly tree: SubagentTree;
  readonly root: RootCard;
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  /** The node the first column starts at: the main agent, or a subagent once a deep branch was opened. */
  readonly base: string;
  readonly onBase: (id: string) => void;
  readonly now: number;
};

const COLUMNS = 3;

/** A card's line 2's end: the states that need saying there, in their colours. */
const StateSuffix = ({ node }: { readonly node: SubagentNode }) => {
  switch (node.state) {
    case "needs-approval":
      return <span className="text-amber-text"> · {stateWord(node.state)}</span>;
    case "failed":
      return <span className="text-red"> · {stateWord(node.state)}</span>;
    case "stopped":
      return <span> · {stateWord(node.state)}</span>;
    case "running":
    case "done":
      return null;
    default:
      return node.state satisfies never;
  }
};

/** The ancestors of a node, nearest last, the main agent first. */
const pathTo = (byId: ReadonlyMap<string, SubagentNode>, id: string): readonly string[] => {
  const path: string[] = [];
  let at = byId.get(id);
  while (at !== undefined) {
    path.unshift(at.id);
    at = at.parentId === null ? undefined : byId.get(at.parentId);
  }
  return [ROOT, ...path];
};

/** The base that shows `id` within the three columns: its own when it fits, else its grandparent's column. */
export const baseFor = (tree: SubagentTree, base: string, id: string): string => {
  if (id === ROOT) return base;
  const byId = new Map(tree.nodes.map((node) => [node.id, node] as const));
  const path = pathTo(byId, id);
  const from = path.indexOf(base);
  if (from !== -1 && path.length - 1 - from < COLUMNS) return base;
  // Start at the node's parent, so it sits in the second column with its own children beside it.
  return path[path.length - 2] ?? ROOT;
};

export const SubagentTreePane = ({ tree, root, selected, onSelect, base, onBase, now }: Props) => {
  const byId = useMemo(() => new Map(tree.nodes.map((node) => [node.id, node] as const)), [tree]);
  const childrenOf = (id: string): readonly string[] => (id === ROOT ? tree.nodes.filter((node) => node.parentId === null).map((node) => node.id) : (byId.get(id)?.children ?? []));
  // The cards shown, depth first: the keyboard's order.
  const shown: { readonly id: string; readonly column: number; readonly parent: string | null }[] = [];
  const visit = (id: string, column: number, parent: string | null): void => {
    shown.push({ id, column, parent });
    if (column < COLUMNS - 1) for (const child of childrenOf(id)) visit(child, column + 1, id);
  };
  visit(base, 0, null);

  const focusCard = (id: string): void => {
    onSelect(id);
    // At once, so the next key goes to it; a card that a re-rooted tree draws anew, on the next frame.
    const card = (): HTMLElement | null => document.querySelector<HTMLElement>(`[data-tree-card="${CSS.escape(id)}"]`);
    const now = card();
    if (now === null) {
      requestAnimationFrame(() => card()?.focus());
    } else {
      now.focus();
    }
  };

  const onKey = (event: KeyboardEvent<HTMLElement>, id: string): void => {
    const at = shown.findIndex((entry) => entry.id === id);
    const entry = shown[at];
    if (entry === undefined) return;
    let next: string | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = shown[at + 1]?.id;
        break;
      case "ArrowUp":
        next = shown[at - 1]?.id;
        break;
      case "ArrowRight":
        next = shown.find((other) => other.parent === id)?.id;
        break;
      case "ArrowLeft":
        next = entry.parent ?? undefined;
        break;
      case "Home":
        next = shown[0]?.id;
        break;
      case "End":
        next = shown.at(-1)?.id;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next !== undefined) focusCard(next);
  };

  const card = (id: string, column: number): ReactNode => {
    const isSelected = id === selected;
    const common = {
      role: "treeitem",
      "data-tree-card": id,
      "aria-level": column + 1,
      "aria-selected": isSelected,
      tabIndex: isSelected ? 0 : -1,
      onClick: () => { onSelect(id); },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => { onKey(event, id); },
      className: cn(
        // The middle column's cards, the main agent's subagents, are 220px; the first and the third
        // 200px, so three columns fit the 740px pane, as the target draws them.
        column === 1 ? "w-[220px]" : "w-[200px]",
        "shrink-0 cursor-pointer rounded-lg border px-3 py-2.5 text-left outline-none",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text",
        isSelected ? "border-faint bg-sel" : "border-line-2 bg-surface hover:bg-hover",
      ),
    } as const;
    const hasChildren = childrenOf(id).length > 0;
    if (id === ROOT) {
      return (
        <div {...common} aria-expanded={hasChildren ? true : undefined} aria-label={t("task.subagents.rootName", { agent: root.agent, state: t(`task.subagents.turnState.${root.state}`), duration: root.duration, calls: root.calls })} data-testid="subagent-card-root">
          <div className="flex min-w-0 items-center gap-2">
            {root.state === "running" ? <Spinner size={9} /> : <span aria-hidden className={cn("size-[7px] shrink-0 rounded-full", root.state === "failed" ? "bg-red" : "bg-green")} />}
            <span className="truncate text-[13.5px] font-medium text-text">{root.agent}</span>
            <span className="shrink-0 text-[13.5px] text-faint">{t("task.subagents.mainAgent")}</span>
          </div>
          {root.model === null ? null : <div className="mt-1 truncate font-mono text-xs tracking-[-0.01em] text-faint">{root.model}</div>}
          <div className="mt-0.5 truncate font-mono text-xs tracking-[-0.01em] text-faint">{t("task.subagents.rootLine", { time: root.duration, calls: root.calls })}</div>
        </div>
      );
    }
    const node = byId.get(id);
    if (node === undefined) return null;
    return (
      <div {...common} aria-expanded={hasChildren ? true : undefined} aria-label={cardName(node, now)} data-testid="subagent-card" data-state={node.state}>
        <div className="flex min-w-0 items-center gap-2">
          <StateMark state={node.state} />
          <span title={node.description} className="truncate text-[13.5px] font-medium text-text">{node.description === "" ? node.type : node.description}</span>
        </div>
        <div className="mt-1 truncate font-mono text-xs tracking-[-0.01em] text-faint">
          {nodeLine(node, now)}
          <StateSuffix node={node} />
        </div>
      </div>
    );
  };

  const branch = (id: string, column: number): ReactNode => {
    const children = childrenOf(id);
    const folded = column >= COLUMNS - 1 && children.length > 0;
    return (
      <div className="flex items-center">
        {card(id, column)}
        {folded ? (
          <>
            <span aria-hidden className="h-px w-[18px] shrink-0 bg-line-3" />
            <button
              type="button"
              data-testid="subagent-fold"
              onClick={() => { onBase(baseFor(tree, base, children[0] ?? id)); }}
              className="inline-flex h-6 shrink-0 items-center rounded-[6px] border border-line-2 px-2 font-mono text-xs text-faint hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-text"
            >
              {t("task.subagents.below", { n: descendantCount(tree, id) })}
            </button>
          </>
        ) : children.length === 0 ? null : (
          <>
            <span aria-hidden className="h-px w-[18px] shrink-0 bg-line-3" />
            <div role="group" className="flex flex-col gap-6">
              {children.map((child, index) => (
                <div key={child} className="relative flex items-center pl-[18px]">
                  <span aria-hidden className="absolute left-0 top-1/2 h-px w-[18px] bg-line-3" />
                  {children.length < 2 ? null : (
                    <span
                      aria-hidden
                      className={cn(
                        "absolute left-0 w-px bg-line-3",
                        index === 0 ? "top-1/2 -bottom-3" : index === children.length - 1 ? "-top-3 bottom-1/2" : "-top-3 -bottom-3",
                      )}
                    />
                  )}
                  {branch(child, column + 1)}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  };

  const crumbs = base === ROOT ? [] : pathTo(byId, base);
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto px-6 py-7" data-testid="subagent-tree-pane">
      {crumbs.length === 0 ? null : (
        <nav aria-label={t("task.subagents.breadcrumb")} className="mb-4 flex flex-wrap items-center gap-1 text-[13px]">
          {crumbs.map((crumb, index) => (
            <span key={crumb} className="inline-flex items-center gap-1">
              {index === 0 ? null : <ChevronRightIcon aria-hidden className="size-3 text-faint" />}
              <button type="button" onClick={() => { onBase(crumb); }} className={cn("rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-text", crumb === base ? "text-text" : "text-muted")}>
                {crumb === ROOT ? root.agent : (byId.get(crumb)?.description ?? crumb)}
              </button>
            </span>
          ))}
        </nav>
      )}
      <div role="tree" aria-label={t("task.subagents.treeLabel", { agent: root.agent })} className="inline-flex min-w-max">
        {branch(base, 0)}
      </div>
    </div>
  );
};
