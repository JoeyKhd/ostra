import type { Logger, TrackerAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { randomBytes } from "node:crypto";

import { createPanelPreviewTokens, postgresAuditLog, postgresChangeNotices, previewCheckMark, systemClock, warnIgnoredSettings } from "@ostra/domain";
import type { CommandOutbox, JobQueue, ServerAdapters, ServerSettings } from "@ostra/domain";
import { hashPassword } from "better-auth/crypto";

import { createAuth } from "./auth/create-auth.ts";
import type { OstraAuth } from "./auth/create-auth.ts";
import { ensureFirstAdmin } from "./auth/first-admin.ts";
import { loadServerSecrets } from "./auth/server-secrets.ts";
import type { CatalogSource } from "./catalog/catalog-source.ts";
import { shippedAgentEffort } from "./services/agent-effort.ts";
import type { AgentEffort } from "./services/agent-effort.ts";
import type { BlobStoreView } from "./services/blob-store-view.ts";
import { coreAppStarter } from "./services/core-app-start.ts";
import { accountMailIsOn, noEmailDirectory } from "./services/email.ts";
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
  /**
   * Milestone 8 (F-141): the secrets key's text, which the panel signs a view's token and a "Start
   * the app" request to core under (core holds the same key). Unset, a key of this process alone:
   * core refuses every relayed stream and input and every start, so previews fail closed.
   */
  readonly previewSecret?: string;
  /**
   * Milestone 8 (ticket 30): the release's version, for the library's `User-Agent: ostra/<version>`
   * (the panel and core ship as one release, ADR 0046). Unset, `0.0.0`.
   */
  readonly serverVersion?: string;
  /** The fetch the library's calls out go through. Unset, the platform's. */
  readonly libraryFetch?: typeof fetch;
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
  const ports = { notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock };
  const emailOn = (): Promise<boolean> => accountMailIsOn(db, settings.email);
  const auth = createAuth({
    db,
    baseUrl: settings.publicUrl,
    secret: secrets.betterAuthSecret,
    settings: { allowDefaultPassword: settings.allowDefaultPassword, invitationDays: settings.invitationDays, resetLinkHours: settings.resetLinkHours },
    logLevel: settings.mode === "production" ? "error" : "warn",
    accounts: { emailOn, jobs: input.jobs, ...ports },
  });
  // F-001: a server that starts with no account seeds the first admin and organization. Every
  // replica runs this; the seed's advisory lock lets exactly one create them.
  await ensureFirstAdmin({ db, settings, hashPassword, ports, logger: input.logger });

  const hub = createStreamHub({ db, databaseUrl: settings.databaseUrl, logger: input.logger });
  await hub.start();
  const previewSecret = input.previewSecret ?? randomBytes(32).toString("hex");

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
    agentEffort: input.agentEffort ?? shippedAgentEffort,
    blobStore: input.blobStore,
    linear: createLinearAppKit(input.linearEndpoints === undefined ? {} : { endpoints: input.linearEndpoints }),
    trackers: createTrackerDirectory({ db, secretStore: input.adapters.secretStore, makeLinear: input.makeLinearTracker }),
    email: input.email ?? noEmailDirectory,
    emailOn,
    stream: hub,
    previews: {
      coreUrl: settings.coreInternalUrl,
      panelTokens: createPanelPreviewTokens(previewSecret),
      checkMark: (host) => previewCheckMark(previewSecret, host),
    },
    appStart: coreAppStarter({ coreUrl: settings.coreInternalUrl, secret: previewSecret, logger: input.logger }),
    library: { fetch: input.libraryFetch ?? globalThis.fetch, serverVersion: input.serverVersion ?? "0.0.0" },
  };

  return {
    deps,
    auth,
    createContext: (request) => createContext(deps, request),
    close: () => hub.stop(),
  };
};
