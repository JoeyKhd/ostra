import type { CodeHostCapabilities } from "@ostra/adapter-sdk";
import type { Tx } from "@ostra/db";
import { gitShaSchema, taskIdSchema, taskRepoIdSchema } from "@ostra/protocol";
import type { OrganizationId, TaskId } from "@ostra/protocol";

import { ciEvaluateSingletonSeconds } from "../jobs.ts";
import type { ReviewRounds } from "../lifecycles/task.ts";
import type { JobQueue } from "../ports.ts";

// Where a code task's review loop starts (F-035, F-100, ADR 0041, ADR 0058): the rounds a task in
// review runs before a reviewer. CI is read when the code host can read it (`ciResults`), and the
// AI review runs when the project has it on and the host can post a comment-type review
// (`reviewComments`): an optional capability each adapter declares (ADR 0025), so a host without
// one goes straight to "waiting for a reviewer", as milestone 5 did.

export type ReviewLoopCapabilities = Pick<CodeHostCapabilities, "ciResults" | "reviewComments">;

/** The rounds a project's code tasks run, from the project's switch and the code host's capabilities. */
export const reviewRoundsInTx = async (tx: Pick<Tx, "project">, projectId: string, capabilities: ReviewLoopCapabilities): Promise<ReviewRounds> => {
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { aiReview: true } });
  return { ci: capabilities.ciResults, aiReview: capabilities.reviewComments && (project?.aiReview ?? false) };
};

/** The rounds off: milestone 5's path, for a caller with no code host to ask. */
export const NO_REVIEW_ROUNDS: ReviewRounds = { ci: false, aiReview: false };

/** A task repo with a PR open, at its current head: what the loop reads. */
export type OpenTaskPr = { readonly taskRepoId: string; readonly repoId: string; readonly prNumber: number; readonly headSha: string; readonly connectionId: string };

/** The task's repos with a PR open and a head. */
export const openTaskPrsInTx = async (tx: Pick<Tx, "taskRepo">, taskId: string): Promise<readonly OpenTaskPr[]> => {
  const rows = await tx.taskRepo.findMany({
    where: { taskId, state: "pr_open", prNumber: { not: null }, headSha: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, repoId: true, prNumber: true, headSha: true, repo: { select: { connectionId: true } } },
  });
  return rows.flatMap((row) =>
    row.prNumber === null || row.headSha === null ? [] : [{ taskRepoId: row.id, repoId: row.repoId, prNumber: row.prNumber, headSha: row.headSha, connectionId: row.repo.connectionId }],
  );
};

/** One `ci.evaluate` for a task PR's head, after the window that lets check events a moment apart evaluate once. */
export const enqueueCiEvaluationInTx = async (
  jobs: JobQueue,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly taskRepoId: string; readonly headSha: string; readonly connectionId: string },
): Promise<boolean> => {
  const headSha = gitShaSchema.safeParse(input.headSha);
  if (!headSha.success) {
    return false;
  }
  await jobs.enqueueInTx(
    tx,
    "ci.evaluate",
    { organizationId: input.organizationId, taskRepoId: taskRepoIdSchema.parse(input.taskRepoId), headSha: headSha.data },
    { startAfterMs: ciEvaluateSingletonSeconds * 1000, group: { id: input.connectionId } },
  );
  return true;
};

/** The next review round's number for a code task: one more than its review runs so far. */
export const nextReviewRoundInTx = async (tx: Pick<Tx, "reviewRun">, codeTaskId: string): Promise<number> => (await tx.reviewRun.count({ where: { codeTaskId } })) + 1;

/**
 * What a task that just moved in review owes its loop, in the same transaction: CI read on each
 * open PR's head when it's in "CI running", or the AI review started when it's in "AI review".
 * Anything else (waiting for a reviewer, a fixing round) needs nothing here.
 */
export const enterReviewLoopInTx = async (deps: { readonly jobs: JobQueue }, tx: Tx, organizationId: OrganizationId, taskId: TaskId | string): Promise<"ci" | "review" | "none"> => {
  const task = await tx.task.findUnique({ where: { id: taskId }, select: { id: true, kind: true, state: true, subState: true } });
  if (task?.kind !== "code" || task.state !== "in_review") {
    return "none";
  }
  if (task.subState === "ci_running") {
    for (const pr of await openTaskPrsInTx(tx, task.id)) {
      await enqueueCiEvaluationInTx(deps.jobs, tx, { organizationId, taskRepoId: pr.taskRepoId, headSha: pr.headSha, connectionId: pr.connectionId });
    }
    return "ci";
  }
  if (task.subState === "ai_review") {
    await deps.jobs.enqueueInTx(tx, "review.start", { organizationId, codeTaskId: taskIdSchema.parse(task.id), round: await nextReviewRoundInTx(tx, task.id) });
    return "review";
  }
  return "none";
};
