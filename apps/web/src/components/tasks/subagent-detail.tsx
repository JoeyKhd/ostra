"use client";

import { useState } from "react";
import type { ReactNode } from "react";

import type { SubagentNode, SubagentRound, TaskToolPart } from "@ostra/task-view";

import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { AgentMarkdown, ApprovalNote, SubagentRow, ToolBody } from "@/task/renderers";
import { useSubagentStartedBy } from "@/task/task-context";

import { Spinner, StateMark, stateTone } from "./subagent-marks";
import { callCount, nodeDurationMs, shortDuration, stateWord, subagentLabel } from "./subagent-words";

// F-138: the detail pane of the subagents window (task-subagents-tree.md, "The detail pane"): the
// selected subagent's type and state, its description, its time and calls, what it was asked and
// by whom, its calls as the thread's tool rows one step quieter, and its answer. For the main
// agent, the turn: the member's message, and the agent's own calls.

/** Past this, a prompt shows its first lines and `Show all`. */
const PROMPT_LINES = 6;
const PROMPT_CHARS = 480;
/** Past this, the calls show the last ones and `Show {n} earlier calls`. */
const CALLS_SHOWN = 40;

const Label = ({ children }: { readonly children: ReactNode }) => <h3 className="mb-1 mt-5 text-xs font-medium text-faint">{children}</h3>;

/** The clock with seconds: `14:04:12`. */
const clockSeconds = (at: number): string => `${formatClock(at)}:${String(new Date(at).getSeconds()).padStart(2, "0")}`;

/** What it was asked: markdown, its first lines until `Show all`. */
const Prompt = ({ text }: { readonly text: string }) => {
  const [all, setAll] = useState(false);
  const long = text.split("\n").length > PROMPT_LINES || text.length > PROMPT_CHARS;
  if (text.trim() === "") return <p className="text-[13.5px] text-faint">{t("task.subagents.noPrompt")}</p>;
  return (
    <div data-part="subagent-prompt">
      <AgentMarkdown text={text} className={cn("text-[13.5px] text-muted", long && !all && "line-clamp-6")} />
      {long ? (
        <button type="button" className="mt-1 text-xs text-teal hover:underline" onClick={() => { setAll((open) => !open); }}>
          {all ? t("task.subagents.showLess") : t("task.subagents.showAll")}
        </button>
      ) : null}
    </div>
  );
};

/** One call, as the thread draws it, a step quieter; a call that started a subagent selects it. */
const Call = ({ part, asker, onSelect }: { readonly part: TaskToolPart; readonly asker: string | undefined; readonly onSelect: (id: string) => void }) => {
  const started = useSubagentStartedBy(part.toolCallId);
  if (started !== undefined) {
    return <SubagentRow node={started.node} popup={false} compact onOpen={() => { onSelect(started.node.id); }} />;
  }
  return (
    <div data-part="tool" data-tool-kind={part.type === "dynamic-tool" ? part.toolName : part.type.slice(5)} data-state={part.state}>
      <ToolBody part={part} />
      <ApprovalNote part={part} {...(asker === undefined ? {} : { asker })} />
    </div>
  );
};

export const Calls = ({ calls, asker, onSelect }: { readonly calls: readonly TaskToolPart[]; readonly asker: string | undefined; readonly onSelect: (id: string) => void }) => {
  const [all, setAll] = useState(false);
  const hidden = all ? 0 : Math.max(0, calls.length - CALLS_SHOWN);
  if (calls.length === 0) return <p className="text-[13px] text-faint">{t("task.subagents.noCalls")}</p>;
  return (
    <div data-part="subagent-calls" className="[&_[data-verb]]:text-faint">
      {hidden === 0 ? null : (
        <button type="button" className="mb-1 text-xs text-teal hover:underline" onClick={() => { setAll(true); }}>
          {plural(hidden, "task.subagents.earlierCalls.one", "task.subagents.earlierCalls.other")}
        </button>
      )}
      {calls.slice(hidden).map((part) => (
        <Call key={part.toolCallId} part={part} asker={asker} onSelect={onSelect} />
      ))}
    </div>
  );
};

/** Its answer, or why there is none yet: a running one's words aren't its answer until it's done. */
const Answer = ({ node, round, last }: { readonly node: SubagentNode; readonly round: SubagentRound; readonly last: boolean }) => {
  const answer = round.answer === null ? null : <AgentMarkdown text={round.answer} className="text-[13.5px] text-text" />;
  if (!last) return answer;
  switch (node.state) {
    case "running":
    case "needs-approval":
      return <p className="text-[13px] text-faint">{t("task.subagents.stillWorking")}</p>;
    case "done":
      return answer;
    case "failed":
      return (
        <>
          {node.error === undefined ? null : <p className="whitespace-pre-wrap text-[13px] text-red">{node.error}</p>}
          <p className="text-[13px] text-faint">{t("task.subagents.failedBefore")}</p>
        </>
      );
    case "stopped":
      return answer ?? <p className="text-[13px] text-faint">{t("task.subagents.stoppedBefore")}</p>;
    default:
      return node.state satisfies never;
  }
};

export const SubagentDetail = ({
  node,
  parentName,
  agentName,
  now,
  onSelect,
}: {
  readonly node: SubagentNode;
  /** Who asked it: the main agent's name, or the parent subagent's description. */
  readonly parentName: string;
  readonly agentName: string;
  readonly now: number;
  readonly onSelect: (id: string) => void;
}) => {
  const ms = nodeDurationMs(node, now);
  const asker = subagentLabel(node);
  const rounds = node.rounds;
  return (
    <div data-testid="subagent-detail" data-subagent={node.id}>
      <div className="flex items-center gap-2">
        {node.type === null ? null : (
          <span className="inline-flex h-5 items-center rounded-[4px] border border-line-2 px-1.5 font-mono text-[11.5px] text-text">{node.type}</span>
        )}
        <span className={cn("inline-flex items-center gap-1.5 text-[13px]", stateTone(node.state))}>
          {node.state === "running" ? <Spinner size={11} /> : <StateMark state={node.state} />}
          {stateWord(node.state)}
        </span>
      </div>
      <h2 className="mt-2 text-base font-semibold text-text">{node.description === "" ? asker : node.description}</h2>
      <p className="mt-1 font-mono text-xs text-faint">
        {node.startedAt === null ? callCount(node.callCount) : t("task.subagents.started", { time: clockSeconds(node.startedAt), duration: ms === null ? "–" : shortDuration(ms), calls: callCount(node.callCount) })}
      </p>
      {node.orphan ? <p className="mt-2 text-[13px] text-faint">{t("task.subagents.orphan", { agent: agentName })}</p> : null}
      {rounds.map((round, index) => {
        const last = index === rounds.length - 1;
        return (
          <section key={round.toolCallId ?? `round-${String(index)}`} data-round={index + 1}>
            {rounds.length > 1 ? (
              <p className="mt-5 border-t border-line pt-3 font-mono text-xs text-faint">
                {t("task.subagents.round", { n: index + 1, time: round.askedAt === null ? "–" : formatClock(round.askedAt) })}
              </p>
            ) : null}
            <Label>{t("task.subagents.askedBy", { name: parentName })}</Label>
            <Prompt text={round.prompt} />
            <Label>{t("task.subagents.callsLabel")}</Label>
            <Calls calls={round.calls} asker={asker} onSelect={onSelect} />
            <Label>{t("task.subagents.answer")}</Label>
            <div data-part="subagent-answer">
              <Answer node={node} round={round} last={last} />
            </div>
          </section>
        );
      })}
    </div>
  );
};

/** The main agent's pane: the turn, what the member asked, and the agent's own calls (no answer: the thread is it). */
export const RootDetail = ({
  agent,
  state,
  startedAt,
  duration,
  calls,
  asked,
  onSelect,
}: {
  readonly agent: string;
  readonly state: "running" | "ended" | "failed";
  readonly startedAt: number | null;
  readonly duration: string;
  readonly calls: readonly TaskToolPart[];
  readonly asked: { readonly name: string; readonly text: string } | null;
  readonly onSelect: (id: string) => void;
}) => (
  <div data-testid="subagent-detail" data-subagent="root">
    <div className="flex items-center gap-2">
      <span className="inline-flex h-5 items-center rounded-[4px] border border-line-2 px-1.5 font-mono text-[11.5px] text-text">{t("task.subagents.mainAgent")}</span>
      <span className={cn("inline-flex items-center gap-1.5 text-[13px]", state === "running" ? "text-teal" : state === "failed" ? "text-red" : "text-green")}>
        {state === "running" ? <Spinner size={11} /> : <span aria-hidden className={cn("size-[7px] rounded-full", state === "failed" ? "bg-red" : "bg-green")} />}
        {t(`task.subagents.turnState.${state}`)}
      </span>
    </div>
    <h2 className="mt-2 text-base font-semibold text-text">{agent}</h2>
    <p className="mt-1 font-mono text-xs text-faint">
      {startedAt === null ? callCount(calls.length) : t("task.subagents.started", { time: clockSeconds(startedAt), duration, calls: callCount(calls.length) })}
    </p>
    {asked === null ? null : (
      <>
        <Label>{t("task.subagents.askedBy", { name: asked.name })}</Label>
        <p className="whitespace-pre-wrap text-[13.5px] text-muted">{asked.text}</p>
      </>
    )}
    <Label>{t("task.subagents.callsLabel")}</Label>
    <Calls calls={calls} asker={undefined} onSelect={onSelect} />
  </div>
);
