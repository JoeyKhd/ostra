import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { AdapterContext, Logger } from "@ostra/adapter-sdk";
import { GitHubAdapter } from "@ostra/adapter-github";
import { ModelEndpointAdapter } from "@ostra/adapter-model-endpoint";
import { createDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import type { ServerAdapters, ServerSettings, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { replicaIdSchema } from "@ostra/protocol";

import { createBlobService } from "./blobs/blob-service.ts";
import type { BlobService } from "./blobs/blob-service.ts";
import { handleBlobEndpoint } from "./blobs/endpoints.ts";
import { blobGcHandler, ensureBlobGcSchedule } from "./blobs/gc.ts";

import { catalogRefreshHandler, catalogSource, ensureSchedules, providerRefreshHandler } from "./catalog/catalog.ts";
import { applyOfferResultsInTx, dispatchHandler, offerTimeoutHandler, requeueQueuedTasks } from "./dispatch/dispatcher.ts";
import type { DispatcherDeps } from "./dispatch/dispatcher.ts";
import { handleTaskEndpoint } from "./dispatch/endpoints.ts";
import { ensureBootstrapJoinToken } from "./gateway/bootstrap-join-token.ts";
import { postgresDeviceSessions } from "./gateway/device-sessions.ts";
import { createGateway } from "./gateway/gateway.ts";
import type { Gateway } from "./gateway/gateway.ts";
import { loadRunnerTokenKey, RUNNER_TOKEN_KEY_FILE } from "./gateway/keys.ts";
import { cancelGraceInTx, cancelSidecarGraceInTx, graceHandler, startGraceInTx, startSidecarGraceInTx } from "./ingest/grace.ts";
import type { GraceDeps } from "./ingest/grace.ts";
import { createIngest } from "./ingest/ingest.ts";
import { createLiveTextWriter } from "./ingest/live-text.ts";
import { applyStopResultsInTx, openPullRequestsHandler, sessionEndedHandler } from "./reactions/session-end.ts";
import type { ReactionDeps } from "./reactions/session-end.ts";
import { openSecretStore } from "./secrets.ts";
import { createCoreServer } from "./server.ts";

// Core (ADR 0016): one process that holds runner connections, runs the queue's workers and serves
// the runner endpoints. `startCore` wires the pieces from the settings; `main.ts` runs it.

/** Core's version: the version `ostra runner` installs to match it (ADR 0046). */
export const CORE_VERSION = "0.0.0";

export { RUNNER_TOKEN_KEY_FILE };

/** How often queued tasks with no offer out get a fresh dispatch. */
const REQUEUE_MS = 5_000;

/** The adapters core holds (ADR 0025): the code host, the model provider and the secret store. */
export const createServerAdapters = async (db: Db, settings: ServerSettings, logger: Logger): Promise<ServerAdapters> => {
  const context: AdapterContext = { logger, clock: adapterClock };
  // Before anything else: a key that can't read the database's secrets stops the start (Q136).
  const secretStore = await openSecretStore(db, settings, context);
  return {
    codeHost: new GitHubAdapter({ userAgent: `ostra-core/${CORE_VERSION}`, apiUrl: settings.githubApiUrl, lfsActionHosts: settings.githubLfsHosts }, context),
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
  options: { readonly host?: string; readonly adapters?: ServerAdapters } = {},
): Promise<RunningCore> => {
  const db = createDb(settings.databaseUrl);
  const adapters = options.adapters ?? (await createServerAdapters(db, settings, logger));
  const jobs = createJobs({
    databaseUrl: settings.databaseUrl,
    role: "worker",
    instanceName: `core-${hostname()}-${String(process.pid)}`,
    logger,
  });
  await jobs.start();
  // A colon, not a dash: the log guard reads a long dashed run as a token.
  const replicaId = replicaIdSchema.parse(`core:${randomUUID()}`);
  const notices = postgresChangeNotices;
  const liveText = createLiveTextWriter({ db, logger });
  // Milestone 2: the session's maximum duration and the idle box's release (tickets 19, 20).
  const timers: SessionTimers = {
    sessionMaxMs: settings.sessionMaxMinutes * 60_000,
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
  const dispatcherDeps: DispatcherDeps = { db, jobs, outbox: postgresCommandOutbox, notices, clock: systemClock, logger };
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
  const signingKey = await loadRunnerTokenKey(settings);
  const gateway = createGateway({
    db,
    databaseUrl: settings.databaseUrl,
    replicaId,
    serverVersion: CORE_VERSION,
    panelUrl: settings.publicUrl,
    signingKey,
    deviceSessions: postgresDeviceSessions(db),
    ports: { notices, audit: postgresAuditLog, clock: systemClock },
    hooks: {
      ingest: createIngest({ db, jobs, notices, clock: systemClock, liveText, logger, timers }),
      liveText: liveText.write,
      onConnectedInTx: (tx, runner) => cancelGraceInTx(graceDeps, tx, runner),
      onDisconnectedInTx: (tx, runner) => startGraceInTx(graceDeps, tx, runner),
      onSidecarConnectedInTx: (tx, lease) => cancelSidecarGraceInTx(graceDeps, tx, lease),
      onSidecarDisconnectedInTx: (tx, lease) => startSidecarGraceInTx(graceDeps, tx, lease),
      onCommandResultsInTx: async (tx, runner, results) => {
        await applyOfferResultsInTx(dispatcherDeps, tx, runner, results);
        await applyStopResultsInTx(reactionDeps, tx, runner, results);
      },
    },
    logger,
  });
  await jobs.work("task.grace", graceHandler(db, graceDeps));
  await jobs.work("task.dispatch", dispatchHandler(dispatcherDeps));
  await jobs.work("task.offer-timeout", offerTimeoutHandler(dispatcherDeps));
  await jobs.work("task.session-ended", sessionEndedHandler(reactionDeps));
  await jobs.work("task.open-pull-requests", openPullRequestsHandler(reactionDeps));
  const catalogDeps = { db, dataDir: settings.dataDir, catalogFetch: settings.catalogFetch, logger };
  await jobs.work("catalog.refresh", catalogRefreshHandler(catalogDeps), { localConcurrency: 1 });
  await jobs.work(
    "provider.refresh-models",
    providerRefreshHandler({ db, jobs, notices, clock: systemClock, adapters, catalog: catalogSource(catalogDeps) }),
    { localConcurrency: 2 },
  );
  liveText.start();
  const taskEndpoints = handleTaskEndpoint({
    db,
    tokens: gateway.context.tokens,
    taskTokens: gateway.context.taskTokens,
    adapters,
    audit: postgresAuditLog,
    clock: systemClock,
    signingKey,
    logger,
  });
  const blobs = createBlobService({ db, settings: settings.blobStore, context: { logger, clock: adapterClock } });
  const blobEndpoints = handleBlobEndpoint({
    db,
    tokens: gateway.context.tokens,
    taskTokens: gateway.context.taskTokens,
    blobs,
    clock: systemClock,
    logger,
  });
  await jobs.work("blob.gc", blobGcHandler({ db, clock: systemClock, logger }), { localConcurrency: 1 });
  const server = createCoreServer({ routes: [gateway.handleRequest, taskEndpoints, blobEndpoints], upgrade: gateway.handleUpgrade, logger });
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
      clearInterval(scheduleTimer);
      await gateway.stop();
      await server.close();
      await liveText.stop();
      await jobs.stop({ graceful: true, timeoutMs: 10_000 });
      await db.$disconnect();
    },
  };
};
