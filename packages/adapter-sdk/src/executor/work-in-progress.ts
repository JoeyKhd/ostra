import { execFile } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
import path from "node:path";

import { gitShaSchema } from "@ostra/protocol";
import type { GitPerson, GitSha, TaskId } from "@ostra/protocol";

import { adapterError, ok } from "../common/result.ts";
import type { AdapterResult } from "../common/result.ts";
import { porcelainChangedPaths, splitByCommitPaths } from "./commit-paths.ts";

// The hidden ref (ADR 0039, Q150; spec section 4, "After every turn"). Ported from
// spikes/can-a-session-move-to-a-fresh-box/src/lib/hidden-ref.ts, with ADR 0039's rule for a
// branch that moved: restore onto the commit the work was saved on, then merge the branch's new
// commits in; on a conflict, restore nothing and leave the branch's head checked out.
//
// After every turn each repo's working tree (uncommitted and untracked files included, ignored
// ones not) is written as a commit outside the task's branches and force-pushed to
// `refs/ostra/wip/<taskId>`. The commit has a `git stash` commit's shape, so the staged state
// comes back too:
//   wip    tree = the working tree, as `git add -A` sees it; parent 1 = HEAD, parent 2 = the index commit
//   index  tree = the index; parent = HEAD
// Nothing touches the real index, HEAD or a branch while saving: the tree is read into a temporary
// index file.
//
// Executors run git their own way (on the machine, or in a container), so this takes a `WipGit`
// bound to one checkout, and `WipFiles` for the temporary index. Every call is an argument array;
// nothing is spliced into a shell.

/** git, run in one checkout. `env` is added to the executor's own git environment. */
export type WipGit = (args: readonly string[], env?: Readonly<Record<string, string>>) => Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}>;

/** File operations where the checkout is, for git's temporary index. Paths are absolute. */
export type WipFiles = {
  /** `false` when `from` doesn't exist. */
  readonly copy: (from: string, to: string) => Promise<boolean>;
  readonly remove: (file: string) => Promise<void>;
};

export type WipDeps = { readonly git: WipGit; readonly files: WipFiles };

/** The task's hidden ref. */
export const hiddenRefFor = (taskId: TaskId): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || taskId.includes("..") || taskId.endsWith(".lock")) {
    throw new Error("hiddenRefFor: a task ID that can't name a ref");
  }
  return `refs/ostra/wip/${taskId}`;
};

/** Who the hidden ref's commits are made by: never pushed to a branch, so ostra's own name. */
const WIP_IDENTITY: GitPerson = { name: "ostra", email: "ostra@users.noreply.invalid" };

const identityEnv = (person: GitPerson): Readonly<Record<string, string>> => ({
  GIT_AUTHOR_NAME: person.name,
  GIT_AUTHOR_EMAIL: person.email,
  GIT_COMMITTER_NAME: person.name,
  GIT_COMMITTER_EMAIL: person.email,
});

type Run = (args: readonly string[], env?: Readonly<Record<string, string>>) => Promise<string>;

class WipFailure extends Error {}

const PUSH_REJECTED = /! \[(?:remote rejected|rejected)\][^(\n]*\(([^)\n]{1,200})\)/;

/**
 * Why git refused a push, from its own `! [rejected] <ref> (<reason>)` line: the reason only, such
 * as `stale info` or `fetch first`, which names no path and no URL. Any other line of git's
 * output can hold the proxy's address, whose path is a secret, so nothing else is kept. `null`
 * when git named no reason.
 */
export const pushRefusalReason = (output: string): string | null => {
  const reason = PUSH_REJECTED.exec(output)?.[1]?.trim();
  return reason === undefined || reason === "" || reason.includes("://") ? null : reason;
};

/** git that throws `WipFailure` with the step's name (never git's output, which can hold paths). */
const runner = (git: WipGit): Run => async (args, env) => {
  const result = await git(args, env);
  if (result.code !== 0) {
    const reason = args[0] === "push" ? pushRefusalReason(`${result.stdout}\n${result.stderr}`) : null;
    throw new WipFailure(`git ${args[0] ?? ""} failed (exit ${String(result.code)}${reason === null ? "" : `: ${reason}`})`);
  }
  return result.stdout.trim();
};

const shaOf = (text: string): GitSha => {
  const parsed = gitShaSchema.safeParse(text);
  if (!parsed.success) throw new WipFailure("git answered something that isn't a SHA");
  return parsed.data;
};

export type SaveWipInput = {
  readonly taskId: TaskId;
  /** The turn this save follows, for the commit's message. */
  readonly turnOrdinal: number;
  /** The remote to force-push to: the git proxy's `origin`. */
  readonly remote: string;
  /**
   * F-113 (ADR 0038, amended 2026-11-21): the spec's `commitPaths`. With them, the saved work keeps
   * only those paths' changes and nothing staged, so the hidden ref carries only what the task may
   * push, and the git proxy takes it. `null` or absent: the whole working tree, as for every other task.
   */
  readonly commitPaths?: readonly string[] | null;
};

export type SavedWip = {
  /** The commit the hidden ref points at. */
  readonly sha: GitSha;
  /** The branch head it was saved on. */
  readonly baseSha: GitSha;
  /** The working tree and index matched HEAD: a turn whose work was all committed. */
  readonly clean: boolean;
};

/**
 * Saves the checkout's working tree to the task's hidden ref, by a forced push with `--no-verify`.
 * A checkout with no commit has nothing to save: `null`.
 */
export const saveWorkInProgressIn = async (deps: WipDeps, input: SaveWipInput): Promise<AdapterResult<SavedWip | null>> => {
  const git = runner(deps.git);
  const ref = hiddenRefFor(input.taskId);
  const env = identityEnv(WIP_IDENTITY);
  let tempIndex: string | undefined;
  try {
    const headResult = await deps.git(["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (headResult.code !== 0) {
      return ok(null);
    }
    const head = shaOf(headResult.stdout.trim());
    const status = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
    const commitPaths = input.commitPaths ?? null;
    // With `commitPaths`, the index commit is HEAD's tree: nothing staged is saved.
    const indexTree = commitPaths === null ? await git(["write-tree"]) : await git(["rev-parse", `${head}^{tree}`]);
    const indexCommit = await git(["commit-tree", indexTree, "-p", head, "-m", `ostra: the index of ${input.taskId} after turn ${String(input.turnOrdinal)}`], env);
    const gitDir = await git(["rev-parse", "--absolute-git-dir"]);
    const realIndex = path.join(gitDir, "index");
    tempIndex = `${realIndex}.ostra-wip`;
    const temp = { GIT_INDEX_FILE: tempIndex };
    if (commitPaths === null) {
      // From the real index, so `add -A` sees what was staged; a repo without one starts from HEAD.
      if (!(await deps.files.copy(realIndex, tempIndex))) {
        await git(["read-tree", head], temp);
      }
      await git(["add", "-A"], temp);
    } else {
      // F-113: HEAD's tree, and only the allowed paths' changes from the working tree.
      await git(["read-tree", head], temp);
      const changed = await deps.git(["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      if (changed.code !== 0) {
        throw new WipFailure(`git status failed (exit ${String(changed.code)})`);
      }
      const kept = splitByCommitPaths(porcelainChangedPaths(changed.stdout), commitPaths).kept;
      for (let start = 0; start < kept.length; start += 200) {
        // A pathspec of its own per path, read literally, so a path's own `*` isn't a glob to git.
        await git(["add", "-A", "--", ...kept.slice(start, start + 200).map((file) => `:(literal)${file}`)], temp);
      }
    }
    const tree = await git(["write-tree"], temp);
    const commit = shaOf(
      await git(["commit-tree", tree, "-p", head, "-p", indexCommit, "-m", `ostra: work in progress of ${input.taskId} after turn ${String(input.turnOrdinal)}`], env),
    );
    await git(["push", "--quiet", "--no-verify", input.remote, `+${commit}:${ref}`]);
    return ok({ sha: commit, baseSha: head, clean: status === "" });
  } catch (error) {
    return adapterError("unavailable", error instanceof WipFailure ? `saving the hidden ref: ${error.message}` : "saving the hidden ref failed");
  } finally {
    if (tempIndex !== undefined) await deps.files.remove(tempIndex);
  }
};

export type RestoreWipInput = {
  readonly taskId: TaskId;
  readonly remote: string;
  /** The branch the checkout is on: a moved branch's work is merged onto it. */
  readonly branch: string;
};

export type RestoredWip =
  | { readonly outcome: "applied"; readonly sha: GitSha; readonly baseSha: GitSha; readonly merged: boolean }
  /**
   * The remote has no hidden ref for the task, or one that holds nothing the branch doesn't: a plain
   * commit the branch already has, which a box lost before its save left (`restoreWorkInProgressIn`).
   */
  | { readonly outcome: "none" }
  /** The branch's new commits conflict with the work: nothing restored, the branch's head checked out. */
  | { readonly outcome: "conflict"; readonly sha: GitSha; readonly baseSha: GitSha };

/** A commit's parents, in order. */
const parentsOf = async (git: Run, sha: GitSha): Promise<GitSha[]> => (await git(["rev-list", "--parents", "-n", "1", sha])).split(" ").slice(1).map(shaOf);

/** Lays the work-in-progress commit's tree over a clean checkout at its first parent, then its index. */
const applyOnto = async (git: Run, deps: WipDeps, base: GitSha, wip: GitSha, indexCommit: GitSha): Promise<void> => {
  const gitDir = await git(["rev-parse", "--absolute-git-dir"]);
  const realIndex = path.join(gitDir, "index");
  const tempIndex = `${realIndex}.ostra-restore`;
  try {
    const temp = { GIT_INDEX_FILE: tempIndex };
    // A fresh clone's index matches HEAD and has stat data, so the two-tree merge sees a clean tree.
    if (!(await deps.files.copy(realIndex, tempIndex))) {
      await git(["read-tree", base], temp);
    }
    await deps.git(["update-index", "-q", "--refresh"], temp);
    await git(["read-tree", "-m", "-u", base, `${wip}^{tree}`], temp);
  } finally {
    await deps.files.remove(tempIndex);
  }
  await git(["read-tree", `${indexCommit}^{tree}`]);
  // The index's stat data is stale after read-tree: refresh it, so status is exact.
  await deps.git(["update-index", "-q", "--refresh"]);
};

/**
 * Restores the task's hidden ref into a clean checkout of the task's branch (ADR 0039, Q150). On
 * the commit it was saved on, the work comes back as it was, staged files staged. On a branch that
 * moved since, the work is restored onto its own commit and the branch's new commits merged in;
 * it comes back unstaged. A conflict leaves the branch's head checked out and restores nothing.
 */
export const restoreWorkInProgressIn = async (deps: WipDeps, input: RestoreWipInput): Promise<AdapterResult<RestoredWip>> => {
  const git = runner(deps.git);
  const ref = hiddenRefFor(input.taskId);
  const env = identityEnv(WIP_IDENTITY);
  try {
    const listed = await git(["ls-remote", input.remote, ref]);
    if (listed === "") {
      return ok({ outcome: "none" });
    }
    await git(["fetch", "--quiet", "--no-tags", input.remote, `+${ref}:${ref}`]);
    const sha = shaOf(await git(["rev-parse", ref]));
    const [base, indexCommit, ...more] = await parentsOf(git, sha);
    const head = shaOf(await git(["rev-parse", "HEAD"]));
    // A work-in-progress commit has two parents: the head it was saved on, and the index commit made on that head.
    if (base === undefined || indexCommit === undefined || more.length > 0 || (await parentsOf(git, indexCommit)).join(" ") !== base) {
      // Any other commit is a branch head with nothing unsaved beside it. The after-turn push points the
      // ref at the branch's head, and the save then writes its work-in-progress commit over it, so a box
      // lost between the two leaves the head there (as a milestone 1 runner's stop push does). A branch
      // that holds that commit has nothing to restore; one that doesn't any more has lost it.
      const held = sha === head || (await deps.git(["merge-base", "--is-ancestor", sha, head])).code === 0;
      return ok(held ? { outcome: "none" } : { outcome: "conflict", sha, baseSha: sha });
    }
    if (head === base) {
      await applyOnto(git, deps, base, sha, indexCommit);
      return ok({ outcome: "applied", sha, baseSha: base, merged: false });
    }
    // The branch moved. Only a branch that grew from the saved commit can take the work.
    const grew = await deps.git(["merge-base", "--is-ancestor", base, head]);
    if (grew.code !== 0) {
      return ok({ outcome: "conflict", sha, baseSha: base });
    }
    await git(["checkout", "--quiet", "--detach", base]);
    await applyOnto(git, deps, base, sha, indexCommit);
    await git(["add", "-A"]);
    await git(["commit", "--quiet", "--no-verify", "--allow-empty", "-m", "ostra: restored work in progress"], env);
    const merged = await deps.git(["merge", "--quiet", "--no-edit", "--no-verify", "--no-ff", head], env);
    if (merged.code !== 0) {
      await deps.git(["merge", "--abort"]);
      await git(["checkout", "--quiet", "--force", input.branch]);
      await git(["clean", "-fdq"]);
      return ok({ outcome: "conflict", sha, baseSha: base });
    }
    // Back on the branch at its head, with the merged tree as the working tree: the work, unstaged.
    await git(["symbolic-ref", "HEAD", `refs/heads/${input.branch}`]);
    await git(["reset", "--quiet", head]);
    return ok({ outcome: "applied", sha, baseSha: base, merged: true });
  } catch (error) {
    return adapterError("unavailable", error instanceof WipFailure ? `restoring the hidden ref: ${error.message}` : "restoring the hidden ref failed");
  }
};

// ---------- on this machine ----------

/** A `WipGit` for a checkout on this machine (the `host` executor and tests). `env` is the whole environment. */
export const localWipGit =
  (cwd: string, env: Readonly<Record<string, string>>): WipGit =>
  (args, extra) =>
    new Promise((resolve) => {
      execFile("git", [...args], { cwd, env: { ...env, ...extra }, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof Reflect.get(error, "code") === "number" ? Number(Reflect.get(error, "code")) : null;
        resolve({ code, stdout, stderr });
      });
    });

/** `WipFiles` on this machine. */
export const localWipFiles: WipFiles = {
  copy: async (from, to) => {
    try {
      await copyFile(from, to);
      return true;
    } catch {
      return false;
    }
  },
  remove: async (file) => {
    await rm(file, { force: true });
  },
};
