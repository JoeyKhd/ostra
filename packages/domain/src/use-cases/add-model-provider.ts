import type { Tx } from "@ostra/db";
import { apiFormatToDb, authSchemeToDb } from "@ostra/db";
import { addModelProviderInputSchema, providerIdSchema } from "@ostra/protocol";
import type { AddModelProviderInput, ProviderId } from "@ostra/protocol";

import { requireOrganizationAdmin } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";

// F-088, ADR 0033: an admin adds a model provider. The token goes to the secret store, the row keeps
// its reference, and a `provider.refresh-models` job lists the models. Personal runners may use it
// only when the admin allows it (off by default). Written by ticket 31.

export { addModelProviderInputSchema };
export type { AddModelProviderInput };

export type AddModelProviderResult = UseCaseResult<
  { readonly providerId: ProviderId },
  "forbidden" | "name-taken" | "connection-failed"
>;

export type AddModelProviderDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock" | "adapters"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
};

export type AddModelProvider = (deps: AddModelProviderDeps, input: AddModelProviderInput) => Promise<AddModelProviderResult>;

const refuse = (
  error: Exclude<AddModelProviderResult, { readonly ok: true }>["error"],
  message: string,
): AddModelProviderResult => ({ ok: false, error, message });

/** The settings a provider's audit entry records: never the token, never its reference. */
const auditData = (input: AddModelProviderInput) => ({
  apiFormat: input.apiFormat,
  authScheme: input.authScheme,
  allowOnPersonalRunners: input.allowOnPersonalRunners,
  sessionsAtOnce: input.sessionsAtOnce,
});

export const addModelProvider: AddModelProvider = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin adds a model provider");
  }
  const taken = await tx.modelProvider.findFirst({ where: { organizationId, name: input.name }, select: { id: true } });
  if (taken !== null) {
    return refuse("name-taken", "A model provider with that name exists");
  }

  // The endpoint is tried with the settings the form holds, which may be the admin's correction of
  // what "Test connection" detected. Nothing is stored for an endpoint that refuses them.
  const tested = await deps.adapters.modelProvider.testConnection({
    baseUrl: input.baseUrl,
    token: input.token,
    authScheme: input.authScheme,
    apiFormat: input.apiFormat,
  });
  if (!tested.ok) {
    return refuse("connection-failed", `The endpoint did not accept the settings: ${tested.error.message}`);
  }

  const stored = await deps.adapters.secretStore.put({ organizationId, purpose: "model-provider.token" }, input.token);
  if (!stored.ok) {
    // The secret store is infrastructure, not a form's mistake: the caller sees a server error.
    throw new Error(`the secret store did not keep a provider's token: ${stored.error.code}`);
  }

  const created = await tx.modelProvider.create({
    data: {
      organizationId,
      name: input.name,
      baseUrl: input.baseUrl,
      apiFormat: apiFormatToDb[input.apiFormat],
      authScheme: authSchemeToDb[input.authScheme],
      tokenSecretRef: stored.value,
      sessionsAtOnce: input.sessionsAtOnce,
      allowOnPersonalRunners: input.allowOnPersonalRunners,
    },
    select: { id: true },
  });
  const providerId = providerIdSchema.parse(created.id);
  // Milestone 4 (F-135, ADR 0065, Q270): the organization's first provider joins its default list,
  // so a fresh install's setup works unchanged. Later providers join no list until an admin ticks one.
  const others = await tx.modelProvider.count({ where: { organizationId, id: { not: providerId } } });
  if (others === 0) {
    await tx.providerListEntry.create({ data: { organizationId, projectId: null, providerId, addedByMemberId: scope.memberId } });
  }

  // The models the endpoint listed are rows at once (custom, until the refresh matches the
  // catalog), so the admin can pick one without waiting for the job.
  await tx.model.createMany({
    data: tested.value.models.map((model) => ({
      organizationId,
      providerId,
      endpointModelId: model.endpointModelId,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
    })),
    skipDuplicates: true,
  });

  await deps.jobs.enqueueInTx(tx, "provider.refresh-models", { organizationId, providerId });
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: null,
    actor: { kind: "member", id: scope.memberId },
    action: "provider.added",
    entity: "model-provider",
    entityId: providerId,
    data: auditData(input),
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "model-provider", entityId: providerId });
  return { ok: true, providerId };
};
