import type { Readable, Writable } from "node:stream";

import type { BoxId, BoxState, GitPerson, GitSha, RepoId, RepoSecret, TaskId, TaskSpec } from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import type { AgentLaunch } from "../agent/base.ts";
import type { ExecutorCapabilities } from "./capabilities.ts";

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
};

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

  /** Removes the box and its workspace (`released`). A box is never reused. */
  abstract release(box: BoxRef): Promise<AdapterResult<void>>;

  /** The box's state as the executor sees it. */
  abstract state(box: BoxRef): Promise<AdapterResult<BoxState>>;
}
