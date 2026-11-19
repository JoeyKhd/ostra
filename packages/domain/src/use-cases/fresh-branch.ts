import type { Tx } from "@ostra/db";
import { taskRepoIdSchema } from "@ostra/protocol";
import type { TaskId, TaskRepoId } from "@ostra/protocol";

// A merged repo's fresh branch (F-066, ADR 0052; ticket 24): the old name with `-2`, then `-3`,
// from the base's current head, its merged PR kept in `TaskPullRequest`. Used by the reopen.

/** The name a repo's next branch takes: the first branch's name with `-N`, N its next generation. */
export const freshBranchName = (current: string, generation: number): string => {
  const suffix = `-${String(generation)}`;
  const first = generation > 1 && current.endsWith(suffix) ? current.slice(0, -suffix.length) : current;
  return `${first}-${String(generation + 1)}`;
};

export type FreshBranch = { readonly taskRepoId: TaskRepoId; readonly branchName: string };

/**
 * Gives every merged repo of the task its fresh branch, in the reopen's transaction. When no repo
 * keeps a branch of the old name (every repo with a branch merged), the task's own branch name
 * moves too, so the spec's one branch name is the new one (spec section 11, item 10); the name
 * stays unique in the project (Q136, item 10).
 */
export const freshBranchesInTx = async (tx: Tx, task: { readonly id: TaskId; readonly branchName: string; readonly projectId: string }, now: Date): Promise<readonly FreshBranch[]> => {
  const repos = await tx.taskRepo.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } });
  const merged = repos.filter((repo) => repo.state === "merged");
  if (merged.length === 0) {
    return [];
  }
  // Every merged repo moves one generation on, together, so their branches keep one name.
  const generation = Math.max(...merged.map((repo) => repo.generation));
  let next = generation;
  let name = freshBranchName(task.branchName, next);
  for (;;) {
    const taken = await tx.taskRepo.findFirst({ where: { projectId: task.projectId, branchName: name, taskId: { not: task.id } }, select: { id: true } });
    const takenByTask = await tx.task.findFirst({ where: { projectId: task.projectId, branchName: name, id: { not: task.id } }, select: { id: true } });
    if (taken === null && takenByTask === null) {
      break;
    }
    next += 1;
    name = freshBranchName(task.branchName, next);
  }
  const fresh: FreshBranch[] = [];
  for (const repo of merged) {
    if (repo.prNumber !== null && repo.prUrl !== null) {
      // The merged PR is kept: the backfill or the opener wrote it; a row missing is written now.
      await tx.taskPullRequest.upsert({
        where: { taskRepoId_number: { taskRepoId: repo.id, number: repo.prNumber } },
        create: {
          organizationId: repo.organizationId,
          projectId: repo.projectId,
          taskRepoId: repo.id,
          number: repo.prNumber,
          url: repo.prUrl,
          branchName: repo.branchName,
          state: "merged",
          closedAt: repo.mergedAt ?? now,
        },
        update: { state: "merged", draft: false, draftByOstra: false, closedAt: repo.mergedAt ?? now },
      });
    }
    await tx.taskRepo.update({
      where: { id: repo.id },
      data: {
        branchName: name,
        generation: next + 1,
        state: "no_branch",
        headSha: null,
        ahead: false,
        prNumber: null,
        prUrl: null,
        prTitle: null,
        prBody: null,
        hiddenRefSha: null,
        hiddenRefBaseSha: null,
        mergedAt: null,
        closedAt: null,
        behindBy: null,
        behindCheckedAt: null,
      },
    });
    fresh.push({ taskRepoId: taskRepoIdSchema.parse(repo.id), branchName: name });
  }
  const kept = repos.filter((repo) => repo.state !== "merged" && repo.state !== "no_branch");
  if (kept.length === 0) {
    await tx.task.update({ where: { id: task.id }, data: { branchName: name } });
  }
  return fresh;
};

