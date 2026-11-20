import type { Logger } from "@ostra/adapter-sdk";
import { secretRefSchema } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { organizationIdSchema, projectIdSchema, repoFullNameSchema, repoIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, RepoFullName, RepoId, TaskId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { NOT_LINKED_MESSAGE } from "../code-host/installations.ts";
import type { TaskStateName } from "../lifecycles/task.ts";
import type { AuditLog, ChangeNotices, Clock, JobQueue, ServerAdapters } from "../ports.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import type { AddProjectRepo, RemoveProjectRepo } from "../use-cases/m4-signatures.ts";
import { repoAccessFor } from "../use-cases/repo-access.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import { canAddProjectRepo, checkoutDirFor, PROJECT_MAX_REPOS_DEFAULT, relatedFor, repoInUse, withRelatedSection } from "./several-repos.ts";
import type { RelatedPr } from "./several-repos.ts";

// A project's several repos (F-098, ADR 0027 amended, Q206; milestone 4's ticket 17): adding one
// the App reaches, up to the limit, at the next position; removing one no unfinished task has a
// branch in; their order. A task's repos are the project's when its session starts: a repo added
// since joins the task's next session, with a task repo and no branch. Each change is an audit
// entry. And the "Related" section every open PR of a task carries, kept in step by `pr.link-related`.

export type ProjectReposDeps = {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore">;
  /** `OSTRA_PROJECT_MAX_REPOS`. */
  readonly maxRepos?: number;
};

type Refusal<E extends string> = { readonly ok: false; readonly error: E; readonly message: string };

/** The project, when the member may change its repos: a project admin, or an organization admin. */
const projectFor = async (
  db: Db | Tx,
  scope: MemberScope,
  projectId: ProjectId,
): Promise<{ readonly ok: true; readonly projectId: ProjectId } | Refusal<"forbidden" | "not-found">> => {
  const project = await db.project.findFirst({ where: { id: projectId, organizationId: scope.organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return { ok: false, error: "not-found", message: "No such project" };
  }
  const info = { id: projectIdSchema.parse(project.id), organizationId: scope.organizationId, access: project.access };
  if (!requireProjectAccess(scope, info, "read").ok) {
    return { ok: false, error: "not-found", message: "No such project" };
  }
  if (!requireProjectAccess(scope, info, "admin").ok) {
    return { ok: false, error: "forbidden", message: "Only a project admin changes its repos" };
  }
  return { ok: true, projectId: info.id };
};

/** The project's row lock: adds, removals and reorders of one project take turns. */
const lockProject = (tx: Tx, organizationId: OrganizationId, projectId: ProjectId) =>
  tx.$queryRaw<readonly unknown[]>`SELECT 1 FROM "project" WHERE "id" = ${projectId} AND "organizationId" = ${organizationId} FOR UPDATE`;

/** A GitHub connection's App credentials, or `null` when its key can't be read. */
const appCredentialsOf = async (deps: ProjectReposDeps, organizationId: OrganizationId, connection: { readonly appId: string; readonly privateKeySecretRef: string | null }) => {
  const ref = secretRefSchema.safeParse(connection.privateKeySecretRef);
  if (!ref.success) return null;
  const key = await deps.adapters.secretStore.get(organizationId, ref.data);
  return key.ok ? { appId: connection.appId, privateKey: key.value } : null;
};

const sameRepo = (fullName: RepoFullName) => (repo: { readonly fullName: string }) => repo.fullName.toLowerCase() === fullName.toLowerCase();

/**
 * The repo as a linked installation of one of the organization's Apps lists it. Else `not-linked`
 * when an installation GitHub lists but ostra hasn't linked (a waiting one) has it, and `null`
 * when none reaches it (milestone 1's `listRepos` check, F-136).
 */
const findReachableRepo = async (deps: ProjectReposDeps, organizationId: OrganizationId, fullName: RepoFullName) => {
  const installations = await deps.db.codeHostInstallation.findMany({
    where: { organizationId, state: "linked", removedAt: null, connection: { kind: "github" } },
    orderBy: { createdAt: "asc" },
    select: { installationId: true, connectionId: true, connection: { select: { appId: true, privateKeySecretRef: true } } },
  });
  for (const installation of installations) {
    const app = await appCredentialsOf(deps, organizationId, installation.connection);
    if (app === null) continue;
    const listed = await deps.adapters.codeHost.listRepos(app, installation.installationId);
    if (!listed.ok) continue;
    const found = listed.value.find(sameRepo(fullName));
    if (found !== undefined) {
      return { kind: "reachable", repo: { ...found, installationId: installation.installationId, connectionId: installation.connectionId } } as const;
    }
  }
  // None linked lists it: is it a waiting installation's? Its repos are offered nowhere, but the refusal says why.
  const linked = new Set(installations.map((installation) => `${installation.connectionId}:${installation.installationId}`));
  const connections = await deps.db.connection.findMany({
    where: { organizationId, kind: "github" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, appId: true, privateKeySecretRef: true },
  });
  for (const connection of connections) {
    const app = await appCredentialsOf(deps, organizationId, connection);
    if (app === null) continue;
    const seen = await deps.adapters.codeHost.listInstallations(app);
    if (!seen.ok) continue;
    for (const installation of seen.value) {
      if (linked.has(`${connection.id}:${installation.installationId}`)) continue;
      const listed = await deps.adapters.codeHost.listRepos(app, installation.installationId);
      if (listed.ok && listed.value.some(sameRepo(fullName))) {
        return { kind: "not-linked" } as const;
      }
    }
  }
  return null;
};

export type AddProjectRepoResult = Awaited<ReturnType<AddProjectRepo>>;

/** Adds a repo the organization's App reaches, at the project's next position, within the limit. */
export const addProjectRepo = async (
  deps: ProjectReposDeps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly fullName: RepoFullName },
): Promise<AddProjectRepoResult> => {
  const organizationId = scope.organizationId;
  const project = await projectFor(deps.db, scope, input.projectId);
  if (!project.ok) {
    return project;
  }
  const maxRepos = deps.maxRepos ?? PROJECT_MAX_REPOS_DEFAULT;
  const existing = await deps.db.repo.findMany({ where: { projectId: project.projectId, organizationId }, select: { fullName: true } });
  if (existing.some((repo) => repo.fullName.toLowerCase() === input.fullName.toLowerCase())) {
    return { ok: false, error: "already-added", message: "The project has that repo already" };
  }
  if (!canAddProjectRepo(existing.length, maxRepos)) {
    return { ok: false, error: "limit-reached", message: `A project holds at most ${String(maxRepos)} repos` };
  }
  const reach = await findReachableRepo(deps, organizationId, input.fullName);
  if (reach === null) {
    return { ok: false, error: "no-access", message: "The organization's GitHub App can't reach that repo: install it there first" };
  }
  if (reach.kind === "not-linked") {
    return { ok: false, error: "not-linked", message: NOT_LINKED_MESSAGE };
  }
  const hostRepo = reach.repo;
  return deps.db.$transaction(async (tx): Promise<AddProjectRepoResult> => {
    await lockProject(tx, organizationId, project.projectId);
    // Under the lock: the count and the positions another add may have changed.
    const repos = await tx.repo.findMany({ where: { projectId: project.projectId, organizationId }, select: { fullName: true, checkoutDir: true, position: true, hostRepoId: true } });
    if (repos.some((repo) => repo.hostRepoId === hostRepo.hostRepoId || repo.fullName.toLowerCase() === hostRepo.fullName.toLowerCase())) {
      return { ok: false, error: "already-added", message: "The project has that repo already" };
    }
    if (!canAddProjectRepo(repos.length, maxRepos)) {
      return { ok: false, error: "limit-reached", message: `A project holds at most ${String(maxRepos)} repos` };
    }
    const position = repos.reduce((last, repo) => Math.max(last, repo.position), -1) + 1;
    const checkoutDir = checkoutDirFor(repoFullNameSchema.parse(hostRepo.fullName), new Set(repos.map((repo) => repo.checkoutDir)));
    const created = await tx.repo.create({
      data: {
        organizationId,
        projectId: project.projectId,
        connectionId: hostRepo.connectionId,
        installationId: hostRepo.installationId,
        hostRepoId: hostRepo.hostRepoId,
        fullName: hostRepo.fullName,
        defaultBranch: hostRepo.defaultBranch,
        private: hostRepo.private,
        checkoutDir,
        position,
      },
      select: { id: true },
    });
    const repoId = repoIdSchema.parse(created.id);
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: project.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "project.repo-added",
      entity: "project",
      entityId: project.projectId,
      data: { repoId, fullName: hostRepo.fullName, position },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: project.projectId, entity: "project", entityId: project.projectId });
    return { ok: true, repoId, checkoutDir, position };
  });
};

/** A removal refused while unfinished tasks have a branch in the repo: those tasks, by ID and title. */
export type RepoInUseRefusal = Refusal<"in-use"> & { readonly tasks: readonly { readonly taskId: TaskId; readonly title: string }[] };

export type RemoveProjectRepoResult = Awaited<ReturnType<RemoveProjectRepo>> | RepoInUseRefusal;

/**
 * Removes a repo from the project, unless an unfinished task has a branch in it (it names them) or
 * it's the project's last. The repo's task repos go with it, finished tasks' included.
 */
export const removeProjectRepo = async (deps: ProjectReposDeps, scope: MemberScope, input: { readonly projectId: ProjectId; readonly repoId: RepoId }): Promise<RemoveProjectRepoResult> => {
  const organizationId = scope.organizationId;
  const project = await projectFor(deps.db, scope, input.projectId);
  if (!project.ok) {
    return project;
  }
  return deps.db.$transaction(async (tx): Promise<RemoveProjectRepoResult> => {
    await lockProject(tx, organizationId, project.projectId);
    const repo = await tx.repo.findFirst({ where: { id: input.repoId, projectId: project.projectId, organizationId }, select: { id: true, fullName: true } });
    if (repo === null) {
      return { ok: false, error: "not-found", message: "No such repo in this project" };
    }
    if ((await tx.repo.count({ where: { projectId: project.projectId, organizationId } })) <= 1) {
      return { ok: false, error: "last-repo", message: "A project keeps at least one repo" };
    }
    const branched = await tx.taskRepo.findMany({
      where: { repoId: repo.id, organizationId, state: { not: "no_branch" } },
      select: { task: { select: { id: true, state: true, title: true } } },
    });
    const titles = new Map(branched.map(({ task }) => [task.id, task.title]));
    const inUse = repoInUse(branched.map(({ task }) => ({ taskId: taskIdSchema.parse(task.id), state: task.state satisfies TaskStateName })));
    if (inUse.length > 0) {
      const tasks = [...new Set(inUse)].map((taskId) => ({ taskId, title: titles.get(taskId) ?? "" }));
      return {
        ok: false,
        error: "in-use",
        message: `Unfinished tasks have a branch in ${repo.fullName}: ${tasks.map((task) => task.title).join(", ")}`.slice(0, 2_000),
        tasks,
      };
    }
    await tx.repo.delete({ where: { id: repo.id } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: project.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "project.repo-removed",
      entity: "project",
      entityId: project.projectId,
      data: { repoId: input.repoId, fullName: repo.fullName },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: project.projectId, entity: "project", entityId: project.projectId });
    return { ok: true, removed: true };
  });
};

/** Sets the project's repo order: the repos, each once, first to last. */
export const reorderProjectRepos = async (
  deps: ProjectReposDeps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly repoIds: readonly RepoId[] },
): Promise<UseCaseResult<{ readonly reordered: true }, "forbidden" | "not-found" | "invalid-input">> => {
  const organizationId = scope.organizationId;
  const project = await projectFor(deps.db, scope, input.projectId);
  if (!project.ok) {
    return project;
  }
  return deps.db.$transaction(async (tx) => {
    await lockProject(tx, organizationId, project.projectId);
    const repos = await tx.repo.findMany({ where: { projectId: project.projectId, organizationId }, select: { id: true } });
    const known = new Set(repos.map((repo) => repo.id));
    if (input.repoIds.length !== repos.length || new Set(input.repoIds).size !== repos.length || input.repoIds.some((id) => !known.has(id))) {
      return { ok: false, error: "invalid-input", message: "The order names each of the project's repos once" } as const;
    }
    for (const [position, id] of input.repoIds.entries()) {
      await tx.repo.update({ where: { id }, data: { position } });
    }
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: project.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "project.repos-reordered",
      entity: "project",
      entityId: project.projectId,
      data: { repos: input.repoIds.join(",") },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: project.projectId, entity: "project", entityId: project.projectId });
    return { ok: true, reordered: true } as const;
  });
};

/**
 * When a task's new session starts: a task repo, with no branch yet, for each repo the project
 * gained since the task's last session. The task's branch name is the one its repos share.
 */
export const addNewProjectReposInTx = async (tx: Tx, task: { readonly id: string; readonly organizationId: string; readonly projectId: string; readonly branchName: string }): Promise<number> => {
  const [repos, taskRepos] = await Promise.all([
    tx.repo.findMany({ where: { projectId: task.projectId, organizationId: task.organizationId }, select: { id: true, defaultBranch: true } }),
    tx.taskRepo.findMany({ where: { taskId: task.id }, select: { repoId: true } }),
  ]);
  const has = new Set(taskRepos.map((row) => row.repoId));
  const missing = repos.filter((repo) => !has.has(repo.id));
  if (missing.length === 0) {
    return 0;
  }
  await tx.taskRepo.createMany({
    data: missing.map((repo) => ({
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.id,
      repoId: repo.id,
      branchName: task.branchName,
      baseBranch: repo.defaultBranch,
    })),
    skipDuplicates: true,
  });
  return missing.length;
};

// ---------- the "Related" section (`pr.link-related`) ----------

export type LinkRelatedDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly notices: ChangeNotices;
  readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore">;
  readonly logger?: Logger | undefined;
};

/**
 * Sets the "Related" section of every open PR of a task to the task's other open PRs, keeping the
 * rest of each body as it is on the host, and writes `pr.related_updated` for each it changed. A PR
 * whose section already says so is left alone, so a replay changes nothing. A code host failure
 * throws, so the job retries.
 */
export const linkRelatedPullRequests = async (deps: LinkRelatedDeps, input: { readonly organizationId: OrganizationId; readonly taskId: TaskId }): Promise<{ readonly updated: number }> => {
  const task = await deps.db.task.findFirst({ where: { id: input.taskId, organizationId: input.organizationId }, select: { id: true, projectId: true } });
  if (task === null) {
    return { updated: 0 };
  }
  const open = await deps.db.taskRepo.findMany({
    where: { taskId: task.id, organizationId: input.organizationId, state: "pr_open", prNumber: { not: null }, prUrl: { not: null } },
    orderBy: [{ repo: { position: "asc" } }, { createdAt: "asc" }],
    select: { repoId: true, prNumber: true, prUrl: true, repo: { select: { fullName: true } } },
  });
  const all: RelatedPr[] = open.flatMap((row) =>
    row.prNumber === null || row.prUrl === null ? [] : [{ repoId: repoIdSchema.parse(row.repoId), prNumber: row.prNumber, url: row.prUrl, fullName: repoFullNameSchema.parse(row.repo.fullName) }],
  );
  let updated = 0;
  for (const pr of all) {
    const access = await repoAccessFor(deps.db, deps.adapters.secretStore, input.organizationId, pr.repoId);
    if (!access.ok) {
      throw new Error(`pr.link-related: ${access.reason}`);
    }
    const details = await deps.adapters.codeHost.getPullRequest(access.access, pr.prNumber);
    if (!details.ok) {
      throw new Error(`pr.link-related: the code host couldn't read the PR (${details.error.code})`);
    }
    if (details.value.state !== "open" || details.value.body === undefined) {
      // A PR closed since, or a host that doesn't return the body: nothing to keep, so nothing written.
      continue;
    }
    const current = details.value.body ?? "";
    const related = relatedFor(pr, all);
    const next = withRelatedSection(current, related);
    if (next === current.trimEnd() || next === current) {
      continue;
    }
    const written = await deps.adapters.codeHost.updatePullRequestBody({ access: access.access, number: pr.prNumber, body: next });
    if (!written.ok) {
      throw new Error(`pr.link-related: the code host refused the PR's body (${written.error.code})`);
    }
    updated += 1;
    await deps.db.$transaction(async (tx) => {
      const session = await tx.session.findFirst({ where: { taskId: task.id }, orderBy: { startedAt: "desc" }, select: { id: true } });
      if (session !== null) {
        await appendServerEvent(tx, {
          organizationId: organizationIdSchema.parse(input.organizationId),
          projectId: projectIdSchema.parse(task.projectId),
          taskId: input.taskId,
          sessionId: sessionIdSchema.parse(session.id),
          at: deps.clock.now(),
          event: { kind: "pr.related_updated", repoId: pr.repoId, prNumber: pr.prNumber, related: related.map((other) => ({ repoId: other.repoId, prNumber: other.prNumber })) },
        });
      }
      await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: projectIdSchema.parse(task.projectId), entity: "task", entityId: input.taskId });
    });
    deps.logger?.info("pr.related-updated", { taskId: input.taskId, repoId: pr.repoId, prNumber: pr.prNumber, related: related.length });
  }
  return { updated };
};

/** After a PR opens: the task's PRs link each other, keyed by the task and the PR. */
export const enqueueLinkRelatedInTx = (
  jobs: JobQueue,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly taskId: TaskId; readonly repoId: RepoId; readonly prNumber: number; readonly connectionId: string },
): Promise<void> =>
  jobs.enqueueInTx(tx, "pr.link-related", { organizationId: input.organizationId, taskId: input.taskId, repoId: input.repoId, prNumber: input.prNumber }, { group: { id: input.connectionId } });
