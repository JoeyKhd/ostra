import { readTicketForTask, ticketFileLimits } from "@ostra/domain";
import type { Ports } from "@ostra/domain";
import { queueSettings } from "@ostra/jobs";
import type { JobHandler } from "@ostra/jobs";

import { coreMessageFilesDeps } from "../agents/prompt-images.ts";
import { ticketReadPorts } from "./ticket-reads.ts";
import type { TicketReadsDeps } from "./ticket-reads.ts";

// `ticket.read-changes` (F-149, ADR 0070, Q336; milestone 9's ticket 12): a ticket task's ticket
// read again, for a reopen (`reopenTask` sends it in place of the dispatch), a member's "Send
// ticket updates" (`requestTicketUpdates`) and a Retry of its failed files (`retryTicketFiles`).
// The domain's `readTicketForTask` does the work on core's ports (the connection's adapter, the
// blob store and the text reader): what changed goes as a `ticket-update` message, and every read
// is a round the thread shows ("nothing new" included). A tracker that doesn't answer retries the
// job; on its last try the round says the ticket couldn't be read, and a reopen dispatches without
// the changes. The ticket's text and its files never reach a log line.

export type ReadChangesDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "audit" | "clock"> & TicketReadsDeps;

export const readChangesHandler =
  (deps: ReadChangesDeps): JobHandler<"ticket.read-changes"> =>
  async (context) => {
    const { payload } = context;
    const lastTry = context.retryCount >= queueSettings["ticket.read-changes"].retryLimit;
    const result = await readTicketForTask(
      {
        db: deps.db,
        jobs: deps.jobs,
        outbox: deps.outbox,
        notices: deps.notices,
        audit: deps.audit,
        clock: deps.clock,
        reads: ticketReadPorts({ ...deps, logger: context.logger }),
        limits: ticketFileLimits(deps.files),
        files: coreMessageFilesDeps(deps.files),
      },
      { organizationId: payload.organizationId, taskId: payload.taskId, reason: payload.reason, memberId: payload.memberId, lastTry },
    );
    // IDs, the reason and the outcome: never the ticket's text, never a file's name.
    if (result.ok) {
      context.logger.info("ticket.read-changes", {
        taskId: payload.taskId,
        reason: payload.reason,
        outcome: result.outcome,
        round: result.round,
        dispatched: result.dispatched,
        steered: result.steered,
      });
    } else {
      context.logger.info("ticket.read-changes-skipped", { taskId: payload.taskId, reason: payload.reason, error: result.error });
    }
  };
