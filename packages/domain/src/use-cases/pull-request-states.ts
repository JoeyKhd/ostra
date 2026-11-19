import { mapTask } from "@ostra/db";
import type { DbEnum, Tx } from "@ostra/db";
import { boxIdSchema, repoIdSchema, taskIdSchema, taskRepoIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, RepoId, TaskRepoId } from "@ostra/protocol";

import { taskRepoFromColumns, taskRepoToColumns } from "../lifecycles/mapping.ts";
import type { TaskInput } from "../lifecycles/task.ts";
import { transitionTaskRepo } from "../lifecycles/task-repo.ts";
import type { TaskRepoInput, TaskRepoLifecycle } from "../lifecycles/task-repo.ts";
import type { Ports } from "../ports.ts";
import { writeTicketStepsInTx } from "../tickets/ticket-writes.ts";
import type { TicketSyncTrigger } from "../tickets/ticket-writes.ts";
import type { UseCaseResult } from "./common.ts";
import { moveTaskInTx } from "./moves.ts";

// A PR's state (F-031, F-044, F-079; spec section 4, "A PR's state"): from the App's
// `pull_request` webhook and from the reconcile every few minutes, which must agree, so both call
// this one use case. Body: ticket 16.

export type PullRequestState = "open" | "merged" | "closed";

export type RecordPullRequestStateInput = {
  readonly organizationId: OrganizationId;
  readonly connectionId: ConnectionId;
  /** The code host's repo ID and the PR's number, which find the task repo. */
  readonly hostRepoId: string;
  readonly prNumber: number;
  readonly state: PullRequestState;
  readonly headSha: string | null;
  /** When the code host says it changed, in ms since the epoch: an older report changes nothing. */
  readonly changedAt: number;
  readonly source: "webhook" | "reconcile";
};

export type RecordPullRequestStateResult = UseCaseResult<
  {
    readonly taskRepoId: TaskRepoId | null;
    /**
     * What the task did: merged, stopped (`prs_closed`), back in review (a PR reopened on the host;
     * added by ticket 16), or nothing.
     */
    readonly taskOutcome: "merged" | "stopped" | "in-review" | "unchanged";
  },
  "stale"
>;

export type RecordPullRequestStateDeps = Pick<Ports, "jobs" | "notices" | "clock" | "audit"> & { readonly tx: Tx };

/**
 * Moves the task repo (`pr_merged`, `pr_closed`, `pr_reopened`), and the task once its last PR
 * merged or every PR closed. The last PR closing enqueues `box.release` and the ticket's "done"
 * write when the board says ostra moves it there.
 */
export type RecordPullRequestState = (deps: RecordPullRequestStateDeps, input: RecordPullRequestStateInput) => Promise<RecordPullRequestStateResult>;

/** Where a task's PRs leave it (Q107): independent of the order their events arrive in. */
export type PullRequestsOutcome = "in-review" | "merged" | "stopped" | "no-pr";

/**
 * The rule over a task's task repos (ADR 0027, Q107): in review while at least one PR is open;
 * merged when none is open and at least one merged; stopped when none is open and none merged. Pure.
 */
export const pullRequestsOutcome = (repos: readonly Pick<TaskRepoLifecycle, "state">[]): PullRequestsOutcome => {
  const withPr = repos.filter((repo) => repo.state === "pr_open" || repo.state === "merged" || repo.state === "closed_unmerged");
  if (withPr.length === 0) return "no-pr";
  if (withPr.some((repo) => repo.state === "pr_open")) return "in-review";
  return withPr.some((repo) => repo.state === "merged") ? "merged" : "stopped";
};

/** The task repo's inputs that take it from where it is to the host's state. Merged is final on the host. */
const repoInputsFor = (repo: TaskRepoLifecycle, state: PullRequestState): readonly TaskRepoInput[] => {
  switch (state) {
    case "open":
      return repo.state === "closed_unmerged" ? [{ type: "pr_reopened" }] : [];
    case "closed":
      return repo.state === "pr_open" ? [{ type: "pr_closed" }] : [];
    case "merged":
      // A PR seen closed, then merged (the reopen between them was missed): reopened, then merged.
      return repo.state === "pr_open" ? [{ type: "pr_merged" }] : repo.state === "closed_unmerged" ? [{ type: "pr_reopened" }, { type: "pr_merged" }] : [];
    default:
      return state satisfies never;
  }
};

const taskInputFor = (
  outcome: PullRequestsOutcome,
  task: { readonly state: DbEnum.TaskState; readonly stoppedReason: DbEnum.TaskStopReason | null },
): TaskInput | null => {
  switch (outcome) {
    case "in-review":
      return task.state === "merged" || (task.state === "stopped" && task.stoppedReason === "prs_closed") ? { type: "pr_reopened" } : null;
    case "merged":
      return task.state === "in_review" ? { type: "last_pr_merged" } : null;
    case "stopped":
      return task.state === "in_review" ? { type: "all_prs_closed" } : null;
    case "no-pr":
      return null;
    default:
      return outcome satisfies never;
  }
};

const triggerFor = (repo: TaskRepoLifecycle, repoId: RepoId, changedAt: number): TicketSyncTrigger => {
  switch (repo.state) {
    case "merged":
      return { kind: "pr-merged", repoId, changedAt };
    case "closed_unmerged":
      return { kind: "pr-closed", repoId, changedAt };
    case "pr_open":
    case "no_branch":
    case "branch_pushed":
      return { kind: "pr-reopened", repoId, changedAt };
    default:
      return repo satisfies never;
  }
};

const auditActionFor = (repo: TaskRepoLifecycle): string =>
  repo.state === "merged" ? "pr.merged" : repo.state === "closed_unmerged" ? "pr.closed" : "pr.reopened";

export const recordPullRequestState: RecordPullRequestState = async (deps, input) => {
  const { tx } = deps;
  // The task repo: the PR's number on a repo of this connection, in this organization. A PR the App
  // didn't open for a task, or a repo outside every project, finds nothing and is ignored.
  const repos = await tx.repo.findMany({
    where: { organizationId: input.organizationId, connectionId: input.connectionId, hostRepoId: input.hostRepoId },
    select: { id: true },
  });
  if (repos.length === 0) {
    return { ok: true, taskRepoId: null, taskOutcome: "unchanged" };
  }
  const candidate = await tx.taskRepo.findFirst({
    where: { repoId: { in: repos.map((repo) => repo.id) }, prNumber: input.prNumber, state: { in: ["pr_open", "merged", "closed_unmerged"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, taskId: true },
  });
  if (candidate === null) {
    return { ok: true, taskRepoId: null, taskOutcome: "unchanged" };
  }
  // One task at a time: the webhook and the reconcile meet here, under the task's row lock.
  await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${candidate.taskId} AND "organizationId" = ${input.organizationId} FOR UPDATE`;
  const taskRow = await tx.task.findFirst({ where: { id: candidate.taskId, organizationId: input.organizationId } });
  const row = await tx.taskRepo.findUnique({ where: { id: candidate.id } });
  if (taskRow === null || row === null) {
    return { ok: true, taskRepoId: null, taskOutcome: "unchanged" };
  }
  const task = mapTask(taskRow);
  const taskRepoId = taskRepoIdSchema.parse(row.id);
  const current = taskRepoFromColumns(row);
  if (!current.ok) {
    return { ok: true, taskRepoId, taskOutcome: "unchanged" };
  }
  // A report older than the close or merge already recorded changes nothing.
  const recordedAt = Math.max(row.mergedAt?.getTime() ?? 0, row.closedAt?.getTime() ?? 0);
  if (current.value.state !== "pr_open" && input.changedAt < recordedAt) {
    return { ok: false, error: "stale", message: "an older report of the PR than the one recorded" };
  }
  let repo = current.value;
  for (const step of repoInputsFor(repo, input.state)) {
    const moved = transitionTaskRepo(repo, step);
    if (moved.ok) repo = moved.state;
  }
  const changed = repo.state !== current.value.state;
  const repoId = repoIdSchema.parse(row.repoId);
  if (changed) {
    const at = new Date(input.changedAt);
    await tx.taskRepo.update({
      where: { id: row.id },
      data: {
        state: taskRepoToColumns(repo).state,
        ...(repo.state === "merged" ? { mergedAt: at, closedAt: at } : repo.state === "closed_unmerged" ? { closedAt: at } : { closedAt: null }),
        ...(input.headSha === null ? {} : { headSha: input.headSha }),
      },
    });
    // The ticket: the merge's "done" when ostra moves it there, and the comment's edit.
    await writeTicketStepsInTx({ tx, jobs: deps.jobs }, { taskId: task.id, trigger: triggerFor(repo, repoId, input.changedAt) });
    await deps.audit.recordInTx(tx, {
      organizationId: input.organizationId,
      projectId: task.projectId,
      actor: { kind: "system", id: null },
      action: auditActionFor(repo),
      entity: "task",
      entityId: task.id,
      data: { repoId, number: input.prNumber, source: input.source },
    });
  }

  // The task follows the set of its PRs (Q107), whichever event came last.
  const all = await tx.taskRepo.findMany({ where: { taskId: task.id }, select: { state: true } });
  const outcome = pullRequestsOutcome(all);
  const taskInput = taskInputFor(outcome, task);
  let taskOutcome: "merged" | "stopped" | "in-review" | "unchanged" = "unchanged";
  if (taskInput !== null && (await moveTaskInTx({ tx, notices: deps.notices }, task, taskInput))) {
    taskOutcome = outcome === "merged" ? "merged" : outcome === "stopped" ? "stopped" : "in-review";
    if (outcome === "merged" || outcome === "stopped") {
      // No PR left open: the box goes, and the hidden ref with it (ticket 20's `box.release`).
      const boxes = await tx.box.findMany({ where: { taskId: task.id, state: { not: "released" } }, select: { id: true } });
      for (const box of boxes) {
        await deps.jobs.enqueueInTx(tx, "box.release", {
          organizationId: input.organizationId,
          taskId: taskIdSchema.parse(task.id),
          boxId: boxIdSchema.parse(box.id),
          reason: "prs-closed",
        });
      }
    }
  } else if (changed) {
    await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
  }
  return { ok: true, taskRepoId, taskOutcome };
};
