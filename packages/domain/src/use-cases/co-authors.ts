import type { Tx } from "@ostra/db";
import type { MemberId, OrganizationId, ProjectId, TaskId } from "@ostra/protocol";

import type { JobQueue } from "../ports.ts";
import { enqueueReviewEvaluationsInTx } from "../review/review-check.ts";

// Co-author credit (F-078, ADR 0040, Q41): each member whose prompt led to a task's commits gets a
// `Co-authored-by` trailer on them. The task's start credits the member who started it, an `@ostra`
// comment its commenter (by the link's no-reply address, `pr-comments.ts`), and the panel's
// messages their sender: a steer, a reopen, a take-over's message, a panel action's message, a
// Linear follow-up. A reviewer's "changes requested" credits no one (ADR 0040, amended). Which
// address the trailer carries is read at each dispatch (`buildTaskSpec`): the link's no-reply one
// while the member has a verified GitHub link (F-119, ADR 0052), their ostra email otherwise.

/**
 * Credits the member as a co-author of the task's next commits, once: a member already credited
 * keeps their row. A new co-author is a new driver for the independent-review check (F-104, Q121),
 * so each open PR of the task is evaluated again. Runs in the caller's transaction, which holds the
 * task's lock. Returns whether the member was new.
 */
export const creditCoAuthorInTx = async (
  jobs: JobQueue,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly taskId: TaskId; readonly memberId: MemberId },
): Promise<boolean> => {
  const credited = await tx.taskCoAuthor.count({ where: { taskId: input.taskId, memberId: input.memberId } });
  if (credited > 0) {
    return false;
  }
  const member = await tx.member.findFirst({ where: { id: input.memberId, organizationId: input.organizationId }, select: { user: { select: { name: true, email: true } } } });
  if (member === null) {
    return false;
  }
  await tx.taskCoAuthor.upsert({
    where: { taskId_email: { taskId: input.taskId, email: member.user.email } },
    create: { organizationId: input.organizationId, projectId: input.projectId, taskId: input.taskId, memberId: input.memberId, name: member.user.name, email: member.user.email },
    update: {},
  });
  await enqueueReviewEvaluationsInTx(jobs, tx, { organizationId: input.organizationId, taskId: input.taskId });
  return true;
};
