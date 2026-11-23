"use client";

import {
  BrainIcon,
  CheckIcon,
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
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import type { RunItem, RunStep, TaskUIMessage } from "@ostra/task-view";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { useTaskContext } from "../task-context";
import { holdsStep, useRunOpen } from "./run-open";
import { Segments, toneClass } from "./segments";
import { StepOutput } from "./step-output";
import { RunFooter } from "./turn-numbers";
import { stepWords } from "./words";
import type { Segment } from "./words";

// Owner: ticket 10 (milestone 10, F-151: a run, opened, parts.md part 6). The run's steps under its
// line, in order, as a list on the strict `22px icon | 72px verb | subject` grid, 28px a row: the
// subject one line (the full value in `title`), then inline, 10px apart, its result, an answered
// approval's receipt and the teal link that opens one more level (`step-output.tsx`). The turn's
// footer (ticket 16's) is its last row.

/** A step's 14px icon, by its kind; a running step turns a spinner in its place. */
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

/**
 * How a step's subject reads: a path or a command line in mono 13.5px `--text-2`; words in sans
 * 13.5px `--muted` with their mono parts 13px `--text-2` (a capture, a subagent, a search); a
 * thought's excerpt in sans `--faint`.
 */
const subjectStyle = (step: RunStep): { readonly box: string; readonly mono: string } => {
  switch (step.kind) {
    case "read":
    case "edit":
    case "command":
    case "fetch":
    case "tool":
      return { box: "font-mono text-[13.5px] text-text-2", mono: "" };
    case "thought":
      return { box: "text-[13.5px] text-faint", mono: "font-mono text-[13px]" };
    case "search":
    case "web-search":
    case "capture":
    case "subagent":
    case "setup":
    case "pr-text":
    case "ostra":
    case "compaction":
    case "info":
      return { box: "text-[13.5px] text-muted", mono: "font-mono text-[13px]" };
    default:
      return step satisfies never;
  }
};

/**
 * A step's result in mono 12.5px: its parts in their tones, the space before a ` · ` and between
 * two results 10px as the targets set them (a mono space is 7.5px), 6px between an edit's `+a` and
 * `−d`; `✓ exit 0` with a 12px check.
 */
const Result = ({ segments, tight }: { readonly segments: readonly Segment[]; readonly tight: boolean }) => (
  <span data-part="step-result" className="shrink-0 whitespace-pre font-mono text-[12.5px] text-faint">
    {segments.map((segment, index) => {
      if (segment.text === " · " || segment.text === " ") {
        return <span key={index} className={segment.text === " " && tight ? "-ml-[1.5px]" : "ml-[2.5px]"}>{segment.text}</span>;
      }
      if (!segment.text.startsWith("✓ ")) return <span key={index} className={toneClass(segment.tone)}>{segment.text}</span>;
      return (
        <span key={index} className={cn("inline-flex items-center gap-[3px]", toneClass(segment.tone))}>
          <CheckIcon aria-hidden className="size-3" />
          <span className="sr-only">✓ </span>
          {segment.text.slice(2)}
        </span>
      );
    })}
  </span>
);

const Spinner = () => <span aria-hidden className="size-[11px] shrink-0 animate-spin rounded-full border-[1.75px] border-line-2 border-t-teal motion-reduce:animate-none" />;

const StepRow = ({ step, message }: { readonly step: RunStep; readonly message: TaskUIMessage }) => {
  const { memberName, openSubagents } = useTaskContext();
  const { state, store } = useRunOpen();
  const link = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLLIElement>(null);
  const shown = [...state.shown].some((id) => holdsStep(step, id));
  const focus = state.focus !== null && holdsStep(step, state.focus);
  useEffect(() => {
    if (!focus) return;
    row.current?.scrollIntoView({ block: "nearest" });
    link.current?.focus({ preventScroll: true });
    store.focused();
  }, [focus, store]);
  const words = stepWords(step, t, memberName, { open: shown, now: Date.now() });
  const style = subjectStyle(step);
  // A subagent that's done ends on a green check (parts.md part 6), its word left for a screen reader.
  const done = step.kind === "subagent" && step.node.state === "done";
  const result = done ? words.result.slice(0, -1).filter((segment, index, all) => index < all.length - 1 || segment.text.trim() !== "") : words.result;
  const end = (
    <>
      {result.length === 0 ? null : step.kind === "ostra" ? (
        // ostra's own tools end on words, not figures: `already submitted, kept as it was`, sans `--faint`.
        <span data-part="step-result" className="shrink-0 text-[13.5px] text-faint"><Segments segments={result} /></span>
      ) : (
        <Result segments={result} tight={step.kind === "edit"} />
      )}
      {done ? (
        <span className="shrink-0 self-center text-green">
          <CheckIcon aria-hidden className="size-3" />
          <span className="sr-only">{t("task.step.subagentState.done")}</span>
        </span>
      ) : null}
      {words.receipt === null ? null : <span className="shrink-0 text-sm text-muted">{words.receipt}</span>}
      {words.link === null ? null : words.link.opens === "subagent" ? (
        step.kind !== "subagent" || openSubagents === undefined ? null : (
          <button type="button" aria-haspopup="dialog" aria-label={words.link.name} onClick={() => { openSubagents(message.id, step.node.id); }} className="inline-flex shrink-0 items-center gap-px text-[12.5px] text-teal hover:underline">
            {words.link.label}
            <ChevronRightIcon aria-hidden className="size-3" />
          </button>
        )
      ) : (
        <button
          ref={link}
          type="button"
          aria-expanded={shown}
          aria-label={words.link.name}
          onClick={() => { store.toggleShown(step); }}
          className="inline-flex shrink-0 items-center gap-px text-[12.5px] text-teal hover:underline"
        >
          {words.link.label}
          <ChevronRightIcon aria-hidden className="size-3" />
        </button>
      )}
    </>
  );
  const quiet = step.kind === "thought";
  // ostra's own tools say what they did as the verb, and milestone 8's info lines are their own words: both run from the verb's column.
  const whole = step.kind === "ostra" || words.verb === null;
  return (
    <li ref={row} data-step={step.kind} data-state={step.state} className="scroll-my-24">
      {/* s6.md: on a phone the verb sits inline before its subject (22px icon | verb | subject, 8px
          gaps), a long subject wraps under itself, and a row is at least 36px tall. */}
      <div className="grid min-h-7 grid-cols-[22px_72px_minmax(0,1fr)] items-center text-ui max-sm:flex max-sm:min-h-9 max-sm:flex-wrap max-sm:items-baseline max-sm:gap-x-2 max-sm:gap-y-0.5">
        <span className="flex items-center text-faint [&_svg]:size-[14px] max-sm:shrink-0" aria-hidden>{step.state === "running" ? <Spinner /> : iconOf(step)}</span>
        {whole ? (
          <span className="col-span-2 flex min-w-0 items-baseline gap-2.5 whitespace-nowrap max-sm:flex-wrap max-sm:whitespace-normal">
            {words.verb === null ? null : <span className="shrink-0 text-muted">{words.verb}</span>}
            {words.subject.length === 0 ? null : <span className={cn("min-w-0 truncate max-sm:break-words max-sm:whitespace-normal", style.box)} title={step.fullSubject}><Segments segments={words.subject} mono={style.mono} /></span>}
            {end}
          </span>
        ) : (
          <>
            <span className={cn("whitespace-nowrap max-sm:shrink-0", quiet ? "text-faint" : "text-muted")}>{words.verb}</span>
            <span className="flex min-w-0 items-baseline gap-2.5 whitespace-nowrap max-sm:flex-1 max-sm:flex-wrap max-sm:whitespace-normal">
              <span data-part="step-subject" className={cn("min-w-0 truncate max-sm:break-words max-sm:whitespace-normal", style.box)} title={step.fullSubject}><Segments segments={words.subject} mono={style.mono} /></span>
              {end}
            </span>
          </>
        )}
      </div>
      {shown && words.link !== null && words.link.opens !== "subagent" ? <StepOutput step={step} opens={words.link.opens} /> : null}
    </li>
  );
};

/** The run's steps under its line, in order, and the turn's footer as its last row. */
export const RunSteps = ({ run, message, id }: { readonly run: RunItem; readonly message: TaskUIMessage; readonly id?: string }) => (
  <div data-part="run-steps" id={id} className="mb-2.5 ml-px border-l border-line-2 pl-3.5 pt-0.5">
    <ul role="list">
      {run.steps.map((step) => <StepRow key={step.id} step={step} message={message} />)}
    </ul>
    <RunFooter message={message} />
  </div>
);
