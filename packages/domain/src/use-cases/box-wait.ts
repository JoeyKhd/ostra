import type { DbEnum, Tx } from "@ostra/db";
import { projectIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, RunnerId, TaskEventOf } from "@ostra/protocol";

import { transitionBox } from "../lifecycles/box.ts";
import type { Clock } from "../ports.ts";
import { appendCoreEvent } from "./server-events.ts";

// A box's wait before it runs (milestone 5, ticket 20, F-093). A `kubernetes` runner accepts its
// dispatch at once, then its box may wait for a node the cluster is adding or for its image's pull:
// it says so in a `runner-event` frame (`box.waiting`), and once more when the pod is scheduled
// (`box.scheduled`). Core keeps the wait on the box's row (it stays `creating`, ticket 05's
// lifecycle) and records each on the task's timeline, so the task page says "waiting for a node".
//
// Only the runner the box was given to moves it. A frame comes again on each new connection (the
// runner keeps its own events an hour), so a repeat changes nothing.

export type BoxWaitEvent = TaskEventOf<"box.waiting"> | TaskEventOf<"box.scheduled">;

type WaitReason = TaskEventOf<"box.waiting">["reason"];

/** The protocol's reason as the database's enum spells it, and back. */
const toColumn = (reason: WaitReason): DbEnum.BoxWaitingReason => (reason === "image-pull" ? "image_pull" : "node");
const fromColumn = (reason: DbEnum.BoxWaitingReason): WaitReason => (reason === "image_pull" ? "image-pull" : "node");

export type RecordBoxWaitInput = {
  readonly organizationId: OrganizationId;
  readonly runnerId: RunnerId;
  readonly event: BoxWaitEvent;
};

export type RecordBoxWaitResult =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly reason: "not-this-runners-box" | "not-creating" | "repeat" };

/** Applies a runner's `box.waiting` or `box.scheduled` to the box it names, in the caller's transaction. */
export const recordBoxWaitInTx = async (tx: Tx, clock: Clock, input: RecordBoxWaitInput): Promise<RecordBoxWaitResult> => {
  const { event } = input;
  // The box's row, locked, for this runner only: another runner's box, or another organization's, is never moved.
  await tx.$queryRaw`SELECT 1 FROM "box" WHERE "id" = ${event.boxId} AND "organizationId" = ${input.organizationId} FOR UPDATE`;
  const box = await tx.box.findFirst({
    where: { id: event.boxId, organizationId: input.organizationId, runnerId: input.runnerId },
    select: { id: true, taskId: true, projectId: true, state: true, waitingReason: true, waitingSince: true, scheduledAt: true },
  });
  if (box === null) {
    return { recorded: false, reason: "not-this-runners-box" };
  }
  if (box.state !== "creating") {
    return { recorded: false, reason: "not-creating" };
  }
  const from = { state: "creating" as const, waiting: box.waitingReason === null || box.waitingSince === null ? null : { reason: fromColumn(box.waitingReason), since: box.waitingSince.getTime() } };
  if (event.kind === "box.waiting") {
    if (box.waitingReason === toColumn(event.reason) && box.waitingSince?.getTime() === event.since) {
      return { recorded: false, reason: "repeat" };
    }
    const moved = transitionBox(from, { type: "waiting", reason: event.reason, since: event.since });
    if (!moved.ok) {
      return { recorded: false, reason: "not-creating" };
    }
    await tx.box.update({ where: { id: box.id }, data: { waitingReason: toColumn(event.reason), waitingSince: new Date(event.since) } });
  } else {
    if (box.waitingReason === null && box.scheduledAt !== null) {
      return { recorded: false, reason: "repeat" };
    }
    const moved = transitionBox(from, { type: "scheduled" });
    if (!moved.ok) {
      return { recorded: false, reason: "not-creating" };
    }
    await tx.box.update({ where: { id: box.id }, data: { waitingReason: null, waitingSince: null, scheduledAt: new Date(clock.now()) } });
  }
  // On the task's timeline, in the session the box was made for.
  const session = await tx.session.findFirst({
    where: { boxId: box.id, taskId: box.taskId, organizationId: input.organizationId },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (session !== null) {
    await appendCoreEvent(tx, {
      organizationId: input.organizationId,
      projectId: projectIdSchema.parse(box.projectId),
      taskId: taskIdSchema.parse(box.taskId),
      sessionId: sessionIdSchema.parse(session.id),
      event,
      at: clock.now(),
    });
  }
  return { recorded: true };
};
