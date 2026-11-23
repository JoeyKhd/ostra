"use client";

import { HourglassIcon, LoaderCircleIcon, ScanSearchIcon } from "lucide-react";
import Link from "next/link";

import { t } from "@/lib/messages";

import { aiReviewLine } from "./follow-up-words";
import type { AiReview } from "./follow-up-words";

// A follow-up and its code task on the task page (2026-11-21; F-100/c6, ADR 0059 amended;
// app-targets/m6/task-rounds.md's "AI review" state): a waiting review says why and where it may
// run, and the code task's thread ends with its AI review. Milestone 10 (ticket 15): what a review
// task reviews is its key line, its title and its top bar's `Open the code task` and `PR #n`.

/** The ` · ` between facts on a line, in `--faint`. */
const Sep = () => <span aria-hidden className="text-faint">·</span>;

/** A review waiting for a runner: why, where it may run, and the way out (Runners, for an admin). */
export const FollowUpWaiting = ({ words, codeTaskId, admin }: { readonly words: string; readonly codeTaskId: string; readonly admin: boolean }) => (
  <div className="mt-2.5 border-l-2 border-line-2 pl-3" data-testid="follow-up-waiting">
    <p className="text-body text-text">{t("review.followUp.waiting")}</p>
    <p className="text-ui text-muted">{words}</p>
    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-ui">
      <Link href={`/tasks/${codeTaskId}`} className="text-teal hover:underline">
        {t("review.followUp.openCodeTask")}
      </Link>
      {admin ? (
        <>
          <Sep />
          <Link href="/organization/runners" className="text-teal hover:underline" data-action="connect-runner">
            {t("review.followUp.connectRunner")}
          </Link>
        </>
      ) : null}
    </p>
  </div>
);

/** The code task's thread ends with its AI review: waiting for a runner, running, or its round's result. */
export const AiReviewLine = ({ review }: { readonly review: AiReview }) => {
  const line = aiReviewLine(review);
  if (line === null) return null;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 pl-10 text-ui text-muted" data-testid="ai-review-line" data-state={line.state}>
      {line.state === "waiting" ? (
        <HourglassIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75] text-faint" />
      ) : line.state === "running" ? (
        <LoaderCircleIcon aria-hidden className="size-[13px] shrink-0 animate-spin stroke-[1.75] text-muted" />
      ) : (
        <ScanSearchIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75] text-faint" />
      )}
      <span>{line.text}</span>
      <Sep />
      <Link href={`/tasks/${review.taskId}`} className="text-teal hover:underline">
        {t("review.followUp.openReviewTask")}
      </Link>
    </p>
  );
};
