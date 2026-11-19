import type { Db, Tx } from "@ostra/db";
import { modelIdSchema, projectIdSchema, providerIdSchema } from "@ostra/protocol";
import type { MemberId, ModelId, OrganizationId, ProjectId, ProviderId } from "@ostra/protocol";

import { requireOrganizationAdmin, requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import { modelNameColumns, modelNameKey, modelNameOfModel } from "./model-name.ts";
import type { ModelName } from "./model-name.ts";
import { keepChoicesOnRefresh, planProviderChange, resolveProjectModel } from "./resolve.ts";
import type { ListedModel, ModelChoiceRow, ProviderChangePlan, Resolution } from "./resolve.ts";

// Keys per project, against the database (F-135, ADR 0065): loading a project's list, its choices
// and the organization's model rows; resolving a session's model; and the organization admin's
// saves, each with its audit entry in its own transaction (ADR 0054), and the release of idle
// boxes that hold a key a project no longer allows (`providers.release-boxes`).

/** What the provider use cases take: the database and the ports they write through. */
export type ProviderDeps = { readonly db: Db } & Pick<Ports, "audit" | "jobs" | "clock">;

/** The audit actions of keys per project (spec section 5.5). */
export const providerAuditActions = {
  defaultChanged: "providers.default-changed",
  projectChanged: "project.providers-changed",
  choiceChanged: "project.model-choice-changed",
  credentialsRefused: "task.credentials-refused",
} as const;

/** One list's state: the organization's default (`projectId` null) or a project's own. */
export type ProviderListState = {
  /** `null`: the organization's default list, which the project follows unless `own`. */
  readonly listProjectId: ProjectId | null;
  readonly own: boolean;
  readonly list: readonly ProviderId[];
  readonly choices: readonly ModelChoiceRow[];
  readonly models: readonly ListedModel[];
};

/** Every model row of the organization, as the resolution reads them. */
export const loadListedModelsInTx = async (tx: Tx | Db, organizationId: OrganizationId): Promise<readonly ListedModel[]> =>
  (
    await tx.model.findMany({
      where: { organizationId },
      select: { id: true, providerId: true, catalogId: true, endpointModelId: true, listed: true },
      orderBy: { id: "asc" },
    })
  ).map((row) => ({
    modelId: modelIdSchema.parse(row.id),
    providerId: providerIdSchema.parse(row.providerId),
    name: modelNameOfModel(row),
    endpointModelId: row.endpointModelId,
    listed: row.listed,
  }));

const loadList = async (tx: Tx | Db, organizationId: OrganizationId, projectId: ProjectId | null) => {
  const [entries, choices] = await Promise.all([
    tx.providerListEntry.findMany({ where: { organizationId, projectId }, select: { providerId: true }, orderBy: { createdAt: "asc" } }),
    tx.modelChoice.findMany({ where: { organizationId, projectId }, select: { modelKey: true, modelId: true } }),
  ]);
  return {
    list: entries.map((entry) => providerIdSchema.parse(entry.providerId)),
    choices: choices.map((choice) => ({ modelKey: choice.modelKey, modelId: modelIdSchema.parse(choice.modelId) })),
  };
};

/** The list a project uses now: its own, or the organization's default. `projectId` null loads the default. */
export const loadProviderList = async (tx: Tx | Db, organizationId: OrganizationId, projectId: ProjectId | null): Promise<ProviderListState | null> => {
  let own = false;
  if (projectId !== null) {
    const project = await tx.project.findFirst({ where: { id: projectId, organizationId }, select: { ownProviders: true } });
    if (project === null) {
      return null;
    }
    own = project.ownProviders;
  }
  const listProjectId = own ? projectId : null;
  const [{ list, choices }, models] = await Promise.all([loadList(tx, organizationId, listProjectId), loadListedModelsInTx(tx, organizationId)]);
  return { listProjectId, own, list, choices, models };
};

/** What a session's start resolves: the provider and model row its project serves the name from. */
export const resolveSessionModel = async (
  tx: Tx | Db,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly modelName: ModelName },
): Promise<Resolution> => {
  const state = await loadProviderList(tx, input.organizationId, input.projectId);
  return state === null ? { ok: false, reason: "no-provider" } : resolveProjectModel(state.list, state.choices, state.models, input.modelName);
};

const refuse = <E extends string>(error: E, message: string): { readonly ok: false; readonly error: E; readonly message: string } => ({ ok: false, error, message });

const memberActor = (memberId: MemberId) => ({ kind: "member", id: memberId }) as const;

/** The org's providers among `providerIds`, or `null` when one isn't the organization's. */
const ownProviders = async (tx: Tx, organizationId: OrganizationId, providerIds: readonly ProviderId[]): Promise<readonly ProviderId[] | null> => {
  const unique = [...new Set(providerIds)];
  const found = await tx.modelProvider.count({ where: { organizationId, id: { in: unique } } });
  return found === unique.length ? unique : null;
};

/** Writes a list as the plan says: entries, dropped and kept choices. */
const writeList = async (
  tx: Tx,
  organizationId: OrganizationId,
  listProjectId: ProjectId | null,
  before: readonly ProviderId[],
  after: readonly ProviderId[],
  plan: ProviderChangePlan,
  models: readonly ListedModel[],
  memberId: MemberId,
): Promise<void> => {
  const removed = before.filter((providerId) => !after.includes(providerId));
  const added = after.filter((providerId) => !before.includes(providerId));
  if (removed.length > 0) {
    await tx.providerListEntry.deleteMany({ where: { organizationId, projectId: listProjectId, providerId: { in: [...removed] } } });
  }
  for (const providerId of added) {
    await tx.providerListEntry.create({ data: { organizationId, projectId: listProjectId, providerId, addedByMemberId: memberId } });
  }
  if (plan.drop.length > 0) {
    await tx.modelChoice.deleteMany({ where: { organizationId, projectId: listProjectId, modelKey: { in: [...plan.drop] } } });
  }
  for (const choice of plan.keep) {
    await upsertChoice(tx, organizationId, listProjectId, choice.modelId, models, { reason: "kept", memberId: null });
  }
};

const upsertChoice = async (
  tx: Tx,
  organizationId: OrganizationId,
  listProjectId: ProjectId | null,
  modelId: ModelId,
  models: readonly ListedModel[],
  by: { readonly reason: "admin" | "kept"; readonly memberId: MemberId | null },
): Promise<void> => {
  const row = models.find((model) => model.modelId === modelId);
  if (row === undefined) {
    throw new Error("a choice's model row is the organization's");
  }
  const key = modelNameKey(row.name);
  const data = { modelId, chosenByMemberId: by.memberId, reason: by.reason, needsConfirm: false };
  const existing = await tx.modelChoice.findFirst({ where: { organizationId, projectId: listProjectId, modelKey: key }, select: { id: true } });
  if (existing === null) {
    await tx.modelChoice.create({ data: { organizationId, projectId: listProjectId, modelKey: key, ...modelNameColumns(row.name), ...data } });
  } else {
    await tx.modelChoice.update({ where: { id: existing.id }, data });
  }
};

/**
 * The keep rule after a provider's model refresh (F-135, ADR 0065), in the refresh's transaction:
 * on every list the provider is on, a model the refresh would give a second provider keeps the one
 * serving it, recorded as a `kept` choice. `before` is the organization's rows as the refresh found
 * them. Returns how many choices it recorded.
 */
export const keepChoicesAfterRefreshInTx = async (
  tx: Tx,
  organizationId: OrganizationId,
  providerId: ProviderId,
  before: readonly ListedModel[],
): Promise<number> => {
  const entries = await tx.providerListEntry.findMany({ where: { organizationId, providerId }, select: { projectId: true } });
  const listIds = [...new Set(entries.map((entry) => entry.projectId))];
  const lists = await Promise.all(
    listIds.map(async (listId) => ({ listProjectId: listId === null ? null : projectIdSchema.parse(listId), ...(await loadList(tx, organizationId, listId === null ? null : projectIdSchema.parse(listId))) })),
  );
  const after = await loadListedModelsInTx(tx, organizationId);
  let recorded = 0;
  for (const { list, keep } of keepChoicesOnRefresh(lists, before, after)) {
    for (const choice of keep) {
      await upsertChoice(tx, organizationId, list.listProjectId, choice.modelId, after, { reason: "kept", memberId: null });
      recorded += 1;
    }
  }
  return recorded;
};

/** Idle boxes holding a key a project no longer allows are released (ADR 0065). */
const releaseBoxes = async (deps: ProviderDeps, tx: Tx, organizationId: OrganizationId, projectIds: readonly ProjectId[]): Promise<void> => {
  const at = deps.clock.now();
  for (const projectId of projectIds) {
    await deps.jobs.enqueueInTx(tx, "providers.release-boxes", { organizationId, projectId, changedAt: at });
  }
};

export type ProviderListSaved = { readonly plan: ProviderChangePlan };

/**
 * The organization's default list (F-135). The default may be empty. Every project that follows
 * it changes with it, and those that lost a provider have their idle boxes released.
 */
export const setDefaultProviders = async (
  deps: ProviderDeps,
  scope: MemberScope,
  input: { readonly providerIds: readonly ProviderId[] },
): Promise<UseCaseResult<ProviderListSaved, "forbidden" | "not-found">> => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin changes the provider lists");
  }
  return deps.db.$transaction(async (tx): Promise<UseCaseResult<ProviderListSaved, "forbidden" | "not-found">> => {
    const after = await ownProviders(tx, organizationId, input.providerIds);
    if (after === null) {
      return refuse("not-found", "A provider isn't this organization's");
    }
    const state = await loadProviderList(tx, organizationId, null);
    if (state === null) {
      return refuse("not-found", "No such organization");
    }
    const plan = planProviderChange({ list: state.list, choices: state.choices }, after, state.models);
    await writeList(tx, organizationId, null, state.list, after, plan, state.models, scope.memberId);
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: memberActor(scope.memberId),
      action: providerAuditActions.defaultChanged,
      entity: "organization",
      entityId: organizationId,
      data: { providers: after.length, moved: plan.lines.filter((line) => line.change === "moves").length, lost: plan.lines.filter((line) => line.change === "loses").length },
    });
    if (state.list.some((providerId) => !after.includes(providerId))) {
      const following = await tx.project.findMany({ where: { organizationId, ownProviders: false }, select: { id: true }, orderBy: { id: "asc" } });
      await releaseBoxes(deps, tx, organizationId, following.map((project) => projectIdSchema.parse(project.id)));
    }
    return { ok: true, plan };
  });
};

/**
 * A project's providers (F-135): follow the organization's default list, or have its own. A
 * project given its own list starts from a copy of the default and its choices.
 */
export const setProjectProviders = async (
  deps: ProviderDeps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly mode: { readonly kind: "default" } | { readonly kind: "own"; readonly providerIds: readonly ProviderId[] } },
): Promise<UseCaseResult<ProviderListSaved, "forbidden" | "not-found">> => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin changes a project's providers");
  }
  return deps.db.$transaction(async (tx): Promise<UseCaseResult<ProviderListSaved, "forbidden" | "not-found">> => {
    const current = await loadProviderList(tx, organizationId, input.projectId);
    if (current === null) {
      return refuse("not-found", "No such project");
    }
    let plan: ProviderChangePlan;
    let after: readonly ProviderId[];
    if (input.mode.kind === "default") {
      const fallback = await loadProviderList(tx, organizationId, null);
      if (fallback === null) {
        return refuse("not-found", "No such organization");
      }
      after = fallback.list;
      plan = planProviderChange({ list: current.list, choices: current.choices }, after, current.models);
      await tx.providerListEntry.deleteMany({ where: { organizationId, projectId: input.projectId } });
      await tx.modelChoice.deleteMany({ where: { organizationId, projectId: input.projectId } });
      await tx.project.update({ where: { id: input.projectId }, data: { ownProviders: false } });
    } else {
      const own = await ownProviders(tx, organizationId, input.mode.providerIds);
      if (own === null) {
        return refuse("not-found", "A provider isn't this organization's");
      }
      after = own;
      plan = planProviderChange({ list: current.list, choices: current.choices }, after, current.models);
      if (!current.own) {
        // Starting its own list: a copy of the default's choices, then the change.
        for (const choice of current.choices) {
          if (!plan.drop.includes(choice.modelKey)) {
            await upsertChoice(tx, organizationId, input.projectId, choice.modelId, current.models, { reason: "kept", memberId: null });
          }
        }
        await writeList(tx, organizationId, input.projectId, [], after, { ...plan, drop: [] }, current.models, scope.memberId);
        await tx.project.update({ where: { id: input.projectId }, data: { ownProviders: true } });
      } else {
        await writeList(tx, organizationId, input.projectId, current.list, after, plan, current.models, scope.memberId);
      }
    }
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: input.projectId,
      actor: memberActor(scope.memberId),
      action: providerAuditActions.projectChanged,
      entity: "project",
      entityId: input.projectId,
      data: { mode: input.mode.kind, providers: after.length },
    });
    if (current.list.some((providerId) => !after.includes(providerId))) {
      await releaseBoxes(deps, tx, organizationId, [input.projectId]);
    }
    return { ok: true, plan };
  });
};

/** What a save would do, shown before it's applied (ADR 0065): every model whose provider changes. Reads only. */
export const previewProviderChange = async (
  db: Db,
  scope: MemberScope,
  input: { readonly projectId: ProjectId | null; readonly providerIds: readonly ProviderId[] },
): Promise<UseCaseResult<ProviderListSaved, "forbidden" | "not-found">> => {
  if (!requireOrganizationAdmin(scope, scope.organizationId).ok) {
    return refuse("forbidden", "Only an organization admin changes the provider lists");
  }
  const state = await loadProviderList(db, scope.organizationId, input.projectId);
  if (state === null) {
    return refuse("not-found", "No such project");
  }
  return { ok: true, plan: planProviderChange({ list: state.list, choices: state.choices }, [...new Set(input.providerIds)], state.models) };
};

/**
 * An organization admin chooses which provider serves a model on a list (F-135): the default's
 * (`projectId` null) or a project's own. The row's provider must be on that list.
 */
export const chooseModelProvider = async (
  deps: ProviderDeps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId | null; readonly modelId: ModelId },
): Promise<UseCaseResult<{ readonly modelKey: string }, "forbidden" | "not-found" | "not-on-list" | "follows-default">> => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin chooses a model's provider");
  }
  return deps.db.$transaction(async (tx): Promise<UseCaseResult<{ readonly modelKey: string }, "forbidden" | "not-found" | "not-on-list" | "follows-default">> => {
    const state = await loadProviderList(tx, organizationId, input.projectId);
    if (state === null) {
      return refuse("not-found", "No such project");
    }
    if (input.projectId !== null && !state.own) {
      return refuse("follows-default", "The project follows the default list: choose there, or give it its own list");
    }
    const row = state.models.find((model) => model.modelId === input.modelId);
    if (row === undefined) {
      return refuse("not-found", "No such model");
    }
    if (!state.list.includes(row.providerId)) {
      return refuse("not-on-list", "That model's provider isn't on the list");
    }
    await upsertChoice(tx, organizationId, state.listProjectId, input.modelId, state.models, { reason: "admin", memberId: scope.memberId });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: input.projectId,
      actor: memberActor(scope.memberId),
      action: providerAuditActions.choiceChanged,
      entity: "model",
      entityId: input.modelId,
      data: { providerId: row.providerId, list: input.projectId === null ? "default" : "project" },
    });
    return { ok: true, modelKey: modelNameKey(row.name) };
  });
};

/** An admin confirms the upgrade's choice for a model profiles named on different providers. */
export const confirmUpgradeChoice = async (
  deps: ProviderDeps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId | null; readonly modelName: ModelName },
): Promise<UseCaseResult<{ readonly confirmed: true }, "forbidden" | "not-found">> => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin confirms a model's provider");
  }
  return deps.db.$transaction(async (tx): Promise<UseCaseResult<{ readonly confirmed: true }, "forbidden" | "not-found">> => {
    const choice = await tx.modelChoice.findFirst({
      where: { organizationId, projectId: input.projectId, modelKey: modelNameKey(input.modelName) },
      select: { id: true, modelId: true },
    });
    if (choice === null) {
      return refuse("not-found", "No choice for that model");
    }
    await tx.modelChoice.update({ where: { id: choice.id }, data: { needsConfirm: false, chosenByMemberId: scope.memberId, reason: "admin" } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: input.projectId,
      actor: memberActor(scope.memberId),
      action: providerAuditActions.choiceChanged,
      entity: "model",
      entityId: modelIdSchema.parse(choice.modelId),
      data: { confirmed: true },
    });
    return { ok: true, confirmed: true };
  });
};

/** A project's providers by name, as a project admin or member sees them: never a token (F-135). */
export const projectProviderNames = async (
  db: Db,
  scope: MemberScope,
  project: { readonly id: ProjectId; readonly organizationId: OrganizationId; readonly access: "open" | "restricted" },
): Promise<UseCaseResult<{ readonly providers: readonly { readonly providerId: ProviderId; readonly name: string }[] }, "not-found">> => {
  if (!requireProjectAccess(scope, project, "read").ok) {
    return refuse("not-found", "No such project");
  }
  const state = await loadProviderList(db, project.organizationId, project.id);
  if (state === null) {
    return refuse("not-found", "No such project");
  }
  const rows = await db.modelProvider.findMany({ where: { organizationId: project.organizationId, id: { in: [...state.list] } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  return { ok: true, providers: rows.map((row) => ({ providerId: providerIdSchema.parse(row.id), name: row.name })) };
};
