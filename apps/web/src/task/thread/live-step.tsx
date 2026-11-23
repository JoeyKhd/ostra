"use client";

import { ChevronRightIcon, PauseIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { LiveStep } from "@ostra/task-view";

import { t } from "@/lib/messages";

import { Segments } from "./segments";
import { liveStepWords } from "./words";

// Owner: ticket 11 (milestone 10, F-151: the live step, parts.md part 5). Ticket 09's stub, with its
// final props: in the place its run's line will take, a spinner, what the agent does now, the
// turn's progress and its clock, ticking each second. Ticket 11 opens the run so far from it and
// gives it its polite live region.

/** The time now, each second: the live step's clock (the spec's seam: an injected `now` in tests). */
const useSecond = (start: number | undefined): number => {
  const [now, setNow] = useState(() => start ?? Date.now());
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { clearInterval(timer); };
  }, []);
  return now;
};

export const LiveStepLine = ({ live, now: fixedNow }: { readonly live: LiveStep; readonly now?: number }) => {
  const ticking = useSecond(fixedNow);
  const now = fixedNow ?? ticking;
  const words = liveStepWords(live, t, now);
  return (
    <div data-part="live-step" className="my-1.5 -ml-1.5 flex min-h-7 w-fit max-w-full items-center gap-2 whitespace-nowrap rounded-md px-1.5 text-ui text-text-2">
      {words.waiting === null ? (
        <span aria-hidden className="size-3 shrink-0 animate-spin rounded-full border-[1.75px] border-line-2 border-t-teal motion-reduce:animate-none" />
      ) : (
        <PauseIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-muted" />
      )}
      <span className="shrink-0"><Segments segments={words.waiting?.asks ?? words.doing} mono="font-mono text-[13.5px]" /></span>
      {words.waiting === null ? (
        <span className="min-w-0 truncate text-faint">
          {words.progress.length === 0 ? null : <> · <Segments segments={words.progress} /></>}
          {words.clock === null ? null : <> · <span className="font-mono text-[12.5px]">{words.clock}</span></>}
        </span>
      ) : (
        <span className="shrink-0 text-sm font-medium text-amber-text">{words.waiting.needs}</span>
      )}
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-faint" />
    </div>
  );
};
