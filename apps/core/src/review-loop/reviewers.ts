import type { CodeHostWebhookEvent } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { enqueueReviewersForHintInTx, enqueueReviewersRefreshInTx, refreshReviewers } from "@ostra/domain";
import type { JobQueue, ReviewersDeps } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";
import type { OrganizationId } from "@ostra/protocol";

import type { WebhookDeliveryContext, WebhookOutcome } from "../webhooks/process.ts";

// A task PR's reviewers (F-102, F-036, ADR 0058; milestone 6's ticket 19). `reviewers.refresh`,
// keyed by the task repo, is asked for by a `review_requested` or `review_request_removed`, a PR's
// opening or a push to it, and milestone 2's PR reconcile; the refresh itself is the domain's
// `refreshReviewers`. ostra requests nobody on GitHub. A code host failure throws, so the queue
// retries it. Logs carry IDs and counts, never a CODEOWNERS file's text.

export const reviewersRefreshHandler =
  (deps: Omit<ReviewersDeps, "logger">): JobHandler<"reviewers.refresh"> =>
  async (context) => {
    const result = await refreshReviewers({ ...deps, logger: context.logger }, context.payload);
    context.logger.info("reviewers.refresh-done", { taskRepoId: context.payload.taskRepoId, matched: result.matched, unmatched: result.unmatched, teams: result.teams, changed: result.changed });
  };

export type ReviewersHintDeps = { readonly db: Db; readonly jobs: JobQueue; readonly capable: boolean };

/** A `pull_request` `review_requested` or `review_request_removed` hint from the App's webhook. */
export const reviewersHintEvent = async (
  deps: ReviewersHintDeps,
  context: WebhookDeliveryContext,
  event: Extract<CodeHostWebhookEvent, { readonly kind: "pull_request_reviewers" }>,
): Promise<WebhookOutcome> => {
  if (!deps.capable) {
    return { outcome: "ignored", reason: "the code host doesn't read reviewers" };
  }
  const enqueued = await deps.db.$transaction((tx) =>
    enqueueReviewersForHintInTx(deps.jobs, tx, { organizationId: context.organizationId, connectionId: context.connectionId, hostRepoId: event.hostRepoId, prNumber: event.number }),
  );
  context.logger.info("reviewers.hint", { action: event.action, number: event.number, enqueued });
  return enqueued ? { outcome: "processed" } : { outcome: "ignored", reason: "not a task's open PR" };
};

/** A task PR opened, pushed to or reconciled: its reviewers are read again. */
export const enqueueReviewersRefresh = async (
  deps: ReviewersHintDeps,
  input: { readonly organizationId: OrganizationId; readonly taskRepoId: string; readonly connectionId: string },
): Promise<void> => {
  if (!deps.capable) {
    return;
  }
  await deps.db.$transaction((tx) => enqueueReviewersRefreshInTx(deps.jobs, tx, input));
};
