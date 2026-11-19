import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CatalogEntry, Logger } from "@ostra/adapter-sdk";
import { catalogEntries, loadBundledCatalog, modelsDevCatalogSchema, parseModelsDevCatalog } from "@ostra/adapter-model-endpoint";
import type { Db } from "@ostra/db";
import { syncProviderModels } from "@ostra/domain";
import type { ChangeNotices, Clock, ServerAdapters } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { organizationIdSchema, parseJson, providerIdSchema } from "@ostra/protocol";
import { z } from "zod";

// The model catalog (ticket 28, F-088, ADR 0033, ADR 0021): a daily `catalog.refresh` fetches the
// models.dev catalog with a plain GET that carries no install data, keeps the last good copy in
// OSTRA_DATA_DIR, and downloads the logos of the providers ostra's models matched into
// `OSTRA_DATA_DIR/model-logos/`, which the panel serves at `/model-logos/<id>.svg` (ticket 31's
// route), so browsers never call models.dev. A failed fetch keeps the old copy. With
// OSTRA_CATALOG_FETCH off, no request is made and the copy bundled with ostra is used.
//
// A daily `provider.refresh-models` per provider lists the endpoint's models and matches them,
// through the same use case the panel's Refresh button calls.

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_LOGOS_URL = "https://models.dev/logos";

/** The last good copy, in the bundled copy's shape, under OSTRA_DATA_DIR. */
export const CATALOG_FILE = path.join("catalog", "models-dev.json");
/** Where the logos go: the folder the panel's `/model-logos/` route reads. */
export const LOGO_DIR = "model-logos";

const DAILY_CATALOG_CRON = "17 4 * * *";
const DAILY_MODELS_CRON = "47 4 * * *";

export type CatalogDeps = {
  readonly db: Db;
  readonly dataDir: string;
  /** OSTRA_CATALOG_FETCH. */
  readonly catalogFetch: boolean;
  readonly logger: Logger;
  readonly catalogUrl?: string;
  readonly logosUrl?: string;
  /** For tests: the catalog server's stand-in. */
  readonly fetchFn?: typeof fetch;
};

export type RefreshOutcome = "off" | "stored" | "failed";

const looksLikeSvg = (text: string): boolean => text.trimStart().startsWith("<svg") && text.length < 200_000;

/** Writes through a temporary file and a rename, so a reader never sees half a file. */
const writeAtomically = async (file: string, text: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, file);
};

/** The catalog's providers that ostra's models matched: whose logos are worth keeping. */
const matchedProviders = async (db: Db): Promise<readonly string[]> => {
  const rows = await db.model.findMany({ where: { catalogId: { not: null } }, select: { catalogId: true }, distinct: ["catalogId"] });
  const ids = new Set<string>();
  for (const row of rows) {
    const provider = row.catalogId?.split("/")[0];
    if (provider !== undefined && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) {
      ids.add(provider);
    }
  }
  return [...ids].sort();
};

export const refreshCatalog = async (deps: CatalogDeps): Promise<RefreshOutcome> => {
  if (!deps.catalogFetch) {
    return "off";
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const url = deps.catalogUrl ?? MODELS_DEV_URL;
  let raw: unknown;
  try {
    // A plain GET: no cookie, no install ID, no header but `accept` (ADR 0021).
    const response = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      deps.logger.warn("catalog.fetch-failed", { status: response.status });
      return "failed";
    }
    const json = parseJson(await response.text());
    if (!json.ok) {
      deps.logger.warn("catalog.fetch-failed", { reason: "not-json" });
      return "failed";
    }
    raw = json.value;
  } catch (error) {
    deps.logger.warn("catalog.fetch-failed", { error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
  const providers = modelsDevCatalogSchema.safeParse(raw);
  const entries = parseModelsDevCatalog(raw);
  if (!providers.success || !entries.ok) {
    // A copy that doesn't match is refused; the last good one stays.
    deps.logger.warn("catalog.refused", { reason: "the copy doesn't parse" });
    return "failed";
  }
  await writeAtomically(
    path.join(deps.dataDir, CATALOG_FILE),
    JSON.stringify({ source: url, fetchedAt: new Date().toISOString(), providers: providers.data }),
  );
  let logos = 0;
  for (const provider of await matchedProviders(deps.db)) {
    try {
      const response = await fetchFn(`${deps.logosUrl ?? MODELS_DEV_LOGOS_URL}/${provider}.svg`, { signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      if (response.ok && looksLikeSvg(text)) {
        await writeAtomically(path.join(deps.dataDir, LOGO_DIR, `${provider}.svg`), text);
        logos += 1;
      }
    } catch {
      // A missing logo shows the panel's plain mark: nothing else depends on it.
    }
  }
  deps.logger.info("catalog.stored", { entries: entries.value.length, logos });
  return "stored";
};

/** The last good copy as stored on disk: the fetch's own file wraps the providers. */
const storedCatalogSchema = z.looseObject({ providers: modelsDevCatalogSchema });

/** The catalog's entries: the last good copy when fetching is on and one exists, else the bundled copy. */
export const catalogSource =
  (deps: Pick<CatalogDeps, "dataDir" | "catalogFetch" | "logger">) =>
  async (): Promise<readonly CatalogEntry[]> => {
    if (deps.catalogFetch) {
      try {
        const json = parseJson(await readFile(path.join(deps.dataDir, CATALOG_FILE), "utf8"));
        const stored = json.ok ? storedCatalogSchema.safeParse(json.value) : null;
        if (stored?.success === true) {
          return catalogEntries(stored.data.providers);
        }
      } catch {
        // No copy yet: the bundled one.
      }
    }
    return (await loadBundledCatalog()).entries;
  };

export const catalogRefreshHandler =
  (deps: CatalogDeps): JobHandler<"catalog.refresh"> =>
  async (context) => {
    const outcome = await refreshCatalog(deps);
    context.logger.info("catalog.refresh-done", { outcome });
    if (outcome === "failed") {
      // Retried by the queue; the last good copy keeps serving meanwhile.
      throw new Error("the catalog fetch failed");
    }
  };

export type ProviderRefreshDeps = {
  readonly db: Db;
  readonly jobs: Jobs;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly adapters: ServerAdapters;
  readonly catalog: () => Promise<readonly CatalogEntry[]>;
};

export const providerRefreshHandler =
  (deps: ProviderRefreshDeps): JobHandler<"provider.refresh-models"> =>
  async (context) => {
    const result = await syncProviderModels(
      { db: deps.db, notices: deps.notices, clock: deps.clock, adapters: deps.adapters, catalog: deps.catalog },
      context.payload,
    );
    if (result.ok) {
      context.logger.info("provider.models-refreshed", { providerId: context.payload.providerId, listed: result.listed, matched: result.matched });
      return;
    }
    context.logger.info("provider.refresh-failed", { providerId: context.payload.providerId, error: result.error });
    switch (result.error) {
      case "not-found":
        // The provider was removed: its schedule goes too.
        await deps.jobs.unschedule("provider.refresh-models", context.payload.providerId);
        return;
      case "secret-unreadable":
        return;
      case "endpoint-failed":
        throw new Error("the endpoint didn't list its models");
      default:
        return result.error satisfies never;
    }
  };

/** The daily schedules: the catalog's (unless fetching is off) and one per provider. Idempotent. */
export const ensureSchedules = async (deps: { readonly db: Db; readonly jobs: Jobs; readonly catalogFetch: boolean }): Promise<number> => {
  if (deps.catalogFetch) {
    await deps.jobs.schedule("catalog.refresh", "daily", DAILY_CATALOG_CRON, {});
  } else {
    await deps.jobs.unschedule("catalog.refresh", "daily");
  }
  const providers = await deps.db.modelProvider.findMany({ select: { id: true, organizationId: true } });
  for (const provider of providers) {
    await deps.jobs.schedule("provider.refresh-models", provider.id, DAILY_MODELS_CRON, {
      organizationId: organizationIdSchema.parse(provider.organizationId),
      providerId: providerIdSchema.parse(provider.id),
    });
  }
  return providers.length;
};
