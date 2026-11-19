import type { RelatedPullRequest, RepoFullName, RepoId, TaskId } from "@ostra/protocol";
import { checkoutDirSchema, runnerLimits } from "@ostra/protocol";

import type { TaskStateName } from "../lifecycles/task.ts";

// Several repos per project (F-098, ADR 0027 amended, Q206): the project's repo limit, the "in use"
// rule for removing a repo, the folder name rule, and the two renderers core uses: the repos list
// appended to the agent's instructions, and a PR's "Related" section. Pure.

/** `OSTRA_PROJECT_MAX_REPOS`'s default. */
export const PROJECT_MAX_REPOS_DEFAULT = runnerLimits.projectReposMax;

/** Whether a project with `count` repos may add one more. */
export const canAddProjectRepo = (count: number, maxRepos: number = PROJECT_MAX_REPOS_DEFAULT): boolean => count < maxRepos;

/** The task states in which a task still uses its repos: a repo with such a task can't be removed. */
const FINISHED: ReadonlySet<TaskStateName> = new Set<TaskStateName>(["stopped", "merged", "done"]);

/**
 * A repo is in use while any task that names it hasn't finished: removing it would pull a
 * checkout out from under a session, or orphan an open PR. Finished tasks keep their history.
 */
export const repoInUse = (tasks: readonly { readonly taskId: TaskId; readonly state: TaskStateName }[]): readonly TaskId[] =>
  tasks.filter((task) => !FINISHED.has(task.state)).map((task) => task.taskId);

/**
 * The repo's folder in the workspace: its name, kept to safe characters, made unique among the
 * project's other folders with `-2`, `-3`… (two organizations can both have an `api`).
 */
export const checkoutDirFor = (fullName: RepoFullName, taken: ReadonlySet<string>): string => {
  const name = fullName.split("/")[1] ?? "repo";
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "").slice(0, 90);
  const base = safe === "" || safe === "." || safe === ".." ? "repo" : safe;
  const lowerTaken = new Set([...taken].map((dir) => dir.toLowerCase()));
  let candidate = base;
  for (let suffix = 2; lowerTaken.has(candidate.toLowerCase()); suffix += 1) {
    candidate = `${base}-${String(suffix)}`;
  }
  return checkoutDirSchema.parse(candidate);
};

export type AgentRepo = {
  readonly fullName: RepoFullName;
  readonly checkoutDir: string;
  readonly defaultBranch: string;
  /** F-066: the repo's own branch, when it isn't the task's. */
  readonly branchName?: string;
};

/**
 * What core appends to the agent's instructions when a task has more than one repo: the agent
 * runs at the workspace root, with each repo in its folder.
 */
export const renderReposForAgent = (repos: readonly AgentRepo[], branchName: string): string | null => {
  if (repos.length < 2) {
    return null;
  }
  return [
    "## Repositories",
    "",
    `This task's workspace holds ${String(repos.length)} repositories side by side; you start at the workspace root. Each is its own git repository, on the branch \`${branchName}\`:`,
    "",
    // A repo on a branch of its own (F-066, after a partial merge) says which one; it is already checked out.
    ...repos.map(
      (repo) =>
        `- \`${repo.checkoutDir}/\`: ${repo.fullName} (base: ${repo.defaultBranch}${repo.branchName === undefined || repo.branchName === branchName ? "" : `, branch: \`${repo.branchName}\``})`,
    ),
    "",
    "Change only the repositories the task needs. Commit in each one you change; each changed repository gets its own pull request.",
  ].join("\n");
};

export const RELATED_START = "<!-- ostra:related -->";
export const RELATED_END = "<!-- /ostra:related -->";

export type RelatedPr = RelatedPullRequest & { readonly fullName: RepoFullName; readonly url: string };

/**
 * A PR's body with its "Related" section set to the task's other PRs. Idempotent: the section
 * between its markers is replaced, never added twice, and removed when there are none.
 */
export const withRelatedSection = (body: string, related: readonly RelatedPr[]): string => {
  const start = body.indexOf(RELATED_START);
  const end = body.indexOf(RELATED_END);
  const without = start >= 0 && end > start ? `${body.slice(0, start)}${body.slice(end + RELATED_END.length)}`.replace(/\n{3,}$/, "\n") : body;
  if (related.length === 0) {
    return without.trimEnd();
  }
  const section = [
    RELATED_START,
    "### Related",
    "",
    "This task changed other repositories too:",
    "",
    ...[...related].sort((x, y) => x.fullName.localeCompare(y.fullName) || x.prNumber - y.prNumber).map((pr) => `- ${pr.fullName}#${String(pr.prNumber)}: ${pr.url}`),
    RELATED_END,
  ].join("\n");
  return `${without.trimEnd()}\n\n${section}`;
};

/** The other PRs of the same task, for one PR's section. */
export const relatedFor = <P extends { readonly repoId: RepoId; readonly prNumber: number }>(self: { readonly repoId: RepoId }, all: readonly P[]): readonly P[] =>
  all.filter((pr) => pr.repoId !== self.repoId);
