// A task's workspace: a fresh git checkout of the sample repo on the task's
// branch, and the diff the agent leaves behind (what ostra would push as the PR).

import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { git } from "./exec.ts";

export const SPIKE_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const SAMPLE_REPO = path.join(SPIKE_ROOT, "sample-repo");
export const ACCEPTANCE_DIR = path.join(SPIKE_ROOT, "src", "tickets", "acceptance");
export const TSC_BIN = path.join(SPIKE_ROOT, "node_modules", "typescript", "bin", "tsc");
export const TYPES_ROOT = path.join(SPIKE_ROOT, "node_modules", "@types");

const EXCLUDED = new Set([".git", "node_modules"]);

/** Copies a repo's files, without its history or installed packages. */
export const copyRepo = async (from: string, to: string): Promise<void> => {
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true, filter: (source) => !EXCLUDED.has(path.basename(source)) });
};

export const removeDir = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};

/** Creates the workspace from the sample: a git checkout on the task's branch, the way the agent finds a repository. */
export const initWorkspace = async (workspace: string, branch: string): Promise<void> => {
  await copyRepo(SAMPLE_REPO, workspace);
  await git(workspace, ["init", "-q", "-b", "main"]);
  await git(workspace, ["config", "user.name", "ostra spike"]);
  await git(workspace, ["config", "user.email", "spike@ostra.invalid"]);
  await git(workspace, ["add", "-A"]);
  await git(workspace, ["commit", "-q", "--no-verify", "-m", "calc at the start of the ticket"]);
  await git(workspace, ["checkout", "-q", "-b", branch]);
};

export type DiffSummary = {
  readonly patch: string;
  readonly files: readonly { readonly path: string; readonly insertions: number; readonly deletions: number }[];
  readonly insertions: number;
  readonly deletions: number;
  /** The agent changed something under src/: an "add tests" ticket shouldn't. */
  readonly touchedSource: boolean;
};

const numstatLine = z.tuple([z.string(), z.string(), z.string()]);

/** Parses `git diff --numstat`: tab-separated added, removed, path; `-` for a binary file. */
export const parseNumstat = (text: string): DiffSummary["files"] =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const parsed = numstatLine.safeParse(line.split("\t"));
      if (!parsed.success) return [];
      const [added, removed, file] = parsed.data;
      return [{ path: file, insertions: added === "-" ? 0 : Number(added), deletions: removed === "-" ? 0 : Number(removed) }];
    });

/** Empties a folder except for its `.git`. */
const clearWorkingTree = async (repo: string): Promise<void> => {
  for (const entry of await readdir(repo)) {
    if (entry !== ".git") await rm(path.join(repo, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
};

/**
 * The diff of what the agent left, against the sample it started from: what
 * ostra would commit and push as the pull request.
 *
 * The agent's own repository is never opened. Its `.git` can hold anything
 * (a pre-commit hook, `core.fsmonitor`, a clean filter named in
 * `.git/config` and `.gitattributes`) and git would run it. So the harness
 * makes a repository of its own under `scratch`: the pristine sample as the
 * base commit, then the agent's files (never its `.git`, never
 * `node_modules`) as the next commit, and diffs the two. A commit that fails,
 * or leaves anything uncommitted, throws: the run is then redone, never
 * recorded as a run that changed nothing.
 */
export const collectDiff = async (workspace: string, scratch: string): Promise<DiffSummary> => {
  const repo = path.join(scratch, "diff-repo");
  await removeDir(repo);
  await copyRepo(SAMPLE_REPO, repo);
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.name", "ostra spike"]);
  await git(repo, ["config", "user.email", "spike@ostra.invalid"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "--no-verify", "-m", "calc at the start of the ticket"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim();

  await clearWorkingTree(repo);
  await copyRepo(workspace, repo);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "ostra: the agent's changes"]);
  const dirty = (await git(repo, ["status", "--porcelain"])).split("\n").filter((line) => line !== "");
  if (dirty.length > 0) throw new Error(`the diff checkout still has ${String(dirty.length)} uncommitted paths after its commit`);

  const patch = await git(repo, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, "HEAD"]);
  const files = parseNumstat(await git(repo, ["diff", "--numstat", "--no-ext-diff", "--no-textconv", base, "HEAD"]));
  const touchedSource = (await git(repo, ["diff", "--name-only", "--no-ext-diff", base, "HEAD", "--", "src"])).trim() !== "";
  await removeDir(repo);
  return {
    patch,
    files,
    insertions: files.reduce((sum, f) => sum + f.insertions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    touchedSource,
  };
};

/** Every file under a directory, as paths relative to it (forward slashes). */
export const listFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative);
      else out.push(relative);
    }
  };
  await walk(dir, "");
  return out.sort();
};

export const readText = async (file: string): Promise<string> => readFile(file, "utf8");
export const writeText = async (file: string, text: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};
