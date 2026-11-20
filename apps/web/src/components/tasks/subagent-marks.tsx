import { CheckIcon, CircleIcon, LoaderCircleIcon, XIcon } from "lucide-react";

import type { SubagentState } from "@ostra/task-view";

import { cn } from "@/lib/cn";

// F-138: a subagent's state mark (task-subagents-tree.md, "A node"): a 7px dot, or Lucide's
// `loader-circle` spinning while it runs (a still ring with reduced motion), a faint ring once it
// was stopped. Amber only for a call that waits on a person, as everywhere else.

/** The spinner: `loader-circle`, spinning; a still ring when the reader asked for less motion. */
export const Spinner = ({ size, className }: { readonly size: number; readonly className?: string | undefined }) => (
  <span aria-hidden className={cn("inline-grid shrink-0 place-items-center text-teal", className)} style={{ width: size, height: size }}>
    <LoaderCircleIcon className="animate-spin stroke-[2] motion-reduce:hidden" style={{ width: size, height: size }} />
    <CircleIcon className="hidden stroke-[2] motion-reduce:block" style={{ width: size, height: size }} />
  </span>
);

/** A node's mark: the dot of its state, the spinner while it runs, the ring once stopped. */
export const StateMark = ({ state, className }: { readonly state: SubagentState; readonly className?: string }) => {
  switch (state) {
    case "running":
      return <Spinner size={9} className={className} />;
    case "done":
      return <span aria-hidden data-mark="done" className={cn("size-[7px] shrink-0 rounded-full bg-green", className)} />;
    case "needs-approval":
      return <span aria-hidden data-mark="needs-approval" className={cn("size-[7px] shrink-0 rounded-full bg-amber shadow-(--dot-amber)", className)} />;
    case "failed":
      return <span aria-hidden data-mark="failed" className={cn("size-[7px] shrink-0 rounded-full bg-red", className)} />;
    case "stopped":
      return <span aria-hidden data-mark="stopped" className={cn("size-[7px] shrink-0 rounded-full border border-faint", className)} />;
    default:
      return state satisfies never;
  }
};

/** The colour of a state's word. */
export const stateTone = (state: SubagentState): string => {
  switch (state) {
    case "running":
      return "text-teal";
    case "needs-approval":
      return "text-amber-text";
    case "failed":
      return "text-red";
    case "done":
      return "text-green";
    case "stopped":
      return "text-faint";
    default:
      return state satisfies never;
  }
};

/** A `Subagent` row's state at its end (task-subagents-badge.md): a check, the spinner, a cross, `stopped`. */
export const RowState = ({ state, word }: { readonly state: SubagentState; readonly word: string }) => {
  switch (state) {
    case "done":
      return <CheckIcon aria-label={word} className="size-[13px] shrink-0 stroke-[1.75] text-green" />;
    case "running":
      return (
        <span className="inline-flex items-center gap-1.5 font-sans text-teal">
          <Spinner size={11} />
          {word}
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 font-sans text-red">
          <XIcon aria-hidden className="size-3 stroke-[1.75]" />
          {word}
        </span>
      );
    case "needs-approval":
      return <span className="font-sans text-amber-text">{word}</span>;
    case "stopped":
      return <span className="font-sans text-faint">{word}</span>;
    default:
      return state satisfies never;
  }
};
