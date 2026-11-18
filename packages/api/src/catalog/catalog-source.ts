import type { CatalogEntry, Logger } from "@ostra/adapter-sdk";
import type { Clock } from "@ostra/domain";

// The models.dev catalog as the routers read it (F-088, ADR 0033, ADR 0021): names, limits, prices
// and logos for the models an endpoint lists. The panel never calls models.dev: the server holds
// the catalog, and one setting (`OSTRA_CATALOG_FETCH`) turns the fetch off, which leaves the copy
// bundled with ostra. The fetch itself and the bundled copy come from the model endpoint adapter
// (ticket 12) and core's refresh job (ticket 28); this is the read-through cache the routers use.

export type CatalogSource = {
  /** The catalog's entries: the last good fetch, or the bundled copy. Never throws. */
  readonly entries: () => Promise<readonly CatalogEntry[]>;
};

export type CreateCatalogSourceInput = {
  /** `OSTRA_CATALOG_FETCH`. Off: no request is ever made. */
  readonly fetchEnabled: boolean;
  /** The copy that ships with ostra, read from disk or the package. */
  readonly loadBundled: () => Promise<readonly CatalogEntry[]>;
  /** A plain GET of the catalog that carries no install data (ADR 0021), parsed loosely. */
  readonly fetchLatest: () => Promise<readonly CatalogEntry[]>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** How long a fetched catalog is served before the next fetch. Default: a day. */
  readonly ttlMs?: number;
  /** How long after a failed fetch before the next try. Default: ten minutes. */
  readonly retryAfterFailureMs?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * A catalog that fetches at most once per `ttlMs`, keeps the last good copy when a fetch fails,
 * falls back to the bundled copy when it never succeeded, and shares one fetch between callers
 * that arrive together.
 */
export const createCatalogSource = (input: CreateCatalogSourceInput): CatalogSource => {
  const ttlMs = input.ttlMs ?? DAY_MS;
  const retryMs = input.retryAfterFailureMs ?? TEN_MINUTES_MS;
  let current: { readonly entries: readonly CatalogEntry[]; readonly freshUntil: number } | null = null;
  let inFlight: Promise<readonly CatalogEntry[]> | null = null;

  const loadBundledOrEmpty = async (): Promise<readonly CatalogEntry[]> => {
    try {
      return await input.loadBundled();
    } catch {
      input.logger.warn("catalog.bundled_unreadable");
      return [];
    }
  };

  const refresh = async (): Promise<readonly CatalogEntry[]> => {
    const now = input.clock.now();
    if (!input.fetchEnabled) {
      const bundled = await loadBundledOrEmpty();
      current = { entries: bundled, freshUntil: Number.POSITIVE_INFINITY };
      return bundled;
    }
    try {
      const fetched = await input.fetchLatest();
      current = { entries: fetched, freshUntil: now + ttlMs };
      return fetched;
    } catch (error) {
      input.logger.warn("catalog.fetch_failed", { reason: error instanceof Error ? error.name : "unknown" });
      if (current !== null) {
        // Keep the last good copy, and don't try again at once.
        current = { entries: current.entries, freshUntil: now + retryMs };
        return current.entries;
      }
      const bundled = await loadBundledOrEmpty();
      current = { entries: bundled, freshUntil: now + retryMs };
      return bundled;
    }
  };

  return {
    entries: () => {
      if (current !== null && input.clock.now() < current.freshUntil) {
        return Promise.resolve(current.entries);
      }
      inFlight ??= refresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
};
