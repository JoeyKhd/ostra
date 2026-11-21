import type { Db, DbEnum } from "@ostra/db";
import { followUpOf } from "@ostra/domain";
import { taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, TaskId } from "@ostra/protocol";

// A follow-up and its code task on the task page (2026-11-21; F-100, F-147, ADR 0059 amended): a
// review task says which task and PRs it reviews, and how its newest round went; a code task says
// how its AI review is doing. Words are the panel's; these are states, counts and links.

/**
 * A prompt task's short ID: the last 8 hex digits, as in its branch name (`branchNameFor`). A
 * UUIDv7's first 8 are its timestamp, the same for every task made within about a minute.
 */
export const shortKeyOf = (id: string): string => id.replaceAll("-", "").slice(-8);

/** A review run as the panel reads it: its round, its state, and once handed in its counts. */
export type ReviewRunView = { readonly round: number; readonly state: DbEnum.ReviewRunState; readonly blocking: number; readonly nits: number };

/** The code task a review task reviews: its key, title and PRs, and the review's newest round. */
export type ReviewOfView = {
  readonly taskId: TaskId;
  readonly key: string;
  readonly title: string;
  readonly prs: readonly { readonly repo: string; readonly number: number; readonly url: string }[];
  readonly run: ReviewRunView | null;
};

/** A code task's AI review: its review task's state, and the newest round's. */
export type AiReviewView = { readonly taskId: TaskId; readonly state: DbEnum.TaskState; readonly run: ReviewRunView | null };

const runSelect = { round: true, state: true, blocking: true, nits: true } as const;

/** `reviewOf` for a review task, `aiReview` for a code task with one; `null` otherwise. */
export const loadFollowUp = async (
  db: Db,
  organizationId: OrganizationId,
  task: { readonly id: string; readonly kind: DbEnum.TaskKind; readonly reviewOfTaskId: string | null },
): Promise<{ readonly reviewOf: ReviewOfView | null; readonly aiReview: AiReviewView | null }> => {
  const parentId = followUpOf(task);
  if (parentId !== null) {
    const [code, run] = await Promise.all([
      db.task.findFirst({
        where: { id: parentId, organizationId },
        select: {
          id: true,
          ticketKey: true,
          title: true,
          repos: { where: { prNumber: { not: null }, prUrl: { not: null } }, orderBy: { createdAt: "asc" }, select: { prNumber: true, prUrl: true, repo: { select: { fullName: true } } } },
        },
      }),
      db.reviewRun.findFirst({ where: { organizationId, reviewTaskId: task.id }, orderBy: { round: "desc" }, select: runSelect }),
    ]);
    return {
      reviewOf:
        code === null
          ? null
          : {
              taskId: taskIdSchema.parse(code.id),
              key: code.ticketKey ?? shortKeyOf(code.id),
              title: code.title,
              prs: code.repos.flatMap((repo) => (repo.prNumber === null || repo.prUrl === null ? [] : [{ repo: repo.repo.fullName, number: repo.prNumber, url: repo.prUrl }])),
              run,
            },
      aiReview: null,
    };
  }
  if (task.kind !== "code") {
    return { reviewOf: null, aiReview: null };
  }
  const review = await db.task.findFirst({ where: { organizationId, reviewOfTaskId: task.id, kind: "review" }, orderBy: { createdAt: "asc" }, select: { id: true, state: true } });
  if (review === null) {
    return { reviewOf: null, aiReview: null };
  }
  const run = await db.reviewRun.findFirst({ where: { organizationId, codeTaskId: task.id }, orderBy: { round: "desc" }, select: runSelect });
  return { reviewOf: null, aiReview: { taskId: taskIdSchema.parse(review.id), state: review.state, run } };
};
