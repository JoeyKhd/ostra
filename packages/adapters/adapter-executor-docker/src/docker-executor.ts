import { HostExecutor } from "@ostra/adapter-executor-host";
import { ExecutorAdapter } from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterResult,
  AgentCommandResult,
  AgentLaunch,
  AgentProcess,
  BoxRef,
  CommitAndPushInput,
  CommittedRepoWork,
  CommitWorkInput,
  CreateBoxInput,
  CreatedBox,
  ExecutorCapabilities,
  HealthReport,
  PrepareInput,
  PrepareResult,
  RepoPushResult,
  RestoredRepoWork,
  RestoreWorkInProgressInput,
  RunAgentCommandInput,
  SavedRepoWork,
  SaveWorkInProgressInput,
  StopInput,
} from "@ostra/adapter-sdk";
import type { BoxReleaseReason, BoxState } from "@ostra/protocol";
import type { Bridge } from "./bridge/bridge-server.ts";
import { bridgeProcesses } from "./bridge-processes.ts";

// The `docker` executor, as the box's sidecar drives it (ADR 0029, ticket 22). The pool runner
// creates the box (`DockerBoxes`, on the Engine API) and removes it; inside the box, the sidecar
// runs the same task host as `host` does, with this executor. Its checkouts, environment files and
// commits are the host executor's own logic on the box's shared task volume, and its processes,
// the agent's and the setup script's, run in the agent's container through the bridge to the
// box's init: no credential is ever in that container (ADR 0030).

export type DockerExecutorOptions = {
  /** The box's task volume, mounted at the same path in both containers. */
  readonly taskRoot: string;
  /** The bridge to the box's init, once it has connected. */
  readonly bridge: Bridge;
  /** The shell the setup script runs with in the agent's container. */
  readonly shell?: string;
};

export class DockerExecutor extends ExecutorAdapter {
  readonly name = "docker";
  readonly capabilities: ExecutorCapabilities = {
    isolation: "container",
    // The environment's services and the snapshot image come with milestone 3's ticket 14, which
    // declares `services: true` and `snapshots: "image"` once they're built.
    services: false,
    boxSizes: false,
    snapshots: "none",
    processContainment: "container",
  };

  readonly #inner: HostExecutor;

  constructor(options: DockerExecutorOptions, context?: AdapterContext) {
    super(context);
    this.#inner = new HostExecutor(
      { dataDir: options.taskRoot, shell: options.shell ?? "bash", processes: bridgeProcesses(options.bridge), processContainment: "container" },
      context,
    );
  }

  health(): Promise<HealthReport> {
    return this.#inner.health();
  }

  create(input: CreateBoxInput): Promise<AdapterResult<CreatedBox>> {
    const unfit = this.refuseUnfitSpec(input.spec);
    return unfit === null ? this.#inner.create(input) : Promise.resolve(unfit);
  }

  prepare(input: PrepareInput): Promise<AdapterResult<PrepareResult>> {
    return this.#inner.prepare(input);
  }

  startAgent(box: BoxRef, launch: AgentLaunch): Promise<AdapterResult<AgentProcess>> {
    return this.#inner.startAgent(box, launch);
  }

  commitAndPush(input: CommitAndPushInput): Promise<AdapterResult<readonly RepoPushResult[]>> {
    return this.#inner.commitAndPush(input);
  }

  /** Milestone 3: the turn's work committed before its checks, as the host executor does it, on the task volume. */
  override commitWork(input: CommitWorkInput): Promise<AdapterResult<readonly CommittedRepoWork[]>> {
    return this.#inner.commitWork(input);
  }

  stop(input: StopInput): Promise<AdapterResult<void>> {
    return this.#inner.stop(input);
  }

  release(box: BoxRef, reason: BoxReleaseReason): Promise<AdapterResult<void>> {
    return this.#inner.release(box, reason);
  }

  /**
   * The hidden ref after a turn, on the agent container's workspace: git runs in the agent's
   * container through the bridge, the temporary index is on the shared task volume (ticket 22).
   */
  override saveWorkInProgress(input: SaveWorkInProgressInput): Promise<AdapterResult<readonly SavedRepoWork[]>> {
    return this.#inner.saveWorkInProgress(input);
  }

  /** The hidden ref restored on a fresh box, the same way (ticket 24). */
  override restoreWorkInProgress(input: RestoreWorkInProgressInput): Promise<AdapterResult<readonly RestoredRepoWork[]>> {
    return this.#inner.restoreWorkInProgress(input);
  }

  /** In the agent's container, through the bridge: the agent's binary and data are there. */
  override runAgentCommand(input: RunAgentCommandInput): Promise<AdapterResult<AgentCommandResult>> {
    return this.#inner.runAgentCommand(input);
  }

  /** A kept box takes the next session's proxies (ticket 24). */
  override resumeBox(input: CreateBoxInput): Promise<AdapterResult<CreatedBox>> {
    return this.#inner.resumeBox(input);
  }

  state(box: BoxRef): Promise<AdapterResult<BoxState>> {
    return this.#inner.state(box);
  }

  /** The task volume's workspace root, as the sidecar sees it (ticket 44). */
  listWorkspaceRoot(box: BoxRef): Promise<AdapterResult<readonly string[]>> {
    return this.#inner.listWorkspaceRoot(box);
  }
}
