"use client";

import { ChevronRightIcon, CircleDollarSignIcon, CircleXIcon, PauseCircleIcon, TimerOffIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { approvalMetadataSchema } from "@ostra/task-view";
import type { TurnFailure, TurnNotice } from "@ostra/task-view";

import { t } from "@/lib/messages";

import { useTaskContext, useToolPart } from "../task-context";
import { useRunOpen } from "./run-open";
import { useThreadParts } from "./thread-context";
import { failureWords, noticeWords } from "./words";
import type { NoticeActionKind } from "./words";

// Owner: ticket 10 (milestone 10, F-151: a failure the turn didn't recover from, and a stop that
// isn't an error, parts.md part 7). The red line under its run: `circle-x` and the words in
// `--red`, the subject mono `--text-2`, what happened `--muted`, and a teal `output ›` / `details ›`
// that opens the run at that step with its output open. A failed turn, a crashed session and a
// lost box are the same line without a subject or link. A limit, a budget hold and an approval
// nobody answered in time are the quiet line (`.notice`): icon and words `--muted`, the action teal.

/** A failure's `output ›` / `details ›`: 13px teal, a 12px chevron. */
const LINK = "inline-flex shrink-0 items-center gap-px text-sm text-teal hover:underline";
/** A notice's action: teal, at the notice's own 14px. */
const ACTION = "shrink-0 text-ui text-teal hover:underline";

/**
 * A failure's own line. `retried`: a later step of the same kind and subject in the turn failed too,
 * so a fetch's line doesn't say `not retried`.
 */
export const FailureLine = ({ failure, retried = false }: { readonly failure: TurnFailure; readonly retried?: boolean }) => {
  const { agent } = useTaskContext();
  const { store } = useRunOpen();
  const words = failureWords(failure, t, { agent: agent.name, retried });
  const step = failure.cause === "step" ? failure.step : null;
  return (
    <div data-part="failure" data-cause={failure.cause} className="-mt-0.5 mb-2 flex min-h-7 min-w-0 items-center gap-2 whitespace-nowrap text-ui text-muted">
      <CircleXIcon aria-hidden className="size-[14px] shrink-0 text-red" />
      <span className="shrink-0 text-red">{words.title}</span>
      {words.subject === null ? null : <span className="min-w-0 shrink truncate font-mono text-[13px] text-text-2" title={step?.fullSubject ?? words.subject}>{words.subject}</span>}
      {words.detail === null ? null : <span className="min-w-0 truncate text-muted">· {words.detail}</span>}
      {words.link === null || step === null ? null : (
        <button type="button" aria-label={words.link.name} onClick={() => { store.reveal(step.id); }} className={LINK}>
          {words.link.label}
          <ChevronRightIcon aria-hidden className="size-3" />
        </button>
      )}
    </div>
  );
};

/** A notice's icon: a session's time running out, the spend cap, a budget hold. */
const noticeIcon = (notice: TurnNotice): ReactNode => {
  switch (notice.cause) {
    case "limit":
      return notice.limit.limit === "spend-cap" ? <CircleDollarSignIcon /> : <TimerOffIcon />;
    case "held":
      return <PauseCircleIcon />;
    case "approval-expired":
      return <TimerOffIcon />;
    default:
      return notice satisfies never;
  }
};

/**
 * Where a limit's action is: the needs-you block at the thread's end that reopens the task (or says
 * who can raise the cap). The action takes the member there, while the task still waits on it.
 */
const toLimitBlock = (from: HTMLElement): void => {
  const block = from.ownerDocument.querySelector<HTMLElement>("[data-need='limit']");
  if (block === null) return;
  block.scrollIntoView({ block: "center" });
  (block.querySelector<HTMLElement>("button, a[href]") ?? block).focus({ preventScroll: true });
};

/** Whether the page holds a limit's needs-you block: the task still waits on the limit. */
const useLimitBlock = (): boolean => {
  const [present, setPresent] = useState(false);
  useEffect(() => {
    const check = (): void => { setPresent(document.querySelector("[data-need='limit']") !== null); };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); };
  }, []);
  return present;
};

/** `Keep working` and `Raise the cap`: to the limit's block, while the task waits on it. */
const ToLimit = ({ kind, label }: { readonly kind: NoticeActionKind; readonly label: string }) =>
  useLimitBlock() ? (
    <button type="button" onClick={(event) => { toLimitBlock(event.currentTarget); }} className={ACTION} data-action={kind}>
      {label}
    </button>
  ) : null;

/** An approval nobody answered in time that can still be answered: its card, under the notice, once asked for. */
const AnswerAnyway = ({ toolCallId, label }: { readonly toolCallId: string | null; readonly label: string }) => {
  const { approvalCard } = useTaskContext();
  const part = useToolPart(toolCallId ?? "");
  const [open, setOpen] = useState(false);
  const metadata = approvalMetadataSchema.safeParse(part?.toolMetadata);
  const card = metadata.success ? (approvalCard?.(metadata.data.approval.id) ?? null) : null;
  if (card === null) return null;
  return (
    <>
      {open ? null : (
        <button type="button" aria-expanded={false} onClick={() => { setOpen(true); }} className={ACTION} data-action="answer-anyway">
          {label}
        </button>
      )}
      {open ? <div className="basis-full whitespace-normal">{card}</div> : null}
    </>
  );
};

const NoticeAction = ({ kind, label, notice }: { readonly kind: NoticeActionKind; readonly label: string; readonly notice: TurnNotice }) => {
  switch (kind) {
    case "open-spend":
      return <Link href="/organization/spend" className={ACTION} data-action="open-spend">{label}</Link>;
    case "answer-anyway":
      return notice.cause === "approval-expired" ? <AnswerAnyway toolCallId={notice.step.toolCallId} label={label} /> : null;
    case "keep-working":
    case "raise-cap":
      return <ToLimit kind={kind} label={label} />;
    default:
      return kind satisfies never;
  }
};

/** A stop that isn't an error (`.notice`): a session limit, a budget hold, an approval nobody answered in time. */
export const NoticeLine = ({ notice }: { readonly notice: TurnNotice }) => {
  const { project, capMicroUsd } = useThreadParts();
  const words = noticeWords(notice, t, { project, capMicroUsd });
  return (
    <div data-part="notice" data-cause={notice.cause} className="mb-2 mt-0.5 flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 text-ui text-muted">
      <span aria-hidden className="flex shrink-0 text-muted [&_svg]:size-[14px]">{noticeIcon(notice)}</span>
      <span className="min-w-0">{words.text}</span>
      {words.action === null ? null : <NoticeAction kind={words.action.kind} label={words.action.label} notice={notice} />}
    </div>
  );
};
