import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { ingestEvents } from "@ostra/domain";
import type { ChangeNotices, Clock, JobQueue, SessionIngestOutcome } from "@ostra/domain";
import { lockTask } from "@ostra/jobs";
import { sessionSeqSchema, taskIdSchema, taskSeqSchema } from "@ostra/protocol";
import type { DownFrame, EventsFrame, RunnerEvent, SessionId, SessionSeq } from "@ostra/protocol";

import type { RunnerRef } from "../gateway/context.ts";
import { databaseErrorCodes, isDataRefusal } from "../gateway/database-error.ts";
import type { DatabaseErrorCodes } from "../gateway/database-error.ts";
import type { LiveTextWriter } from "./live-text.ts";

// Core's side of event ingest (ticket 25): an `events` frame is saved by `ingestEvents` in one
// transaction, and only after it commits does the gateway send the acks this returns (ADR 0034).
//
// A batch the database refuses (SQLSTATE class 22 or 23: text jsonb can't hold, a value out of
// range, a constraint) is refused again on every resend, so it must not end in a closed socket and
// a reconnect: the refused event is found, stored as a placeholder `agent.unknown`, and acked.

/** The frame a session's outcome becomes. The messages never hold content. */
export const outcomeFrame = (outcome: SessionIngestOutcome): DownFrame => {
  switch (outcome.kind) {
    case "saved":
      return { type: "ack", sessionId: outcome.sessionId, upTo: outcome.upTo };
    case "gap":
      return { type: "ack", sessionId: outcome.sessionId, upTo: outcome.upTo, resendFrom: outcome.resendFrom };
    case "stale-lease":
      return {
        type: "error",
        code: "stale-lease",
        message: "this session's lease has moved on; its writes are refused",
        sessionId: outcome.sessionId,
        currentEpoch: outcome.currentEpoch,
      };
    case "unknown-session":
      return { type: "error", code: "unknown-session", message: "no such session for this runner", sessionId: outcome.sessionId };
    default:
      return outcome satisfies never;
  }
};

/**
 * What a refused event is stored as: the sequence keeps its place, so the session's cursor moves on
 * and the runner drops the event. `raw` is the code that refused it, never the event's content.
 */
const placeholderFor = (item: RunnerEvent, codes: DatabaseErrorCodes): RunnerEvent => ({
  ...item,
  event: { kind: "agent.unknown", acpKind: "event-refused", raw: `refused by the database: ${codes.sqlState ?? codes.code ?? "unknown"}` },
});

/** An event not even a placeholder could take: skipped, with the cursor moved past it. */
type Skipped = { readonly sessionId: SessionId; readonly sessionSeq: SessionSeq };

const transactionOptions = { timeout: 30_000, maxWait: 10_000 } as const;

export type Ingest = (runner: RunnerRef, frame: EventsFrame) => Promise<readonly DownFrame[]>;

export const createIngest = (options: {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly liveText: LiveTextWriter;
  readonly logger: Logger;
}): Ingest => {
  const logger = options.logger.child({ component: "ingest" });

  const attempt = (runner: RunnerRef, events: readonly RunnerEvent[]) =>
    options.db.$transaction(
      (tx) =>
        ingestEvents(
          { tx, jobs: options.jobs, notices: options.notices, clock: options.clock, logger },
          { runnerId: runner.runnerId, events: [...events] },
        ),
      transactionOptions,
    );

  // Last resort, when not even the placeholder can be stored: the cursor moves past the event with
  // no row, so the runner is never asked to send it again. It's done under the same fence as a
  // write: the runner holds a lease of the task at the event's epoch, and that epoch is current.
  const skip = (runner: RunnerRef, item: RunnerEvent): Promise<SessionIngestOutcome | null> =>
    options.db.$transaction(async (tx): Promise<SessionIngestOutcome | null> => {
      const session = await tx.session.findUnique({ where: { id: item.sessionId } });
      if (session?.ingestedSeq !== item.sessionSeq - 1) {
        return null;
      }
      const taskId = taskIdSchema.parse(session.taskId);
      const task = await lockTask(tx, runner.organizationId, taskId);
      if (task?.leaseEpoch !== item.leaseEpoch) {
        return null;
      }
      const lease = await tx.lease.findFirst({
        where: { taskId, organizationId: task.organizationId, runnerId: runner.runnerId, epoch: item.leaseEpoch },
        select: { id: true },
      });
      if (lease === null) {
        return null;
      }
      await tx.session.update({ where: { id: item.sessionId }, data: { ingestedSeq: item.sessionSeq } });
      return {
        kind: "saved",
        sessionId: item.sessionId,
        taskId,
        upTo: item.sessionSeq,
        headSeq: taskSeqSchema.parse(Math.max(1, task.eventSeq)),
        duplicates: 0,
      };
    }, transactionOptions);

  /**
   * Saves `events`. When the database refuses the data it finds the refused event by halving the
   * batch: what the database accepts is saved, and each refused event is stored once as a
   * placeholder in its place. Anything else (a deadlock, a lost connection) is thrown, and the
   * runner's reconnect and resend are the right answer to that.
   */
  const save = async (
    runner: RunnerRef,
    events: readonly RunnerEvent[],
    outcomes: SessionIngestOutcome[],
    skipped: Skipped[],
  ): Promise<void> => {
    try {
      outcomes.push(...(await attempt(runner, events)).outcomes);
      return;
    } catch (error) {
      const codes = databaseErrorCodes(error);
      if (!isDataRefusal(codes)) {
        throw error;
      }
      if (events.length > 1) {
        // In session order, so each half still starts where the cursor is.
        const ordered = [...events].sort((a, b) => a.sessionSeq - b.sessionSeq);
        const middle = Math.ceil(ordered.length / 2);
        await save(runner, ordered.slice(0, middle), outcomes, skipped);
        await save(runner, ordered.slice(middle), outcomes, skipped);
        return;
      }
      const [item] = events;
      if (item === undefined) {
        throw error;
      }
      // IDs and codes only, never the event.
      logger.warn("ingest.event-refused", {
        runnerId: runner.runnerId,
        sessionId: item.sessionId,
        sessionSeq: item.sessionSeq,
        kind: item.event.kind,
        ...(codes.code === undefined ? {} : { code: codes.code }),
        ...(codes.sqlState === undefined ? {} : { sqlState: codes.sqlState }),
      });
      try {
        outcomes.push(...(await attempt(runner, [placeholderFor(item, codes)])).outcomes);
        return;
      } catch (placeholderError) {
        if (!isDataRefusal(databaseErrorCodes(placeholderError))) {
          throw placeholderError;
        }
      }
      const moved = await skip(runner, item);
      if (moved === null) {
        // Not this runner's to write; throw the first error as before.
        throw error;
      }
      logger.warn("ingest.event-skipped", { runnerId: runner.runnerId, sessionId: item.sessionId, sessionSeq: item.sessionSeq });
      outcomes.push(moved);
      skipped.push({ sessionId: item.sessionId, sessionSeq: sessionSeqSchema.parse(item.sessionSeq) });
    }
  };

  return async (runner, frame) => {
    const outcomes: SessionIngestOutcome[] = [];
    const skipped: Skipped[] = [];
    await save(runner, frame.events, outcomes, skipped);
    // Committed: a completed message's partial text is never written again.
    const saved = new Map(outcomes.flatMap((outcome) => (outcome.kind === "saved" ? [[outcome.sessionId, outcome.taskId] as const] : [])));
    for (const item of frame.events) {
      const taskId = saved.get(item.sessionId);
      if (taskId !== undefined && (item.event.kind === "agent.message" || item.event.kind === "agent.thought")) {
        options.liveText.complete(taskId, item.event.segmentId);
      }
    }
    for (const outcome of outcomes) {
      if (outcome.kind !== "saved") {
        logger.info("ingest.refused", { runnerId: runner.runnerId, sessionId: outcome.sessionId, outcome: outcome.kind });
      }
    }
    // One reply per session: the last word on it.
    const lastBySession = new Map<SessionId, SessionIngestOutcome>();
    for (const outcome of outcomes) {
      lastBySession.set(outcome.sessionId, outcome);
    }
    return [
      ...[...lastBySession.values()].map(outcomeFrame),
      ...skipped.map(
        (item): DownFrame => ({
          type: "error",
          code: "event-rejected",
          message: "the database refused this event and nothing could be stored in its place; it is skipped",
          sessionId: item.sessionId,
          sessionSeq: item.sessionSeq,
        }),
      ),
    ];
  };
};
