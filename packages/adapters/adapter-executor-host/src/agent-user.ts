import { chmod, chown, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { TASK_UNIT_ENV, markedInPs } from "./containment.ts";
import type { MarkerSweep } from "./containment.ts";
import { runProgram } from "./process.ts";
import type { RunOptions, RunResult } from "./process.ts";
import type { TaskProcesses } from "./task-processes.ts";

// A `host` pool's agent user (ADR 0029 as amended, Q242, F-015, ticket 10). On a pool, the agent
// runs as a separate OS user, never as the runner's own: on Linux and macOS the runner starts every
// process of a task (the agent, its setup script, its checks and the git that makes its worktree)
// through `sudo -n -u <user> --`, with the command as an argument array, never a shell line. The
// admin makes the user and a sudoers rule that lets the runner's user start processes as that user
// and no other (docs/configuration.md):
//
//   ostra-runner ALL=(ostra-agent) NOPASSWD:SETENV: ALL
//   Defaults>ostra-agent umask=0007, umask_override
//
// `SETENV` lets the launch's variables through (`--preserve-env=<names>`, never their values in an
// argument), and the umask keeps what the agent writes in its worktree writable by the group the
// runner shares with it. The runner makes the task's folder and hands it to that group: the agent's
// primary group, which the admin adds the runner's user to; its directories are setgid, so what the
// agent makes inside stays in that group. The runner's own data folder is traversable only, and its
// key and temp folder are its user's alone, so the agent can't read them. `health()` checks that
// `sudo -n -u` works for the agent's user, for no other, that the user can get through to the
// runner's tasks folder, and that it can't read the key.
//
// On Windows a `host` pool runner refuses to start in v1: running a process as another Windows user
// needs that user's password or a service's privileges. `OSTRA_DEV_HOST_POOL_SAME_USER=true` runs a
// pool as the runner's own user for development and tests only, refused when `NODE_ENV` is
// `production`, and the runner says "same user (development only)".
//
// Containment with the separate user: the cgroup on Linux, which the runner kills as a unit whatever
// user its processes run as; the marker sweep otherwise (macOS, Linux without a delegated cgroup),
// over the agent user's processes, listed and ended as that user, since the runner can't signal them.

/** Why a `host` pool runner on Windows doesn't start (ADR 0029, Q242). */
export const HOST_POOL_WINDOWS_REASON = "A host pool runs the agent as a separate OS user, which this release supports on Linux and macOS";

/** Why a `host` pool runner without its agent user doesn't start, with the fix. */
export const HOST_POOL_NO_USER_REASON =
  "A host pool runs the agent as a separate OS user: set OSTRA_HOST_POOL_AGENT_USER (--host-pool-agent-user) to that user, and give this runner's user a sudoers rule for that user alone";

/** Why the development switch is refused. */
export const HOST_POOL_SAME_USER_PRODUCTION_REASON =
  "OSTRA_DEV_HOST_POOL_SAME_USER is for development and tests only, and NODE_ENV is production: a host pool runs the agent as its own OS user (OSTRA_HOST_POOL_AGENT_USER)";

/** What the runner and the panel say of a pool on the development switch. */
export const SAME_USER_DEVELOPMENT = "same user (development only)";

/** The development switch's variable, which the executor checks again (the server checks it too). */
export const SAME_USER_ENV = "OSTRA_DEV_HOST_POOL_SAME_USER";

/** Who a task's processes run as. */
export type AgentUser =
  /** A personal runner: the member's own user, as milestone 1 built it. */
  | { readonly kind: "runner" }
  /** A pool on the development switch: the runner's own user, said so. */
  | { readonly kind: "same-user-development" }
  /** A pool: a separate OS user, through `sudo -n -u`. */
  | { readonly kind: "separate"; readonly user: string };

/** A POSIX-portable user name: no leading dash, so `sudo -u` never reads it as a flag. */
const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/i;

const truthy = (value: string | undefined): boolean => value !== undefined && ["true", "1", "on", "yes"].includes(value.trim().toLowerCase());

export type HostPoolSettings = {
  /** `OSTRA_HOST_POOL_AGENT_USER`. */
  readonly agentUser: string | undefined;
  /** Where `OSTRA_DEV_HOST_POOL_SAME_USER` and `NODE_ENV` are read. */
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** The runner's own user name, which the agent's can't be. */
  readonly runnerUser: string | null;
};

/** Who a `host` pool's tasks run as, or why the pool runner doesn't start. */
export const hostPoolAgentUser = (settings: HostPoolSettings): { readonly ok: true; readonly value: AgentUser } | { readonly ok: false; readonly reason: string } => {
  if (truthy(settings.env[SAME_USER_ENV])) {
    return settings.env["NODE_ENV"] === "production" ? { ok: false, reason: HOST_POOL_SAME_USER_PRODUCTION_REASON } : { ok: true, value: { kind: "same-user-development" } };
  }
  if (settings.platform === "win32") {
    return { ok: false, reason: HOST_POOL_WINDOWS_REASON };
  }
  const user = settings.agentUser?.trim() ?? "";
  if (user === "") {
    return { ok: false, reason: HOST_POOL_NO_USER_REASON };
  }
  if (!USER_NAME.test(user)) {
    return { ok: false, reason: "OSTRA_HOST_POOL_AGENT_USER isn't a user name" };
  }
  if (settings.runnerUser !== null && user === settings.runnerUser) {
    return { ok: false, reason: "OSTRA_HOST_POOL_AGENT_USER names the runner's own user: the agent runs as a separate one" };
  }
  return { ok: true, value: { kind: "separate", user } };
};

/** How `sudo` is started: `/usr/bin/sudo` on Linux and macOS. A test puts a stand-in here. */
export type SudoProgram = { readonly command: string; readonly args: readonly string[] };

export const DEFAULT_SUDO: SudoProgram = { command: "/usr/bin/sudo", args: [] };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `sudo -n -u <user> [--preserve-env=<names>] -- <command> <args...>`: the command and its
 * arguments as they are, each one argument; the environment's names only, its values never in an
 * argument (the process gets them through its environment, which `SETENV` lets through).
 */
export const sudoInvocation = (
  user: string,
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  sudo: SudoProgram = DEFAULT_SUDO,
): { readonly command: string; readonly args: readonly string[] } => {
  const names = Object.keys(env)
    .filter((name) => ENV_NAME.test(name))
    .sort();
  return {
    command: sudo.command,
    args: [...sudo.args, "-n", "-u", user, ...(names.length === 0 ? [] : [`--preserve-env=${names.join(",")}`]), "--", command, ...args],
  };
};

/**
 * The task's processes as the agent's user: every program the executor starts (the agent, the
 * setup script, the checks, git) goes through `sudo -n -u <user> --`, in the task's unit as before.
 */
export const agentUserProcesses = (user: string, inner: TaskProcesses, sudo: SudoProgram = DEFAULT_SUDO): TaskProcesses => ({
  createUnit: inner.createUnit,
  startAgent: (launch, unit) => {
    const invoked = sudoInvocation(user, launch.command, launch.args, launch.env, sudo);
    return inner.startAgent({ ...launch, command: invoked.command, args: [...invoked.args] }, unit);
  },
  run: (command, args, options) => {
    const invoked = sudoInvocation(user, command, args, options.env, sudo);
    return inner.run(invoked.command, invoked.args, options);
  },
});

/** Runs a program to its end: `runProgram`, or a test's stand-in. */
export type RunCommand = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

/** The PIDs a Linux `/proc` listing, run as the agent's user, prints for the marker: one per line. */
const PROC_MARKED_SCRIPT = [
  "const fs = require('node:fs');",
  "const wanted = process.argv[1];",
  "for (const entry of fs.readdirSync('/proc')) {",
  "  if (!/^\\d+$/.test(entry) || Number(entry) === process.pid) continue;",
  "  try { if (fs.readFileSync('/proc/' + entry + '/environ', 'latin1').split('\\u0000').includes(wanted)) console.log(entry); } catch {}",
  "}",
].join("\n");

export type AgentUserSweepOptions = {
  readonly platform?: NodeJS.Platform;
  readonly sudo?: SudoProgram;
  readonly run?: RunCommand;
  /** Node, for the Linux listing. Default: this process's. */
  readonly node?: string;
};

/**
 * The marker sweep over the agent user's processes: listed as that user (its `/proc` on Linux,
 * `ps -wwE` on macOS, both readable only by their owner) and ended as that user with `kill -KILL`,
 * the PIDs as arguments. A few rounds, for a process that forked while it ran.
 */
export const agentUserMarkerSweep = (user: string, options: AgentUserSweepOptions = {}): MarkerSweep => {
  const platform = options.platform ?? process.platform;
  const sudo = options.sudo ?? DEFAULT_SUDO;
  const run = options.run ?? runProgram;
  const node = options.node ?? process.execPath;
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" };
  const asAgent = (command: string, args: readonly string[]): Promise<RunResult> => {
    const invoked = sudoInvocation(user, command, args, {}, sudo);
    return run(invoked.command, invoked.args, { cwd: "/", env, maxBuffer: 64 * 1024 * 1024 });
  };
  const find = async (marker: string): Promise<readonly number[]> => {
    if (platform === "win32") {
      return [];
    }
    if (platform === "linux") {
      const listed = await asAgent(node, ["-e", PROC_MARKED_SCRIPT, `${TASK_UNIT_ENV}=${marker}`]);
      return listed.stdout
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    }
    const listed = await asAgent("ps", ["-wwE", "-U", user, "-o", "pid=,command="]);
    return markedInPs(listed.stdout, marker);
  };
  return async (marker) => {
    let ended = 0;
    for (let round = 0; round < 4; round += 1) {
      const pids = await find(marker);
      if (pids.length === 0) {
        break;
      }
      await asAgent("kill", ["-KILL", ...pids.map(String)]);
      ended += pids.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return ended;
  };
};

/** How a folder is handed over: a test records it; the default changes the group and the modes. */
export type HandOver = (root: string) => Promise<void>;

/**
 * Hands a task's folder to the agent's group (`gid`): every directory setgid and `rwxrws---`, every
 * file `rw-rw----` (`rwxrwx---` when it was executable), the runner keeping its ownership. Links are
 * left as they are. The runner can change a file's group to one it belongs to, so this needs no root.
 */
export const handOverToGroup =
  (gid: number): HandOver =>
  async (root) => {
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    const visit = async (target: string): Promise<void> => {
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        return;
      }
      await chown(target, uid, gid);
      if (info.isDirectory()) {
        await chmod(target, 0o2770);
        for (const entry of await readdir(target)) {
          await visit(path.join(target, entry));
        }
        return;
      }
      await chmod(target, (info.mode & 0o111) === 0 ? 0o660 : 0o770);
    };
    await visit(root);
  };

/** What `health()` checks of the agent's user, each with the words the runner shows. */
export type AgentUserCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * `sudo -n -u` works for the agent's user (a `true` as that user), not for another (`root`), the
 * agent's user can get through to the runner's tasks folder (every folder above it lets it pass), and
 * it can't read the runner's secret paths (its key, its temp folder).
 */
export const checkAgentUser = async (
  user: string,
  secrets: readonly string[],
  options: {
    readonly sudo?: SudoProgram;
    readonly run?: RunCommand;
    readonly cwd: string;
    /** The folder the agent's user must get through to: the runner's `tasks`, which holds each task's folder. */
    readonly reach?: string;
  },
): Promise<AgentUserCheck> => {
  const sudo = options.sudo ?? DEFAULT_SUDO;
  const run = options.run ?? runProgram;
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" };
  const as = (who: string, command: string, args: readonly string[]): Promise<RunResult> => {
    const invoked = sudoInvocation(who, command, args, {}, sudo);
    return run(invoked.command, invoked.args, { cwd: options.cwd, env });
  };
  if ((await as(user, "true", [])).code !== 0) {
    return { ok: false, reason: `sudo -n -u ${user} doesn't work for this runner's user: add the sudoers rule for ${user} (docs/configuration.md)` };
  }
  if ((await as("root", "true", [])).code === 0) {
    return { ok: false, reason: "sudo lets this runner's user act as root: its sudoers rule must name the agent's user alone" };
  }
  // A data folder under a home only its owner may enter (`~/.ostra/runner` on most systems) would
  // fail every clone with git's exit 128: said here, before a task, with the fix.
  if (options.reach !== undefined && (await as(user, "test", ["-x", options.reach])).code !== 0) {
    return {
      ok: false,
      reason: `the agent's user ${user} can't get through to ${options.reach}: let other users through every folder above it (chmod o+x), or set OSTRA_RUNNER_DATA_DIR to a folder such as /var/lib/ostra-runner`,
    };
  }
  for (const secret of secrets) {
    if ((await as(user, "test", ["-r", secret])).code === 0) {
      return { ok: false, reason: `the agent's user ${user} can read the runner's ${path.basename(secret)}: make it the runner's user's alone` };
    }
  }
  return { ok: true };
};
