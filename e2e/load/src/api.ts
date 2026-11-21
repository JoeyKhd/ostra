import { GitHubAdapter } from "@ostra/adapter-github";
import { ModelEndpointAdapter } from "@ostra/adapter-model-endpoint";
import { systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { AdapterContext, Logger, SecretRowStore } from "@ostra/adapter-sdk";
import { BuiltinSecretStore, parseSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { appRouter, coreBlobReader, createApiRuntime, createCallerFactory, createCatalogSource } from "@ostra/api";
import type { ApiRuntime } from "@ostra/api";
import { createDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { postgresCommandOutbox, systemClock } from "@ostra/domain";
import type { ServerSettings } from "@ostra/domain";
import { createJobs, createProducer } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { organizationIdSchema } from "@ostra/protocol";

// `packages/api` in the harness's own process (ticket 34): the panel's composition root as
// `apps/web/src/server/deps.ts` builds it, and a caller signed in as the first admin through
// better-auth, as a browser is. Tasks are made, runners approved and steers sent through these
// procedures, so a steer's time starts where the panel's call does.

const callerFactory = createCallerFactory(appRouter);
export type AdminCaller = ReturnType<typeof callerFactory>;

export type HarnessApi = {
  readonly runtime: ApiRuntime;
  readonly db: Db;
  readonly admin: AdminCaller;
  readonly close: () => Promise<void>;
};

const secretRows = (db: Db): SecretRowStore => ({
  insert: async (row) => {
    await db.secret.create({
      data: { id: row.id, organizationId: row.organizationId, purpose: row.purpose, ciphertext: Uint8Array.from(row.ciphertext), nonce: Uint8Array.from(row.nonce), keyVersion: row.keyVersion },
    });
  },
  get: async (id) => {
    const row = await db.secret.findUnique({ where: { id } });
    if (row === null) return undefined;
    return { id: row.id, organizationId: organizationIdSchema.parse(row.organizationId), purpose: row.purpose, ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion };
  },
  delete: async (id) => {
    const { count } = await db.secret.deleteMany({ where: { id } });
    return count > 0;
  },
});

export const startHarnessApi = async (input: {
  readonly settings: ServerSettings;
  readonly secretsKey: string;
  readonly adminEmail: string;
  readonly adminPassword: string;
  readonly logger: Logger;
}): Promise<HarnessApi> => {
  const { settings, logger } = input;
  const db = createDb(settings.databaseUrl, { maxConnections: 10 });
  const context: AdapterContext = { logger, clock: adapterClock };
  const key = parseSecretsKey(input.secretsKey);
  if (!key.ok) throw new Error("the harness's secrets key didn't parse");
  const jobs: Jobs = createJobs({ databaseUrl: settings.databaseUrl, role: "enqueue-only", instanceName: `load-${String(process.pid)}`, logger });
  const runtime = await createApiRuntime({
    settings,
    db,
    adapters: {
      codeHost: new GitHubAdapter({ userAgent: "ostra-load", apiUrl: settings.githubApiUrl, lfsActionHosts: settings.githubLfsHosts }, context),
      modelProvider: new ModelEndpointAdapter({ allowPrivateNetwork: settings.modelEndpointAllowPrivate }, context),
      secretStore: new BuiltinSecretStore({ rows: secretRows(db), key: key.value }, context),
    },
    jobs: createProducer(jobs, { logger }),
    outbox: postgresCommandOutbox,
    catalog: createCatalogSource({ fetchEnabled: false, loadBundled: () => Promise.resolve([]), fetchLatest: () => Promise.resolve([]), clock: systemClock, logger }),
    makeLinearTracker: () => {
      throw new Error("the load test has no Linear connection");
    },
    blobStore: {
      name: "postgres",
      health: () => Promise.resolve({ status: "ok" }),
      // As the panel reads a blob: through core's blob service, whichever store keeps it.
      read: coreBlobReader({ db, coreUrl: settings.coreInternalUrl, secret: input.secretsKey, logger }),
      upload: () => Promise.reject(new Error("no uploads in the load test")),
    },
    logger,
  });
  const signedIn = await runtime.auth.api.signInEmail({ body: { email: input.adminEmail, password: input.adminPassword }, returnHeaders: true });
  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair !== "")
    .join("; ");
  const admin = callerFactory(await runtime.createContext({ headers: new Headers({ cookie }), resHeaders: new Headers() }));
  return {
    runtime,
    db,
    admin,
    close: async () => {
      await runtime.close();
      await jobs.stop({ graceful: false, timeoutMs: 2_000 }).catch(() => undefined);
      await db.$disconnect();
    },
  };
};
