import { HostExecutor } from "@ostra/adapter-executor-host";
import { adapterError, ExecutorAdapter } from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterResult,
  AgentCommandResult,
  AgentLaunch,
  AgentProcess,
  BoxRef,
  BuildSnapshotInput,
  CheckRunResult,
  CommitAndPushInput,
  CommittedRepoWork,
  CommitWorkInput,
  CreateBoxInput,
  CreatedBox,
  ExecutorCapabilities,
  HealthReport,
  KeptSnapshot,
  PrepareInput,
  PrepareResult,
  RepoPushResult,
  RestoredRepoWork,
  RestoreWorkInProgressInput,
  RunAgentCommandInput,
  RunChecksInput,
  SavedRepoWork,
  SaveWorkInProgressInput,
  SnapshotBuildResult,
  StopInput,
} from "@ostra/adapter-sdk";
import type { BoxReleaseReason, BoxState, SnapshotId } from "@ostra/protocol";
import type { Bridge } from "./bridge/bridge-server.ts";
import { bridgeProcesses } from "./bridge-processes.ts";
import { SERVICES_HEALTHY_WITHIN_MS } from "./boxes.ts";
import { awaitServicesFile, SIDECAR_SERVICES_FILE } from "./services-file.ts";
import type { DockerSnapshots } from "./snapshot/snapshots.ts";

// The `docker` executor, as the box's sidecar drives it (ADR 0029, ticket 22). The pool runner
// creates the box (`DockerBoxes`, on the Engine API) and removes it; inside the box, the sidecar
// runs the same task host as `host` does, with this executor. Its checkouts, environment files and
// commits are the host executor's own logic on the box's shared task volume, and its processes,
// the agent's and the setup script's, run in the agent's container through the bridge to the
// box's init: no credential is ever in that container (ADR 0030).
//
// Milestone 3 (ticket 14): the turn's checks run in the agent's container the same way, as the
// agent's user, through the bridge (`runChecks`, with the host executor's timeouts and tree reap).
// A box from a snapshot finds the snapshot's checkouts on its task volume, which the image filled,
// and moves them into the task's workspace; then it fetches and runs the setup, which is now
// incremental. The services are the pool runner's: it starts them with the box and reports their
// health in a file the sidecar reads before the setup. Snapshots are built and kept by the pool
// runner too, which holds the Engine (`createDockerSnapshots`); a box's sidecar builds none.

export type DockerExecutorOptions = {
  /** The box's task volume, mounted at the same path in both containers. */
  readonly taskRoot: string;
  /** The bridge to the box's init, once it has connected. */
  readonly bridge: Bridge;
  /** The shell the setup script runs with in the agent's container. */
  readonly shell?: string;
  /** Where the pool runner reports the services' health. Default: `/run/ostra/services.json`. */
  readonly servicesFile?: string;
  /** How long the sidecar waits for that report. Default: the services' 120 s and 30 s more. */
  readonly servicesWaitMs?: number;
  /** The pool runner's snapshots, on the Engine; a box's sidecar has none. */
  readonly snapshots?: DockerSnapshots;
};

export class DockerExecutor extends ExecutorAdapter {
  readonly name = "docker";
  readonly capabilities: ExecutorCapabilities = {
    isolation: "container",
    // Milestone 3 (ticket 14): the services on the box's network, and the snapshot image.
    services: true,
    boxSizes: false,
    snapshots: "image",
    processContainment: "container",
  };

  readonly #inner: HostExecutor;
  readonly #snapshots: DockerSnapshots | undefined;

  constructor(options: DockerExecutorOptions, context?: AdapterContext) {
    super(context);
    const servicesFile = options.servicesFile ?? SIDECAR_SERVICES_FILE;
    const servicesWaitMs = options.servicesWaitMs ?? SERVICES_HEALTHY_WITHIN_MS + 30_000;
    this.#snapshots = options.snapshots;
    this.#inner = new HostExecutor(
      {
        dataDir: options.taskRoot,
        shell: options.shell ?? "bash",
        processes: bridgeProcesses(options.bridge),
        processContainment: "container",
        boxCapabilities: { services: true, snapshots: "image" },
        awaitServices: (spec, signal) =>
          awaitServicesFile(
            servicesFile,
            (spec.services ?? []).map((service) => service.name),
            { timeoutMs: servicesWaitMs, signal },
          ),
      },
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

  /** In the agent's container, as the agent's user, through the bridge: the host executor's checks on the task volume. */
  override runChecks(box: BoxRef, input: Omit<RunChecksInput, "workspaceDir">): Promise<AdapterResult<readonly CheckRunResult[]>> {
    return this.#inner.runChecks(box, input);
  }

  /** The pool runner's: a box's sidecar has no Engine to build with. */
  override buildSnapshot(input: BuildSnapshotInput): Promise<AdapterResult<SnapshotBuildResult>> {
    return this.#snapshots?.buildSnapshot(input) ?? Promise.resolve(adapterError("unsupported", "a box's sidecar builds no snapshots: its pool runner does"));
  }

  override hasSnapshot(snapshotId: SnapshotId): Promise<AdapterResult<KeptSnapshot | null>> {
    return this.#snapshots?.hasSnapshot(snapshotId) ?? Promise.resolve(adapterError("unsupported", "a box's sidecar keeps no snapshots: its pool runner does"));
  }

  state(box: BoxRef): Promise<AdapterResult<BoxState>> {
    return this.#inner.state(box);
  }

  /** The task volume's workspace root, as the sidecar sees it (ticket 44). */
  listWorkspaceRoot(box: BoxRef): Promise<AdapterResult<readonly string[]>> {
    return this.#inner.listWorkspaceRoot(box);
  }
}
