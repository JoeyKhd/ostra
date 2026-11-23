"use client";

import { HistoryIcon, LayersIcon, ListChecksIcon, SlidersHorizontalIcon, SquareIcon, SquarePlayIcon, UserRoundIcon } from "lucide-react";
import type { ReactNode } from "react";

import { t } from "@/lib/messages";

import { useTaskContext } from "../task-context";
import { dividerWords } from "./words";
import type { DividerInput } from "./words";

// Owner: ticket 12 (milestone 10, F-151: a divider, parts.md part 12). Ticket 09's stub, with its
// final props: a change a reader needs between turns, centred, 13px `--faint`, its icon and a
// `--line` rule to each side. Bookkeeping is never one.

const iconOf = (divider: DividerInput): ReactNode => {
  switch (divider.kind) {
    case "day":
      return null;
    case "restored":
      return divider.event.origin === "resumed" ? <SquarePlayIcon /> : divider.event.origin === "rebuilt" ? <LayersIcon /> : <HistoryIcon />;
    case "plan-turn":
    case "build-turn":
    case "plan-again":
      return <ListChecksIcon />;
    case "driver":
      return <UserRoundIcon />;
    case "effort":
      return <SlidersHorizontalIcon />;
    case "stopped":
      return <SquareIcon />;
    default:
      return divider satisfies never;
  }
};

export const Divider = ({ divider, now }: { readonly divider: DividerInput; readonly now: number }) => {
  const { memberName, agent } = useTaskContext();
  const words = dividerWords(divider, t, { nameOf: memberName, agent: agent.name, now });
  return (
    <div
      data-part="divider"
      data-divider={divider.kind}
      className="my-[18px] flex items-center gap-2.5 whitespace-nowrap text-sm text-faint before:h-px before:min-w-6 before:flex-1 before:bg-line after:h-px after:min-w-6 after:flex-1 after:bg-line [&_svg]:size-[14px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75]"
    >
      {iconOf(divider)}
      <span className={divider.kind === "day" ? "font-mono text-xs" : "min-w-0 truncate"}>{words.text}</span>
      {words.time === null ? null : <span className="font-mono text-xs">{words.time}</span>}
    </div>
  );
};
