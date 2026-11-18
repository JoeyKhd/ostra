// git, run as a child process with its arguments as an array: nothing is ever
// spliced into a shell command. Each call gets an explicit environment, so
// the runner's own git config (credential helpers, hooks) never applies.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type GitOptions = {
  readonly cwd: string;
  /** Added to a minimal environment. Never logged. */
  readonly env?: Readonly<Record<string, string>>;
  /** Written to git's stdin. */
  readonly input?: string;
};

export type GitResult = { readonly stdout: string; readonly stderr: string };

const BASE_ENV_NAMES = process.platform === "win32"
  ? ["PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]
  : ["PATH", "HOME", "TMPDIR", "LANG"];

/**
 * Git never looks for a repository above this spike's run folder: the run
 * folder sits inside the ostra checkout, and a command that missed its own
 * repo must fail, not act on ostra's.
 */
const CEILING = path.resolve(import.meta.dirname, "..", "..", ".runs");

/** A git environment from an allowlist, with no global or system config. */
export const gitEnv = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of BASE_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: CEILING,
    GIT_AUTHOR_NAME: "ostra",
    GIT_AUTHOR_EMAIL: "ostra@ostra.invalid",
    GIT_COMMITTER_NAME: "ostra",
    GIT_COMMITTER_EMAIL: "ostra@ostra.invalid",
    ...extra,
  };
};

export const git = async (args: readonly string[], options: GitOptions): Promise<GitResult> => {
  const child = run("git", [...args], {
    cwd: options.cwd,
    env: gitEnv(options.env),
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (options.input !== undefined) {
    child.child.stdin?.end(options.input);
  }
  const { stdout, stderr } = await child;
  return { stdout, stderr };
};

/** `git … | trim`. */
export const gitOut = async (args: readonly string[], options: GitOptions): Promise<string> => (await git(args, options)).stdout.trim();

/** Lines of `git status --porcelain=v1 -z --untracked-files=all`, as `XY path`. */
export const statusEntries = async (cwd: string): Promise<string[]> => {
  const out = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd })).stdout;
  return out.split("\0").filter((entry) => entry !== "");
};
