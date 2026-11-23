"use client";

import { CheckIcon, ChevronRightIcon, CircleDotIcon, CircleIcon } from "lucide-react";
import { useContext, useId, useState, useSyncExternalStore } from "react";

import type { AgentMessage } from "@ostra/domain/agent-message";
import { clientMessageIdSchema } from "@ostra/protocol";
import type { PlanEntry, TurnId } from "@ostra/protocol";
import type { QuestionData, TaskDataPart, TaskUIMessage } from "@ostra/task-view";

import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import { useTaskContext } from "../task-context";
import { noAnswers } from "./answers";
import type { ThreadAnswers } from "./answers";
import { Segments } from "./segments";
import { ThreadParts } from "./thread-context";
import { receiptWords } from "./words";
import type { ReceiptInput } from "./words";

// Owner: ticket 12 (milestone 10, F-151: a receipt, parts.md part 12). A settled need in its
// block's place, 28px, 14px `--muted`: `check` 14px `--faint` (a decision was made), the words with
// the chosen value `--text-2`, the time mono 12.5px `--faint`, and a teal link when there's more:
// `Show the plan ›` opens the plan as approved, each entry with milestone 1's progress mark and
// `edited` on a changed one. Every receipt is drawn here, ticket 13's blocks' too. An answer is a
// receipt, never a member's bubble (content fix 10): a late answer (sent as a reopen, once the box
// was gone) stands in its message's place, and its turn draws none.

/** The plan a `Show the plan ›` opens: as approved, with the driver's edits and the build's progress. */
export type ShownPlan = {
  readonly entries: readonly PlanEntry[];
  readonly edited: readonly boolean[];
  /** Each entry's status in the build turns (`plan.updated`); `null` before the build reported any. */
  readonly progress: readonly PlanEntry["status"][] | null;
};

/** The thread's answers (`answers.ts`), or none outside a thread. */
const useAnswers = (): ThreadAnswers => useContext(ThreadParts)?.answers ?? noAnswers;

/** Milestone 1's progress mark: green `check` done, teal `circle-dot` current, `--faint` circle ahead. */
const Mark = ({ status }: { readonly status: PlanEntry["status"] }) => {
  switch (status) {
    case "completed":
      return <CheckIcon aria-hidden className="size-[14px] stroke-2 text-green" />;
    case "in_progress":
      return <CircleDotIcon aria-hidden className="size-[14px] stroke-[1.75] text-teal" />;
    case "pending":
      return <CircleIcon aria-hidden className="size-[14px] stroke-[1.75] text-faint" />;
    default:
      return status satisfies never;
  }
};

/** A plan entry's words, its inline code mono: drawn as text, never HTML. */
const EntryText = ({ text }: { readonly text: string }) => (
  <>
    {text.split(/`([^`]+)`/g).map((piece, index) =>
      index % 2 === 1 ? (
        <code key={index} className="rounded-[5px] border border-line bg-surface px-[5px] py-px font-mono text-[13px]">
          {piece}
        </code>
      ) : (
        piece
      ),
    )}
  </>
);

/** The plan as approved, opened under its receipt: the list as in the block, without rule or buttons. */
export const ShownPlanList = ({ id, plan }: { readonly id: string; readonly plan: ShownPlan }) => (
  <ol id={id} data-part="plan-shown" className="mb-2 ml-[22px] mt-0.5" aria-label={t("task.receipt.showPlan")}>
    {plan.entries.map((entry, index) => {
      const status = plan.progress?.[index] ?? "pending";
      const edited = plan.edited[index] === true;
      return (
        <li key={index} data-status={status} data-edited={edited ? "true" : undefined} className="flex min-h-[26px] items-start gap-2 py-0.5 text-body leading-[1.5] text-text">
          <span className="flex h-[22px] w-4 shrink-0 items-center">
            <Mark status={status} />
          </span>
          <span className="w-6 shrink-0 font-mono text-[12.5px] leading-[22px] text-faint">{index + 1}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <EntryText text={entry.content} />
            {edited ? <span className="ml-2 text-[12.5px] text-faint">{t("taskAnswers.plan.edited")}</span> : null}
          </span>
        </li>
      );
    })}
  </ol>
);

/**
 * A receipt. `at` is its time; a question's comes from its answer when the item has none. `late`:
 * it stands for a late answer's message, so a question answered late still draws it. `plan`: what
 * `Show the plan ›` opens.
 */
export const Receipt = ({ receipt, at, plan, late = false }: { readonly receipt: ReceiptInput; readonly at: number | null; readonly plan?: ShownPlan; readonly late?: boolean }) => {
  const { memberName } = useTaskContext();
  const answers = useAnswers();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const words = receiptWords(receipt, t, memberName);
  if (words === null) return null;
  // Answered late: the reopen message that carried the answer draws its receipt; the turn's stands back.
  if (receipt.kind === "question" && !late && answers.lateQuestions.has(receipt.question.questionId)) return null;
  const time = at ?? (receipt.kind === "question" ? (answers.questionAt.get(receipt.question.questionId) ?? null) : null);
  const more = words.action !== null && plan !== undefined && plan.entries.length > 0 ? words.action : null;
  return (
    <div data-part="receipt" data-receipt={receipt.kind} className="mb-1.5 mt-1">
      <div className="flex min-h-7 items-center gap-2 whitespace-nowrap text-ui text-muted">
        {words.settled ? <CheckIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint" /> : null}
        <span className="min-w-0 truncate">
          <Segments segments={words.words} mono="font-mono text-[13px]" />
        </span>
        {time === null ? null : <span className="shrink-0 font-mono text-[12.5px] text-faint">{formatClock(time)}</span>}
        {more === null ? null : (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => { setOpen((now) => !now); }}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-teal hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
            data-action="show-plan"
          >
            {more}
            <ChevronRightIcon aria-hidden className={cn("size-[13px] stroke-[1.75]", open && "rotate-90")} />
          </button>
        )}
      </div>
      {open && plan !== undefined ? <ShownPlanList id={listId} plan={plan} /> : null}
    </div>
  );
};

/** The plan turn's receipt, after its items: approved (with `Show the plan ›`) or changes asked. None while open, or answered late. */
export const PlanReceipt = ({ turnId }: { readonly turnId: TurnId }) => {
  const answer = useAnswers().plans.get(turnId);
  if (answer === undefined) return null;
  if (answer.late !== null) return null;
  return answer.decision === "approve" ? (
    <Receipt receipt={{ kind: "plan-approved", by: answer.by, edited: answer.edited.some(Boolean) }} at={answer.at} plan={{ entries: answer.entries, edited: answer.edited, progress: answer.progress }} />
  ) : (
    <Receipt receipt={{ kind: "plan-changes", by: answer.by }} at={answer.at} />
  );
};

/** The asked question whose text a late answer quotes, the newest; `undefined` when it isn't in view. */
const askedOf = (data: ReadonlyMap<string, TaskDataPart>, question: string): QuestionData | undefined => {
  let found: QuestionData | undefined;
  for (const part of data.values()) if (part.type === "data-question" && part.data.message === question) found = part.data;
  return found;
};

/** A plan's entries from a late approval's text (`1. Add …` a line), when its answer isn't in view. */
const entriesOf = (plan: string): readonly PlanEntry[] =>
  plan.split("\n").flatMap((line) => {
    const content = line.replace(/^\s*\d+[.)]\s*/, "").trim();
    return content === "" ? [] : [{ content, priority: "medium" as const, status: "pending" as const }];
  });

type LateAnswer = Extract<AgentMessage, { readonly kind: "plan-approved" | "question-answer" | "approval-answer" }>;

/**
 * A late answer's message (a plan approved, a question answered, an approval answered once the box
 * was gone, sent as the reopen): its receipt in the bubble's place, never a bubble. It reads the
 * answer it carried from the log when it's in view (the question's choices, the plan's edits and
 * progress), else from the message's own data.
 */
export const AnswerReceipt = ({ message, answer }: { readonly message: TaskUIMessage; readonly answer: LateAnswer }) => {
  const { store } = useTaskContext();
  const answers = useAnswers();
  const question = answer.kind === "question-answer" ? answer.question : null;
  const readAsked = () => (question === null ? undefined : askedOf(store.get().data, question));
  const asked = useSyncExternalStore(store.subscribe, readAsked, readAsked);
  const meta = message.metadata;
  const by = meta?.author?.memberId;
  if (by === undefined) return null;
  const at = meta?.at ?? null;
  switch (answer.kind) {
    case "question-answer":
      return asked?.status.state === "answered" ? (
        <Receipt receipt={{ kind: "question", question: asked }} at={at} late />
      ) : (
        <Receipt receipt={{ kind: "answered", by, answers: answer.answers }} at={at} late />
      );
    case "plan-approved": {
      const id = clientMessageIdSchema.safeParse(message.id.replace(/^user:/, ""));
      const late = id.success ? answers.late.get(id.data) : undefined;
      const known = late?.kind === "plan" ? answers.plans.get(late.turnId) : undefined;
      const plan: ShownPlan = known === undefined ? { entries: entriesOf(answer.plan), edited: [], progress: null } : { entries: known.entries, edited: known.edited, progress: known.progress };
      return <Receipt receipt={{ kind: "plan-approved", by, edited: known === undefined ? answer.edited : known.edited.some(Boolean) }} at={at} plan={plan} late />;
    }
    case "approval-answer":
      return <Receipt receipt={{ kind: "approval", by, decision: answer.decision, request: answer.request, reason: answer.reason }} at={at} late />;
    default:
      return answer satisfies never;
  }
};
