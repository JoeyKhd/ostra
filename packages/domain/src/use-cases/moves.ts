import type { Logger } from "@ostra/adapter-sdk";
import type { Session, Task, Tx } from "@ostra/db";
import { organizationIdSchema, projectIdSchema } from "@ostra/protocol";

import { sessionFromColumns, sessionToColumns, taskFromColumns, taskToColumns } from "../lifecycles/mapping.ts";
import { transitionSession } from "../lifecycles/session.ts";
import type { SessionInput } from "../lifecycles/session.ts";
import { transitionTask } from "../lifecycles/task.ts";
import type { TaskInput } from "../lifecycles/task.ts";
import type { ChangeNotices } from "../ports.ts";

// Moving a task or a session by its lifecycle's transition, in the caller's transaction: the row is
// written only when the transition allows the input. A refusal is an expected answer (a late event,
// a stale click): it's logged with IDs only and changes nothing (ticket 25).

export type MoveDeps = {
  readonly tx: Tx;
  readonly notices: ChangeNotices;
  readonly logger?: Logger;
};

type TaskRow = Pick<Task, "id" | "organizationId" | "projectId" | "kind" | "state" | "subState" | "needsYouReason" | "stoppedReason">;

/** Applies `input` to the task; `true` when it moved. A change notice goes with every move. */
export const moveTaskInTx = async (deps: MoveDeps, task: TaskRow, input: TaskInput): Promise<boolean> => {
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
  await deps.tx.task.update({
    where: { id: task.id },
    data: {
      state: columns.state,
      subState: columns.subState,
      needsYouReason: columns.needsYouReason,
      stoppedReason: columns.stoppedReason,
    },
  });
  await deps.notices.emitInTx(deps.tx, {
    organizationId: organizationIdSchema.parse(task.organizationId),
    projectId: projectIdSchema.parse(task.projectId),
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
