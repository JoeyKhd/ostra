"use client";

import { HistoryIcon, LayersIcon, ListChecksIcon, PlayIcon, SlidersHorizontalIcon, SquareIcon, SquarePlayIcon, UserRoundIcon } from "lucide-react";
import type { ReactNode } from "react";

import { t } from "@/lib/messages";

import { useTaskContext } from "../task-context";
import { dividerWords } from "./words";
import type { DividerInput } from "./words";

// Owner: ticket 12 (milestone 10, F-151: a divider, parts.md part 12). A change a reader needs
// between turns, centred, 13px `--faint`, a 14px icon 8px before its words, and a 1px `--line` rule
// to each side, 18px above and below: the day (mono 12px, no icon), how a session came back, the
// plan turn's and the build turn's markers, a new driver, a level change and a stop with their
// times. Bookkeeping is never one: a runner connecting, a box idling out, a release, a save.

const iconOf = (divider: DividerInput): ReactNode => {
  switch (divider.kind) {
    case "day":
      return null;
    case "restored":
      return divider.event.origin === "resumed" ? <SquarePlayIcon /> : divider.event.origin === "rebuilt" ? <LayersIcon /> : <HistoryIcon />;
    case "plan-turn":
    case "plan-again":
      return <ListChecksIcon />;
    case "build-turn":
      return <PlayIcon />;
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

/** The words with the runner's name in mono (`… on alex-desktop · …`). */
const WithRunner = ({ text, runner }: { readonly text: string; readonly runner: string }) => {
  const at = text.indexOf(runner);
  return at === -1 ? (
    text
  ) : (
    <>
      {text.slice(0, at)}
      <span className="font-mono text-xs">{runner}</span>
      {text.slice(at + runner.length)}
    </>
  );
};

export const Divider = ({ divider, now }: { readonly divider: DividerInput; readonly now: number }) => {
  const { memberName, agent } = useTaskContext();
  const words = dividerWords(divider, t, { nameOf: memberName, agent: agent.name, now });
  const day = divider.kind === "day";
  return (
    <div
      role="separator"
      aria-label={words.time === null ? words.text : `${words.text} ${words.time}`}
      data-part="divider"
      data-divider={divider.kind}
      className="my-[18px] flex items-center gap-2.5 whitespace-nowrap text-sm text-faint before:h-px before:min-w-6 before:flex-1 before:bg-line after:h-px after:min-w-6 after:flex-1 after:bg-line"
    >
      <span className="inline-flex min-w-0 items-center gap-2 [&_svg]:size-[14px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75]">
        {iconOf(divider)}
        <span className={day ? "font-mono text-xs" : "min-w-0 truncate"}>{divider.kind === "restored" && divider.runner !== null ? <WithRunner text={words.text} runner={divider.runner} /> : words.text}</span>
        {words.time === null ? null : <span className="font-mono text-xs">{words.time}</span>}
      </span>
    </div>
  );
};
