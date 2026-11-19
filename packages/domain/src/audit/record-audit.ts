import type { Tx } from "@ostra/db";

import type { AuditInput } from "../ports.ts";

// The one port every audit write goes through (F-073, ADR 0054; milestone 4, ticket 10). It writes
// in the caller's transaction, so an entry exists only if the change it describes committed, and it
// keeps the actor's name as it is now, so a removed member's entries still read. Append-only: no
// code updates or deletes an `AuditEntry` (`audit/append-only.test.ts` checks the repo for it).

/** What the system's own entries are signed with. */
export const SYSTEM_ACTOR_NAME = "ostra";

/** The actor's current name: a member's account name, a runner's name, or the system's. */
export const actorNameOf = async (tx: Tx, actor: AuditInput["actor"]): Promise<string | null> => {
  switch (actor.kind) {
    case "system":
      return SYSTEM_ACTOR_NAME;
    case "member": {
      if (actor.id === null) {
        return null;
      }
      const member = await tx.member.findUnique({ where: { id: actor.id }, select: { user: { select: { name: true } } } });
      return member?.user.name ?? null;
    }
    case "runner": {
      if (actor.id === null) {
        return null;
      }
      const runner = await tx.runner.findUnique({ where: { id: actor.id }, select: { name: true } });
      return runner?.name ?? null;
    }
    default:
      return actor.kind satisfies never;
  }
};

/**
 * Records one action in the caller's transaction. `actorName` is filled from the actor's current
 * name unless the caller already holds it. IDs and settings only, never content or secrets.
 */
export const recordAudit = async (tx: Tx, entry: AuditInput & { readonly actorName?: string | null }): Promise<void> => {
  const actorName = entry.actorName === undefined ? await actorNameOf(tx, entry.actor) : entry.actorName;
  await tx.auditEntry.create({
    data: {
      organizationId: entry.organizationId,
      projectId: entry.projectId,
      actorKind: entry.actor.kind,
      actorId: entry.actor.id,
      actorName,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      ...(entry.data === undefined ? {} : { data: entry.data }),
    },
  });
};
