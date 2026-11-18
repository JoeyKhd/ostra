import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { postgresAuditLog, postgresChangeNotices, systemClock } from "@ostra/domain";
import type { CommandOutbox, JobQueue, ServerAdapters, ServerSettings } from "@ostra/domain";
import { hashPassword } from "better-auth/crypto";

import { createAuth } from "./auth/create-auth.ts";
import type { OstraAuth } from "./auth/create-auth.ts";
import { announceSetupToken, loadServerSecrets } from "./auth/server-secrets.ts";
import type { CatalogSource } from "./catalog/catalog-source.ts";
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
  readonly logger: Logger;
  /** Where the setup line goes. Default: the process's standard error. */
  readonly announce?: (text: string) => void;
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
  const secrets = await loadServerSecrets(settings);
  const auth = createAuth({
    db,
    baseUrl: settings.publicUrl,
    secret: secrets.betterAuthSecret,
    settings: {
      openAccountSignup: settings.openSignupAccounts,
      openOrganizationSignup: settings.openSignupOrganizations,
    },
    logLevel: settings.mode === "production" ? "error" : "warn",
  });
  const hub = createStreamHub({ db, databaseUrl: settings.databaseUrl, logger: input.logger });
  await hub.start();

  const deps: ApiDeps = {
    db,
    auth,
    settings,
    ports: {
      jobs: input.jobs,
      outbox: input.outbox,
      notices: postgresChangeNotices,
      audit: postgresAuditLog,
      clock: systemClock,
      adapters: input.adapters,
    },
    logger: input.logger,
    setupToken: secrets.setupToken,
    hashPassword,
    catalog: input.catalog,
    stream: hub,
  };

  // F-001, Q117: while no account exists, the log says how to make the first one.
  const accounts = await db.user.count();
  if (accounts === 0) {
    announceSetupToken(input.announce ?? ((text) => process.stderr.write(`${text}\n`)), {
      panelUrl: settings.publicUrl,
      setupToken: secrets.setupToken,
    });
  }

  return {
    deps,
    auth,
    createContext: (request) => createContext(deps, request),
    close: () => hub.stop(),
  };
};
