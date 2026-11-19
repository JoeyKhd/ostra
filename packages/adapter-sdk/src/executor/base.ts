import type { Readable, Writable } from "node:stream";

import type {
  BoxId,
  BoxReleaseReason,
  BoxState,
  GitPerson,
  GitSha,
  HiddenRefRestore,
  ProjectId,
  RepoId,
  RepoSecret,
  SnapshotBuildEnvironment,
  SnapshotCredentials,
  SnapshotFailureReason,
  SnapshotId,
  TaskId,
  TaskSpec,
} from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import { adapterError } from "../common/result.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import type { AgentCommand, AgentLaunch } from "../agent/base.ts";
import type { ExecutorCapabilities } from "./capabilities.ts";
import type { CheckRunResult, RunChecksInput } from "./checks.ts";

// The executor kind (ADR 0025, ADR 0029): `docker`, `host`, then `kubernetes`. It runs in the
// runner and gives each task its place to run. The same task code drives every executor, so a
// task behaves the same on all of them (runner parity, AGENTS.md).

/** Which box an operation is about. The adapter keeps its own state for each. */
export type BoxRef = { readonly taskId: TaskId; readonly boxId: BoxId };

/** The addresses the sidecar's work listens on, which the box's git and agent are pointed at. */
export type TaskProxies = {
  /** The git proxy: repos are cloned and pushed through it, with no token in the box. */
  readonly gitBaseUrl: string;
  /** The key proxy, in front of the model provider. */
  readonly modelBaseUrl: string;
  /** ostra's MCP tools for the task. */
  readonly mcpUrl: string;
};

export type CreateBoxInput = BoxRef & {
  readonly spec: TaskSpec;
  readonly proxies: TaskProxies;
};

/** Where the box's workspace is, as the agent sees it. */
export type CreatedBox = {
  /** The repos side by side (F-016). */
  readonly workspaceDir: string;
  /** The agent's own folder for its config, data and cache. */
  readonly agentDir: string;
  /**
   * The task's own global git config: the credential helper cleared and the code host's origin
   * rewritten to the git proxy. The agent's launch environment points `GIT_CONFIG_GLOBAL` at it
   * (see `gitGuardEnv`), so git run by the agent outside a checkout talks to the proxy only.
   * A path the agent's process can read: in a container, the same path as on the executor.
   */
  readonly gitConfig: string;
};

/** The names `gitGuardEnv` sets: an agent's launch environment takes them from the runner only. */
export const GIT_GUARD_ENV_NAMES = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_TERMINAL_PROMPT",
  "GCM_INTERACTIVE",
] as const;

/**
 * The git environment every agent process gets (ADR 0029): the task's config as the global one, no
 * system config (on Git for Windows it sets `credential.helper=manager`, the member's stored
 * credential), and no credential helper from any source, so git reaches the git proxy and nothing else.
 */
export const gitGuardEnv = (gitConfig: string): Readonly<Record<(typeof GIT_GUARD_ENV_NAMES)[number], string>> => ({
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
});

export type PrepareInput = {
  readonly box: BoxRef;
  readonly spec: TaskSpec;
  /** The environment's secrets per repo, from the task credentials: written into each repo's checkout only. */
  readonly secrets: readonly { readonly repoId: RepoId; readonly entries: readonly RepoSecret[] }[];
  /** The setup script's output, as it comes. It becomes `environment.setup_output` events. */
  readonly onSetupOutput: (stream: "stdout" | "stderr", text: string) => void;
  readonly signal?: AbortSignal;
};

export type PrepareResult = {
  /** `null` when the environment has no setup script. */
  readonly setup: { readonly exitCode: number | null; readonly durationMs: number } | null;
};

export type ProcessExit = { readonly code: number | null; readonly signal: string | null };

/** The agent's process, wherever it runs: spike 3's `AgentHost` seam. */
export type AgentProcess = {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** In the executor's own process namespace. */
  readonly pid: number | null;
  readonly exited: Promise<ProcessExit>;
  /**
   * The PIDs in the task's containment unit now, when the unit can list them (a Windows job, a
   * cgroup: ticket 42). A cancelled turn's reap takes the ones born during it from this list, so a
   * process that detached itself ends too.
   */
  readonly unitPids?: () => Promise<readonly number[]>;
};

export type CommitAndPushInput = {
  readonly box: BoxRef;
  /** The commit message for what the agent left uncommitted. */
  readonly message: string;
  /** The App's bot (F-078). */
  readonly author: GitPerson;
  /** `Co-authored-by` trailers. */
  readonly coAuthors: readonly GitPerson[];
  readonly branchName: string;
  /** The task's hidden ref, `refs/ostra/wip/<taskId>`, which also holds unfinished work (ADR 0039). */
  readonly hiddenRef: string;
};

export type RepoPushResult = {
  readonly repoId: RepoId;
  /** The branch's head after the push, or `null` when the repo has no commit of the task. */
  readonly headSha: GitSha | null;
  /** Whether the branch is ahead of its base: this repo gets a PR (F-030, F-065). */
  readonly ahead: boolean;
};

export type StopInput = {
  readonly box: BoxRef;
  /** How long the agent has to exit before its whole process tree is killed. */
  readonly graceMs: number;
};

// ---------- milestone 2: work in progress (ADR 0039) ----------

export type SaveWorkInProgressInput = {
  readonly box: BoxRef;
  /** The turn this save follows. */
  readonly turnOrdinal: number;
};

/** One repo's hidden ref after a save. `sha` is `null` for a repo with no commit yet, or a failed save. */
export type SavedRepoWork = {
  readonly repoId: RepoId;
  readonly sha: GitSha | null;
  /** The branch head it was saved on. */
  readonly baseSha: GitSha | null;
};

export type RestoreWorkInProgressInput = {
  readonly box: BoxRef;
  /** From the task spec's `restore.hiddenRefs`: what each repo saved last. */
  readonly refs: readonly HiddenRefRestore[];
};

/** One repo's restore: `conflict` leaves the branch's head checked out (Q150). */
export type RestoredRepoWork = { readonly repoId: RepoId; readonly outcome: "applied" | "none" | "conflict" };

// ---------- milestone 2: a command beside the agent (tickets 22 and 24) ----------

export type RunAgentCommandInput = {
  readonly box: BoxRef;
  /** From the agent adapter (`exportSession`, `importSession`). */
  readonly command: AgentCommand;
  /** The command is ended after this long. */
  readonly timeoutMs: number;
};

/** A command's end. `stdout` is cut at 64 KiB; it can hold content, so it's never logged. */
export type AgentCommandResult = { readonly exitCode: number | null; readonly stdout: string };

// ---------- milestone 3: checks, snapshots and the host cache ----------

/** A snapshot build's inputs and secrets (F-051): the command's environment and the snapshot credentials. */
export type BuildSnapshotInput = {
  readonly snapshotId: SnapshotId;
  readonly projectId: ProjectId;
  readonly environment: SnapshotBuildEnvironment;
  /** The setup secrets and the repos' tokens, mounted for the build only. Never logged. */
  readonly credentials: SnapshotCredentials;
  /** The build's output, as it comes: words for the panel, never logged with a secret's value. */
  readonly onOutput: (stream: "stdout" | "stderr", text: string) => void;
  readonly signal?: AbortSignal;
};

/** A built snapshot, or why it wasn't: `snapshot.built` or `snapshot.failed`. */
export type SnapshotBuildResult =
  | { readonly outcome: "built"; readonly imageRef: string; readonly imageDigest: string; readonly durationMs: number }
  | { readonly outcome: "failed"; readonly reason: SnapshotFailureReason; readonly detail: string };

/** A snapshot image this runner keeps. */
export type KeptSnapshot = { readonly imageRef: string; readonly imageDigest: string };

/** A project's host cache: what to mirror, under which key. */
export type PrepareCacheInput = {
  readonly projectId: ProjectId;
  /** The spec's `snapshot.cacheKey`: names the project's mirrors and cache folder on this runner. */
  readonly cacheKey: string;
  /** The repos to mirror, cloned through the git proxy as a task's are. */
  readonly repos: readonly { readonly repoId: RepoId; readonly cloneUrl: string }[];
  readonly proxies: TaskProxies;
  readonly signal?: AbortSignal;
};

export type PreparedCache = {
  readonly cacheKey: string;
  /** Whether a cache for the key was there already, so this made nothing new but fetched. */
  readonly reused: boolean;
  /** The project's dependency cache folder, which each box's package managers point at. */
  readonly dependencyCacheDir: string;
};

export abstract class ExecutorAdapter {
  readonly kind = "executor" as const;
  abstract readonly name: string;
  abstract readonly capabilities: ExecutorCapabilities;

  readonly #context: AdapterContext;
  #plumbing: Plumbing | undefined;

  constructor(context: AdapterContext = defaultAdapterContext) {
    this.#context = context;
  }

  /** Retries, rate budgets, idempotency and the logger, shared by every adapter (ADR 0025). */
  protected get plumbing(): Plumbing {
    this.#plumbing ??= createPlumbing(this.#context, { kind: this.kind, name: this.name });
    return this.#plumbing;
  }

  /** Whether the executor can run boxes here (Docker answers; the shell is on PATH). */
  abstract health(): Promise<HealthReport>;

  /** Creates the box (`creating`): containers, or a worktree root. */
  abstract create(input: CreateBoxInput): Promise<AdapterResult<CreatedBox>>;

  /** Checks out every repo through the git proxy, writes the environment, runs setup (`preparing`). */
  abstract prepare(input: PrepareInput): Promise<AdapterResult<PrepareResult>>;

  /** Starts the agent's process in the box and hands back its stdio and handle. */
  abstract startAgent(box: BoxRef, launch: AgentLaunch): Promise<AdapterResult<AgentProcess>>;

  /** Commits what's left, pushes the branch and the hidden ref in every repo, reports which are ahead. */
  abstract commitAndPush(input: CommitAndPushInput): Promise<AdapterResult<readonly RepoPushResult[]>>;

  /** Ends the agent and every process of the task (`stopped`). The workspace stays. */
  abstract stop(input: StopInput): Promise<AdapterResult<void>>;

  /** Removes the box and its workspace (`released`), for the reason given. A box is never reused. */
  abstract release(box: BoxRef, reason: BoxReleaseReason): Promise<AdapterResult<void>>;

  /**
   * Milestone 2, after any turn: each repo's working tree to the task's hidden ref, by a forced push
   * through the git proxy, with `--no-verify` and `GIT_CEILING_DIRECTORIES` set (ADR 0039). The
   * shared steps are `saveWorkInProgressIn` (`executor/work-in-progress.ts`). Additive: an
   * executor answers `unsupported` until it has it (tickets 22 and 24).
   */
  saveWorkInProgress(input: SaveWorkInProgressInput): Promise<AdapterResult<readonly SavedRepoWork[]>> {
    this.plumbing.logger.debug("saveWorkInProgress is not supported", { taskId: input.box.taskId });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't save work in progress yet`));
  }

  /**
   * Milestone 2, on a fresh box: each repo's hidden ref restored onto the commit it was saved on,
   * then the branch's new commits merged in; on a conflict, the branch's head checked out and
   * `conflict` answered (Q150). The shared steps are `restoreWorkInProgressIn`.
   */
  restoreWorkInProgress(input: RestoreWorkInProgressInput): Promise<AdapterResult<readonly RestoredRepoWork[]>> {
    this.plumbing.logger.debug("restoreWorkInProgress is not supported", { taskId: input.box.taskId, repos: input.refs.length });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't restore work in progress yet`));
  }

  /**
   * Milestone 2: runs one of the agent adapter's commands (a session's export or import) in the box,
   * where the agent runs, with the command's own environment and never a shell line. Additive: an
   * executor answers `unsupported` until it has it (tickets 22 and 24).
   */
  runAgentCommand(input: RunAgentCommandInput): Promise<AdapterResult<AgentCommandResult>> {
    this.plumbing.logger.debug("runAgentCommand is not supported", { taskId: input.box.taskId });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't run an agent command yet`));
  }

  /**
   * Milestone 2, ADR 0039's `resumed` step: a box this executor still keeps (`stopped` or `idle`)
   * takes a new session's spec and proxies, so its git talks to the new git proxy, and is `ready`
   * for the agent again. The workspace, the branch and the agent's own folder stay as they were.
   * `not-found` when the box is gone. Additive: `unsupported` until an executor has it (ticket 24).
   */
  resumeBox(input: CreateBoxInput): Promise<AdapterResult<CreatedBox>> {
    this.plumbing.logger.debug("resumeBox is not supported", { taskId: input.taskId });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't resume a kept box yet`));
  }

  /** The box's state as the executor sees it. */
  abstract state(box: BoxRef): Promise<AdapterResult<BoxState>>;

  /**
   * The names in the workspace root, top level only (Q133, ticket 44): the repos' checkouts, ostra's
   * own folders, and anything the agent left beside them. On `host` the worktree's root; in a box,
   * the task volume, as the sidecar sees it. Names only, never content, and never logged.
   */
  abstract listWorkspaceRoot(box: BoxRef): Promise<AdapterResult<readonly string[]>>;

  // ---------- milestone 3: additive, so each answers `unsupported` until an executor has it ----------

  /**
   * A spec this executor can't run (ADR 0038): services without `services`, a snapshot of a kind it
   * doesn't keep. `create` calls it first, so such a spec is refused before a box is made; `null`
   * when the spec fits.
   */
  protected refuseUnfitSpec(spec: TaskSpec): AdapterResult<never> | null {
    if ((spec.services?.length ?? 0) > 0 && !this.capabilities.services) {
      return adapterError("unsupported", `${this.name} doesn't start services`);
    }
    const snapshot = spec.snapshot ?? null;
    if (snapshot !== null) {
      const wanted = snapshot.kind === "image" ? "image" : "host-cache";
      if (this.capabilities.snapshots !== wanted) {
        return adapterError("unsupported", `${this.name} doesn't start a box from a ${wanted} snapshot`);
      }
    }
    return null;
  }

  /**
   * Runs the turn's checks in the agent's environment (F-054, ADR 0052, Q188), in order, each with
   * its timeout and the total's, and keeps each one's output (`runChecksWith` does the shared part).
   * A check's environment holds the environment's variables and never a model key, a code host
   * token or the runner's own variables.
   */
  runChecks(box: BoxRef, input: Omit<RunChecksInput, "workspaceDir">): Promise<AdapterResult<readonly CheckRunResult[]>> {
    this.plumbing.logger.debug("runChecks is not supported", { taskId: box.taskId, checks: input.spec.checks?.length ?? 0 });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't run checks yet`));
  }

  /**
   * Builds a project's snapshot image and keeps it on this runner (F-051, ADR 0038), with the setup
   * secrets mounted for the build only and the image scanned for each one's value. Needs
   * `snapshots: "image"`.
   */
  buildSnapshot(input: BuildSnapshotInput): Promise<AdapterResult<SnapshotBuildResult>> {
    this.plumbing.logger.debug("buildSnapshot is not supported", { snapshotId: input.snapshotId });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't build a snapshot`));
  }

  /** The snapshot image this runner keeps by ID, or `null`. Needs `snapshots: "image"`. */
  hasSnapshot(snapshotId: SnapshotId): Promise<AdapterResult<KeptSnapshot | null>> {
    this.plumbing.logger.debug("hasSnapshot is not supported", { snapshotId });
    return Promise.resolve(adapterError("unsupported", `${this.name} keeps no snapshots`));
  }

  /**
   * Makes or refreshes a project's repo mirrors and dependency cache folder (F-051, ADR 0038 as
   * amended, Q185), which the project's next boxes start from. Needs `snapshots: "host-cache"`.
   */
  prepareCache(input: PrepareCacheInput): Promise<AdapterResult<PreparedCache>> {
    this.plumbing.logger.debug("prepareCache is not supported", { projectId: input.projectId });
    return Promise.resolve(adapterError("unsupported", `${this.name} keeps no host cache`));
  }
}
