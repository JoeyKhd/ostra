"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";

import type { TaskUIMessage } from "@ostra/task-view";

import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import { useThreadParts } from "./thread-context";
import { eventLogLinkWords, footerFacts, tooltipRows } from "./words";

// Owner: ticket 16 (milestone 10, F-151: the turn's numbers, parts.md parts 6 and 9). Ticket 09's
// stubs, with their final props: the footer's facts and its `Event log ›`, and the turn's time
// with its tooltip's words as a `title` until ticket 16 draws the tooltip.

/**
 * The opened run's last row (parts.md part 6): the turn's number, its level, tokens, reasoning,
 * spend and what it saved, mono `--faint`, and `Event log ›` to the turn's first event.
 */
export const RunFooter = ({ message }: { readonly message: TaskUIMessage }) => {
  const { taskKind } = useThreadParts();
  const meta = message.metadata;
  if (meta === undefined) return null;
  const facts = footerFacts(meta, taskKind, t);
  return (
    <div data-part="run-footer" className="mt-1 flex min-h-[30px] flex-wrap items-center gap-x-2.5 border-t border-line py-0.5 font-mono text-xs text-faint">
      <span className="min-w-0">
        {facts.map((fact, index) => (
          <span key={index} className="whitespace-nowrap" title={fact.tip ?? undefined}>
            {index === 0 ? "" : " · "}
            {fact.text}
          </span>
        ))}
      </span>
      <Link href={`?tab=events&seq=${String(meta.firstSeq)}`} className="ml-auto inline-flex shrink-0 items-center gap-0.5 font-sans text-[12.5px] text-teal hover:underline">
        {eventLogLinkWords(t)}
        <ChevronRightIcon aria-hidden className="size-[13px]" />
      </Link>
    </div>
  );
};

/**
 * The turn's time on its first line (parts.md parts 4 and 9): `formatClock(meta.at)` in mono
 * `--faint`. Ticket 16 makes it focusable with its tooltip.
 */
export const TurnTime = ({ message }: { readonly message: TaskUIMessage }) => {
  const { taskKind } = useThreadParts();
  const meta = message.metadata;
  if (meta?.at === undefined) return null;
  const tip = tooltipRows(meta, taskKind, t);
  const title = [tip.head, ...tip.rows.map((row) => `${row.key}: ${row.value}`)].join("\n");
  return (
    <span data-part="turn-time" title={title} className="ml-1 shrink-0 font-mono text-[12.5px] text-faint">
      {formatClock(meta.at)}
    </span>
  );
};
