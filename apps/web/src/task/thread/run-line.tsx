"use client";

import { ChevronRightIcon } from "lucide-react";

import type { RunItem, TaskUIMessage } from "@ostra/task-view";

import { SubagentsBadge } from "@/components/tasks/subagents-badge";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { useTaskContext } from "../task-context";
import { isRunOpen, useRunOpen } from "./run-open";
import { RunSteps } from "./run-steps";
import { Segments } from "./segments";
import { TurnTime } from "./turn-numbers";
import { runLineWords } from "./words";

// Owner: ticket 10 (milestone 10, F-151: a run's line, parts.md part 4). One quiet line per closed
// run: a 28px button, 14px `--faint`, its counts in order and its tail (`failed` and `denied` the
// only red words), a chevron that turns when it's open; the subagents badge after the chevron; the
// turn's time on the turn's first line. Pressed, it opens its steps in place. What's open is the
// viewer's (`run-open.ts`), never saved, and stays open as new events arrive.

export const RunLine = ({ run, message }: { readonly run: RunItem; readonly message: TaskUIMessage }) => {
  const { memberName, openSubagents } = useTaskContext();
  const { state, store } = useRunOpen();
  const open = isRunOpen(state, run);
  const words = runLineWords(run, t, memberName);
  const listId = `steps-${run.id}`;
  return (
    <div data-part="run" data-item={run.id} data-open={open ? "true" : "false"}>
      <div className="my-1.5 -ml-1.5 flex min-h-7 max-w-full items-center">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => { store.toggleRun(run); }}
          className={cn("flex min-h-7 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-ui text-faint hover:bg-hover hover:text-muted", open && "text-muted")}
        >
          <span data-part="run-words" className="min-w-0 truncate"><Segments segments={words} mono="font-mono text-[13px] text-muted" /></span>
          <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 text-faint", open && "rotate-90")} />
        </button>
        {run.subagents === null || openSubagents === undefined ? null : (
          <SubagentsBadge counts={run.subagents} onOpen={() => { openSubagents(message.id, null); }} className="ml-1.5" />
        )}
        {run.firstInTurn ? <span className={cn("flex shrink-0", run.subagents !== null && "ml-1.5")}><TurnTime message={message} /></span> : null}
      </div>
      {open ? <RunSteps run={run} message={message} id={listId} /> : null}
    </div>
  );
};
