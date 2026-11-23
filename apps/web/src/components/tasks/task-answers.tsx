"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ListChecksIcon, MessageCircleQuestionIcon, PencilIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import type { ApprovalDecision, PlanEntry, TaskId } from "@ostra/protocol";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { NeedsYou } from "@/components/ui/needs-you";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";
import { AgentMarkdown } from "@/task/renderers";
import { somethingElseWords } from "@/task/thread/words";

import { answerOf, choicesOf, emptyQuestionForm, isChoice, ownOpen, pick, SOMETHING_ELSE, typeOwn, typeText } from "./question-form";
import type { QuestionForm } from "./question-form";

// Ticket 43 (task-approval.md, task-plan.md; F-026, F-063, F-024): what the task page answers. Any
// member answers an approval; the driver answers the agent's questions and its plan, and a watcher
// sees them read-only with "Take over to answer". Everything here comes from `tasks.get`, so the
// thread's own fold stays a read of the log.
//
// Milestone 10 (F-151, ticket 13, parts.md part 11): drawn in the compact thread at that part's
// sizes, inside the amber rule (`NeedsYouInThread`): the question's choices as a radio group with
// `Something else…`, the plan as a numbered list right in the rule, the approval's card under its
// asking step. Each block that waits on its viewer says what for (`data-waits`), for the pill.

type Task = RouterOutputs["tasks"]["get"];
export type ApprovalView = Task["approvals"][number];
export type QuestionView = Task["questions"][number];
export type PlanView = NonNullable<Task["plan"]>;

/** Deny's reason, at most 2,000 characters (spec 5.1); the counter shows from 1,800. */
export const DENY_REASON_MAX = 2000;
const DENY_COUNTER_FROM = 1800;

/** The sentence for what asks, by the subject's kind (task-approval.md, "What asks"). */
/** F-138: the same, for a subagent's call: `explore · Find the version source asks before running this command:`. */
export const subagentAskSentence = (kind: "path" | "command" | "url" | "tool" | null, subagent: string): string => {
  switch (kind) {
    case "path":
      return t("task.subagents.asks.path", { subagent });
    case "command":
      return t("task.subagents.asks.command", { subagent });
    case "url":
      return t("task.subagents.asks.url", { subagent });
    case "tool":
      return t("task.subagents.asks.tool", { subagent });
    case null:
      return t("task.subagents.asks.other", { subagent });
    default:
      return kind satisfies never;
  }
};

export const askSentence = (kind: "path" | "command" | "url" | "tool" | null, agent: string): string => {
  switch (kind) {
    case "path":
      return t("taskAnswers.asks.path", { agent });
    case "command":
      return t("taskAnswers.asks.command", { agent });
    case "url":
      return t("taskAnswers.asks.url", { agent });
    case "tool":
      return t("taskAnswers.asks.tool", { agent });
    case null:
      return t("taskAnswers.asks.other", { agent });
    default:
      return kind satisfies never;
  }
};

/** The same with no rule that asked: the agent's own settings held the call back (task-approval.md, "What asks"). */
export const wantsSentence = (kind: "path" | "command" | "url" | "tool" | null, agent: string): string => {
  switch (kind) {
    case "path":
      return t("taskAnswers.wants.path", { agent });
    case "command":
      return t("taskAnswers.wants.command", { agent });
    case "url":
      return t("taskAnswers.wants.url", { agent });
    case "tool":
      return t("taskAnswers.wants.tool", { agent });
    case null:
      return t("taskAnswers.asks.other", { agent });
    default:
      return kind satisfies never;
  }
};

/**
 * What "Approve for this task" also approves, by what asked (task-approval.md, "Approve for this
 * task"; `states-asks.md` cell 1): `commands that start with` + mono `pnpm db`. The pattern is
 * drawn mono; a file's line names no pattern.
 */
export const ForThisTaskLine = ({ kind, pattern }: { readonly kind: "path" | "command" | "url" | "tool" | null; readonly pattern: string }) => {
  let words: string;
  switch (kind) {
    case "path":
      return <>{t("taskAnswers.forTaskAlso.path")}</>;
    case "command":
      words = t("taskAnswers.forTaskAlso.command", { pattern: "\u0000" });
      break;
    case "url":
      words = t("taskAnswers.forTaskAlso.url", { pattern: "\u0000" });
      break;
    case "tool":
    case null:
      words = t("taskAnswers.forTaskAlso.tool", { pattern: "\u0000" });
      break;
    default:
      return kind satisfies never;
  }
  const [before = "", after = ""] = words.split("\u0000");
  return (
    <>
      {before}
      <span className="font-mono text-[12.5px] text-text-2">{pattern}</span>
      {after}
    </>
  );
};

/** The warning under the deny's reason: the turn ends, and the session's other open approvals close. */
export const denyWarning = (agent: string, othersOpen: number): string =>
  othersOpen === 0
    ? t("taskAnswers.deny.warning", { agent })
    : othersOpen === 1
      ? `${t("taskAnswers.deny.warning", { agent })} ${t("taskAnswers.deny.otherOne")}`
      : `${t("taskAnswers.deny.warning", { agent })} ${t("taskAnswers.deny.otherMany", { n: othersOpen })}`;

/** The receipt of an answered or closed approval (task-approval.md, "Receipts"). */
export const approvalReceipt = (approval: ApprovalView): string | null => {
  const name = approval.answeredBy?.name ?? t("taskPage.someone");
  if (approval.state === "answered") {
    switch (approval.decision) {
      case "allow_once":
        return t("taskAnswers.receipt.once", { name });
      case "allow_task":
        return approval.forThisTask === null ? t("taskAnswers.receipt.task", { name }) : t("taskAnswers.receipt.taskPattern", { name, pattern: approval.forThisTask.pattern });
      case "deny":
        return approval.denyReason === null || approval.denyReason === "" ? t("taskAnswers.receipt.denied", { name }) : t("taskAnswers.receipt.deniedWhy", { name, reason: approval.denyReason });
      case null:
        return t("taskAnswers.receipt.answered", { name });
      default:
        return approval.decision satisfies never;
    }
  }
  // Answered by a task rule: that rule's pattern, from the row's `ruleId` (ticket 43's decision), not the rule that asked.
  if (approval.state === "answered_by_rule") {
    if (approval.byTaskRule !== null) return t("taskAnswers.receipt.byNamedRule", { rule: approval.byTaskRule.pattern });
    return approval.rule === null ? t("taskAnswers.receipt.byRule") : t("taskAnswers.receipt.byNamedRule", { rule: approval.rule.name });
  }
  if (approval.state === "closed") return approval.closedReason === "expired" ? t("taskAnswers.receipt.expired") : t("taskAnswers.receipt.cancelled");
  return null;
};

const Refused = ({ message }: { readonly message: string | null }) =>
  message === null ? null : <p role="alert" className="mt-2 text-sm text-red">{message}</p>;

/**
 * One approval waiting for a person: the rule and the subject, then Deny, Approve once (amber) and
 * Approve for this task with the pattern it adds. Deny opens the reason in place of the buttons.
 */
export const ApprovalCard = ({
  taskId,
  approval,
  agent,
  project,
  othersOpen,
  asker,
  onLostRace,
}: {
  readonly taskId: TaskId;
  readonly approval: ApprovalView;
  readonly agent: string;
  readonly project: string;
  /** The session's other open approvals, for the deny's warning. */
  readonly othersOpen: number;
  /** F-138: the subagent whose call asks (`explore · Find the version source`); absent for the agent's own. */
  readonly asker?: string;
  /** Another member answered first (`CONFLICT`): the receipt that replaces this card says so, for this member only. */
  readonly onLostRace?: (approvalId: string) => void;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const answer = useMutation(
    trpc.approvals.answer.mutationOptions({
      onError: (error) => {
        if (error.data?.code === "CONFLICT") onLostRace?.(approval.approvalId);
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.tasks.get.queryKey({ taskId }) }),
    }),
  );
  const offered = (decision: ApprovalDecision): boolean => approval.options.some((option) => option.decision === decision);
  const send = (decision: ApprovalDecision, why?: string) => {
    answer.mutate({ approvalId: approval.approvalId, decision, ...(why === undefined || why === "" ? {} : { reason: why }) });
  };
  const conflict = answer.error?.data?.code === "CONFLICT";
  const refused = answer.error === null ? null : conflict ? t("taskAnswers.answeredFirst") : errorText(answer.error);
  const busy = answer.isPending || answer.isSuccess;
  const onReasonKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") setDenying(false);
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send("deny", reason.trim());
  };
  return (
    <NeedsYou
      data-testid="approval"
      item={approval.approvalId}
      focusOnAppear
      waits="approval"
      title={approval.answerableAnyway ? t("taskAnswers.expiredTitle") : t("task.approval.title")}
      {...(denying
        ? {}
        : {
            actions: (
              <>
                {offered("deny") ? <Button size="sm" className="h-7" disabled={busy} onClick={() => { setDenying(true); }} data-action="deny">{t("taskAnswers.deny.button")}</Button> : null}
                {offered("allow_once") ? (
                  <Button size="sm" variant="amber" className="h-7" disabled={busy} onClick={() => { send("allow_once"); }} data-action="approve-once">
                    {approval.answerableAnyway ? t("taskAnswers.answerAnyway") : t("taskAnswers.approveOnce")}
                  </Button>
                ) : null}
                {offered("allow_task") && approval.forThisTask !== null ? (
                  <Button size="sm" className="h-7" disabled={busy} onClick={() => { send("allow_task"); }} data-action="approve-task">{t("taskAnswers.approveTask")}</Button>
                ) : null}
              </>
            ),
          })}
      footer={
        denying ? (
          <div data-part="deny">
            <label className="mb-1 block text-xs text-faint" htmlFor={`deny-${approval.approvalId}`}>{t("taskAnswers.deny.label", { agent })}</label>
            <Textarea
              id={`deny-${approval.approvalId}`}
              autoFocus
              rows={2}
              maxLength={DENY_REASON_MAX}
              value={reason}
              onChange={(event) => { setReason(event.target.value); }}
              onKeyDown={onReasonKey}
              className="min-h-0 text-ui"
            />
            {reason.length >= DENY_COUNTER_FROM ? <p className="text-right text-xs text-faint">{t("taskAnswers.deny.counter", { n: reason.length.toLocaleString("en-US") })}</p> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" className="h-7" disabled={busy} onClick={() => { send("deny", reason.trim()); }} data-action="deny-send">
                {reason.trim() === "" ? t("taskAnswers.deny.button") : t("taskAnswers.deny.withReason")}
              </Button>
              <Button size="sm" variant="ghost" className="h-7" onClick={() => { setDenying(false); }}>{t("common.cancel")}</Button>
            </div>
            <p className="mt-2 text-xs text-faint">{denyWarning(agent, othersOpen)}</p>
            <Refused message={refused} />
          </div>
        ) : (
          <>
            {/* parts.md part 11: the pattern line 13px `--muted` with its pattern mono, then the footnote 13px `--faint`, 8px apart. */}
            {approval.forThisTask === null || !offered("allow_task") ? null : (
              <p className="mb-2 text-muted" data-part="for-this-task"><ForThisTaskLine kind={approval.subject?.kind ?? null} pattern={approval.forThisTask.pattern} /></p>
            )}
            <p>{t("taskAnswers.anyMember", { project })}</p>
            <Refused message={refused} />
          </>
        )
      }
    >
      <p>
        {approval.rule === null ? null : <span className="font-semibold">{approval.rule.name} </span>}
        {asker !== undefined
          ? subagentAskSentence(approval.subject?.kind ?? null, asker)
          : approval.rule === null
            ? wantsSentence(approval.subject?.kind ?? null, agent)
            : askSentence(approval.subject?.kind ?? null, agent)}
      </p>
      {approval.subject === null ? null : (
        <code className="mt-2 inline-block max-w-full break-all rounded-[6px] border border-line bg-surface px-2.5 py-1.5 font-mono text-[13px] leading-[1.3] text-text" data-part="subject">
          {approval.subject.value}
        </code>
      )}
    </NeedsYou>
  );
};

/** The agent's question as the thread draws its messages: Markdown, no raw HTML, safe links (ADR 0036). */
export const QuestionMessage = ({ text, className }: { readonly text: string; readonly className?: string }) => (
  <div data-part="question-message" className={className}>
    <AgentMarkdown text={text} />
  </div>
);

/**
 * One field's choices (parts.md part 11): a radio group, 30px rows (44px on a phone), a 16px radio
 * with a 1.5px `--control-line` ring (chosen: a 5px `--text` ring), the label 14px; the enum's values,
 * then `Something else…`, which opens a 32px field under it. A watcher's are at 50% and disabled.
 * Native radios, one name a field: Tab reaches the group once, and the arrows move and choose at once.
 */
const Choices = ({ field, choices, form, onPick, onOwn, ownField, disabled, label }: {
  readonly field: QuestionView["fields"][number];
  readonly choices: readonly string[];
  readonly form: QuestionForm;
  readonly onPick: (value: string) => void;
  readonly onOwn: (words: string) => void;
  readonly ownField: (node: HTMLInputElement | null) => void;
  readonly disabled: boolean;
  readonly label: string;
}) => {
  const name = useId();
  const words = somethingElseWords(t);
  return (
    <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} data-part="choices" className={cn("flex flex-col", disabled && "opacity-50")}>
      {choices.map((choice) => {
        const other = choice === SOMETHING_ELSE;
        return (
          <div key={choice} className="contents">
            <label className={cn("flex min-h-[30px] w-fit items-center gap-2.5 text-ui text-text max-sm:min-h-11 max-sm:text-lede", !disabled && "cursor-pointer")} data-part="choice">
              <input
                type="radio"
                name={name}
                value={choice}
                checked={form.chosen[field.id] === choice}
                disabled={disabled}
                aria-disabled={disabled || undefined}
                onChange={() => { onPick(choice); }}
                className="size-4 shrink-0 appearance-none rounded-full border-[1.5px] border-control-line checked:border-[5px] checked:border-text"
              />
              {other ? words.choice : choice}
            </label>
            {other && ownOpen(form, field.id) ? (
              <Input
                ref={ownField}
                aria-label={words.field}
                value={form.own[field.id] ?? ""}
                onChange={(event) => { onOwn(event.target.value); }}
                data-part="something-else"
                className="my-0.5 ml-[26px] h-8 max-w-[460px] rounded-[6px] text-ui"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

/** The first choice of a question block, for the focus once its viewer can answer (after `Take over to answer`). */
const firstChoice = (block: HTMLElement | null): HTMLElement | null => block?.querySelector<HTMLElement>("input:not([disabled])") ?? null;

/**
 * The agent's question (parts.md part 11, `s1.md`): for the driver, the choices and `Send answer`,
 * asleep (the panel's disabled button) until every field holds a value, `Sending…` in flight,
 * `⌘↵` / `Ctrl+↵` too; it sends the answers with `other` naming the fields answered in words. For
 * anyone else, the quiet block: the same choices at 50% and disabled, `Take over to answer`, which
 * takes over and then focuses the first choice. `freeText`: the agent takes words for a choice
 * (`capabilities.questionFreeText`), so each enum ends with `Something else…`; without it the form
 * is milestone 3's.
 */
export const QuestionCard = ({
  taskId,
  question,
  agent,
  isDriver,
  driver,
  onTakeOver,
  takingOver,
  repeats = false,
  freeText = false,
}: {
  readonly taskId: TaskId;
  readonly question: QuestionView;
  readonly agent: string;
  readonly isDriver: boolean;
  readonly driver: string | null;
  readonly onTakeOver: () => void;
  readonly takingOver: boolean;
  /** The question is the agent's own message, just above: the card points at it, never repeats it. */
  readonly repeats?: boolean;
  /** The agent takes a member's own words for a choice: each enum offers `Something else…`. */
  readonly freeText?: boolean;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<QuestionForm>(emptyQuestionForm);
  const [focusField, setFocusField] = useState<string | null>(null);
  const [focusChoice, setFocusChoice] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const answer = useMutation(trpc.questions.answer.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.tasks.get.queryKey({ taskId }) }) }));
  const sent = answerOf(question.fields, form);
  const busy = answer.isPending || answer.isSuccess;
  const send = () => {
    if (sent === null || busy || !isDriver) return;
    answer.mutate({ taskId, questionId: question.questionId, answers: { ...sent.answers }, other: [...sent.other] });
  };
  // `Take over to answer`: once this member drives, the focus goes to the first choice.
  useEffect(() => {
    if (!focusChoice || !isDriver) return;
    setFocusChoice(false);
    firstChoice(holder.current)?.focus();
  }, [focusChoice, isDriver]);
  const ownField = (fieldId: string) => (node: HTMLInputElement | null) => {
    if (node !== null && focusField === fieldId) {
      node.focus();
      setFocusField(null);
    }
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  };
  const single = question.fields.length === 1;
  return (
    <div ref={holder} onKeyDown={onKey} className="contents">
      <NeedsYou
        data-testid="question"
        item={question.questionId}
        focusOnAppear={isDriver}
        tone={isDriver ? "amber" : "quiet"}
        waits={isDriver ? "question" : null}
        icon={<MessageCircleQuestionIcon aria-hidden />}
        title={t("task.question.title")}
        actions={
          isDriver ? (
            <>
              <Button
                size="sm"
                variant="amber"
                className="h-7 disabled:border-line-2 disabled:bg-surface disabled:text-faint disabled:opacity-40 max-sm:h-11 max-sm:w-full max-sm:text-lede"
                disabled={sent === null || busy}
                onClick={send}
                data-action="answer-question"
              >
                {answer.isPending ? t("taskAnswers.question.sending") : t("taskAnswers.question.send")}
              </Button>
              <span className="ml-1.5 text-sm text-faint max-sm:ml-0">{t("taskAnswers.question.driverFoot", { agent })}</span>
            </>
          ) : (
            <>
              <Button size="sm" className="h-7" onClick={() => { setFocusChoice(true); onTakeOver(); }} disabled={takingOver} data-action="take-over-to-answer">{t("taskAnswers.question.takeOver")}</Button>
              <span className="ml-1.5 text-sm text-faint">{driver === null ? t("taskAnswers.question.nobody") : t("taskAnswers.question.driverAnswers", { name: driver })}</span>
            </>
          )
        }
        {...(answer.error === null ? {} : { footer: <Refused message={errorText(answer.error)} /> })}
      >
        {repeats ? <p className="text-muted" data-part="question-above">{t("taskPage.needsYouCard.questionAbove", { agent })}</p> : <QuestionMessage text={question.message} />}
        <div className="mt-2 flex flex-col gap-2" data-part="question-fields">
          {question.fields.map((field) => {
            const label = field.label === "" ? t("task.question.title") : field.label;
            const shown = single && isChoice(field) ? null : field.label === "" ? null : <p className="mb-1 text-xs text-faint">{field.label}</p>;
            return isChoice(field) ? (
              <div key={field.id}>
                {shown}
                <Choices
                  field={field}
                  choices={choicesOf(field, freeText)}
                  form={form}
                  label={label}
                  disabled={!isDriver}
                  onPick={(value) => {
                    const picked = pick(form, field.id, value);
                    setForm(picked.form);
                    setFocusField(picked.focus?.field ?? null);
                  }}
                  onOwn={(words) => { setForm((now) => typeOwn(now, field.id, words)); }}
                  ownField={ownField(field.id)}
                />
              </div>
            ) : (
              <label key={field.id} className={cn("block", !isDriver && "opacity-50")}>
                {field.label === "" ? null : <span className="mb-1 block text-xs text-faint">{field.label}</span>}
                <Input disabled={!isDriver} value={form.chosen[field.id] ?? ""} onChange={(event) => { const words = event.target.value; setForm((now) => typeText(now, field.id, words)); }} className="h-8 max-w-[460px] rounded-[6px] text-ui" />
              </label>
            );
          })}
        </div>
      </NeedsYou>
    </div>
  );
};

/** One step of the plan while the driver edits it. */
type DraftStep = { readonly key: number; readonly content: string; readonly priority: PlanEntry["priority"] };

const toDraft = (entries: readonly PlanEntry[]): readonly DraftStep[] => entries.map((entry, i) => ({ key: i, content: entry.content, priority: entry.priority }));

/** Moves the step at `index` one place up or down; out of range leaves the list as it is. */
export const moveStep = <T,>(steps: readonly T[], index: number, by: -1 | 1): readonly T[] => {
  const to = index + by;
  if (to < 0 || to >= steps.length) return steps;
  const next = [...steps];
  const [moved] = next.splice(index, 1);
  if (moved === undefined) return steps;
  next.splice(to, 0, moved);
  return next;
};

/** A plan entry's words, its inline code mono (`src/keys/shortcuts.ts`): drawn as text, never HTML. */
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

/**
 * The plan's entries (parts.md part 11, `s5.md`): a numbered list right inside the rule, no box in
 * the block: 26px rows, the number Plex Mono 12.5px `--faint` in a 24px column, the entry 14.5px.
 */
const PlanList = ({ entries }: { readonly entries: readonly PlanEntry[] }) => (
  <ol className="pt-px" data-part="plan-entries">
    {entries.map((entry, i) => (
      <li key={i} className="grid min-h-[26px] grid-cols-[24px_minmax(0,1fr)] items-baseline py-px text-body leading-[1.5] text-text">
        <span className="font-mono text-[12.5px] text-faint">{i + 1}</span>
        <span className="[overflow-wrap:anywhere]">
          <EntryText text={entry.content} />
        </span>
      </li>
    ))}
  </ol>
);

/**
 * The plan (task-plan.md, `s5.md`): proposed, the needs-you block with its entries as a numbered list
 * right in the rule, then Approve plan, Edit and approve and Ask for changes to the plan for the
 * driver, and the watcher's quiet block with `Take over to answer`. The editor and the request for
 * changes are milestone 3's, inside the same rule. Answered, it's ticket 12's receipt instead.
 */
export const PlanBlock = ({
  taskId,
  plan,
  agent,
  isDriver,
  driver,
  onTakeOver,
  takingOver,
}: {
  readonly taskId: TaskId;
  readonly plan: PlanView;
  readonly agent: string;
  readonly isDriver: boolean;
  readonly driver: string | null;
  readonly onTakeOver: () => void;
  readonly takingOver: boolean;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"view" | "edit" | "changes">("view");
  const [steps, setSteps] = useState<readonly DraftStep[]>(() => toDraft(plan.entries));
  const [nextKey, setNextKey] = useState(plan.entries.length);
  const [request, setRequest] = useState("");
  const answer = useMutation(trpc.plans.answer.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.tasks.get.queryKey({ taskId }) }) }));
  const busy = answer.isPending || answer.isSuccess;

  // Answered, the plan is its receipt after the plan turn (ticket 12's `PlanReceipt`): no block.
  if (plan.approved !== null || plan.itemId === null) return null;

  const approve = (entries: readonly PlanEntry[]) => {
    answer.mutate({ taskId, decision: "approve", entries: [...entries], message: plan.message });
  };
  const edited = (): readonly PlanEntry[] =>
    steps.filter((step) => step.content.trim() !== "").map((step) => ({ content: step.content.trim(), priority: step.priority, status: "pending" as const }));
  const onStepKey = (index: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      setSteps((now) => moveStep(now, index, event.key === "ArrowUp" ? -1 : 1));
    }
  };

  let body: ReactNode;
  if (mode === "edit") {
    body = (
      <div data-part="plan-edit">
        <ul className="mt-2 flex flex-col gap-1.5">
          {steps.map((step, i) => (
            <li key={step.key} className="flex items-center gap-1.5">
              <span className="w-5 shrink-0 text-right font-mono text-sm text-faint">{i + 1}</span>
              <Input
                aria-label={t("taskAnswers.plan.step", { n: i + 1 })}
                value={step.content}
                onChange={(event) => { const value = event.target.value; setSteps((now) => now.map((one) => (one.key === step.key ? { ...one, content: value } : one))); }}
                onKeyDown={onStepKey(i)}
                className="h-8 flex-1"
              />
              <Button size="icon" variant="ghost" aria-label={t("taskAnswers.plan.up")} onClick={() => { setSteps((now) => moveStep(now, i, -1)); }}><ArrowUpIcon /></Button>
              <Button size="icon" variant="ghost" aria-label={t("taskAnswers.plan.down")} onClick={() => { setSteps((now) => moveStep(now, i, 1)); }}><ArrowDownIcon /></Button>
              <Button size="icon" variant="ghost" aria-label={t("taskAnswers.plan.remove")} onClick={() => { setSteps((now) => now.filter((one) => one.key !== step.key)); }}><XIcon /></Button>
            </li>
          ))}
        </ul>
        <Button size="sm" variant="ghost" className="mt-1.5 h-7" onClick={() => { setSteps((now) => [...now, { key: nextKey, content: "", priority: "medium" }]); setNextKey(nextKey + 1); }} data-action="add-step">
          <PlusIcon /> {t("taskAnswers.plan.addStep")}
        </Button>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="amber" className="h-7" disabled={busy || edited().length === 0} onClick={() => { approve(edited()); }} data-action="approve-edited-plan">{t("taskAnswers.plan.approve")}</Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => { setMode("view"); setSteps(toDraft(plan.entries)); }}>{t("common.cancel")}</Button>
        </div>
      </div>
    );
  } else if (mode === "changes") {
    body = (
      <div data-part="plan-changes" className="mt-2">
        <Textarea autoFocus rows={2} aria-label={t("taskAnswers.plan.whatChange")} placeholder={t("taskAnswers.plan.whatChange")} value={request} onChange={(event) => { setRequest(event.target.value); }} className="min-h-0 text-ui" />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" className="h-7" disabled={busy || request.trim() === ""} onClick={() => { answer.mutate({ taskId, decision: "revise", request: request.trim() }); }} data-action="send-plan-changes">{t("taskAnswers.plan.sendChanges")}</Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => { setMode("view"); }}>{t("common.cancel")}</Button>
        </div>
      </div>
    );
  } else {
    // A plan with no entries is its message alone, already in the thread just above: point at it.
    body =
      plan.entries.length === 0 ? (
        <p className="text-muted" data-part="plan-line">{plan.message.trim() === "" ? t("taskPage.needsYouCard.planOnly", { agent }) : t("taskPage.needsYouCard.planAbove", { agent })}</p>
      ) : (
        <PlanList entries={plan.entries} />
      );
  }

  return (
    <NeedsYou
      data-testid="plan"
      icon={<ListChecksIcon aria-hidden />}
      title={t("taskAnswers.plan.title")}
      tone={isDriver ? "amber" : "quiet"}
      waits={isDriver ? "plan" : null}
      {...(mode === "view" && isDriver
        ? {
            actions: (
              <>
                <Button size="sm" variant="amber" className="h-7" disabled={busy} onClick={() => { approve(plan.entries); }} data-action="approve-plan"><CheckIcon aria-hidden />{t("taskAnswers.plan.approve")}</Button>
                <Button size="sm" className="h-7" disabled={busy} onClick={() => { setMode("edit"); }} data-action="edit-plan"><PencilIcon aria-hidden />{t("taskAnswers.plan.edit")}</Button>
                <Button size="sm" className="h-7" disabled={busy} onClick={() => { setMode("changes"); }} data-action="ask-plan-changes">{t("taskAnswers.plan.askChanges")}</Button>
              </>
            ),
          }
        : {})}
      footer={
        <>
          {isDriver ? (
            <span>{t("taskAnswers.plan.driverFoot", { agent })}</span>
          ) : (
            <span className="text-muted">
              {driver === null ? t("taskAnswers.watcher.nobody") : t("taskAnswers.plan.driverAnswers", { name: driver })}{" "}
              <Button variant="link" className="text-sm" onClick={onTakeOver} disabled={takingOver} data-action="take-over-to-answer">{t("taskAnswers.question.takeOver")}</Button>
            </span>
          )}
          {plan.revision === null ? null : <p className="mt-1">{t("taskAnswers.plan.revisionAsked", { name: plan.revision.by?.name ?? t("taskPage.someone") })}</p>}
          <Refused message={answer.error === null ? null : errorText(answer.error)} />
        </>
      }
    >
      {body}
    </NeedsYou>
  );
};

/** The watcher's bar in the composer's place (task-approval.md, "The watcher's bar"). */
export const WatcherBar = ({ driver, onTakeOver, takingOver }: { readonly driver: string | null; readonly onTakeOver: () => void; readonly takingOver: boolean }) => (
  <div className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line-2 bg-surface px-3.5 py-2" data-part="watcher-bar">
    <span className="text-ui font-medium text-text">{driver === null ? t("taskAnswers.watcher.nobody") : t("taskAnswers.watcher.driving", { name: driver })}</span>
    <span className="min-w-0 flex-1 text-xs text-faint">{t("taskAnswers.watcher.hint")}</span>
    <Button size="sm" className="h-7" onClick={onTakeOver} disabled={takingOver} data-action="take-over">{t("taskPage.takeOver")}</Button>
  </div>
);

/** One of a card's calls, held by the page: run it, whether it's in flight, and why it was refused. */
export type CardAction = { readonly run: () => void; readonly pending: boolean; readonly error: string | null };

/** A ticket closed or cancelled while the task ran (F-066): stop the task, or keep working. */
export const TicketClosedBlock = ({ summary, stop, keep, className }: { readonly summary: string | null; readonly stop: CardAction; readonly keep: CardAction; readonly className?: string }) => {
  const busy = stop.pending || keep.pending;
  const failed = stop.error ?? keep.error;
  return (
    <NeedsYou
      data-testid="ticket-closed"
      need="ticket-closed"
      title={t("taskAnswers.ticketClosed.title")}
      {...(className === undefined ? {} : { className })}
      actions={
        <>
          <Button size="sm" className="h-7" disabled={busy} onClick={keep.run} data-action="keep-working">{t("taskAnswers.ticketClosed.keep")}</Button>
          <Button size="sm" variant="amber" className="h-7" disabled={busy} onClick={stop.run} data-action="stop-task">{t("taskAnswers.ticketClosed.stop")}</Button>
        </>
      }
      {...(failed === null ? {} : { footer: <Refused message={failed} /> })}
    >
      {/* The item's summary is core's own sentence about the move; without one, the page's. */}
      <p>{summary ?? t("taskAnswers.ticketClosed.body")}</p>
    </NeedsYou>
  );
};
