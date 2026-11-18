import type { Tx } from "@ostra/db";
import { notifyChannels } from "@ostra/db";
import type { OrganizationId, ProjectId, SessionId, TaskEvent, TaskId, TaskSeq } from "@ostra/protocol";
import { serverOnlyKinds, taskEventSchema, taskSeqSchema } from "@ostra/protocol";

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
  const event = taskEventSchema.parse(input.event);
  const counter = await tx.task.update({
    where: { id: input.taskId },
    data: { eventSeq: { increment: 1 } },
    select: { eventSeq: true },
  });
  const seq = taskSeqSchema.parse(counter.eventSeq);
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
  const payload = JSON.stringify({ taskId: input.taskId, seq });
  await tx.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${payload})`;
  return seq;
};
