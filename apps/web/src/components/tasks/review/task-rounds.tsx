"use client";

import { HandIcon } from "lucide-react";
import Link from "next/link";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { taskStateLine } from "../task-words";
import type { TaskReason, TaskLimit, TaskState } from "../task-words";

import { capBody, capTitle } from "./review-words";
import type { CapKind, Limits, SubState } from "./review-words";

// The task page in review (app-targets/m6/task-rounds.md; F-035, F-101, F-105, ticket 35): the
// stage line under the status, "automatic turns N of 4", the cap's needs-you with "Keep working",
// and the panel's Rounds group. Milestone 10: what a round sent the agent by itself, and why, is its
// message's outlined bubble in the thread (ticket 12); its outcome, its turn's push line (ticket 14).

type Count = { readonly used: number; readonly limit: number };

/** The cap's needs-you at the thread's end, when the task stopped at a round's limit. */
export const RoundsInThread = ({ taskId, limits, cap, capInput, isDriver, driver, keep, onTakeOver }: {
  readonly taskId: string;
  readonly limits: Limits;
  /** The cap the task waits at (`round_cap`), or `null`. */
  readonly cap: CapKind | null;
  readonly capInput: { readonly agent: string; readonly failing: string | null; readonly blocking: number };
  readonly isDriver: boolean;
  readonly driver: string | null;
  readonly keep: { readonly run: () => void; readonly pending: boolean; readonly error: string | null };
  readonly onTakeOver: () => void;
}) => {
  const reviewHref = `/tasks/${taskId}/review`;
  // Milestone 10 (F-151, tickets 12 and 14): each round is its message's outlined bubble in the thread
  // (what it sent, its round of its limit, its hold), and its outcome is its turn's push line, with
  // CI's verdict once it says (`Pushed 9a03d1e · CI passed`). A round the cap stopped never ran: the
  // cap's needs-you says so.
  if (cap === null) return null;
  return (
    <div className="mt-4 space-y-3" data-testid="task-rounds">
      {/* Milestone 10 (ticket 13, parts.md part 11, `states-asks.md` cell 6): milestone 6's copy and buttons at the thread's needs-you sizes. */}
      <div className={cn("mb-2 mt-3 border-l-(length:--rule-needs-you) py-0.5 pl-[14px]", isDriver ? "border-amber" : "border-line-2")} role="region" aria-label={capTitle(cap)} data-testid="round-cap" data-cap={cap} data-waits={isDriver ? "other" : undefined}>
        <p className={cn("flex items-center gap-2 text-ui font-semibold", isDriver ? "text-amber-text" : "text-muted")}>
          <HandIcon aria-hidden className="size-[14px] stroke-[1.75]" /> {capTitle(cap)}
        </p>
        <p className="mt-[5px] text-body leading-[1.55] text-text">{capBody(cap, { ...capInput, limits })}</p>
        {isDriver ? (
          <>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" variant="amber" className="h-7" disabled={keep.pending} onClick={keep.run} data-action="keep-working">{t("review.cap.keepWorking")}</Button>
              {cap === "ci" ? <Link href={`/tasks/${taskId}?tab=checks`} className={cn(buttonVariants({ size: "sm" }), "h-7")}>{t("review.cap.openChecks")}</Link> : null}
              {cap === "findings" ? <Link href={reviewHref} className={cn(buttonVariants({ size: "sm" }), "h-7")}>{t("review.cap.openReview")}</Link> : null}
            </div>
            <p className="mt-2 text-sm text-faint">{cap === "ci" ? t("review.cap.footCi", { agent: capInput.agent }) : cap === "findings" ? t("review.cap.footFindings", { agent: capInput.agent }) : t("review.cap.footTurns", { agent: capInput.agent })}</p>
            {keep.error === null ? null : <p role="alert" className="mt-1 text-sm text-red">{keep.error}</p>}
          </>
        ) : (
          <p className="mt-1.5 text-sm text-muted">
            {t("review.cap.driverDecides", { driver: driver ?? t("taskPage.someone") })}{" "}
            <Button variant="link" className="text-sm" onClick={onTakeOver}>{t("taskPage.takeOver")}</Button>
          </p>
        )}
      </div>
    </div>
  );
};

/**
 * The Status row in review (task-rounds.md): the state, then the sub-state the loop is at
 * (`In review · CI running`); a needs-you or any other state keeps its own line.
 */
export const statusWithSubState = (task: { readonly state: TaskState; readonly reason: TaskReason; readonly subState: SubState; readonly limit?: TaskLimit }): string => {
  const line = taskStateLine(task.state, task.reason, task.limit ?? null);
  if (task.state !== "in_review" || task.subState === null) return line;
  switch (task.subState) {
    case "ci_running":
      return t("review.statusSub.ciRunning", { state: line });
    case "fixing_ci":
      return t("review.statusSub.fixingCi", { state: line });
    case "ai_review":
      return t("review.statusSub.aiReview", { state: line });
    case "fixing_findings":
      return t("review.statusSub.fixingFindings", { state: line });
    case "waiting_for_reviewer":
      return t("review.statusSub.waitingForReviewer", { state: line });
    default:
      return task.subState satisfies never;
  }
};

/** The panel's Rounds group: each count of its limit since a person last acted, and a hold. */
export const RoundsGroup = ({ counts, aiReview, since, held }: {
  readonly counts: { readonly ci: Count; readonly review: Count; readonly automaticTurns: Count };
  readonly aiReview: boolean;
  /** When a person last acted (a clock time), or `null` before anyone did. */
  readonly since: string | null;
  readonly held: boolean;
}) => {
  const value = (count: Count) => (
    <span className={cn("font-mono", count.used >= count.limit ? "font-medium text-text" : "")}>{t("review.line.turnsCount", { used: count.used, limit: count.limit })}</span>
  );
  return (
    <PropGroup
      title={
        <span className="flex items-center justify-between gap-2">
          <span>{t("review.panel.rounds")}</span>
          <span className="font-normal">{since === null ? t("review.panel.sinceStart") : t("review.panel.since", { time: since })}</span>
        </span>
      }
    >
      <div data-testid="rounds-group">
        <PropRow labelWidth={124} label={t("review.panel.roundsCi")}>{value(counts.ci)}</PropRow>
        {aiReview ? <PropRow labelWidth={124} label={t("review.panel.roundsFindings")}>{value(counts.review)}</PropRow> : null}
        <PropRow labelWidth={124} label={t("review.panel.roundsTurns")}>{value(counts.automaticTurns)}</PropRow>
        {held ? <PropRow labelWidth={124} label={t("review.panel.held")}><span>{t("review.panel.heldNow")}</span></PropRow> : null}
      </div>
    </PropGroup>
  );
};
