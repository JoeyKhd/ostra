"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon, MessageCircleQuestionIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import type { ApprovalDecision, PlanEntry, TaskId } from "@ostra/protocol";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { NeedsYou, useFocusOnAppear } from "@/components/ui/needs-you";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

// Ticket 43 (task-approval.md, task-plan.md; F-026, F-063, F-024): what the task page answers. Any
// member answers an approval; the driver answers the agent's questions and its plan, and a watcher
// sees them read-only with "Take over to answer". Everything here comes from `tasks.get`, so the
// thread's own fold stays a read of the log.

type Task = RouterOutputs["tasks"]["get"];
export type ApprovalView = Task["approvals"][number];
export type QuestionView = Task["questions"][number];
export type PlanView = NonNullable<Task["plan"]>;

/** Deny's reason, at most 2,000 characters (spec 5.1); the counter shows from 1,800. */
export const DENY_REASON_MAX = 2000;
const DENY_COUNTER_FROM = 1800;

/** The sentence for what asks, by the subject's kind (task-approval.md, "What asks"). */
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

/** A pattern a task rule adds, in words: `Edit config/settings.json in this task`. */
export const forThisTaskWords = (rule: { readonly tool: string; readonly pattern: string }): string => {
  switch (rule.tool) {
    case "edit":
      return t("taskAnswers.forTask.edit", { pattern: rule.pattern });
    case "execute":
      return t("taskAnswers.forTask.execute", { pattern: rule.pattern });
    case "fetch":
      return t("taskAnswers.forTask.fetch", { pattern: rule.pattern });
    default:
      return t("taskAnswers.forTask.other", { pattern: rule.pattern });
  }
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
  if (approval.state === "answered_by_rule") return approval.rule === null ? t("taskAnswers.receipt.byRule") : t("taskAnswers.receipt.byNamedRule", { rule: approval.rule.name });
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
}: {
  readonly taskId: TaskId;
  readonly approval: ApprovalView;
  readonly agent: string;
  readonly project: string;
  /** The session's other open approvals, for the deny's warning. */
  readonly othersOpen: number;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const answer = useMutation(
    trpc.approvals.answer.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.tasks.get.queryKey({ taskId }) }) }),
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
      title={approval.answerableAnyway ? t("taskAnswers.expiredTitle") : t("task.approval.title")}
      className="my-2.5"
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
            {approval.forThisTask === null || !offered("allow_task") ? null : (
              <p className="text-xs text-muted" data-part="for-this-task">{t("taskAnswers.forTaskAdds", { rule: forThisTaskWords(approval.forThisTask) })}</p>
            )}
            <p className="text-xs text-faint">{t("taskAnswers.anyMember", { project })}</p>
            <Refused message={refused} />
          </>
        )
      }
    >
      <p>
        {approval.rule === null ? null : <span className="font-semibold">{approval.rule.name} </span>}
        {askSentence(approval.subject?.kind ?? null, agent)}
      </p>
      {approval.subject === null ? null : (
        <code className="mt-2 inline-block max-w-full break-all rounded-[6px] border border-line bg-surface px-2.5 py-1.5 font-mono text-[12.5px] leading-[1.4] text-text" data-part="subject">
          {approval.subject.value}
        </code>
      )}
    </NeedsYou>
  );
};

/** The agent's question: a form for the driver, read-only with "Take over to answer" for anyone else. */
export const QuestionCard = ({
  taskId,
  question,
  agent,
  isDriver,
  driver,
  onTakeOver,
  takingOver,
}: {
  readonly taskId: TaskId;
  readonly question: QuestionView;
  readonly agent: string;
  readonly isDriver: boolean;
  readonly driver: string | null;
  readonly onTakeOver: () => void;
  readonly takingOver: boolean;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const answer = useMutation(trpc.questions.answer.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.tasks.get.queryKey({ taskId }) }) }));
  const complete = question.fields.every((field) => (values[field.id] ?? "").trim() !== "");
  const card = useFocusOnAppear<HTMLDivElement>(true);
  const set = (id: string, value: string) => { setValues((now) => ({ ...now, [id]: value })); };
  return (
    <div ref={card} tabIndex={-1} role="group" aria-label={t("task.question.title")} className="my-2.5 border-l-2 border-amber pl-3 focus:outline-2 focus:outline-offset-2 focus:outline-teal" data-testid="question" data-item={question.questionId}>
      <div className="flex items-center gap-2 text-body font-semibold text-amber">
        <MessageCircleQuestionIcon aria-hidden className="size-[14px] stroke-[1.75]" /> {t("task.question.title")}
      </div>
      <p className="mt-1 whitespace-pre-wrap font-medium">{question.message}</p>
      <fieldset disabled={!isDriver} aria-disabled={!isDriver} className={cn("mt-2 flex flex-col gap-2", !isDriver && "opacity-50")}>
        {question.fields.map((field) =>
          field.type === "select" && field.options !== undefined && field.options.length > 0 ? (
            <div key={field.id} role="radiogroup" aria-label={field.label}>
              {field.label === "" ? null : <p className="mb-1 text-xs text-faint">{field.label}</p>}
              {field.options.map((option) => (
                <label key={option} className="flex h-[26px] items-center gap-2 text-ui">
                  <input type="radio" name={`${question.questionId}-${field.id}`} value={option} checked={values[field.id] === option} onChange={() => { set(field.id, option); }} />
                  {option}
                </label>
              ))}
            </div>
          ) : (
            <label key={field.id} className="block">
              <span className="mb-1 block text-xs text-faint">{field.label}</span>
              <Input value={values[field.id] ?? ""} onChange={(event) => { set(field.id, event.target.value); }} className="h-8" />
            </label>
          ),
        )}
      </fieldset>
      {isDriver ? (
        <>
          <Button size="sm" variant="amber" className="mt-3 h-7" disabled={!complete || answer.isPending || answer.isSuccess} onClick={() => { answer.mutate({ taskId, questionId: question.questionId, answers: values }); }} data-action="answer-question">
            {answer.isPending ? t("taskAnswers.question.sending") : t("taskAnswers.question.send")}
          </Button>
          <p className="mt-2 text-xs text-faint">{t("taskAnswers.question.driverFoot", { agent })}</p>
        </>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" className="h-7" onClick={onTakeOver} disabled={takingOver} data-action="take-over-to-answer">{t("taskAnswers.question.takeOver")}</Button>
          <span className="text-xs text-faint">{driver === null ? t("taskAnswers.question.nobody") : t("taskAnswers.question.driverAnswers", { name: driver })}</span>
        </div>
      )}
      <Refused message={answer.error === null ? null : errorText(answer.error)} />
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

const PlanList = ({ entries, edited }: { readonly entries: readonly PlanEntry[]; readonly edited?: readonly boolean[] }) => (
  <ol className="mt-1 list-decimal pl-5">
    {entries.map((entry, i) => (
      <li key={i} className="py-0.5 text-body">
        {entry.content}
        {edited?.[i] === true ? <span className="ml-2 text-xs text-faint">{t("taskAnswers.plan.edited")}</span> : null}
      </li>
    ))}
  </ol>
);

/**
 * The plan (task-plan.md): proposed, it's the needs-you block with Approve plan, Edit and approve and
 * Ask for changes for the driver; approved, a receipt with the plan as approved and `edited` marks.
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

  if (plan.approved !== null) {
    return (
      <div className="my-3" data-testid="plan-approved">
        <p className="text-sm text-muted">{t("taskAnswers.plan.approvedBy", { name: plan.approved.by?.name ?? t("taskPage.someone") })}</p>
        <PlanList entries={plan.approved.entries} edited={plan.approved.edited} />
      </div>
    );
  }
  if (plan.itemId === null) return null;

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
    body = <PlanList entries={plan.entries} />;
  }

  return (
    <NeedsYou
      data-testid="plan"
      title={t("taskAnswers.plan.title")}
      className="my-3"
      {...(mode === "view" && isDriver
        ? {
            actions: (
              <>
                <Button size="sm" className="h-7" disabled={busy} onClick={() => { setMode("changes"); }} data-action="ask-plan-changes">{t("taskAnswers.plan.askChanges")}</Button>
                <Button size="sm" className="h-7" disabled={busy} onClick={() => { setMode("edit"); }} data-action="edit-plan">{t("taskAnswers.plan.edit")}</Button>
                <Button size="sm" variant="amber" className="h-7" disabled={busy} onClick={() => { approve(plan.entries); }} data-action="approve-plan">{t("taskAnswers.plan.approve")}</Button>
              </>
            ),
          }
        : {})}
      footer={
        <>
          {isDriver ? (
            <span>{t("taskAnswers.plan.driverFoot", { agent })}</span>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              <Button size="sm" className="h-7" onClick={onTakeOver} disabled={takingOver}>{t("taskAnswers.question.takeOver")}</Button>
              {driver === null ? t("taskAnswers.question.nobody") : t("taskAnswers.plan.driverAnswers", { name: driver })}
            </span>
          )}
          {plan.revision === null ? null : <p className="mt-1">{t("taskAnswers.plan.revisionAsked", { name: plan.revision.by?.name ?? t("taskPage.someone") })}</p>}
          <Refused message={answer.error === null ? null : errorText(answer.error)} />
        </>
      }
    >
      {plan.message.trim() === "" ? null : <p className="whitespace-pre-wrap text-muted">{plan.message.length > 600 ? `${plan.message.slice(0, 600)}…` : plan.message}</p>}
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

/** A ticket closed or cancelled while the task ran (F-066): stop the task, or keep working. */
export const TicketClosedBlock = ({ taskId, summary }: { readonly taskId: TaskId; readonly summary: string | null }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settle = { onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.tasks.get.queryKey({ taskId }) }) };
  const stop = useMutation(trpc.tasks.stop.mutationOptions(settle));
  const keep = useMutation(trpc.tasks.keepWorking.mutationOptions(settle));
  const busy = stop.isPending || keep.isPending || stop.isSuccess || keep.isSuccess;
  const failed = stop.error ?? keep.error;
  return (
    <NeedsYou
      data-testid="ticket-closed"
      title={t("taskAnswers.ticketClosed.title")}
      className="mt-4"
      actions={
        <>
          <Button size="sm" className="h-7" disabled={busy} onClick={() => { keep.mutate({ taskId }); }} data-action="keep-working">{t("taskAnswers.ticketClosed.keep")}</Button>
          <Button size="sm" variant="amber" className="h-7" disabled={busy} onClick={() => { stop.mutate({ taskId }); }} data-action="stop-task">{t("taskAnswers.ticketClosed.stop")}</Button>
        </>
      }
      footer={<Refused message={failed === null ? null : errorText(failed)} />}
    >
      {/* The item's summary is core's own sentence about the move; without one, the page's. */}
      <p>{summary ?? t("taskAnswers.ticketClosed.body")}</p>
    </NeedsYou>
  );
};
