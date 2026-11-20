import type { Tx } from "@ostra/db";
import { organizationIdSchema, ticketWriteIdSchema } from "@ostra/protocol";
import type { TaskId, TicketWriteId } from "@ostra/protocol";

import type { Ports } from "../ports.ts";
import { ticketWriteKey } from "./contracts.ts";
import type { TicketWritePayload, TicketWriteStep } from "./contracts.ts";

// One write to the tracker writer's outbox (F-031, F-046), shared by every start and by "Create
// ticket": the row and its `ticket.sync` job, in the caller's transaction.

/** Where a ticket write goes: the task, its board and ticket, and the connection that throttles it. */
export type TicketWriteTarget = {
  readonly organizationId: string;
  readonly projectId: string;
  readonly taskId: TaskId;
  readonly boardId: string;
  readonly ticketId: string | null;
  readonly connectionId: string;
};

/**
 * Writes one `TicketWrite` and sends its `ticket.sync` job in the caller's transaction (F-031,
 * F-046). The idempotency key is fixed by the task and the step, so a replay finds the row.
 */
export const writeTicketOutboxInTx = async (
  deps: { readonly tx: Tx } & Pick<Ports, "jobs">,
  at: TicketWriteTarget,
  step: TicketWriteStep,
  payload: TicketWritePayload,
): Promise<TicketWriteId> => {
  const row = await deps.tx.ticketWrite.create({
    data: {
      organizationId: at.organizationId,
      projectId: at.projectId,
      taskId: at.taskId,
      boardId: at.boardId,
      ticketId: at.ticketId,
      kind: payload.kind,
      payload,
      idempotencyKey: ticketWriteKey(at.taskId, step),
    },
    select: { id: true },
  });
  const ticketWriteId = ticketWriteIdSchema.parse(row.id);
  // Throttled per connection: a tracker's rate limit is the connection's (ADR 0037).
  await deps.jobs.enqueueInTx(
    deps.tx,
    "ticket.sync",
    { organizationId: organizationIdSchema.parse(at.organizationId), ticketWriteId },
    { group: { id: at.connectionId } },
  );
  return ticketWriteId;
};
