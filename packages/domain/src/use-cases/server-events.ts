import type { Tx } from "@ostra/db";
import { notifyChannels } from "@ostra/db";
import type { OrganizationId, ProjectId, SessionId, TaskEvent, TaskEventKind, TaskId, TaskSeq } from "@ostra/protocol";
import { serverOnlyKinds, taskEventSchema, taskSeqSchema } from "@ostra/protocol";

import { writeEventSearchEntries } from "../search/entries.ts";
import { storableEvent } from "./storable-event.ts";

// The server's own events (ADR 0035, ADR 0036): a member's message, an answer, a take-over, a PR.
// They go through the same log as the agent's, numbered per task under a lock on the task row, but
// no peer numbered them, so their session number is `null`. The panel's transactions write them
// (`createPromptTask`, `task.send`, `approval.answer`), and core's ingest numbers the runner's
// events the same way, so one reader sees one order.

export type AppendServerEventInput = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  /** Only a kind the server writes: a runner can never forge these (`serverOnlyKinds`). */
  readonly event: TaskEvent;
  /** Server time, in ms since the epoch. */
  readonly at: number;
};

/**
 * Appends one server-written event in the caller's transaction and wakes the live tailers when it
 * commits. Taking the next number is an update of the task row, which locks it: writers to one task
 * serialize, numbers commit in order, and a reader never sees a gap.
 */
export const appendServerEvent = async (tx: Tx, input: AppendServerEventInput): Promise<TaskSeq> => {
  if (!serverOnlyKinds.has(input.event.kind)) {
    throw new Error(`appendServerEvent: ${input.event.kind} is written by a runner, not by the server`);
  }
  return append(tx, input);
};

/**
 * The runner's kinds core also records itself, when it's core that saw it happen (milestone 2): a
 * runaway limit core times (the maximum duration, the stall: ADR 0037), and the crash of a box the
 * dispatch found gone (F-047); milestone 5, a box's wait a runner reports outside the session
 * (`box.waiting`, `box.scheduled`, ticket 20). Stored like a server event, with no session number.
 */
export const coreRecordedKinds: ReadonlySet<TaskEventKind> = new Set<TaskEventKind>(["session.limit_reached", "session.crashed", "box.waiting", "box.scheduled"]);

/** Appends one event of a `coreRecordedKinds` kind, as `appendServerEvent` does. */
export const appendCoreEvent = async (tx: Tx, input: AppendServerEventInput): Promise<TaskSeq> => {
  if (!coreRecordedKinds.has(input.event.kind)) {
    throw new Error(`appendCoreEvent: core doesn't record ${input.event.kind} itself`);
  }
  return append(tx, input);
};

/**
 * Appends one server-written event whose content needs its own number (milestone 9: a message's
 * files go to `attachments/<n>/`, `<n>` its number): takes the number first, under the task row's
 * lock, then builds the event in the same transaction. A builder that throws rolls the number back
 * with the transaction.
 */
export const appendServerEventNumbered = async (
  tx: Tx,
  input: Omit<AppendServerEventInput, "event">,
  build: (seq: TaskSeq) => Promise<TaskEvent>,
): Promise<{ readonly seq: TaskSeq; readonly event: TaskEvent }> => {
  const seq = await takeSeq(tx, input.taskId);
  const event = taskEventSchema.parse(await build(seq));
  if (!serverOnlyKinds.has(event.kind)) {
    throw new Error(`appendServerEventNumbered: ${event.kind} is written by a runner, not by the server`);
  }
  await insert(tx, { ...input, event }, seq);
  return { seq, event };
};

/** The task's next event number: an update of the task row, which locks it. */
const takeSeq = async (tx: Tx, taskId: TaskId): Promise<TaskSeq> => {
  const counter = await tx.task.update({
    where: { id: taskId },
    data: { eventSeq: { increment: 1 } },
    select: { eventSeq: true },
  });
  return taskSeqSchema.parse(counter.eventSeq);
};

const append = async (tx: Tx, input: AppendServerEventInput): Promise<TaskSeq> => {
  const event = taskEventSchema.parse(input.event);
  const seq = await takeSeq(tx, input.taskId);
  await insert(tx, { ...input, event }, seq);
  return seq;
};

const insert = async (tx: Tx, input: AppendServerEventInput, seq: TaskSeq): Promise<void> => {
  const { event } = input;
  await tx.event.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      taskId: input.taskId,
      seq,
      sessionId: input.sessionId,
      sessionSeq: null,
      leaseEpoch: null,
      kind: event.kind,
      payload: storableEvent(event),
      occurredAt: new Date(input.at),
    },
  });
  // Search (ticket 11): a member's message is found by its words, in the event's own transaction.
  await writeEventSearchEntries(tx, { organizationId: input.organizationId, projectId: input.projectId, taskId: input.taskId }, [{ seq, event }]);
  const payload = JSON.stringify({ taskId: input.taskId, seq });
  await tx.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${payload})`;
};
