import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { ingestEvents } from "@ostra/domain";
import type { ChangeNotices, Clock, JobQueue, SessionIngestOutcome } from "@ostra/domain";
import type { DownFrame, EventsFrame } from "@ostra/protocol";

import type { RunnerRef } from "../gateway/context.ts";
import type { LiveTextWriter } from "./live-text.ts";

// Core's side of event ingest (ticket 25): an `events` frame is saved by `ingestEvents` in one
// transaction, and only after it commits does the gateway send the acks this returns (ADR 0034).

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
  return async (runner, frame) => {
    const result = await options.db.$transaction(
      (tx) =>
        ingestEvents(
          { tx, jobs: options.jobs, notices: options.notices, clock: options.clock, logger },
          { runnerId: runner.runnerId, events: frame.events },
        ),
      { timeout: 30_000, maxWait: 10_000 },
    );
    // Committed: a completed message's partial text is never written again.
    const saved = new Map(result.outcomes.flatMap((outcome) => (outcome.kind === "saved" ? [[outcome.sessionId, outcome.taskId] as const] : [])));
    for (const item of frame.events) {
      const taskId = saved.get(item.sessionId);
      if (taskId !== undefined && (item.event.kind === "agent.message" || item.event.kind === "agent.thought")) {
        options.liveText.complete(taskId, item.event.segmentId);
      }
    }
    for (const outcome of result.outcomes) {
      if (outcome.kind !== "saved") {
        logger.info("ingest.refused", { runnerId: runner.runnerId, sessionId: outcome.sessionId, outcome: outcome.kind });
      }
    }
    return result.outcomes.map(outcomeFrame);
  };
};
