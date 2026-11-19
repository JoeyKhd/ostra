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
  CreateBoxInput,
  CreatedBox,
  ExecutorCapabilities,
  HealthReport,
  PrepareInput,
  PrepareResult,
  RepoPushResult,
  RunAgentCommandInput,
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
    // The environment's services come with F-094 (milestone 3).
    services: false,
    boxSizes: false,
    snapshots: false,
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
    return this.#inner.create(input);
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

  stop(input: StopInput): Promise<AdapterResult<void>> {
    return this.#inner.stop(input);
  }

  release(box: BoxRef, reason: BoxReleaseReason): Promise<AdapterResult<void>> {
    return this.#inner.release(box, reason);
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
