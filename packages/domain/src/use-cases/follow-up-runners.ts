import type { Db, Tx } from "@ostra/db";
import { runnerIdSchema, taskIdSchema } from "@ostra/protocol";
import type { RunnerId, TaskId } from "@ostra/protocol";

// Follow-up tasks run where their task ran (ADR 0059 amended 2026-11-21; F-069, F-014, F-100).
//
// A follow-up is a task ostra starts by itself from a member's code task: today its AI review (a
// review task, `reviewOfTaskId`). A CI round, a findings round and "changes requested" reopen the
// code task itself, which already goes back to its own runner. A follow-up goes to the project's
// pools first, as any task does; when none of their runners can take it now, it may also run on a
// personal runner of the code task's member that the code task ran on, or that the member picked
// for it. Whichever is free first takes it. Never another member's runner, never a runner of an
// outside task (`poolOnly`), and only where the session's provider is allowed on personal runners.

/** The code task a task follows up, or `null` for a task a member or a rule started. */
export const followUpOf = (task: { readonly kind: string; readonly reviewOfTaskId: string | null }): TaskId | null =>
  task.kind === "review" && task.reviewOfTaskId !== null ? taskIdSchema.parse(task.reviewOfTaskId) : null;

/** A personal runner a follow-up may run on, by name for the reason it waits. */
export type FollowUpRunner = { readonly id: RunnerId; readonly name: string };

/** How many of the code task's boxes are read for the runners it ran on, newest first. */
const BOXES_READ = 20;

/**
 * The personal runners a follow-up may run on, newest first: each personal runner of the code
 * task's member that one of its boxes ran on, then the one the member picked for it. Not revoked,
 * and only that member's. None for a task that isn't a follow-up, a code task no member started
 * or that runs on pools only, or a follow-up whose member isn't the code task's.
 */
export const followUpRunnersInTx = async (
  tx: Tx | Db,
  task: { readonly organizationId: string; readonly kind: string; readonly reviewOfTaskId: string | null; readonly creatorMemberId: string | null },
): Promise<readonly FollowUpRunner[]> => {
  const parentId = followUpOf(task);
  if (parentId === null || task.creatorMemberId === null) {
    return [];
  }
  const parent = await tx.task.findFirst({
    where: { id: parentId, organizationId: task.organizationId },
    select: { id: true, creatorMemberId: true, runnerId: true, poolOnly: true },
  });
  if (parent === null || parent.poolOnly || parent.creatorMemberId !== task.creatorMemberId) {
    return [];
  }
  const boxes = await tx.box.findMany({
    where: { taskId: parent.id, organizationId: task.organizationId, runnerId: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: BOXES_READ,
    select: { runnerId: true },
  });
  const ids = [...new Set([...boxes.flatMap((box) => (box.runnerId === null ? [] : [box.runnerId])), ...(parent.runnerId === null ? [] : [parent.runnerId])])];
  if (ids.length === 0) {
    return [];
  }
  const owned = await tx.runner.findMany({
    where: { id: { in: ids }, organizationId: task.organizationId, kind: "personal", ownerMemberId: parent.creatorMemberId, revokedAt: null, state: { not: "revoked" } },
    select: { id: true, name: true },
  });
  return ids.flatMap((id) => {
    const runner = owned.find((row) => row.id === id);
    return runner === undefined ? [] : [{ id: runnerIdSchema.parse(runner.id), name: runner.name }];
  });
};
