import type { Db } from "@ostra/db";
import { apiFormatFromDb, authSchemeFromDb, Prisma } from "@ostra/db";
import { secretRefSchema } from "@ostra/adapter-sdk";
import type { CatalogEntry, CatalogMatch } from "@ostra/adapter-sdk";
import { reasoningControlsSchema } from "@ostra/protocol";
import type { InputModality, OrganizationId, ProviderId } from "@ostra/protocol";

import type { Ports } from "../ports.ts";
import { isBatchVariant, variantTagOf } from "../providers/model-name.ts";
import { followRenamedModelsInTx, keepChoicesAfterRefreshInTx, loadListedModelsInTx, moveChoicesOffBatchRowsInTx } from "../providers/provider-lists.ts";
import type { UseCaseResult } from "./common.ts";

// F-088, ADR 0033: lists a provider's models from its endpoint, matches each to the models.dev
// catalog (or marks it custom), and keeps the rows. The `provider.refresh-models` job (core, ticket
// 28) and `providers.refresh` (the panel's button) both call this, so they can't disagree.
//
// What a refresh never does: overwrite what an admin entered for a custom model (its name, limits
// and prices), an admin's reasoning controls for any model (F-137) or an admin's "Reads images"
// (F-148), or delete a model that agent profiles point at: one the endpoint no longer lists
// is marked unlisted.
//
// 2026-11-22 (ADR 0033): each model matches its serving provider's own entry (an OpenRouter model,
// OpenRouter's), so a refresh can move a row that an older release matched to another provider's
// entry. It rewrites the row's catalog ID, inputs, reasoning, limits and catalog prices, and what
// named the model by its old ID follows it (`followRenamedModelsInTx`).
//
// A batch variant (`x:batch`, the endpoint's asynchronous batch API) is kept unlisted too, so no
// picker offers it beside `x`. Only this sync writes `listed` (no admin sets it), so every refresh
// applies the rule to every row, including those an earlier version listed, and a choice on one
// moves to its provider's plain row.

/** Whether a model the endpoint lists is one ostra offers: all but a batch variant (F-088). */
const offered = (endpointModelId: string): boolean => !isBatchVariant(endpointModelId);

/**
 * A custom model's inputs as its endpoint's own list says them (2026-11-22, F-148), where models.dev
 * doesn't know the model: nothing when the list says nothing, so what was there stays. An admin's
 * "Reads images" is another column, and wins.
 */
const listedInputs = (match: CatalogMatch["match"] | undefined): { readonly catalogInputModalities?: InputModality[] } =>
  match?.kind === "custom" && match.inputModalities !== undefined ? { catalogInputModalities: [...match.inputModalities] } : {};

export type SyncProviderModelsDeps = Pick<Ports, "notices" | "clock" | "adapters"> & {
  readonly db: Db;
  /** The catalog's entries, from the server's cache (ticket 31's `CatalogSource`). */
  readonly catalog: () => Promise<readonly CatalogEntry[]>;
};

export type SyncProviderModelsResult = UseCaseResult<
  { readonly listed: number; readonly matched: number },
  "not-found" | "secret-unreadable" | "endpoint-failed"
>;

export type SyncProviderModels = (
  deps: SyncProviderModelsDeps,
  target: { readonly organizationId: OrganizationId; readonly providerId: ProviderId },
) => Promise<SyncProviderModelsResult>;

const refuse = (error: Exclude<SyncProviderModelsResult, { readonly ok: true }>["error"], message: string): SyncProviderModelsResult => ({
  ok: false,
  error,
  message,
});

export const syncProviderModels: SyncProviderModels = async (deps, target) => {
  const { db } = deps;
  const { organizationId, providerId } = target;
  const provider = await db.modelProvider.findFirst({ where: { id: providerId, organizationId } });
  if (provider === null) {
    return refuse("not-found", "No such model provider");
  }
  const ref = secretRefSchema.safeParse(provider.tokenSecretRef);
  if (!ref.success) {
    return refuse("secret-unreadable", "The provider's token reference is malformed");
  }
  const token = await deps.adapters.secretStore.get(organizationId, ref.data);
  if (!token.ok) {
    return refuse("secret-unreadable", "The provider's token could not be read from the secret store");
  }
  const apiFormat = apiFormatFromDb[provider.apiFormat];
  const listed = await deps.adapters.modelProvider.listModels({
    baseUrl: provider.baseUrl,
    token: token.value,
    authScheme: authSchemeFromDb[provider.authScheme],
    apiFormat,
  });
  if (!listed.ok) {
    return refuse("endpoint-failed", `The endpoint did not list its models: ${listed.error.message}`);
  }
  // 2026-11-22 (ADR 0033): the base URL says which provider serves these models, so each matches
  // that provider's own catalog entry, with its prices, limits, reasoning and inputs.
  const matches = deps.adapters.modelProvider.matchCatalog(listed.value, await deps.catalog(), { baseUrl: provider.baseUrl });
  const byId = new Map(matches.map((match) => [match.endpointModelId, match.match] as const));
  const now = new Date(deps.clock.now());
  let matched = 0;

  await db.$transaction(async (tx) => {
    // Milestone 4 (F-135): the rows as they were, for the keep rule at the end.
    const before = await loadListedModelsInTx(tx, organizationId);
    const existing = await tx.model.findMany({ where: { providerId, organizationId } });
    const known = new Map(existing.map((row) => [row.endpointModelId, row] as const));
    // A row this refresh matches to another entry: its old catalog ID, and its new one.
    const renames = new Map<string, string>();
    for (const model of listed.value) {
      const match = byId.get(model.endpointModelId);
      const row = known.get(model.endpointModelId);
      if (match?.kind === "catalog") {
        matched += 1;
        const entry = match.entry;
        const was = row?.catalogId ?? null;
        if (was !== null && was !== entry.catalogId && (!renames.has(was) || variantTagOf(model.endpointModelId) === null)) {
          // The plain row's new name, when `x` and `x:batch` had one name.
          renames.set(was, entry.catalogId);
        }
        // F-037 (ADR 0055): an admin's price comes last in the order and wins, so a refresh keeps it.
        const priced = [entry.inputPricePerMTok, entry.outputPricePerMTok, entry.cacheReadPricePerMTok, entry.cacheWritePricePerMTok].some((price) => price !== null);
        const prices =
          row?.priceSource === "admin"
            ? {}
            : {
                inputPricePerMTok: entry.inputPricePerMTok,
                outputPricePerMTok: entry.outputPricePerMTok,
                // Q163: the cache prices when the catalog has them; unknown ones price at the input price.
                cacheReadPricePerMTok: entry.cacheReadPricePerMTok ?? null,
                cacheWritePricePerMTok: entry.cacheWritePricePerMTok ?? null,
                // 2026-11-22: the prices come from models.dev (the serving provider's entry), and say so.
                priceSource: priced ? ("catalog" as const) : null,
              };
        const values = {
          catalogId: entry.catalogId,
          displayName: entry.name,
          contextWindow: entry.contextWindow ?? model.contextWindow,
          maxOutputTokens: entry.maxOutputTokens,
          ...prices,
          // F-137 (ADR 0066): the catalog's reasoning controls. An admin's (`adminReasoning`) are
          // never written here, so a refresh never undoes them.
          catalogReasoning: reasoningControlsSchema.parse(entry.reasoning),
          // F-148 (ADR 0070, Q335): the catalog's inputs (models.dev's `modalities.input`), `null`
          // when it says nothing. An admin's "Reads images" (`adminImageInput`) is never written
          // here, so a refresh never undoes it.
          catalogInputModalities: entry.inputModalities === null ? Prisma.DbNull : [...entry.inputModalities],
          listed: offered(model.endpointModelId),
        };
        if (row === undefined) {
          await tx.model.create({ data: { organizationId, providerId, endpointModelId: model.endpointModelId, ...values } });
        } else {
          await tx.model.update({ where: { id: row.id }, data: values });
        }
      } else if (row === undefined) {
        await tx.model.create({
          data: {
            organizationId,
            providerId,
            endpointModelId: model.endpointModelId,
            displayName: model.displayName,
            contextWindow: model.contextWindow,
            ...listedInputs(match),
            listed: offered(model.endpointModelId),
          },
        });
      } else {
        // A custom model keeps what the admin entered; the endpoint only fills what is empty.
        await tx.model.update({
          where: { id: row.id },
          data: {
            listed: offered(model.endpointModelId),
            ...(row.catalogId === null
              ? {
                  displayName: row.displayName ?? model.displayName,
                  contextWindow: row.contextWindow ?? model.contextWindow,
                  ...listedInputs(match),
                }
              : {}),
          },
        });
      }
    }
    const listedIds = new Set(listed.value.map((model) => model.endpointModelId));
    const gone = existing.filter((row) => row.listed && !listedIds.has(row.endpointModelId)).map((row) => row.id);
    if (gone.length > 0) {
      await tx.model.updateMany({ where: { id: { in: gone } }, data: { listed: false } });
    }
    // 2026-11-22: what names a renamed model by its old catalog ID follows it, before the keep rule.
    await followRenamedModelsInTx(tx, organizationId, providerId, renames);
    // F-088: a choice on a batch row stays on its provider, from the plain row.
    await moveChoicesOffBatchRowsInTx(tx, organizationId, providerId);
    // A model this refresh gives a second provider on a list keeps the one serving it (ADR 0065).
    await keepChoicesAfterRefreshInTx(tx, organizationId, providerId, before);
    await tx.modelProvider.update({ where: { id: providerId }, data: { modelsRefreshedAt: now } });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "model-provider", entityId: providerId });
  });
  return { ok: true, listed: listed.value.length, matched };
};
