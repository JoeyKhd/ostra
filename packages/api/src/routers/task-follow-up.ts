import type { Db, DbEnum } from "@ostra/db";
import { followUpOf, reviewHeadsSchema } from "@ostra/domain";
import { readAgentMessage } from "@ostra/domain/agent-message";
import { taskEventSchema, taskIdSchema } from "@ostra/protocol";
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

/**
 * Milestone 10 (F-151/c7, ticket 08; the targets' choice 10, `s3.md`): a review task's figures, for
 * its status line (`round 2 of 3: nothing blocking, 1 nit`), its Result group and its top bar
 * (`Open the code task`, `PR #483`, `Open the review`). From its newest review run, the round
 * limit and the code task it reviews. Counts and links only, never the review's text.
 */
export type ReviewFiguresView = {
  /** Which review this is, of how many, as the round's first message names them (`round 2 of 3`). */
  readonly round: number;
  readonly limit: number;
  /** The newest run's state: `running` until it's handed in, then `submitted` and `posted`, or `failed`. */
  readonly state: DbEnum.ReviewRunState;
  /** The findings it handed in, blocking and nits; both `0` before the hand-in. */
  readonly blocking: number;
  readonly nits: number;
  /** The review ostra posted on the PR, on the code host; `null` before it posts. */
  readonly url: string | null;
  readonly codeTask: { readonly id: TaskId; readonly key: string; readonly title: string };
  /** The PR it reviews: the run's first head's, else the code task's first; `null` with neither. */
  readonly prNumber: number | null;
};

const runSelect = { id: true, round: true, state: true, blocking: true, nits: true, heads: true } as const;

/** A run as the follow-up views show it, without the columns only the figures read. */
const runViewOf = (run: ReviewRunView | null): ReviewRunView | null => (run === null ? null : { round: run.round, state: run.state, blocking: run.blocking, nits: run.nits });

/**
 * The round and its limit as the review's first message names them: read back from the review
 * task's prompt, which each round rewrites (`reviewPrompt`), so the status line says what ostra's
 * outlined bubble says. A prompt that doesn't read as a review's falls back to the run's round, of
 * the first review and one per review round the cap allows (`OSTRA_REVIEW_ROUNDS`), never below it.
 */
const roundOf = (prompt: string | null, run: { readonly round: number }, reviewRounds: number): { readonly round: number; readonly limit: number } => {
  const message = prompt === null ? null : readAgentMessage({ text: prompt, intent: undefined });
  return message?.kind === "ai-review" ? { round: message.round.number, limit: message.round.of } : { round: run.round, limit: Math.max(reviewRounds + 1, run.round) };
};

/** `reviewOf` and `review` for a review task, `aiReview` for a code task with one; `null` otherwise. */
export const loadFollowUp = async (
  db: Db,
  organizationId: OrganizationId,
  task: { readonly id: string; readonly kind: DbEnum.TaskKind; readonly reviewOfTaskId: string | null; readonly prompt: string | null },
  limits: { readonly reviewRounds: number },
): Promise<{ readonly reviewOf: ReviewOfView | null; readonly aiReview: AiReviewView | null; readonly review: ReviewFiguresView | null }> => {
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
    const prs = code === null ? [] : code.repos.flatMap((repo) => (repo.prNumber === null || repo.prUrl === null ? [] : [{ repo: repo.repo.fullName, number: repo.prNumber, url: repo.prUrl }]));
    const reviewOf = code === null ? null : { taskId: taskIdSchema.parse(code.id), key: code.ticketKey ?? shortKeyOf(code.id), title: code.title, prs, run: runViewOf(run) };
    if (reviewOf === null || run === null) {
      return { reviewOf, aiReview: null, review: null };
    }
    const [head] = reviewHeadsSchema.safeParse(run.heads).data ?? [];
    // The review's address on the code host, as ostra posted it: the review task's own
    // `review.posted` for this run, on the reviewed PR's repo, else the first one posted.
    const posted = (
      await db.event.findMany({
        where: { taskId: task.id, organizationId, kind: "review.posted", payload: { path: ["reviewRunId"], equals: run.id } },
        orderBy: { seq: "asc" },
        select: { payload: true },
      })
    ).flatMap((row) => {
      const event = taskEventSchema.safeParse(row.payload);
      return event.success && event.data.kind === "review.posted" ? [event.data] : [];
    });
    const url = (posted.find((one) => one.repoId === head?.repoId) ?? posted[0])?.url ?? null;
    return {
      reviewOf,
      aiReview: null,
      review: {
        ...roundOf(task.prompt, run, limits.reviewRounds),
        state: run.state,
        blocking: run.blocking,
        nits: run.nits,
        url,
        codeTask: { id: reviewOf.taskId, key: reviewOf.key, title: reviewOf.title },
        prNumber: head?.prNumber ?? prs[0]?.number ?? null,
      },
    };
  }
  if (task.kind !== "code") {
    return { reviewOf: null, aiReview: null, review: null };
  }
  const review = await db.task.findFirst({ where: { organizationId, reviewOfTaskId: task.id, kind: "review" }, orderBy: { createdAt: "asc" }, select: { id: true, state: true } });
  if (review === null) {
    return { reviewOf: null, aiReview: null, review: null };
  }
  const run = await db.reviewRun.findFirst({ where: { organizationId, codeTaskId: task.id }, orderBy: { round: "desc" }, select: runSelect });
  return { reviewOf: null, aiReview: { taskId: taskIdSchema.parse(review.id), state: review.state, run: runViewOf(run) }, review: null };
};
