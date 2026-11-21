import { rm } from "node:fs/promises";
import path from "node:path";
import { HostExecutor } from "@ostra/adapter-executor-host";
import { adapterError, ExecutorAdapter, makeTaskTokenDir, writeTaskTokenDirFile, TASK_TOKEN_FILE } from "@ostra/adapter-sdk";
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
  ExecutorCapacity,
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
  TaskTokenOwner,
} from "@ostra/adapter-sdk";
import type { BoxReleaseReason, BoxState, SnapshotId } from "@ostra/protocol";
import type { Bridge } from "./bridge/bridge-server.ts";
import { bridgeProcesses } from "./bridge-processes.ts";
import { SERVICES_HEALTHY_WITHIN_MS } from "./boxes.ts";
import type { BoxInput, CapacitySettings, DockerBoxes } from "./boxes.ts";
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
//
// Milestone 5 (ticket 09): `boxSizes`, the runner's offer (`capacity()`), registry images and
// pushes. With `pool`, the pool runner's half on the Engine, `create` first makes the box's
// containers (`DockerBoxes`) with the size as the agent's limits, the registry image pulled by
// digest with its pull credential, and the task token written by `writeTaskTokenFile`'s folder
// rules into a folder only the sidecar's container mounts; `release` removes them and that folder.
// The executor contract suite drives both halves in one process; a pool runner holds the first and
// a box's sidecar the second.

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
  /** Milestone 5: the pool runner's half, which makes and removes the boxes on the Engine; a box's sidecar has none. */
  readonly pool?: DockerPoolHalf;
};

/** The pool runner's half of the executor (ticket 09): the boxes on the Engine, and where their token folders go. */
export type DockerPoolHalf = {
  readonly boxes: DockerBoxes;
  /** Where each box's token folder is made: `<tokenRoot>/<boxId>`, mounted into its sidecar only. */
  readonly tokenRoot: string;
  /** Who reads a token folder besides the runner (`writeTaskTokenFile`'s rules). */
  readonly tokenOwner: TaskTokenOwner;
  /** The rest of a box's input, which the dispatch gives: its session, lease, server address and base image. */
  readonly boxInput: (box: BoxRef) => Pick<BoxInput, "sessionId" | "leaseEpoch" | "serverUrl" | "baseImage">;
  /** The runner's offer settings (ADR 0059): slots and reserve. */
  readonly capacity: CapacitySettings;
  /** Hands a path to another uid, for an `owner` token folder. Defaults to `fs.chown`. */
  readonly chown?: (target: string, uid: number, gid: number) => Promise<void>;
};

export class DockerExecutor extends ExecutorAdapter {
  readonly name = "docker";
  readonly capabilities: ExecutorCapabilities = {
    isolation: "container",
    // Milestone 3 (ticket 14): the services on the box's network, and the snapshot image.
    services: true,
    // Milestone 5 (F-095): a box's size is the agent's container's limits.
    boxSizes: true,
    snapshots: "image",
    processContainment: "container",
    // Milestone 5 (ADR 0060): a box can start from the organization's registry, and without one the
    // runner builds and keeps its own snapshot (milestone 3). A Docker host never waits for a node.
    registry: "optional",
    nodeWait: false,
    // Milestone 8 (ADR 0068): Chromium from the base image, in the agent's container, which has its
    // own loopback: the init's forwarder reaches an app's port.
    boxBrowser: "image",
    appReach: "forwarder",
  };

  readonly #inner: HostExecutor;
  readonly #snapshots: DockerSnapshots | undefined;
  readonly #pool: DockerPoolHalf | undefined;
  #capacity: ExecutorCapacity | null = null;

  constructor(options: DockerExecutorOptions, context?: AdapterContext) {
    super(context);
    const servicesFile = options.servicesFile ?? SIDECAR_SERVICES_FILE;
    const servicesWaitMs = options.servicesWaitMs ?? SERVICES_HEALTHY_WITHIN_MS + 30_000;
    this.#snapshots = options.snapshots;
    this.#pool = options.pool;
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

  async health(): Promise<HealthReport> {
    // The pool runner's offer is read with its health, at start and after.
    await this.refreshCapacity();
    return this.#inner.health();
  }

  /**
   * Milestone 5 (ADR 0059): the pool runner's whole offer, from its last reading of the Engine's
   * `info` (`refreshCapacity`); `null` before the first reading, and in a box's sidecar.
   */
  override capacity(): ExecutorCapacity | null {
    return this.#capacity;
  }

  /** Reads the Engine's `info` again for `capacity()`; a reading that fails keeps the last one. */
  async refreshCapacity(): Promise<void> {
    if (this.#pool === undefined) {
      return;
    }
    this.#capacity = (await this.#pool.boxes.readCapacity(this.#pool.capacity)) ?? this.#capacity;
  }

  async create(input: CreateBoxInput): Promise<AdapterResult<CreatedBox>> {
    const unfit = this.refuseUnfitBox(input);
    if (unfit !== null) {
      return unfit;
    }
    const pool = this.#pool;
    if (pool !== undefined) {
      const made = await this.#makeBox(pool, input);
      if (!made.ok) {
        return made;
      }
    }
    // Inside the box, the workspace only: the pool runner made the containers, from the image and
    // with the size, and wrote the task token where only this sidecar reads it.
    const created = await this.#inner.create({ taskId: input.taskId, boxId: input.boxId, spec: input.spec, proxies: input.proxies });
    if (!created.ok && pool !== undefined) {
      await this.#removeBox(pool, input);
    }
    return created;
  }

  /** The pool runner's half: the token folder, then the box's containers on the Engine. */
  async #makeBox(pool: DockerPoolHalf, input: CreateBoxInput): Promise<AdapterResult<void>> {
    const tokenDir = path.join(pool.tokenRoot, input.boxId);
    const options = pool.chown === undefined ? {} : { chown: pool.chown };
    // The folder is made afresh even without a token: the sidecar's mount is there from the start.
    const folder = await makeTaskTokenDir(tokenDir, pool.tokenOwner, options);
    if (!folder.ok) {
      return folder;
    }
    const token = input.taskToken ?? null;
    if (token !== null) {
      const written = await writeTaskTokenDirFile(tokenDir, pool.tokenOwner, TASK_TOKEN_FILE, token, options);
      if (!written.ok) {
        await rm(tokenDir, { recursive: true, force: true });
        return written;
      }
    }
    const made = await pool.boxes.createBox({
      ...pool.boxInput(input),
      taskId: input.taskId,
      boxId: input.boxId,
      tokenDir,
      ...(pool.tokenOwner.kind === "group" ? { tokenGroup: pool.tokenOwner.gid } : {}),
      size: input.size ?? null,
      image: input.image ?? null,
    });
    if (!made.ok) {
      await rm(tokenDir, { recursive: true, force: true });
      return adapterError(made.error.status === 409 ? "conflict" : "unavailable", made.error.message);
    }
    return { ok: true, value: undefined };
  }

  async #removeBox(pool: DockerPoolHalf, box: BoxRef): Promise<AdapterResult<void>> {
    const removed = await pool.boxes.removeBox(box.boxId);
    await rm(path.join(pool.tokenRoot, box.boxId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return removed.ok ? { ok: true, value: undefined } : adapterError("unavailable", removed.error.message);
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

  async release(box: BoxRef, reason: BoxReleaseReason): Promise<AdapterResult<void>> {
    const released = await this.#inner.release(box, reason);
    if (this.#pool === undefined || !released.ok) {
      return released;
    }
    // The pool runner's half: the containers, the network, the volume and the token folder.
    return this.#removeBox(this.#pool, box);
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
    // Milestone 5 (F-120): with `push`, the scanned image goes to the registry and its digest comes back.
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
