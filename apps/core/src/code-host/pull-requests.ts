import { secretRefSchema } from "@ostra/adapter-sdk";
import type { CodeHostAdapter, Logger, PullRequestDetails, SecretStoreAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { recordPullRequestState } from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock, JobQueue, RecordPullRequestStateResult } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { connectionIdSchema, organizationIdSchema, repoFullNameSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";

import type { WebhookHandler } from "../webhooks/process.ts";

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
};

const record = (
  deps: PullRequestStateDeps,
  input: Parameters<typeof recordPullRequestState>[1],
): Promise<RecordPullRequestStateResult> =>
  deps.db.$transaction((tx) => recordPullRequestState({ tx, jobs: deps.jobs, notices: deps.notices, clock: deps.clock, audit: deps.audit }, input), { timeout: 20_000 });

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
    if (event.kind !== "pull_request") {
      return { outcome: "ignored", reason: `not a pull_request event (${event.kind === "other" ? event.event.slice(0, 64) : event.kind})` };
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
    return result.taskRepoId === null ? { outcome: "ignored", reason: "not a task's PR" } : { outcome: "processed" };
  };

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
    where: { organizationId: input.organizationId, state: "pr_open", prNumber: { not: null }, repo: { connectionId: input.connectionId } },
    orderBy: { updatedAt: "asc" },
    take: MAX_PRS_PER_PASS,
    select: { prNumber: true, repo: { select: { fullName: true, installationId: true, hostRepoId: true } } },
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
    if (details.value.state === "open") continue;
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
