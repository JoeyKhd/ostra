"use client";

import { ArrowUpRightIcon, CheckIcon, ChevronUpIcon, CircleAlertIcon, CircleDotIcon, CircleIcon, HandIcon, InfoIcon, LoaderCircleIcon, MessageSquareIcon, PencilIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, ReactNode } from "react";

import { approvalIdSchema, questionIdSchema, taskIdSchema } from "@ostra/protocol";

import { actionHref, detailActionKey, reasonParts } from "@/components/home/home-words";
import type { Part } from "@/components/home/home-words";
import { useFocusedItem } from "@/components/shell/actions/use-scope";
import type { ItemScope } from "@/components/shell/actions/use-scope";
import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { projectColour } from "@/components/shell/project-colour";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { NeedsYou } from "@/components/ui/needs-you";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { usePhone } from "@/components/tasks/take-it-local";
import { cn } from "@/lib/cn";
import { formatAge } from "@/lib/format";
import { tNodes } from "@/lib/message-nodes";
import { t } from "@/lib/messages";

import { PLAN_SHOWN, askTitle, autoOpen, deliveryWords, groupByProject, ledeWords, outcomeWords, pageOrder } from "./needs-you-words";
import type { ApprovalAsk, InlineAsk, NotificationView, Outcome, PlanAsk, PlanEntryView, ProjectGroup, QuestionAsk, ReachView } from "./needs-you-words";

// The Needs you page (needs-you.md; F-036, F-062): the member's open notifications grouped by
// project, unread first, the approvals, plans and questions answered in place, and the Done tab.

const Parts = ({ parts }: { readonly parts: readonly Part[] }) => (
  <>
    {parts.map((part, i) =>
      part.code === true ? (
        <code key={i} className="font-mono text-[12.5px] text-text">{part.text}</code>
      ) : (
        <span key={i}>{part.text}</span>
      ),
    )}
  </>
);
const partsText = (parts: readonly Part[]): string => parts.map((part) => part.text).join("");

const Square = ({ id }: { readonly id: string }) => <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(id) }} />;

/** An answer's press: what the buttons show, and what came back. */
export type AnswerState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly pressed: string }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "lost-race"; readonly outcome: Outcome | null };

/** The answers the page sends; each resolves to what the API said. */
export type Answers = {
  readonly approval: (row: NotificationView, ask: ApprovalAsk, answer: { readonly kind: "once" } | { readonly kind: "task" } | { readonly kind: "deny"; readonly reason: string }) => Promise<AnswerResult>;
  readonly plan: (row: NotificationView, ask: PlanAsk, answer: { readonly kind: "approve" } | { readonly kind: "changes"; readonly message: string }) => Promise<AnswerResult>;
  readonly question: (row: NotificationView, ask: QuestionAsk, answer: string) => Promise<AnswerResult>;
};

export type AnswerResult = { readonly kind: "answered"; readonly outcome: Outcome } | { readonly kind: "refused"; readonly message: string } | { readonly kind: "lost-race"; readonly outcome: Outcome | null };

const Spinner = () => <LoaderCircleIcon aria-hidden className="size-[13px] motion-safe:animate-spin" />;

const Refusal = ({ state }: { readonly state: AnswerState }) => {
  if (state.kind === "refused")
    return (
      <p role="alert" className="mt-2 flex items-center gap-1.5 text-[12.5px] text-red">
        <CircleAlertIcon aria-hidden className="size-[13px]" /> {state.message}
      </p>
    );
  if (state.kind === "lost-race")
    return (
      <p role="alert" className="mt-2 flex items-center gap-1.5 text-[12.5px] text-red">
        <CircleAlertIcon aria-hidden className="size-[13px]" /> {t("needsYouPage.lostRace")}
        {state.outcome === null ? null : <span className="text-muted">{outcomeWords(state.outcome)}</span>}
      </p>
    );
  return null;
};

const NotDriver = ({ driver, taskId }: { readonly driver: string; readonly taskId: string }) => (
  <p className="text-xs text-muted">
    {t("needsYouPage.driving", { name: driver })}{" "}
    <Link href={`/tasks/${taskId}`} className="text-teal hover:underline">{t("needsYouPage.openTask")}</Link>
  </p>
);

const run = async (press: string, setState: (state: AnswerState) => void, send: () => Promise<AnswerResult>, onAnswered: (outcome: Outcome) => void) => {
  setState({ kind: "sending", pressed: press });
  const result = await send();
  switch (result.kind) {
    case "answered":
      setState({ kind: "idle" });
      onAnswered(result.outcome);
      return;
    case "refused":
      setState({ kind: "refused", message: result.message });
      return;
    case "lost-race":
      setState({ kind: "lost-race", outcome: result.outcome });
      return;
    default:
      return result satisfies never;
  }
};

export const ApprovalAnswer = ({
  row,
  ask,
  answers,
  onAnswered,
  phone = false,
}: {
  readonly row: NotificationView;
  readonly ask: ApprovalAsk;
  readonly answers: Answers;
  readonly onAnswered: (outcome: Outcome) => void;
  /** phone-approval.md: under 640px the item carries the rule and the title; the answers stack full width. */
  readonly phone?: boolean;
}) => {
  const [state, setState] = useState<AnswerState>({ kind: "idle" });
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const busy = state.kind === "sending";
  const pressed = (name: string) => (state.kind === "sending" && state.pressed === name ? <Spinner /> : null);
  const deny = () => { void run("deny", setState, () => answers.approval(row, ask, { kind: "deny", reason: reason.trim() }), onAnswered); };
  if (phone) {
    return (
      <div role="group" aria-label={askTitle(ask)} data-testid="needs-you" className="mt-2">
        <p className="text-ui text-text">{t("needsYouPage.wants", { agent: ask.agent, summary: ask.summary })}</p>
        <code className="mt-2 block whitespace-pre-wrap rounded-[6px] border border-line-2 bg-surface px-3 py-2.5 font-mono text-[13px] text-text [overflow-wrap:anywhere]">{ask.subject}</code>
        <p className="mt-2 text-[12.5px] text-muted">{t("needsYouPage.rule")} {ask.rule ?? t("needsYouPage.customRule")}</p>
        {denying ? (
          <div className="mt-3">
            <Textarea autoFocus rows={2} aria-label={t("needsYouPage.denyReason")} placeholder={t("needsYouPage.denyReason")} value={reason} onChange={(event) => { setReason(event.target.value); }} className="min-h-0 text-body" />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button variant="ghost" className="h-11" onClick={() => { setDenying(false); setReason(""); }}>{t("common.cancel")}</Button>
              <Button variant="danger" className="h-11" disabled={busy} onClick={deny}>{pressed("deny")}{t("needsYouPage.deny")}</Button>
            </div>
          </div>
        ) : (
          <>
            <Button variant="amber" className="mt-3 h-11 w-full" disabled={busy} onClick={() => { void run("once", setState, () => answers.approval(row, ask, { kind: "once" }), onAnswered); }}>
              {pressed("once") ?? <CheckIcon aria-hidden />}
              {t("needsYouPage.approveOnce")}
            </Button>
            <div className={cn("mt-2 grid gap-2", ask.pattern === null ? "grid-cols-1" : "grid-cols-2")}>
              {ask.pattern === null ? null : (
                <Button className="h-11" disabled={busy} onClick={() => { void run("task", setState, () => answers.approval(row, ask, { kind: "task" }), onAnswered); }}>
                  {pressed("task")}{t("needsYouPage.approveTask")}
                </Button>
              )}
              <Button className="h-11" disabled={busy} onClick={() => { setDenying(true); }} data-action="deny">{t("needsYouPage.deny")}</Button>
            </div>
          </>
        )}
        <p className="mt-2.5 text-xs text-faint">
          {ask.pattern === null
            ? t("needsYouPage.anyMember", { project: row.project.name })
            : tNodes("needsYouPage.forThisTaskAdds", { pattern: <code className="font-mono text-muted">{ask.pattern}</code>, project: row.project.name })}
        </p>
        <Refusal state={state} />
      </div>
    );
  }
  return (
    <NeedsYou
      title={askTitle(ask)}
      actions={
        <>
          <Button size="sm" className="h-7" disabled={busy} onClick={() => { setDenying(true); }} data-action="deny">{pressed("deny")}{t("needsYouPage.deny")}</Button>
          <Button size="sm" variant="amber" className="h-7" disabled={busy} onClick={() => { void run("once", setState, () => answers.approval(row, ask, { kind: "once" }), onAnswered); }}>
            {pressed("once")}{t("needsYouPage.approveOnce")}
          </Button>
          {ask.pattern === null ? null : (
            <Button size="sm" className="h-7" disabled={busy} onClick={() => { void run("task", setState, () => answers.approval(row, ask, { kind: "task" }), onAnswered); }}>
              {pressed("task")}{t("needsYouPage.approveTask")}
            </Button>
          )}
        </>
      }
      footer={
        <>
          {denying ? (
            <span className="mb-2 flex flex-wrap items-center gap-2">
              <Input
                autoFocus
                aria-label={t("needsYouPage.denyReason")}
                placeholder={t("needsYouPage.denyReason")}
                value={reason}
                onChange={(event) => { setReason(event.target.value); }}
                className="h-7 max-w-[360px] flex-1 text-sm"
              />
              <Button size="sm" className="h-7" disabled={busy} onClick={deny}>
                {t("needsYouPage.deny")}
              </Button>
              <Button size="sm" variant="ghost" className="h-7" onClick={() => { setDenying(false); setReason(""); }}>{t("common.cancel")}</Button>
            </span>
          ) : null}
          <span className="block text-xs">
            {ask.pattern === null
              ? t("needsYouPage.anyMember", { project: row.project.name })
              : tNodes("needsYouPage.forThisTaskAdds", { pattern: <code className="font-mono text-text">{ask.pattern}</code>, project: row.project.name })}
          </span>
          <Refusal state={state} />
        </>
      }
    >
      <p className="text-sm">
        {t("needsYouPage.wants", { agent: ask.agent, summary: ask.summary })} {t("needsYouPage.rule")}{" "}
        <span className="font-medium text-text">{ask.rule ?? t("needsYouPage.customRule")}</span>
      </p>
      <code className="mt-2 inline-block max-w-full whitespace-pre-wrap rounded-sm border border-line bg-surface px-2.5 py-1.5 font-mono text-[12.5px] text-text [overflow-wrap:anywhere]">{ask.subject}</code>
    </NeedsYou>
  );
};

const EntryGlyph = ({ status }: { readonly status: PlanEntryView["status"] }) => {
  const cls = "size-3 shrink-0 stroke-[1.75]";
  switch (status) {
    case "pending":
      return <CircleIcon aria-hidden className={cn(cls, "text-faint")} />;
    case "in_progress":
      return <CircleDotIcon aria-hidden className={cn(cls, "text-muted")} />;
    case "completed":
      return <CheckIcon aria-hidden className={cn(cls, "text-green")} />;
    case "cancelled":
      return <XIcon aria-hidden className={cn(cls, "text-faint")} />;
    default:
      return status satisfies never;
  }
};

export const PlanAnswer = ({ row, ask, answers, onAnswered, phone = false }: {
  readonly row: NotificationView;
  readonly ask: PlanAsk;
  readonly answers: Answers;
  readonly onAnswered: (outcome: Outcome) => void;
  /** phone-approval.md, "The plan sheet": numbered rows, `Approve plan` full width, the other two side by side. */
  readonly phone?: boolean;
}) => {
  const [state, setState] = useState<AnswerState>({ kind: "idle" });
  const [changing, setChanging] = useState(false);
  const [message, setMessage] = useState("");
  const busy = state.kind === "sending";
  const shown = ask.entries.slice(0, PLAN_SHOWN);
  const rest = ask.entries.length - shown.length;
  const approve = () => { void run("approve", setState, () => answers.plan(row, ask, { kind: "approve" }), onAnswered); };
  const sendChanges = () => { void run("changes", setState, () => answers.plan(row, ask, { kind: "changes", message: message.trim() }), onAnswered); };
  if (phone) {
    return (
      <div role="group" aria-label={askTitle(ask)} data-testid="needs-you">
        <p className="text-ui font-semibold text-text">{t("needsYouPage.planLabel")}</p>
        <ol className="mt-1">
          {shown.map((entry, i) => (
            <li key={i} className="flex min-h-10 items-start gap-0 border-b border-line py-2.5 text-ui text-text last:border-b-0">
              <span className="w-6 shrink-0 font-mono text-xs leading-5 text-faint">{i + 1}</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{entry.text}</span>
            </li>
          ))}
        </ol>
        {rest > 0 ? <Link href={`/tasks/${row.taskId}`} className="text-sm text-teal hover:underline">{t("needsYouPage.moreOnTask", { n: rest })}</Link> : null}
        {ask.driver !== null ? (
          <div className="mt-3"><NotDriver driver={ask.driver} taskId={row.taskId} /></div>
        ) : changing ? (
          <div className="mt-3">
            <Textarea autoFocus rows={3} aria-label={t("needsYouPage.whatChange")} placeholder={t("needsYouPage.whatChange")} value={message} onChange={(event) => { setMessage(event.target.value); }} className="min-h-0 text-body" />
            <Button variant="primary" className="mt-2 h-11 w-full" disabled={busy || message.trim() === ""} onClick={sendChanges}>{t("needsYouPage.send")}</Button>
            <Button variant="ghost" className="mt-2 h-11 w-full" onClick={() => { setChanging(false); }}>{t("common.cancel")}</Button>
          </div>
        ) : (
          <>
            <Button variant="amber" className="mt-3 h-11 w-full" disabled={busy} onClick={approve}>
              {state.kind === "sending" && state.pressed === "approve" ? <Spinner /> : <CheckIcon aria-hidden />}
              {t("needsYouPage.approvePlan")}
            </Button>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button className="h-11" asChild>
                <Link href={`/tasks/${row.taskId}?plan=edit`}><PencilIcon aria-hidden />{t("needsYouPage.editOnTask")}</Link>
              </Button>
              <Button className="h-11" disabled={busy} onClick={() => { setChanging(true); }}><MessageSquareIcon aria-hidden />{t("needsYouPage.askChanges")}</Button>
            </div>
            <p className="mt-2.5 flex items-start gap-1.5 text-xs text-faint"><InfoIcon aria-hidden className="mt-px size-[13px] shrink-0" />{t("needsYouPage.planDriverOnly")}</p>
          </>
        )}
        <Refusal state={state} />
      </div>
    );
  }
  return (
    <NeedsYou
      title={askTitle(ask)}
      {...(ask.driver === null
        ? {
            actions: (
              <>
                <Button size="sm" className="h-7" disabled={busy} onClick={() => { setChanging(true); }}>{t("needsYouPage.askChanges")}</Button>
                <Button size="sm" variant="amber" className="h-7" disabled={busy} onClick={() => { void run("approve", setState, () => answers.plan(row, ask, { kind: "approve" }), onAnswered); }}>
                  {state.kind === "sending" && state.pressed === "approve" ? <Spinner /> : null}
                  {t("needsYouPage.approvePlan")}
                </Button>
                <Button size="sm" className="h-7" asChild>
                  <Link href={`/tasks/${row.taskId}?plan=edit`}>{t("needsYouPage.editOnTask")}</Link>
                </Button>
              </>
            ),
          }
        : {})}
      footer={
        <>
          {ask.driver === null ? null : <NotDriver driver={ask.driver} taskId={row.taskId} />}
          {changing ? (
            <span className="mt-1 block">
              <Textarea rows={2} aria-label={t("needsYouPage.whatChange")} placeholder={t("needsYouPage.whatChange")} value={message} onChange={(event) => { setMessage(event.target.value); }} className="min-h-0 text-sm" />
              <span className="mt-2 flex gap-2">
                <Button size="sm" className="h-7" disabled={busy || message.trim() === ""} onClick={() => { void run("changes", setState, () => answers.plan(row, ask, { kind: "changes", message: message.trim() }), onAnswered); }}>
                  {t("needsYouPage.send")}
                </Button>
                <Button size="sm" variant="ghost" className="h-7" onClick={() => { setChanging(false); }}>{t("common.cancel")}</Button>
              </span>
            </span>
          ) : null}
          <Refusal state={state} />
        </>
      }
    >
      <ul className="text-sm">
        {shown.map((entry, i) => (
          <li key={i} className="flex min-h-6 items-center gap-2">
            <EntryGlyph status={entry.status} />
            <span className="min-w-0">{entry.text}</span>
          </li>
        ))}
      </ul>
      {rest > 0 ? (
        <Link href={`/tasks/${row.taskId}`} className="text-sm text-teal hover:underline">{t("needsYouPage.moreOnTask", { n: rest })}</Link>
      ) : null}
    </NeedsYou>
  );
};

export const QuestionAnswer = ({ row, ask, answers, onAnswered }: { readonly row: NotificationView; readonly ask: QuestionAsk; readonly answers: Answers; readonly onAnswered: (outcome: Outcome) => void }) => {
  const [state, setState] = useState<AnswerState>({ kind: "idle" });
  const [text, setText] = useState("");
  const [full, setFull] = useState(false);
  const busy = state.kind === "sending";
  const long = ask.question.split("\n").length > 4 || ask.question.length > 320;
  const send = (answer: string, press: string) => { void run(press, setState, () => answers.question(row, ask, answer), onAnswered); };
  return (
    <NeedsYou title={askTitle(ask)} footer={<Refusal state={state} />}>
      <p className={cn("whitespace-pre-wrap text-sm text-text [overflow-wrap:anywhere]", !full && "line-clamp-4")}>{ask.question}</p>
      {long && !full ? (
        <button type="button" onClick={() => { setFull(true); }} className="text-sm text-teal hover:underline">{t("needsYouPage.showMore")}</button>
      ) : null}
      {ask.driver === null ? (
        <div className="mt-3">
          {ask.options.length === 0 ? null : (
            <div className="mb-2 flex flex-wrap gap-2">
              {ask.options.map((option, i) => (
                <Button key={i} size="sm" className="h-7" disabled={busy} onClick={() => { send(option, `option-${String(i)}`); }}>
                  {state.kind === "sending" && state.pressed === `option-${String(i)}` ? <Spinner /> : null}
                  {option}
                </Button>
              ))}
            </div>
          )}
          <Textarea rows={2} aria-label={t("needsYouPage.yourAnswer")} placeholder={t("needsYouPage.yourAnswer")} value={text} onChange={(event) => { setText(event.target.value); }} className="min-h-0 text-sm" />
          <Button size="sm" variant="amber" className="mt-2 h-7" disabled={busy || text.trim() === ""} onClick={() => { send(text.trim(), "send"); }}>
            {state.kind === "sending" && state.pressed === "send" ? <Spinner /> : null}
            {t("needsYouPage.sendAnswer")}
          </Button>
        </div>
      ) : (
        <div className="mt-2">
          <NotDriver driver={ask.driver} taskId={row.taskId} />
        </div>
      )}
    </NeedsYou>
  );
};

const InlineAnswer = ({ row, ask, answers, onAnswered }: { readonly row: NotificationView; readonly ask: InlineAsk; readonly answers: Answers; readonly onAnswered: (outcome: Outcome) => void }) => {
  switch (ask.kind) {
    case "approval":
      return <ApprovalAnswer row={row} ask={ask} answers={answers} onAnswered={onAnswered} />;
    case "plan":
      return <PlanAnswer row={row} ask={ask} answers={answers} onAnswered={onAnswered} />;
    case "question":
      return <QuestionAnswer row={row} ask={ask} answers={answers} onAnswered={onAnswered} />;
    default:
      return ask satisfies never;
  }
};

// ---------- the rows ----------

// The reason column gives the title room at the double sidebar's narrower page (needs-you.md drew 300px beside a 232px sidebar).
const ROW_GRID = "md:grid-cols-[14px_80px_minmax(0,1fr)_260px_44px_112px]";

/**
 * One needs-you item at phone width (phone-approval.md): a 2px amber rule, `Needs you · {reason}` and
 * the age, then the key and title with the reason's verb. An approval is always open in place; a plan
 * or a question opens in a bottom sheet; anything else opens its task.
 */
const PhoneItem = ({ row, now, answers, onAnswered }: {
  readonly row: NotificationView;
  readonly now: number;
  readonly answers: Answers;
  readonly onAnswered: (row: NotificationView, outcome: Outcome) => void;
}) => {
  const [sheet, setSheet] = useState(false);
  const href = `/tasks/${row.taskId}`;
  const ask = row.outcome === null ? row.ask : null;
  const line = ask === null ? t("needsYouPage.phoneLine", { reason: partsText(reasonParts(row.detail)) }) : askTitle(ask);
  const answered = (outcome: Outcome) => { setSheet(false); onAnswered(row, outcome); };
  const action =
    row.outcome !== null ? (
      <span className="shrink-0 text-xs text-faint">{t("needsYouPage.done")}</span>
    ) : ask === null ? (
      <Button size="sm" className="h-8 shrink-0" asChild>
        <Link href={actionHref(row.detail.reason, row.project.id, row.taskId)}>{t(detailActionKey(row.detail))}</Link>
      </Button>
    ) : ask.kind === "approval" ? null : (
      <Button size="sm" className="h-8 shrink-0" onClick={() => { setSheet(true); }}>{t(detailActionKey(row.detail))}</Button>
    );
  return (
    <li className="border-b border-line py-3.5 pl-3.5 pr-4" data-notification={row.id}>
      <div className="border-l-2 border-amber pl-3">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-amber-text">
          <HandIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75]" />
          <span className="min-w-0 flex-1 truncate">{row.outcome === null ? line : outcomeWords(row.outcome)}</span>
          <span className="shrink-0 font-mono text-xs font-normal text-faint" suppressHydrationWarning>{formatAge(row.at, now)}</span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <Link href={href} className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="shrink-0 font-mono text-sm text-faint">{row.key}</span>
            <span className={cn("min-w-0 truncate text-text", ask?.kind === "approval" ? "text-[15px] font-medium" : "text-ui")}>{row.title}</span>
          </Link>
          {action}
        </div>
        {ask?.kind === "approval" ? <ApprovalAnswer row={row} ask={ask} answers={answers} onAnswered={answered} phone /> : null}
      </div>
      {ask === null || ask.kind === "approval" ? null : (
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent side="bottom" title={row.title} className="max-h-[90dvh] px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
            <div aria-hidden className="mx-auto mb-3 h-1 w-9 rounded-full bg-line-2" />
            <div className="flex items-center gap-2 pr-8">
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-faint">{row.key} · <span className="font-sans text-muted">{row.project.name}</span></span>
              <Link href={href} className="inline-flex shrink-0 items-center gap-1 text-sm text-teal hover:underline">{t("home.action.openTask")}<ArrowUpRightIcon aria-hidden className="size-[13px]" /></Link>
            </div>
            <h2 className="mt-1 text-[18px] font-semibold text-text">{row.title}</h2>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-amber-text">
              <HandIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75]" />
              {askTitle(ask)}
              {ask.driver === null ? <span className="font-normal text-muted">{t("needsYouPage.youDrive")}</span> : null}
            </p>
            <div className="mt-3 border-t border-line pt-3">
              {ask.kind === "plan" ? <PlanAnswer row={row} ask={ask} answers={answers} onAnswered={answered} phone /> : <QuestionAnswer row={row} ask={ask} answers={answers} onAnswered={answered} />}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </li>
  );
};

export const NotificationRow = ({
  row,
  now,
  expanded,
  unreadDot,
  answers,
  onToggle,
  onAnswered,
  focusRef,
  onKeyDown,
  tabbable = false,
  onItemFocus,
  onItemBlur,
}: {
  readonly row: NotificationView;
  readonly now: number;
  readonly expanded: boolean;
  /** The dot as the page first drew it: dots stay for this visit (needs-you.md, Reading). */
  readonly unreadDot: boolean;
  readonly answers: Answers;
  readonly onToggle: (id: string) => void;
  readonly onAnswered: (row: NotificationView, outcome: Outcome) => void;
  readonly focusRef?: (node: HTMLDivElement | null) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>, row: NotificationView) => void;
  /** The list's one Tab stop (ticket 16): the row the arrows last reached, else the first. */
  readonly tabbable?: boolean;
  /** The row's item is in the shell's scope while the focus is inside the row (F-081: `a`, `d`, `r`). */
  readonly onItemFocus?: (row: NotificationView) => void;
  readonly onItemBlur?: () => void;
}) => {
  const reason = reasonParts(row.detail);
  const inline = row.ask !== null && row.outcome === null;
  const href = `/tasks/${row.taskId}`;
  const action = row.outcome !== null ? (
    <span className="justify-self-end text-xs text-faint">{t("needsYouPage.done")}</span>
  ) : expanded ? (
    <Button variant="ghost" size="icon" className="size-7 justify-self-end" aria-expanded aria-label={t("needsYouPage.collapse")} onClick={() => { onToggle(row.id); }}>
      <ChevronUpIcon aria-hidden />
    </Button>
  ) : inline ? (
    <Button size="sm" className="h-[26px] w-[112px] justify-self-end font-normal" aria-expanded={false} onClick={() => { onToggle(row.id); }}>
      {t(detailActionKey(row.detail))}
    </Button>
  ) : (
    <Button size="sm" className="h-[26px] w-[112px] justify-self-end font-normal" asChild>
      <Link href={actionHref(row.detail.reason, row.project.id, row.taskId)}>{t(detailActionKey(row.detail))}</Link>
    </Button>
  );
  return (
    <li
      className="border-b border-line"
      data-notification={row.id}
      data-read={unreadDot ? "false" : "true"}
      onFocus={() => onItemFocus?.(row)}
      onBlur={(event: FocusEvent<HTMLLIElement>) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) onItemBlur?.();
      }}
    >
      <div
        ref={focusRef}
        tabIndex={tabbable ? 0 : -1}
        data-testid="needs-you-row"
        aria-label={`${row.key} ${row.title}`}
        onKeyDown={(event) => onKeyDown?.(event, row)}
        className={cn("grid min-h-10 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 py-1.5 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-muted md:py-0", ROW_GRID)}
      >
        <span className="flex justify-center">{unreadDot ? <span role="img" aria-label={t("needsYouPage.unread")} className="size-1.5 rounded-full bg-text" /> : null}</span>
        <div className="flex min-w-0 items-center gap-2 md:contents">
          <Link href={href} className="shrink-0 font-mono text-xs text-faint hover:underline">{row.key}</Link>
          <Link href={href} className={cn("min-w-0 truncate text-ui hover:underline", unreadDot ? "font-medium text-text" : "text-muted")}>{row.title}</Link>
        </div>
        <Tooltip content={partsText(reason)}>
          <span className="col-start-2 min-w-0 truncate text-sm text-muted md:col-start-auto">
            {row.outcome === null ? <Parts parts={reason} /> : outcomeWords(row.outcome)}
          </span>
        </Tooltip>
        <span className="hidden text-right font-mono text-xs text-faint md:block" suppressHydrationWarning>{formatAge(row.at, now)}</span>
        <span className="col-start-3 row-span-2 row-start-1 flex items-center md:col-start-auto md:row-span-1 md:row-start-auto md:justify-end">{action}</span>
      </div>
      {expanded && row.ask !== null && row.outcome === null ? (
        <div className="pb-3.5 pt-3 md:pl-[94px]">
          <InlineAnswer row={row} ask={row.ask} answers={answers} onAnswered={(outcome) => { onAnswered(row, outcome); }} />
        </div>
      ) : null}
      {row.deliveryFailed === null ? null : (
        <p className="flex items-center gap-1.5 pb-2 text-xs text-red md:pl-[94px]">
          <CircleAlertIcon aria-hidden className="size-[13px]" /> {deliveryWords(row.deliveryFailed)}
        </p>
      )}
    </li>
  );
};

export const GroupBand = ({ group }: { readonly group: ProjectGroup }) => (
  <div className="flex h-[30px] items-center gap-2 rounded-sm bg-surface px-2.5">
    <Square id={group.project.id} />
    <Link href={`/projects/${group.project.id}`} className="text-sm font-semibold text-text hover:underline">{group.project.name}</Link>
    <span className="font-mono text-xs text-faint">{group.rows.length}</span>
  </div>
);

export type OpenListProps = {
  readonly rows: readonly NotificationView[];
  readonly now: number;
  readonly answers: Answers;
  /** The rows unread when the page first drew them: their dots stay for this visit. */
  readonly unreadAtLoad: ReadonlySet<string>;
};

/** The Open tab: groups by project, one row expanded at a time, ↑/↓, Enter and Esc. */
export const OpenList = ({ rows, now, answers, unreadAtLoad }: OpenListProps) => {
  const phone = usePhone();
  const groups = groupByProject(rows);
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined);
  const [current, setCurrent] = useState<string | null>(null);
  const scope = useFocusedItem();
  const [answered, setAnswered] = useState<ReadonlyMap<string, Outcome>>(new Map());
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const open = expanded === undefined ? autoOpen(groups) : expanded;
  const order = pageOrder(groups);
  const shown = (row: NotificationView): NotificationView => {
    const outcome = answered.get(row.id);
    return outcome === undefined ? row : { ...row, outcome };
  };
  const toggle = (id: string) => { setExpanded(open === id ? null : id); };
  const stop = current !== null && order.includes(current) ? current : (order[0] ?? null);
  /** After the row opens, its control: the deny button pressed (`d`), or the answer's field (`r`). */
  const inRow = (id: string, act: (row: HTMLElement) => void) => {
    setExpanded(id);
    requestAnimationFrame(() => {
      const node = document.querySelector<HTMLElement>(`[data-notification="${CSS.escape(id)}"]`);
      if (node !== null) act(node);
    });
  };
  const itemOf = (row: NotificationView): ItemScope | null => {
    if (row.ask === null || row.outcome !== null) return null;
    const taskId = taskIdSchema.parse(row.taskId);
    switch (row.ask.kind) {
      case "approval":
        return { kind: "approval", approvalId: approvalIdSchema.parse(row.ask.approvalId), taskId, key: row.key, deny: () => { inRow(row.id, (node) => { node.querySelector<HTMLElement>("[data-action='deny']")?.click(); }); } };
      case "question":
        return row.ask.driver !== null ? null : { kind: "question", questionId: questionIdSchema.parse(row.ask.questionId), taskId, key: row.key, reply: () => { inRow(row.id, (node) => { node.querySelector<HTMLElement>("textarea, input")?.focus(); }); } };
      case "plan":
        return null;
      default:
        return row.ask satisfies never;
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: NotificationView) => {
    if (event.target !== event.currentTarget) return;
    const index = order.indexOf(row.id);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = order[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next === undefined) return;
      event.preventDefault();
      setCurrent(next);
      nodes.current.get(next)?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (row.ask !== null && row.outcome === null) toggle(row.id);
      else window.location.assign(`/tasks/${row.taskId}`);
    } else if (event.key === "Escape" && open === row.id) {
      event.preventDefault();
      setExpanded(null);
      nodes.current.get(row.id)?.focus();
    }
  };
  return (
    <div className="flex flex-col gap-3" data-open-list>
      {groups.map((group) => (
        <section key={group.project.id} data-group={group.project.id}>
          <GroupBand group={group} />
          <ul>
            {group.rows.map((row) => phone ? (
              <PhoneItem
                key={row.id}
                row={shown(row)}
                now={now}
                answers={answers}
                onAnswered={(target, outcome) => { setAnswered((now) => new Map(now).set(target.id, outcome)); }}
              />
            ) : (
              <NotificationRow
                key={row.id}
                row={shown(row)}
                now={now}
                expanded={open === row.id}
                unreadDot={unreadAtLoad.has(row.id)}
                answers={answers}
                onToggle={toggle}
                onAnswered={(target, outcome) => {
                  setAnswered((now) => new Map(now).set(target.id, outcome));
                  setExpanded(null);
                }}
                focusRef={(node) => {
                  if (node === null) nodes.current.delete(row.id);
                  else nodes.current.set(row.id, node);
                }}
                onKeyDown={onKeyDown}
                tabbable={stop === row.id}
                onItemFocus={(target) => {
                  setCurrent(target.id);
                  scope.focus(itemOf(target));
                }}
                onItemBlur={scope.blur}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
};

/** The Done tab: one list, newest answer first, the project as a column, the outcome at the right. */
export const DoneList = ({ rows, now, onMore, hasMore }: { readonly rows: readonly NotificationView[]; readonly now: number; readonly onMore: () => void; readonly hasMore: boolean }) =>
  rows.length === 0 ? (
    <p className="mt-6 text-sm text-faint">{t("needsYouPage.doneEmpty")}</p>
  ) : (
    <>
      <ul data-done-list>
        {rows.map((row) => (
          <li key={row.id} className="grid min-h-10 grid-cols-[80px_minmax(0,1fr)_auto] items-center gap-x-2 border-b border-line md:grid-cols-[80px_minmax(0,1fr)_150px_44px_220px]">
            <Link href={`/tasks/${row.taskId}`} className="font-mono text-xs text-faint hover:underline">{row.key}</Link>
            <Link href={`/tasks/${row.taskId}`} className="min-w-0 truncate text-sm text-muted hover:underline">{row.title}</Link>
            <span className="hidden min-w-0 items-center gap-2 text-sm text-muted md:flex"><Square id={row.project.id} /><span className="truncate">{row.project.name}</span></span>
            <span className="hidden text-right font-mono text-xs text-faint md:block" suppressHydrationWarning>{formatAge(row.at, now)}</span>
            <span className="truncate text-right text-[12.5px] text-muted">{row.outcome === null ? "" : outcomeWords(row.outcome)}</span>
          </li>
        ))}
      </ul>
      {hasMore ? (
        <button type="button" onClick={onMore} className="mt-3 text-sm text-teal hover:underline">{t("needsYouPage.loadMore")}</button>
      ) : null}
    </>
  );

/** The Open tab with nothing in it: the Deep water picture and two lines. */
export const OpenEmpty = () => (
  <div className="mt-10 flex flex-col items-center text-center" data-open-empty>
    <img src="/inbox-empty-illustration.webp" alt="" width={560} height={373} className="aspect-[560/373] w-full max-w-[560px]" />
    <p className="mt-6 text-lede font-semibold text-text">{t("needsYouPage.empty")}</p>
    <p className="mt-2 text-sm text-muted">{t("needsYouPage.emptyBody")}</p>
  </div>
);

export type NeedsYouTab = "open" | "done";

export const NeedsYouTabs = ({ tab, onTab, openCount }: { readonly tab: NeedsYouTab; readonly onTab: (tab: NeedsYouTab) => void; readonly openCount: number | null }) => (
  <UnderlineTabs
    className="mt-4"
    idPrefix="needs-you"
    label={t("needsYouPage.tabsLabel")}
    selected={tab}
    onSelect={onTab}
    tabs={[
      { id: "open", label: t("needsYouPage.open"), ...(openCount === null ? {} : { extra: <span className="font-mono text-xs text-faint">{openCount}</span> }) },
      { id: "done", label: t("needsYouPage.done") },
    ]}
  />
);

export const NeedsYouLede = ({ unread }: { readonly unread: number | null }) =>
  unread === null ? <Skeleton className="mt-1 h-4 w-[320px]" /> : <span>{ledeWords(unread)}</span>;

export const ListSkeleton = () => (
  <div className="flex flex-col gap-3" aria-busy>
    {[0, 1].map((group) => (
      <div key={group}>
        <Skeleton className="h-[30px] w-full rounded-sm" />
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex h-10 items-center gap-4 border-b border-line">
            <Skeleton className="ml-6 w-[56px]" />
            <Skeleton className="w-[220px]" />
            <Skeleton className="ml-auto w-[200px]" />
          </div>
        ))}
      </div>
    ))}
  </div>
);

/** The properties panel: where these notifications reach the member (ticket 37's choices). */
export const ReachPanel = ({ reach }: { readonly reach: ReachView | null }) => {
  const dash = <span className="text-muted">–</span>;
  const email: ReactNode =
    reach === null ? dash : reach.email.kind === "on" ? (
      <span>
        <span className="block font-mono">{reach.email.address}</span>
        <span className="block text-xs text-muted">{t("needsYouPage.emailDelay", { n: reach.email.delayMinutes })}</span>
      </span>
    ) : reach.email.kind === "off" ? (
      <span className="text-muted">{t("needsYouPage.off")}</span>
    ) : (
      <span className="text-muted">{t("needsYouPage.mailOff")}</span>
    );
  return (
    <div data-reach>
      <PropGroup title={t("needsYouPage.reach")}>
        <PropRow label={t("needsYouPage.panel")} labelWidth={84}>{reach === null ? dash : t("needsYouPage.always")}</PropRow>
        <PropRow label={t("needsYouPage.ticket")} labelWidth={84}>
          {reach === null ? dash : reach.ticketOff || reach.tracker === null ? <span className="text-muted">{t("needsYouPage.off")}</span> : t("needsYouPage.ticketComment", { tracker: reach.tracker })}
        </PropRow>
        <PropRow label={t("needsYouPage.email")} labelWidth={84}>{email}</PropRow>
      </PropGroup>
      {reach !== null && reach.email.kind === "on" ? <p className="mt-2.5 text-xs text-faint">{t("needsYouPage.mailNote", { n: reach.email.delayMinutes })}</p> : null}
      <Link href="/account/notifications" className="mt-3 inline-block text-[12.5px] text-teal hover:underline">{t("needsYouPage.choices")}</Link>
    </div>
  );
};
