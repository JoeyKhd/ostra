import type { Db, Tx } from "@ostra/db";
import { modelIdSchema, providerIdSchema } from "@ostra/protocol";
import type { ModelId, OrganizationId, ProjectId, ProviderId } from "@ostra/protocol";

import type { JobQueue } from "../ports.ts";
import { createNeedsYouItemInTx, resolveNeedsYouItemsInTx } from "../use-cases/needs-you-items.ts";
import { modelNameOfColumns, modelNameOfModel, modelNameText } from "./model-name.ts";
import type { ModelName } from "./model-name.ts";
import { loadProviderList } from "./provider-lists.ts";
import { providerGate, resolveProfileModel } from "./resolve.ts";
import type { ProviderGate, Resolution } from "./resolve.ts";

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

/**
 * Why a profile's own provider can't serve its task (ADR 0065 amended 2026-11-20): the project's
 * list doesn't allow it, or it no longer lists the model. Its name is what the refusal says.
 */
export type ProfileProviderRefusal = {
  readonly providerId: ProviderId;
  readonly name: string;
  readonly reason: "not-allowed" | "not-listed";
};

export type ProfileModelResolution =
  | {
      readonly ok: true;
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
      readonly modelName: ModelName;
      /** The resolved provider's personal-runner switch (Q47), which every start checks. */
      readonly allowOnPersonalRunners: boolean;
    }
  /**
   * `modelName` null: the profile names no model at all. Otherwise nothing serves it: with
   * `provider`, the profile's own provider isn't allowed or doesn't list it; with `null`, nothing on
   * the project's list serves it by name.
   */
  | { readonly ok: false; readonly modelName: ModelName | null; readonly provider: ProfileProviderRefusal | null };

/**
 * The provider and model row that serve a profile's model in a project now: the profile's own
 * provider when it names one, which the project's list must allow (F-135, ADR 0065 amended
 * 2026-11-20), else the provider the project's list serves the name from.
 */
export const resolveProfileModelInTx = async (
  tx: Tx | Db,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly profileId: string },
): Promise<ProfileModelResolution> => {
  const profile = await tx.agentProfile.findFirst({
    where: { id: input.profileId, organizationId: input.organizationId },
    select: {
      modelCatalogId: true,
      modelCustomName: true,
      model: { select: { catalogId: true, endpointModelId: true } },
      provider: { select: { id: true, name: true } },
    },
  });
  const modelName = profile === null ? null : profileModelName(profile);
  if (profile === null || modelName === null) {
    return { ok: false, modelName: null, provider: null };
  }
  const pinned = profile.provider === null ? null : { providerId: providerIdSchema.parse(profile.provider.id), name: profile.provider.name };
  const state = await loadProviderList(tx, input.organizationId, input.projectId);
  const resolved: Resolution =
    state === null ? { ok: false, reason: "no-provider" } : resolveProfileModel(state.list, state.choices, state.models, modelName, pinned?.providerId ?? null);
  if (!resolved.ok) {
    return {
      ok: false,
      modelName,
      provider: pinned === null ? null : { ...pinned, reason: resolved.reason === "not-allowed" ? "not-allowed" : "not-listed" },
    };
  }
  const provider = await tx.modelProvider.findFirst({
    where: { id: resolved.providerId, organizationId: input.organizationId },
    select: { allowOnPersonalRunners: true },
  });
  if (provider === null) {
    return { ok: false, modelName, provider: null };
  }
  return { ok: true, providerId: resolved.providerId, modelId: resolved.modelId, modelName, allowOnPersonalRunners: provider.allowOnPersonalRunners };
};

/**
 * The words a refusal carries when nothing serves the model: the profile's own provider that the
 * project doesn't allow, or that no longer lists the model, else no provider on the project's list.
 */
export const noProviderMessage = (modelName: ModelName, provider: ProfileProviderRefusal | null = null): string => {
  if (provider === null) {
    return `No provider on this project's list serves ${modelNameText(modelName)}: an organization admin adds one under Models`;
  }
  return provider.reason === "not-allowed"
    ? `The profile runs on ${provider.name}, which this project's list doesn't allow: an organization admin adds it in Models and keys, or a member picks a profile on an allowed key`
    : `${provider.name}, the profile's provider, no longer lists ${modelNameText(modelName)}: an organization admin picks another model for the profile`;
};

/** Whether a session's profile names its provider (ADR 0065 amended 2026-11-20): then it never moves to another. */
const profilePinnedInTx = async (tx: Tx | Db, organizationId: OrganizationId, agentProfileId: string | null): Promise<boolean> => {
  if (agentProfileId === null) {
    return false;
  }
  const profile = await tx.agentProfile.findFirst({ where: { id: agentProfileId, organizationId }, select: { providerId: true } });
  return profile !== null && profile.providerId !== null;
};

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
  session: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly providerId: string | null;
    readonly modelId: string | null;
    /** The session's profile: one that names its provider keeps the session on it (ADR 0065 amended). */
    readonly agentProfileId: string | null;
  },
): Promise<ProviderGate | null> => {
  if (session.providerId === null || session.modelId === null) {
    return null;
  }
  const [state, model, pinned] = await Promise.all([
    loadProviderList(tx, session.organizationId, session.projectId),
    tx.model.findFirst({ where: { id: session.modelId, organizationId: session.organizationId }, select: { catalogId: true, endpointModelId: true } }),
    profilePinnedInTx(tx, session.organizationId, session.agentProfileId),
  ]);
  if (state === null || model === null) {
    return null;
  }
  return providerGate(
    { providerId: providerIdSchema.parse(session.providerId), modelId: modelIdSchema.parse(session.modelId), modelName: modelNameOfModel(model), pinned },
    state,
  );
};

/**
 * Both checks a recorded row gets at a turn start, from one read of the project's list: whether
 * the row is still allowed, and the provider gate for the turn.
 */
export const sessionRowStateInTx = async (
  tx: Tx | Db,
  session: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly providerId: string;
    readonly modelId: string;
    /** The session's profile: one that names its provider keeps the session on it (ADR 0065 amended). */
    readonly agentProfileId: string | null;
  },
): Promise<{ readonly allowed: boolean; readonly gate: ProviderGate | null }> => {
  const [state, model, pinned] = await Promise.all([
    loadProviderList(tx, session.organizationId, session.projectId),
    tx.model.findFirst({ where: { id: session.modelId, organizationId: session.organizationId }, select: { providerId: true, catalogId: true, endpointModelId: true } }),
    profilePinnedInTx(tx, session.organizationId, session.agentProfileId),
  ]);
  if (state === null || model === null) {
    return { allowed: false, gate: null };
  }
  const allowed = model.providerId === session.providerId && state.list.some((providerId) => providerId === session.providerId);
  const gate = providerGate(
    { providerId: providerIdSchema.parse(session.providerId), modelId: modelIdSchema.parse(session.modelId), modelName: modelNameOfModel(model), pinned },
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
