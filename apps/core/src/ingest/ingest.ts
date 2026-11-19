import type { Logger } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { ingestEvents } from "@ostra/domain";
import type { ChangeNotices, Clock, JobQueue, SessionIngestOutcome, SessionTimers } from "@ostra/domain";
import { lockTask } from "@ostra/jobs";
import {
  epochMsSchema,
  isTaskEventKind,
  leaseEpochSchema,
  organizationIdSchema,
  projectIdSchema,
  runnerEventSchema,
  runnerEventSchemaV0,
  runnerEventSchemaV1,
  runnerLimits,
  serverOnlyKinds,
  sessionIdSchema,
  sessionSeqSchema,
  taskIdSchema,
  taskSeqSchema,
} from "@ostra/protocol";
import type { DownFrame, EventsFrame, RunnerEvent, SessionId, SessionSeq } from "@ostra/protocol";
import { z } from "zod";

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
//
// Milestone 2 (ticket 17, F-043): an event that fails validation is the same. Its frame used to be a
// protocol violation, so the runner reconnected and resent it forever. Now the frame is salvaged:
// each event whose envelope reads but whose body doesn't is stored as the same placeholder, the rest
// as they are, and the ack moves past it. Either way the refusal is visible, once: an
// `unstorable_event` needs-you item for the driver, raised in the transaction that stored the
// placeholder, one open item per task.

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

/** A refused event, by its session and its number there: `<sessionId>:<sessionSeq>`. */
export const refusedKey = (sessionId: string, sessionSeq: number): string => `${sessionId}:${String(sessionSeq)}`;

/** The events of a frame core refused, by `refusedKey`. */
export type RefusedEvents = ReadonlySet<string>;

/** The placeholder for an event that failed validation. `raw` names its kind when it's one ostra knows, never its content. */
const validationPlaceholder = (kind: string): RunnerEvent["event"] => ({
  kind: "agent.unknown",
  acpKind: "event-refused",
  raw: `refused: it failed validation (${isTaskEventKind(kind) ? kind : "an unknown kind"})`,
});

const looseFrameSchema = z.looseObject({
  type: z.literal("events"),
  events: z.array(z.unknown()).min(1).max(runnerLimits.eventsPerFrameMax),
});

const envelopeSchema = z.looseObject({
  sessionId: sessionIdSchema,
  sessionSeq: sessionSeqSchema,
  leaseEpoch: leaseEpochSchema,
  at: epochMsSchema,
  event: z.looseObject({ kind: z.string().max(200) }),
});

const parseRunnerEventAt = (raw: unknown, minor: number): RunnerEvent | null => {
  const parsed = (minor >= 2 ? runnerEventSchema : minor >= 1 ? runnerEventSchemaV1 : runnerEventSchemaV0).safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/**
 * An `events` frame that failed to parse, salvaged: every event whose envelope (session, number,
 * epoch, time) reads is kept, and one whose body doesn't is replaced by a placeholder and named in
 * `refused`. `null` when the frame can't be salvaged (not an events frame, an envelope that doesn't
 * read, a kind only the server writes, nothing to refuse), which stays a protocol violation.
 */
export const salvageEventsFrame = (text: string, minor: number): { readonly frame: EventsFrame; readonly refused: RefusedEvents } | null => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const loose = looseFrameSchema.safeParse(json);
  if (!loose.success) {
    return null;
  }
  const events: RunnerEvent[] = [];
  const refused = new Set<string>();
  for (const raw of loose.data.events) {
    const envelope = envelopeSchema.safeParse(raw);
    if (!envelope.success) {
      return null;
    }
    const kind = envelope.data.event.kind;
    if (isTaskEventKind(kind) && serverOnlyKinds.has(kind)) {
      return null;
    }
    const parsed = parseRunnerEventAt(raw, minor);
    if (parsed !== null) {
      events.push(parsed);
      continue;
    }
    const { sessionId, sessionSeq, leaseEpoch, at } = envelope.data;
    events.push({ sessionId, sessionSeq, leaseEpoch, at, event: validationPlaceholder(kind) });
    refused.add(refusedKey(sessionId, sessionSeq));
  }
  return refused.size === 0 ? null : { frame: { type: "events", events }, refused };
};

/**
 * Raises the task's `unstorable_event` needs-you item for each refused event the batch stored, one
 * open item per task. Its summary names the event's number, never its content.
 */
const raiseUnstorableInTx = async (
  tx: Tx,
  notices: ChangeNotices,
  events: readonly RunnerEvent[],
  outcomes: readonly SessionIngestOutcome[],
  refused: RefusedEvents,
): Promise<void> => {
  for (const item of events) {
    if (!refused.has(refusedKey(item.sessionId, item.sessionSeq))) {
      continue;
    }
    const stored = outcomes.some((outcome) => outcome.kind === "saved" && outcome.sessionId === item.sessionId && outcome.upTo >= item.sessionSeq);
    if (!stored) {
      continue;
    }
    const session = await tx.session.findUnique({ where: { id: item.sessionId }, select: { taskId: true, organizationId: true, projectId: true } });
    if (session === null) {
      continue;
    }
    const open = await tx.needsYouItem.findFirst({ where: { taskId: session.taskId, reason: "unstorable_event", state: "open" }, select: { id: true } });
    if (open === null) {
      await tx.needsYouItem.create({
        data: {
          organizationId: session.organizationId,
          projectId: session.projectId,
          taskId: session.taskId,
          reason: "unstorable_event",
          audience: "driver",
          summary: `The server couldn't store event ${String(item.sessionSeq)} of the session, so it refused it once and kept the rest.`,
        },
      });
    }
    await notices.emitInTx(tx, {
      organizationId: organizationIdSchema.parse(session.organizationId),
      projectId: projectIdSchema.parse(session.projectId),
      entity: "task",
      entityId: taskIdSchema.parse(session.taskId),
    });
  }
};

/** An event not even a placeholder could take: skipped, with the cursor moved past it. */
type Skipped = { readonly sessionId: SessionId; readonly sessionSeq: SessionSeq };

const transactionOptions = { timeout: 30_000, maxWait: 10_000 } as const;

/** Saves a frame; `refused` names the events `salvageEventsFrame` replaced by placeholders. */
export type Ingest = (runner: RunnerRef, frame: EventsFrame, refused?: RefusedEvents) => Promise<readonly DownFrame[]>;

export const createIngest = (options: {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly liveText: LiveTextWriter;
  readonly logger: Logger;
  /** Milestone 2: the session's and the box's timers (tickets 17, 19, 20). */
  readonly timers?: SessionTimers;
}): Ingest => {
  const logger = options.logger.child({ component: "ingest" });

  const attempt = (runner: RunnerRef, events: readonly RunnerEvent[], refused: RefusedEvents) =>
    options.db.$transaction(async (tx) => {
      const result = await ingestEvents(
        {
          tx,
          jobs: options.jobs,
          notices: options.notices,
          clock: options.clock,
          logger,
          ...(options.timers === undefined ? {} : { timers: options.timers }),
        },
        { runnerId: runner.runnerId, events: [...events] },
      );
      if (refused.size > 0) {
        await raiseUnstorableInTx(tx, options.notices, events, result.outcomes, refused);
      }
      return result;
    }, transactionOptions);

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
      const moved: SessionIngestOutcome = {
        kind: "saved",
        sessionId: item.sessionId,
        taskId,
        upTo: item.sessionSeq,
        headSeq: taskSeqSchema.parse(Math.max(1, task.eventSeq)),
        duplicates: 0,
      };
      await raiseUnstorableInTx(tx, options.notices, [item], [moved], new Set([refusedKey(item.sessionId, item.sessionSeq)]));
      return moved;
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
    refused: RefusedEvents,
  ): Promise<void> => {
    try {
      outcomes.push(...(await attempt(runner, events, refused)).outcomes);
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
        await save(runner, ordered.slice(0, middle), outcomes, skipped, refused);
        await save(runner, ordered.slice(middle), outcomes, skipped, refused);
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
        outcomes.push(...(await attempt(runner, [placeholderFor(item, codes)], new Set([refusedKey(item.sessionId, item.sessionSeq)]))).outcomes);
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

  return async (runner, frame, refused = new Set<string>()) => {
    const outcomes: SessionIngestOutcome[] = [];
    const skipped: Skipped[] = [];
    for (const item of frame.events) {
      if (refused.has(refusedKey(item.sessionId, item.sessionSeq))) {
        // IDs only, never the event.
        logger.warn("ingest.event-invalid", { runnerId: runner.runnerId, sessionId: item.sessionId, sessionSeq: item.sessionSeq });
      }
    }
    await save(runner, frame.events, outcomes, skipped, refused);
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
