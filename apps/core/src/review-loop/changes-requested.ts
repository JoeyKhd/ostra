import type { CodeHostWebhookEvent } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { reopenOnChangesRequested, reviewerMayReopenInTx, taskRepoOfPrInTx } from "@ostra/domain";
import type { ChangesRequestedDeps, ChangesRequestedSkip, JobQueue } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";

import type { WebhookDeliveryContext } from "../webhooks/process.ts";

// "Changes requested" reopens the task (F-105, ADR 0040 amended, ADR 0058; milestone 6's ticket
// 20). Milestone 4's `pull_request_review` handling sees a `submitted` review with
// `changes_requested` on a task's PR; when its author is a person whose verified link is an active
// member who can open the project, `changes.reopen` is enqueued, keyed by the review. Anyone else's
// review (a bot's, ostra's own App's included, an unlinked user's, another organization's member's)
// is ignored with no reply: the delivery's record says why. The job is the domain's
// `reopenOnChangesRequested`, which reads the review again on the host. The review's text never
// reaches a log line.

export type ChangesRequestedHint =
  | { readonly kind: "enqueued" }
  | { readonly kind: "skipped"; readonly skip: ChangesRequestedSkip }
  /** Not a submitted "changes requested" review: nothing for this ticket to do. */
  | { readonly kind: "not-a-request" };

/** A `pull_request_review` delivery, as far as "changes requested" goes. */
export const changesRequestedHint = async (
  deps: { readonly db: Db; readonly jobs: JobQueue; readonly capable: boolean },
  /** The delivery's, or (F-044) the reconcile's that found the review on the host. */
  context: Pick<WebhookDeliveryContext, "organizationId" | "connectionId" | "logger">,
  event: Extract<CodeHostWebhookEvent, { readonly kind: "pull_request_review" }>,
): Promise<ChangesRequestedHint> => {
  if (!deps.capable || event.action !== "submitted" || event.review.state !== "changes_requested") {
    return { kind: "not-a-request" };
  }
  const outcome = await deps.db.$transaction(async (tx): Promise<ChangesRequestedHint> => {
    const taskRepo = await taskRepoOfPrInTx(tx, { organizationId: context.organizationId, connectionId: context.connectionId, hostRepoId: event.hostRepoId, prNumber: event.number });
    if (taskRepo === null) {
      return { kind: "skipped", skip: "not-a-task-pr" };
    }
    const reviewer = await reviewerMayReopenInTx(tx, { organizationId: context.organizationId, projectId: taskRepo.projectId, review: event.review });
    if (!reviewer.ok) {
      return { kind: "skipped", skip: reviewer.skip };
    }
    await deps.jobs.enqueueInTx(tx, "changes.reopen", { organizationId: context.organizationId, taskRepoId: taskRepo.id, reviewId: event.review.reviewId });
    return { kind: "enqueued" };
  });
  context.logger.info("pr.changes-requested", { number: event.number, reviewId: event.review.reviewId, outcome: outcome.kind, ...(outcome.kind === "skipped" ? { skip: outcome.skip } : {}) });
  return outcome;
};

export const changesReopenHandler =
  (deps: Omit<ChangesRequestedDeps, "logger">): JobHandler<"changes.reopen"> =>
  async (context) => {
    const result = await reopenOnChangesRequested({ ...deps, logger: context.logger }, context.payload);
    if (!result.ok && result.error === "busy") {
      // Between sessions: the queue tries again once the next turn is going.
      throw new Error("changes.reopen: the task is between sessions; trying again");
    }
    context.logger.info("changes.reopen-done", { taskRepoId: context.payload.taskRepoId, reviewId: context.payload.reviewId, ...(result.ok ? { reopened: result.reopened, held: result.held } : { error: result.error }) });
  };
