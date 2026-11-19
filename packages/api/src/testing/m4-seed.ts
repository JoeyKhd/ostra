import { randomBytes } from "node:crypto";

import type { Db } from "@ostra/db";
import { modelIdSchema, providerIdSchema } from "@ostra/protocol";
import type { ModelId, OrganizationId, ProjectId, ProviderId } from "@ostra/protocol";

// Seeding helpers for milestone 4's read views (spend, budgets, Insights): providers, models and the
// rollup rows core's ingest and `insights.compute` write, written directly so a view's test can
// state its fixture and compare with the domain's reference definitions.

/** A provider row (its token never read here). */
export const seedProviderRow = async (db: Db, organizationId: OrganizationId, name: string): Promise<ProviderId> => {
  const row = await db.modelProvider.create({
    data: {
      organizationId,
      name,
      baseUrl: `https://${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.example.com/v1`,
      apiFormat: "anthropic_messages",
      authScheme: "x_api_key",
      tokenSecretRef: `secret-${randomBytes(4).toString("hex")}`,
    },
    select: { id: true },
  });
  return providerIdSchema.parse(row.id);
};

/** A model row on a provider, priced or not. Prices are dollars per million tokens. */
export const seedModelRow = async (
  db: Db,
  input: {
    readonly organizationId: OrganizationId;
    readonly providerId: ProviderId;
    readonly endpointModelId: string;
    readonly catalogId?: string | null;
    readonly displayName?: string | null;
    readonly inputPricePerMTok?: number | null;
    readonly outputPricePerMTok?: number | null;
  },
): Promise<ModelId> => {
  const row = await db.model.create({
    data: {
      organizationId: input.organizationId,
      providerId: input.providerId,
      endpointModelId: input.endpointModelId,
      catalogId: input.catalogId ?? null,
      displayName: input.displayName ?? null,
      inputPricePerMTok: input.inputPricePerMTok ?? null,
      outputPricePerMTok: input.outputPricePerMTok ?? null,
    },
    select: { id: true },
  });
  return modelIdSchema.parse(row.id);
};

export type SpendRowInput = {
  readonly projectId: ProjectId;
  readonly modelId: ModelId;
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly spentMicroUsd?: number;
  readonly unpricedTokens?: number;
};

/** `SpendDaily` rows, as ticket 12's ingest leaves them. */
export const seedSpendRows = async (db: Db, organizationId: OrganizationId, rows: readonly SpendRowInput[]): Promise<void> => {
  await db.spendDaily.createMany({
    data: rows.map((row) => ({
      organizationId,
      projectId: row.projectId,
      modelId: row.modelId,
      day: new Date(`${row.day}T00:00:00.000Z`),
      inputTokens: BigInt(row.inputTokens ?? 0),
      outputTokens: BigInt(row.outputTokens ?? 0),
      cacheReadTokens: BigInt(row.cacheReadTokens ?? 0),
      cacheWriteTokens: BigInt(row.cacheWriteTokens ?? 0),
      spentMicroUsd: BigInt(row.spentMicroUsd ?? 0),
      unpricedTokens: BigInt(row.unpricedTokens ?? 0),
    })),
  });
};
