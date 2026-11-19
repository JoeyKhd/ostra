import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { AdapterContext, LogRecord, SecretRowStore } from "@ostra/adapter-sdk";
import { GitHubAdapter } from "@ostra/adapter-github";
import { bundledCatalogSchema, catalogEntries, ModelEndpointAdapter, parseModelsDevCatalog } from "@ostra/adapter-model-endpoint";
import { BuiltinSecretStore, generateSecretsKey, parseSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { createApiRuntime, createCatalogSource } from "@ostra/api";
import type { ApiDeps, ApiRuntime } from "@ostra/api";
import { createDb } from "@ostra/db";
import { repoRoot } from "@ostra/db/dev";
import type { Db } from "@ostra/db";
import { checkSecretsKey, parseServerSettings, postgresCommandOutbox, secretsKeyMismatchError, systemClock } from "@ostra/domain";
import type { JobQueue, ServerSettings } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import { errnoCode, organizationIdSchema } from "@ostra/protocol";

// The panel's composition root (ADR 0016): one per web process. It builds what only the web app
// makes (the database client, the adapters, the enqueue-only job queue and the outbox) and hands
// them to `createApiRuntime`, which seeds the first admin when the install has no account (F-001).

const sink = (record: LogRecord): void => {
  // One JSON line per record: IDs and fields only, never content (AGENTS.md, Code).
  const line = JSON.stringify({ at: new Date().toISOString(), level: record.level, msg: record.message, ...record.fields });
  if (record.level === "error" || record.level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

const logger = createLogger(sink, { service: "web" });

/**
 * The built-in secret store's key (spec section 11, item 1): `OSTRA_SECRETS_KEY`, or one generated
 * at first start and kept in `OSTRA_DATA_DIR/secrets-key` (mode 0600), which core reads too.
 */
const loadSecretsKey = async (settings: ServerSettings): Promise<string> => {
  if (settings.secretsKey !== null) return settings.secretsKey;
  const file = path.join(settings.dataDir, "secrets-key");
  try {
    const kept = (await readFile(file, "utf8")).trim();
    if (kept !== "") return kept;
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, `${generateSecretsKey()}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    // Another process wrote it first: its key wins.
    if (errnoCode(error) !== "EEXIST") throw error;
  }
  await chmod(file, 0o600).catch(() => undefined);
  return (await readFile(file, "utf8")).trim();
};

/** The `Secret` table as the built-in store's rows. */
const prismaSecretRows = (db: Db): SecretRowStore => ({
  insert: async (row) => {
    await db.secret.create({
      data: {
        id: row.id,
        organizationId: row.organizationId,
        purpose: row.purpose,
        ciphertext: Uint8Array.from(row.ciphertext),
        nonce: Uint8Array.from(row.nonce),
        keyVersion: row.keyVersion,
      },
    });
  },
  get: async (id) => {
    const row = await db.secret.findUnique({ where: { id } });
    if (row === null) return undefined;
    return {
      id: row.id,
      organizationId: organizationIdSchema.parse(row.organizationId),
      purpose: row.purpose,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      keyVersion: row.keyVersion,
    };
  },
  delete: async (id) => {
    const { count } = await db.secret.deleteMany({ where: { id } });
    return count > 0;
  },
});

/**
 * The catalog copy that ships with ostra. Read by path: the adapter's own loader resolves it from
 * `import.meta.url`, which a Turbopack bundle rewrites to an asset URL.
 */
const loadBundledCatalog = async () => {
  const file = path.join(repoRoot, "packages", "adapters", "adapter-model-endpoint", "catalog", "models-dev.json");
  const bundled = bundledCatalogSchema.parse(JSON.parse(await readFile(file, "utf8")));
  return catalogEntries(bundled.providers);
};

const MODELS_DEV_URL = "https://models.dev/api.json";

const fetchLatestCatalog = async () => {
  // A plain GET that carries no install data (ADR 0021).
  const response = await fetch(MODELS_DEV_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`models.dev answered ${String(response.status)}`);
  const parsed = parseModelsDevCatalog(await response.json());
  if (!parsed.ok) throw new Error("models.dev's catalog didn't parse");
  return parsed.value;
};

const build = async (): Promise<ApiRuntime> => {
  const parsed = parseServerSettings(process.env);
  if (!parsed.ok) {
    throw new Error(`ostra's settings are invalid:\n${parsed.errors.join("\n")}`);
  }
  const settings = parsed.settings;
  const db = createDb(settings.databaseUrl);
  const context: AdapterContext = { logger, clock: adapterClock };

  const key = parseSecretsKey(await loadSecretsKey(settings));
  if (!key.ok) throw new Error("OSTRA_SECRETS_KEY is not a 32-byte key (64 hex characters or base64)");
  const secretStore = new BuiltinSecretStore({ rows: prismaSecretRows(db), key: key.value }, context);
  // A key that can't read the database's secrets stops the panel at start, as it stops core (Q136).
  const checked = await checkSecretsKey(db, secretStore);
  if (!checked.ok) {
    logger.error("secrets-key.mismatch", { keyVersion: key.value.version });
    throw secretsKeyMismatchError();
  }

  const jobs = createJobs({
    databaseUrl: settings.databaseUrl,
    role: "enqueue-only",
    instanceName: `web-${String(process.pid)}`,
    logger,
  });
  // Core installs pg-boss's schema (ADR 0037). The panel starts without it and connects the queue
  // when it first enqueues, so the panel's pages never wait on core.
  let started: Promise<void> | undefined;
  const ensureStarted = (): Promise<void> => {
    started ??= jobs.start().catch((error: unknown) => {
      started = undefined;
      logger.warn("web.jobs_unavailable", { name: error instanceof Error ? error.name : "unknown" });
      throw error;
    });
    return started;
  };
  const queue: JobQueue = {
    enqueueInTx: async (tx, job, payload, options) => {
      await ensureStarted();
      await jobs.enqueueInTx(tx, job, payload, options);
    },
  };

  const runtime = await createApiRuntime({
    settings,
    db,
    adapters: {
      codeHost: new GitHubAdapter({ userAgent: "ostra-panel", apiUrl: settings.githubApiUrl, lfsActionHosts: settings.githubLfsHosts }, context),
      modelProvider: new ModelEndpointAdapter({ allowPrivateNetwork: settings.modelEndpointAllowPrivate }, context),
      secretStore,
    },
    jobs: queue,
    outbox: postgresCommandOutbox,
    catalog: createCatalogSource({
      fetchEnabled: settings.catalogFetch,
      loadBundled: loadBundledCatalog,
      fetchLatest: fetchLatestCatalog,
      clock: systemClock,
      logger,
    }),
    logger,
  });
  logger.info("web.started", { mode: settings.mode, publicUrl: settings.publicUrl });
  return runtime;
};

// One runtime per process. Next's dev server reloads modules, so it's kept on `globalThis`.
declare global {
  var ostraRuntime: Promise<ApiRuntime> | undefined;
}

/** The API's runtime: built on first use, then shared by every request of this process. */
export const getRuntime = (): Promise<ApiRuntime> => {
  globalThis.ostraRuntime ??= build().catch((error: unknown) => {
    globalThis.ostraRuntime = undefined;
    throw error;
  });
  return globalThis.ostraRuntime;
};

export const getApiDeps = async (): Promise<ApiDeps> => (await getRuntime()).deps;
