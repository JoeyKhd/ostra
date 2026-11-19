import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { adapterError, ExecutorAdapter, ok } from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterResult,
  AgentLaunch,
  AgentProcess,
  BoxRef,
  CommitAndPushInput,
  CreateBoxInput,
  CreatedBox,
  ExecutorCapabilities,
  HealthReport,
  PrepareInput,
  PrepareResult,
  ProcessExit,
  RepoPushResult,
  StopInput,
  TaskProxies,
} from "@ostra/adapter-sdk";
import { gitShaSchema, SETUP_OUTPUT_MAX_CHARS } from "@ostra/protocol";
import type { BoxState, GitPerson, RepoSecret, TaskId, TaskSpec } from "@ostra/protocol";
import { detectContainment, processTreeContainment } from "./containment.ts";
import { localProcesses } from "./task-processes.ts";
import type { TaskProcesses } from "./task-processes.ts";
import type { Containment, ContainmentUnit } from "./containment.ts";
import { excludeFromGit, insideCheckout, renderEnvFile, writeCheckoutFile } from "./env-file.ts";
import { baseEnv, ostraLines, runProgram } from "./process.ts";
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
//
// Its differences from `docker` are ADR 0029's allowed ones, declared in `capabilities`: no
// isolation, no services, no box sizes, no snapshots, and process containment by the tree (or a
// cgroup on Linux) instead of a container.

export type HostExecutorOptions = {
  /** The runner's data folder: task roots go in `tasks/`. */
  readonly dataDir: string;
  /** The shell setup scripts run with, from PATH (`OSTRA_RUNNER_SHELL`, default `bash`). */
  readonly shell?: string;
  /** How a task's processes end together. Default: detected (a cgroup on Linux when allowed). */
  readonly containment?: Containment;
  /** Where the agent and the setup script run (spike 3's `AgentHost` seam). Default: this machine. */
  readonly processes?: TaskProcesses;
  /** What the executor declares about containment, when `processes` isn't this machine's. */
  readonly processContainment?: ExecutorCapabilities["processContainment"];
  /** Where the base environment's variables come from. Default: this process's. */
  readonly env?: NodeJS.ProcessEnv;
};

type RunningAgent = {
  readonly pid: number | null;
  readonly exited: Promise<ProcessExit>;
  readonly unit: ContainmentUnit;
  readonly stdinEnd: () => void;
};

type BoxRecord = {
  readonly ref: BoxRef;
  state: BoxState;
  readonly root: string;
  readonly workspaceDir: string;
  readonly agentDir: string;
  readonly gitConfig: string;
  readonly spec: TaskSpec;
  readonly proxies: TaskProxies;
  agent: RunningAgent | undefined;
};

const boxKey = (box: BoxRef): string => `${box.taskId}\u0000${box.boxId}`;

/** A folder name for a task's root: its ID, with anything odd replaced. */
const folderOf = (taskId: TaskId): string => taskId.replace(/[^A-Za-z0-9._-]/g, "_");

/** A `Co-authored-by` trailer, as git and GitHub read it. */
export const coAuthorTrailer = (person: GitPerson): string => `Co-authored-by: ${person.name} <${person.email}>`;

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
 * `core.hooksPath`: the `prepare-commit-msg` hook below is how every commit gets its trailers.
 */
const GIT_HARDENING = ["-c", "core.fsmonitor=false", "-c", "core.sshCommand=", "-c", "protocol.ext.allow=never"] as const;

/** Setup output split so no piece passes the event's cap. */
const splitOutput = (text: string): readonly string[] => {
  const pieces: string[] = [];
  for (let index = 0; index < text.length; index += SETUP_OUTPUT_MAX_CHARS) {
    pieces.push(text.slice(index, index + SETUP_OUTPUT_MAX_CHARS));
  }
  return pieces;
};

export class HostExecutor extends ExecutorAdapter {
  readonly name = "host";
  readonly capabilities: ExecutorCapabilities;

  readonly #dataDir: string;
  readonly #shell: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #boxes = new Map<string, BoxRecord>();
  #containment: Containment | undefined;
  readonly #processes: TaskProcesses;
  #lfs: boolean | undefined;

  /** Use `HostExecutor.start` to get the containment this machine allows; this constructor uses the one given. */
  constructor(options: HostExecutorOptions, context?: AdapterContext) {
    super(context);
    this.#dataDir = options.dataDir;
    this.#shell = options.shell ?? "bash";
    this.#env = options.env ?? process.env;
    this.#containment = options.containment;
    this.#processes =
      options.processes ??
      localProcesses(() => {
        this.#containment ??= processTreeContainment();
        return this.#containment;
      });
    const kind = options.processContainment ?? options.containment?.kind ?? "process-tree";
    this.capabilities = { isolation: "none", services: false, boxSizes: false, snapshots: false, processContainment: kind };
  }

  /** A host executor with the best containment this machine allows (ADR 0029, Q126). */
  static async start(options: Omit<HostExecutorOptions, "containment">, context?: AdapterContext): Promise<HostExecutor> {
    return new HostExecutor({ ...options, containment: await detectContainment() }, context);
  }

  async health(): Promise<HealthReport> {
    const env = baseEnv(this.#env);
    await mkdir(this.#dataDir, { recursive: true });
    const git = await runProgram("git", ["--version"], { cwd: this.#dataDir, env });
    if (git.code !== 0) {
      return { status: "down", reason: "git isn't on PATH" };
    }
    const shell = await runProgram(this.#shell, ["--version"], { cwd: this.#dataDir, env });
    if (shell.code !== 0) {
      return { status: "down", reason: `the setup shell (${this.#shell}) isn't on PATH; set OSTRA_RUNNER_SHELL` };
    }
    return { status: "ok" };
  }

  async create(input: CreateBoxInput): Promise<AdapterResult<CreatedBox>> {
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
      agent: undefined,
    };
    this.#boxes.set(key, record);
    try {
      // A task root is never reused: anything left from an earlier box of this task goes first.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      await mkdir(record.workspaceDir, { recursive: true });
      await mkdir(record.agentDir, { recursive: true });
      await mkdir(path.dirname(record.gitConfig), { recursive: true });
      await this.#writeTaskGitConfig(record);
    } catch (error) {
      record.state = "failed";
      return adapterError("unavailable", `couldn't make the task's folder (${error instanceof Error ? error.name : "unknown"})`);
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
    for (const repo of record.spec.repos) {
      const checkout = path.join(record.workspaceDir, repo.checkoutDir);
      const cloned = await this.#git(record, ["clone", "--quiet", "--origin", "origin", "--branch", repo.defaultBranch, repo.cloneUrl, checkout], record.workspaceDir);
      if (cloned.code !== 0) {
        record.state = "failed";
        log.warn("clone failed", { repoId: repo.repoId, code: cloned.code });
        return adapterError("unavailable", `cloning ${repo.fullName} through the git proxy failed${this.#reason(cloned)}`);
      }
      const configured = await this.#configureCheckout(record, checkout, repo.defaultBranch);
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
    const setup = await this.#runSetup(record, input);
    if (!setup.ok) {
      record.state = "failed";
      return setup;
    }
    record.state = "ready";
    log.info("box ready", { setupExitCode: setup.value?.exitCode ?? null });
    return ok({ setup: setup.value });
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
    const started = await this.#processes.startAgent(launch, `${record.ref.taskId}-${record.ref.boxId}`);
    if (!started.ok) {
      return adapterError("unavailable", `the agent's process didn't start (${started.reason})`);
    }
    const { process: agentProcess, unit, stdinEnd } = started.value;
    const pid = agentProcess.pid;
    const exited = agentProcess.exited;
    record.agent = { pid, exited, unit, stdinEnd };
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
    const messageFile = path.join(record.root, "git", "commit-message.txt");
    await writeFile(messageFile, commitMessageWithTrailers(input.message, input.coAuthors));
    const authorEnv = {
      GIT_AUTHOR_NAME: input.author.name,
      GIT_AUTHOR_EMAIL: input.author.email,
      GIT_COMMITTER_NAME: input.author.name,
      GIT_COMMITTER_EMAIL: input.author.email,
    };
    for (const repo of record.spec.repos) {
      const checkout = path.join(record.workspaceDir, repo.checkoutDir);
      const status = await this.#git(record, ["status", "--porcelain"], checkout);
      if (status.code !== 0) {
        return adapterError("unavailable", `reading ${repo.fullName}'s changes failed`);
      }
      if (status.stdout.trim().length > 0) {
        // Everything the agent left: changed, new and untracked files (the env files are excluded).
        await this.#git(record, ["add", "--all"], checkout);
        const committed = await this.#git(record, ["commit", "--quiet", "--no-verify", "--file", messageFile], checkout, authorEnv);
        if (committed.code !== 0) {
          return adapterError("unavailable", `committing ${repo.fullName}'s changes failed${this.#reason(committed)}`);
        }
      }
      const count = await this.#git(record, ["rev-list", "--count", `refs/remotes/origin/${repo.defaultBranch}..HEAD`], checkout);
      const ahead = count.code === 0 && Number(count.stdout.trim()) > 0;
      if (!ahead) {
        results.push({ repoId: repo.repoId, headSha: null, ahead: false });
        continue;
      }
      const head = gitShaSchema.safeParse((await this.#git(record, ["rev-parse", "HEAD"], checkout)).stdout.trim());
      // Both refs in one push: the git proxy takes all or nothing. The branch is the task's own, so a
      // history the agent rewrote is pushed as it is.
      const pushed = await this.#git(
        record,
        ["push", "--quiet", "--porcelain", "origin", `+HEAD:refs/heads/${input.branchName}`, `+HEAD:${input.hiddenRef}`],
        checkout,
      );
      if (pushed.code !== 0 || !head.success) {
        this.plumbing.logger.warn("push failed", { taskId: record.ref.taskId, repoId: repo.repoId, code: pushed.code });
        return adapterError("unavailable", `pushing ${repo.fullName} through the git proxy failed${this.#reason(pushed)}`);
      }
      results.push({ repoId: repo.repoId, headSha: head.data, ahead: true });
    }
    this.plumbing.logger.info("pushed", { taskId: record.ref.taskId, ahead: results.filter((item) => item.ahead).length });
    return ok(results);
  }

  async stop(input: StopInput): Promise<AdapterResult<void>> {
    const record = this.#boxes.get(boxKey(input.box));
    if (record === undefined) {
      return ok(undefined);
    }
    await this.#endAgent(record, input.graceMs);
    if (record.state !== "released") {
      record.state = "stopped";
    }
    return ok(undefined);
  }

  async release(box: BoxRef): Promise<AdapterResult<void>> {
    const record = this.#boxes.get(boxKey(box));
    if (record === undefined) {
      return ok(undefined);
    }
    await this.#endAgent(record, 0);
    try {
      await rm(record.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      return adapterError("unavailable", `couldn't remove the task's folder (${error instanceof Error ? error.name : "unknown"})`);
    }
    record.state = "released";
    this.#boxes.delete(boxKey(box));
    this.plumbing.logger.info("box released", { taskId: box.taskId, boxId: box.boxId });
    return ok(undefined);
  }

  state(box: BoxRef): Promise<AdapterResult<BoxState>> {
    return Promise.resolve(ok(this.#boxes.get(boxKey(box))?.state ?? "released"));
  }

  // ---------- inside ----------

  async #endAgent(record: BoxRecord, graceMs: number): Promise<void> {
    const agent = record.agent;
    if (agent === undefined) {
      return;
    }
    record.agent = undefined;
    // A chance to exit on its own (its stdin closes), then the whole tree.
    agent.stdinEnd();
    const quit = await Promise.race([agent.exited.then(() => true), new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, graceMs);
      })]);
    await agent.unit.killAll();
    if (!quit) {
      await Promise.race([agent.exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    await agent.unit.dispose();
    this.plumbing.logger.info("agent ended", { taskId: record.ref.taskId, boxId: record.ref.boxId, exitedInGrace: quit });
  }

  #reason(result: RunResult): string {
    const own = ostraLines(`${result.stdout}\n${result.stderr}`);
    return own.length > 0 ? `: ${own}` : ` (exit ${String(result.code)})`;
  }

  /**
   * git with the task's own config: never the member's global one, never the system's.
   *
   * It runs through the processes seam, not in this process. On `docker` a checkout is on the volume
   * the agent writes, so its config, hooks and filters are the agent's to set, and any of them can
   * run a program when git reads the repo (`core.fsmonitor` on `status`, a filter driver on `add`, a
   * hook on `commit`). That program must run in the agent's container, which holds no credential,
   * and never in the sidecar, which does (ADR 0030). On `host` the seam is this machine, as before.
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
      },
    });
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

  /** Settings both the task's git config and each checkout's local config get. */
  async #settings(record: BoxRecord): Promise<readonly (readonly [string, string])[]> {
    const settings: [string, string][] = [
      ["user.name", record.spec.gitIdentity.name],
      ["user.email", record.spec.gitIdentity.email],
      // No credential helper: the proxy adds the token, and nothing should ask for one.
      ["credential.helper", ""],
      ["advice.detachedHead", "false"],
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
    for (const [key, value] of await this.#settings(record)) {
      const set = await runProgram("git", ["config", "--file", record.gitConfig, key, value], { cwd: record.root, env: baseEnv(this.#env) });
      if (set.code !== 0) {
        throw new Error(`git config ${key} failed`);
      }
    }
  }

  async #configureCheckout(record: BoxRecord, checkout: string, defaultBranch: string): Promise<AdapterResult<void>> {
    // The same settings locally, so the agent's own git (with its own environment) still goes
    // through the proxy, as the App's bot, with no credential helper.
    for (const [key, value] of await this.#settings(record)) {
      const set = await this.#git(record, ["config", "--local", key, value], checkout);
      if (set.code !== 0) {
        return adapterError("unavailable", `configuring the checkout failed (${key})`);
      }
    }
    const branch = record.spec.branchName;
    const remote = await this.#git(record, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], checkout);
    const checkedOut =
      remote.code === 0
        ? await this.#git(record, ["checkout", "--quiet", "-b", branch, `refs/remotes/origin/${branch}`], checkout)
        : await this.#git(record, ["checkout", "--quiet", "-b", branch, `refs/remotes/origin/${defaultBranch}`], checkout);
    if (checkedOut.code !== 0) {
      return adapterError("unavailable", "checking out the task's branch failed");
    }
    const gitDir = path.join(checkout, ".git");
    const hook = path.join(gitDir, "hooks", "prepare-commit-msg");
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, PREPARE_COMMIT_MSG_HOOK);
    await chmod(hook, 0o755);
    await writeFile(path.join(gitDir, "ostra-trailers"), record.spec.coAuthors.map((person) => `${coAuthorTrailer(person)}\n`).join(""));
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

  async #runSetup(record: BoxRecord, input: PrepareInput): Promise<AdapterResult<PrepareResult["setup"]>> {
    const script = record.spec.environment.setupScript;
    if (script === null || script.trim().length === 0) {
      return ok(null);
    }
    const file = path.join(record.root, "setup", "setup.sh");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, script.replace(/\r\n/g, "\n"));
    const started = Date.now();
    let exitCode: number | null = 0;
    for (const repo of record.spec.repos) {
      const environment = record.spec.environment.repos.find((entry) => entry.repoId === repo.repoId);
      const secrets = input.secrets.find((entry) => entry.repoId === repo.repoId)?.entries ?? [];
      const env: Record<string, string> = { ...baseEnv(this.#env), OSTRA_REPO: repo.fullName };
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
      const result = await this.#processes.run(this.#shell, [file.split(path.sep).join("/")], {
        cwd: path.join(record.workspaceDir, repo.checkoutDir),
        env,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
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
