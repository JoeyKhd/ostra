import type { Db } from "@ostra/db";
import { apiFormatFromDb, authSchemeFromDb } from "@ostra/db";
import { secretRefSchema } from "@ostra/adapter-sdk";
import type { CatalogEntry } from "@ostra/adapter-sdk";
import type { OrganizationId, ProviderId } from "@ostra/protocol";

import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";

// F-088, ADR 0033: lists a provider's models from its endpoint, matches each to the models.dev
// catalog (or marks it custom), and keeps the rows. The `provider.refresh-models` job (core, ticket
// 28) and `providers.refresh` (the panel's button) both call this, so they can't disagree.
//
// What a refresh never does: overwrite what an admin entered for a custom model (its name, limits
// and prices), or delete a model that agent profiles point at: one the endpoint no longer lists
// is marked unlisted.

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
  const matches = deps.adapters.modelProvider.matchCatalog(listed.value, await deps.catalog());
  const byId = new Map(matches.map((match) => [match.endpointModelId, match.match] as const));
  const now = new Date(deps.clock.now());
  let matched = 0;

  await db.$transaction(async (tx) => {
    const existing = await tx.model.findMany({ where: { providerId, organizationId } });
    const known = new Map(existing.map((row) => [row.endpointModelId, row] as const));
    for (const model of listed.value) {
      const match = byId.get(model.endpointModelId);
      const row = known.get(model.endpointModelId);
      if (match?.kind === "catalog") {
        matched += 1;
        const entry = match.entry;
        const values = {
          catalogId: entry.catalogId,
          displayName: entry.name,
          contextWindow: entry.contextWindow ?? model.contextWindow,
          maxOutputTokens: entry.maxOutputTokens,
          inputPricePerMTok: entry.inputPricePerMTok,
          outputPricePerMTok: entry.outputPricePerMTok,
          listed: true,
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
          },
        });
      } else {
        // A custom model keeps what the admin entered; the endpoint only fills what is empty.
        await tx.model.update({
          where: { id: row.id },
          data: {
            listed: true,
            ...(row.catalogId === null
              ? {
                  displayName: row.displayName ?? model.displayName,
                  contextWindow: row.contextWindow ?? model.contextWindow,
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
    await tx.modelProvider.update({ where: { id: providerId }, data: { modelsRefreshedAt: now } });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "model-provider", entityId: providerId });
  });
  return { ok: true, listed: listed.value.length, matched };
};
