"use client";

import { LayersIcon, XIcon } from "lucide-react";

import type { SubagentTree } from "@ostra/task-view";

import { cn } from "@/lib/cn";

import { Spinner } from "./subagent-marks";
import { badgeName, badgeState, badgeStateText, subagentCount } from "./subagent-words";

// F-138: the badge on the agent's turn (task-subagents-tree.md, "1. The badge"): how many subagents
// the turn started, nested ones included, then the one state that matters most: an approval
// waiting, a failure, one running, one stopped. It opens the turn's window.

export const SubagentsBadge = ({ tree, onOpen, className }: { readonly tree: SubagentTree; readonly onOpen: () => void; readonly className?: string }) => {
  const state = badgeState(tree.counts);
  return (
    <button
      type="button"
      data-testid="subagents-badge"
      data-state={state?.state ?? "done"}
      aria-haspopup="dialog"
      aria-label={badgeName(tree.counts)}
      onClick={onOpen}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 self-center whitespace-nowrap rounded-[6px] border border-line-2 bg-surface px-[9px] text-[12.5px] font-medium text-text",
        "hover:border-line-3 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text",
        className,
      )}
    >
      <LayersIcon aria-hidden className="size-[13px] stroke-[1.75] text-muted" />
      <span>{subagentCount(tree.counts.total)}</span>
      {state === null ? null : (
        <>
          <span aria-hidden className="text-faint">·</span>
          {state.state === "needs-approval" ? (
            <span className="inline-flex items-center gap-1.5 text-amber-text">
              <span aria-hidden className="size-[7px] rounded-full bg-amber" />
              {badgeStateText(state)}
            </span>
          ) : state.state === "failed" ? (
            <span className="inline-flex items-center gap-1 text-red">
              <XIcon aria-hidden className="size-3 stroke-[1.75]" />
              {badgeStateText(state)}
            </span>
          ) : state.state === "running" ? (
            <span className="inline-flex items-center gap-1.5 text-teal">
              <Spinner size={11} />
              {badgeStateText(state)}
            </span>
          ) : (
            <span className="text-faint">{badgeStateText(state)}</span>
          )}
        </>
      )}
    </button>
  );
};
