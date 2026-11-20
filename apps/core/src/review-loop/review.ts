import { postReview, startReview } from "@ostra/domain";
import type { ReviewDeps } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";

// The AI review's jobs (F-100, ADR 0028 amended, ADR 0058; milestone 6's ticket 17):
// - `review.start`, keyed by the code task and the round: the code task's one review task, made
//   at its first review and reopened per round on every open PR's current head, read-only, on the
//   project's review profile, dispatched through the budget gate as an automatic round;
// - `review.post`, per review run and repo: one comment-type review per PR, the findings on the
//   PR's diff as line comments and the rest in its body, then the loop's next step.
// Both are the domain's. A code host failure throws, so the queue retries it. A finding's text,
// the summary and a review's body never reach a log line: the lines carry IDs and counts.

export const reviewStartHandler =
  (deps: Omit<ReviewDeps, "logger">): JobHandler<"review.start"> =>
  async (context) => {
    const result = await startReview({ ...deps, logger: context.logger }, context.payload);
    if (!result.ok) {
      context.logger.info("review.start-skipped", { codeTaskId: context.payload.codeTaskId, round: context.payload.round, error: result.error });
      return;
    }
    context.logger.info("review.start-done", { codeTaskId: context.payload.codeTaskId, round: context.payload.round, reviewRunId: result.reviewRunId, reviewTaskId: result.reviewTaskId, created: result.created, held: result.held });
  };

export const reviewPostHandler =
  (deps: Omit<ReviewDeps, "logger">): JobHandler<"review.post"> =>
  async (context) => {
    const result = await postReview({ ...deps, logger: context.logger }, context.payload);
    if (!result.ok) {
      context.logger.info("review.post-skipped", { reviewRunId: context.payload.reviewRunId, repoId: context.payload.repoId, error: result.error });
      return;
    }
    context.logger.info("review.post-done", { reviewRunId: context.payload.reviewRunId, repoId: context.payload.repoId, lineComments: result.lineComments, inBody: result.inBody, done: result.done });
  };
