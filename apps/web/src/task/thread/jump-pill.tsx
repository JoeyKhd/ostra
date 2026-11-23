"use client";

import { ArrowDownIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";

import type { NeedsYouWaits } from "@/components/ui/needs-you";
import { t } from "@/lib/messages";

import { pillWords } from "./words";
import type { PillNeed } from "./words";

// Owner: ticket 13 (milestone 10, F-151: off screen, the pill, parts.md part 11, the targets'
// choice 12). While every open block that waits on the viewer (`data-waits`: the question, the plan,
// an approval, a reply, any other need; never a watcher's quiet block) is scrolled out of the
// thread's view, the thread's bottom 46px is a solid `--bg` band with an 18px fade above it, and the
// pill sits centred in it: `Needs you · question ↓`, `· plan`, `· approval`, `· 2 approvals`,
// `· reply`, or `Needs you ↓`. Pressing it scrolls the block into view and focuses its first control.
// It goes once a block is in view. The text scrolls behind the band; the composer doesn't move.

/** A block shows enough to be seen once this much of it is in view (its title line), or all of it when it's shorter. */
const SEEN_PX = 32;

/** A box's top and bottom, in the viewport's coordinates. */
export type Span = { readonly top: number; readonly bottom: number };

/** Whether a block is in view: enough of it shows inside the thread's visible part. */
const inView = (block: Span, view: Span): boolean => {
  const shown = Math.min(block.bottom, view.bottom) - Math.max(block.top, view.top);
  return shown >= Math.min(block.bottom - block.top, SEEN_PX);
};

/** What the pill names for the blocks that wait: one kind by its name, approvals counted, a mix as `Needs you`. */
export const pillOf = (waiting: readonly NeedsYouWaits[]): PillNeed | null => {
  const [first] = waiting;
  if (first === undefined) return null;
  if (waiting.some((kind) => kind !== first)) return { kind: "other" };
  switch (first) {
    case "approval":
      return { kind: "approval", count: waiting.length };
    case "question":
    case "plan":
    case "reply":
    case "other":
      return { kind: first };
    default:
      return first satisfies never;
  }
};

const isWaits = (value: string | undefined): value is NeedsYouWaits => value === "question" || value === "plan" || value === "approval" || value === "reply" || value === "other";

/** A block in the thread that waits on its viewer, with what it waits for. */
export type WaitingBlock = { readonly element: HTMLElement; readonly kind: NeedsYouWaits };

/** The blocks in a thread that wait on its viewer, in reading order. */
const waitingBlocks = (root: ParentNode): readonly WaitingBlock[] =>
  [...root.querySelectorAll<HTMLElement>("[data-waits]")].flatMap((element) => {
    const kind = element.dataset["waits"];
    return isWaits(kind) ? [{ element, kind }] : [];
  });

/** What the band shows: the pill's words and the block it brings back, or nothing while a block is in view. */
type Shown = { readonly need: PillNeed; readonly target: HTMLElement } | null;

/** The band's state for the blocks that wait and the thread's visible span. */
export const shownFor = (blocks: readonly WaitingBlock[], view: Span): Shown => {
  if (blocks.some(({ element }) => inView(element.getBoundingClientRect(), view))) return null;
  const need = pillOf(blocks.map(({ kind }) => kind));
  const target = blocks[0]?.element;
  return need === null || target === undefined ? null : { need, target };
};

/** A block's first control: a question's first choice (the chosen one when there is one), else its first button or field, else the block. */
export const firstControlOf = (block: HTMLElement): HTMLElement => {
  const choice = block.querySelector<HTMLElement>("input[type='radio']:checked:not([disabled])") ?? block.querySelector<HTMLElement>("input[type='radio']:not([disabled])");
  if (choice !== null) return choice;
  return block.querySelector<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled])") ?? block;
};

/** The pill's press: the block into view, then the focus on its first control (no second scroll). */
export const jumpTo = (block: HTMLElement, reducedMotion: boolean): void => {
  block.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
  const control = firstControlOf(block);
  if (control === block && !block.hasAttribute("tabindex")) block.setAttribute("tabindex", "-1");
  control.focus({ preventScroll: true });
};

const JumpPill = ({ need, onJump }: { readonly need: PillNeed; readonly onJump: () => void }) => (
  <button
    type="button"
    data-part="jump-pill"
    onClick={onJump}
    className="pointer-events-auto inline-flex h-[30px] items-center gap-2 whitespace-nowrap rounded-[15px] border border-line-2 bg-raise pl-[11px] pr-3 text-[13.5px] font-medium text-text shadow-[var(--shadow-pop)]"
  >
    <span aria-hidden className="size-[7px] rounded-full bg-amber" />
    {pillWords(need, t)}
    <ArrowDownIcon aria-hidden className="size-[14px] stroke-[1.75] text-muted" />
  </button>
);

/** The band's markup: a solid `--bg` band 46px tall, an 18px fade above it, the pill centred. */
export const JumpBandView = ({ need, onJump }: { readonly need: PillNeed; readonly onJump: () => void }) => (
  <div
    data-part="jump-band"
    className="pointer-events-none absolute bottom-0 left-0 right-[2px] z-[4] flex h-[46px] items-center justify-center bg-bg before:pointer-events-none before:absolute before:inset-x-0 before:-top-[18px] before:h-[18px] before:bg-linear-to-b before:from-transparent before:to-bg before:content-['']"
  >
    <JumpPill need={need} onJump={onJump} />
  </div>
);

const sameShown = (a: Shown, b: Shown): boolean =>
  a === b || (a !== null && b !== null && a.target === b.target && pillWords(a.need, t) === pillWords(b.need, t));

/**
 * The band over the thread's bottom, inside the thread's frame (`relative`), as wide as the
 * column. It watches the viewport's scroll, its size and the blocks it holds.
 */
export const JumpBand = ({ viewport }: { readonly viewport: RefObject<HTMLElement | null> }) => {
  const [shown, setShown] = useState<Shown>(null);
  const measure = useCallback(() => {
    const root = viewport.current;
    if (root === null) return;
    const frame = root.getBoundingClientRect();
    const next = shownFor(waitingBlocks(root), { top: frame.top, bottom: frame.bottom });
    setShown((now) => (sameShown(now, next) ? now : next));
  }, [viewport]);
  useEffect(() => {
    const root = viewport.current;
    if (root === null) return;
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    later();
    root.addEventListener("scroll", later, { passive: true });
    const resized = new ResizeObserver(later);
    resized.observe(root);
    const changed = new MutationObserver(later);
    changed.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-waits"] });
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("scroll", later);
      resized.disconnect();
      changed.disconnect();
    };
  }, [viewport, measure]);
  if (shown === null) return null;
  const jump = () => {
    jumpTo(shown.target, window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  };
  return <JumpBandView need={shown.need} onJump={jump} />;
};
