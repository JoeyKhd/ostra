"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from "react";

import type { TaskUIMessage } from "@ostra/task-view";

import { usePhone } from "@/components/tasks/take-it-local";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import { useThreadParts } from "./thread-context";
import { eventLogLinkWords, footerFacts, tooltipRows } from "./words";
import type { TooltipRow, TooltipWords } from "./words";

// Owner: ticket 16 (milestone 10, F-151: the turn's numbers, parts.md parts 6 and 9, the README's
// choices 1 and 2). A turn's numbers live in the opened run's footer and in a tooltip on the turn's
// time, never as a line of the column. The footer is the phone's way to them: there the time is
// plain text, with no tooltip.

/**
 * The opened run's last row (parts.md part 6): the turn's number, its level, tokens, reasoning,
 * spend and what it saved, mono `--faint`, each fact kept whole when the row wraps, and at its right
 * `Event log ›` to the turn's first event (on a phone, on a line of its own). The clamp's fact
 * carries its sentence as a tooltip.
 */
export const RunFooter = ({ message }: { readonly message: TaskUIMessage }) => {
  const { taskKind } = useThreadParts();
  const meta = message.metadata;
  if (meta === undefined) return null;
  const facts = footerFacts(meta, taskKind, t);
  return (
    <div data-part="run-footer" className="mt-1 flex min-h-[30px] items-center gap-2.5 border-t border-line py-0.5 font-mono text-xs text-faint max-sm:flex-col max-sm:items-start max-sm:gap-0 max-sm:pt-1.5">
      <span data-part="footer-facts" className="min-w-0 leading-[18px]">
        {facts.map((fact, index) => {
          const last = index === facts.length - 1;
          // A fact and the ` ·` after it never part: the row breaks only at the space between two facts.
          return (
            <Fragment key={index}>
              <span className="whitespace-nowrap">
                <span data-part="footer-fact" title={fact.tip ?? undefined}>{fact.text}</span>
                {last ? null : " ·"}
              </span>
              {last ? null : " "}
            </Fragment>
          );
        })}
      </span>
      <Link href={`?tab=events&seq=${String(meta.firstSeq)}`} className="ml-auto inline-flex shrink-0 items-center gap-0.5 font-sans text-[12.5px] text-teal hover:underline max-sm:ml-0 max-sm:h-7">
        {eventLogLinkWords(t)}
        <ChevronRightIcon aria-hidden className="size-[13px]" />
      </Link>
    </div>
  );
};

/** How long the pointer rests on the time before its tooltip shows (parts.md part 9). */
export const TIP_HOVER_MS = 300;
/** How long the pointer has to cross from the time to its tooltip before it closes (WCAG 1.4.13: the tooltip can be hovered). */
export const TIP_LEAVE_MS = 150;

/** The timers the tooltip waits on: the browser's, or a test's fake ones (spec section 9, "Time"). */
export type TipTimers<Handle> = {
  readonly set: (run: () => void, ms: number) => Handle;
  readonly clear: (handle: Handle) => void;
};

/** What happens to the time: the pointer comes and goes (on the time or its tooltip), the focus comes and goes, Escape. */
export type TipControl = {
  readonly enter: () => void;
  readonly leave: () => void;
  readonly focus: () => void;
  readonly blur: () => void;
  readonly escape: () => void;
  readonly stop: () => void;
};

/**
 * When the time's tooltip shows: after 300 ms of the pointer on the time, at once on focus. It stays
 * while the pointer is on the time or its tooltip, or the focus is on the time; Escape closes it
 * until the pointer or the focus comes back.
 */
export const createTipControl = <Handle,>(show: (open: boolean) => void, timers: TipTimers<Handle>): TipControl => {
  let open = false;
  let hovered = false;
  let focused = false;
  let wait: { readonly handle: Handle } | null = null;
  let grace: { readonly handle: Handle } | null = null;
  const cancel = (): void => {
    if (wait !== null) timers.clear(wait.handle);
    if (grace !== null) timers.clear(grace.handle);
    wait = null;
    grace = null;
  };
  const set = (next: boolean): void => {
    if (next === open) return;
    open = next;
    show(next);
  };
  return {
    enter: () => {
      hovered = true;
      if (grace !== null) timers.clear(grace.handle);
      grace = null;
      if (open || wait !== null) return;
      wait = {
        handle: timers.set(() => {
          wait = null;
          set(true);
        }, TIP_HOVER_MS),
      };
    },
    leave: () => {
      hovered = false;
      if (wait !== null) timers.clear(wait.handle);
      wait = null;
      if (!open || focused || grace !== null) return;
      grace = {
        handle: timers.set(() => {
          grace = null;
          if (!hovered && !focused) set(false);
        }, TIP_LEAVE_MS),
      };
    },
    focus: () => {
      focused = true;
      cancel();
      set(true);
    },
    blur: () => {
      focused = false;
      if (hovered) return;
      cancel();
      set(false);
    },
    escape: () => {
      cancel();
      set(false);
    },
    stop: cancel,
  };
};

const browserTimers: TipTimers<ReturnType<typeof setTimeout>> = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => { clearTimeout(handle); },
};

/** The space between the time and its tooltip. */
const TIP_GAP = 13;

/** The top of what clips the time: its nearest scrolling box (the thread), else the window's. */
const clipTopOf = (element: HTMLElement): number => {
  for (let box = element.parentElement; box !== null; box = box.parentElement) {
    if (/(auto|scroll|hidden)/.test(getComputedStyle(box).overflowY)) return Math.max(0, box.getBoundingClientRect().top);
  }
  return 0;
};

/** A row's value, its figure in mono `--text-2`. */
const RowValue = ({ row }: { readonly row: TooltipRow }) => {
  const at = row.figure === null ? -1 : row.value.indexOf(row.figure);
  if (row.figure === null || at === -1) return <span className="min-w-0">{row.value}</span>;
  return (
    <span className="min-w-0">
      {row.value.slice(0, at)}
      <span className="font-mono text-xs text-text-2">{row.figure}</span>
      {row.value.slice(at + row.figure.length)}
    </span>
  );
};

/**
 * The tooltip (parts.md part 9): 268px on `--raise`, the head in `--text` 500, then `74px key |
 * value` rows. It's in the page only while it shows, so its numbers are never the column's text.
 */
export const TurnTip = ({ id, tip, below = false, box }: { readonly id: string; readonly tip: TooltipWords; readonly below?: boolean; readonly box?: Ref<HTMLSpanElement> }) => (
  <span
    ref={box}
    id={id}
    role="tooltip"
    data-part="turn-tip"
    data-place={below ? "below" : "above"}
    className={cn(
      "absolute left-[-10px] z-30 w-[268px] whitespace-normal rounded-lg border border-line-2 bg-raise px-[11px] pb-[9px] pt-2 text-left font-sans text-[12.5px] leading-[1.5] text-muted shadow-(--shadow-pop)",
      below ? "top-[calc(100%+13px)]" : "bottom-[calc(100%+13px)]",
    )}
  >
    <span data-part="tip-head" className="mb-[3px] block font-medium text-text">{tip.head}</span>
    {tip.rows.map((row) => (
      <span key={row.key} data-part="tip-row" className="grid grid-cols-[74px_minmax(0,1fr)] gap-x-2.5">
        <span className="text-faint">{row.key}</span>
        <RowValue row={row} />
      </span>
    ))}
  </span>
);

/**
 * The turn's time on its first line (parts.md parts 4 and 9, the README's choice 2):
 * `formatClock(meta.at)` in mono `--faint`. It's focusable, draws a dotted `--line-3` underline on
 * hover and focus, and holds the turn's numbers in a tooltip: after 300 ms of hover, at once on
 * focus, above the time (below when there's no room), closed by Escape. On a phone it's plain text
 * with no tooltip: the opened run's footer is the way in (`s6.md`).
 */
export const TurnTime = ({ message }: { readonly message: TaskUIMessage }) => {
  const { taskKind } = useThreadParts();
  const phone = usePhone();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [below, setBelow] = useState(false);
  const time = useRef<HTMLSpanElement>(null);
  const tipBox = useRef<HTMLSpanElement>(null);
  const control = useMemo(() => createTipControl(setOpen, browserTimers), []);
  useEffect(() => () => { control.stop(); }, [control]);
  // Escape closes it wherever the focus is (WCAG 1.4.13: dismissible without moving the pointer).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") control.escape();
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); };
  }, [open, control]);
  // Above the time, unless what clips the thread leaves it no room there.
  useLayoutEffect(() => {
    if (!open || time.current === null || tipBox.current === null) return;
    setBelow(time.current.getBoundingClientRect().top - TIP_GAP - tipBox.current.offsetHeight < clipTopOf(time.current));
  }, [open]);
  const meta = message.metadata;
  if (meta?.at === undefined) return null;
  const clock = formatClock(meta.at);
  if (phone) return <span data-part="turn-time" className="ml-1 shrink-0 font-mono text-[12.5px] text-faint">{clock}</span>;
  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    control.escape();
  };
  return (
    <span className="relative ml-1 inline-flex shrink-0" onMouseEnter={control.enter} onMouseLeave={control.leave}>
      <span
        ref={time}
        data-part="turn-time"
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        onFocus={control.focus}
        onBlur={control.blur}
        onKeyDown={onKeyDown}
        className={cn(
          "rounded-sm font-mono text-[12.5px] text-faint decoration-line-3 decoration-dotted underline-offset-[3px] hover:underline focus-visible:underline",
          open && "underline",
        )}
      >
        {clock}
      </span>
      {open ? <TurnTip id={id} tip={tooltipRows(meta, taskKind, t)} below={below} box={tipBox} /> : null}
    </span>
  );
};
