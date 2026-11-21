import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { globToRegExp, runnerLimits } from "@ostra/protocol";

// Milestone 6 (F-113, ADR 0038): a turn's commit keeps only the task's `commitPaths` (an onboarding
// task's `["AGENTS.md"]`): the other changes stay in the workspace, uncommitted, and the runner
// reports them in `commit.filtered`. Each entry is a repo-relative path or a glob of one (`*` in a
// segment, `**` across segments). `null` means everything, as for every other task.

const run = promisify(execFile);

/** The changed paths a commit keeps, and the ones it leaves. */
export type CommitPathSplit = { readonly kept: readonly string[]; readonly dropped: readonly string[] };

/** Splits changed paths by `commitPaths`: every path when it's `null`. Paths come from git, inside the repo. */
export const splitByCommitPaths = (paths: readonly string[], commitPaths: readonly string[] | null): CommitPathSplit => {
  if (commitPaths === null) {
    return { kept: [...paths], dropped: [] };
  }
  const patterns = commitPaths.map(globToRegExp);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const file of paths) {
    (patterns.some((pattern) => pattern.test(file)) ? kept : dropped).push(file);
  }
  return { kept, dropped };
};

/** What staging kept, as `commit.filtered` carries it: the dropped paths cut to the protocol's limit, with their count. */
export type StagedCommitPaths = { readonly kept: readonly string[]; readonly dropped: readonly string[]; readonly droppedCount: number };

/** The changed paths of `git status --porcelain=v1 -z` output: a rename counts as its new path. */
export const porcelainChangedPaths = (output: string): readonly string[] => {
  const entries = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // A rename or a copy names its old path in the next entry, which isn't a change of its own.
    if (status.startsWith("R") || status.startsWith("C")) index += 1;
  }
  return paths;
};

/** The repo's changed paths, tracked and untracked, from `git status`: a rename counts as its new path. */
export const changedPaths = async (repoDir: string): Promise<readonly string[]> => {
  const { stdout } = await run("git", ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: repoDir,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return porcelainChangedPaths(stdout);
};

/**
 * Stages, in the repo, only the changed paths `commitPaths` keeps, and leaves the rest as they
 * are: unstaged, uncommitted, still in the workspace. The caller commits what's staged.
 */
export const stageCommitPaths = async (repoDir: string, commitPaths: readonly string[] | null): Promise<StagedCommitPaths> => {
  const split = splitByCommitPaths(await changedPaths(repoDir), commitPaths);
  // A pathspec of its own per path, read literally, so a path's own `*` isn't a glob to git.
  for (let start = 0; start < split.kept.length; start += 200) {
    const chunk = split.kept.slice(start, start + 200).map((file) => `:(literal)${file}`);
    await run("git", ["add", "-A", "--", ...chunk], { cwd: repoDir, windowsHide: true });
  }
  return {
    kept: split.kept,
    dropped: split.dropped.slice(0, runnerLimits.commitFilteredPathsMax),
    droppedCount: split.dropped.length,
  };
};
