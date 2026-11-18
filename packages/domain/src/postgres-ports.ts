import { notifyChannels, NOTIFY_PAYLOAD_MAX_BYTES } from "@ostra/db";

import type { AuditLog, ChangeNotices, Clock } from "./ports.ts";

// The Postgres side of two ports (ticket 30): who did what, and the change notices the panel's live
// views refetch on. Both write in the caller's transaction, so a notice and an audit entry exist
// only if the change they describe committed (ADR 0011). The panel and core share them.

export const systemClock: Clock = { now: () => Date.now() };

/** The audit log (F-073): IDs and settings only, never content or secrets. */
export const postgresAuditLog: AuditLog = {
  recordInTx: async (tx, entry) => {
    await tx.auditEntry.create({
      data: {
        organizationId: entry.organizationId,
        projectId: entry.projectId,
        actorKind: entry.actor.kind,
        actorId: entry.actor.id,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        ...(entry.data === undefined ? {} : { data: entry.data }),
      },
    });
  },
};

/**
 * Change notices (ADR 0035): a row, and one `NOTIFY` that commits with it. The payload is the
 * notice's number only: a wake-up for every web process's tailer, never content.
 */
export const postgresChangeNotices: ChangeNotices = {
  emitInTx: async (tx, notice) => {
    const row = await tx.changeNotice.create({
      data: {
        organizationId: notice.organizationId,
        projectId: notice.projectId,
        entity: notice.entity,
        entityId: notice.entityId,
      },
      select: { seq: true },
    });
    const payload = JSON.stringify({ seq: Number(row.seq) });
    if (payload.length > NOTIFY_PAYLOAD_MAX_BYTES) {
      throw new Error("a change notice's payload is over the NOTIFY limit");
    }
    await tx.$executeRaw`SELECT pg_notify(${notifyChannels.changes}, ${payload})`;
  },
};
