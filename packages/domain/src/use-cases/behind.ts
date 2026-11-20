import { createHash } from "node:crypto";

import type { Db, Tx } from "@ostra/db";
import { clientMessageIdSchema, gitShaSchema, organizationIdSchema, projectIdSchema, repoIdSchema, taskIdSchema, taskRepoIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, TaskId, TaskRepoId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { updateBranchPrompt } from "../prompts/index.ts";
import type { BehindRepo } from "../prompts/index.ts";
import type { Ports, ServerAdapters } from "../ports.ts";
import { storedDiffInTx } from "./diff-comments.ts";
import type { M3Deps, RecordBehind, RequestUpdateBranch } from "./m3-signatures.ts";
import { sendMemberMessageInTx } from "./member-message.ts";
import type { SendMemberMessageDeps } from "./member-message.ts";
import { repoAccessFor } from "./repo-access.ts";

// Behind and "Update branch" (F-070, ADR 0052; ticket 24). A task repo with a pushed branch is
// "behind" when its base has commits the branch lacks: the code host's compare of the base and the
// branch's head says how many. It's recomputed on the App's `push` to the base branch and by
// `task.reconcile-behind` every OSTRA_RECONCILE_MINUTES. "Update branch" asks the agent, as a
// member message, to merge each base into its branch (never a rebase) and fix the conflicts.

/** The task repos whose `behind` is worth knowing: a pushed branch or an open PR, on a live task. */
const BEHIND_REPO_STATES = ["branch_pushed", "pr_open"] as const;
const FINISHED_TASK_STATES = ["merged", "done", "stopped"] as const;

/** Writes a task repo's `behind`, with when it was checked. A change emits the task's change notice. */
export const recordBehindInTx = async (
  tx: Tx,
  deps: Pick<Ports, "notices" | "clock">,
  input: { readonly taskRepoId: TaskRepoId; readonly behindBy: number },
): Promise<{ readonly ok: true; readonly changed: boolean } | { readonly ok: false; readonly error: "not-found"; readonly message: string }> => {
  const row = await tx.taskRepo.findUnique({ where: { id: input.taskRepoId }, select: { id: true, organizationId: true, projectId: true, taskId: true, behindBy: true } });
  if (row === null) {
    return { ok: false, error: "not-found", message: "no such task repo" };
  }
  const changed = row.behindBy !== input.behindBy;
  await tx.taskRepo.update({ where: { id: row.id }, data: { behindBy: input.behindBy, behindCheckedAt: new Date(deps.clock.now()) } });
  if (changed) {
    await deps.notices.emitInTx(tx, {
      organizationId: organizationIdSchema.parse(row.organizationId),
      projectId: projectIdSchema.parse(row.projectId),
      entity: "task",
      entityId: taskIdSchema.parse(row.taskId),
    });
  }
  return { ok: true, changed };
};

/** The use case's shape (ticket 07). The base's SHA isn't kept: `behindBy` and when it was checked are. */
export const recordBehind: RecordBehind = (deps, input) => deps.db.$transaction((tx) => recordBehindInTx(tx, deps, { taskRepoId: input.taskRepoId, behindBy: input.behindBy }));

export type RefreshBehindDeps = Pick<Ports, "notices" | "clock"> & { readonly db: Db; readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore"> };

export type RefreshBehindResult =
  | { readonly ok: true; readonly behindBy: number; readonly changed: boolean }
  | { readonly ok: false; readonly error: "not-found" | "unsupported" | "code-host-failed"; readonly message: string; readonly retry: boolean };

/** One task repo's `behind`, from the code host's compare of its base and its branch's head. */
export const refreshBehind = async (deps: RefreshBehindDeps, input: { readonly organizationId: OrganizationId; readonly taskRepoId: TaskRepoId }): Promise<RefreshBehindResult> => {
  const taskRepo = await deps.db.taskRepo.findFirst({
    where: { id: input.taskRepoId, organizationId: input.organizationId },
    select: { id: true, repoId: true, baseBranch: true, branchName: true, headSha: true },
  });
  if (taskRepo === null) {
    return { ok: false, error: "not-found", message: "no such task repo", retry: false };
  }
  if (!deps.adapters.codeHost.capabilities.compare) {
    return { ok: false, error: "unsupported", message: `${deps.adapters.codeHost.name} can't compare branches`, retry: false };
  }
  const access = await repoAccessFor(deps.db, deps.adapters.secretStore, input.organizationId, repoIdSchema.parse(taskRepo.repoId));
  if (!access.ok) {
    return { ok: false, error: "code-host-failed", message: access.reason, retry: false };
  }
  const compared = await deps.adapters.codeHost.compare(access.access, taskRepo.baseBranch, taskRepo.headSha ?? taskRepo.branchName);
  if (!compared.ok) {
    return { ok: false, error: "code-host-failed", message: `the code host couldn't compare (${compared.error.code})`, retry: compared.error.code !== "not-found" };
  }
  const behindBy = compared.value.behindBy;
  const recorded = await deps.db.$transaction((tx) => recordBehindInTx(tx, deps, { taskRepoId: taskRepoIdSchema.parse(taskRepo.id), behindBy }));
  return recorded.ok ? { ok: true, behindBy, changed: recorded.changed } : { ok: false, error: "not-found", message: recorded.message, retry: false };
};

/** The most task repos one reconcile pass compares; the next pass carries on with the oldest checked. */
export const BEHIND_PER_PASS = 200;

export type BehindPass = { readonly checked: number; readonly changed: number; readonly failed: number };

const refreshAll = async (deps: RefreshBehindDeps, rows: readonly { readonly id: string; readonly organizationId: string }[]): Promise<BehindPass> => {
  let changed = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await refreshBehind(deps, { organizationId: organizationIdSchema.parse(row.organizationId), taskRepoId: taskRepoIdSchema.parse(row.id) });
    if (result.ok) {
      changed += result.changed ? 1 : 0;
    } else {
      failed += 1;
    }
  }
  return { checked: rows.length, changed, failed };
};

/** `task.reconcile-behind`: every live task repo with a pushed branch, the least recently checked first. */
export const reconcileBehind = async (deps: RefreshBehindDeps, options: { readonly limit?: number } = {}): Promise<BehindPass> => {
  const rows = await deps.db.taskRepo.findMany({
    where: { state: { in: [...BEHIND_REPO_STATES] }, task: { state: { notIn: [...FINISHED_TASK_STATES] } } },
    orderBy: [{ behindCheckedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: options.limit ?? BEHIND_PER_PASS,
    select: { id: true, organizationId: true },
  });
  return refreshAll(deps, rows);
};

export type PushOutcome = BehindPass & {
  /** The task repos whose own branch the push moved: their diff comments are checked (F-072). */
  readonly taskBranches: number;
};

/**
 * The App's `push` (F-070, F-072): to a base branch, each live task repo on it recomputes `behind`;
 * to a task's own branch (a member pushed to it), the comments on older heads are checked against
 * the new head. The repo is found by the connection and the host's repo ID, so another
 * organization's repo is never matched.
 */
export const recordPush = async (
  deps: RefreshBehindDeps & Pick<Ports, "jobs">,
  input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId; readonly hostRepoId: string; readonly ref: string; readonly after: string },
): Promise<PushOutcome> => {
  const branch = input.ref.startsWith("refs/heads/") ? input.ref.slice("refs/heads/".length) : null;
  const none = { checked: 0, changed: 0, failed: 0, taskBranches: 0 };
  if (branch === null) {
    return none;
  }
  const repos = await deps.db.repo.findMany({ where: { organizationId: input.organizationId, connectionId: input.connectionId, hostRepoId: input.hostRepoId }, select: { id: true } });
  if (repos.length === 0) {
    return none;
  }
  const repoIds = repos.map((repo) => repo.id);
  const onBase = await deps.db.taskRepo.findMany({
    where: { organizationId: input.organizationId, repoId: { in: repoIds }, baseBranch: branch, state: { in: [...BEHIND_REPO_STATES] }, task: { state: { notIn: [...FINISHED_TASK_STATES] } } },
    orderBy: { id: "asc" },
    take: BEHIND_PER_PASS,
    select: { id: true, organizationId: true },
  });
  const pass = await refreshAll(deps, onBase);
  // A push to the task's own branch: the comments written on an older head are checked against it.
  const parsedHead = gitShaSchema.safeParse(input.after);
  const head = parsedHead.success ? parsedHead.data : null;
  const own =
    head === null
      ? []
      : await deps.db.taskRepo.findMany({
          where: { organizationId: input.organizationId, repoId: { in: repoIds }, branchName: branch, diffComments: { some: { state: { in: ["draft", "sent"] }, outdatedAt: null, headSha: { not: head } } } },
          select: { taskId: true, repoId: true },
        });
  if (head !== null && own.length > 0) {
    const headSha = head;
    await deps.db.$transaction(async (tx) => {
      for (const taskRepo of own) {
        await deps.jobs.enqueueInTx(tx, "diff.fetch", {
          organizationId: input.organizationId,
          taskId: taskIdSchema.parse(taskRepo.taskId),
          repoId: repoIdSchema.parse(taskRepo.repoId),
          baseSha: null,
          headSha,
        });
      }
    });
  }
  return { ...pass, taskBranches: own.length };
};

// ---------- Update branch ----------

export type UpdateBranchExtras = Pick<SendMemberMessageDeps, "spendCap" | "timers">;

/** `requestUpdateBranch`, with the server's spend cap and session timers for a reopen. */
export const requestUpdateBranchWith = (deps: M3Deps, extras: UpdateBranchExtras, scope: MemberScope, input: { readonly taskId: TaskId }): ReturnType<RequestUpdateBranch> =>
  deps.db.$transaction(
    async (tx) => {
      const task = await tx.task.findFirst({
        where: { id: input.taskId, organizationId: scope.organizationId },
        select: { id: true, projectId: true, project: { select: { access: true } } },
      });
      if (task === null || !requireProjectAccess(scope, { id: projectIdSchema.parse(task.projectId), organizationId: scope.organizationId, access: task.project.access }, "read").ok) {
        return { ok: false, error: "not-found", message: "No such task" };
      }
      const candidates = await tx.taskRepo.findMany({
        where: { taskId: task.id, state: { in: [...BEHIND_REPO_STATES] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, repoId: true, headSha: true, branchName: true, baseBranch: true, behindBy: true, behindCheckedAt: true, repo: { select: { fullName: true } } },
      });
      // The figure the Changes tab shows (`diff.get`): the reconcile's or a webhook's, else the compare
      // of the branch's current head, so the button the tab offers is never refused (F-070).
      const behind: (typeof candidates[number] & { readonly behindBy: number })[] = [];
      for (const row of candidates) {
        const figure = row.behindBy ?? (row.headSha === null ? null : ((await storedDiffInTx(tx, repoIdSchema.parse(row.repoId), row.headSha))?.behindBy ?? null));
        if (figure !== null && figure > 0) {
          behind.push({ ...row, behindBy: figure });
        }
      }
      if (behind.length === 0) {
        return { ok: false, error: "nothing-behind", message: "No repo of the task is behind its base" };
      }
      const repos: BehindRepo[] = behind.map((row) => ({ repo: row.repo.fullName, branch: row.branchName, baseBranch: row.baseBranch, behindBy: row.behindBy }));
      // The same repos at the same check are the same request: pressed twice, sent once.
      const key = behind.map((row) => `${row.id}:${String(row.behindBy)}:${String(row.behindCheckedAt?.getTime() ?? 0)}`).join(",");
      const clientMessageId = clientMessageIdSchema.parse(`update-branch:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`);
      const sent = await sendMemberMessageInTx({ ...deps, ...extras }, tx, scope, {
        taskId: input.taskId,
        clientMessageId,
        text: updateBranchPrompt(repos),
        intent: "update-branch",
        sender: "driver",
      });
      if (!sent.ok) {
        return { ok: false, error: sent.error, message: sent.message };
      }
      if (!sent.duplicate) {
        await deps.audit.recordInTx(tx, {
          organizationId: scope.organizationId,
          projectId: projectIdSchema.parse(task.projectId),
          actor: { kind: "member", id: scope.memberId },
          action: "task.update-branch",
          entity: "task",
          entityId: input.taskId,
          data: { repos: behind.length, delivery: sent.delivery },
        });
      }
      return { ok: true, repos: behind.length, delivery: sent.delivery };
    },
    { timeout: 20_000 },
  );

export const requestUpdateBranch: RequestUpdateBranch = (deps, scope, input) => requestUpdateBranchWith(deps, {}, scope, input);
