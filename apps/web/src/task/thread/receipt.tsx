"use client";

import { CheckIcon } from "lucide-react";

import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import { useTaskContext } from "../task-context";
import { Segments } from "./segments";
import { receiptWords } from "./words";
import type { ReceiptInput } from "./words";

// Owner: ticket 12 (milestone 10, F-151: a receipt, parts.md part 12). Ticket 09's stub, with its
// final props: a settled need in its block's place, 28px, 14px `--muted`, `check`, the words with
// the chosen value in `--text-2` and the time. Ticket 12 adds the teal link when there's more
// (`Show the plan ›`).

export const Receipt = ({ receipt, at }: { readonly receipt: ReceiptInput; readonly at: number | null }) => {
  const { memberName } = useTaskContext();
  const words = receiptWords(receipt, t, memberName);
  if (words === null) return null;
  return (
    <div data-part="receipt" data-receipt={receipt.kind} className="mb-1.5 mt-1 flex min-h-7 items-center gap-2 whitespace-nowrap text-ui text-muted">
      {words.settled ? <CheckIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint" /> : null}
      <span className="min-w-0 truncate"><Segments segments={words.words} /></span>
      {at === null ? null : <span className="shrink-0 font-mono text-[12.5px] text-faint">{formatClock(at)}</span>}
    </div>
  );
};
