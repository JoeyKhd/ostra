import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { waitReasonText } from "../task-waiting-words";
import type { Reason, WaitContext } from "../task-waiting-words";
import { aiReviewWords } from "./review-words";

// A follow-up and its code task on the task page (2026-11-21; F-100/c6, ADR 0059 amended): what a
// review task reviews, why it waits for a runner and where it may run, and on the code task's page
// how its AI review is doing. Every word from `messages/en.json`.

type Task = RouterOutputs["tasks"]["get"];
export type ReviewOf = NonNullable<Task["reviewOf"]>;
export type AiReview = NonNullable<Task["aiReview"]>;

/**
 * Why a review waits, when a runner is why: where it may run and what holds it. `null` for a wait
 * the page words in its own block (a model, a key, a budget, an installation, services).
 */
export const followUpWaitWords = (reason: Reason, context: WaitContext): string | null => {
  const pools = t("review.followUp.waitsPools", { project: context.project });
  switch (reason.code) {
    case "follow-up-waits": {
      const values = { runner: reason.runner.name, project: context.project };
      switch (reason.personal) {
        case "busy":
          return t("review.followUp.waitsBusy", values);
        case "offline":
          return t("review.followUp.waitsOffline", values);
        case "outdated":
          return t("review.followUp.waitsOutdated", values);
        case "not-allowed":
          return t("review.followUp.waitsNotAllowed", values);
        default:
          return reason.personal satisfies never;
      }
    }
    case "no-runner-online":
      return pools;
    case "queued":
    case "pool-full":
    case "project-share-reached":
    case "no-runner-with-labels":
    case "size-too-large":
    case "needs-registry":
    case "needs-protocol":
    case "personal-runner-unavailable":
    case "offer-declined":
    case "offer-timed-out":
      return `${pools} ${waitReasonText(reason, context)}`;
    case "no-model":
    case "provider-held":
    case "provider-cap":
    case "personal-runner-not-allowed":
    case "needs-services":
    case "needs-services-runner":
    case "no-provider-for-model":
    case "provider-not-allowed":
    case "budget-reached":
    case "model-unpriced":
    case "installation-not-linked":
      return null;
    default:
      return reason satisfies never;
  }
};

/** The PR a review reads, as its line names it: `PR #14`. */
export const reviewedPrText = (pr: ReviewOf["prs"][number]): string => t("review.followUp.pr", { number: pr.number });

/** A review run's result once it has one (`AI review round 2: nothing blocking`); `null` while it runs. */
export const reviewResultText = (run: ReviewOf["run"]): string | null => (run === null || run.state === "running" ? null : aiReviewWords(true, [run]));

/** The AI review's state on its code task's page: waiting for a runner, running, or its round's result. */
export const aiReviewLine = (review: AiReview): { readonly state: "waiting" | "running" | "result"; readonly text: string } | null => {
  switch (review.state) {
    case "queued":
      return { state: "waiting", text: t("review.followUp.lineWaiting") };
    case "preparing":
    case "running":
    case "needs_you":
    case "awaiting_approval":
      return { state: "running", text: t("review.followUp.lineRunning") };
    case "in_review":
    case "merged":
    case "done":
    case "stopped": {
      if (review.run === null) return null;
      if (review.run.state === "running") return { state: "result", text: t("review.followUp.lineStopped") };
      return { state: "result", text: aiReviewWords(true, [review.run]) ?? t("review.followUp.lineStopped") };
    }
    default:
      return review.state satisfies never;
  }
};
