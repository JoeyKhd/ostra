"use client";

import { CheckIcon, HandIcon, LoaderCircleIcon, PauseCircleIcon, RefreshCcwIcon, XIcon } from "lucide-react";
import Link from "next/link";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import { taskStateLine } from "../task-words";
import type { TaskReason, TaskState } from "../task-words";

import { capBody, capTitle, findingsSentWords, releasedHoldText, roundName, roundOutcomeText, stagesOf } from "./review-words";
import type { CapKind, Limits, Stage, SubState, TaskRound } from "./review-words";

// The task page in review (app-targets/m6/task-rounds.md; F-035, F-101, F-105, ticket 35): the
// stage line under the status, "automatic turns N of 4", a card per round (what ostra sent the agent
// by itself, and why), the cap's needs-you with "Keep working", and the panel's Rounds group.

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

/** One round as a card: its name, its turn, and what it sent. */
export const RoundCard = ({ round, limits, reviewHref, taskId }: { readonly round: TaskRound; readonly limits: Limits; readonly reviewHref: string; readonly taskId: string }) => {
  const body = (() => {
    switch (round.cause.kind) {
      case "ci":
        return round.cause.failing.length === 0 ? (
          <p className="text-sm text-muted">{t("review.round.noFailing")}</p>
        ) : (
          <ul>
            {round.cause.failing.slice(0, 5).map((check) => (
              <li key={`${check.repo}-${check.name}`} className="flex min-h-[26px] items-center gap-2 text-sm">
                <XIcon aria-hidden className="size-[13px] shrink-0 text-red" />
                <span className="font-mono text-text">{check.name}</span>
                <span className="text-faint">{check.conclusion === "timed_out" ? t("review.round.timedOut") : check.conclusion === "cancelled" ? t("review.round.cancelled") : t("review.round.failed")}</span>
                {check.logFile === null ? (
                  <span className="text-faint">{t("review.round.noLog")}</span>
                ) : (
                  <Link href={`/tasks/${taskId}?tab=checks`} className="font-mono text-teal hover:underline" data-log={check.logFile}>{check.logFile}</Link>
                )}
              </li>
            ))}
            {round.cause.failing.length > 5 ? <li className="text-xs text-faint">{t("review.round.notSent", { n: round.cause.failing.length - 5 })}</li> : null}
          </ul>
        );
      case "findings":
        return (
          <p className="text-sm text-muted">
            {findingsSentWords(round.cause.findings)}{" "}
            <Link href={reviewHref} className="text-teal hover:underline">{t("review.round.openReview")}</Link>
          </p>
        );
      case "changes-requested":
        return <p className="text-sm text-muted">{t("review.round.changesSent", { name: round.cause.by?.name ?? t("taskPage.someone") })}</p>;
      default:
        return round.cause satisfies never;
    }
  })();
  return (
    <div className="flex gap-3" data-round={round.kind} data-number={round.number} data-state={round.state}>
      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full border border-line-2 text-muted">
        <RefreshCcwIcon className="size-[14px] stroke-[1.75]" />
      </span>
      <div className="min-w-0 flex-1 rounded-lg border border-line px-3.5 py-2.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-ui font-semibold text-text">{roundName(round, limits)}</span>
          <span className="font-mono text-xs text-faint">
            {formatClock(round.createdAt)}
            {round.automatic ? ` · ${t("review.round.automatic")}` : ""}
          </span>
        </div>
        <div className="mt-1">{body}</div>
        {round.state === "held" ? (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-faint">
            <PauseCircleIcon aria-hidden className="size-[13px]" />
            {round.heldReason?.scope === "organization" ? t("review.round.heldOrganization") : t("review.round.heldProject")}
          </p>
        ) : round.hold !== null && releasedHoldText(round.hold) !== null ? (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-faint" data-testid="round-released">
            <PauseCircleIcon aria-hidden className="size-[13px]" />
            {releasedHoldText(round.hold)}
          </p>
        ) : round.state === "capped" ? (
          <p className="mt-1.5 text-xs text-faint">{round.cappedReason === "spend-cap" ? t("review.round.cappedSpend") : t("review.round.capped")}</p>
        ) : null}
      </div>
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
  if (rounds.length === 0 && cap === null) return null;
  return (
    <div className="mt-4 space-y-3" data-testid="task-rounds">
      {/* A round the cap stopped never ran: the cap's needs-you below says so, not a card. */}
      {rounds.filter((round) => round.state !== "capped").map((round) => {
        const outcome = roundOutcomeText(round.outcome, capInput.agent);
        return (
          <div key={`${round.kind}-${String(round.number)}-${String(round.createdAt)}`} className="space-y-1.5">
            <RoundCard round={round} limits={limits} reviewHref={reviewHref} taskId={taskId} />
            {outcome === null ? null : <p className="pl-10 text-ui text-muted" data-testid="round-outcome">{outcome}</p>}
          </div>
        );
      })}
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
export const statusWithSubState = (task: { readonly state: TaskState; readonly reason: TaskReason; readonly subState: SubState }): string => {
  const line = taskStateLine(task.state, task.reason);
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
