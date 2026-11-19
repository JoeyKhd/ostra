import type { PoolId, ProjectId, TaskId } from "@ostra/protocol";

// The queue (F-067, ADR 0059): one per pool, the queued tasks that pool could run, as a query
// over ostra's rows, never a stored list. Its order is ticket priority (Urgent, High, Medium,
// Low), then the time the task was first queued (a requeue keeps it), then its ID.

/** A place in the queue's order: 1 urgent, 2 high, 3 medium, 4 low. */
export type QueuePriority = 1 | 2 | 3 | 4;

/** A prompt task's, and a ticket's without a priority: Medium. */
export const DEFAULT_QUEUE_PRIORITY: QueuePriority = 3;

/**
 * A task's queue priority from its ticket's (Linear's scale: 0 none, 1 urgent to 4 low; another
 * tracker maps onto it). No ticket, no priority or a value off the scale: Medium.
 */
export const queuePriorityFor = (ticketPriority: number | null | undefined): QueuePriority =>
  ticketPriority === 1 || ticketPriority === 2 || ticketPriority === 3 || ticketPriority === 4 ? ticketPriority : DEFAULT_QUEUE_PRIORITY;

/** A queued task as the queue reads it. */
export type QueuedTask = {
  readonly id: TaskId;
  readonly projectId: ProjectId;
  readonly queuePriority: number;
  /** Epoch ms the task was first queued. */
  readonly queuedAt: number;
};

/** The queue's order: priority, then the time queued, then the ID. A comparator for `sort`. */
export const queueOrder = (a: QueuedTask, b: QueuedTask): number => {
  if (a.queuePriority !== b.queuePriority) {
    return a.queuePriority - b.queuePriority;
  }
  if (a.queuedAt !== b.queuedAt) {
    return a.queuedAt - b.queuedAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** A project's pools, as `ProjectPool` rows hold them. */
export type ProjectPoolRow = { readonly projectId: ProjectId; readonly poolId: PoolId };

/**
 * A pool's queue: the queued tasks whose project may use the pool, in the queue's order. A task
 * its project's pools could all run is in each of their queues.
 */
export const poolQueue = <T extends QueuedTask>(
  poolId: PoolId,
  queued: readonly T[],
  projectPools: readonly ProjectPoolRow[],
): readonly T[] => {
  const projects = new Set(projectPools.filter((row) => row.poolId === poolId).map((row) => row.projectId));
  return queued.filter((task) => projects.has(task.projectId)).sort(queueOrder);
};

/** A task's place in an ordered queue, from 1; `null` when it isn't in it. */
export const placeInQueue = (queue: readonly QueuedTask[], taskId: TaskId): number | null => {
  const index = queue.findIndex((task) => task.id === taskId);
  return index < 0 ? null : index + 1;
};
