import type { Tx } from "@ostra/db";
import { gitPersonSchema } from "@ostra/protocol";
import type { GitPerson, MemberId, OrganizationId, ProjectId, TaskId } from "@ostra/protocol";

import type { JobQueue } from "../ports.ts";
import { enqueueReviewEvaluationsInTx } from "../review/review-check.ts";
import { githubNoReplyAddress } from "./github-link.ts";

// Co-author credit (F-078, ADR 0040, Q41): each member whose prompt led to a task's commits gets a
// `Co-authored-by` trailer on them. The task's start credits the member who started it, an `@ostra`
// comment its commenter (by the link's no-reply address), and the panel's messages their sender: a
// steer, a reopen, a take-over's message, a panel action's message, a Linear follow-up. A
// reviewer's "changes requested" credits no one (ADR 0040, amended).
//
// Where the trailers reach the commits: a fresh session's spec carries the list (`buildTaskSpec`),
// and a message steered into a session that's going carries it too (the steer's `coAuthors`,
// protocol minor 8), so a member credited mid-session is on that box's next commits, not only on the
// next dispatch's. Both read it here (`taskCoAuthorsInTx`), after the sender's credit.

/**
 * How a message's sender is credited (F-078). Missing: by their ostra email. `{ email }`: by that
 * address of theirs (an `@ostra` comment's commenter, by the link's no-reply address, ADR 0052).
 * `false`: not at all (a reviewer's "changes requested", ADR 0040 amended).
 */
export type CoAuthorCredit = false | { readonly email: string } | undefined;

/**
 * Credits the member as a co-author of the task's next commits. By their ostra email, once: a
 * member already credited keeps their row. By another address (`email`), a row for that address,
 * as an `@ostra` comment always wrote one. A new co-author is a new driver for the
 * independent-review check (F-104, Q121), so each open PR of the task is evaluated again. Runs in
 * the caller's transaction, which holds the task's lock. Returns whether the member was new.
 */
export const creditCoAuthorInTx = async (
  jobs: JobQueue,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly taskId: TaskId; readonly memberId: MemberId; readonly email?: string },
): Promise<boolean> => {
  const credited = await tx.taskCoAuthor.count({ where: { taskId: input.taskId, memberId: input.memberId } });
  if (credited > 0 && input.email === undefined) {
    return false;
  }
  const member = await tx.member.findFirst({ where: { id: input.memberId, organizationId: input.organizationId }, select: { user: { select: { name: true, email: true } } } });
  if (member === null) {
    return false;
  }
  const email = input.email ?? member.user.email;
  await tx.taskCoAuthor.upsert({
    where: { taskId_email: { taskId: input.taskId, email } },
    create: { organizationId: input.organizationId, projectId: input.projectId, taskId: input.taskId, memberId: input.memberId, name: member.user.name, email },
    update: {},
  });
  if (credited > 0) {
    return false;
  }
  await enqueueReviewEvaluationsInTx(jobs, tx, { organizationId: input.organizationId, taskId: input.taskId });
  return true;
};

/** Credits a message's sender as the caller asks (`CoAuthorCredit`). */
export const creditSenderInTx = async (
  jobs: JobQueue,
  tx: Tx,
  credit: CoAuthorCredit,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly taskId: TaskId; readonly memberId: MemberId },
): Promise<void> => {
  if (credit === false) {
    return;
  }
  await creditCoAuthorInTx(jobs, tx, credit === undefined ? input : { ...input, email: credit.email });
};

/**
 * The task's trailers, in the order its members were credited: one per member, the first row kept
 * (a member credited at the start by their ostra email and again by an `@ostra` comment's no-reply
 * address gets one trailer), and a row with no member as it was written. A member with a verified
 * GitHub link (F-119, ADR 0052) is credited by the link's no-reply address, read now, so a link
 * made after the task began is used from the next commit on; one without, by the name and email
 * the row holds. A row git can't write as a person is left out.
 */
export const taskCoAuthorsInTx = async (tx: Tx, input: { readonly organizationId: OrganizationId; readonly taskId: TaskId }): Promise<GitPerson[]> => {
  const rows = (await tx.taskCoAuthor.findMany({ where: { taskId: input.taskId, organizationId: input.organizationId }, orderBy: { createdAt: "asc" } })).filter(
    (row, index, all) => row.memberId === null || all.findIndex((other) => other.memberId === row.memberId) === index,
  );
  const linked = await tx.member.findMany({
    where: { id: { in: rows.flatMap((row) => (row.memberId === null ? [] : [row.memberId])) }, organizationId: input.organizationId },
    select: { id: true, user: { select: { githubUserId: true, githubLogin: true } } },
  });
  return rows
    .map((row) => {
      const user = linked.find((member) => member.id === row.memberId)?.user;
      return user?.githubUserId !== undefined && user.githubUserId !== null && user.githubLogin !== null
        ? { name: row.name, email: githubNoReplyAddress(user.githubUserId, user.githubLogin) }
        : { name: row.name, email: row.email };
    })
    .map((person) => gitPersonSchema.safeParse(person))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
};
