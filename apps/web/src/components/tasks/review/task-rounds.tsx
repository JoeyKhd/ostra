"use client";

import { CheckIcon, HandIcon, LoaderCircleIcon, PauseCircleIcon, XIcon } from "lucide-react";
import Link from "next/link";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { taskStateLine } from "../task-words";
import type { TaskReason, TaskLimit, TaskState } from "../task-words";

import { capBody, capTitle, roundOutcomeText, stagesOf } from "./review-words";
import type { CapKind, Limits, Stage, SubState, TaskRound } from "./review-words";

// The task page in review (app-targets/m6/task-rounds.md; F-035, F-101, F-105, ticket 35): the
// stage line under the status, "automatic turns N of 4", each round's outcome, the cap's needs-you
// with "Keep working", and the panel's Rounds group. Milestone 10 (ticket 12): what a round sent
// the agent by itself, and why, is its message's outlined bubble in the thread.

type Count = { readonly used: number; readonly limit: number };

const StageGlyph = ({ stage, needsYou, held }: { readonly stage: Stage; readonly needsYou: boolean; readonly held: boolean }) => {
  if (stage.state === "done") return <CheckIcon aria-hidden className="size-[14px] stroke-[2] text-green" />;
  if (stage.state === "current") {
    if (held) return <PauseCircleIcon aria-hidden className="size-[14px] stroke-[1.75] text-muted" />;
    return <span aria-hidden className={cn("inline-block size-2.5 rounded-full", needsYou ? "bg-amber" : "bg-text")} />;
  }
  return <span aria-hidden className="inline-block size-2.5 rounded-full border border-faint" />;
};

/** The five stages of the loop, joined by hairlines; at the right, the automatic turns. */
export const StageLine = ({ subState, aiReview, counts, needsYou, held }: {
  readonly subState: SubState;
  readonly aiReview: boolean;
  readonly counts: { readonly ci: Count; readonly review: Count; readonly automaticTurns: Count };
  readonly needsYou: boolean;
  readonly held: boolean;
}) => {
  const stages = stagesOf({ subState, aiReview, ci: counts.ci, review: counts.review });
  return (
    <div className="mt-2.5 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="stage-line" data-sub-state={subState ?? ""}>
      {/* Tight enough that the five stages and the turns fit one row beside the panel at 1440 (task-rounds.webp). */}
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {stages.map((stage, index) => (
          <li key={stage.id} className="flex items-center gap-1.5 whitespace-nowrap" data-stage={stage.id} data-state={stage.state}>
            {index > 0 ? <span aria-hidden className="h-px w-3 bg-line-2" /> : null}
            <StageGlyph stage={stage} needsYou={needsYou} held={held} />
            <span className={cn(stage.state === "current" ? "font-medium text-text" : stage.state === "done" ? "text-muted" : "text-faint")}>{stage.words}</span>
          </li>
        ))}
      </ol>
      {counts.automaticTurns.used === 0 ? null : (
        <Tooltip content={t("review.turnsHelp", { limit: counts.automaticTurns.limit })}>
          <span className="ml-auto whitespace-nowrap text-xs text-faint" data-testid="automatic-turns">
            {t("review.line.turns")} <span className="font-mono text-[13px] text-text">{t("review.line.turnsCount", { used: counts.automaticTurns.used, limit: counts.automaticTurns.limit })}</span>
          </span>
        </Tooltip>
      )}
    </div>
  );
};

/** The rounds in the thread, oldest first, then the cap's needs-you when the task stopped at one. */
export const RoundsInThread = ({ taskId, rounds, limits, cap, capInput, isDriver, driver, keep, onTakeOver }: {
  readonly taskId: string;
  readonly rounds: readonly TaskRound[];
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
  // Milestone 10 (F-151, ticket 12): each round is its message's outlined bubble in the thread (what it
  // sent, its round of its limit, its hold); its outcome stays here until the push's result line
  // carries the CI verdict (ticket 14). A round the cap stopped never ran: the cap's needs-you says so.
  const outcomes = rounds.flatMap((round) => {
    const outcome = round.state === "capped" ? null : roundOutcomeText(round.outcome, capInput.agent);
    return outcome === null ? [] : [{ key: `${round.kind}-${String(round.number)}-${String(round.createdAt)}`, outcome }];
  });
  if (outcomes.length === 0 && cap === null) return null;
  return (
    <div className="mt-4 space-y-3" data-testid="task-rounds">
      {outcomes.map(({ key, outcome }) => (
        <p key={key} className="text-ui text-muted" data-testid="round-outcome">{outcome}</p>
      ))}
      {cap === null ? null : (
        <div className={cn("border-l-2 pl-3", isDriver ? "border-amber" : "border-line-2")} role="region" aria-label={capTitle(cap)} data-testid="round-cap" data-cap={cap}>
          <p className={cn("flex items-center gap-1.5 text-sm font-semibold", isDriver ? "text-amber-text" : "text-muted")}>
            <HandIcon aria-hidden className="size-[14px] stroke-[1.75]" /> {capTitle(cap)}
          </p>
          <p className="mt-1 text-body text-text">{capBody(cap, { ...capInput, limits })}</p>
          {isDriver ? (
            <>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button variant="amber" disabled={keep.pending} onClick={keep.run} data-action="keep-working">{t("review.cap.keepWorking")}</Button>
                {cap === "ci" ? <Link href={`/tasks/${taskId}?tab=checks`} className={buttonVariants()}>{t("review.cap.openChecks")}</Link> : null}
                {cap === "findings" ? <Link href={reviewHref} className={buttonVariants()}>{t("review.cap.openReview")}</Link> : null}
              </div>
              <p className="mt-1.5 text-xs text-faint">{cap === "ci" ? t("review.cap.footCi", { agent: capInput.agent }) : cap === "findings" ? t("review.cap.footFindings", { agent: capInput.agent }) : t("review.cap.footTurns", { agent: capInput.agent })}</p>
              {keep.error === null ? null : <p role="alert" className="mt-1 text-sm text-red">{keep.error}</p>}
            </>
          ) : (
            <p className="mt-1.5 text-sm text-muted">
              {t("review.cap.driverDecides", { driver: driver ?? t("taskPage.someone") })}{" "}
              <Button variant="link" className="text-sm" onClick={onTakeOver}>{t("taskPage.takeOver")}</Button>
            </p>
          )}
        </div>
      )}
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

/** The Code group's `Head` and `CI` rows for a repo with a PR (task-rounds.md). */
export const CodeHeadRows = ({ headSha, ci }: { readonly headSha: string | null; readonly ci: { readonly state: "passed" | "failed" | "running" | "none"; readonly failing: string | null } | null }) => (
  <>
    <PropRow label={t("taskPage.head")}>
      <span className="font-mono text-ui" data-testid="code-head">{headSha === null ? "–" : headSha.slice(0, 7)}</span>
    </PropRow>
    <PropRow label={t("taskPage.ci")}>
      <span className="flex min-w-0 items-center gap-1.5 text-ui" data-testid="code-ci" data-ci={ci?.state ?? "none"}>
        {ci?.state === "passed" ? (
          <>
            <CheckIcon aria-hidden className="size-[14px] stroke-[1.75] text-green" />
            {t("taskPage.ciPassed")}
          </>
        ) : ci?.state === "failed" ? (
          <>
            <XIcon aria-hidden className="size-[14px] stroke-[1.75] text-red" />
            <span className="truncate">{ci.failing === null ? t("taskPage.ciFailed") : `${t("taskPage.ciFailed")} · ${ci.failing}`}</span>
          </>
        ) : ci?.state === "running" ? (
          <>
            <LoaderCircleIcon aria-hidden className="size-[14px] animate-spin stroke-[1.75] text-muted" />
            {t("taskPage.ciRunning")}
          </>
        ) : (
          <span className="text-faint">{t("taskPage.ciNone")}</span>
        )}
      </span>
    </PropRow>
  </>
);

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
