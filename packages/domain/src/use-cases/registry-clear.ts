import { secretRefSchema } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { registryIdSchema } from "@ostra/protocol";

import { requireOrganizationAdmin } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports, ServerAdapters } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";

// Clearing the organization's registry (F-120; milestone 5's ticket 28). In one transaction: the
// snapshots it held stop naming it, the row goes, `registry.cleared` is in the audit log, and the
// panel hears of it. Its two credentials are deleted from the secret store after the commit, once
// no row names them. The images stay in the registry, which the organization owns: ostra deletes
// nothing there. Without a registry a `docker` host builds its own snapshots again, and a
// `kubernetes` pool's tasks wait with `needs-registry` (ADR 0060).

export type ClearRegistryDeps = { readonly db: Db } & Pick<Ports, "audit" | "notices" | "clock"> & { readonly adapters: Pick<ServerAdapters, "secretStore"> };

export type ClearRegistry = (
  deps: ClearRegistryDeps,
  scope: MemberScope,
) => Promise<UseCaseResult<{ readonly cleared: boolean }, "forbidden">>;

/** An admin clears the registry. With none set, it answers `cleared: false` and changes nothing. */
export const clearRegistry: ClearRegistry = async (deps, scope) => {
  if (!requireOrganizationAdmin(scope, scope.organizationId).ok) {
    return { ok: false, error: "forbidden", message: "Only an admin clears the registry" };
  }
  const organizationId = scope.organizationId;
  const removed = await deps.db.$transaction(async (tx) => {
    const row = await tx.registry.findUnique({ where: { organizationId }, select: { id: true, url: true, pushSecretId: true, pullSecretId: true } });
    if (row === null) {
      return null;
    }
    const registryId = registryIdSchema.parse(row.id);
    const released = await tx.snapshot.updateMany({ where: { organizationId, registryId }, data: { registryId: null } });
    await tx.registry.delete({ where: { id: registryId } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "registry.cleared",
      entity: "registry",
      entityId: registryId,
      data: { url: row.url, snapshots: released.count },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
    return row;
  });
  if (removed === null) {
    return { ok: true, cleared: false };
  }
  for (const stored of [removed.pushSecretId, removed.pullSecretId]) {
    const ref = secretRefSchema.safeParse(stored);
    if (ref.success) {
      await deps.adapters.secretStore.delete(organizationId, ref.data);
    }
  }
  return { ok: true, cleared: true };
};
