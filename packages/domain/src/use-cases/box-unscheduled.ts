import type { Logger } from "@ostra/adapter-sdk";
import type { Tx } from "@ostra/db";
import { taskIdSchema } from "@ostra/protocol";
import type { BoxUnscheduled, BoxUnscheduledReason, OrganizationId, RunnerId, TaskId } from "@ostra/protocol";

import type { Ports } from "../ports.ts";
import { requeueTaskInTx } from "./admission.ts";

// A box the cluster never placed (ADR 0060, amended 2026-11-22, F-093). A `kubernetes` runner
// accepts a dispatch at once and makes the box's pod, which may then find no node: none joined
// within the node wait (`no-node`), or the pod stayed unschedulable with no scale-up under way, or
// the namespace's quota refused it (`no-room`). The runner reported room it didn't have. It says
// so in a `runner-event` frame (`box.unscheduled`), after a status that offers no slot, and core
// sends the task back to its pool's queue: the lease ends, the box fails, the task moves from
// `preparing` back to `queued` with its first queued time (its place), and its session, which never
// ran, waits for the next dispatch. Not a crash: nothing needs a member. The queue then holds the
// task as it holds any task with no room (`queued`), until the runner reports room again.
//
// Only the runner the box was given to moves it, and only while the box's lease is the task's and
// the box never ran: the runner keeps its events an hour and sends them again on each connection,
// and a repeat changes nothing.

/** Why the lease ended, as its row keeps it. */
export const boxUnscheduledEndReason = (reason: BoxUnscheduledReason): string => (reason === "no-node" ? "no-node" : "no-room");

/** Why the box failed, as its row keeps it: no content. */
export const boxUnscheduledFailedReason = (reason: BoxUnscheduledReason): string =>
  reason === "no-node" ? "no node joined the cluster in time" : "the cluster had no room for the box";

export type RecordBoxUnscheduledInput = {
  readonly organizationId: OrganizationId;
  readonly runnerId: RunnerId;
  readonly event: BoxUnscheduled;
};

export type RecordBoxUnscheduledResult =
  | { readonly recorded: true; readonly taskId: TaskId }
  | { readonly recorded: false; readonly reason: "not-this-runners-box" | "box-ran" | "lease-ended" | "not-preparing" };

export type RecordBoxUnscheduledDeps = Pick<Ports, "jobs" | "notices" | "clock"> & { readonly logger?: Logger };

/** Applies a runner's `box.unscheduled` to the box it names, in the caller's transaction. */
export const recordBoxUnscheduledInTx = async (deps: RecordBoxUnscheduledDeps, tx: Tx, input: RecordBoxUnscheduledInput): Promise<RecordBoxUnscheduledResult> => {
  const box = await tx.box.findFirst({
    where: { id: input.event.boxId, organizationId: input.organizationId, runnerId: input.runnerId },
    select: { id: true, taskId: true },
  });
  if (box === null) {
    return { recorded: false, reason: "not-this-runners-box" };
  }
  // The task row first, as the dispatch and the offer's answer take it.
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT 1 FROM "task" WHERE "id" = ${box.taskId} AND "organizationId" = ${input.organizationId} FOR UPDATE`;
  if (locked.length === 0) {
    return { recorded: false, reason: "not-this-runners-box" };
  }
  const task = await tx.task.findUniqueOrThrow({ where: { id: box.taskId }, select: { id: true, leaseEpoch: true } });
  const lease = await tx.lease.findFirst({ where: { taskId: task.id, boxId: box.id, epoch: task.leaseEpoch, state: "active" }, select: { id: true } });
  if (lease === null) {
    return { recorded: false, reason: "lease-ended" };
  }
  // A box whose sidecar connected was placed: it ran, and its loss is `box.lost`'s.
  const state = await tx.box.findUniqueOrThrow({ where: { id: box.id }, select: { state: true } });
  if (state.state !== "creating") {
    return { recorded: false, reason: "box-ran" };
  }
  const taskId = taskIdSchema.parse(task.id);
  const requeued = await requeueTaskInTx(
    { jobs: deps.jobs, notices: deps.notices, clock: deps.clock, ...(deps.logger === undefined ? {} : { logger: deps.logger }) },
    tx,
    {
      organizationId: input.organizationId,
      taskId,
      endReason: boxUnscheduledEndReason(input.event.reason),
      boxReason: boxUnscheduledFailedReason(input.event.reason),
      // The admission the next dispatch runs words why it waits: its turn, while no runner has room.
      wait: null,
    },
  );
  return requeued ? { recorded: true, taskId } : { recorded: false, reason: "not-preparing" };
};
