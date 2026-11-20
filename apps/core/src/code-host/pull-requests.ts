import { secretRefSchema } from "@ostra/adapter-sdk";
import type { CodeHostAdapter, CodeHostWebhookEvent, Logger, PullRequestDetails, SecretStoreAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { appOwnerInTx, enqueueReviewEvaluationsInTx, installationGoneInTx, linkOwnInstallationInTx, reconcileBehind, recordPullRequestState, recordPush } from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock, JobQueue, RecordPullRequestStateResult } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { connectionIdSchema, organizationIdSchema, repoFullNameSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";

import { ciHintEvent, recordTaskPrHead } from "../review-loop/ci.ts";
import type { CiHintDeps } from "../review-loop/ci.ts";
import { enqueueReviewersRefresh, reviewersHintEvent } from "../review-loop/reviewers.ts";
import type { ReviewersHintDeps } from "../review-loop/reviewers.ts";
import type { WebhookDeliveryContext, WebhookHandler, WebhookOutcome } from "../webhooks/process.ts";

// PR states (F-031, F-044, F-046, F-079, ticket 16). Two ways a PR's state reaches its task, which
// must agree, so both call the domain's one `recordPullRequestState`:
// - the App's `pull_request` webhook, through the inbox (`webhook.process` → `githubWebhookHandler`);
// - `github.reconcile-prs`, a schedule every OSTRA_RECONCILE_MINUTES per GitHub connection, over the
//   task repos with a PR open, each read through `getPullRequest` within the App's rate budget. With
//   webhooks off, a merge reaches the task within one interval.
// A PR the App didn't open for a task, or a repo outside every project, is ignored.
//
// Logs carry the connection, the repo, the PR's number and the outcome, never a PR's text.

export type PullRequestStateDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly codeHost: CodeHostAdapter;
  readonly secretStore: SecretStoreAdapter;
  readonly logger: Logger;
  /** Milestone 3 (ticket 26): a push, for the snapshot's lockfile trigger. Without it, a push is ignored. */
  readonly onPush?: (input: {
    readonly organizationId: OrganizationId;
    readonly connectionId: ConnectionId;
    readonly event: Extract<CodeHostWebhookEvent, { kind: "push" }>;
  }) => Promise<string>;
  /** Milestone 3 (ticket 25): what an `issue_comment` or a `pull_request_review_comment` does. */
  readonly onComment?: (context: WebhookDeliveryContext, event: PrCommentEvent) => Promise<WebhookOutcome>;
};

/** A PR comment's webhook, as the code host's adapter reads it. */
export type PrCommentEvent = Extract<CodeHostWebhookEvent, { readonly kind: "issue_comment" | "pull_request_review_comment" }>;

const record = (
  deps: PullRequestStateDeps,
  input: Parameters<typeof recordPullRequestState>[1],
): Promise<RecordPullRequestStateResult> =>
  deps.db.$transaction((tx) => recordPullRequestState({ tx, jobs: deps.jobs, notices: deps.notices, clock: deps.clock, audit: deps.audit }, input), { timeout: 20_000 });

/** An `installation` event (F-136): `created` links the owner's own, `deleted` removes a linked one. */
const installationEvent = async (
  deps: PullRequestStateDeps,
  context: WebhookDeliveryContext,
  event: Extract<CodeHostWebhookEvent, { readonly kind: "installation" }>,
): Promise<WebhookOutcome> => {
  const target = { organizationId: context.organizationId, connectionId: context.connectionId, installationId: event.installationId };
  if (event.action === "deleted") {
    const removed = await deps.db.$transaction((tx) => installationGoneInTx(deps, tx, target));
    context.logger.info("installation.deleted", { installationId: event.installationId, removed });
    return removed ? { outcome: "processed" } : { outcome: "ignored", reason: "not a linked installation" };
  }
  if (event.action !== "created") {
    return { outcome: "ignored", reason: `installation ${event.action.slice(0, 32)}` };
  }
  const connection = await deps.db.connection.findFirst({ where: { id: context.connectionId, organizationId: context.organizationId, kind: "github" } });
  const ref = secretRefSchema.safeParse(connection?.privateKeySecretRef);
  const key = ref.success ? await deps.secretStore.get(context.organizationId, ref.data) : null;
  if (connection === null || key?.ok !== true) {
    return { outcome: "failed", reason: "the connection's App key couldn't be read" };
  }
  const linked = await deps.db.$transaction(async (tx) => {
    const owner = await appOwnerInTx(tx, deps.codeHost, { appId: connection.appId, privateKey: key.value }, connection);
    return linkOwnInstallationInTx(deps, tx, {
      ...target,
      owner,
      installation: { installationId: event.installationId, accountId: event.account.accountId, accountLogin: event.account.login, accountKind: event.account.kind },
    });
  });
  context.logger.info("installation.created", { installationId: event.installationId, linked });
  return linked ? { outcome: "processed" } : { outcome: "ignored", reason: "another account's installation waits for an admin" };
};

/** `webhook.process`'s handler for a GitHub connection: a `pull_request` event's state. */
export const githubWebhookHandler =
  (deps: PullRequestStateDeps): WebhookHandler =>
  async (context) => {
    // The inbox verified the body already; the adapter reads the stored copy, as it was sent.
    const parsed = deps.codeHost.parseWebhook({ headers: { "x-github-event": context.event }, body: JSON.stringify(context.payload), secret: "" });
    if (!parsed.ok) {
      return { outcome: "ignored", reason: "the delivery could not be read" };
    }
    const event = parsed.value;
    if (event.kind === "push") {
      // Milestone 3 (F-070, F-072, ticket 24): a base branch moved, or a task's branch did.
      const pushed = await recordPush(
        { db: deps.db, jobs: deps.jobs, notices: deps.notices, clock: deps.clock, adapters: { codeHost: deps.codeHost, secretStore: deps.secretStore } },
        { organizationId: context.organizationId, connectionId: context.connectionId, hostRepoId: event.hostRepoId, ref: event.ref, after: event.after },
      );
      context.logger.info("push.behind", { checked: pushed.checked, changed: pushed.changed, failed: pushed.failed, taskBranches: pushed.taskBranches });
      // Milestone 3 (ticket 26): the same push, for the snapshot's lockfile trigger.
      const snapshot = deps.onPush === undefined ? null : await deps.onPush({ organizationId: context.organizationId, connectionId: context.connectionId, event });
      if (snapshot !== null) context.logger.info("push.read", { outcome: snapshot });
      return pushed.checked + pushed.taskBranches === 0 && snapshot !== "rebuilding"
        ? { outcome: "ignored", reason: snapshot === null ? "no task's base or branch" : `push: ${snapshot}` }
        : { outcome: "processed" };
    }
    if (event.kind === "issue_comment" || event.kind === "pull_request_review_comment") {
      // Milestone 3 (F-053, ticket 25): an `@ostra` comment, acted on by its own job.
      return deps.onComment === undefined ? { outcome: "ignored", reason: "comments aren't read here" } : deps.onComment(context, event);
    }
    if (event.kind === "pull_request_review") {
      // Milestone 4 (F-104, ticket 18): a review on a task's open PR re-evaluates its check on the PR's head.
      const enqueued = await deps.db.$transaction((tx) =>
        enqueueReviewEvaluationsInTx(deps.jobs, tx, {
          organizationId: context.organizationId,
          hostRepo: { connectionId: context.connectionId, hostRepoId: event.hostRepoId, prNumber: event.number },
          headSha: event.headSha,
        }),
      );
      context.logger.info("pr.review", { number: event.number, action: event.action.slice(0, 32), reviewer: event.review.login.slice(0, 64), enqueued });
      return enqueued === 0 ? { outcome: "ignored", reason: "not a task's open PR" } : { outcome: "processed" };
    }
    if (event.kind === "installation") {
      // Milestone 4 (F-136, ADR 0065): the App owner's own installation is linked when seen; any
      // other waits for an admin. An uninstall marks a linked one removed.
      return installationEvent(deps, context, event);
    }
    if (event.kind === "installation_repositories") {
      return { outcome: "ignored", reason: "an installation's repos are read when a project adds one" };
    }
    if (event.kind === "ci") {
      // Milestone 6 (F-035, ticket 16): a head's CI changed, read through `ci.evaluate`.
      return ciHintEvent(ciDeps(deps), context, event);
    }
    if (event.kind === "pull_request_reviewers") {
      // Milestone 6 (F-102, ticket 19): the PR's requested reviewers changed, read through `reviewers.refresh`.
      return reviewersHintEvent(reviewersDeps(deps), context, event);
    }
    if (event.kind !== "pull_request") {
      return { outcome: "ignored", reason: `not a pull_request event (${event.event.slice(0, 64)})` };
    }
    const result = await record(deps, {
      organizationId: context.organizationId,
      connectionId: context.connectionId,
      hostRepoId: event.hostRepoId,
      prNumber: event.number,
      state: event.state,
      headSha: event.headSha,
      changedAt: event.changedAt,
      source: "webhook",
    });
    if (!result.ok) {
      return { outcome: "ignored", reason: result.message };
    }
    context.logger.info("pr.state", { number: event.number, action: event.action.slice(0, 32), taskOutcome: result.taskOutcome, matched: result.taskRepoId !== null });
    if (result.taskRepoId !== null && event.state === "open" && REVIEW_ACTIONS.has(event.action)) {
      // Milestone 6 (F-035, F-100, tickets 16, 17): the head, and its CI; a person's push ends an AI review of the old one.
      const head = await recordTaskPrHead(ciDeps(deps), { organizationId: context.organizationId, taskRepoId: result.taskRepoId, headSha: event.headSha });
      if (head.moved || head.enqueued) context.logger.info("pr.head", { number: event.number, reviewEnded: head.moved, ciEnqueued: head.enqueued });
      // Milestone 4 (F-104, ticket 18): a new head (`synchronize`) waits for an approval of it.
      const taskRepoId = result.taskRepoId;
      // Milestone 6 (F-102, ticket 19): an opening or a push changes the paths CODEOWNERS is read for.
      await enqueueReviewersRefresh(reviewersDeps(deps), { organizationId: context.organizationId, taskRepoId, connectionId: context.connectionId });
      await deps.db.$transaction((tx) =>
        enqueueReviewEvaluationsInTx(deps.jobs, tx, {
          organizationId: context.organizationId,
          taskRepoId,
          hostRepo: { connectionId: context.connectionId, hostRepoId: event.hostRepoId, prNumber: event.number },
          headSha: event.headSha,
        }),
      );
    }
    return result.taskRepoId === null ? { outcome: "ignored", reason: "not a task's PR" } : { outcome: "processed" };
  };

/** What CI's hints and heads need of the PR state's deps. */
const ciDeps = (deps: PullRequestStateDeps): CiHintDeps => ({ db: deps.db, jobs: deps.jobs, notices: deps.notices, adapters: { codeHost: deps.codeHost, secretStore: deps.secretStore } });

/** What reviewers' hints need of the PR state's deps: a host that reads requested reviewers or CODEOWNERS. */
const reviewersDeps = (deps: PullRequestStateDeps): ReviewersHintDeps => ({
  db: deps.db,
  jobs: deps.jobs,
  capable: deps.codeHost.capabilities.requestedReviewers || deps.codeHost.capabilities.codeOwners,
});

/** The `pull_request` actions that give a task PR a head to evaluate its independent-review check on. */
const REVIEW_ACTIONS: ReadonlySet<string> = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

/** When the host says the PR's state last changed: its merge, its close, or its last update. */
const changedAtOf = (details: PullRequestDetails): number =>
  details.state === "merged" ? (details.mergedAt ?? details.updatedAt) : details.state === "closed" ? (details.closedAt ?? details.updatedAt) : details.updatedAt;

export type ReconcileOutcome = { readonly read: number; readonly changed: number; readonly stoppedEarly: string | null };

/** The most PRs one pass reads; the next pass carries on. */
const MAX_PRS_PER_PASS = 200;

/** One reconcile pass over a GitHub connection's open PRs. Exported for tests; `github.reconcile-prs` is its job. */
export const reconcilePullRequests = async (
  deps: PullRequestStateDeps,
  input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId },
): Promise<ReconcileOutcome> => {
  const connection = await deps.db.connection.findFirst({
    where: { id: input.connectionId, organizationId: input.organizationId, kind: "github" },
    select: { appId: true, privateKeySecretRef: true },
  });
  const ref = secretRefSchema.safeParse(connection?.privateKeySecretRef);
  if (connection === null || !ref.success) {
    return { read: 0, changed: 0, stoppedEarly: "the connection has no App key" };
  }
  const key = await deps.secretStore.get(input.organizationId, ref.data);
  if (!key.ok) {
    return { read: 0, changed: 0, stoppedEarly: "the App's key couldn't be read" };
  }
  const open = await deps.db.taskRepo.findMany({
    // Milestone 4 (F-136, ADR 0065): only repos of linked installations; nothing is minted for another.
    where: { organizationId: input.organizationId, state: "pr_open", prNumber: { not: null }, repo: { connectionId: input.connectionId, installation: { state: "linked", removedAt: null } } },
    orderBy: { updatedAt: "asc" },
    take: MAX_PRS_PER_PASS,
    select: { id: true, prNumber: true, repo: { select: { fullName: true, installationId: true, hostRepoId: true } } },
  });
  let read = 0;
  let changed = 0;
  for (const taskRepo of open) {
    const repo = repoFullNameSchema.safeParse(taskRepo.repo.fullName);
    if (taskRepo.prNumber === null || !repo.success) continue;
    const details = await deps.codeHost.getPullRequest(
      { app: { appId: connection.appId, privateKey: key.value }, installationId: taskRepo.repo.installationId, repo: repo.data },
      taskRepo.prNumber,
    );
    read += 1;
    if (!details.ok) {
      if (details.error.code === "rate-limited") {
        // The App's budget is spent: the next pass carries on.
        return { read, changed, stoppedEarly: "rate-limited" };
      }
      deps.logger.warn("pr.reconcile-read-failed", { connectionId: input.connectionId, prNumber: taskRepo.prNumber, code: details.error.code });
      continue;
    }
    if (details.value.state === "open") {
      // Milestone 4 (F-104, ticket 18): with webhooks off, the reconcile keeps the check current.
      const { prNumber } = taskRepo;
      const headSha = details.value.headSha;
      // Milestone 6 (F-035, ticket 16): the head's CI, for an App without the check events too.
      await recordTaskPrHead(ciDeps(deps), { organizationId: input.organizationId, taskRepoId: taskRepo.id, headSha });
      // Milestone 6 (F-102, ticket 19): the PR's reviewers, for an App without the reviewer events too.
      await enqueueReviewersRefresh(reviewersDeps(deps), { organizationId: input.organizationId, taskRepoId: taskRepo.id, connectionId: input.connectionId });
      await deps.db.$transaction((tx) =>
        enqueueReviewEvaluationsInTx(deps.jobs, tx, {
          organizationId: input.organizationId,
          taskRepoId: taskRepo.id,
          hostRepo: { connectionId: input.connectionId, hostRepoId: taskRepo.repo.hostRepoId, prNumber },
          headSha,
        }),
      );
      continue;
    }
    const result = await record(deps, {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      hostRepoId: taskRepo.repo.hostRepoId,
      prNumber: taskRepo.prNumber,
      state: details.value.state,
      headSha: details.value.headSha,
      changedAt: changedAtOf(details.value),
      source: "reconcile",
    });
    if (result.ok && result.taskRepoId !== null) changed += 1;
  }
  return { read, changed, stoppedEarly: null };
};

export const reconcileHandler =
  (deps: PullRequestStateDeps): JobHandler<"github.reconcile-prs"> =>
  async (context) => {
    const outcome = await reconcilePullRequests(deps, context.payload);
    context.logger.info("pr.reconciled", { read: outcome.read, changed: outcome.changed, stoppedEarly: outcome.stoppedEarly });
  };

/** A cron for every N minutes (pg-boss's cron has minutes). */
const everyMinutes = (minutes: number): string => (minutes <= 1 ? "* * * * *" : minutes < 60 ? `*/${String(Math.round(minutes))} * * * *` : "0 * * * *");

/** A reconcile schedule per GitHub connection, made from the rows (the panel can't make schedules). */
export const createReconcileSchedules = (deps: { readonly db: Db; readonly jobs: Pick<Jobs, "schedule">; readonly reconcileMinutes: number }) => {
  const known = new Set<string>();
  return {
    ensure: async (): Promise<number> => {
      const connections = await deps.db.connection.findMany({ where: { kind: "github", state: "active" }, select: { id: true, organizationId: true } });
      let made = 0;
      for (const connection of connections) {
        if (known.has(connection.id)) continue;
        await deps.jobs.schedule("github.reconcile-prs", connection.id, everyMinutes(deps.reconcileMinutes), {
          organizationId: organizationIdSchema.parse(connection.organizationId),
          connectionId: connectionIdSchema.parse(connection.id),
        });
        known.add(connection.id);
        made += 1;
      }
      return made;
    },
  };
};

/**
 * `task.reconcile-behind` (F-070, ticket 24): every OSTRA_RECONCILE_MINUTES, the live task repos'
 * `behind`, the least recently checked first, so a base that moved without a webhook still shows.
 */
export const reconcileBehindHandler =
  (deps: PullRequestStateDeps): JobHandler<"task.reconcile-behind"> =>
  async (context) => {
    const pass = await reconcileBehind({ db: deps.db, notices: deps.notices, clock: deps.clock, adapters: { codeHost: deps.codeHost, secretStore: deps.secretStore } });
    context.logger.info("behind.reconciled", { checked: pass.checked, changed: pass.changed, failed: pass.failed });
  };

/** The one `task.reconcile-behind` schedule: an idempotent pass over every organization's task repos. */
export const ensureBehindSchedule = (deps: { readonly jobs: Pick<Jobs, "schedule">; readonly reconcileMinutes: number }): Promise<void> =>
  deps.jobs.schedule("task.reconcile-behind", "all", everyMinutes(deps.reconcileMinutes), {});
