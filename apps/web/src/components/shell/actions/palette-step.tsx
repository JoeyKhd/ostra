"use client";

import { ChevronRightIcon, CornerDownLeftIcon, LoaderCircleIcon } from "lucide-react";

import { approvalIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ApprovalId, QuestionId, TaskId } from "@ostra/protocol";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The palette's second steps (command-palette.md, "The second step"): an action whose label ends in
// `…` picks its item here, and nothing is done until the step's Enter. `Approve…` approves once;
// `Deny…` asks for an optional reason; `Answer…` answers a question of one choice list or one text
// field in place, and opens the task for any other; `Reopen a task…` picks a task, then its message.

type NotificationRow = RouterOutputs["notifications"]["list"]["rows"][number];
type QuestionField = Extract<NonNullable<NotificationRow["view"]["answer"]>, { readonly kind: "question" }>["fields"][number];

export type WaitingApproval = { readonly approvalId: ApprovalId; readonly taskId: TaskId; readonly key: string; readonly title: string; readonly subject: string };
export type WaitingQuestion = { readonly questionId: QuestionId; readonly taskId: TaskId; readonly key: string; readonly title: string; readonly message: string; readonly fields: readonly QuestionField[] };
export type StepTask = { readonly taskId: TaskId; readonly key: string; readonly title: string };

export type PaletteStep =
  | { readonly kind: "approve-pick" }
  | { readonly kind: "deny-pick" }
  | { readonly kind: "deny-reason"; readonly approval: WaitingApproval }
  | { readonly kind: "answer-pick" }
  | { readonly kind: "answer-choice"; readonly question: WaitingQuestion; readonly fieldId: string; readonly options: readonly string[] }
  | { readonly kind: "answer-text"; readonly question: WaitingQuestion; readonly fieldId: string }
  | { readonly kind: "reopen-pick" }
  | { readonly kind: "reopen-message"; readonly task: StepTask };

/** The open approvals and the questions this member may answer, from `notifications.list`, oldest first. */
export const waitingOf = (rows: readonly NotificationRow[]): { readonly approvals: readonly WaitingApproval[]; readonly questions: readonly WaitingQuestion[] } => {
  const approvals: WaitingApproval[] = [];
  const questions: WaitingQuestion[] = [];
  for (const row of [...rows].sort((a, b) => a.view.since - b.view.since)) {
    const answer = row.view.answer;
    if (answer === null || row.view.state !== "open") continue;
    const taskId = taskIdSchema.parse(row.view.taskId);
    if (answer.kind === "approval" && answer.state === "open") {
      approvals.push({ approvalId: approvalIdSchema.parse(answer.approvalId), taskId, key: row.view.key, title: row.view.title, subject: answer.subject?.value ?? "" });
    } else if (answer.kind === "question" && answer.canAnswer) {
      questions.push({ questionId: answer.questionId, taskId, key: row.view.key, title: row.view.title, message: answer.message, fields: answer.fields });
    }
  }
  return { approvals, questions };
};

/** The step's chip, before the input: `Approve`, `Deny CALC-142`. */
export const stepChip = (step: PaletteStep): string => {
  switch (step.kind) {
    case "approve-pick":
      return t("palette.step.approve");
    case "deny-pick":
      return t("palette.step.deny");
    case "deny-reason":
      return `${t("palette.step.deny")} ${step.approval.key}`;
    case "answer-pick":
      return t("palette.step.answer");
    case "answer-choice":
    case "answer-text":
      return `${t("palette.step.answer")} ${step.question.key}`;
    case "reopen-pick":
      return t("palette.step.reopen");
    case "reopen-message":
      return `${t("palette.step.reopen")} ${step.task.key}`;
    default:
      return step satisfies never;
  }
};

/** The input's placeholder in a step. */
export const stepPlaceholder = (step: PaletteStep): MessageKey => {
  switch (step.kind) {
    case "deny-reason":
      return "palette.step.denyReason";
    case "answer-text":
      return "palette.step.answerText";
    case "approve-pick":
    case "deny-pick":
    case "answer-pick":
    case "answer-choice":
    case "reopen-pick":
    case "reopen-message":
      return "palette.step.filter";
    default:
      return step satisfies never;
  }
};

/** The step's empty line. */
export const stepEmpty = (step: PaletteStep): MessageKey => {
  switch (step.kind) {
    case "approve-pick":
    case "deny-pick":
      return "palette.step.noApprovals";
    case "answer-pick":
      return "palette.step.noQuestions";
    case "reopen-pick":
      return "palette.step.noReopen";
    case "answer-choice":
    case "deny-reason":
    case "answer-text":
    case "reopen-message":
      return "palette.step.nothing";
    default:
      return step satisfies never;
  }
};

/** What Enter does in the step's footer. */
export const stepRun = (step: PaletteStep): MessageKey => {
  switch (step.kind) {
    case "approve-pick":
      return "palette.step.runApprove";
    case "deny-pick":
    case "answer-pick":
    case "reopen-pick":
      return "palette.step.runPick";
    case "deny-reason":
      return "palette.step.runDeny";
    case "answer-choice":
    case "answer-text":
      return "palette.step.runAnswer";
    case "reopen-message":
      return "palette.step.runReopen";
    default:
      return step satisfies never;
  }
};

export type StepOption = { readonly id: string; readonly primary: string; readonly key: string | null; readonly secondary: string | null; readonly next: boolean };

/** A row of a step's list, as the palette draws it. */
export const StepRow = ({ option, id, selected, busy, onSelect, onRun }: { readonly option: StepOption; readonly id: string; readonly selected: boolean; readonly busy: boolean; readonly onSelect: () => void; readonly onRun: () => void }) => (
  <div
    id={id}
    role="option"
    aria-selected={selected}
    data-testid="palette-step-row"
    data-step-row={option.id}
    onMouseMove={onSelect}
    onClick={onRun}
    className={cn("relative mx-1.5 grid min-h-[52px] cursor-default grid-cols-[72px_minmax(0,1fr)_20px] items-center gap-x-3 rounded-lg px-2.5 py-1.5", selected && "bg-sel before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-text")}
  >
    <span className="truncate font-mono text-[12.5px] text-faint">{option.key ?? ""}</span>
    <span className="min-w-0">
      <span className="block truncate text-ui text-text">{option.primary}</span>
      {option.secondary === null ? null : <span className="block truncate font-mono text-[12.5px] text-muted">{option.secondary}</span>}
    </span>
    <span className="flex justify-end text-faint">
      {busy && selected ? <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" /> : option.next ? <ChevronRightIcon aria-hidden className="size-3.5" /> : selected ? <CornerDownLeftIcon aria-hidden className="size-3" /> : null}
    </span>
  </div>
);
