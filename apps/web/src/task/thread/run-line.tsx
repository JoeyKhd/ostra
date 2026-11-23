"use client";

import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import type { RunItem, TaskUIMessage } from "@ostra/task-view";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { useTaskContext } from "../task-context";
import { RunSteps } from "./run-steps";
import { Segments } from "./segments";
import { TurnTime } from "./turn-numbers";
import { runLineWords, segmentsText } from "./words";

// Owner: ticket 10 (milestone 10, F-151: a run's line, parts.md part 4). Ticket 09's stub, with its
// final props: one quiet line per closed run, 28px, 14px `--faint`, its counts and its tail, a
// chevron, the turn's time on its first line; pressed, it opens its steps in place.

export const RunLine = ({ run, message }: { readonly run: RunItem; readonly message: TaskUIMessage }) => {
  const { memberName } = useTaskContext();
  const [open, setOpen] = useState(false);
  const words = runLineWords(run, t, memberName);
  return (
    <div data-part="run" data-item={run.id}>
      <div className="my-1.5 -ml-1.5 flex min-h-7 max-w-full items-center">
        <button
          type="button"
          aria-expanded={open}
          title={segmentsText(words)}
          onClick={() => { setOpen((value) => !value); }}
          className={cn("flex min-h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-ui text-faint hover:bg-hover hover:text-muted focus-visible:outline-2 focus-visible:outline-teal", open && "text-muted")}
        >
          <span className="min-w-0 truncate whitespace-nowrap"><Segments segments={words} mono="font-mono text-[13px] text-muted" /></span>
          <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 text-faint", open && "rotate-90")} />
        </button>
        {run.firstInTurn ? <TurnTime message={message} /> : null}
      </div>
      {open ? <RunSteps run={run} message={message} /> : null}
    </div>
  );
};
