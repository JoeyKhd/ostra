import type { Db, Tx } from "@ostra/db";
import { modelIdSchema, providerIdSchema } from "@ostra/protocol";
import type { ModelId, OrganizationId, ProjectId, ProviderId } from "@ostra/protocol";

import type { JobQueue } from "../ports.ts";
import { createNeedsYouItemInTx, resolveNeedsYouItemsInTx } from "../use-cases/needs-you-items.ts";
import { modelNameOfColumns, modelNameOfModel, modelNameText } from "./model-name.ts";
import type { ModelName } from "./model-name.ts";
import { loadProviderList, resolveSessionModel } from "./provider-lists.ts";
import { providerGate } from "./resolve.ts";
import type { ProviderGate } from "./resolve.ts";

// Keys per project at a session's start and at every turn start (F-135, ADR 0065, ticket 48).
// A session records the provider and model row its start resolved; the dispatch, the task spec,
// the credentials and the spend read only those, and check them against the project's list as it
// is now. Nothing here falls back to another provider.

/** What a profile's model is by name: its two columns, else (a profile saved before milestone 4) its `Model` row's name. */
export const profileModelName = (profile: {
  readonly modelCatalogId: string | null;
  readonly modelCustomName: string | null;
  readonly model: { readonly catalogId: string | null; readonly endpointModelId: string } | null;
}): ModelName | null => modelNameOfColumns(profile) ?? (profile.model === null ? null : modelNameOfModel(profile.model));

export type ProfileModelResolution =
  | {
      readonly ok: true;
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
      readonly modelName: ModelName;
      /** The resolved provider's personal-runner switch (Q47), which every start checks. */
      readonly allowOnPersonalRunners: boolean;
    }
  /** `modelName` null: the profile names no model at all; otherwise nothing on the project's list serves it. */
  | { readonly ok: false; readonly modelName: ModelName | null };

/** The provider and model row that serve a profile's model in a project now (`resolveSessionModel`). */
export const resolveProfileModelInTx = async (
  tx: Tx | Db,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly profileId: string },
): Promise<ProfileModelResolution> => {
  const profile = await tx.agentProfile.findFirst({
    where: { id: input.profileId, organizationId: input.organizationId },
    select: { modelCatalogId: true, modelCustomName: true, model: { select: { catalogId: true, endpointModelId: true } } },
  });
  const modelName = profile === null ? null : profileModelName(profile);
  if (modelName === null) {
    return { ok: false, modelName: null };
  }
  const resolved = await resolveSessionModel(tx, { organizationId: input.organizationId, projectId: input.projectId, modelName });
  if (!resolved.ok) {
    return { ok: false, modelName };
  }
  const provider = await tx.modelProvider.findFirst({
    where: { id: resolved.providerId, organizationId: input.organizationId },
    select: { allowOnPersonalRunners: true },
  });
  if (provider === null) {
    return { ok: false, modelName };
  }
  return { ok: true, providerId: resolved.providerId, modelId: resolved.modelId, modelName, allowOnPersonalRunners: provider.allowOnPersonalRunners };
};

/** The words a refusal carries when nothing on the project's list serves the model. */
export const noProviderMessage = (modelName: ModelName): string =>
  `No provider on this project's list serves ${modelNameText(modelName)}: an organization admin adds one under Models`;

/**
 * Whether a session's recorded row is still one its project may use: the provider on the project's
 * list now, and the model row that provider's own. A forged or stale row is never used.
 */
export const sessionRowAllowedInTx = async (
  tx: Tx | Db,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly providerId: string; readonly modelId: string },
): Promise<boolean> => {
  const [state, model] = await Promise.all([
    loadProviderList(tx, input.organizationId, input.projectId),
    tx.model.findFirst({ where: { id: input.modelId, organizationId: input.organizationId }, select: { providerId: true } }),
  ]);
  return state !== null && model !== null && model.providerId === input.providerId && state.list.some((providerId) => providerId === input.providerId);
};

/**
 * The provider gate for a session's next turn (ADR 0065): `open` on its recorded row, `moved` when
 * the project now serves its model from another row, `none` when nothing serves it. `null` for a
 * session that recorded no row yet (its start resolves one).
 */
export const sessionProviderGateInTx = async (
  tx: Tx | Db,
  session: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly providerId: string | null; readonly modelId: string | null },
): Promise<ProviderGate | null> => {
  if (session.providerId === null || session.modelId === null) {
    return null;
  }
  const [state, model] = await Promise.all([
    loadProviderList(tx, session.organizationId, session.projectId),
    tx.model.findFirst({ where: { id: session.modelId, organizationId: session.organizationId }, select: { catalogId: true, endpointModelId: true } }),
  ]);
  if (state === null || model === null) {
    return null;
  }
  return providerGate(
    { providerId: providerIdSchema.parse(session.providerId), modelId: modelIdSchema.parse(session.modelId), modelName: modelNameOfModel(model) },
    state,
  );
};

/**
 * Both checks a recorded row gets at a turn start, from one read of the project's list: whether
 * the row is still allowed, and the provider gate for the turn.
 */
export const sessionRowStateInTx = async (
  tx: Tx | Db,
  session: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly providerId: string; readonly modelId: string },
): Promise<{ readonly allowed: boolean; readonly gate: ProviderGate | null }> => {
  const [state, model] = await Promise.all([
    loadProviderList(tx, session.organizationId, session.projectId),
    tx.model.findFirst({ where: { id: session.modelId, organizationId: session.organizationId }, select: { providerId: true, catalogId: true, endpointModelId: true } }),
  ]);
  if (state === null || model === null) {
    return { allowed: false, gate: null };
  }
  const allowed = model.providerId === session.providerId && state.list.some((providerId) => providerId === session.providerId);
  const gate = providerGate(
    { providerId: providerIdSchema.parse(session.providerId), modelId: modelIdSchema.parse(session.modelId), modelName: modelNameOfModel(model) },
    state,
  );
  return { allowed, gate };
};

/**
 * The needs-you item a task that no provider serves raises, for the organization's admins (who
 * alone edit the lists, F-003): one open item per task.
 */
export const raiseNoProviderInTx = async (
  deps: { readonly jobs: JobQueue },
  tx: Tx,
  task: { readonly organizationId: string; readonly projectId: string; readonly id: string },
  modelName: ModelName,
): Promise<void> => {
  const open = await tx.needsYouItem.findFirst({ where: { taskId: task.id, reason: "no_provider_for_model", state: "open" }, select: { id: true } });
  if (open !== null) {
    return;
  }
  await createNeedsYouItemInTx(deps, tx, {
    organizationId: task.organizationId,
    projectId: task.projectId,
    taskId: task.id,
    reason: "no_provider_for_model",
    audience: "organization_admins",
    summary: modelNameText(modelName),
  });
};

/** A provider serves the task's model again: its open "no provider" item is closed by ostra. */
export const clearNoProviderInTx = async (deps: { readonly jobs: JobQueue }, tx: Tx, task: { readonly id: string }, at: number): Promise<void> => {
  await resolveNeedsYouItemsInTx(deps, tx, { taskId: task.id, reason: "no_provider_for_model" }, { state: "answered", at: new Date(at), byMemberId: null });
};
