import type { CodeHostWebhookEvent } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { CI_LOG_PURPOSE, enqueueCiForHintInTx, evaluateCi, recordTaskPrHeadInTx } from "@ostra/domain";
import type { CiLogStore, EvaluateCiDeps } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";

import type { BlobService } from "../blobs/blob-service.ts";
import type { WebhookDeliveryContext, WebhookOutcome } from "../webhooks/process.ts";

// CI on a task's PRs (F-035, ADR 0058; milestone 6's ticket 16). Three ways a head's CI is asked
// for, all ending in `ci.evaluate` keyed by the task repo and the head:
// - a `check_run`, `check_suite` or `status` hint from the App's webhook (ostra's own App's runs
//   are no hint), for each task PR open at that head;
// - a PR's opening or a push to it (`pull_request`), and milestone 2's PR reconcile, which also
//   covers an App without the check events: the head is recorded, a running AI review of an older
//   head ends, and the head is evaluated until it has its verdict;
// - the delayed evaluations at the "no CI" deadline and the wait limit, which `evaluateCi` sends.
// The evaluation itself is the domain's `evaluateCi`. A code host failure throws, so the queue
// retries it. A failed verdict's log tails are blobs of the task: never logged, never in an event.

/** A CI log tail's content type in the blob store. */
const CI_LOG_CONTENT_TYPE = "text/plain";

/** Stores a failing check's log tail as a blob of its task. `null` when the store refused it. */
export const blobCiLogStore =
  (blobs: Pick<BlobService, "put">): CiLogStore =>
  async (owner, log) => {
    const stored = await blobs.put(
      { organizationId: owner.organizationId, task: { projectId: owner.projectId, taskId: owner.taskId } },
      { purpose: CI_LOG_PURPOSE, contentType: CI_LOG_CONTENT_TYPE, bytes: new TextEncoder().encode(log.text) },
    );
    return stored.ok ? stored.value.blobId : null;
  };

export const ciEvaluateHandler =
  (deps: Omit<EvaluateCiDeps, "logger">): JobHandler<"ci.evaluate"> =>
  async (context) => {
    const { organizationId, taskRepoId, headSha } = context.payload;
    const result = await evaluateCi({ ...deps, logger: context.logger }, { organizationId, taskRepoId, headSha });
    if (!result.ok) {
      context.logger.info("ci.evaluate-skipped", { taskRepoId, headSha, error: result.error });
      return;
    }
    context.logger.info("ci.evaluate-done", { taskRepoId, headSha, verdict: result.verdict, outcome: result.outcome, followed: result.followed, deadline: context.payload.deadline ?? null });
  };

export type CiHintDeps = Pick<EvaluateCiDeps, "jobs" | "notices" | "adapters"> & { readonly db: Db };

/** A `ci` hint from the App's webhook: an evaluation of each task PR open at its head. */
export const ciHintEvent = async (deps: CiHintDeps, context: WebhookDeliveryContext, event: Extract<CodeHostWebhookEvent, { readonly kind: "ci" }>): Promise<WebhookOutcome> => {
  if (!deps.adapters.codeHost.capabilities.ciResults) {
    return { outcome: "ignored", reason: "the code host doesn't read CI" };
  }
  const enqueued = await deps.db.$transaction((tx) =>
    enqueueCiForHintInTx(deps.jobs, tx, { organizationId: context.organizationId, connectionId: context.connectionId, hostRepoId: event.hostRepoId, headSha: event.headSha, appSlug: event.appSlug }),
  );
  context.logger.info("ci.hint", { event: event.event, action: event.action?.slice(0, 32) ?? null, enqueued });
  return enqueued === 0 ? { outcome: "ignored", reason: "not a task PR's head, or ostra's own check" } : { outcome: "processed" };
};

/** A task PR's head as the host reports it, from a `pull_request` event or the reconcile. */
export const recordTaskPrHead = (deps: CiHintDeps, input: Parameters<typeof recordTaskPrHeadInTx>[2]): Promise<{ readonly moved: boolean; readonly enqueued: boolean }> =>
  deps.db.$transaction((tx) => recordTaskPrHeadInTx(deps, tx, input), { timeout: 20_000 });
