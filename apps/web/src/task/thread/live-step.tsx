"use client";

import { ChevronRightIcon, PauseIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";

import type { LiveStep, RunItem, RunStep, TaskUIMessage } from "@ostra/task-view";

import { SubagentsBadge } from "@/components/tasks/subagents-badge";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { useTaskContext } from "../task-context";
import { isRunOpen, useRunOpen } from "./run-open";
import { RunSteps } from "./run-steps";
import { Segments } from "./segments";
import { askingStepWords, liveStepWords } from "./words";

// Owner: ticket 11 (milestone 10, F-151: the live step, parts.md part 5). While a turn runs, its
// open run is this one line, in the place its run's line will take: a 12px spinner (a still ring
// with reduced motion), what the agent does now in `--text-2` with its subject mono, the turn's
// progress in `--faint` (`8 steps done, 1 failed`, red only on `failed`; the plan step; the clock
// from the turn's start, ticking each second), a chevron, and milestone 7's subagents badge while
// the run has any. It's a button that opens the run so far (ticket 10's opened run, which stays open
// once the run closes into its line). Its words are a polite live region that speaks a new step at most
// once every 10 s, never the clock.

/** A screen reader hears the live step at most this often (parts.md, "Keyboard and screen readers"). */
export const ANNOUNCE_GAP_MS = 10_000;

/** The clock and timers the announcer reads: the browser's, or a test's fake ones (spec section 9, "Time"). */
export type AnnounceTimers<Handle> = {
  readonly now: () => number;
  readonly set: (run: () => void, ms: number) => Handle;
  readonly clear: (handle: Handle) => void;
};

/** When a live step last spoke. One for the page: the live step that starts under new prose waits its turn too. */
export type AnnounceGate = { last: number | null };

export type Announcer = {
  /** The live step's words now (never the clock): spoken at once, or once 10 s have passed since the last; only the newest waits. */
  readonly words: (words: string) => void;
  readonly stop: () => void;
};

/** The live region's throttle: a new step is said once, a tick says nothing, and nothing is said twice within 10 s. */
export const createAnnouncer = <Handle,>(say: (words: string) => void, timers: AnnounceTimers<Handle>, gate: AnnounceGate): Announcer => {
  let said: string | null = null;
  let newest: string | null = null;
  let waiting: { readonly handle: Handle } | null = null;
  const flush = (): void => {
    waiting = null;
    if (newest === null || newest === said) return;
    said = newest;
    gate.last = timers.now();
    say(said);
  };
  return {
    words: (words) => {
      newest = words;
      if (waiting !== null || words === said) return;
      const wait = gate.last === null ? 0 : gate.last + ANNOUNCE_GAP_MS - timers.now();
      if (wait <= 0) flush();
      else waiting = { handle: timers.set(flush, wait) };
    },
    stop: () => {
      if (waiting !== null) timers.clear(waiting.handle);
      waiting = null;
    },
  };
};

const pageGate: AnnounceGate = { last: null };
const browserTimers: AnnounceTimers<ReturnType<typeof setTimeout>> = {
  now: () => Date.now(),
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => { clearTimeout(handle); },
};

/** What the live region holds: the newest step the announcer let through; empty until it mounts. */
const useAnnouncement = (words: string): string => {
  const [said, setSaid] = useState("");
  const announcer = useRef<Announcer | null>(null);
  useEffect(() => {
    const made = createAnnouncer(setSaid, browserTimers, pageGate);
    announcer.current = made;
    return () => {
      made.stop();
      announcer.current = null;
    };
  }, []);
  useEffect(() => { announcer.current?.words(words); }, [words]);
  return said;
};

/** The time now, each second: the live step's clock. `fixed` holds it still (a still render). */
const useSecond = (fixed: number | undefined): number => {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return undefined;
    const timer = setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { clearInterval(timer); };
  }, [fixed]);
  return fixed ?? now;
};

/** The line's box: as a run's line (28px, `padding: 0 6px`, pulled 6px left so its words line up with the prose), 14px `--text-2`. */
const LINE = "my-1.5 -ml-1.5 flex min-h-7 w-fit max-w-full items-center gap-2 whitespace-nowrap rounded-sm px-1.5 text-ui text-text-2";

/**
 * The step whose approval waits, where the live step was (choice 9, parts.md part 5): still, with
 * `pause` in the spinner's place, `Wants to run {command}` and amber `needs approval`. Its block
 * (milestone 3's card, ticket 13) follows it.
 */
export const AskingStepLine = ({ step }: { readonly step: RunStep }) => (
  <div data-part="asking-line" className={LINE}>
    <PauseIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-muted" />
    {/* The trailing space keeps the words apart in the text a screen reader reads; the gap draws it. */}
    <span className="min-w-0 truncate"><Segments segments={askingStepWords(step, t)} mono="font-mono text-[13.5px] text-text" />{" "}</span>
    <span className="shrink-0 text-sm font-medium text-amber-text">{t("task.doing.needsApproval")}</span>
  </div>
);

export const LiveStepLine = ({ live, now: fixedNow, steps = null }: {
  readonly live: LiveStep;
  readonly now?: number;
  /** The run so far, which the line opens in place; `null` when the turn is in no run (it writes, under its prose). */
  readonly steps?: { readonly run: RunItem; readonly message: TaskUIMessage } | null;
}) => {
  const now = useSecond(fixedNow);
  const words = liveStepWords(live, t, now);
  const announced = useAnnouncement(words.announcement);
  // What's open is the thread's (ticket 10's `run-open.ts`): the run opened here stays open once it closes into its line.
  const { state, store } = useRunOpen();
  const { openSubagents } = useTaskContext();
  if (live.waiting !== null) {
    return (
      <div data-part="live-step">
        <AskingStepLine step={live.waiting} />
      </div>
    );
  }
  // The plan step's entry gives way first when the line is long (parts.md part 5): it's drawn apart
  // from the steps done and the clock, which stay whole.
  const plan = live.planStep === null ? [] : liveStepWords({ ...live, done: 0 }, t, now).progress;
  const progress = live.planStep === null ? words.progress : liveStepWords({ ...live, planStep: null }, t, now).progress;
  const facts = [
    ...(plan.length === 0 ? [] : [<span key="plan" className="min-w-0 truncate"><Segments segments={plan} mono="font-mono text-[12.5px]" /></span>]),
    ...(progress.length === 0 ? [] : [<span key="steps" className="shrink-0"><Segments segments={progress} /></span>]),
    ...(words.clock === null ? [] : [<span key="clock" className="shrink-0 font-mono text-[12.5px]" data-part="live-clock">{words.clock}</span>]),
  ];
  const line = (
    <>
      <span aria-hidden className="size-3 shrink-0 animate-spin rounded-full border-[1.75px] border-line-2 border-t-teal motion-reduce:animate-none" />
      {/* The trailing space keeps the words apart in the button's name; the gap draws it. */}
      <span className={plan.length === 0 ? "min-w-0 truncate" : "shrink-0"} data-part="live-doing"><Segments segments={words.doing} mono="font-mono text-[13.5px] text-text" />{" "}</span>
      {facts.length === 0 ? null : (
        <span className={cn("flex min-w-0 items-baseline text-faint", plan.length === 0 && "shrink-0")}>
          {facts.map((fact, index) => (
            <Fragment key={fact.key}>
              <span className="shrink-0 whitespace-pre">{index === 0 ? "· " : " · "}</span>
              {fact}
            </Fragment>
          ))}
        </span>
      )}
    </>
  );
  if (steps === null) {
    return (
      <div data-part="live-step">
        <div className={LINE}>{line}</div>
        <span className="sr-only" aria-live="polite" aria-atomic="true" data-part="live-announcement">{announced}</span>
      </div>
    );
  }
  const { run, message } = steps;
  const open = isRunOpen(state, run);
  const listId = `steps-${run.id}`;
  return (
    <div data-part="live-step" data-open={open ? "true" : "false"}>
      <div className="my-1.5 -ml-1.5 flex min-h-7 max-w-full items-center">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          data-part="live-line"
          onClick={() => { store.toggleRun(run); }}
          className="flex min-h-7 min-w-0 max-w-full items-center gap-2 whitespace-nowrap rounded-sm px-1.5 text-left text-ui text-text-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-teal"
        >
          {line}
          <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 text-faint", open && "rotate-90")} />
        </button>
        {/* Milestone 7's badge, as on the run's line: the subagents window stays one press away while they run. */}
        {run.subagents === null || openSubagents === undefined ? null : (
          <SubagentsBadge counts={run.subagents} onOpen={() => { openSubagents(message.id, null); }} className="ml-1.5" />
        )}
      </div>
      <span className="sr-only" aria-live="polite" aria-atomic="true" data-part="live-announcement">{announced}</span>
      {open ? <RunSteps run={run} message={message} id={listId} /> : null}
    </div>
  );
};
