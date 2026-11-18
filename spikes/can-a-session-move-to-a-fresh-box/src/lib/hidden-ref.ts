// The task's hidden ref (ADR 0039, step 2 after every turn): the working tree,
// uncommitted and untracked files included, as a commit outside the task's
// branches, pushed to `refs/ostra/wip/<task>`.
//
// The commit has the shape of a `git stash` commit, so the staged state comes
// back too:
//   wip    tree = the working tree (as `git add -A` would see it: ignored files are left out)
//          parent 1 = HEAD, parent 2 = the index commit
//   index  tree = the index, parent = HEAD
// Nothing touches the real index, HEAD or any branch while saving: the working
// tree is read into a temporary index file.
//
// Restoring, on a fresh clone at the same HEAD, is a two-tree `read-tree -m -u`
// from HEAD to the wip tree (it creates, updates and deletes files), and then
// the index is set from the index commit, so files that were untracked are
// untracked again.

import { copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { git, gitOut, statusEntries } from "./git.ts";
import type { TaskId } from "./ids.ts";

export const hiddenRef = (task: TaskId): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(task) || task.includes("..") || task.endsWith(".lock")) throw new Error("hiddenRef: bad task ID");
  return `refs/ostra/wip/${task}`;
};

export type SavedWork = {
  readonly ref: string;
  readonly commit: string;
  readonly head: string;
  readonly indexCommit: string;
  /** `git status` entries at the time of saving (`XY path`). */
  readonly status: readonly string[];
  /** Whether the working tree and index matched HEAD (a finished turn that was committed). */
  readonly clean: boolean;
};

export type SaveOptions = {
  readonly workspace: string;
  /** A remote name or URL. */
  readonly remote: string;
  readonly task: TaskId;
  readonly turn: number;
  /** Extra environment for the push (credentials go here, never into arguments). */
  readonly pushEnv?: Readonly<Record<string, string>>;
};

export const saveWorkInProgress = async (options: SaveOptions): Promise<SavedWork> => {
  const { workspace: cwd } = options;
  const ref = hiddenRef(options.task);
  const head = await gitOut(["rev-parse", "HEAD"], { cwd });
  const status = await statusEntries(cwd);

  const indexTree = await gitOut(["write-tree"], { cwd });
  const indexCommit = await gitOut(["commit-tree", indexTree, "-p", head, "-m", `ostra: index of ${options.task} after turn ${String(options.turn)}`], { cwd });

  const realIndex = path.resolve(cwd, await gitOut(["rev-parse", "--git-path", "index"], { cwd }));
  const tempIndex = `${realIndex}.ostra-wip`;
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    // Start from the real index, so `add -A` sees what was staged; a repo with no index starts from HEAD.
    await copyFile(realIndex, tempIndex).catch(async () => git(["read-tree", head], { cwd, env }));
    await git(["add", "-A"], { cwd, env });
    const worktreeTree = await gitOut(["write-tree"], { cwd, env });
    const commit = await gitOut(
      ["commit-tree", worktreeTree, "-p", head, "-p", indexCommit, "-m", `ostra: work in progress of ${options.task} after turn ${String(options.turn)}`],
      { cwd },
    );
    await git(["push", "--quiet", "--no-verify", options.remote, `+${commit}:${ref}`], { cwd, ...(options.pushEnv === undefined ? {} : { env: options.pushEnv }) });
    return { ref, commit, head, indexCommit, status, clean: status.length === 0 };
  } finally {
    await rm(tempIndex, { force: true });
  }
};

export type RestoredWork = {
  readonly commit: string;
  readonly status: readonly string[];
};

export type RestoreOptions = {
  readonly workspace: string;
  readonly remote: string;
  readonly task: TaskId;
  readonly fetchEnv?: Readonly<Record<string, string>>;
};

/** Restores the hidden ref into a clone whose HEAD is the ref's first parent. Returns undefined when the remote has no such ref. */
export const restoreWorkInProgress = async (options: RestoreOptions): Promise<RestoredWork | undefined> => {
  const { workspace: cwd } = options;
  const ref = hiddenRef(options.task);
  const listed = await gitOut(["ls-remote", options.remote, ref], { cwd, ...(options.fetchEnv === undefined ? {} : { env: options.fetchEnv }) });
  if (listed === "") return undefined;
  await git(["fetch", "--quiet", "--no-tags", options.remote, `+${ref}:${ref}`], { cwd, ...(options.fetchEnv === undefined ? {} : { env: options.fetchEnv }) });
  const commit = await gitOut(["rev-parse", ref], { cwd });
  const parents = (await gitOut(["rev-list", "--parents", "-n", "1", commit], { cwd })).split(" ").slice(1);
  const [base, indexCommit] = parents;
  if (base === undefined || indexCommit === undefined) throw new Error("the hidden ref is not a work-in-progress commit");
  const head = await gitOut(["rev-parse", "HEAD"], { cwd });
  if (head !== base) throw new Error("the hidden ref was saved on another commit than the branch's head");

  const realIndex = path.resolve(cwd, await gitOut(["rev-parse", "--git-path", "index"], { cwd }));
  const tempIndex = `${realIndex}.ostra-restore`;
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    // The fresh clone's index matches HEAD and has stat data, so the two-tree
    // merge sees a clean tree. Without an index, start from HEAD and refresh.
    await copyFile(realIndex, tempIndex).catch(async () => {
      await git(["read-tree", head], { cwd, env });
      await git(["update-index", "-q", "--refresh"], { cwd, env }).catch(() => undefined);
    });
    await git(["read-tree", "-m", "-u", head, `${commit}^{tree}`], { cwd, env });
  } finally {
    await rm(tempIndex, { force: true });
  }
  await git(["read-tree", `${indexCommit}^{tree}`], { cwd });
  // The index's stat data is stale after read-tree: refresh it so status is exact.
  await git(["update-index", "-q", "--refresh"], { cwd }).catch(() => undefined);
  return { commit, status: await statusEntries(cwd) };
};
