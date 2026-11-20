import type { Tx } from "@ostra/db";
import { organizationIdSchema, ticketIdSchema } from "@ostra/protocol";
import type { TicketId } from "@ostra/protocol";

import type { Ports } from "../ports.ts";

// The ingest's side of intake rules (F-011, ADR 0056; milestone 6's ticket 11): milestone 2's ticket
// ingest calls this in its own transaction, so a ticket's change and its `intake.match` commit
// together. Apart from `intake.ts` so the ticket cache imports nothing of the start.

/** The rules a ticket's change is matched against: a project's enabled, unpaused intake rules. */
export const activeRulesWhere = (organizationId: string, projectIds: readonly string[]) =>
  ({ organizationId, projectId: { in: [...projectIds] }, kind: "intake_rule" as const, schedule: null, enabled: true, deletedAt: null, pausedAt: null });

/**
 * In the ingest's transaction: `intake.match` for each ticket row this read changed, when its
 * project has an active rule. Keyed by the ticket and its tracker time, so a replayed read is one job.
 */
export const enqueueIntakeMatchesInTx = async (deps: Pick<Ports, "jobs">, tx: Tx, ticketIds: readonly TicketId[]): Promise<number> => {
  if (ticketIds.length === 0) {
    return 0;
  }
  const rows = await tx.ticket.findMany({ where: { id: { in: [...ticketIds] }, removedAt: null }, select: { id: true, organizationId: true, projectId: true, trackerUpdatedAt: true } });
  const first = rows[0];
  if (first === undefined) {
    return 0;
  }
  const withRules = await tx.automation.findMany({
    where: activeRulesWhere(first.organizationId, [...new Set(rows.map((row) => row.projectId))]),
    select: { projectId: true },
    distinct: ["projectId"],
  });
  const projects = new Set(withRules.map((row) => row.projectId));
  let sent = 0;
  for (const row of rows) {
    if (!projects.has(row.projectId)) {
      continue;
    }
    await deps.jobs.enqueueInTx(tx, "intake.match", {
      organizationId: organizationIdSchema.parse(row.organizationId),
      ticketId: ticketIdSchema.parse(row.id),
      trackerUpdatedAt: row.trackerUpdatedAt.getTime(),
    });
    sent += 1;
  }
  return sent;
};

