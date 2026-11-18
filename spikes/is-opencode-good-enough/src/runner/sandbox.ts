// What the harness hands to the processes that run what an agent wrote (its
// tests, the type checker, the command line it changed) and to every git call
// it makes: an allowlisted environment, a scratch HOME, and git set up so that
// nothing in a repository the agent controlled (hooks, filters, a config)
// runs. None of this is a sandbox: the process still runs as the member's own
// account and can read what the account can. It only keeps the harness's own
// secrets (LINEAR_*, GITHUB_*, model keys that happen to be in its shell) out
// of those processes' environment.
//
// Where a run's task folder lives (workspace, home, XDG and temp dirs) is here
// too: outside the spike's folder, so that `cd ..` from the workspace does not
// reach the hidden tests, the reference solutions or the other runs' diffs.

import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** This harness process's own task folders, in the OS temp folder: one per run, deleted when the run ends. */
export const WORK_ROOT = path.join(os.tmpdir(), "ostra-spike-10", `p${String(process.pid)}`);

/** Runner variables a child needs to start at all. None is a secret. */
const PASSTHROUGH =
  process.platform === "win32"
    ? ["PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"]
    : ["PATH", "LANG", "LC_ALL"];

/**
 * A child's whole environment, from an allowlist: the variables above, and a
 * home and temp folder at `home`. The harness's own environment is never
 * inherited. `home` must exist before a process that writes there runs.
 */
export const cleanEnv = (home: string): Record<string, string> => {
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of PASSTHROUGH) {
    const value = process.env[name];
    // Windows names are case-insensitive: `PATH` and `Path` are one variable.
    if (value === undefined || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    env[name] = value;
  }
  return { ...env, HOME: home, USERPROFILE: home, TMP: home, TEMP: home, TMPDIR: home };
};

/** The environment for a harness-run tool (the typecheck, `git --version`): the allowlist, with a scratch home that exists. */
export const hostToolEnv = async (): Promise<Record<string, string>> => {
  const home = path.join(WORK_ROOT, "tool-home");
  await mkdir(home, { recursive: true });
  return cleanEnv(home);
};

type GitSandbox = { readonly hooksDir: string; readonly globalConfig: string; readonly home: string };

let sandbox: Promise<GitSandbox> | undefined;

const prepareGitSandbox = async (): Promise<GitSandbox> => {
  const base = path.join(WORK_ROOT, "git");
  const found: GitSandbox = { hooksDir: path.join(base, "no-hooks"), globalConfig: path.join(base, "empty-gitconfig"), home: path.join(base, "home") };
  await mkdir(found.hooksDir, { recursive: true });
  await mkdir(found.home, { recursive: true });
  await writeFile(found.globalConfig, "");
  return found;
};

const gitSandbox = async (): Promise<GitSandbox> => {
  sandbox ??= prepareGitSandbox();
  return sandbox;
};

const forward = (file: string): string => file.replaceAll("\\", "/");

/**
 * How every git call of the harness runs: no hooks (an empty hooks folder), no
 * fsmonitor, no signing, no global or system config, no prompt, and an
 * allowlisted environment. A repository the agent worked in is still never
 * opened by the harness for the diff (see `collectDiff`): this is the second
 * line, for the calls on repositories the harness made itself.
 */
export const gitInvocation = async (): Promise<{ readonly flags: readonly string[]; readonly env: Record<string, string> }> => {
  const found = await gitSandbox();
  return {
    flags: ["-c", `core.hooksPath=${forward(found.hooksDir)}`, "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", "core.quotepath=false", "-c", "core.autocrlf=false"],
    env: { ...cleanEnv(found.home), GIT_CONFIG_GLOBAL: found.globalConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  };
};

/** Deletes this process's folder in the OS temp folder, and forgets the git set-up that lived in it. */
export const cleanWorkRoot = async (): Promise<void> => {
  sandbox = undefined;
  await rm(WORK_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};
