"use client";

import { ArrowDownIcon } from "lucide-react";

import { t } from "@/lib/messages";

import { pillWords } from "./words";
import type { PillNeed } from "./words";

// Owner: ticket 13 (milestone 10, F-151: off screen, the pill, parts.md part 11). Ticket 09's stub,
// with its final props: the amber dot, `Needs you · {what}` and `arrow-down`, a button that
// brings the open block back. Ticket 13 puts it on its 46px band, only while the block is out of
// view; until then nothing places it.

export const JumpPill = ({ need, onJump }: { readonly need: PillNeed; readonly onJump: () => void }) => (
  <button
    type="button"
    data-part="jump-pill"
    onClick={onJump}
    className="inline-flex h-[30px] items-center gap-2 whitespace-nowrap rounded-[15px] border border-line-2 bg-raise pl-[11px] pr-3 text-[13.5px] font-medium text-text shadow-[var(--shadow-pop)]"
  >
    <span aria-hidden className="size-[7px] rounded-full bg-amber" />
    {pillWords(need, t)}
    <ArrowDownIcon aria-hidden className="size-[14px] stroke-[1.75] text-muted" />
  </button>
);
