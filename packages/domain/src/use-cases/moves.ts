import type { Logger } from "@ostra/adapter-sdk";
import type { mapTask, Session, Tx } from "@ostra/db";

import { sessionFromColumns, sessionToColumns, taskFromColumns, taskToColumns } from "../lifecycles/mapping.ts";
import { transitionSession } from "../lifecycles/session.ts";
import type { SessionInput } from "../lifecycles/session.ts";
import { transitionTask } from "../lifecycles/task.ts";
import type { TaskInput } from "../lifecycles/task.ts";
import type { ChangeNotices, JobQueue } from "../ports.ts";
import { recordTicketProgressInTx } from "../tickets/ticket-writes.ts";
import { closeItemsOfEndedTaskInTx, isEndedTaskState } from "./needs-you-items.ts";

// Moving a task or a session by its lifecycle's transition, in the caller's transaction: the row is
// written only when the transition allows the input. A refusal is an expected answer (a late event,
// a stale click): it's logged with IDs only and changes nothing (ticket 25).

export type MoveDeps = {
  readonly tx: Tx;
  readonly notices: ChangeNotices;
  readonly logger?: Logger;
};

/** A task's move also owes the fan-out of the items it closes. */
export type TaskMoveDeps = MoveDeps & { readonly jobs: JobQueue };

/** A task row as `mapTask` gives it, so its IDs are branded. */
type TaskRow = Pick<
  ReturnType<typeof mapTask>,
  "id" | "organizationId" | "projectId" | "kind" | "state" | "subState" | "needsYouReason" | "stoppedReason"
>;

/**
 * Applies `input` to the task; `true` when it moved. A change notice goes with every move, and a
 * move that ends the task (stopped, merged, done) dismisses its open needs-you items: an item never
 * outlives its reason.
 */
export const moveTaskInTx = async (deps: TaskMoveDeps, task: TaskRow, input: TaskInput): Promise<boolean> => {
  const current = taskFromColumns(task);
  if (!current.ok) {
    deps.logger?.error("task.unreadable", { taskId: task.id, reason: current.reason });
    return false;
  }
  const moved = transitionTask(current.value, input);
  if (!moved.ok) {
    deps.logger?.info("task.transition-refused", { taskId: task.id, input: input.type, state: task.state });
    return false;
  }
  const columns = taskToColumns(moved.state);
  const updated = await deps.tx.task.update({
    where: { id: task.id },
    data: {
      state: columns.state,
      subState: columns.subState,
      needsYouReason: columns.needsYouReason,
      stoppedReason: columns.stoppedReason,
    },
    select: { ticketId: true },
  });
  if (updated.ticketId !== null) {
    // A ticket task's progress comment shows every move (F-031): its edit commits with the move.
    await recordTicketProgressInTx(deps.tx, task.id, columns.state);
  }
  if (isEndedTaskState(columns.state)) {
    await closeItemsOfEndedTaskInTx(deps, deps.tx, task.id, { at: new Date(), byMemberId: null });
  }
  await deps.notices.emitInTx(deps.tx, {
    organizationId: task.organizationId,
    projectId: task.projectId,
    entity: "task",
    entityId: task.id,
  });
  return true;
};

type SessionRow = Pick<Session, "id" | "taskId" | "state" | "outcome">;

/** Applies `input` to the session; `true` when it moved. */
export const moveSessionInTx = async (deps: MoveDeps, session: SessionRow, input: SessionInput): Promise<boolean> => {
  const current = sessionFromColumns(session);
  if (!current.ok) {
    deps.logger?.error("session.unreadable", { sessionId: session.id, reason: current.reason });
    return false;
  }
  const moved = transitionSession(current.value, input);
  if (!moved.ok) {
    deps.logger?.info("session.transition-refused", { sessionId: session.id, input: input.type, state: session.state });
    return false;
  }
  const columns = sessionToColumns(moved.state);
  const ending = columns.state === "ended" || columns.state === "stopped" || columns.state === "crashed";
  await deps.tx.session.update({
    where: { id: session.id },
    data: { state: columns.state, outcome: columns.outcome, ...(ending ? { endedAt: new Date() } : {}) },
  });
  return true;
};
