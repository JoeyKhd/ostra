import { plural, t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The review loop's words (app-targets/m6/review-screen.md, task-rounds.md, review-settings.md;
// F-035, F-100, F-101, F-102, ticket 35): the round line, the stages, a round's card, the cap's
// needs-you and a reviewer's state. Pure, so each is tested on its own.

export type ReviewScreen = RouterOutputs["review"]["screen"];
export type ReviewPr = ReviewScreen["prs"][number];
export type ReviewFinding = ReviewPr["findings"][number];
export type ReviewRun = ReviewScreen["reviewRuns"][number];
export type TaskRounds = RouterOutputs["tasks"]["rounds"];
export type TaskRound = TaskRounds["rounds"][number];
export type SubState = ReviewScreen["subState"];
export type CiState = NonNullable<ReviewPr["ci"]>["state"];
export type Limits = TaskRounds["limits"];

type Count = { readonly used: number; readonly limit: number };

/** The sub-state in words: the stage the review loop is at. */
export const subStateWords = (subState: SubState, rounds: { readonly ci: Count; readonly review: Count }): string | null => {
  switch (subState) {
    case null:
      return null;
    case "ci_running":
      return t("review.stage.ciRunning");
    case "fixing_ci":
      return t("review.stage.fixingCi", { n: Math.max(1, rounds.ci.used), limit: rounds.ci.limit });
    case "ai_review":
      return t("review.stage.aiReview");
    case "fixing_findings":
      return t("review.stage.fixingFindings", { n: Math.max(1, rounds.review.used), limit: rounds.review.limit });
    case "waiting_for_reviewer":
      return t("review.stage.waitingForReviewer");
    default:
      return subState satisfies never;
  }
};

const monthOf = (at: number): string => new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(at);

/** How long a hold lasted: `9 min`, `2 h`, `1 d`. */
const heldFor = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return t("units.minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48 ? t("units.hours", { n: hours }) : t("units.days", { n: Math.round(hours / 24) });
};

/**
 * A released hold's line (task-rounds.md): `Held 9 min: the project's budget for November was
 * reached. Released when Alex Kim raised it.` (or `…when December began.`); `null` while it holds.
 */
export const releasedHoldText = (hold: NonNullable<TaskRound["hold"]>): string | null => {
  if (hold.releasedAt === null) return null;
  const month = monthOf(hold.heldAt);
  const head = hold.scope === "organization" ? t("review.round.releasedOrganization", { duration: heldFor(hold.releasedAt - hold.heldAt), month }) : t("review.round.releasedProject", { duration: heldFor(hold.releasedAt - hold.heldAt), month });
  const tail =
    hold.releasedByName !== null
      ? t("review.round.releasedBy", { name: hold.releasedByName })
      : monthOf(hold.releasedAt) !== month
        ? t("review.round.releasedMonth", { month: monthOf(hold.releasedAt) })
        : t("review.round.released");
  return `${head} ${tail}`;
};

/**
 * The round's outcome after its card: `OpenCode pushed 3f9c21a. CI passed.`, or `The turn ended
 * without a push.`; `null` while the turn runs.
 */
export const roundOutcomeText = (outcome: TaskRound["outcome"], agent: string): string | null => {
  if (outcome === null) return null;
  if (outcome.kind === "no-push") return t("review.round.noPush");
  const sha = outcome.headSha.slice(0, 7);
  const { ci, failing } = outcome;
  switch (ci) {
    case "passed":
      return t("review.round.pushedPassed", { agent, sha });
    case "failed":
    case "timed_out":
      return failing === null ? t("review.round.pushedFailedNoCheck", { agent, sha }) : t("review.round.pushedFailed", { agent, sha, check: failing });
    case "pending":
    case "none":
      return t("review.round.pushed", { agent, sha });
    default:
      return ci satisfies never;
  }
};

/** The latest CI verdict on a PR's head. */
export const ciWords = (state: CiState | null): string | null => {
  switch (state) {
    case null:
      return null;
    case "pending":
      return t("review.ci.running");
    case "passed":
      return t("review.ci.passed");
    case "failed":
      return t("review.ci.failed");
    case "none":
      return t("review.ci.none");
    case "timed_out":
      return t("review.ci.timedOut");
    default:
      return state satisfies never;
  }
};

/** The review screen's CI row: its mark and its words. `quiet` rows are `--faint`, with no mark. */
export type PrCiRow = { readonly mark: "passed" | "failed" | "running" | "quiet"; readonly words: string };

const passingConclusions: readonly string[] = ["success", "neutral", "skipped"];

/**
 * The PR group's CI row (F-102, F-151/c6): the code host's CI on the PR's head, counted in jobs
 * (`Passed · 3 jobs`), a failure naming its failing jobs (`Failed · e2e, lint`).
 */
export const prCiRow = (ci: ReviewPr["ci"]): PrCiRow => {
  if (ci === null) return { mark: "quiet", words: t("review.ci.none") };
  switch (ci.state) {
    case "passed":
      return { mark: "passed", words: plural(ci.checks.length, "review.panel.ciPassed.one", "review.panel.ciPassed.other") };
    case "failed": {
      const failing = ci.checks.filter((job) => job.conclusion !== null && !passingConclusions.includes(job.conclusion));
      return { mark: "failed", words: t("review.panel.ciFailed", { jobs: failing.map((job) => job.name).join(", ") }) };
    }
    case "pending":
      return { mark: "running", words: t("review.ci.running") };
    case "none":
      return { mark: "quiet", words: t("review.ci.none") };
    case "timed_out":
      return { mark: "quiet", words: t("review.ci.timedOut") };
    default:
      return ci.state satisfies never;
  }
};

/** The AI review's part of the round line: off, running, or the newest round's result. */
export const aiReviewWords = (aiReview: boolean, runs: readonly Pick<ReviewRun, "round" | "state" | "blocking">[]): string | null => {
  if (!aiReview) return t("review.ai.off");
  const last = runs.at(-1);
  if (last === undefined) return null;
  if (last.state === "running") return t("review.ai.running");
  if (last.state === "failed") return t("review.ai.failed", { n: last.round });
  return last.blocking === 0 ? t("review.ai.nothingBlocking", { n: last.round }) : t("review.ai.blocking", { n: last.round, b: last.blocking });
};

/** Who the round line's dot speaks to: a reviewer still to review sees amber, one who approved green. */
export type ViewerReview = "to-review" | "approved" | "other";

export const viewerReview = (prs: readonly Pick<ReviewPr, "state" | "reviewers">[], meId: string | null): ViewerReview => {
  if (meId === null) return "other";
  const mine = prs.flatMap((pr) => pr.reviewers.filter((reviewer) => reviewer.member?.memberId === meId));
  if (mine.length === 0) return "other";
  return mine.every((reviewer) => reviewer.state === "approved") ? "approved" : "to-review";
};

/** A reviewer's state at the row's right. */
export const reviewerStateWords = (reviewer: Pick<ReviewPr["reviewers"][number], "state" | "team" | "source">): string => {
  if (reviewer.team !== null) return reviewer.source === "codeowners" ? t("review.reviewer.teamCodeowners") : t("review.reviewer.teamRequested");
  // A review state GitHub adds later reads as requested.
  if (reviewer.state === "approved") return t("review.reviewer.approved");
  if (reviewer.state === "changes_requested") return t("review.reviewer.changesRequested");
  if (reviewer.state === "commented") return t("review.reviewer.commented");
  return t("review.reviewer.requested");
};

/** A finding's state chip: a resolved one names the round that found it fixed (`Resolved in round 2`). */
export const findingStateWords = (finding: Pick<ReviewFinding, "state" | "resolvedInRound">): string => {
  switch (finding.state) {
    case "open":
      return t("review.finding.open");
    case "resolved":
      return finding.resolvedInRound === null ? t("review.finding.resolved") : t("review.finding.resolvedIn", { n: finding.resolvedInRound });
    case "outdated":
      return t("review.finding.outdated");
    default:
      return finding.state satisfies never;
  }
};

/**
 * The line above the diff while a new review runs (review-screen.md, "AI review running"): `A new
 * review is running on 3f9c21a. These findings are from round 2.`, with the head it runs on for the
 * PR's repo and the last finished round's number. `null` when no review runs on this PR, or none
 * finished before it (no findings to explain).
 */
export const reviewRunningText = (runs: readonly Pick<ReviewRun, "round" | "state" | "heads">[], repoId: string): string | null => {
  const last = runs.at(-1);
  if (last?.state !== "running") return null;
  const head = last.heads.find((one) => one.repoId === repoId);
  const finished = runs.findLast((run) => run.round < last.round && (run.state === "posted" || run.state === "submitted"));
  if (head === undefined || finished === undefined) return null;
  return t("review.ai.newRunning", { sha: head.headSha.slice(0, 7), n: finished.round });
};

/** The AI review's line in the PR's panel group: what's open and what's resolved. */
export const findingsSummary = (aiReview: boolean, findings: readonly Pick<ReviewFinding, "state" | "severity">[]): string => {
  if (!aiReview) return t("review.panel.aiOff");
  if (findings.length === 0) return t("review.panel.nothingFound");
  const open = findings.filter((finding) => finding.state === "open");
  const blocking = open.filter((finding) => finding.severity === "blocking").length;
  const nits = open.length - blocking;
  const resolved = findings.filter((finding) => finding.state === "resolved").length;
  const parts = [
    ...(blocking === 0 ? [] : [plural(blocking, "review.panel.blockingOpen.one", "review.panel.blockingOpen.other")]),
    ...(nits === 0 ? [] : [plural(nits, "review.panel.nitsOpen.one", "review.panel.nitsOpen.other")]),
    ...(resolved === 0 ? [] : [t("review.panel.resolved", { n: resolved })]),
  ];
  return parts.length === 0 ? t("review.panel.nothingOpen") : parts.join(" · ");
};

// ---------- the task page: stages, rounds, the cap ----------

export type StageState = "done" | "current" | "ahead";
export type Stage = { readonly id: NonNullable<SubState>; readonly words: string; readonly state: StageState };

const ORDER: readonly NonNullable<SubState>[] = ["ci_running", "fixing_ci", "ai_review", "fixing_findings", "waiting_for_reviewer"];

/**
 * The stage line: the five stages, or three with the AI review off. A stage before the current one
 * is done only when it happened in this pass (CI fixed, findings fixed); one passed over stays ahead.
 */
export const stagesOf = (input: { readonly subState: SubState; readonly aiReview: boolean; readonly ci: Count; readonly review: Count }): readonly Stage[] => {
  const shown = ORDER.filter((id) => input.aiReview || (id !== "ai_review" && id !== "fixing_findings"));
  const at = input.subState === null ? -1 : shown.indexOf(input.subState);
  return shown.map((id, index) => {
    const happened = id === "fixing_ci" ? input.ci.used > 0 : id === "fixing_findings" ? input.review.used > 0 : true;
    const state: StageState = index === at ? "current" : index < at && happened ? "done" : "ahead";
    const words =
      id === "fixing_ci"
        ? state === "ahead" && input.ci.used === 0
          ? t("review.stage.fixingCiPlain")
          : t("review.stage.fixingCi", { n: Math.max(1, input.ci.used), limit: input.ci.limit })
        : id === "fixing_findings"
          ? state === "ahead" && input.review.used === 0
            ? t("review.stage.fixingFindingsPlain")
            : t("review.stage.fixingFindings", { n: Math.max(1, input.review.used), limit: input.review.limit })
          : (subStateWords(id, input) ?? "");
    return { id, words, state };
  });
};

/** A round card's name. */
export const roundName = (round: Pick<TaskRound, "kind" | "number" | "cause">, limits: Limits): string => {
  switch (round.kind) {
    case "ci":
      return t("review.round.ci", { n: round.number, limit: limits.ciRounds });
    case "findings":
      return t("review.round.findings", { n: round.number, limit: limits.reviewRounds });
    case "changes-requested":
      return round.cause.kind === "changes-requested" && round.cause.by !== null ? t("review.round.changesBy", { name: round.cause.by.name }) : t("review.round.changes");
    default:
      return round.kind satisfies never;
  }
};

/** The findings round's one line: the blocking findings it sent, by title, and the nits it listed. */
export const findingsSentWords = (findings: readonly { readonly title: string; readonly severity: "blocking" | "nit" }[]): string => {
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  const nits = findings.length - blocking.length;
  const titles = blocking.slice(0, 3).map((finding) => finding.title).join(", ");
  const more = blocking.length > 3 ? t("review.round.andMore", { n: blocking.length - 3 }) : "";
  const sent = blocking.length === 0 ? t("review.round.sentNone") : plural(blocking.length, "review.round.sent.one", "review.round.sent.other", { titles: `${titles}${more}` });
  return nits === 0 ? sent : `${sent} ${plural(nits, "review.round.nits.one", "review.round.nits.other")}`;
};

/** Which cap the task stopped at, from its rounds: the newest capped round's reason and kind. */
export type CapKind = "ci" | "findings" | "turns";

export const capOf = (rounds: readonly Pick<TaskRound, "kind" | "state" | "cappedReason">[]): CapKind | null => {
  const capped = rounds.findLast((round) => round.state === "capped");
  if (capped === undefined) return null;
  if (capped.cappedReason === "automatic-turns") return "turns";
  return capped.kind === "ci" ? "ci" : "findings";
};

export const capTitle = (cap: CapKind): string => {
  switch (cap) {
    case "ci":
      return t("review.cap.titleCi");
    case "findings":
      return t("review.cap.titleFindings");
    case "turns":
      return t("review.cap.titleTurns");
    default:
      return cap satisfies never;
  }
};

export const capBody = (cap: CapKind, input: { readonly agent: string; readonly limits: Limits; readonly failing: string | null; readonly blocking: number }): string => {
  switch (cap) {
    case "ci":
      return input.failing === null
        ? t("review.cap.bodyCi", { limit: input.limits.ciRounds, agent: input.agent })
        : t("review.cap.bodyCiCheck", { limit: input.limits.ciRounds, agent: input.agent, check: input.failing });
    case "findings":
      return t("review.cap.bodyFindings", { b: input.blocking, limit: input.limits.reviewRounds, agent: input.agent });
    case "turns":
      return t("review.cap.bodyTurns", { limit: input.limits.automaticTurns });
    default:
      return cap satisfies never;
  }
};
