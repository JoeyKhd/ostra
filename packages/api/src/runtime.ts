import type { Logger, TrackerAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { postgresAuditLog, postgresChangeNotices, systemClock, warnIgnoredSettings } from "@ostra/domain";
import type { CommandOutbox, JobQueue, ServerAdapters, ServerSettings } from "@ostra/domain";
import { hashPassword } from "better-auth/crypto";

import { createAuth } from "./auth/create-auth.ts";
import type { OstraAuth } from "./auth/create-auth.ts";
import { ensureFirstAdmin } from "./auth/first-admin.ts";
import { loadServerSecrets } from "./auth/server-secrets.ts";
import type { CatalogSource } from "./catalog/catalog-source.ts";
import { controlsAgentEffort } from "./services/agent-effort.ts";
import type { AgentEffort } from "./services/agent-effort.ts";
import type { BlobStoreView } from "./services/blob-store-view.ts";
import { noEmailDirectory } from "./services/email.ts";
import type { EmailDirectory } from "./services/email.ts";
import { createLinearAppKit } from "./services/linear-app.ts";
import type { LinearEndpoints } from "./services/linear-app.ts";
import { createTrackerDirectory } from "./services/trackers.ts";
import type { LinearTrackerAuth } from "./services/trackers.ts";
import { createStreamHub } from "./stream/hub.ts";
import type { ApiDeps, Context } from "./trpc/context.ts";
import { createContext } from "./trpc/context.ts";

// The composition root for the panel's API (ticket 30): everything `apps/web` builds once per
// server process. The web app hands in what only it can make (the database, the adapters, the
// queue and the outbox), and gets back the dependencies the routers need, better-auth, and a
// function that makes a request's context.

export type ApiRuntimeInput = {
  readonly settings: ServerSettings;
  readonly db: Db;
  readonly adapters: ServerAdapters;
  /** `packages/jobs`' `enqueue-only` instance: the panel never runs a worker (ADR 0037). */
  readonly jobs: JobQueue;
  /** Core's command outbox implementation (ADR 0034). */
  readonly outbox: CommandOutbox;
  readonly catalog: CatalogSource;
  /** The blob store's name and health, for the storage page (ticket 31). */
  readonly blobStore: BlobStoreView;
  /** Linear's OAuth and API addresses; unset, the real ones. A test points them at the fake Linear server. */
  readonly linearEndpoints?: LinearEndpoints;
  /** Builds a Linear adapter from a stored credential (tickets 27 to 29). */
  readonly makeLinearTracker: (auth: LinearTrackerAuth) => TrackerAdapter;
  /** Builds the adapter that sends mail for the install's email (Resend, SMTP). Unset, the build has none and "Send a test mail" says so. */
  readonly email?: EmailDirectory;
  /** F-137: each agent's reasoning levels. Unset, read off the model's controls for the agents that take one. */
  readonly agentEffort?: AgentEffort;
  readonly logger: Logger;
};

export type ApiRuntime = {
  readonly deps: ApiDeps;
  /** What better-auth's HTTP handler is built on (`apps/web`'s `/api/auth/*` route). */
  readonly auth: OstraAuth;
  /** A request's context: its session, and the member it acts as. */
  readonly createContext: (input: { readonly headers: Headers; readonly resHeaders: Headers }) => Promise<Context>;
  readonly close: () => Promise<void>;
};

export const createApiRuntime = async (input: ApiRuntimeInput): Promise<ApiRuntime> => {
  const { settings, db } = input;
  // An upgraded install may still set a retired setting: it starts, and says it ignores it.
  warnIgnoredSettings(input.logger, settings);
  const secrets = await loadServerSecrets(settings);
  const auth = createAuth({
    db,
    baseUrl: settings.publicUrl,
    secret: secrets.betterAuthSecret,
    settings: { allowDefaultPassword: settings.allowDefaultPassword },
    logLevel: settings.mode === "production" ? "error" : "warn",
  });
  // F-001: a server that starts with no account seeds the first admin and organization. Every
  // replica runs this; the seed's advisory lock lets exactly one create them.
  const ports = { notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock };
  await ensureFirstAdmin({ db, settings, hashPassword, ports, logger: input.logger });

  const hub = createStreamHub({ db, databaseUrl: settings.databaseUrl, logger: input.logger });
  await hub.start();

  const deps: ApiDeps = {
    db,
    auth,
    settings,
    ports: {
      jobs: input.jobs,
      outbox: input.outbox,
      ...ports,
      adapters: input.adapters,
    },
    logger: input.logger,
    hashPassword,
    catalog: input.catalog,
    agentEffort: input.agentEffort ?? controlsAgentEffort,
    blobStore: input.blobStore,
    linear: createLinearAppKit(input.linearEndpoints === undefined ? {} : { endpoints: input.linearEndpoints }),
    trackers: createTrackerDirectory({ db, secretStore: input.adapters.secretStore, makeLinear: input.makeLinearTracker }),
    email: input.email ?? noEmailDirectory,
    stream: hub,
  };

  return {
    deps,
    auth,
    createContext: (request) => createContext(deps, request),
    close: () => hub.stop(),
  };
};
