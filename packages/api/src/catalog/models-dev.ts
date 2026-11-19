import { loadBundledCatalog, parseModelsDevCatalog } from "@ostra/adapter-model-endpoint";
import type { Logger } from "@ostra/adapter-sdk";
import type { Clock } from "@ostra/domain";

import { createCatalogSource } from "./catalog-source.ts";
import type { CatalogSource } from "./catalog-source.ts";

// The real catalog source (F-088, ADR 0021, ADR 0033): the copy bundled with ostra, and, when
// `OSTRA_CATALOG_FETCH` is on, a daily plain GET of models.dev that carries no install data: no
// cookie, no identifier, nothing but the request itself.

export const MODELS_DEV_URL = "https://models.dev/api.json";

export type ModelsDevCatalogInput = {
  /** `OSTRA_CATALOG_FETCH`. */
  readonly fetchEnabled: boolean;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Tests give a fake; the server uses the platform's. */
  readonly fetchFn?: typeof fetch;
  readonly url?: string;
};

const FETCH_TIMEOUT_MS = 15_000;

export const createModelsDevCatalogSource = (input: ModelsDevCatalogInput): CatalogSource => {
  const fetchFn = input.fetchFn ?? fetch;
  return createCatalogSource({
    fetchEnabled: input.fetchEnabled,
    clock: input.clock,
    logger: input.logger,
    loadBundled: async () => (await loadBundledCatalog({ logger: input.logger })).entries,
    fetchLatest: async () => {
      const response = await fetchFn(input.url ?? MODELS_DEV_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`models.dev answered ${String(response.status)}`);
      }
      const parsed = parseModelsDevCatalog(await response.json(), { logger: input.logger });
      if (!parsed.ok) {
        // A copy that doesn't match the schema is refused, and the last good copy stays.
        throw new Error(parsed.error.message);
      }
      return parsed.value;
    },
  });
};
