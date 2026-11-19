import { access, constants } from "node:fs/promises";
import path from "node:path";
import { runProgram } from "./process.ts";

// Which program runs a task's setup script (Q136, item 9; F-050). The setting is
// `OSTRA_RUNNER_SHELL`, default the bare name `bash`.
//
// - On Linux and macOS, a bare name is looked up on `PATH` when it runs, as always.
// - On Windows, the bare name `bash` means Git for Windows' own bash: Git for Windows puts only
//   `git` on `PATH`, and the `bash` a Windows `PATH` does have is often `System32\bash.exe`, the
//   WSL launcher, which would run the script on another computer. So the executor asks the `git`
//   on `PATH` for its install (`git --exec-path`) and takes that install's `bin\bash.exe`, by its
//   full path. A `bash` on `PATH` that isn't the WSL launcher is the fallback.
// - A full path is used as given, the WSL launcher's included, and so is any other name: someone
//   asked for it.

/** What the resolver needs from the machine, faked in tests. */
export type ShellProbe = {
  readonly platform: NodeJS.Platform;
  /** The environment whose `PATH` (and `PATHEXT`, `SystemRoot`) to read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `git --exec-path`'s answer, or `undefined` when there's no git to ask. */
  readonly gitExecPath: () => Promise<string | undefined>;
  /** Whether a file exists. */
  readonly isFile: (file: string) => Promise<boolean>;
};

export type SetupShell =
  | { readonly kind: "found"; readonly command: string }
  | { readonly kind: "missing"; readonly reason: string };

/** The message the health check gives when there's no setup shell, with its fix. */
export const MISSING_SHELL_REASON_WINDOWS =
  "no setup shell: looked for Git for Windows' bash (bin\\bash.exe under the install of the git on PATH) and for a bash on PATH that isn't WSL's System32\\bash.exe; install Git for Windows, or set OSTRA_RUNNER_SHELL to a shell's full path";

export const missingShellReason = (shell: string): string =>
  `the setup shell (${shell}) isn't on PATH; install it, or set OSTRA_RUNNER_SHELL to a shell's full path`;

const isBareBash = (shell: string): boolean => /^bash(?:\.exe)?$/i.test(shell);

/** The case-insensitive value of an environment variable, as Windows reads it. */
const envValue = (env: ShellProbe["env"], name: string): string | undefined => {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
};

/** Git for Windows' `bin\bash.exe`, from the folder `git --exec-path` names, walking up to its root. */
const gitBash = async (execPath: string, probe: ShellProbe): Promise<string | undefined> => {
  // `C:/Program Files/Git/mingw64/libexec/git-core`: the root is a few folders up.
  let folder = path.win32.normalize(execPath.trim());
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.win32.join(folder, "bin", "bash.exe");
    if (await probe.isFile(candidate)) return candidate;
    const parent = path.win32.dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
  return undefined;
};

/** Every `bash` on a Windows `PATH`, in order. */
const bashesOnPath = async (probe: ShellProbe): Promise<readonly string[]> => {
  const found: string[] = [];
  const dirs = (envValue(probe.env, "PATH") ?? "").split(";").filter((dir) => dir.trim() !== "");
  for (const dir of dirs) {
    const candidate = path.win32.join(dir.trim().replace(/^"|"$/g, ""), "bash.exe");
    if (await probe.isFile(candidate)) found.push(candidate);
  }
  return found;
};

/** Whether a path is Windows' own `System32\bash.exe`, the WSL launcher. */
export const isWslLauncher = (file: string, env: ShellProbe["env"]): boolean => {
  const normalized = path.win32.normalize(file).toLowerCase();
  if (/\\(?:system32|sysnative)\\bash\.exe$/.test(normalized)) return true;
  const root = envValue(env, "SystemRoot") ?? envValue(env, "windir");
  return root !== undefined && normalized === path.win32.join(root, "System32", "bash.exe").toLowerCase();
};

/** The program that runs setup scripts, for the setting `shell` (Q136, item 9). */
export const resolveSetupShell = async (shell: string, probe: ShellProbe): Promise<SetupShell> => {
  if (probe.platform !== "win32" || !isBareBash(shell)) {
    // Linux and macOS: from PATH when it runs. A full path or another name: as given.
    return { kind: "found", command: shell };
  }
  const execPath = await probe.gitExecPath();
  if (execPath !== undefined && execPath.trim() !== "") {
    const fromGit = await gitBash(execPath, probe);
    if (fromGit !== undefined) return { kind: "found", command: fromGit };
  }
  const fallback = (await bashesOnPath(probe)).find((candidate) => !isWslLauncher(candidate, probe.env));
  if (fallback !== undefined) return { kind: "found", command: fallback };
  return { kind: "missing", reason: MISSING_SHELL_REASON_WINDOWS };
};

/** This machine's probe: the real `git`, `PATH` and files. */
export const localShellProbe = (env: Readonly<Record<string, string>>, cwd: string): ShellProbe => ({
  platform: process.platform,
  env,
  gitExecPath: async () => {
    const result = await runProgram("git", ["--exec-path"], { cwd, env });
    return result.code === 0 ? result.stdout.trim() : undefined;
  },
  isFile: async (file) => {
    try {
      await access(file, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
});
