import { mapTask } from "@ostra/db";
import { projectIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, RunnerId, SessionId, TaskEventOf, TaskId } from "@ostra/protocol";

import { recordSessionCrashInTx } from "./ingest-events.ts";
import type { SessionCrashDeps } from "./ingest-events.ts";
import { appendCoreEvent } from "./server-events.ts";

// A box lost under its task (F-047, ADR 0039's lost box, ADR 0029's parity). On `host` the runner
// holds the session, so it says `session.crashed` itself, and a restarted one says it for each
// session its last process left (`reportRestoredSessions`). A `docker` or `kubernetes` box's
// session is its sidecar's, which can say nothing once its box is gone: its pool runner sees the
// box go (a sidecar that exited with an error or vanished, a pod deleted or failed) and says so in
// a `runner-event` frame (`box.lost`). Core then records the crash itself, with the cause
// `box_lost`, and moves the rows as the runner's own `session.crashed` would: the task needs its
// driver, the box failed, the lease ended, and the one-click reopen restores on a fresh box from
// the last archive and the hidden ref. Without it, the sidecar's grace stopped the task after 10
// minutes as `runner_lost`, and left the box `stopped`.
//
// Only the runner the box was given to reports it, and only while the box's lease and session are
// still on it: a box whose task already ended, stopped or moved on is a repeat (the runner keeps
// its events an hour and sends them again on each connection), and changes nothing.

/** The crash's words on the task's timeline: no content, as the runner's own. */
export const BOX_LOST_ERROR = "the box went away while the session was on it";

export type RecordBoxLostInput = {
  readonly organizationId: OrganizationId;
  readonly runnerId: RunnerId;
  readonly event: TaskEventOf<"box.lost">;
};

export type RecordBoxLostResult =
  | { readonly recorded: true; readonly taskId: TaskId; readonly sessionId: SessionId }
  | { readonly recorded: false; readonly reason: "not-this-runners-box" | "host-box" | "lease-ended" | "session-ended" };

const ACTIVE_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;

/** Applies a pool runner's `box.lost` to the box it names, in the caller's transaction. */
export const recordBoxLostInTx = async (deps: SessionCrashDeps, input: RecordBoxLostInput): Promise<RecordBoxLostResult> => {
  const { tx } = deps;
  const box = await tx.box.findFirst({
    where: { id: input.event.boxId, organizationId: input.organizationId, runnerId: input.runnerId },
    select: { id: true, taskId: true, executor: true },
  });
  if (box === null) {
    return { recorded: false, reason: "not-this-runners-box" };
  }
  if (box.executor === "host") {
    // The runner holds a `host` box's session, and says its crash in it.
    return { recorded: false, reason: "host-box" };
  }
  // The task row as ingest takes it: the box's last events, the grace's end and a reopen wait.
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT 1 FROM "task" WHERE "id" = ${box.taskId} AND "organizationId" = ${input.organizationId} FOR NO KEY UPDATE`;
  if (locked.length === 0) {
    return { recorded: false, reason: "not-this-runners-box" };
  }
  const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: box.taskId } }));
  const lease = await tx.lease.findFirst({ where: { taskId: task.id, boxId: box.id, epoch: task.leaseEpoch, state: "active" }, select: { id: true } });
  if (lease === null) {
    return { recorded: false, reason: "lease-ended" };
  }
  const session = await tx.session.findFirst({
    where: { taskId: task.id, boxId: box.id, state: { in: [...ACTIVE_SESSION_STATES] } },
    orderBy: { startedAt: "desc" },
  });
  if (session === null) {
    return { recorded: false, reason: "session-ended" };
  }
  const taskId = taskIdSchema.parse(task.id);
  const sessionId = sessionIdSchema.parse(session.id);
  await appendCoreEvent(tx, {
    organizationId: input.organizationId,
    projectId: projectIdSchema.parse(task.projectId),
    taskId,
    sessionId,
    event: { kind: "session.crashed", error: BOX_LOST_ERROR, cause: "box_lost" },
    at: deps.clock.now(),
  });
  await recordSessionCrashInTx(deps, task, session);
  return { recorded: true, taskId, sessionId };
};
