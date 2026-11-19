import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { AdapterContext, Logger } from "@ostra/adapter-sdk";
import { S3BlobStore } from "@ostra/adapter-blob-s3";
import { GitHubAdapter } from "@ostra/adapter-github";
import { OpenCodeAdapter } from "@ostra/adapter-opencode";
import { LinearAdapter } from "@ostra/adapter-linear";
import { ModelEndpointAdapter } from "@ostra/adapter-model-endpoint";
import { createDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import {
  organizationOfGitHubKey,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  postgresIdempotencyStore,
  postgresRateBudgetStore,
  syncEmailSettingsRow,
  systemClock,
  warnIgnoredSettings,
} from "@ostra/domain";
import type { ServerAdapters, ServerSettings, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { replicaIdSchema } from "@ostra/protocol";

import { createBlobService } from "./blobs/blob-service.ts";
import type { BlobService } from "./blobs/blob-service.ts";
import { agentEffortLevels } from "./agents/effort-levels.ts";
import { handleBlobEndpoint } from "./blobs/endpoints.ts";
import { handlePanelBlobEndpoint } from "./blobs/panel-endpoints.ts";
import { blobGcHandler, ensureBlobGcSchedule } from "./blobs/gc.ts";

import { catalogRefreshHandler, catalogSource, ensureSchedules, providerRefreshHandler } from "./catalog/catalog.ts";
import { applyOfferResultsInTx, dispatchHandler, offerTimeoutHandler, requeueQueuedTasks } from "./dispatch/dispatcher.ts";
import type { DispatcherDeps } from "./dispatch/dispatcher.ts";
import { handleTaskEndpoint } from "./dispatch/endpoints.ts";
import { handleMemoryEndpoint } from "./memory/endpoints.ts";
import { ensureBootstrapJoinToken } from "./gateway/bootstrap-join-token.ts";
import { postgresDeviceSessions } from "./gateway/device-sessions.ts";
import { createGateway } from "./gateway/gateway.ts";
import type { Gateway } from "./gateway/gateway.ts";
import { loadRunnerTokenKey, RUNNER_TOKEN_KEY_FILE } from "./gateway/keys.ts";
import { cancelGraceInTx, cancelSidecarGraceInTx, graceHandler, startGraceInTx, startSidecarGraceInTx } from "./ingest/grace.ts";
import type { GraceDeps } from "./ingest/grace.ts";
import { applyReleaseResultsInTx, boxReleaseHandler, ensureRetentionSchedule, providerBoxesHandler, releaseAfterIdleHandler, retentionSweepHandler } from "./cleanup/cleanup.ts";
import type { CleanupDeps } from "./cleanup/cleanup.ts";
import { createIngest } from "./ingest/ingest.ts";
import { ensureStallSweepSchedule, maxDurationHandler, stallSweepHandler } from "./limits/limits.ts";
import type { LimitDeps } from "./limits/limits.ts";
import { createLiveTextWriter } from "./ingest/live-text.ts";
import { createEmailChannel, createNotificationChannels, notifyDeliverHandler, notifyFanoutHandler, realEmailFactories } from "./notifications/index.ts";
import type { NotifyDeps } from "./notifications/index.ts";
import { accountMailSendHandler } from "./reactions/account-mail.ts";
import { runnerJoinNoticeHandler } from "./notifications/runner-notices.ts";
import { budgetCheckHandler, budgetNewMonthHandler, budgetReleaseHandler, ensureBudgetNewMonthSchedule } from "./reactions/budgets.ts";
import { ensureInsightsSchedule, insightsComputeHandler } from "./reactions/insights.ts";
import { enqueueSearchBackfill, searchBackfillHandler } from "./search/backfill.ts";
import { linkRelatedHandler } from "./reactions/related-prs.ts";
import { reviewEvaluateHandler } from "./reactions/review-check.ts";
import { applyStopResultsInTx, openPullRequestsHandler, sessionEndedHandler } from "./reactions/session-end.ts";
import type { ReactionDeps } from "./reactions/session-end.ts";
import { loadSecretsKey, openSecretStore } from "./secrets.ts";
import { createCoreServer } from "./server.ts";
import { createReconcileSchedules, ensureBehindSchedule, githubWebhookHandler, reconcileBehindHandler, reconcileHandler } from "./code-host/pull-requests.ts";
import { githubCommentHandler, prCommentHook } from "./code-host/pr-comments.ts";
import { diffFetchHandler } from "./diff/diff-fetch.ts";
import { createConnectionTrackers } from "./tracker/connections.ts";
import { createPollSchedules, pollBoardHandler, trackerWebhookHandler } from "./tracker/ingest.ts";
import { ensureTokenRefreshes, refreshTokenHandler } from "./tracker/refresh-token.ts";
import { fetchContextHandler } from "./tracker/context.ts";
import { drainTicketWrites, ticketSyncHandler } from "./tracker/writer.ts";
import { handleSnapshotEndpoint } from "./snapshots/endpoints.ts";
import {
  applySnapshotCommandResultsInTx,
  applySnapshotRunnerEvent,
  ensureSnapshotNightlySchedule,
  requeueSnapshots,
  snapshotNightlyHandler,
  snapshotScheduleHandler,
  snapshotsOnPush,
} from "./snapshots/snapshots.ts";
import type { SnapshotDeps } from "./snapshots/snapshots.ts";
import { createWebhookInbox, parseBlockedWebhooks } from "./webhooks/inbox.ts";
import { webhookProcessHandler } from "./webhooks/process.ts";
import type { WebhookHandlers } from "./webhooks/process.ts";

// Core (ADR 0016): one process that holds runner connections, runs the queue's workers and serves
// the runner endpoints. `startCore` wires the pieces from the settings; `main.ts` runs it.

/** Core's version: the version `ostra runner` installs to match it (ADR 0046). */
export const CORE_VERSION = "0.0.0";

export { RUNNER_TOKEN_KEY_FILE };

/** How often board schedules and token refreshes are made from their rows (a board attached in the panel polls within it). */
const TRACKER_TICK_MS = 30_000;

/** How often the tracker writer's outbox is drained into `ticket.sync` jobs. */
const TICKET_DRAIN_MS = 2_000;

/** How often queued tasks with no offer out get a fresh dispatch. */
const REQUEUE_MS = 5_000;

/** How often queued snapshot builds look for a `docker` runner, and lost ones go back to the queue (ticket 26). */
const SNAPSHOT_SWEEP_MS = 15_000;

/** The adapters core holds (ADR 0025): the code host, the model provider and the secret store. */
export const createServerAdapters = async (db: Db, settings: ServerSettings, logger: Logger): Promise<ServerAdapters> => {
  const context: AdapterContext = { logger, clock: adapterClock };
  // The App's rate budgets and idempotency keys in Postgres, under the organization whose App it is (F-046).
  const githubContext: AdapterContext = {
    ...context,
    rateBudgets: postgresRateBudgetStore(db, organizationOfGitHubKey(db)),
    idempotency: postgresIdempotencyStore(db, organizationOfGitHubKey(db)),
  };
  // Before anything else: a key that can't read the database's secrets stops the start (Q136).
  const secretStore = await openSecretStore(db, settings, context);
  return {
    codeHost: new GitHubAdapter({ userAgent: `ostra-core/${CORE_VERSION}`, apiUrl: settings.githubApiUrl, lfsActionHosts: settings.githubLfsHosts }, githubContext),
    modelProvider: new ModelEndpointAdapter({ allowPrivateNetwork: settings.modelEndpointAllowPrivate }, context),
    secretStore,
  };
};

export type RunningCore = {
  readonly port: number;
  readonly db: Db;
  readonly jobs: Jobs;
  readonly gateway: Gateway;
  /** The blob service (ticket 12): session archives and ticket files. */
  readonly blobs: BlobService;
  readonly stop: () => Promise<void>;
};

export const startCore = async (
  settings: ServerSettings,
  logger: Logger,
  options: {
    readonly host?: string;
    readonly adapters?: ServerAdapters;
    /** OSTRA_DEV_BLOCK_WEBHOOKS, development only: `linear`, `github`, comma separated. */
    readonly devBlockWebhooks?: string;
    /** Tests only (ticket 21's restart harness): a fake Linear's GraphQL endpoint. */
    readonly linearApiUrl?: string;
    /** Tests only: the queue's poll and supervise intervals, so a dead worker's job is freed in seconds. */
    readonly jobIntervals?: { readonly pollingIntervalSeconds: number; readonly superviseIntervalSeconds: number };
    /**
     * Tests only (ticket 38's failure suite): the session's maximum duration and the stall in
     * milliseconds instead of the settings' minutes, so the runaway cases run in seconds.
     */
    readonly limitsMs?: { readonly sessionMaxMs?: number; readonly stallMs?: number };
  } = {},
): Promise<RunningCore> => {
  // An upgraded install may still set a retired setting: core starts, and says it ignores it.
  warnIgnoredSettings(logger, settings);
  const db = createDb(settings.databaseUrl);
  const adapters = options.adapters ?? (await createServerAdapters(db, settings, logger));
  const jobs = createJobs({
    databaseUrl: settings.databaseUrl,
    role: "worker",
    instanceName: `core-${hostname()}-${String(process.pid)}`,
    logger,
    ...(options.jobIntervals ?? {}),
  });
  await jobs.start();
  // A colon, not a dash: the log guard reads a long dashed run as a token.
  const replicaId = replicaIdSchema.parse(`core:${randomUUID()}`);
  const notices = postgresChangeNotices;
  const liveText = createLiveTextWriter({ db, logger });
  // Milestone 2: the session's maximum duration and the idle box's release (tickets 19, 20).
  const timers: SessionTimers = {
    sessionMaxMs: options.limitsMs?.sessionMaxMs ?? settings.sessionMaxMinutes * 60_000,
    boxReleaseIdleMs: settings.boxReleaseIdleDays * 24 * 3_600_000,
    cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload),
  };
  const graceDeps: GraceDeps = {
    jobs,
    outbox: postgresCommandOutbox,
    notices,
    audit: postgresAuditLog,
    clock: systemClock,
    logger,
    timers,
  };
  // A reopen restores an archive only for an agent whose adapter can import one (ADR 0039, ticket 18).
  const archiveAgents = new Map([["opencode", new OpenCodeAdapter().capabilities.sessionArchive]]);
  // How each agent takes project memory (F-110, ticket 15): the tools, or the block only.
  const memoryAgents = new Map([["opencode", new OpenCodeAdapter().capabilities.memory]]);
  const dispatcherDeps: DispatcherDeps = {
    db,
    jobs,
    outbox: postgresCommandOutbox,
    notices,
    clock: systemClock,
    logger,
    reopen: { agentImportsArchives: (adapter) => archiveAgents.get(adapter) === true, archiveMaxBytes: settings.blobStore.maxBytes },
    // Milestone 4 (F-137): a task at a level goes only to a minor-3 runner.
    effortLevels: agentEffortLevels,
  };
  const reactionDeps: ReactionDeps = {
    db,
    jobs,
    notices,
    audit: postgresAuditLog,
    clock: systemClock,
    adapters,
    publicUrl: settings.publicUrl,
    logger,
    timers,
  };
  // Snapshots (milestone 3, ticket 26): built by a `docker` runner of the project's pools.
  const snapshotDeps: SnapshotDeps = {
    db,
    jobs,
    outbox: postgresCommandOutbox,
    notices,
    clock: systemClock,
    codeHost: adapters.codeHost,
    secretStore: adapters.secretStore,
    logger,
  };
  const signingKey = await loadRunnerTokenKey(settings);
  const gateway = createGateway({
    db,
    databaseUrl: settings.databaseUrl,
    replicaId,
    serverVersion: CORE_VERSION,
    panelUrl: settings.publicUrl,
    signingKey,
    deviceSessions: postgresDeviceSessions(db),
    ports: { notices, audit: postgresAuditLog, clock: systemClock, jobs },
    hooks: {
      ingest: createIngest({ db, jobs, notices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox, budgetWarnPercent: settings.budgetWarnPercent }),
      liveText: liveText.write,
      onConnectedInTx: (tx, runner) => cancelGraceInTx(graceDeps, tx, runner),
      onDisconnectedInTx: (tx, runner) => startGraceInTx(graceDeps, tx, runner),
      onSidecarConnectedInTx: (tx, lease) => cancelSidecarGraceInTx(graceDeps, tx, lease),
      onSidecarDisconnectedInTx: (tx, lease) => startSidecarGraceInTx(graceDeps, tx, lease),
      onCommandResultsInTx: async (tx, runner, results) => {
        await applyOfferResultsInTx(dispatcherDeps, tx, runner, results);
        await applyStopResultsInTx(reactionDeps, tx, runner, results);
        await applyReleaseResultsInTx({ clock: systemClock, logger }, tx, runner, results);
        await applySnapshotCommandResultsInTx(snapshotDeps, tx, runner, results);
      },
      runnerEvent: (runner, frame) => applySnapshotRunnerEvent(snapshotDeps, runner, frame),
    },
    logger,
  });
  await jobs.work("task.grace", graceHandler(db, graceDeps));
  await jobs.work("task.dispatch", dispatchHandler(dispatcherDeps));
  await jobs.work("task.offer-timeout", offerTimeoutHandler(dispatcherDeps));
  await jobs.work("task.session-ended", sessionEndedHandler(reactionDeps));
  await jobs.work("task.open-pull-requests", openPullRequestsHandler(reactionDeps));
  await jobs.work("snapshot.schedule", snapshotScheduleHandler(snapshotDeps), { localConcurrency: 2 });
  await jobs.work("snapshot.nightly", snapshotNightlyHandler(snapshotDeps), { localConcurrency: 1 });
  // Runaway protection on the server (ticket 19): the maximum duration and the stall sweep.
  const limitDeps: LimitDeps = {
    db,
    jobs,
    outbox: postgresCommandOutbox,
    notices,
    clock: systemClock,
    logger,
    timers,
    stallMs: options.limitsMs?.stallMs ?? settings.sessionStallMinutes * 60_000,
  };
  await jobs.work("session.max-duration", maxDurationHandler(limitDeps));
  await jobs.work("session.stall-sweep", stallSweepHandler(limitDeps), { localConcurrency: 1 });
  const catalogDeps = { db, dataDir: settings.dataDir, catalogFetch: settings.catalogFetch, logger };
  await jobs.work("catalog.refresh", catalogRefreshHandler(catalogDeps), { localConcurrency: 1 });
  await jobs.work(
    "provider.refresh-models",
    providerRefreshHandler({ db, jobs, notices, clock: systemClock, adapters, catalog: catalogSource(catalogDeps) }),
    { localConcurrency: 2 },
  );
  liveText.start();
  // The S3-compatible store, when OSTRA_BLOB_STORE=s3 (ticket 11). Blobs written to the built-in store
  // before the switch stay readable there: each `Blob` row names its store.
  const s3 =
    settings.blobStore.kind === "s3"
      ? new S3BlobStore(
          {
            endpoint: settings.blobStore.endpoint,
            bucket: settings.blobStore.bucket,
            region: settings.blobStore.region,
            accessKeyId: settings.blobStore.accessKeyId,
            secretAccessKey: settings.blobStore.secretAccessKey,
            maxBytes: settings.blobStore.maxBytes,
          },
          { logger, clock: adapterClock },
        )
      : undefined;
  const blobs = createBlobService({ db, settings: settings.blobStore, context: { logger, clock: adapterClock }, ...(s3 === undefined ? {} : { s3 }) });
  const taskEndpoints = handleTaskEndpoint({
    db,
    tokens: gateway.context.tokens,
    taskTokens: gateway.context.taskTokens,
    adapters,
    audit: postgresAuditLog,
    clock: systemClock,
    signingKey,
    logger,
    specSettings: {
      idleMinutes: settings.boxIdleMinutes,
      spendCap: { capMicroUsd: settings.taskSpendCapMicroUsd, capTokens: settings.taskTokenCap },
    },
    blobs,
    // Milestone 4 (ticket 15): how each agent takes memory, and the index's limits.
    memory: {
      agentMemory: (adapter) => memoryAgents.get(adapter),
      memoryLimits: { indexMaxNotes: settings.memoryIndexMaxNotes, indexMaxBytes: settings.memoryIndexMaxBytes, alwaysMaxBytes: settings.memoryAlwaysMaxBytes },
    },
  });
  // The memory tools' endpoints (ticket 15): the sidecar's `memory_*` calls, by the task's token.
  const memoryEndpoints = handleMemoryEndpoint({
    db,
    tokens: gateway.context.tokens,
    taskTokens: gateway.context.taskTokens,
    secretStore: adapters.secretStore,
    audit: postgresAuditLog,
    clock: systemClock,
    logger,
    proposalsPerTask: settings.memoryProposalsPerTask,
  });
  const snapshotEndpoints = handleSnapshotEndpoint({ db, tokens: gateway.context.tokens, adapters, audit: postgresAuditLog, clock: systemClock, logger });
  const blobEndpoints = handleBlobEndpoint({
    db,
    tokens: gateway.context.tokens,
    taskTokens: gateway.context.taskTokens,
    blobs,
    clock: systemClock,
    logger,
  });
  // The panel's own way in for a member's file (ticket 42): its token is made under the secrets key,
  // which the panel and core both hold.
  const panelBlobEndpoints = handlePanelBlobEndpoint({ blobs, secret: () => loadSecretsKey(settings), clock: systemClock, logger });
  await jobs.work("blob.gc", blobGcHandler({ db, clock: systemClock, logger, ...(s3 === undefined ? {} : { s3 }) }), { localConcurrency: 1 });
  // The webhook inbox (ticket 13): verify, claim, 200; `webhook.process` acts from the queue.
  const inbox = createWebhookInbox({
    db,
    jobs,
    secretStore: adapters.secretStore,
    // Verifying is pure: the adapter needs no token for it.
    trackerVerifiers: { linear: new LinearAdapter({ auth: { kind: "oauth", token: "verify-only" } }, { logger, clock: adapterClock }) },
    codeHost: adapters.codeHost,
    clock: systemClock,
    logger,
    insertDeadlineMs: settings.webhookInsertDeadlineMs,
    blocked: parseBlockedWebhooks(options.devBlockWebhooks, settings.mode),
  });
  // A connection's tracker, with its token and the organization's Postgres stores (tickets 14, 15).
  const trackers = createConnectionTrackers({
    db,
    secretStore: adapters.secretStore,
    clock: systemClock,
    logger,
    ...(options.linearApiUrl === undefined ? {} : { linearApiUrl: options.linearApiUrl }),
  });
  const ingestDeps = { db, trackers, notices, clock: systemClock, logger, closed: { jobs, outbox: postgresCommandOutbox, audit: postgresAuditLog } };
  // PR states (ticket 16): the App's webhooks and a reconcile per GitHub connection agree.
  const prDeps = {
    db,
    jobs,
    notices,
    audit: postgresAuditLog,
    clock: systemClock,
    codeHost: adapters.codeHost,
    secretStore: adapters.secretStore,
    logger,
    onPush: (input: Parameters<typeof snapshotsOnPush>[1]) => snapshotsOnPush(snapshotDeps, input),
    // Milestone 3 (ticket 25): an `@ostra` comment on a task's PR is queued as its `github.comment`.
    onComment: prCommentHook({ db, jobs }),
  };
  await jobs.work("github.reconcile-prs", reconcileHandler(prDeps), { localConcurrency: 2 });
  // Milestone 4 (F-104, ticket 18): the independent-review check, on each task PR's head.
  await jobs.work("review.evaluate", reviewEvaluateHandler({ db, notices, clock: systemClock, adapters }), { localConcurrency: 2 });
  // Milestone 4 (F-098, ticket 17): a task's PRs list each other in their "Related" sections.
  await jobs.work("pr.link-related", linkRelatedHandler({ db, notices, clock: systemClock, adapters }), { localConcurrency: 2 });
  await jobs.work(
    "github.comment",
    githubCommentHandler({
      db,
      jobs,
      outbox: postgresCommandOutbox,
      notices,
      audit: postgresAuditLog,
      clock: systemClock,
      adapters,
      timers,
      spendCap: { capMicroUsd: settings.taskSpendCapMicroUsd, capTokens: settings.taskTokenCap },
    }),
    { localConcurrency: 2 },
  );
  // Milestone 3 (ticket 24): each live task repo's `behind`, every OSTRA_RECONCILE_MINUTES.
  await jobs.work("task.reconcile-behind", reconcileBehindHandler(prDeps), { localConcurrency: 1 });
  await ensureBehindSchedule({ jobs, reconcileMinutes: settings.reconcileMinutes });
  // Milestone 3's diff (ticket 22): one compare per head, cached, and outdated comments.
  const diffLimits = { maxFiles: settings.diffMaxFiles, maxPatchBytes: settings.diffMaxPatchBytes };
  await jobs.work("diff.fetch", diffFetchHandler({ db, notices, clock: systemClock, adapters, limits: diffLimits, logger }), { localConcurrency: 2 });
  const reconcileSchedules = createReconcileSchedules({ db, jobs, reconcileMinutes: settings.reconcileMinutes });
  const webhookHandlers: WebhookHandlers = {
    linear: trackerWebhookHandler(ingestDeps),
    github: githubWebhookHandler(prDeps),
  };
  await jobs.work("webhook.process", webhookProcessHandler({ db, clock: systemClock, handlers: webhookHandlers }));
  // Polling (ticket 14): a schedule per attached board, made here from the board rows.
  await jobs.work("tracker.poll-board", pollBoardHandler(ingestDeps), { localConcurrency: 2 });
  const pollSchedules = createPollSchedules({
    db,
    jobs,
    pollSeconds: settings.trackerPollSeconds,
    reconcileMinutes: settings.reconcileMinutes,
    logger,
  });
  const refreshDeps = { db, jobs, secretStore: adapters.secretStore, trackers, notices, audit: postgresAuditLog, clock: systemClock, logger };
  await jobs.work("linear.refresh-token", refreshTokenHandler(refreshDeps), { localConcurrency: 1 });
  const trackerTick = async (): Promise<void> => {
    await pollSchedules.ensure().catch((error: unknown) => {
      logger.warn("tracker.schedules-failed", { error: error instanceof Error ? error.name : "unknown" });
    });
    await reconcileSchedules.ensure().catch((error: unknown) => {
      logger.warn("github.reconcile-schedules-failed", { error: error instanceof Error ? error.name : "unknown" });
    });
    await ensureTokenRefreshes(refreshDeps).catch((error: unknown) => {
      logger.warn("linear.refresh-schedule-failed", { error: error instanceof Error ? error.name : "unknown" });
    });
  };
  await trackerTick();
  const trackerTimer = setInterval(() => void trackerTick(), TRACKER_TICK_MS);
  trackerTimer.unref();
  // The tracker writer (ticket 15): `ticket.sync` applies each outbox row; the drain sends the rows
  // written where no queue was at hand (a task's move), every 2 s.
  await jobs.work("ticket.sync", ticketSyncHandler({ db, trackers, clock: systemClock, publicUrl: settings.publicUrl, logger }), { localConcurrency: 4 });
  // Notifications (ticket 20): a needs-you moment fans out to its audience, and each channel delivers on its own.
  // Mail goes through the install's own settings when they set it (they lock the panel's choice), else the saved row.
  await syncEmailSettingsRow(db, settings.email);
  const emailChannel = createEmailChannel({
    db,
    secretStore: adapters.secretStore,
    clock: systemClock,
    logger,
    publicUrl: settings.publicUrl,
    stallMinutes: settings.sessionStallMinutes,
    fromSettings: settings.email,
    factories: realEmailFactories,
  });
  const notifyDeps: NotifyDeps = {
    db,
    jobs,
    notices,
    outbox: postgresCommandOutbox,
    audit: postgresAuditLog,
    clock: systemClock,
    adapters,
    logger,
    trackers,
    channels: createNotificationChannels(db, { logger, clock: adapterClock }),
    email: emailChannel,
    publicUrl: settings.publicUrl,
    emailDelaySeconds: settings.emailDelaySeconds,
    trackerCoalesceMinutes: settings.trackerNotifyCoalesceMinutes,
    stallMinutes: settings.sessionStallMinutes,
  };
  await jobs.work("notify.fanout", notifyFanoutHandler(notifyDeps), { localConcurrency: 4 });
  await jobs.work("notify.deliver", notifyDeliverHandler(notifyDeps), { localConcurrency: 4 });
  // The account mails (milestone 4, ticket 19): an invitation, a verification or a reset, at once.
  await jobs.work(
    "account-mail.send",
    accountMailSendHandler({ db, clock: systemClock, logger, publicUrl: settings.publicUrl, accountSender: emailChannel.accountSender, verificationHours: settings.resetLinkHours }),
    { localConcurrency: 4 },
  );
  // Milestone 4 (ticket 13): budget notices, and the release of held turns on a raise or a new month.
  const budgetDeps = {
    db,
    jobs,
    outbox: postgresCommandOutbox,
    notices,
    clock: systemClock,
    budgetWarnPercent: settings.budgetWarnPercent,
    emailDelaySeconds: settings.emailDelaySeconds,
  };
  // Milestone 5 (F-091, ticket 12): a pool runner's join tells the admins, and opens its approval.
  await jobs.work(
    "runner.join-notice",
    runnerJoinNoticeHandler({ db, jobs, notices, clock: systemClock, emailDelaySeconds: settings.emailDelaySeconds }),
    { localConcurrency: 2 },
  );
  await jobs.work("budget.check", budgetCheckHandler(budgetDeps), { localConcurrency: 2 });
  await jobs.work("budget.release", budgetReleaseHandler(budgetDeps), { localConcurrency: 1 });
  await jobs.work("budget.new-month", budgetNewMonthHandler(budgetDeps), { localConcurrency: 1 });
  await ensureBudgetNewMonthSchedule(jobs);
  // Milestone 4 (ticket 14): Insights, recomputed from ostra's own tables on a schedule.
  await jobs.work("insights.compute", insightsComputeHandler({ db, clock: systemClock }), { localConcurrency: 1 });
  await ensureInsightsSchedule(jobs, settings.insightsIntervalMinutes);
  // Cleanup and retention (ticket 20): a box's release, its idle days, and the daily retention pass.
  const cleanupDeps: CleanupDeps = {
    db,
    jobs,
    outbox: postgresCommandOutbox,
    notices,
    audit: postgresAuditLog,
    clock: systemClock,
    adapters,
    logger,
    deleteBlob: async (organizationId, blobId) => {
      const deleted = await blobs.delete(organizationId, blobId);
      return deleted.ok || deleted.error === "not-found";
    },
    retentionDays: settings.retentionDays,
    releaseAfterIdleMs: settings.boxReleaseIdleDays * 24 * 3_600_000,
  };
  await jobs.work("box.release", boxReleaseHandler(cleanupDeps), { localConcurrency: 4 });
  await jobs.work("box.release-after-idle", releaseAfterIdleHandler(cleanupDeps), { localConcurrency: 4 });
  // Keys per project (F-135): a list change releases the boxes that hold a key it removed.
  await jobs.work("providers.release-boxes", providerBoxesHandler(cleanupDeps), { localConcurrency: 2 });
  await jobs.work("retention.sweep", retentionSweepHandler(cleanupDeps), { localConcurrency: 1 });
  // A ticket task's context, images and first prompt, then its dispatch (ticket 18).
  await jobs.work("ticket.fetch-context", fetchContextHandler({ db, jobs, notices, clock: systemClock, trackers, blobs, logger }), { localConcurrency: 4 });
  // Search (ticket 11): the entries of tasks from before milestone 4, once per task.
  await jobs.work("search.backfill", searchBackfillHandler({ db }), { localConcurrency: 2 });
  await enqueueSearchBackfill({ db, jobs, logger }).catch((error: unknown) => {
    logger.warn("search.backfill-enqueue-failed", { error: error instanceof Error ? error.name : "unknown" });
  });
  const drain = setInterval(() => {
    drainTicketWrites({ db, jobs, clock: systemClock }).catch((error: unknown) => {
      logger.warn("ticket.drain-failed", { error: error instanceof Error ? error.name : "unknown" });
    });
  }, TICKET_DRAIN_MS);
  drain.unref();
  const server = createCoreServer({ routes: [gateway.handleRequest, taskEndpoints, memoryEndpoints, snapshotEndpoints, blobEndpoints, panelBlobEndpoints, inbox.handle], upgrade: gateway.handleUpgrade, logger });
  await gateway.start();
  const port = await server.listen(settings.corePort, options.host);

  // The bootstrap join token waits for the first organization (a fresh install has none yet).
  let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
  const bootstrap = async (): Promise<void> => {
    const outcome = await ensureBootstrapJoinToken(db, settings.dataDir, logger).catch((error: unknown) => {
      logger.warn("bootstrap-join-token.failed", { error: error instanceof Error ? error.name : "unknown" });
      return "waiting" as const;
    });
    if (outcome === "waiting") {
      bootstrapTimer = setTimeout(() => void bootstrap(), 30_000);
      bootstrapTimer.unref();
    }
  };
  await bootstrap();

  // The daily catalog and model-list schedules; a provider added in the panel gets its own within 10 minutes.
  const schedules = async (): Promise<void> => {
    await ensureSchedules({ db, jobs, catalogFetch: settings.catalogFetch }).catch((error: unknown) => {
      logger.warn("schedules.failed", { error: error instanceof Error ? error.name : "unknown" });
    });
    await ensureBlobGcSchedule(jobs).catch((error: unknown) => {
      logger.warn("schedules.failed", { job: "blob.gc", error: error instanceof Error ? error.name : "unknown" });
    });
    await ensureRetentionSchedule(jobs).catch((error: unknown) => {
      logger.warn("schedules.failed", { job: "retention.sweep", error: error instanceof Error ? error.name : "unknown" });
    });
    await ensureStallSweepSchedule(jobs).catch((error: unknown) => {
      logger.warn("schedules.failed", { job: "session.stall-sweep", error: error instanceof Error ? error.name : "unknown" });
    });
    await ensureSnapshotNightlySchedule(jobs, settings.snapshotNightlyHour).catch((error: unknown) => {
      logger.warn("schedules.failed", { job: "snapshot.nightly", error: error instanceof Error ? error.name : "unknown" });
    });
  };
  await schedules();
  const scheduleTimer = setInterval(() => void schedules(), 10 * 60_000);
  scheduleTimer.unref();

  // Queued tasks with no offer out try again: a runner came online, a slot freed, a hold ended.
  const requeue = setInterval(() => {
    requeueQueuedTasks(dispatcherDeps).catch((error: unknown) => {
      logger.warn("dispatch.requeue-failed", { error: error instanceof Error ? error.name : "unknown" });
    });
  }, REQUEUE_MS);
  requeue.unref();
  const snapshotSweep = setInterval(() => {
    requeueSnapshots(snapshotDeps).catch((error: unknown) => {
      logger.warn("snapshot.sweep-failed", { error: error instanceof Error ? error.name : "unknown" });
    });
  }, SNAPSHOT_SWEEP_MS);
  snapshotSweep.unref();

  logger.info("core.listening", { port, replicaId });
  return {
    port,
    db,
    jobs,
    gateway,
    blobs,
    stop: async () => {
      clearTimeout(bootstrapTimer);
      clearInterval(requeue);
      clearInterval(snapshotSweep);
      clearInterval(drain);
      clearInterval(trackerTimer);
      clearInterval(scheduleTimer);
      await gateway.stop();
      await server.close();
      await liveText.stop();
      await jobs.stop({ graceful: true, timeoutMs: 10_000 });
      s3?.close();
      emailChannel.close();
      await db.$disconnect();
    },
  };
};
