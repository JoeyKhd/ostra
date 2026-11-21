import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  adapterError,
  browserChannel,
  ExecutorAdapter,
  identifyBrowser,
  localWipFiles,
  ok,
  openAppLog,
  restoreWorkInProgressIn,
  runChecksWith,
  saveWorkInProgressIn,
  splitByCommitPaths,
} from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterResult,
  AgentCommandResult,
  AgentLaunch,
  AgentProcess,
  AppProcessHandle,
  BoxRef,
  BrowserChannel,
  BrowserStart,
  StartAppProcessInput,
  StopAppProcessInput,
  CheckRunResult,
  CommitAndPushInput,
  CommittedRepoWork,
  CommitWorkInput,
  CreateBoxInput,
  CreatedBox,
  ExecutorCapabilities,
  HealthReport,
  PrepareCacheInput,
  PreparedCache,
  PrepareInput,
  PrepareResult,
  ProcessExit,
  ServiceHealth,
  RepoPushResult,
  RestoredRepoWork,
  RestoreWorkInProgressInput,
  RunAgentCommandInput,
  RunChecksInput,
  RunOneCheck,
  SavedRepoWork,
  SaveWorkInProgressInput,
  StagedCommitPaths,
  StopInput,
  TaskProxies,
  WipDeps,
} from "@ostra/adapter-sdk";
import { appLogPath, gitShaSchema, repoBranchName, repoGitIdentity, runnerLimits, SETUP_OUTPUT_MAX_CHARS } from "@ostra/protocol";
import type { BoxReleaseReason, BoxState, GitPerson, ProjectId, RepoId, RepoSecret, TaskId, TaskSpec, TaskSpecReviewRepo } from "@ostra/protocol";
import { cgroupPrefix, detectContainment, newUnitMarker, processTreeContainment, sweepLeftovers, TASK_UNIT_ENV } from "./containment.ts";
import {
  agentUserMarkerSweep,
  agentUserProcesses,
  checkAgentUser,
  handOverToGroup,
  hostPoolAgentUser,
  SAME_USER_DEVELOPMENT,
} from "./agent-user.ts";
import type { AgentUser, HandOver, SudoProgram } from "./agent-user.ts";
import { localProcesses } from "./task-processes.ts";
import type { BrowserProgram, TaskProcesses } from "./task-processes.ts";
import type { BrowserResolution } from "./machine-browser.ts";
import type { Containment, ContainmentProbe, ContainmentUnit } from "./containment.ts";
import { excludeFromGit, insideCheckout, renderEnvFile, writeCheckoutFile } from "./env-file.ts";
import { baseEnv, codeHostRefusal, ostraLines, runProgram } from "./process.ts";
import { localShellProbe, missingShellReason, resolveSetupShell } from "./setup-shell.ts";
import type { SetupShell, ShellProbe } from "./setup-shell.ts";
import type { RunResult } from "./process.ts";

// The `host` executor (ADR 0029, F-016, F-014): a task runs in a folder of the runner's machine,
// with every repo of its project checked out side by side, through the git proxy. It's "personal,
// not isolated": the agent runs as the member, so it can read what they can. What the executor
// guarantees is that the agent's process gets only its launch's environment (the fake key and the
// proxy URLs, never a credential), that git talks to the proxy only (an `insteadOf` rule local to
// the task, never the member's own config), and that stopping a task ends the agent's whole
// process tree.
//
//   <dataDir>/tasks/<taskId>/
//     workspace/<checkoutDir>/   the repos, side by side: the agent's reach
//     agent/                     the agent's own config, data and cache
//     git/config                 the task's git config: identity, insteadOf, no credential helper
//     setup/setup.sh             the environment's setup script
//     unit-marker                the task's containment marker, so a restarted runner finds its processes
//   <dataDir>/cache/<projectId>/   milestone 3's host cache (F-051, ADR 0038 as amended, Q185)
//     <repoId>.git               a bare mirror of each repo, fetched through the git proxy
//     deps/                      the dependency cache the setup's package managers point into
//     cache-key, last-used       the spec's key, and when a task last used it
//
// Its differences from `docker` are ADR 0029's allowed ones, declared in `capabilities`: no
// isolation, no services, no box sizes, a host cache instead of a snapshot image, and process
// containment by the tree (or a cgroup on Linux, or a Windows job object) instead of a container.
// The task's unit is made with its folder; the setup script, the agent and the checks join it, and
// it ends at stop and release (ticket 42).
//
// Milestone 5 (ticket 10): a `host` pool runs the agent as a separate OS user (`agent-user.ts`):
// every process of a task goes through `sudo -n -u <user> --`, the task's folder is handed to that
// user's group when it's made, and `health()` checks the sudoers rule and that the user can't read
// the runner's key. A pool on the development switch runs as the runner's own user and says so.

export type HostExecutorOptions = {
  /** The runner's data folder: task roots go in `tasks/`. */
  readonly dataDir: string;
  /**
   * The shell setup scripts run with (`OSTRA_RUNNER_SHELL`, default `bash`): from PATH on Linux and
   * macOS, and for the bare name on Windows, Git for Windows' own bash (`setup-shell.ts`).
   */
  readonly shell?: string;
  /** How the bare name `bash` is found. Default: this machine, unless `processes` is another one. */
  readonly shellProbe?: ShellProbe;
  /** How a task's processes end together. Default: detected (a cgroup on Linux when allowed). */
  readonly containment?: Containment;
  /** Where the agent and the setup script run (spike 3's `AgentHost` seam). Default: this machine. */
  readonly processes?: TaskProcesses;
  /** What the executor declares about containment, when `processes` isn't this machine's. */
  readonly processContainment?: ExecutorCapabilities["processContainment"];
  /** Where the base environment's variables come from. Default: this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** How long a project's host cache stays without a task using it (F-051). Default: 30 days. */
  readonly cacheIdleDays?: number;
  /**
   * A `docker` box's sidecar runs this executor on the task volume, and declares its box's own:
   * services, and a snapshot image (ticket 14). Default: `host`'s (no services, the host cache).
   */
  readonly boxCapabilities?: Pick<ExecutorCapabilities, "services" | "snapshots">;
  /**
   * Milestone 3 (F-094), in a `docker` box: each of the spec's services' health, which the pool
   * runner reports once each is healthy or failed. `prepare` waits for it before the setup script.
   */
  readonly awaitServices?: (spec: TaskSpec, signal: AbortSignal | undefined) => Promise<readonly ServiceHealth[]>;
  /** Milestone 5 (ticket 10): who a task's processes run as. Default: the runner's own user (a personal runner). */
  readonly agentUser?: HostAgentUserOptions;
  /**
   * Milestone 8 (ADR 0068, F-121): the machine's browser, which each box starts in its unit with a
   * fresh profile. Ticket 11 finds it (`resolveMachineBrowser`: `OSTRA_RUNNER_BROWSER`, Chrome,
   * Chromium, Edge, or the pinned download), as a source a box asks when it wants one, which gives
   * the reason when there's none. Absent or `null`: a box has no browser (`not-found`). Ignored with
   * `processes`, which starts its own.
   */
  readonly browser?: BrowserProgram | null | (() => Promise<BrowserResolution>);
};

/** Milestone 8 (F-140): one of the app's processes in a box, its log open until it exits. */
type RunningApp = {
  readonly handle: AppProcessHandle;
  readonly stop: (graceMs: number) => Promise<void>;
};

/** A pool's agent user, as the executor runs it (`HostExecutor.startPool` makes it). */
export type HostAgentUserOptions = {
  readonly user: AgentUser;
  /** How `sudo` starts. Default: `/usr/bin/sudo`. */
  readonly sudo?: SudoProgram;
  /** How a task's folder is handed to a separate user. Default: nothing (`startPool` gives the agent's group). */
  readonly handOver?: HandOver;
  /** What the agent's user must not read, which `health()` checks: the runner's key, its temp folder. */
  readonly secrets?: readonly string[];
};

/** `HostExecutor.startPool`'s settings, besides the executor's own. */
export type HostPoolOptions = {
  /** `OSTRA_HOST_POOL_AGENT_USER`. */
  readonly agentUser: string | undefined;
  /** What the agent's user must not read: the runner's key, its temp folder. */
  readonly secrets?: readonly string[];
  readonly sudo?: SudoProgram;
  /** For tests: the system and the runner's user name. Default: this machine's. */
  readonly platform?: NodeJS.Platform;
  readonly runnerUser?: string | null;
  /** For tests: the agent group's ID, instead of `id -g <user>`. */
  readonly agentGid?: number;
};

/**
 * Where a `docker` box's task volume holds a snapshot's checkouts (F-051, Q153), from the image
 * that filled it: `<dataDir>/snapshot/workspace/<checkoutDir>`, and the snapshot's ID in
 * `<dataDir>/snapshot/snapshot-id` (the docker executor's Dockerfile writes both).
 */
export const SNAPSHOT_FOLDER = "snapshot";

/** A project's host cache stays this long without a task (F-051, working value). */
export const CACHE_IDLE_DAYS = 30;

/** How often a running executor looks for idle caches, besides at start. */
const SWEEP_EVERY_MS = 60 * 60_000;

/** Why a `host` runner refuses a spec with services: the words ostra shows (ADR 0029, F-094). */
export const HOST_SERVICES_REASON = "the `host` executor starts no services";

/**
 * The package managers' cache variables, each pointed into the project's dependency cache (F-051),
 * so the setup's install is warm from the second task on. `CARGO_HOME` holds cargo's registry.
 */
export const dependencyCacheEnv = (dir: string): Readonly<Record<string, string>> => ({
  OSTRA_DEPENDENCY_CACHE: dir,
  npm_config_cache: path.join(dir, "npm"),
  PNPM_STORE_DIR: path.join(dir, "pnpm-store"),
  YARN_CACHE_FOLDER: path.join(dir, "yarn"),
  PIP_CACHE_DIR: path.join(dir, "pip"),
  GOMODCACHE: path.join(dir, "go-mod"),
  CARGO_HOME: path.join(dir, "cargo"),
});

type RunningAgent = {
  readonly pid: number | null;
  readonly exited: Promise<ProcessExit>;
  readonly stdinEnd: () => void;
};

/** The file in a task's folder that keeps its unit's marker. */
const UNIT_MARKER_FILE = "unit-marker";

type BoxRecord = {
  readonly ref: BoxRef;
  state: BoxState;
  readonly root: string;
  readonly workspaceDir: string;
  readonly agentDir: string;
  readonly gitConfig: string;
  /** The session's spec and proxies: a resumed box takes the next session's (ticket 24). */
  spec: TaskSpec;
  proxies: TaskProxies;
  /** Every process of the task, as one unit (ticket 42). Made with the folder. */
  unit: ContainmentUnit | undefined;
  agent: RunningAgent | undefined;
  /** Each repo's head when the box got ready or at the last `commitWork`: a turn changed a repo when it moved (Q188). */
  readonly turnBase: Map<RepoId, string>;
  /** Milestone 8: the app's processes running, by name, and the browsers open; they end with the box. */
  readonly apps: Map<string, RunningApp>;
  readonly browsers: Set<BrowserChannel>;
};

/** A project's cache folder: its ID, with anything odd replaced. */
const projectFolder = (projectId: ProjectId): string => projectId.replace(/[^A-Za-z0-9._-]/g, "_");

const boxKey = (box: BoxRef): string => `${box.taskId}\u0000${box.boxId}`;

/** ostra's own folder in a checkout or the workspace: the ticket's files go in its `ticket/` (ticket 26). */
const OSTRA_DIR = ".ostra";

/** The most of an agent command's output kept: it can hold content, so it's never logged. */
const AGENT_COMMAND_OUTPUT_MAX = 64 * 1024;

/** A folder name for a task's root: its ID, with anything odd replaced. */
const folderOf = (taskId: TaskId): string => taskId.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * The changed paths of `git status --porcelain=v1 -z`, tracked and untracked: a rename counts as its
 * new path, and its old one, the next entry, isn't a change of its own.
 */
export const porcelainZPaths = (output: string): readonly string[] => {
  const entries = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) {
      continue;
    }
    paths.push(entry.slice(3));
    if (entry.startsWith("R") || entry.startsWith("C")) {
      index += 1;
    }
  }
  return paths;
};

/** Milestone 6 (F-100): a review task's checkout of the repo, from the spec's `review`, or `null`. */
export const reviewRepoOf = (spec: Pick<TaskSpec, "review">, repoId: RepoId): TaskSpecReviewRepo | null =>
  spec.review?.repos.find((repo) => repo.repoId === repoId) ?? null;

/** A `Co-authored-by` trailer, as git and GitHub read it. */
export const coAuthorTrailer = (person: GitPerson): string => `Co-authored-by: ${person.name} <${person.email}>`;

/** A bot as the author and committer of ostra's own commits: the environment outranks any config. */
const identityEnv = (person: GitPerson): Readonly<Record<string, string>> => ({
  GIT_AUTHOR_NAME: person.name,
  GIT_AUTHOR_EMAIL: person.email,
  GIT_COMMITTER_NAME: person.name,
  GIT_COMMITTER_EMAIL: person.email,
});

/**
 * A bot as a git config's identity. `author.*` and `committer.*` outrank `user.*` wherever each is
 * set, so an agent's `git -c user.name=...` doesn't take a repo's commits from its bot.
 */
const identitySettings = (person: GitPerson): readonly (readonly [string, string])[] => [
  ["user.name", person.name],
  ["user.email", person.email],
  ["author.name", person.name],
  ["author.email", person.email],
  ["committer.name", person.name],
  ["committer.email", person.email],
];

/** The commit message with its trailers, one per co-author. */
export const commitMessageWithTrailers = (message: string, coAuthors: readonly GitPerson[]): string => {
  const body = message.trim().length === 0 ? "ostra: work in progress" : message.trim();
  return coAuthors.length === 0 ? `${body}\n` : `${body}\n\n${coAuthors.map(coAuthorTrailer).join("\n")}\n`;
};

// Every commit in the task's repos gets the co-authors' trailers, the agent's own commits too
// (F-078). The trailers come from a file, never from this script's text, so a name can't run code.
const PREPARE_COMMIT_MSG_HOOK = `#!/bin/sh
# Written by ostra: adds the task's Co-authored-by trailers to every commit (F-078).
trailers="$(git rev-parse --git-dir)/ostra-trailers"
[ -f "$trailers" ] || exit 0
while IFS= read -r trailer; do
  [ -n "$trailer" ] && git interpret-trailers --in-place --if-exists addIfDifferent --trailer "$trailer" "$1"
done < "$trailers"
exit 0
`;

/**
 * Settings on every checkout git command, which beat the checkout's own config: no filesystem
 * monitor (a repo-local `core.fsmonitor` runs a program), no `ext::` transport, no ssh command. Not
 * `core.hooksPath`: the `prepare-commit-msg` hook below is how every commit gets its trailers. And
 * `core.longpaths`, on: Windows stops git at 260 characters otherwise, and a long data folder or a deep
 * file in a repo fails a clone with "Filename too long" and a checkout with "cannot lock ref".
 */
const GIT_HARDENING = ["-c", "core.fsmonitor=false", "-c", "core.sshCommand=", "-c", "protocol.ext.allow=never", "-c", "core.longpaths=true"] as const;

/** Setup output split so no piece passes the event's cap. */
const splitOutput = (text: string): readonly string[] => {
  const pieces: string[] = [];
  for (let index = 0; index < text.length; index += SETUP_OUTPUT_MAX_CHARS) {
    pieces.push(text.slice(index, index + SETUP_OUTPUT_MAX_CHARS));
  }
  return pieces;
};

/** The markers kept in the task folders a run of this runner left. */
const keptMarkers = async (dataDir: string): Promise<readonly string[]> => {
  const tasks = path.join(dataDir, "tasks");
  const folders = await readdir(tasks).catch((): string[] => []);
  const markers: string[] = [];
  for (const folder of folders) {
    const marker = (await readFile(path.join(tasks, folder, UNIT_MARKER_FILE), "utf8").catch(() => "")).trim();
    if (/^ostra-unit-[0-9a-f]{24}$/.test(marker)) {
      markers.push(marker);
    }
  }
  return markers;
};

/** A failure's code (EBUSY, EPERM) or its name: never its message, which can hold a path. */
const errorCode = (error: unknown): string => {
  const code: unknown = Reflect.get(Object(error), "code");
  return typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
};

export class HostExecutor extends ExecutorAdapter {
  readonly name = "host";
  readonly capabilities: ExecutorCapabilities;

  readonly #dataDir: string;
  readonly #shell: string;
  readonly #shellProbe: ShellProbe | undefined;
  #setupShell: Promise<SetupShell> | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #boxes = new Map<string, BoxRecord>();
  #containment: Containment | undefined;
  readonly #processes: TaskProcesses;
  #lfs: boolean | undefined;
  readonly #cacheIdleMs: number;
  readonly #awaitServices: HostExecutorOptions["awaitServices"];
  readonly #agentUser: HostAgentUserOptions;
  /** One cache update per project at a time: two tasks of a project never fetch one mirror together. */
  readonly #cacheLocks = new Map<string, Promise<unknown>>();
  /** When the idle caches were last swept: at start, then at most hourly as boxes use a cache. */
  #lastSweep = 0;

  /** Use `HostExecutor.start` to get the containment this machine allows; this constructor uses the one given. */
  constructor(options: HostExecutorOptions, context?: AdapterContext) {
    super(context);
    this.#dataDir = options.dataDir;
    this.#shell = options.shell ?? "bash";
    this.#env = options.env ?? process.env;
    this.#shellProbe =
      options.shellProbe ?? (options.processes === undefined ? localShellProbe(baseEnv(this.#env), this.#dataDir) : undefined);
    this.#containment = options.containment;
    const browser = options.browser ?? null;
    const processes =
      options.processes ??
      localProcesses(
        () => {
          this.#containment ??= processTreeContainment();
          return this.#containment;
        },
        typeof browser === "function"
          ? browser
          : () =>
              Promise.resolve(
                browser === null
                  ? { available: false, reason: "not-found", detail: "this runner names no browser" }
                  : { available: true, program: browser, source: "setting" },
              ),
      );
    this.#agentUser = options.agentUser ?? { user: { kind: "runner" } };
    const agentUser = this.#agentUser.user;
    // Milestone 5 (ticket 10): on a pool, every process of the task as the agent's user.
    this.#processes = agentUser.kind === "separate" ? agentUserProcesses(agentUser.user, processes, this.#agentUser.sudo) : processes;
    const kind = options.processContainment ?? options.containment?.kind ?? "process-tree";
    this.#cacheIdleMs = (options.cacheIdleDays ?? CACHE_IDLE_DAYS) * 24 * 60 * 60_000;
    this.#awaitServices = options.awaitServices;
    // The repo mirrors and the dependency cache stand in for a snapshot image (ADR 0038, Q185).
    this.capabilities = {
      isolation: "none",
      services: options.boxCapabilities?.services ?? false,
      boxSizes: false,
      snapshots: options.boxCapabilities?.snapshots ?? "host-cache",
      processContainment: kind,
      // Milestone 5: a worktree takes no registry image and never waits for a node.
      registry: "none",
      nodeWait: false,
      // Milestone 8 (ADR 0068): the machine's own browser, and the machine's loopback.
      boxBrowser: "machine",
      appReach: "loopback",
    };
  }

  /**
   * A host executor with the best containment this machine allows (ADR 0029, Q126), after it ended
   * what an earlier run of this runner left behind (ticket 42). A fallback to the process tree is
   * logged with its reason.
   */
  static async start(
    options: Omit<HostExecutorOptions, "containment">,
    context?: AdapterContext,
    probe: Partial<ContainmentProbe> = {},
  ): Promise<HostExecutor> {
    const prefix = cgroupPrefix(path.resolve(options.dataDir));
    const containment = await detectContainment({
      cgroupPrefix: prefix,
      onFallback: (reason) => {
        context?.logger.warn("containment.fallback", { containment: "process-tree", reason });
      },
      ...probe,
    });
    const markers = await keptMarkers(options.dataDir);
    const left = await sweepLeftovers({ probe, markers, cgroupPrefix: prefix }).catch(() => ({ cgroups: 0, processes: 0 }));
    if (left.cgroups > 0 || left.processes > 0) {
      context?.logger.info("containment.leftovers-ended", { cgroups: left.cgroups, processes: left.processes });
    }
    const executor = new HostExecutor({ ...options, containment }, context);
    // A project's cache that no task used for its idle days goes (F-051).
    await executor.sweepIdleCaches().catch(() => 0);
    return executor;
  }

  /**
   * Milestone 5 (ticket 10, ADR 0029 as amended): a `host` pool runner's executor, or why it
   * doesn't start: on Windows; without its agent user; or on the development switch in
   * production. With a separate user, the task's processes run as that user, its folders are handed
   * to that user's group, the data folder is traversable only, and the containment's marker sweep
   * lists and ends that user's processes.
   */
  static async startPool(
    options: Omit<HostExecutorOptions, "containment" | "agentUser"> & HostPoolOptions,
    context?: AdapterContext,
    probe: Partial<ContainmentProbe> = {},
  ): Promise<{ readonly ok: true; readonly value: HostExecutor } | { readonly ok: false; readonly reason: string }> {
    const { agentUser: setting, secrets, sudo, platform, runnerUser, agentGid, ...executorOptions } = options;
    const resolved = hostPoolAgentUser({
      agentUser: setting,
      env: options.env ?? process.env,
      platform: platform ?? process.platform,
      runnerUser: runnerUser === undefined ? os.userInfo().username : runnerUser,
    });
    if (!resolved.ok) {
      return resolved;
    }
    const user = resolved.value;
    if (user.kind !== "separate") {
      context?.logger.warn("host pool runs as the runner's own user", { agentUser: SAME_USER_DEVELOPMENT });
      return { ok: true, value: await HostExecutor.start({ ...executorOptions, agentUser: { user } }, context, probe) };
    }
    let gid = agentGid;
    if (gid === undefined) {
      const looked = await runProgram("id", ["-g", user.user], { cwd: "/", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
      gid = Number(looked.stdout.trim());
      if (looked.code !== 0 || !Number.isInteger(gid) || gid < 0) {
        return { ok: false, reason: `the agent's user ${user.user} doesn't exist on this machine` };
      }
    }
    // The data folder and its tasks: traversable only, so the agent reaches its own task's folder
    // by its path and lists nothing; the runner's key and temp folder stay its own (`secrets`).
    await mkdir(path.join(executorOptions.dataDir, "tasks"), { recursive: true });
    await chmod(executorOptions.dataDir, 0o711);
    await chmod(path.join(executorOptions.dataDir, "tasks"), 0o711);
    const executor = await HostExecutor.start(
      {
        ...executorOptions,
        agentUser: { user, handOver: handOverToGroup(gid), ...(sudo === undefined ? {} : { sudo }), ...(secrets === undefined ? {} : { secrets }) },
      },
      context,
      { sweep: agentUserMarkerSweep(user.user, { ...(sudo === undefined ? {} : { sudo }), ...(platform === undefined ? {} : { platform }) }), ...probe },
    );
    return { ok: true, value: executor };
  }

  /** Milestone 5 (ticket 10): who this executor's task processes run as. */
  get agentUser(): AgentUser {
    return this.#agentUser.user;
  }

  async health(): Promise<HealthReport> {
    const env = baseEnv(this.#env);
    await mkdir(this.#dataDir, { recursive: true });
    const git = await runProgram("git", ["--version"], { cwd: this.#dataDir, env });
    if (git.code !== 0) {
      return { status: "down", reason: "git isn't on PATH" };
    }
    const setupShell = await this.#resolveShell();
    if (setupShell.kind === "missing") {
      return { status: "down", reason: setupShell.reason };
    }
    const shell = await runProgram(setupShell.command, ["--version"], { cwd: this.#dataDir, env });
    if (shell.code !== 0) {
      return { status: "down", reason: missingShellReason(setupShell.command) };
    }
    // Milestone 5 (ticket 10): a pool's agent user.
    const agentUser = this.#agentUser.user;
    switch (agentUser.kind) {
      case "runner":
        return { status: "ok" };
      case "same-user-development":
        return { status: "degraded", reason: SAME_USER_DEVELOPMENT };
      case "separate": {
        const tasks = path.join(this.#dataDir, "tasks");
        await mkdir(tasks, { recursive: true });
        const checked = await checkAgentUser(agentUser.user, this.#agentUser.secrets ?? [], {
          cwd: this.#dataDir,
          reach: tasks,
          ...(this.#agentUser.sudo === undefined ? {} : { sudo: this.#agentUser.sudo }),
        });
        return checked.ok ? { status: "ok" } : { status: "down", reason: checked.reason };
      }
      default:
        return agentUser satisfies never;
    }
  }

  /** The program that runs setup scripts, found once (Q136, item 9). */
  #resolveShell(): Promise<SetupShell> {
    const probe = this.#shellProbe;
    this.#setupShell ??=
      probe === undefined ? Promise.resolve({ kind: "found", command: this.#shell }) : resolveSetupShell(this.#shell, probe);
    return this.#setupShell;
  }

  /** A host never starts services, with the reason ostra shows (F-094), and keeps only a host cache (ADR 0038). */
  protected override refuseUnfitSpec(spec: TaskSpec): AdapterResult<never> | null {
    if ((spec.services?.length ?? 0) > 0 && !this.capabilities.services) {
      return adapterError("unsupported", HOST_SERVICES_REASON);
    }
    return super.refuseUnfitSpec(spec);
  }

  async create(input: CreateBoxInput): Promise<AdapterResult<CreatedBox>> {
    const unfit = this.refuseUnfitBox(input);
    if (unfit !== null) {
      return unfit;
    }
    const key = boxKey(input);
    if (this.#boxes.has(key)) {
      return adapterError("conflict", "the box exists already");
    }
    const root = path.join(this.#dataDir, "tasks", folderOf(input.taskId));
    const record: BoxRecord = {
      ref: { taskId: input.taskId, boxId: input.boxId },
      state: "creating",
      root,
      workspaceDir: path.join(root, "workspace"),
      agentDir: path.join(root, "agent"),
      gitConfig: path.join(root, "git", "config"),
      spec: input.spec,
      proxies: input.proxies,
      unit: undefined,
      agent: undefined,
      turnBase: new Map(),
      apps: new Map(),
      browsers: new Set(),
    };
    this.#boxes.set(key, record);
    try {
      // A task root is never reused: anything left from an earlier box of this task goes first.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      await mkdir(record.workspaceDir, { recursive: true });
      await mkdir(record.agentDir, { recursive: true });
      await mkdir(path.dirname(record.gitConfig), { recursive: true });
      // The task's unit, with its folder: the setup script and the agent join it (ticket 42).
      const marker = newUnitMarker();
      await writeFile(path.join(root, UNIT_MARKER_FILE), marker);
      record.unit = await this.#processes.createUnit(`${input.taskId}-${input.boxId}`, marker);
      await this.#writeTaskGitConfig(record);
      // Milestone 5 (ticket 10): a pool's task folder, made by the runner, handed to the agent's user.
      if (this.#agentUser.user.kind === "separate") {
        await this.#agentUser.handOver?.(root);
      }
    } catch (error) {
      record.state = "failed";
      return adapterError("unavailable", `couldn't make the task's folder (${errorCode(error)})`);
    }
    this.plumbing.logger.info("box created", { taskId: input.taskId, boxId: input.boxId, repos: input.spec.repos.length });
    return ok({ workspaceDir: record.workspaceDir, agentDir: record.agentDir, gitConfig: record.gitConfig });
  }

  async prepare(input: PrepareInput): Promise<AdapterResult<PrepareResult>> {
    const record = this.#boxes.get(boxKey(input.box));
    if (record?.state !== "creating") {
      return adapterError("conflict", `the box can't be prepared from ${record?.state ?? "released"}`);
    }
    record.state = "preparing";
    const log = this.plumbing.logger.child({ taskId: record.ref.taskId, boxId: record.ref.boxId });
    // The project's host cache first (F-051): the mirrors make the clones local, the deps folder the install warm.
    const cache = await this.#useCache(record, input.signal);
    // A `docker` box from a snapshot (F-051): its volume came with the checkouts, which move in.
    const snapshot = await this.#adoptSnapshot(record);
    for (const repo of record.spec.repos) {
      const checkout = path.join(record.workspaceDir, repo.checkoutDir);
      const updated = snapshot === "used" ? await this.#updateAdopted(record, repo, checkout) : null;
      if (updated !== null && !updated.ok) {
        record.state = "failed";
        return updated;
      }
      // From the mirror's objects, then dissociated: the worktree needs nothing of the mirror after.
      const reference = cache === null ? [] : ["--reference-if-able", this.#mirrorOf(cache.projectId, repo.repoId), "--dissociate"];
      const cloned =
        updated !== null
          ? { code: 0, stdout: "", stderr: "" }
          : await this.#git(record, ["clone", "--quiet", ...reference, "--origin", "origin", "--branch", repo.defaultBranch, repo.cloneUrl, checkout], record.workspaceDir);
      if (cloned.code !== 0) {
        record.state = "failed";
        log.warn("clone failed", { repoId: repo.repoId, code: cloned.code });
        return adapterError("unavailable", `cloning ${repo.fullName} through the git proxy failed${this.#reason(cloned)}`);
      }
      const configured = await this.#configureCheckout(record, checkout, repo);
      if (!configured.ok) {
        record.state = "failed";
        return configured;
      }
      const secrets = input.secrets.find((entry) => entry.repoId === repo.repoId)?.entries ?? [];
      const written = await this.#writeEnvironment(record, repo.repoId, checkout, secrets);
      if (!written.ok) {
        record.state = "failed";
        return written;
      }
    }
    // The services before the setup script, which may need them (F-094): the box's runner reports them.
    const services = (record.spec.services?.length ?? 0) > 0 && this.#awaitServices !== undefined ? await this.#awaitServices(record.spec, input.signal) : undefined;
    if (services?.some((service) => service.outcome === "failed") === true) {
      record.state = "ready";
      log.warn("a service didn't start: no setup", { failed: services.filter((service) => service.outcome === "failed").length });
      return ok({ setup: null, services, ...(snapshot === null ? {} : { snapshot }) });
    }
    const setup = await this.#runSetup(record, input, cache?.prepared.dependencyCacheDir ?? null);
    if (!setup.ok) {
      record.state = "failed";
      return setup;
    }
    await this.#recordHeads(record);
    record.state = "ready";
    log.info("box ready", { setupExitCode: setup.value?.exitCode ?? null, dependencyCache: cache === null ? null : cache.prepared.reused ? "warm" : "cold" });
    return ok({
      setup: setup.value,
      ...(cache === null ? {} : { dependencyCache: { cacheKey: cache.prepared.cacheKey, reused: cache.prepared.reused } }),
      ...(snapshot === null ? {} : { snapshot }),
      ...(services === undefined ? {} : { services }),
    });
  }

  async startAgent(box: BoxRef, launch: AgentLaunch): Promise<AdapterResult<AgentProcess>> {
    const record = this.#boxes.get(boxKey(box));
    if (record === undefined || (record.state !== "ready" && record.state !== "idle")) {
      return adapterError("conflict", `an agent can't start in a box that is ${record?.state ?? "released"}`);
    }
    if (record.agent !== undefined) {
      return adapterError("conflict", "the box's agent is running already");
    }
    for (const file of launch.files) {
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content, { mode: 0o600 });
    }
    const unit = record.unit;
    if (unit === undefined) {
      return adapterError("conflict", "the box has no containment unit");
    }
    // The task's marker rides in the agent's environment, so its children carry it too.
    const started = await this.#processes.startAgent({ ...launch, env: { ...launch.env, [TASK_UNIT_ENV]: unit.marker } }, unit);
    if (!started.ok) {
      return adapterError("unavailable", `the agent's process didn't start (${started.reason})`);
    }
    const { process: agentProcess, stdinEnd } = started.value;
    const pid = agentProcess.pid;
    const exited = agentProcess.exited;
    record.agent = { pid, exited, stdinEnd };
    void exited.then(() => {
      if (record.agent?.pid === pid && record.state !== "stopped" && record.state !== "released") {
        record.state = "idle";
      }
    });
    this.plumbing.logger.info("agent started", { taskId: box.taskId, boxId: box.boxId, pid, containment: unit.kind });
    return ok(agentProcess);
  }

  async commitAndPush(input: CommitAndPushInput): Promise<AdapterResult<readonly RepoPushResult[]>> {
    const record = this.#boxes.get(boxKey(input.box));
    if (record === undefined || record.state === "released" || record.state === "creating") {
      return adapterError("conflict", `nothing to push from a box that is ${record?.state ?? "released"}`);
    }
    const results: RepoPushResult[] = [];
    const commit = input.pushOnly === true ? null : await this.#commitMessage(record, input);
    for (const repo of record.spec.repos) {
      const checkout = path.join(record.workspaceDir, repo.checkoutDir);
      let filtered: StagedCommitPaths | null = null;
      if (commit !== null) {
        const committed = await this.#commitLeft(record, repo, commit);
        if (!committed.ok) {
          return committed;
        }
        filtered = committed.value;
      }
      // F-113: a repo whose commit kept nothing of the turn's isn't ahead, so it isn't pushed.
      const count = await this.#git(record, ["rev-list", "--count", `refs/remotes/origin/${repo.defaultBranch}..HEAD`], checkout);
      const ahead = count.code === 0 && Number(count.stdout.trim()) > 0;
      if (!ahead) {
        results.push({ repoId: repo.repoId, headSha: null, ahead: false, ...(filtered === null ? {} : { filtered }) });
        continue;
      }
      const head = gitShaSchema.safeParse((await this.#git(record, ["rev-parse", "HEAD"], checkout)).stdout.trim());
      // Both refs in one push: the git proxy takes all or nothing. The branch is the task's own, so a
      // history the agent rewrote is pushed as it is.
      const pushed = await this.#git(
        record,
        ["push", "--quiet", "--porcelain", "origin", `+HEAD:refs/heads/${repo.branchName ?? input.branchName}`, `+HEAD:${input.hiddenRef}`],
        checkout,
      );
      if (pushed.code !== 0 || !head.success) {
        this.plumbing.logger.warn("push failed", { taskId: record.ref.taskId, repoId: repo.repoId, code: pushed.code });
        return adapterError("unavailable", `pushing ${repo.fullName} through the git proxy failed${this.#reason(pushed)}`);
      }
      results.push({ repoId: repo.repoId, headSha: head.data, ahead: true, ...(filtered === null ? {} : { filtered }) });
    }
    this.plumbing.logger.info("pushed", { taskId: record.ref.taskId, ahead: results.filter((item) => item.ahead).length });
    return ok(results);
  }

  /**
   * Milestone 3 (F-054): what the turn left committed in every repo, as `commitAndPush` does, with
   * no push; then which repos the turn changed, by each head against where it was (Q188).
   */
  override async commitWork(input: CommitWorkInput): Promise<AdapterResult<readonly CommittedRepoWork[]>> {
    const record = this.#boxes.get(boxKey(input.box));
    if (record === undefined || record.state === "released" || record.state === "creating") {
      return adapterError("conflict", `nothing to commit in a box that is ${record?.state ?? "released"}`);
    }
    const commit = await this.#commitMessage(record, input);
    const results: CommittedRepoWork[] = [];
    for (const repo of record.spec.repos) {
      const committed = await this.#commitLeft(record, repo, commit);
      if (!committed.ok) {
        return committed;
      }
      const head = await this.#headOf(record, repo);
      const filtered = committed.value;
      results.push({ repoId: repo.repoId, headSha: head, changed: head === null || head !== record.turnBase.get(repo.repoId), ...(filtered === null ? {} : { filtered }) });
      if (head !== null) {
        record.turnBase.set(repo.repoId, head);
      }
    }
    this.plumbing.logger.info("work committed", { taskId: record.ref.taskId, changed: results.filter((item) => item.changed).length });
    return ok(results);
  }

  async stop(input: StopInput): Promise<AdapterResult<void>> {
    const record = this.#boxes.get(boxKey(input.box));
    if (record === undefined) {
      return ok(undefined);
    }
    await this.#endApp(record, input.graceMs);
    await this.#endAgent(record, input.graceMs);
    // Everything else the task started too: a daemon its setup script left (ticket 42).
    await record.unit?.killAll();
    if (record.state !== "released") {
      record.state = "stopped";
    }
    return ok(undefined);
  }

  // ---------- milestone 8 (ADR 0068): the running app ----------

  /**
   * One of the app's processes (F-140), through the processes seam: on `host` a child in the task's
   * unit, in a box the init's, as the agent's user either way. Its output goes to its log in the
   * task's folder (`.ostra/app/<name>.log`), never in a repo, and it ends with the box.
   */
  override async startAppProcess(input: StartAppProcessInput): Promise<AdapterResult<AppProcessHandle>> {
    const record = this.#boxes.get(boxKey(input.box));
    const unit = record?.unit;
    if (record === undefined || unit === undefined || (record.state !== "ready" && record.state !== "idle")) {
      return adapterError("conflict", `an app process can't start in a box that is ${record?.state ?? "released"}`);
    }
    const { launch } = input;
    if (record.apps.has(launch.name)) {
      return adapterError("conflict", `the app process ${launch.name} is running already`);
    }
    const logPath = path.join(record.root, ...appLogPath(launch.name).split("/"));
    let log;
    try {
      log = await openAppLog(logPath);
    } catch (error) {
      return adapterError("unavailable", `couldn't open the app process's log (${errorCode(error)})`);
    }
    // The task's marker rides in its environment, as the agent's does, so its children carry it too.
    const started = await this.#processes.startApp({ ...launch, env: { ...launch.env, [TASK_UNIT_ENV]: unit.marker } }, unit);
    if (!started.ok) {
      await log.close();
      return adapterError("unavailable", `the app process ${launch.name} didn't start (${started.reason})`);
    }
    const running = started.value;
    running.stdout.on("data", (chunk: Buffer) => {
      log.write(chunk);
    });
    running.stderr.on("data", (chunk: Buffer) => {
      log.write(chunk);
    });
    // Its exit is reported once its output is in the log: the end of both streams, then the file closed.
    const streamEnd = (stream: NodeJS.ReadableStream): Promise<void> =>
      new Promise((resolve) => {
        stream.once("end", resolve);
        stream.once("close", resolve);
      });
    const exited = Promise.all([running.exited, streamEnd(running.stdout), streamEnd(running.stderr)]).then(async ([exit]) => {
      await log.close();
      if (record.apps.get(launch.name)?.handle.pid === running.pid) {
        record.apps.delete(launch.name);
      }
      this.plumbing.logger.info("app process exited", { taskId: record.ref.taskId, boxId: record.ref.boxId, app: launch.name, code: exit.code, signal: exit.signal });
      return exit;
    });
    const handle: AppProcessHandle = { name: launch.name, pid: running.pid, logPath, exited };
    record.apps.set(launch.name, { handle, stop: running.stop });
    this.plumbing.logger.info("app process started", { taskId: record.ref.taskId, boxId: record.ref.boxId, app: launch.name, pid: running.pid });
    return ok(handle);
  }

  override async stopAppProcess(input: StopAppProcessInput): Promise<AdapterResult<ProcessExit>> {
    const running = this.#boxes.get(boxKey(input.box))?.apps.get(input.name);
    if (running === undefined) {
      return adapterError("not-found", `no app process ${input.name} runs in the box`);
    }
    await running.stop(input.graceMs);
    return ok(await running.handle.exited);
  }

  /**
   * The box's browser (F-121, F-141), through the processes seam: on `host` the machine's, in the
   * task's unit; in a box the image's, started by the init. Named by DevTools' own `Browser.getVersion`.
   */
  override async startBrowser(box: BoxRef): Promise<AdapterResult<BrowserStart>> {
    const record = this.#boxes.get(boxKey(box));
    const unit = record?.unit;
    if (record === undefined || unit === undefined || (record.state !== "ready" && record.state !== "idle")) {
      return adapterError("conflict", `a browser can't start in a box that is ${record?.state ?? "released"}`);
    }
    const started = await this.#processes.startBrowser(unit, { ...baseEnv(this.#env), [TASK_UNIT_ENV]: unit.marker });
    if (!started.available) {
      this.plumbing.logger.info("no browser in the box", { taskId: box.taskId, boxId: box.boxId, reason: started.reason });
      return ok({ available: false, reason: started.reason });
    }
    const channel = browserChannel(started.ends);
    record.browsers.add(channel);
    void channel.closed.then(() => record.browsers.delete(channel));
    const identity = await identifyBrowser(channel, started.program);
    if (identity === null) {
      await channel.close();
      this.plumbing.logger.warn("the box's browser didn't answer", { taskId: box.taskId, boxId: box.boxId });
      return ok({ available: false, reason: "failed-to-start" });
    }
    this.plumbing.logger.info("browser started", { taskId: box.taskId, boxId: box.boxId, browser: identity.name, version: identity.version });
    return ok({ available: true, browser: { ...identity, channel, profileDir: started.profileDir } });
  }

  /** The app's processes and the browsers end before the agent: each process gets `graceMs` to exit, and each browser's profile goes. */
  async #endApp(record: BoxRecord, graceMs: number): Promise<void> {
    const apps = [...record.apps.values()];
    const browsers = [...record.browsers];
    await Promise.all([...apps.map(async (app) => app.stop(graceMs).catch(() => undefined)), ...browsers.map(async (browser) => browser.close().catch(() => undefined))]);
    await Promise.all(apps.map((app) => app.handle.exited));
  }

  async release(box: BoxRef, reason: BoxReleaseReason = "requested"): Promise<AdapterResult<void>> {
    const record = this.#boxes.get(boxKey(box));
    if (record === undefined) {
      // A box this executor no longer tracks, such as one kept before the runner restarted (ticket
      // 23): its folder goes too, unless another box of the same task lives in it now.
      if ([...this.#boxes.values()].some((other) => other.ref.taskId === box.taskId)) {
        return ok(undefined);
      }
      try {
        await rm(path.join(this.#dataDir, "tasks", folderOf(box.taskId)), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (error) {
        return adapterError("unavailable", `couldn't remove the task's folder (${error instanceof Error ? error.name : "unknown"})`);
      }
      return ok(undefined);
    }
    await this.#endApp(record, 0);
    await this.#endAgent(record, 0);
    await record.unit?.dispose();
    record.unit = undefined;
    // Milestone 5 (ticket 10): what the agent's user made, removed as that user, who owns it.
    if (this.#agentUser.user.kind === "separate") {
      await this.#processes
        .run("rm", ["-rf", "--", record.workspaceDir, record.agentDir], { cwd: this.#dataDir, env: baseEnv(this.#env) })
        .catch(() => undefined);
    }
    try {
      await rm(record.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      return adapterError("unavailable", `couldn't remove the task's folder (${errorCode(error)})`);
    }
    record.state = "released";
    this.#boxes.delete(boxKey(box));
    this.plumbing.logger.info("box released", { taskId: box.taskId, boxId: box.boxId, reason });
    return ok(undefined);
  }

  state(box: BoxRef): Promise<AdapterResult<BoxState>> {
    return Promise.resolve(ok(this.#boxes.get(boxKey(box))?.state ?? "released"));
  }

  /**
   * After a turn (ADR 0039): each repo's working tree to the task's hidden ref, by a forced push
   * through the git proxy. A repo whose save fails answers `null`, and the others still save. With
   * the spec's `commitPaths` (F-113, ADR 0038 as amended 2026-11-21), only those paths' changes.
   */
  override async saveWorkInProgress(input: SaveWorkInProgressInput): Promise<AdapterResult<readonly SavedRepoWork[]>> {
    const record = this.#boxes.get(boxKey(input.box));
    if (record === undefined || record.state === "released" || record.state === "creating" || record.state === "failed") {
      return adapterError("conflict", `nothing to save from a box that is ${record?.state ?? "released"}`);
    }
    const saved: SavedRepoWork[] = [];
    const commitPaths = record.spec.commitPaths ?? null;
    for (const repo of record.spec.repos) {
      const checkout = path.join(record.workspaceDir, repo.checkoutDir);
      const result = await saveWorkInProgressIn(this.#wip(record, checkout), { taskId: record.ref.taskId, turnOrdinal: input.turnOrdinal, remote: "origin", commitPaths });
      if (!result.ok) {
        this.plumbing.logger.warn("saving the hidden ref failed", { taskId: record.ref.taskId, repoId: repo.repoId, reason: result.error.message });
      }
      const value = result.ok ? result.value : null;
      saved.push({ repoId: repo.repoId, sha: value?.sha ?? null, baseSha: value?.baseSha ?? null });
    }
    this.plumbing.logger.info("hidden ref saved", { taskId: record.ref.taskId, turnOrdinal: input.turnOrdinal, saved: saved.filter((item) => item.sha !== null).length });
    return ok(saved);
  }

  /**
   * On a fresh box (ADR 0039, Q150): each repo's hidden ref onto its saved commit, the branch's new
   * commits merged in. A conflict, or a restore that fails, leaves the branch's head checked out
   * and the ref alone. A repo the spec names no ref for answers `none`.
   */
  override async restoreWorkInProgress(input: RestoreWorkInProgressInput): Promise<AdapterResult<readonly RestoredRepoWork[]>> {
    const record = this.#boxes.get(boxKey(input.box));
    if (record?.state !== "ready" || record.agent !== undefined) {
      return adapterError("conflict", `work in progress is restored into a ready box before its agent starts (${record?.state ?? "released"})`);
    }
    const restored: RestoredRepoWork[] = [];
    for (const repo of record.spec.repos) {
      if (!input.refs.some((ref) => ref.repoId === repo.repoId)) {
        restored.push({ repoId: repo.repoId, outcome: "none" });
        continue;
      }
      const checkout = path.join(record.workspaceDir, repo.checkoutDir);
      const result = await restoreWorkInProgressIn(this.#wip(record, checkout), { taskId: record.ref.taskId, remote: "origin", branch: repoBranchName(record.spec, repo) });
      if (!result.ok) {
        this.plumbing.logger.warn("restoring the hidden ref failed", { taskId: record.ref.taskId, repoId: repo.repoId, reason: result.error.message });
        // Back to the branch's head, as a conflict leaves it: the ref stays for another try.
        await this.#git(record, ["checkout", "--quiet", "--force", repoBranchName(record.spec, repo)], checkout);
        await this.#git(record, ["clean", "-fdq"], checkout);
        restored.push({ repoId: repo.repoId, outcome: "conflict" });
        continue;
      }
      restored.push({ repoId: repo.repoId, outcome: result.value.outcome });
    }
    // The restored work is uncommitted: the next `commitWork` commits it, and that turn changed the repo.
    await this.#recordHeads(record);
    this.plumbing.logger.info("hidden ref restored", {
      taskId: record.ref.taskId,
      applied: restored.filter((item) => item.outcome === "applied").length,
      conflicts: restored.filter((item) => item.outcome === "conflict").length,
    });
    return ok(restored);
  }

  /** The agent adapter's command (a session's export or import), on this machine, in the task's unit. */
  override async runAgentCommand(input: RunAgentCommandInput): Promise<AdapterResult<AgentCommandResult>> {
    const record = this.#boxes.get(boxKey(input.box));
    if (record === undefined || record.state === "released" || record.state === "creating") {
      return adapterError("not-found", `no box to run the command in (${record?.state ?? "released"})`);
    }
    // `stdoutTo`: the command's standard output goes to that file as it comes (OpenCode's export
    // prints the archive), never through a shell.
    const target = input.command.stdoutTo;
    let sink: WriteStream | undefined;
    if (target !== undefined) {
      await mkdir(path.dirname(target), { recursive: true });
      sink = createWriteStream(target, { mode: 0o600 });
    }
    const writing = sink;
    const result = await this.#processes.run(input.command.command, input.command.args, {
      cwd: input.command.cwd,
      // Exactly the command's environment, as the agent's own launch (ADR 0030).
      env: { ...input.command.env },
      signal: AbortSignal.timeout(input.timeoutMs),
      maxBuffer: AGENT_COMMAND_OUTPUT_MAX,
      ...(record.unit === undefined ? {} : { unit: record.unit }),
      ...(writing === undefined
        ? {}
        : {
            onOutput: (stream: "stdout" | "stderr", text: string) => {
              if (stream === "stdout") {
                writing.write(text);
              }
            },
          }),
    });
    if (writing !== undefined) {
      await new Promise<void>((resolve) => {
        writing.end(() => {
          resolve();
        });
      });
    }
    this.plumbing.logger.info("agent command ran", { taskId: input.box.taskId, boxId: input.box.boxId, exitCode: result.code });
    return ok({ exitCode: result.code, stdout: writing === undefined ? result.stdout.slice(0, AGENT_COMMAND_OUTPUT_MAX) : "" });
  }

  /**
   * A kept box takes the next session (ADR 0039, `resumed`): the task's git config and each
   * checkout's `insteadOf` rules point at the new git proxy, and the trailers at the new co-authors.
   * The workspace, the branch and the agent's folder stay as they were.
   */
  override async resumeBox(input: CreateBoxInput): Promise<AdapterResult<CreatedBox>> {
    const record = this.#boxes.get(boxKey(input));
    if (record === undefined || record.state === "released" || record.state === "failed" || record.state === "creating") {
      return adapterError("not-found", "the box isn't kept here");
    }
    if (record.agent !== undefined || record.state === "preparing") {
      return adapterError("conflict", "the box is still running a session");
    }
    record.spec = input.spec;
    record.proxies = input.proxies;
    try {
      await this.#writeTaskGitConfig(record);
      for (const repo of record.spec.repos) {
        const checkout = path.join(record.workspaceDir, repo.checkoutDir);
        // The last session's proxy rules go first: each named the old proxy's address.
        const rules = await this.#git(record, ["config", "--local", "--name-only", "--get-regexp", "^url\\..*\\.insteadof$"], checkout);
        for (const name of rules.stdout.split(/\r?\n/).filter((line) => line.trim() !== "")) {
          await this.#git(record, ["config", "--local", "--unset-all", name.trim()], checkout);
        }
        for (const [key, value] of await this.#settings(record, repoGitIdentity(record.spec, repo))) {
          const set = await this.#git(record, ["config", "--local", key, value], checkout);
          if (set.code !== 0) {
            return adapterError("unavailable", `configuring the checkout failed (${key})`);
          }
        }
        await writeFile(path.join(checkout, ".git", "ostra-trailers"), record.spec.coAuthors.map((person) => `${coAuthorTrailer(person)}\n`).join(""));
        // Milestone 6 (F-100): a review task reopened for its next round moves to the round's heads.
        const reviewed = reviewRepoOf(record.spec, repo.repoId);
        if (reviewed !== null) {
          const atHead = await this.#checkoutReviewHead(record, checkout, reviewed);
          if (!atHead.ok) {
            return atHead;
          }
          continue;
        }
        // F-066: a repo that merged while the task carried on has a fresh branch now; its checkout
        // moves onto it, from the base's current head, before anything is taken from the host.
        const moved = await this.#moveToRepoBranch(record, checkout, repo);
        if (!moved.ok) {
          return moved;
        }
        // F-103: a reopen starts from the branch as it is. A member may have pushed to it since the
        // last turn (`ostra checkout`): their commits come into the kept worktree before the agent
        // starts, or the next push, which is forced, would drop them.
        const taken = await this.#takeRemoteCommits(record, checkout, repoBranchName(record.spec, repo));
        if (!taken.ok) {
          return taken;
        }
      }
    } catch (error) {
      return adapterError("unavailable", `couldn't resume the box (${error instanceof Error ? error.name : "unknown"})`);
    }
    await this.#recordHeads(record);
    record.state = "ready";
    this.plumbing.logger.info("box resumed", { taskId: input.taskId, boxId: input.boxId });
    return ok({ workspaceDir: record.workspaceDir, agentDir: record.agentDir, gitConfig: record.gitConfig });
  }

  /**
   * Puts a kept checkout on the repo's branch when the spec names another than the one checked out
   * (F-066): a repo merged and reopened works on `<name>-2`, started from the base as it is now (a
   * squash merge leaves the old branch's commits out of the base's history). Uncommitted work comes
   * along, since a plain checkout keeps it; a checkout that can't move leaves the box unresumed, and
   * the runner builds a fresh one.
   */
  async #moveToRepoBranch(record: BoxRecord, checkout: string, repo: TaskSpec["repos"][number]): Promise<AdapterResult<void>> {
    const branch = repoBranchName(record.spec, repo);
    const current = await this.#git(record, ["symbolic-ref", "--quiet", "--short", "HEAD"], checkout);
    if (current.code === 0 && current.stdout.trim() === branch) {
      return ok(undefined);
    }
    const local = await this.#git(record, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], checkout);
    if (local.code === 0) {
      const switched = await this.#git(record, ["checkout", "--quiet", branch], checkout);
      return switched.code === 0 ? ok(undefined) : adapterError("conflict", "the kept checkout can't move onto the repo's branch");
    }
    // The branch on the host when it exists (pushed from elsewhere), else the base's current head.
    const onHost = await this.#git(record, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], checkout);
    let start = `refs/remotes/origin/${branch}`;
    if (onHost.code !== 0) {
      const base = await this.#git(record, ["fetch", "--quiet", "origin", `+refs/heads/${repo.defaultBranch}:refs/remotes/origin/${repo.defaultBranch}`], checkout);
      if (base.code !== 0) {
        return adapterError("unavailable", "the base branch couldn't be fetched for the repo's fresh branch");
      }
      start = `refs/remotes/origin/${repo.defaultBranch}`;
    }
    const created = await this.#git(record, ["checkout", "--quiet", "-b", branch, start], checkout);
    if (created.code !== 0) {
      return adapterError("conflict", "the kept checkout can't move onto the repo's fresh branch");
    }
    this.plumbing.logger.info("moved the kept checkout onto the repo's branch", { taskId: record.ref.taskId, repoId: repo.repoId });
    return ok(undefined);
  }

  /**
   * Brings the task branch's commits from the code host into a kept checkout: a fast-forward when
   * the checkout has nothing new, a merge when both moved. A branch not pushed yet has nothing to
   * take. A merge that conflicts is undone and the box isn't resumed: the runner then builds a fresh
   * one from the branch as it is on the host.
   */
  async #takeRemoteCommits(record: BoxRecord, checkout: string, branch: string): Promise<AdapterResult<void>> {
    const remote = `refs/remotes/origin/${branch}`;
    const fetched = await this.#git(record, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:${remote}`], checkout);
    if (fetched.code !== 0) {
      // Nothing pushed yet, or the host can't be reached: the checkout stays as it was.
      return ok(undefined);
    }
    const has = await this.#git(record, ["merge-base", "--is-ancestor", remote, "HEAD"], checkout);
    if (has.code === 0) {
      return ok(undefined);
    }
    const merged = await this.#git(record, ["merge", "--quiet", "--no-edit", remote], checkout);
    if (merged.code !== 0) {
      await this.#git(record, ["merge", "--abort"], checkout);
      this.plumbing.logger.warn("the branch moved on the host and doesn't merge", { taskId: record.ref.taskId });
      return adapterError("conflict", "the task's branch moved on the code host and doesn't merge into the kept worktree");
    }
    this.plumbing.logger.info("took the branch's new commits", { taskId: record.ref.taskId });
    return ok(undefined);
  }

  /** The worktree's root: its names, top level only (ticket 44). */
  async listWorkspaceRoot(box: BoxRef): Promise<AdapterResult<readonly string[]>> {
    const record = this.#boxes.get(boxKey(box));
    if (record === undefined || record.state === "released") {
      return adapterError("not-found", "no such box");
    }
    try {
      return ok(await readdir(record.workspaceDir));
    } catch (error) {
      return adapterError("unavailable", `couldn't list the workspace (${errorCode(error)})`);
    }
  }

  // ---------- milestone 3: the host cache (F-051) and checks (F-054) ----------

  /**
   * Makes or refreshes a project's host cache (ADR 0038 as amended, Q185): a bare mirror of each
   * repo, fetched through the git proxy, and the dependency cache folder. One update per project at
   * a time. A new cache key starts the dependency cache again; the mirrors are only git objects and
   * stay. `reused` says the key's cache was all there already: the task reports it as warm.
   */
  override async prepareCache(input: PrepareCacheInput): Promise<AdapterResult<PreparedCache>> {
    const folder = projectFolder(input.projectId);
    const previous = this.#cacheLocks.get(folder) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.#refreshCache(input));
    this.#cacheLocks.set(folder, run);
    try {
      return await run;
    } finally {
      if (this.#cacheLocks.get(folder) === run) {
        this.#cacheLocks.delete(folder);
      }
    }
  }

  /**
   * Removes a project's host cache, as when the project is removed from this runner (F-051).
   * `conflict` while a box of the project is live: its setup may be reading the cache.
   */
  async removeProjectCache(projectId: ProjectId): Promise<AdapterResult<void>> {
    if ([...this.#boxes.values()].some((record) => record.spec.projectId === projectId && record.state !== "released")) {
      return adapterError("conflict", "a box of the project is still using its cache");
    }
    await this.#cacheLocks.get(projectFolder(projectId))?.catch(() => undefined);
    try {
      await rm(this.#cacheDir(projectId), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      return adapterError("unavailable", `couldn't remove the project's cache (${errorCode(error)})`);
    }
    this.plumbing.logger.info("host cache removed", { projectId });
    return ok(undefined);
  }

  /**
   * Removes every project's host cache no task used for the idle days (30, a working value), except
   * one a live box or an update holds. `HostExecutor.start` runs it, and a box that uses a cache at
   * most hourly after. Answers how many went.
   */
  async sweepIdleCaches(now: number = Date.now()): Promise<number> {
    this.#lastSweep = now;
    const root = path.join(this.#dataDir, "cache");
    const folders = await readdir(root).catch((): string[] => []);
    const live = new Set(
      [...this.#boxes.values()].filter((record) => record.state !== "released").map((record) => projectFolder(record.spec.projectId)),
    );
    let removed = 0;
    for (const folder of folders) {
      if (live.has(folder) || this.#cacheLocks.has(folder)) {
        continue;
      }
      const used = await stat(path.join(root, folder, "last-used")).catch(() => null);
      const lastUsed = used?.mtimeMs ?? (await stat(path.join(root, folder)).catch(() => null))?.mtimeMs ?? now;
      if (now - lastUsed >= this.#cacheIdleMs) {
        await rm(path.join(root, folder), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.plumbing.logger.info("idle host caches removed", { removed });
    }
    return removed;
  }

  /**
   * The turn's checks (F-054, ADR 0052, Q188), in the worktree: each as a child process of the
   * setup shell, in its repo's folder or the workspace root, with the check's environment only
   * (`checkEnvironment`: nothing of the runner's), in the task's unit, and its timeout ending the
   * whole process tree. `runChecksWith` keeps the order, the total and the output files.
   */
  override async runChecks(box: BoxRef, input: Omit<RunChecksInput, "workspaceDir">): Promise<AdapterResult<readonly CheckRunResult[]>> {
    const record = this.#boxes.get(boxKey(box));
    if (
      record === undefined ||
      record.state === "released" ||
      record.state === "creating" ||
      record.state === "preparing" ||
      record.state === "failed"
    ) {
      return adapterError("conflict", `checks don't run in a box that is ${record?.state ?? "released"}`);
    }
    const setupShell = await this.#resolveShell();
    if (setupShell.kind === "missing") {
      return adapterError("unavailable", setupShell.reason);
    }
    const shell = setupShell.command;
    const unit = record.unit;
    let results: readonly CheckRunResult[];
    try {
      results = await runChecksWith({ ...input, workspaceDir: record.workspaceDir }, (check) => this.#runCheck(shell, unit, check));
    } catch (error) {
      return adapterError("unavailable", `the checks couldn't run (${errorCode(error)})`);
    }
    // Statuses only: a check's output is untrusted and never logged.
    this.plumbing.logger.info("checks ran", {
      taskId: box.taskId,
      boxId: box.boxId,
      checks: results.length,
      notPassed: results.filter((result) => result.status !== "passed").length,
    });
    return ok(results);
  }

  // ---------- inside: a docker box's snapshot (F-051, ticket 14) ----------

  /**
   * `used` when the spec names a snapshot image and the task volume holds that snapshot's
   * checkouts, which then move into the task's workspace; `fell-back` when it names one this box
   * doesn't have, so the box clones and sets up in full; `null` when it names none.
   */
  async #adoptSnapshot(record: BoxRecord): Promise<"used" | "fell-back" | null> {
    const wanted = record.spec.snapshot ?? null;
    if (wanted?.kind !== "image") {
      return null;
    }
    const folder = path.join(this.#dataDir, SNAPSHOT_FOLDER);
    const held = (await readFile(path.join(folder, "snapshot-id"), "utf8").catch(() => "")).trim();
    if (held !== wanted.snapshotId) {
      this.plumbing.logger.info("the box has no copy of the task's snapshot: a full setup", { taskId: record.ref.taskId, snapshotId: wanted.snapshotId });
      return "fell-back";
    }
    try {
      for (const repo of record.spec.repos) {
        await rename(path.join(folder, "workspace", repo.checkoutDir), path.join(record.workspaceDir, repo.checkoutDir));
      }
    } catch (error) {
      this.plumbing.logger.warn("the snapshot's checkouts couldn't move in: a full setup", { taskId: record.ref.taskId, code: errorCode(error) });
      for (const repo of record.spec.repos) {
        await rm(path.join(record.workspaceDir, repo.checkoutDir), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
      return "fell-back";
    }
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    this.plumbing.logger.info("the box starts from its snapshot", { taskId: record.ref.taskId, snapshotId: wanted.snapshotId });
    return "used";
  }

  /**
   * A snapshot's checkout brought up to the task's start: every branch fetched through the git proxy,
   * and the default branch's current head checked out. What the setup made (ignored and untracked
   * files: the installed dependencies) stays, so the setup that runs next is incremental.
   */
  async #updateAdopted(record: BoxRecord, repo: TaskSpec["repos"][number], checkout: string): Promise<AdapterResult<void>> {
    for (const args of [
      ["config", "--local", "remote.origin.url", repo.cloneUrl],
      ["config", "--local", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      ["fetch", "--quiet", "--prune", "origin"],
      ["checkout", "--quiet", "--force", "-B", repo.defaultBranch, `refs/remotes/origin/${repo.defaultBranch}`],
    ]) {
      const ran = await this.#git(record, args, checkout);
      if (ran.code !== 0) {
        this.plumbing.logger.warn("updating the snapshot's checkout failed", { taskId: record.ref.taskId, repoId: repo.repoId, step: args[0] ?? "git" });
        return adapterError("unavailable", `updating ${repo.fullName}'s checkout from the snapshot failed${this.#reason(ran)}`);
      }
    }
    return ok(undefined);
  }

  // ---------- inside: the host cache and checks ----------

  #cacheDir(projectId: ProjectId): string {
    return path.join(this.#dataDir, "cache", projectFolder(projectId));
  }

  #mirrorOf(projectId: ProjectId, repoId: RepoId): string {
    return path.join(this.#cacheDir(projectId), `${repoId.replace(/[^A-Za-z0-9._-]/g, "_")}.git`);
  }

  /** The spec's host cache for a box, made fresh; `null` when the spec names none or it couldn't be made. */
  async #useCache(
    record: BoxRecord,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly projectId: ProjectId; readonly prepared: PreparedCache } | null> {
    const snapshot = record.spec.snapshot ?? null;
    if (snapshot?.kind !== "host-cache") {
      return null;
    }
    const prepared = await this.prepareCache({
      projectId: record.spec.projectId,
      cacheKey: snapshot.cacheKey,
      repos: record.spec.repos.map((repo) => ({ repoId: repo.repoId, cloneUrl: repo.cloneUrl })),
      proxies: record.proxies,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!prepared.ok) {
      // The cache makes a setup fast and never fails it: the box clones and installs in full.
      this.plumbing.logger.warn("the host cache wasn't prepared", {
        taskId: record.ref.taskId,
        projectId: record.spec.projectId,
        code: prepared.error.code,
      });
      return null;
    }
    // A runner that stays up for months still lets go of a cache no task uses (F-051).
    if (Date.now() - this.#lastSweep >= SWEEP_EVERY_MS) {
      void this.sweepIdleCaches().catch(() => 0);
    }
    return { projectId: record.spec.projectId, prepared: prepared.value };
  }

  async #refreshCache(input: PrepareCacheInput): Promise<AdapterResult<PreparedCache>> {
    const dir = this.#cacheDir(input.projectId);
    const deps = path.join(dir, "deps");
    const keyFile = path.join(dir, "cache-key");
    const gitConfig = path.join(dir, "gitconfig");
    try {
      await mkdir(dir, { recursive: true });
      const keptKey = (await readFile(keyFile, "utf8").catch(() => "")).trim();
      const depsThere = (await stat(deps).catch(() => null))?.isDirectory() === true;
      let reused = keptKey === input.cacheKey && depsThere;
      if (keptKey !== input.cacheKey) {
        await rm(deps, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
      await mkdir(deps, { recursive: true });
      // The mirrors' own global config: empty, so the member's never applies.
      await writeFile(gitConfig, "");
      for (const repo of input.repos) {
        const mirror = this.#mirrorOf(input.projectId, repo.repoId);
        if ((await stat(path.join(mirror, "HEAD")).catch(() => null)) === null) {
          reused = false;
          await rm(mirror, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          for (const args of [
            ["init", "--quiet", "--bare", mirror],
            ["--git-dir", mirror, "config", "remote.origin.url", repo.cloneUrl],
            // The branches only: a task clones its default branch and fetches its own.
            ["--git-dir", mirror, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"],
          ]) {
            const made = await this.#cacheGit(dir, gitConfig, input.proxies, repo.cloneUrl, args, undefined);
            if (made.code !== 0) {
              return adapterError("unavailable", `making the mirror of ${repo.repoId} failed (exit ${String(made.code)})`);
            }
          }
        }
        const fetched = await this.#cacheGit(
          dir,
          gitConfig,
          input.proxies,
          repo.cloneUrl,
          ["--git-dir", mirror, "fetch", "--quiet", "--prune", "origin"],
          input.signal,
        );
        if (fetched.code !== 0) {
          return adapterError("unavailable", `fetching the mirror of ${repo.repoId} through the git proxy failed${this.#reason(fetched)}`);
        }
      }
      await writeFile(keyFile, input.cacheKey);
      const now = new Date();
      await writeFile(path.join(dir, "last-used"), now.toISOString());
      await utimes(path.join(dir, "last-used"), now, now);
      this.plumbing.logger.info("host cache prepared", { projectId: input.projectId, repos: input.repos.length, reused });
      return ok({ cacheKey: input.cacheKey, reused, dependencyCacheDir: deps });
    } catch (error) {
      return adapterError("unavailable", `couldn't prepare the host cache (${errorCode(error)})`);
    }
  }

  /** git on a project's mirrors: the code host's origin to the git proxy, no credential helper, nothing above the cache. */
  #cacheGit(
    cwd: string,
    gitConfig: string,
    proxies: PrepareCacheInput["proxies"],
    cloneUrl: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<RunResult> {
    const to = `${proxies.gitBaseUrl.replace(/\/+$/, "")}/`;
    const from = `${new URL(cloneUrl).origin}/`;
    return this.#processes.run("git", [...GIT_HARDENING, "-c", "credential.helper=", "-c", `url.${to}.insteadOf=${from}`, ...args], {
      cwd,
      env: {
        ...baseEnv(this.#env),
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_CEILING_DIRECTORIES: path.dirname(cwd),
      },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** One check: the admin's command line, run by the setup shell, in the task's unit; its timeout reaps the tree. */
  async #runCheck(shell: string, unit: ContainmentUnit | undefined, check: Parameters<RunOneCheck>[0]): Promise<Awaited<ReturnType<RunOneCheck>>> {
    const controller = new AbortController();
    // Set from the timer, so kept in an object the type checker doesn't narrow.
    const cut = { timedOut: false };
    const timer = setTimeout(() => {
      cut.timedOut = true;
      controller.abort();
    }, check.timeoutMs);
    const onAbort = (): void => {
      // The task stopping cuts the check short, as its timeout would.
      cut.timedOut = true;
      controller.abort();
    };
    check.signal?.addEventListener("abort", onAbort, { once: true });
    if (check.signal?.aborted === true) {
      onAbort();
    }
    try {
      const result = await this.#processes.run(shell, ["-c", check.command], {
        cwd: check.cwd,
        // The check's whole environment, plus the unit's marker the process-tree sweep finds it by.
        env: unit === undefined ? check.env : { ...check.env, [TASK_UNIT_ENV]: unit.marker },
        signal: controller.signal,
        ownGroup: true,
        maxBuffer: 0,
        ...(unit === undefined ? {} : { unit }),
        onOutput: (_stream, text) => {
          check.onOutput(text);
        },
      });
      // A program that never started: `runProgram` names why in its stderr, with no exit code.
      const error = result.code === null && !cut.timedOut ? result.stderr.trim().slice(0, 200) || "the check didn't start" : null;
      return { exitCode: result.code, timedOut: cut.timedOut, error };
    } finally {
      clearTimeout(timer);
      check.signal?.removeEventListener("abort", onAbort);
    }
  }

  // ---------- inside ----------

  /** The commit message file, with its trailers, and the task's bot, which `#commitLeft` makes each repo's own. */
  async #commitMessage(record: BoxRecord, input: CommitWorkInput): Promise<{ readonly file: string; readonly author: GitPerson }> {
    const file = path.join(record.root, "git", "commit-message.txt");
    await writeFile(file, commitMessageWithTrailers(input.message, input.coAuthors));
    return { file, author: input.author };
  }

  /** Commits everything the turn left in one repo: changed, new and untracked files (the env files are excluded). */
  /**
   * Commits what the turn left in one repo. With the spec's `commitPaths` (F-113, ADR 0038), only
   * the allowed paths: their changes are staged and committed, and the rest stay in the working
   * tree. When the branch's own commits (the agent's) already touch another path, its tip is rebuilt
   * as one commit on the base with the allowed paths' content: a mixed reset to the base keeps every
   * change in the tree, and only the allowed ones are committed again. Answers what was kept and left
   * out, or `null` when the spec commits everything.
   */
  async #commitLeft(
    record: BoxRecord,
    repo: TaskSpec["repos"][number],
    message: { readonly file: string; readonly author: GitPerson },
  ): Promise<AdapterResult<StagedCommitPaths | null>> {
    // F-136 (ADR 0065): the repo's own App's bot authors and commits it, the task's when it has none.
    const commit = { file: message.file, env: identityEnv(repoGitIdentity({ gitIdentity: message.author }, repo)) };
    const commitPaths = record.spec.commitPaths ?? null;
    if (commitPaths !== null) {
      return this.#commitAllowed(record, repo, commit, commitPaths);
    }
    const committedAll = await this.#commitAll(record, repo, commit);
    return committedAll.ok ? ok(null) : committedAll;
  }

  async #commitAll(
    record: BoxRecord,
    repo: TaskSpec["repos"][number],
    commit: { readonly file: string; readonly env: Readonly<Record<string, string>> },
  ): Promise<AdapterResult<void>> {
    const checkout = path.join(record.workspaceDir, repo.checkoutDir);
    const status = await this.#git(record, ["status", "--porcelain"], checkout);
    if (status.code !== 0) {
      return adapterError("unavailable", `reading ${repo.fullName}'s changes failed`);
    }
    if (status.stdout.trim().length > 0) {
      await this.#git(record, ["add", "--all"], checkout);
      const committed = await this.#git(record, ["commit", "--quiet", "--no-verify", "--file", commit.file], checkout, commit.env);
      if (committed.code !== 0) {
        return adapterError("unavailable", `committing ${repo.fullName}'s changes failed${this.#reason(committed)}`);
      }
    }
    return ok(undefined);
  }

  /** F-113: the commit of `#commitLeft` with `commitPaths`. Paths from git only; none is ever logged. */
  async #commitAllowed(
    record: BoxRecord,
    repo: TaskSpec["repos"][number],
    commit: { readonly file: string; readonly env: Readonly<Record<string, string>> },
    commitPaths: readonly string[],
  ): Promise<AdapterResult<StagedCommitPaths>> {
    const checkout = path.join(record.workspaceDir, repo.checkoutDir);
    const baseRef = `refs/remotes/origin/${repo.defaultBranch}`;
    const mergeBase = await this.#git(record, ["merge-base", "HEAD", baseRef], checkout);
    const base = gitShaSchema.safeParse(mergeBase.stdout.trim());
    if (mergeBase.code !== 0 || !base.success) {
      return adapterError("unavailable", `reading ${repo.fullName}'s base failed`);
    }
    const branchPaths = async (): Promise<readonly string[] | null> => {
      const diff = await this.#git(record, ["diff", "--name-only", "--no-renames", "-z", base.data, "HEAD"], checkout);
      return diff.code === 0 ? diff.stdout.split("\0").filter((entry) => entry !== "") : null;
    };
    // 1. The branch's own commits: one that touched another path is undone, its changes kept in the tree.
    const committed = await branchPaths();
    if (committed === null) {
      return adapterError("unavailable", `reading ${repo.fullName}'s commits failed`);
    }
    const rebuilt = splitByCommitPaths(committed, commitPaths).dropped.length > 0;
    if (rebuilt) {
      const reset = await this.#git(record, ["reset", "--quiet", "--mixed", base.data], checkout);
      if (reset.code !== 0) {
        return adapterError("unavailable", `rebuilding ${repo.fullName}'s branch on its base failed`);
      }
    }
    // 2. The tree's changes: only the allowed ones are staged and committed.
    const status = await this.#git(record, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], checkout);
    if (status.code !== 0) {
      return adapterError("unavailable", `reading ${repo.fullName}'s changes failed`);
    }
    const split = splitByCommitPaths(porcelainZPaths(status.stdout), commitPaths);
    for (let start = 0; start < split.kept.length; start += 200) {
      // A pathspec of its own per path, read literally, so a path's own `*` isn't a glob to git.
      const added = await this.#git(record, ["add", "--all", "--", ...split.kept.slice(start, start + 200).map((file) => `:(literal)${file}`)], checkout);
      if (added.code !== 0) {
        return adapterError("unavailable", `staging ${repo.fullName}'s allowed changes failed`);
      }
    }
    const staged = await this.#git(record, ["diff", "--cached", "--quiet"], checkout);
    if (staged.code === 1) {
      const made = await this.#git(record, ["commit", "--quiet", "--no-verify", "--file", commit.file], checkout, commit.env);
      if (made.code !== 0) {
        return adapterError("unavailable", `committing ${repo.fullName}'s allowed changes failed${this.#reason(made)}`);
      }
    }
    // 3. What the branch holds now, against its base: the allowed paths only.
    const kept = (await branchPaths()) ?? [];
    this.plumbing.logger.info("commit filtered", { taskId: record.ref.taskId, repoId: repo.repoId, kept: kept.length, dropped: split.dropped.length, rebuilt });
    return ok({
      kept: kept.slice(0, runnerLimits.commitFilteredPathsMax),
      dropped: split.dropped.slice(0, runnerLimits.commitFilteredPathsMax),
      droppedCount: split.dropped.length,
    });
  }

  /** A checkout's head, or `null` when it has none or can't be read. */
  async #headOf(record: BoxRecord, repo: TaskSpec["repos"][number]): Promise<string | null> {
    const head = await this.#git(record, ["rev-parse", "--verify", "--quiet", "HEAD"], path.join(record.workspaceDir, repo.checkoutDir));
    const sha = gitShaSchema.safeParse(head.stdout.trim());
    return head.code === 0 && sha.success ? sha.data : null;
  }

  /** Each repo's head now: where the next turn's changes are measured from. */
  async #recordHeads(record: BoxRecord): Promise<void> {
    for (const repo of record.spec.repos) {
      const head = await this.#headOf(record, repo);
      if (head === null) {
        record.turnBase.delete(repo.repoId);
      } else {
        record.turnBase.set(repo.repoId, head);
      }
    }
  }

  async #endAgent(record: BoxRecord, graceMs: number): Promise<void> {
    const agent = record.agent;
    if (agent === undefined) {
      return;
    }
    record.agent = undefined;
    // A chance to exit on its own (its stdin closes), then the task's whole unit.
    agent.stdinEnd();
    const quit = await Promise.race([agent.exited.then(() => true), new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, graceMs);
      })]);
    await record.unit?.killAll();
    if (!quit) {
      await Promise.race([agent.exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    this.plumbing.logger.info("agent ended", { taskId: record.ref.taskId, boxId: record.ref.boxId, exitedInGrace: quit });
  }

  #reason(result: RunResult): string {
    const text = `${result.stdout}\n${result.stderr}`;
    const own = ostraLines(text);
    if (own.length > 0) {
      return `: ${own}`;
    }
    // Not the proxy's refusal: the code host's own, such as GitHub's on a workflow file (Q122).
    const host = codeHostRefusal(text);
    return host === null ? ` (exit ${String(result.code)})` : `: ${host}`;
  }

  /**
   * git with the task's own config: never the member's global one, never the system's.
   *
   * It runs through the processes seam, not in this process. On `docker` a checkout is on the volume
   * the agent writes, so its config, hooks and filters are the agent's to set, and any of them can
   * run a program when git reads the repo (`core.fsmonitor` on `status`, a filter driver on `add`, a
   * hook on `commit`). That program must run in the agent's container, which holds no credential,
   * and never in the sidecar, which does (ADR 0030). On `host` the seam is this machine, as before.
   *
   * Git never looks for a repository above the task's workspace (spike 2, gotcha 12): a command
   * that missed its checkout fails instead of acting on whatever repo holds the runner's folder.
   */
  #git(record: BoxRecord, args: readonly string[], cwd: string, extra: Readonly<Record<string, string>> = {}): Promise<RunResult> {
    return this.#processes.run("git", [...GIT_HARDENING, ...args], {
      cwd,
      env: {
        ...baseEnv(this.#env),
        GIT_CONFIG_GLOBAL: record.gitConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        ...extra,
        GIT_CEILING_DIRECTORIES: record.workspaceDir,
      },
    });
  }

  /** The shared work-in-progress steps' git, bound to one checkout of the box. */
  #wip(record: BoxRecord, checkout: string): WipDeps {
    return { git: (args, env) => this.#git(record, args, checkout, env ?? {}), files: localWipFiles };
  }

  async #hasLfs(): Promise<boolean> {
    if (this.#lfs === undefined) {
      await mkdir(this.#dataDir, { recursive: true });
      this.#lfs = (await this.#processes.run("git", ["lfs", "version"], { cwd: this.#dataDir, env: baseEnv(this.#env) })).code === 0;
    }
    return this.#lfs;
  }

  /** The insteadOf rules: each repo's code host origin, to the git proxy. */
  #insteadOf(record: BoxRecord): readonly { readonly from: string; readonly to: string }[] {
    const origins = [...new Set(record.spec.repos.map((repo) => `${new URL(repo.cloneUrl).origin}/`))];
    const to = `${record.proxies.gitBaseUrl.replace(/\/+$/, "")}/`;
    return origins.map((from) => ({ from, to }));
  }

  /**
   * Settings both the task's git config and each checkout's local config get, with the bot given:
   * the task's in the task's config, and each repo's own in its checkout (F-136), which outranks it.
   */
  async #settings(record: BoxRecord, person: GitPerson): Promise<readonly (readonly [string, string])[]> {
    const settings: (readonly [string, string])[] = [
      ...identitySettings(person),
      // No credential helper: the proxy adds the token, and nothing should ask for one.
      ["credential.helper", ""],
      ["advice.detachedHead", "false"],
      // Windows stops git at 260 characters unless it is told otherwise: a deep file in a checkout,
      // or a branch's ref lock under a long data folder, fails with "cannot lock ref". Harmless elsewhere.
      ["core.longpaths", "true"],
    ];
    for (const rule of this.#insteadOf(record)) {
      settings.push([`url.${rule.to}.insteadOf`, rule.from]);
    }
    if (await this.#hasLfs()) {
      settings.push(
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["filter.lfs.process", "git-lfs filter-process"],
        ["filter.lfs.required", "true"],
      );
    }
    return settings;
  }

  async #writeTaskGitConfig(record: BoxRecord): Promise<void> {
    await writeFile(record.gitConfig, "");
    for (const [key, value] of await this.#settings(record, record.spec.gitIdentity)) {
      const set = await runProgram("git", ["config", "--file", record.gitConfig, key, value], { cwd: record.root, env: baseEnv(this.#env) });
      if (set.code !== 0) {
        throw new Error(`git config ${key} failed`);
      }
    }
  }

  async #configureCheckout(record: BoxRecord, checkout: string, repo: TaskSpec["repos"][number]): Promise<AdapterResult<void>> {
    // The same settings locally, so the agent's own git (with its own environment) still goes
    // through the proxy, as the bot of this repo's App (F-136), with no credential helper.
    for (const [key, value] of await this.#settings(record, repoGitIdentity(record.spec, repo))) {
      const set = await this.#git(record, ["config", "--local", key, value], checkout);
      if (set.code !== 0) {
        return adapterError("unavailable", `configuring the checkout failed (${key})`);
      }
    }
    // Milestone 6 (F-100, ticket 22): a review task's repo sits at its PR's head, detached, with the base fetched too.
    const reviewed = reviewRepoOf(record.spec, repo.repoId);
    if (reviewed !== null) {
      const atHead = await this.#checkoutReviewHead(record, checkout, reviewed);
      if (!atHead.ok) {
        return atHead;
      }
    } else {
      const branch = repoBranchName(record.spec, repo);
      const defaultBranch = repo.defaultBranch;
      const remote = await this.#git(record, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], checkout);
      const checkedOut =
        remote.code === 0
          ? await this.#git(record, ["checkout", "--quiet", "-b", branch, `refs/remotes/origin/${branch}`], checkout)
          : await this.#git(record, ["checkout", "--quiet", "-b", branch, `refs/remotes/origin/${defaultBranch}`], checkout);
      if (checkedOut.code !== 0) {
        return adapterError("unavailable", "checking out the task's branch failed");
      }
    }
    const gitDir = path.join(checkout, ".git");
    // ostra's own folder (`.ostra/`: the ticket's files, ticket 26) never lands in a commit or the hidden ref.
    await excludeFromGit(gitDir, [OSTRA_DIR]);
    const hook = path.join(gitDir, "hooks", "prepare-commit-msg");
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, PREPARE_COMMIT_MSG_HOOK);
    await chmod(hook, 0o755);
    await writeFile(path.join(gitDir, "ostra-trailers"), record.spec.coAuthors.map((person) => `${coAuthorTrailer(person)}\n`).join(""));
    return ok(undefined);
  }

  /**
   * Milestone 6 (F-100, ADR 0058): a review task's checkout of one repo. The PR's head and its base
   * are fetched by SHA through the git proxy (read-only, as for any fetch), and the head is checked
   * out detached, so the agent can diff `baseSha...headSha` and has no branch to commit on. A head
   * the remote doesn't give by SHA comes from the PR's own ref, `refs/pull/<number>/head`.
   */
  async #checkoutReviewHead(record: BoxRecord, checkout: string, reviewed: TaskSpecReviewRepo): Promise<AdapterResult<void>> {
    const has = async (sha: string): Promise<boolean> => (await this.#git(record, ["cat-file", "-e", `${sha}^{commit}`], checkout)).code === 0;
    for (const sha of [reviewed.headSha, reviewed.baseSha]) {
      if (await has(sha)) {
        continue;
      }
      const bySha = await this.#git(record, ["fetch", "--quiet", "--no-tags", "origin", sha], checkout);
      if (bySha.code !== 0 || !(await has(sha))) {
        await this.#git(record, ["fetch", "--quiet", "--no-tags", "origin", `+refs/pull/${String(reviewed.prNumber)}/head:refs/remotes/origin/pull/${String(reviewed.prNumber)}`], checkout);
      }
      if (!(await has(sha))) {
        this.plumbing.logger.warn("a review head couldn't be fetched", { taskId: record.ref.taskId, repoId: reviewed.repoId, prNumber: reviewed.prNumber });
        return adapterError("unavailable", `fetching pull request #${String(reviewed.prNumber)}'s ${sha === reviewed.headSha ? "head" : "base"} through the git proxy failed`);
      }
    }
    const detached = await this.#git(record, ["checkout", "--quiet", "--force", "--detach", reviewed.headSha], checkout);
    if (detached.code !== 0) {
      return adapterError("unavailable", `checking out pull request #${String(reviewed.prNumber)}'s head failed`);
    }
    // The base as a ref of its own, so `git diff ostra/base...HEAD` reads it by name.
    await this.#git(record, ["update-ref", "refs/ostra/review-base", reviewed.baseSha], checkout);
    return ok(undefined);
  }

  async #writeEnvironment(
    record: BoxRecord,
    repoId: TaskSpec["repos"][number]["repoId"],
    checkout: string,
    secrets: readonly RepoSecret[],
  ): Promise<AdapterResult<void>> {
    const environment = record.spec.environment.repos.find((entry) => entry.repoId === repoId);
    const variables = [
      ...(environment?.variables ?? []).map((variable) => ({ name: variable.name, value: variable.value })),
      ...secrets.flatMap((secret) => (secret.kind === "variable" ? [{ name: secret.name, value: secret.value }] : [])),
    ];
    const files = [
      ...(environment?.files ?? []),
      ...secrets.flatMap((secret) => (secret.kind === "file" ? [{ path: secret.path, content: secret.content }] : [])),
    ];
    const written: string[] = [];
    const envFile = environment?.envFile ?? ".env";
    if (variables.length > 0) {
      const target = insideCheckout(checkout, envFile);
      if (target === null) {
        return adapterError("invalid-input", "the env file's path leaves the checkout");
      }
      await writeCheckoutFile(target, renderEnvFile(variables));
      written.push(envFile);
    }
    for (const file of files) {
      const target = insideCheckout(checkout, file.path);
      if (target === null) {
        return adapterError("invalid-input", "an environment file's path leaves the checkout");
      }
      await writeCheckoutFile(target, file.content);
      written.push(file.path);
    }
    // Keep every file ostra wrote out of git, whatever the repo's own .gitignore says.
    const notIgnored: string[] = [];
    for (const relative of written) {
      const ignored = await this.#git(record, ["check-ignore", "--quiet", "--", relative], checkout);
      if (ignored.code !== 0) {
        notIgnored.push(relative);
      }
    }
    await excludeFromGit(path.join(checkout, ".git"), notIgnored);
    return ok(undefined);
  }

  async #runSetup(record: BoxRecord, input: PrepareInput, dependencyCacheDir: string | null): Promise<AdapterResult<PrepareResult["setup"]>> {
    const script = record.spec.environment.setupScript;
    if (script === null || script.trim().length === 0) {
      return ok(null);
    }
    const file = path.join(record.root, "setup", "setup.sh");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, script.replace(/\r\n/g, "\n"));
    const setupShell = await this.#resolveShell();
    if (setupShell.kind === "missing") {
      return adapterError("unavailable", setupShell.reason);
    }
    const started = Date.now();
    let exitCode: number | null = 0;
    for (const repo of record.spec.repos) {
      const environment = record.spec.environment.repos.find((entry) => entry.repoId === repo.repoId);
      const secrets = input.secrets.find((entry) => entry.repoId === repo.repoId)?.entries ?? [];
      const env: Record<string, string> = {
        ...baseEnv(this.#env),
        // The project's dependency cache, for the package managers and the script (F-051).
        ...(dependencyCacheDir === null ? {} : dependencyCacheEnv(dependencyCacheDir)),
        OSTRA_REPO: repo.fullName,
      };
      if (record.unit !== undefined) {
        env[TASK_UNIT_ENV] = record.unit.marker;
      }
      for (const variable of environment?.variables ?? []) {
        if (variable.availableDuringSetup) {
          env[variable.name] = variable.value;
        }
      }
      for (const secret of secrets) {
        if (secret.kind === "variable" && secret.availableDuringSetup) {
          env[secret.name] = secret.value;
        }
      }
      // The script as a file, run by the shell with an argument array: never a command string.
      const result = await this.#processes.run(setupShell.command, [file.split(path.sep).join("/")], {
        cwd: path.join(record.workspaceDir, repo.checkoutDir),
        env,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(record.unit === undefined ? {} : { unit: record.unit }),
        maxBuffer: 0,
        onOutput: (stream, text) => {
          for (const piece of splitOutput(text)) {
            input.onSetupOutput(stream, piece);
          }
        },
      });
      exitCode = result.code;
      if (result.code !== 0) {
        break;
      }
    }
    return ok({ exitCode, durationMs: Date.now() - started });
  }
}
