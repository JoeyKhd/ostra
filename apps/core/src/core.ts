import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { AdapterContext, Logger } from "@ostra/adapter-sdk";
import { GitHubAdapter } from "@ostra/adapter-github";
import { ModelEndpointAdapter } from "@ostra/adapter-model-endpoint";
import { BuiltinSecretStore, parseSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { createDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import type { ServerAdapters, ServerSettings } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { replicaIdSchema } from "@ostra/protocol";

import { catalogRefreshHandler, catalogSource, ensureSchedules, providerRefreshHandler } from "./catalog/catalog.ts";
import { applyOfferResultsInTx, dispatchHandler, offerTimeoutHandler, requeueQueuedTasks } from "./dispatch/dispatcher.ts";
import type { DispatcherDeps } from "./dispatch/dispatcher.ts";
import { handleTaskEndpoint } from "./dispatch/endpoints.ts";
import { ensureBootstrapJoinToken } from "./gateway/bootstrap-join-token.ts";
import { postgresDeviceSessions } from "./gateway/device-sessions.ts";
import { createGateway } from "./gateway/gateway.ts";
import type { Gateway } from "./gateway/gateway.ts";
import { loadOrCreateKey } from "./gateway/keys.ts";
import { cancelGraceInTx, graceHandler, startGraceInTx } from "./ingest/grace.ts";
import type { GraceDeps } from "./ingest/grace.ts";
import { createIngest } from "./ingest/ingest.ts";
import { createLiveTextWriter } from "./ingest/live-text.ts";
import { applyStopResultsInTx, openPullRequestsHandler, sessionEndedHandler } from "./reactions/session-end.ts";
import type { ReactionDeps } from "./reactions/session-end.ts";
import { loadSecretsKey, postgresSecretRows } from "./secrets.ts";
import { createCoreServer } from "./server.ts";

// Core (ADR 0016): one process that holds runner connections, runs the queue's workers and serves
// the runner endpoints. `startCore` wires the pieces from the settings; `main.ts` runs it.

/** Core's version: the version `ostra runner` installs to match it (ADR 0046). */
export const CORE_VERSION = "0.0.0";

/** The file in OSTRA_DATA_DIR that holds the key runners' access tokens are signed with. */
export const RUNNER_TOKEN_KEY_FILE = "runner-token.key";

/** How often queued tasks with no offer out get a fresh dispatch. */
const REQUEUE_MS = 5_000;

/** The adapters core holds (ADR 0025): the code host, the model provider and the secret store. */
export const createServerAdapters = async (db: Db, settings: ServerSettings, logger: Logger): Promise<ServerAdapters> => {
  const context: AdapterContext = { logger, clock: adapterClock };
  const key = parseSecretsKey(await loadSecretsKey(settings));
  if (!key.ok) {
    throw new Error("OSTRA_SECRETS_KEY is not a 32-byte key (64 hex characters or base64)");
  }
  return {
    codeHost: new GitHubAdapter({ userAgent: `ostra-core/${CORE_VERSION}` }, context),
    modelProvider: new ModelEndpointAdapter({}, context),
    secretStore: new BuiltinSecretStore({ rows: postgresSecretRows(db), key: key.value }, context),
  };
};

export type RunningCore = {
  readonly port: number;
  readonly db: Db;
  readonly jobs: Jobs;
  readonly gateway: Gateway;
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
  const graceDeps: GraceDeps = {
    jobs,
    outbox: postgresCommandOutbox,
    notices,
    audit: postgresAuditLog,
    clock: systemClock,
    logger,
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
  };
  const signingKey = await loadOrCreateKey(settings.dataDir, RUNNER_TOKEN_KEY_FILE);
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
      ingest: createIngest({ db, jobs, notices, clock: systemClock, liveText, logger }),
      liveText: liveText.write,
      onConnectedInTx: (tx, runner) => cancelGraceInTx(graceDeps, tx, runner),
      onDisconnectedInTx: (tx, runner) => startGraceInTx(graceDeps, tx, runner),
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
    adapters,
    audit: postgresAuditLog,
    clock: systemClock,
    signingKey,
    logger,
  });
  const server = createCoreServer({ routes: [gateway.handleRequest, taskEndpoints], upgrade: gateway.handleUpgrade, logger });
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
