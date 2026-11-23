"use client";

import { Fragment, useMemo } from "react";
import type { ReactNode } from "react";

import { liveStepOf, turnItemsOf } from "@ostra/task-view";
import type { LiveStep, RunStep, TaskUIMessage, TaskUIPart, TurnItem } from "@ostra/task-view";

import { subagentLabel } from "@/components/tasks/subagent-words";

import { ApprovalNote, DataRow, QuestionBlock } from "../renderers";
import { useSubagentOwner, useToolPart } from "../task-context";
import { Captures } from "./captures";
import { Divider } from "./divider";
import { FailureLine, NoticeLine } from "./failure-line";
import { AskingStepLine, LiveStepLine } from "./live-step";
import { PrCard } from "./pr-card";
import { Prose } from "./prose";
import { Receipt } from "./receipt";
import { ResultLine } from "./result-line";
import { RunLine } from "./run-line";
import { useThreadParts } from "./thread-context";

// Owner: ticket 09 (milestone 10, F-151: the rule of the column, parts.md). One message's items,
// in its order, each through its part's component (`turnItemsOf`, ticket 03): the panel draws
// items, never raw parts, so every viewer and test sees the same grouping. Nothing the fold puts
// in a turn is drawn twice, and no part draws a bookkeeping row (ticket 02 took them out).

/** A pending approval's asking step, where the live step was, with its block under it (choice 9). */
const AskingStep = ({ step }: { readonly step: RunStep }) => {
  const part = useToolPart(step.toolCallId ?? "");
  const owner = useSubagentOwner(step.toolCallId ?? "");
  return (
    <div data-part="asking-step">
      <AskingStepLine step={step} />
      {part === undefined ? null : owner === undefined ? <ApprovalNote part={part} /> : <ApprovalNote part={part} asker={subagentLabel(owner.node)} />}
    </div>
  );
};

/**
 * The failed steps a later step of the same kind and subject retried, and that failed too (a
 * fetch's line then doesn't say `not retried`): every failure's own line is a step the turn didn't
 * recover from, so a retry that failed is one of them, later in the turn.
 */
const retriedOf = (items: readonly TurnItem[]): ReadonlySet<string> => {
  const failed = items.flatMap((item) => (item.kind === "failure" && item.failure.cause === "step" ? [item.failure.step] : []));
  return new Set(failed.filter((step, index) => failed.slice(index + 1).some((later) => later.kind === step.kind && later.fullSubject === step.fullSubject)).map((step) => step.id));
};

/** One item, by its part. */
const Item = ({ item, message, live, retried }: { readonly item: TurnItem; readonly message: TaskUIMessage; readonly live: LiveStep | null; readonly retried: ReadonlySet<string> }) => {
  const { ciOf } = useThreadParts();
  switch (item.kind) {
    case "run":
      // The turn is in this run: the live step stands in its line's place until the run closes.
      return item.open && live !== null && live.waiting === null ? <LiveStepLine live={live} steps={{ run: item, message }} /> : <RunLine run={item} message={message} />;
    case "prose":
      return <Prose part={item.part} />;
    case "captures":
      return <Captures attachments={item.attachments} />;
    case "failure":
      return <FailureLine failure={item.failure} retried={item.failure.cause === "step" && retried.has(item.failure.step.id)} />;
    case "notice":
      return <NoticeLine notice={item.notice} />;
    case "result": {
      const { result } = item;
      return result.kind === "pr" ? <PrCard pr={result.pr} ci={ciOf(result.pr.repoId)} /> : <ResultLine result={result} />;
    }
    case "needs": {
      const { need } = item;
      switch (need.kind) {
        case "question":
          return item.open ? <QuestionBlock data={need.question} /> : <Receipt receipt={{ kind: "question", question: need.question }} at={null} />;
        case "approval":
          return <AskingStep step={need.step} />;
        default:
          return need satisfies never;
      }
    }
    default:
      return item satisfies never;
  }
};

/**
 * What a part draws outside the items: a divider (ticket 12), a row milestones 1 to 9 drew that no
 * item holds yet, or nothing (`null`: an item holds it, or it's bookkeeping the Event log keeps).
 */
const rowOf = (part: TaskUIPart, at: number): ReactNode => {
  switch (part.type) {
    case "data-driver":
      return <Divider divider={{ kind: "driver", change: part.data }} now={at} />;
    case "data-effort":
      return <Divider divider={{ kind: "effort", change: part.data }} now={at} />;
    case "data-system": {
      const { event } = part.data;
      if (event.kind === "session.restored") return <Divider divider={{ kind: "restored", event, runner: null }} now={at} />;
      if (event.kind === "turn.cancel_requested") return <Divider divider={{ kind: "stopped", by: event.memberId, at }} now={at} />;
      // A crash and a lost box are failure items; a runner's connection and a config change are the Event log's.
      return null;
    }
    case "data-pr-comment":
    case "data-files-outside":
    case "data-released":
    case "data-ticket-files":
    case "data-unsupported":
    case "data-problem":
      return part.id === undefined ? null : <DataRow id={part.id} />;
    case "text":
    case "reasoning":
    case "file":
    case "source-url":
    case "source-document":
    case "reasoning-file":
    case "custom":
    case "steering-message":
    case "step-start":
    case "dynamic-tool":
    case "tool-read":
    case "tool-edit":
    case "tool-execute":
    case "data-plan":
    case "data-question":
    case "data-compaction":
    case "data-setup":
    case "data-pushed":
    case "data-pr-text":
    case "data-pr":
    case "data-session-end":
    case "data-saved":
    case "data-limit":
    case "data-held":
    case "data-memory-proposed":
    case "data-attachments":
    case "data-attachment-skipped":
    case "data-app-process":
    case "data-no-browser":
    case "data-message-files":
    case "data-review":
    case "data-draft":
      return null;
    default:
      return part satisfies never;
  }
};

/**
 * An agent's turn, or a row outside any turn, as the column's items: its runs, prose, captures,
 * failures, notices, results and what waits on a member, then its live step while it runs.
 */
export const TurnItems = ({ message }: { readonly message: TaskUIMessage }) => {
  const { workspace } = useThreadParts();
  const items = useMemo(() => turnItemsOf(message, workspace), [message, workspace]);
  const live = useMemo(() => liveStepOf(message, workspace), [message, workspace]);
  const retried = useMemo(() => retriedOf(items), [items]);
  const rows = useMemo(() => {
    const at = message.metadata?.at ?? 0;
    return message.parts.flatMap((part, index) => {
      const row = rowOf(part, at);
      return row === null ? [] : [<Fragment key={`${part.type}:${String(index)}`}>{row}</Fragment>];
    });
  }, [message]);
  // A live step with no open run to stand in (the agent writes, or thinks before its first step) follows the items.
  const inRun = items.some((item) => item.kind === "run" && item.open);
  return (
    <>
      {message.metadata?.turnMode === "plan" ? <Divider divider={{ kind: "plan-turn" }} now={message.metadata.at ?? Date.now()} /> : null}
      {rows}
      {items.map((item) => (
        <div key={item.id} data-item={item.id} data-item-kind={item.kind} className="contents">
          <Item item={item} message={message} live={live} retried={retried} />
        </div>
      ))}
      {live !== null && !inRun && live.waiting === null ? <LiveStepLine live={live} /> : null}
    </>
  );
};
