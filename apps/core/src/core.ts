import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import type { Logger } from "@ostra/adapter-sdk";
import { createDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { postgresAuditLog, postgresChangeNotices, systemClock } from "@ostra/domain";
import type { ServerSettings } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { replicaIdSchema } from "@ostra/protocol";

import { ensureBootstrapJoinToken } from "./gateway/bootstrap-join-token.ts";
import { postgresDeviceSessions } from "./gateway/device-sessions.ts";
import { createGateway } from "./gateway/gateway.ts";
import type { Gateway } from "./gateway/gateway.ts";
import { loadOrCreateKey } from "./gateway/keys.ts";
import { createCoreServer } from "./server.ts";

// Core (ADR 0016): one process that holds runner connections, runs the queue's workers and serves
// the runner endpoints. `startCore` wires the pieces from the settings; `main.ts` runs it.

/** Core's version: the version `ostra runner` installs to match it (ADR 0046). */
export const CORE_VERSION = "0.0.0";

/** The file in OSTRA_DATA_DIR that holds the key runners' access tokens are signed with. */
export const RUNNER_TOKEN_KEY_FILE = "runner-token.key";

export type RunningCore = {
  readonly port: number;
  readonly db: Db;
  readonly jobs: Jobs;
  readonly gateway: Gateway;
  readonly stop: () => Promise<void>;
};

export const startCore = async (settings: ServerSettings, logger: Logger, options: { readonly host?: string } = {}): Promise<RunningCore> => {
  const db = createDb(settings.databaseUrl);
  const jobs = createJobs({
    databaseUrl: settings.databaseUrl,
    role: "worker",
    instanceName: `core-${hostname()}-${String(process.pid)}`,
    logger,
  });
  await jobs.start();
  // A colon, not a dash: the log guard reads a long dashed run as a token.
  const replicaId = replicaIdSchema.parse(`core:${randomUUID()}`);
  const gateway = createGateway({
    db,
    databaseUrl: settings.databaseUrl,
    replicaId,
    serverVersion: CORE_VERSION,
    panelUrl: settings.publicUrl,
    signingKey: await loadOrCreateKey(settings.dataDir, RUNNER_TOKEN_KEY_FILE),
    deviceSessions: postgresDeviceSessions(db),
    ports: { notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock },
    logger,
  });
  const server = createCoreServer({ routes: [gateway.handleRequest], upgrade: gateway.handleUpgrade, logger });
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

  logger.info("core.listening", { port, replicaId });
  return {
    port,
    db,
    jobs,
    gateway,
    stop: async () => {
      clearTimeout(bootstrapTimer);
      await gateway.stop();
      await server.close();
      await jobs.stop({ graceful: true, timeoutMs: 10_000 });
      await db.$disconnect();
    },
  };
};
