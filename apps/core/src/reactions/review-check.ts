import { evaluateReviewCheck } from "@ostra/domain";
import type { ReviewCheckDeps } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";

// The independent-review check's job (F-104, ADR 0040 amended; milestone 4's ticket 18):
// `review.evaluate`, keyed by the PR and its head, enqueued by a review, a new head, a PR ostra
// opened, a GitHub link or unlink, a new trailer and the PR reconcile. The evaluation is the
// domain's `evaluateReviewCheck`; a code host failure throws, so the queue retries it.

export const reviewEvaluateHandler =
  (deps: Omit<ReviewCheckDeps, "logger">): JobHandler<"review.evaluate"> =>
  async (context) => {
    const result = await evaluateReviewCheck({ ...deps, logger: context.logger }, context.payload);
    if (!result.ok) {
      context.logger.info("review.evaluate-skipped", { taskRepoId: context.payload.taskRepoId, prNumber: context.payload.prNumber, error: result.error });
      return;
    }
    context.logger.info("review.evaluated", {
      taskRepoId: context.payload.taskRepoId,
      prNumber: context.payload.prNumber,
      status: result.verdict.status,
      outcome: result.outcome,
    });
  };
