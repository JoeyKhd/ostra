"use client";

import {
  BrainIcon,
  ChevronRightIcon,
  FileTextIcon,
  GitPullRequestIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  LayersIcon,
  PencilIcon,
  SearchIcon,
  SquareTerminalIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import type { RunItem, RunStep, TaskUIMessage } from "@ostra/task-view";

import { t } from "@/lib/messages";

import { useTaskContext } from "../task-context";
import { Segments } from "./segments";
import { StepOutput } from "./step-output";
import { RunFooter } from "./turn-numbers";
import { stepWords } from "./words";

// Owner: ticket 10 (milestone 10, F-151: a run, opened, parts.md part 6). Ticket 09's stub, with its
// final props: the run's steps as a list on the `22px icon | 72px verb | subject` grid, each with
// its result and its link, then the turn's footer.

/** A step's 14px icon, by its kind. */
const iconOf = (step: RunStep): ReactNode => {
  switch (step.kind) {
    case "read":
      return <FileTextIcon />;
    case "edit":
      return <PencilIcon />;
    case "command":
      return <TerminalIcon />;
    case "thought":
      return <BrainIcon />;
    case "search":
      return <SearchIcon />;
    case "web-search":
    case "fetch":
      return <GlobeIcon />;
    case "capture":
      return <ImageIcon />;
    case "subagent":
      return <LayersIcon />;
    case "setup":
      return <SquareTerminalIcon />;
    case "pr-text":
      return <GitPullRequestIcon />;
    case "ostra":
    case "tool":
      return <WrenchIcon />;
    case "compaction":
    case "info":
      return <InfoIcon />;
    default:
      return step satisfies never;
  }
};

const StepRow = ({ step }: { readonly step: RunStep }) => {
  const { memberName } = useTaskContext();
  const [open, setOpen] = useState(false);
  const words = stepWords(step, t, memberName, { open, now: Date.now() });
  return (
    <li data-step={step.kind} data-state={step.state}>
      <div className="grid min-h-7 grid-cols-[22px_72px_minmax(0,1fr)] items-center text-ui">
        <span className="flex text-faint [&_svg]:size-[14px] [&_svg]:stroke-[1.75]" aria-hidden>{iconOf(step)}</span>
        <span className="text-muted">{words.verb ?? ""}</span>
        <span className="flex min-w-0 items-baseline gap-2.5 whitespace-nowrap">
          <span className="min-w-0 truncate text-text-2" title={step.fullSubject}><Segments segments={words.subject} mono="font-mono text-[13.5px]" /></span>
          {words.result.length === 0 ? null : <span className="shrink-0 font-mono text-[12.5px] text-faint"><Segments segments={words.result} /></span>}
          {words.receipt === null ? null : <span className="shrink-0 text-sm text-muted">{words.receipt}</span>}
          {words.link === null ? null : (
            <button type="button" aria-expanded={open} aria-label={words.link.name} onClick={() => { setOpen((value) => !value); }} className="inline-flex shrink-0 items-center gap-px text-[12.5px] text-teal hover:underline">
              {words.link.label}
              <ChevronRightIcon aria-hidden className="size-3" />
            </button>
          )}
        </span>
      </div>
      {open && words.link !== null ? <StepOutput step={step} opens={words.link.opens} /> : null}
    </li>
  );
};

/** The run's steps under its line, in order, and the turn's footer as its last row. */
export const RunSteps = ({ run, message }: { readonly run: RunItem; readonly message: TaskUIMessage }) => (
  <div data-part="run-steps" className="mb-2.5 ml-px border-l border-line-2 pl-3.5 pt-0.5">
    <ul role="list">
      {run.steps.map((step) => <StepRow key={step.id} step={step} />)}
    </ul>
    <RunFooter message={message} />
  </div>
);
