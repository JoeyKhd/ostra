import { randomBytes } from "node:crypto";

import { planSnapshotBuild, SETUP_FAILED_MARKER } from "@ostra/adapter-executor-docker";
import { adapterError, ExecutorAdapter, ok } from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterResult,
  AgentCommandResult,
  AgentLaunch,
  AgentProcess,
  BoxRef,
  BoxSize,
  BoxWaitChange,
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
  ServiceHealth,
  SnapshotBuildResult,
  StopInput,
} from "@ostra/adapter-sdk";
import type { BoxReleaseReason, BoxState, SnapshotId, TaskSpecService } from "@ostra/protocol";

import { PUSH_RESULT_PREFIX, pushResultSchema, SCAN_HIT_EXIT, SCAN_HIT_PREFIX } from "./build-steps.ts";
import { baselineProblem, BUILD_ROLE } from "./egress.ts";

import type { KubeApi, KubeResult, PodView } from "./kube-api.ts";
import { boxNames, boxObjects, boxSelector, BRIDGE_PORT, LABELS, BOX_ROLE, serviceContainerName, TASK_ROOT } from "./pod.ts";
import type { BoxObjects, PodImages } from "./pod.ts";
import { cpuMillisOf, memoryMiBOf } from "./quantity.ts";
import { BUILDKIT_IMAGE, BUILDKIT_SWITCHES_OFF, buildObjects } from "./snapshots.ts";
import type { BuildkitSwitches, ContextPlan } from "./snapshots.ts";

// The `kubernetes` executor (ticket 07, ADR 0060, ADR 0029): a box is one pod in the runner's
// namespace. It runs in the pool runner, which holds a service account with a role in that
// namespace only.
//
//   create    the box's secret (the task token and the bridge's nonce), its pull secret when the
//             image has a credential, and the pod (`pod.ts`); it returns once the pod exists, so the
//             runner has accepted the dispatch long before a node is found (ADR 0029)
//   prepare   waits for the sidecar's readiness, saying so through `onWaiting` while the pod waits
//             for a node the autoscaler is adding or for its image's pull (ticket 08 grows it)
//   stop      deletes the pod: a stopped pod is never kept (ADR 0039)
//   release   deletes the pod and every object left with the box's label
//   state     the pod's phase and conditions as a `BoxState`
//
// The task itself (the checkouts, the agent, the commits) runs in the box: the sidecar drives the
// agent's container through the bridge on the pod's loopback, with the same executor logic as a
// `docker` box's sidecar. That half is `inBox`: absent on a pool runner, whose sidecar runs it in the
// pod (ticket 20), so those calls answer `unsupported` there; given by the sidecar's process and by
// the contract suite, which plays the sidecar against the fake cluster's process mode.

/** Why a box failed before it ran (F-093): no node within the wait, or no room and no node coming. Core queues the task again (ticket 13). */
export type BoxWaitFailure = "no-node" | "no-room" | "image-pull";

/** The task's half inside the box: the bridge to the box's init, and the executor that drives the agent through it. */
export type InBox = {
  /**
   * Before the pod is made: listens for the box's init on the pod's loopback, checking the nonce.
   * Answers the port, and the box's executor once the init has connected.
   */
  readonly listen: (
    box: BoxRef,
    nonce: string,
  ) => Promise<{ readonly port: number; readonly executor: Promise<ExecutorAdapter>; readonly close: () => void }>;
};

export type Clock = { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> };

const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

export type KubernetesExecutorOptions = {
  readonly kube: KubeApi;
  /** `OSTRA_K8S_NAMESPACE`: where the boxes' pods are made. */
  readonly namespace: string;
  readonly images: PodImages;
  /** `OSTRA_BOX_SERVER_URL`: the server as a box's sidecar reaches it. */
  readonly serverUrl: string;
  /** `OSTRA_RUNNER_SLOTS`: 20 by default on `kubernetes`. */
  readonly slots?: number;
  /** The CPU and memory to offer when the namespace has no ResourceQuota; absent, no limit but the slots (the cluster grows). */
  readonly resources?: BoxSize | null;
  /** `OSTRA_K8S_RUNTIME_CLASS`. */
  readonly runtimeClassName?: string | null;
  /** `OSTRA_K8S_NODE_WAIT_MINUTES`: 15 by default. */
  readonly nodeWaitMinutes?: number;
  /** How long an unschedulable pod waits for the autoscaler's `TriggeredScaleUp` before it fails as `no-room`. Default 30 s: the autoscaler reacts within seconds. */
  readonly scaleUpGraceMs?: number;
  /** `OSTRA_SIDECAR_CPU_MILLIS` and `OSTRA_SIDECAR_MEMORY_MIB`. */
  readonly sidecarLimits?: BoxSize;
  /** `OSTRA_SERVICE_CPU_MILLIS` and `OSTRA_SERVICE_MEMORY_MIB`: a service names no limits of its own. */
  readonly serviceLimits?: BoxSize;
  /** How long the services have to be healthy once the sidecar runs. Default 120 s (F-094). */
  readonly servicesWaitMs?: number;
  /** How long an image's pull runs before the box says it waits for it. Default 10 s (F-093). */
  readonly imagePullWaitMs?: number;
  /** Whether `health()` checks the namespace's egress baseline (F-116). Default true. */
  readonly requireEgressBaseline?: boolean;
  /** `OSTRA_K8S_BUILD_NAMESPACE`: where snapshots are built. Default `<namespace>-builds`. */
  readonly buildNamespace?: string;
  /** Rootless BuildKit's image. */
  readonly buildkitImage?: string;
  /** BuildKit's unjustified settings, each off unless a live run needs it (milestone 7's review). */
  readonly buildkitSwitches?: BuildkitSwitches;
  /** BuildKit's daemonless build in its image. Default `buildctl-daemonless.sh`. */
  readonly buildkitCommand?: readonly string[];
  /** The runner image's build steps. Default `ostra internal build-step`. */
  readonly buildStepCommand?: readonly string[];
  /** The build container's limits. Default 4 CPUs and 4 GiB, as spike 3's. */
  readonly buildLimits?: BoxSize;
  /** How long a build may run. Default an hour, the build pod's deadline. */
  readonly buildTimeoutMs?: number;
  /** How often the executor looks at a pod it waits on. Default 500 ms. */
  readonly pollMs?: number;
  readonly clock?: Clock;
  /** The box's init in the base image. Default `node /opt/ostra/init/main.ts`, as on `docker`. */
  readonly initCommand?: readonly string[];
  /** The sidecar in the runner image. Default `ostra sidecar`. */
  readonly sidecarCommand?: readonly string[];
  /** The task's half in the box (see above). */
  readonly inBox?: InBox;
};

/** A cluster without native sidecars can't run a box. */
export const KUBERNETES_MIN_MINOR = 29;
const NODE_WAIT_MINUTES = 15;
const DEFAULT_SLOTS = 20;
/** No quota and no settings: the slots are the limit, and the cluster grows. */
const UNBOUNDED = 2 ** 31 - 1;
/** The push step's result line, or `null` when it isn't one. */
const parsePushResult = (text: string): { readonly digest: string; readonly blobs: number } | null => {
  try {
    const parsed = pushResultSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** A container's waiting reasons that mean its image won't come. */
const PULL_FAILURES: ReadonlySet<string> = new Set(["ErrImagePull", "ImagePullBackOff", "InvalidImageName", "ErrImageNeverPull"]);
/** How long release waits for a deleted pod to be gone. */
const RELEASE_WAIT_MS = 60_000;

/** What the executor does in its namespace, and so what its role must allow there. */
export const NEEDED_ACCESS: readonly { readonly verb: string; readonly group: string; readonly resource: string }[] = [
  ...["create", "get", "list", "watch", "delete"].map((verb) => ({ verb, group: "", resource: "pods" })),
  ...["create", "get", "list", "patch", "delete"].map((verb) => ({ verb, group: "", resource: "secrets" })),
  { verb: "list", group: "", resource: "events" },
  { verb: "list", group: "", resource: "resourcequotas" },
  { verb: "list", group: "networking.k8s.io", resource: "networkpolicies" },
];

type BoxRecord = {
  readonly ref: BoxRef;
  readonly objects: BoxObjects;
  readonly createdAt: number;
  readonly onWaiting: ((change: BoxWaitChange) => void) | undefined;
  /** `creating` until the sidecar is ready; then the pod says. */
  phase: "creating" | "running" | "stopped" | "failed";
  failure: BoxWaitFailure | null;
  /** Said `waiting` and not yet `scheduled`. */
  waiting: { readonly reason: "node" | "image-pull"; readonly since: number } | null;
  /** When the pod was first seen scheduled. */
  scheduledAt: number | null;
  readonly services: readonly TaskSpecService[];
  inner: ExecutorAdapter | null;
  closeBridge: (() => void) | null;
};

const keyOf = (box: BoxRef): string => `${box.taskId}\u0000${box.boxId}`;

export class KubernetesExecutor extends ExecutorAdapter {
  readonly name = "kubernetes";
  readonly capabilities: ExecutorCapabilities = {
    isolation: "container",
    services: true,
    boxSizes: true,
    snapshots: "image",
    processContainment: "container",
    // Kubelets pull, so a box's snapshot comes from the organization's registry (ADR 0060).
    registry: "required",
    nodeWait: true,
  };

  readonly #kube: KubeApi;
  readonly #namespace: string;
  readonly #images: PodImages;
  readonly #serverUrl: string;
  readonly #slots: number;
  readonly #resources: BoxSize | null;
  readonly #runtimeClassName: string | null;
  readonly #nodeWaitMs: number;
  readonly #scaleUpGraceMs: number;
  readonly #sidecarLimits: BoxSize;
  readonly #serviceLimits: BoxSize;
  readonly #servicesWaitMs: number;
  readonly #imagePullWaitMs: number;
  readonly #requireEgressBaseline: boolean;
  readonly #buildNamespace: string;
  readonly #buildkitImage: string;
  readonly #buildkitSwitches: BuildkitSwitches;
  readonly #buildkitCommand: readonly string[];
  readonly #buildStepCommand: readonly string[];
  readonly #buildLimits: BoxSize;
  readonly #buildTimeoutMs: number;
  readonly #pollMs: number;
  readonly #clock: Clock;
  readonly #initCommand: readonly string[];
  readonly #sidecarCommand: readonly string[];
  readonly #inBox: InBox | undefined;
  readonly #boxes = new Map<string, BoxRecord>();
  readonly #released = new Set<string>();
  #capacity: ExecutorCapacity;

  constructor(options: KubernetesExecutorOptions, context?: AdapterContext) {
    super(context);
    this.#kube = options.kube;
    this.#namespace = options.namespace;
    this.#images = options.images;
    this.#serverUrl = options.serverUrl;
    this.#slots = options.slots ?? DEFAULT_SLOTS;
    this.#resources = options.resources ?? null;
    this.#runtimeClassName = options.runtimeClassName ?? null;
    this.#nodeWaitMs = (options.nodeWaitMinutes ?? NODE_WAIT_MINUTES) * 60_000;
    this.#scaleUpGraceMs = options.scaleUpGraceMs ?? 30_000;
    this.#sidecarLimits = options.sidecarLimits ?? { cpuMillis: 1000, memoryMiB: 256 };
    this.#serviceLimits = options.serviceLimits ?? { cpuMillis: 1000, memoryMiB: 1024 };
    this.#servicesWaitMs = options.servicesWaitMs ?? 120_000;
    this.#imagePullWaitMs = options.imagePullWaitMs ?? 10_000;
    this.#requireEgressBaseline = options.requireEgressBaseline ?? true;
    this.#buildNamespace = options.buildNamespace ?? `${options.namespace}-builds`;
    this.#buildkitImage = options.buildkitImage ?? BUILDKIT_IMAGE;
    this.#buildkitSwitches = options.buildkitSwitches ?? BUILDKIT_SWITCHES_OFF;
    this.#buildkitCommand = options.buildkitCommand ?? ["buildctl-daemonless.sh"];
    this.#buildStepCommand = options.buildStepCommand ?? ["ostra", "internal", "build-step"];
    this.#buildLimits = options.buildLimits ?? { cpuMillis: 4000, memoryMiB: 4096 };
    this.#buildTimeoutMs = options.buildTimeoutMs ?? 3_600_000;
    this.#pollMs = options.pollMs ?? 500;
    this.#clock = options.clock ?? realClock;
    this.#initCommand = options.initCommand ?? ["node", "/opt/ostra/init/main.ts"];
    this.#sidecarCommand = options.sidecarCommand ?? ["ostra", "sidecar"];
    this.#inBox = options.inBox;
    const offer = this.#resources ?? { cpuMillis: UNBOUNDED, memoryMiB: UNBOUNDED };
    this.#capacity = { slots: this.#slots, cpuMillis: offer.cpuMillis, memoryMiB: offer.memoryMiB };
  }

  /** The cluster answers, at 1.29 or later; the namespace is there; the service account may do what the executor does in it. */
  async health(): Promise<HealthReport> {
    const version = await this.#kube.version();
    if (!version.ok) {
      return { status: "down", reason: `The cluster's API doesn't answer (${version.message}).` };
    }
    if (version.value.major < 1 || (version.value.major === 1 && version.value.minor < KUBERNETES_MIN_MINOR)) {
      return {
        status: "down",
        reason: `This cluster runs Kubernetes ${String(version.value.major)}.${String(version.value.minor)}; ostra's boxes need 1.${String(KUBERNETES_MIN_MINOR)} or later for native sidecars.`,
      };
    }
    const namespace = await this.#kube.namespace(this.#namespace);
    if (!namespace.ok) {
      return { status: "down", reason: `The namespace ${this.#namespace} can't be read (${namespace.message}).` };
    }
    if (namespace.value === "missing") {
      return { status: "down", reason: `The namespace ${this.#namespace} doesn't exist: the runner chart makes it (OSTRA_K8S_NAMESPACE).` };
    }
    for (const access of NEEDED_ACCESS) {
      const allowed = await this.#kube.canI({ namespace: this.#namespace, ...access });
      if (!allowed.ok) {
        return { status: "down", reason: `The service account's rights can't be checked (${allowed.message}).` };
      }
      if (!allowed.value) {
        return { status: "down", reason: `The runner's service account may not ${access.verb} ${access.resource} in ${this.#namespace}: its role needs it.` };
      }
    }
    if (this.#requireEgressBaseline) {
      const policies = await this.#kube.networkPolicies(this.#namespace);
      if (!policies.ok) {
        return { status: "down", reason: `The namespace's network policies can't be read (${policies.message}).` };
      }
      const problem = baselineProblem(policies.value, this.#namespace, { [LABELS.partOf]: "ostra", [LABELS.role]: BOX_ROLE });
      if (problem !== null) {
        return { status: "down", reason: problem };
      }
    }
    await this.refreshCapacity();
    return { status: "ok" };
  }

  /** The last reading: `refreshCapacity` updates it, after `health`, each `create` and each `release`. */
  override capacity(): ExecutorCapacity {
    return this.#capacity;
  }

  /**
   * Slots from `OSTRA_RUNNER_SLOTS`; CPU and memory from the namespace's ResourceQuota, less what the
   * namespace's other pods request (the runner's own among them), or the runner's settings without
   * a quota. The whole offer: core subtracts the boxes it placed, from its own rows (ADR 0059).
   */
  async refreshCapacity(): Promise<ExecutorCapacity> {
    const quotas = await this.#kube.quotas(this.#namespace);
    if (!quotas.ok) {
      return this.#capacity;
    }
    const limitOf = (resource: "cpu" | "memory"): number | null => {
      let least: number | null = null;
      for (const quota of quotas.value) {
        for (const key of [resource, `requests.${resource}`, `limits.${resource}`]) {
          const text = quota.hard[key];
          if (text === undefined) continue;
          const value = resource === "cpu" ? cpuMillisOf(text) : memoryMiBOf(text);
          if (value !== null) least = least === null ? value : Math.min(least, value);
        }
      }
      return least;
    };
    const cpu = limitOf("cpu");
    const memory = limitOf("memory");
    if (cpu === null && memory === null) {
      const offer = this.#resources ?? { cpuMillis: UNBOUNDED, memoryMiB: UNBOUNDED };
      this.#capacity = { slots: this.#slots, cpuMillis: offer.cpuMillis, memoryMiB: offer.memoryMiB };
      return this.#capacity;
    }
    const pods = await this.#kube.listPods(this.#namespace);
    const others = pods.ok ? pods.value.filter((pod) => pod.labels[LABELS.role] !== BOX_ROLE && pod.phase !== "Succeeded" && pod.phase !== "Failed") : [];
    const used = others.reduce((sum, pod) => ({ cpuMillis: sum.cpuMillis + pod.requests.cpuMillis, memoryMiB: sum.memoryMiB + pod.requests.memoryMiB }), { cpuMillis: 0, memoryMiB: 0 });
    this.#capacity = {
      slots: this.#slots,
      cpuMillis: cpu === null ? (this.#resources?.cpuMillis ?? UNBOUNDED) : Math.max(0, cpu - used.cpuMillis),
      memoryMiB: memory === null ? (this.#resources?.memoryMiB ?? UNBOUNDED) : Math.max(0, memory - used.memoryMiB),
    };
    return this.#capacity;
  }

  /** Why a box failed before it ran, when it did: `no-node` and `no-room` send its task back to the queue (ticket 13). */
  failureOf(box: BoxRef): BoxWaitFailure | null {
    return this.#boxes.get(keyOf(box))?.failure ?? null;
  }

  async create(input: CreateBoxInput): Promise<AdapterResult<CreatedBox>> {
    const unfit = this.refuseUnfitBox(input);
    if (unfit !== null) {
      return unfit;
    }
    const ref: BoxRef = { taskId: input.taskId, boxId: input.boxId };
    const key = keyOf(ref);
    if (this.#boxes.has(key)) {
      return adapterError("conflict", "the box exists already");
    }
    const log = this.plumbing.logger.child({ taskId: input.taskId, boxId: input.boxId });
    const nonce = randomBytes(32).toString("base64url");
    const listening = this.#inBox === undefined ? null : await this.#inBox.listen(ref, nonce);
    const objects = boxObjects(
      { box: ref, spec: input.spec, size: input.size ?? null, image: input.image ?? null, nonce, taskToken: input.taskToken ?? null },
      {
        images: this.#images,
        serverUrl: this.#serverUrl,
        runtimeClassName: this.#runtimeClassName,
        sidecarLimits: this.#sidecarLimits,
        serviceLimits: this.#serviceLimits,
        bridgePort: listening?.port ?? BRIDGE_PORT,
        initCommand: this.#initCommand,
        sidecarCommand: this.#sidecarCommand,
      },
    );
    const failed = async (made: KubeResult<unknown>, what: string): Promise<AdapterResult<CreatedBox>> => {
      listening?.close();
      await this.#removeObjects(ref);
      const status = made.ok ? 0 : made.status;
      log.warn("creating the box failed", { status, step: what });
      const code = status === 403 ? "forbidden" : status === 401 ? "unauthorized" : status === 409 ? "conflict" : status === 422 || status === 400 ? "invalid-input" : "unavailable";
      return adapterError(code, `${what} failed: ${made.ok ? "" : made.message}`);
    };
    this.#released.delete(key);
    const secret = await this.#kube.createSecret(this.#namespace, objects.secret);
    if (!secret.ok) return failed(secret, "creating the box's secret");
    if (objects.pullSecret !== null) {
      const pull = await this.#kube.createSecret(this.#namespace, objects.pullSecret);
      if (!pull.ok) return failed(pull, "creating the box's pull secret");
    }
    const pod = await this.#kube.createPod(this.#namespace, objects.pod);
    if (!pod.ok) return failed(pod, "creating the box's pod");
    // The secrets go with the pod: the garbage collector deletes a dependent with its owner. Release
    // deletes them by label too, so a failed patch leaves nothing behind.
    for (const name of [objects.names.secret, ...(objects.pullSecret === null ? [] : [objects.names.pullSecret])]) {
      const owned = await this.#kube.ownSecret(this.#namespace, name, { name: pod.value.name, uid: pod.value.uid });
      if (!owned.ok) log.warn("making a secret the pod's dependent failed", { status: owned.status });
    }
    const record: BoxRecord = {
      ref,
      objects,
      createdAt: this.#clock.now(),
      onWaiting: input.onWaiting,
      phase: "creating",
      failure: null,
      waiting: null,
      scheduledAt: null,
      services: input.spec.services ?? [],
      inner: null,
      closeBridge: listening?.close ?? null,
    };
    this.#boxes.set(key, record);
    log.info("box pod created", { namespace: this.#namespace, sized: input.size !== undefined && input.size !== null, fromRegistry: input.image !== undefined && input.image !== null });
    void this.refreshCapacity();
    if (listening === null) {
      // The pod's view of the task's folders, as the sidecar's executor makes them.
      const root = `${TASK_ROOT}/tasks/${input.taskId.replaceAll(/[^A-Za-z0-9._-]/g, "_")}`;
      return ok({ workspaceDir: `${root}/workspace`, agentDir: `${root}/agent`, gitConfig: `${root}/git/config` });
    }
    // The sidecar's half: once the pod runs and the init has connected, its executor makes the folders.
    const running = await this.#untilRunning(record);
    if (!running.ok) return running;
    const inner = await listening.executor;
    record.inner = inner;
    return inner.create({ taskId: input.taskId, boxId: input.boxId, spec: input.spec, proxies: input.proxies });
  }

  async prepare(input: PrepareInput): Promise<AdapterResult<PrepareResult>> {
    const record = this.#boxes.get(keyOf(input.box));
    if (record === undefined) {
      return adapterError("not-found", "no such box");
    }
    const running = await this.#untilRunning(record);
    if (!running.ok) {
      return running;
    }
    const services = record.services.length === 0 ? null : await this.#servicesHealth(record);
    // On a pool runner the sidecar runs the setup in the pod; here the box is ready for it.
    if (record.inner === null) {
      return ok({ setup: null, ...(services === null ? {} : { services }) });
    }
    const prepared = await record.inner.prepare(input);
    return prepared.ok && services !== null ? ok({ ...prepared.value, services }) : prepared;
  }

  /** Each service's health once the sidecar runs (F-094): its readiness, within the wait, in the environment's order. */
  async #servicesHealth(record: BoxRecord): Promise<readonly ServiceHealth[]> {
    const started = this.#clock.now();
    const results = new Map<string, ServiceHealth>();
    for (;;) {
      const read = await this.#kube.readPod(this.#namespace, record.objects.names.pod);
      const pod = read.ok ? read.value : null;
      for (const service of record.services) {
        if (results.has(service.name)) continue;
        const status = pod?.initContainers.find((container) => container.name === serviceContainerName(service.name));
        if (pod === null) {
          results.set(service.name, { name: service.name, outcome: "failed", reason: "The box's pod is gone." });
        } else if (status?.state === "terminated") {
          results.set(service.name, { name: service.name, outcome: "failed", reason: `The service's container exited (exit ${String(status.exitCode ?? "unknown")}) before it was healthy.` });
        } else if (status?.state === "waiting" && status.reason !== null && PULL_FAILURES.has(status.reason)) {
          results.set(service.name, { name: service.name, outcome: "failed", reason: "The service's image couldn't be pulled." });
        } else if (status?.state === "running" && status.ready) {
          results.set(service.name, { name: service.name, outcome: "healthy", afterMs: Math.max(0, this.#clock.now() - started) });
        }
      }
      if (results.size === record.services.length) break;
      if (this.#clock.now() - started >= this.#servicesWaitMs) {
        for (const service of record.services) {
          if (!results.has(service.name)) {
            results.set(service.name, { name: service.name, outcome: "failed", reason: `The service wasn't healthy within ${String(Math.ceil(this.#servicesWaitMs / 1000))} s.` });
          }
        }
        break;
      }
      await this.#clock.sleep(this.#pollMs);
    }
    return record.services.flatMap((service) => {
      const result = results.get(service.name);
      return result === undefined ? [] : [result];
    });
  }

  /**
   * Waits for the box's sidecar to be ready, watching the pod's `PodScheduled` condition and its
   * events: `waiting: node` while the autoscaler adds one, `scheduled` once it's placed.
   */
  async #untilRunning(record: BoxRecord): Promise<AdapterResult<void>> {
    const log = this.plumbing.logger.child({ taskId: record.ref.taskId, boxId: record.ref.boxId });
    const fail = async (failure: BoxWaitFailure | null, message: string): Promise<AdapterResult<void>> => {
      record.phase = "failed";
      record.failure = failure;
      log.warn("the box failed before it ran", { reason: failure ?? "pod" });
      await this.#kube.deletePod(this.#namespace, record.objects.names.pod, 0);
      return adapterError("unavailable", message);
    };
    const tell = (change: BoxWaitChange): void => {
      try {
        record.onWaiting?.(change);
      } catch {
        // A listener's failure is the runner's to report; the box goes on.
      }
    };
    let unschedulableSince: number | null = null;
    for (;;) {
      if (record.phase === "running") return ok(undefined);
      if (record.phase === "stopped" || record.phase === "failed") return adapterError("conflict", "the box isn't running");
      const read = await this.#kube.readPod(this.#namespace, record.objects.names.pod);
      if (!read.ok) return adapterError("unavailable", `reading the box's pod failed: ${read.message}`);
      const pod = read.value;
      if (pod === null || pod.deleting) return fail(null, "the box's pod is gone");
      const now = this.#clock.now();
      const decision = await this.#readWait(pod, record, now, unschedulableSince);
      unschedulableSince = decision.unschedulableSince;
      for (const change of decision.tell) tell(change);
      if (decision.kind === "fail") return fail(decision.failure, decision.message);
      if (decision.kind === "running") {
        record.phase = "running";
        return ok(undefined);
      }
      await this.#clock.sleep(this.#pollMs);
    }
  }

  /** One look at a waiting pod: what to tell, and whether it runs, still waits, or failed. */
  async #readWait(
    pod: PodView,
    record: BoxRecord,
    now: number,
    unschedulableSince: number | null,
  ): Promise<
    { readonly tell: readonly BoxWaitChange[]; readonly unschedulableSince: number | null } & (
      | { readonly kind: "running" | "waiting" }
      | { readonly kind: "fail"; readonly failure: BoxWaitFailure | null; readonly message: string }
    )
  > {
    const tell: BoxWaitChange[] = [];
    if (pod.phase === "Failed" || pod.phase === "Succeeded") {
      return { kind: "fail", failure: null, message: "the box's pod ended before it was ready", tell, unschedulableSince };
    }
    if (pod.scheduled?.status === "False" && pod.scheduled.reason === "Unschedulable") {
      const since = unschedulableSince ?? now;
      const events = await this.#kube.podEvents(this.#namespace, pod.name);
      const scaling = events.ok && events.value.some((event) => event.reason === "TriggeredScaleUp");
      if (scaling) {
        if (record.waiting === null) {
          record.waiting = { reason: "node", since: record.createdAt };
          tell.push({ kind: "waiting", reason: "node", since: new Date(record.createdAt) });
        }
        if (now - record.createdAt >= this.#nodeWaitMs) {
          return {
            kind: "fail",
            failure: "no-node",
            message: `No node joined within ${String(Math.round(this.#nodeWaitMs / 60_000))} minutes (OSTRA_K8S_NODE_WAIT_MINUTES): the task goes back to the queue.`,
            tell,
            unschedulableSince: since,
          };
        }
        return { kind: "waiting", tell, unschedulableSince: since };
      }
      if (now - since >= this.#scaleUpGraceMs) {
        return { kind: "fail", failure: "no-room", message: "The cluster has no room for the box and isn't adding a node: the task goes back to the queue.", tell, unschedulableSince: since };
      }
      return { kind: "waiting", tell, unschedulableSince: since };
    }
    if (pod.scheduled?.status === "True") {
      record.scheduledAt ??= now;
      if (record.waiting?.reason === "node") {
        tell.push({ kind: "scheduled", afterMs: Math.max(0, now - record.waiting.since) });
        record.waiting = null;
      }
    }
    const containers = [...pod.initContainers, ...pod.containers];
    if (containers.some((container) => container.state === "waiting" && container.reason !== null && PULL_FAILURES.has(container.reason))) {
      return { kind: "fail", failure: "image-pull", message: "An image of the box couldn't be pulled: check the registry and its pull credential.", tell, unschedulableSince: null };
    }
    const sidecar = pod.initContainers.find((container) => container.name === "sidecar");
    if (sidecar?.state === "running" && sidecar.ready) {
      if (record.waiting?.reason === "image-pull") {
        tell.push({ kind: "scheduled", afterMs: Math.max(0, now - record.waiting.since) });
        record.waiting = null;
      }
      return { kind: "running", tell, unschedulableSince: null };
    }
    // A pull still under way past its wait (`Pulling` without its `Pulled`): the box says it waits for its image.
    if (record.scheduledAt !== null && record.waiting === null && now - record.scheduledAt >= this.#imagePullWaitMs) {
      const events = await this.#kube.podEvents(this.#namespace, pod.name);
      const count = (reason: string): number => (events.ok ? events.value.filter((event) => event.reason === reason).length : 0);
      if (count("Pulling") > count("Pulled")) {
        record.waiting = { reason: "image-pull", since: record.scheduledAt };
        tell.push({ kind: "waiting", reason: "image-pull", since: new Date(record.scheduledAt) });
      }
    }
    return { kind: "waiting", tell, unschedulableSince: null };
  }

  #inner(box: BoxRef): AdapterResult<ExecutorAdapter> {
    const record = this.#boxes.get(keyOf(box));
    if (record === undefined) {
      return adapterError("not-found", "no such box");
    }
    if (record.inner === null) {
      return adapterError("unsupported", "on kubernetes the box's sidecar runs the task in the pod");
    }
    return ok(record.inner);
  }

  async startAgent(box: BoxRef, launch: AgentLaunch): Promise<AdapterResult<AgentProcess>> {
    const inner = this.#inner(box);
    return inner.ok ? inner.value.startAgent(box, launch) : inner;
  }

  async commitAndPush(input: CommitAndPushInput): Promise<AdapterResult<readonly RepoPushResult[]>> {
    const inner = this.#inner(input.box);
    return inner.ok ? inner.value.commitAndPush(input) : inner;
  }

  override async commitWork(input: CommitWorkInput): Promise<AdapterResult<readonly CommittedRepoWork[]>> {
    const inner = this.#inner(input.box);
    return inner.ok ? inner.value.commitWork(input) : inner;
  }

  override async saveWorkInProgress(input: SaveWorkInProgressInput): Promise<AdapterResult<readonly SavedRepoWork[]>> {
    const inner = this.#inner(input.box);
    return inner.ok ? inner.value.saveWorkInProgress(input) : inner;
  }

  override async restoreWorkInProgress(input: RestoreWorkInProgressInput): Promise<AdapterResult<readonly RestoredRepoWork[]>> {
    const inner = this.#inner(input.box);
    return inner.ok ? inner.value.restoreWorkInProgress(input) : inner;
  }

  override async runAgentCommand(input: RunAgentCommandInput): Promise<AdapterResult<AgentCommandResult>> {
    const inner = this.#inner(input.box);
    return inner.ok ? inner.value.runAgentCommand(input) : inner;
  }

  override async runChecks(box: BoxRef, input: Omit<RunChecksInput, "workspaceDir">): Promise<AdapterResult<readonly CheckRunResult[]>> {
    const inner = this.#inner(box);
    return inner.ok ? inner.value.runChecks(box, input) : inner;
  }

  async listWorkspaceRoot(box: BoxRef): Promise<AdapterResult<readonly string[]>> {
    const inner = this.#inner(box);
    return inner.ok ? inner.value.listWorkspaceRoot(box) : inner;
  }

  /**
   * A snapshot on `kubernetes` (ticket 08, F-120): a rootless BuildKit pod in the build namespace
   * (`snapshots.ts`), which exports an OCI tarball, scans it, and pushes only a clean image, with the
   * push credential, answering the digest boxes pull by. Without a push there's nowhere a kubelet
   * could pull from, so it's refused. Without the build namespace's egress policy, nothing is built.
   */
  override async buildSnapshot(input: BuildSnapshotInput): Promise<AdapterResult<SnapshotBuildResult>> {
    const push = input.push ?? null;
    if (push === null) {
      return adapterError("unsupported", "a kubernetes runner builds a snapshot only to push it to the organization's registry: its kubelets pull from there");
    }
    const log = this.plumbing.logger.child({ snapshotId: input.snapshotId, projectId: input.projectId });
    const started = this.#clock.now();
    const failed = (reason: "setup-failed" | "secret-found" | "build-failed", detail: string): AdapterResult<SnapshotBuildResult> =>
      ok({ outcome: "failed", reason, detail: detail.slice(0, 2000) });
    const policies = await this.#kube.networkPolicies(this.#buildNamespace);
    if (!policies.ok) {
      return adapterError("unavailable", `the build namespace's network policies can't be read: ${policies.message}`);
    }
    const problem = baselineProblem(policies.value, this.#buildNamespace, { [LABELS.partOf]: "ostra", [LABELS.role]: BUILD_ROLE }, "snapshot builds");
    if (problem !== null) {
      return adapterError("unavailable", problem);
    }
    const planned = planSnapshotBuild({
      snapshotId: input.snapshotId,
      projectId: input.projectId,
      environment: input.environment,
      credentials: input.credentials,
      defaultBaseImage: this.#images.base,
    });
    if (!planned.ok) {
      return failed("build-failed", planned.detail);
    }
    const plan: ContextPlan = {
      repos: input.environment.repos.map((repo) => ({
        cloneUrl: repo.cloneUrl,
        defaultBranch: repo.defaultBranch,
        checkoutDir: repo.checkoutDir,
        token: input.credentials.repos.find((entry) => entry.repoId === repo.repoId)?.gitToken ?? null,
        files: repo.files.map((file) => ({ path: file.path, content: file.content })),
      })),
      dockerfile: planned.plan.dockerfile,
      contextFiles: planned.plan.contextFiles,
    };
    const objects = buildObjects(
      { snapshotId: input.snapshotId, projectId: input.projectId, plan, secrets: planned.plan.secrets, scanFor: planned.plan.scanFor, push },
      {
        namespace: this.#buildNamespace,
        runnerImage: this.#images.runner,
        buildkitImage: this.#buildkitImage,
        switches: this.#buildkitSwitches,
        limits: this.#buildLimits,
        stepCommand: this.#buildStepCommand,
        buildkitCommand: this.#buildkitCommand,
      },
    );
    const values = [...planned.plan.secrets.map((secret) => secret.value), ...input.credentials.repos.map((repo) => repo.gitToken), push.credential.token].filter((value) => value.length >= 4);
    const redact = (text: string): string => values.reduce((out, value) => out.replaceAll(value, "[a secret]"), text);
    const cleanUp = async (): Promise<void> => {
      await this.#kube.deletePod(this.#buildNamespace, objects.names.pod, 0);
      for (const name of [objects.names.secret, objects.names.pushSecret]) await this.#kube.deleteSecret(this.#buildNamespace, name);
      // A pod's deletion is graceful: the build answers once its pod is gone.
      const deadline = this.#clock.now() + RELEASE_WAIT_MS;
      for (;;) {
        const read = await this.#kube.readPod(this.#buildNamespace, objects.names.pod);
        if (!read.ok || read.value === null || this.#clock.now() >= deadline) return;
        await this.#clock.sleep(this.#pollMs);
      }
    };
    try {
      for (const secret of [objects.secret, objects.pushSecret]) {
        const made = await this.#kube.createSecret(this.#buildNamespace, secret);
        if (!made.ok) return adapterError(made.status === 403 ? "forbidden" : "unavailable", `creating the build's secret failed: ${made.message}`);
      }
      const pod = await this.#kube.createPod(this.#buildNamespace, objects.pod);
      if (!pod.ok) return adapterError(pod.status === 403 ? "forbidden" : "unavailable", `creating the build's pod failed: ${pod.message}`);
      for (const name of [objects.names.secret, objects.names.pushSecret]) {
        await this.#kube.ownSecret(this.#buildNamespace, name, { name: pod.value.name, uid: pod.value.uid });
      }
      log.info("snapshot build started", { namespace: this.#buildNamespace });
      // The pod runs its steps in order; it ends Succeeded after a push, or Failed at the first step that fails.
      let ended: PodView | null = null;
      while (ended === null) {
        if (input.signal?.aborted === true) return adapterError("aborted", "the build was cancelled");
        if (this.#clock.now() - started >= this.#buildTimeoutMs) return failed("build-failed", "the build ran past its deadline");
        const read = await this.#kube.readPod(this.#buildNamespace, objects.names.pod);
        if (!read.ok) return adapterError("unavailable", `reading the build's pod failed: ${read.message}`);
        if (read.value === null) return failed("build-failed", "the build's pod is gone");
        if (read.value.phase === "Succeeded" || read.value.phase === "Failed") ended = read.value;
        else await this.#clock.sleep(this.#pollMs);
      }
      const logOf = async (container: string): Promise<string> => {
        const read = await this.#kube.podLog(this.#buildNamespace, objects.names.pod, container);
        return read.ok ? redact(read.value) : "";
      };
      const buildLog = await logOf("build");
      if (buildLog !== "") input.onOutput("stdout", buildLog);
      const step = (name: string) => ended.initContainers.find((container) => container.name === name) ?? ended.containers.find((container) => container.name === name);
      const exited = (name: string): number | null => {
        const status = step(name);
        return status?.state === "terminated" ? status.exitCode : null;
      };
      if (exited("context") !== 0) return failed("build-failed", "staging the build's context failed (a repo's clone)");
      if (exited("build") !== 0) {
        const setupFailed = buildLog.includes(SETUP_FAILED_MARKER);
        return failed(setupFailed ? "setup-failed" : "build-failed", setupFailed ? "the setup script failed in the snapshot build" : `the image build failed (exit ${String(exited("build"))})`);
      }
      if (exited("scan") === SCAN_HIT_EXIT) {
        const line = (await logOf("scan")).split("\n").find((each) => each.startsWith(SCAN_HIT_PREFIX)) ?? "";
        const names = line.slice(SCAN_HIT_PREFIX.length).trim();
        log.warn("a setup secret was found in the snapshot image: nothing was pushed", {});
        return failed("secret-found", `The setup secrets ${names === "" ? "" : `${names} `}were found in the image, so nothing was pushed. A setup script must not write a secret's value into a file.`);
      }
      if (exited("scan") !== 0) return failed("build-failed", "the image couldn't be scanned");
      const pushLog = await logOf("push");
      const resultLine = pushLog.split("\n").reverse().find((each) => each.startsWith(PUSH_RESULT_PREFIX));
      const result = resultLine === undefined ? null : parsePushResult(resultLine.slice(PUSH_RESULT_PREFIX.length));
      if (exited("push") !== 0 || result === null) return failed("build-failed", "the push to the registry failed");
      log.info("snapshot built and pushed", { blobs: result.blobs, durationMs: this.#clock.now() - started });
      return ok({ outcome: "built", imageRef: push.ref, imageDigest: result.digest, digest: result.digest, durationMs: Math.max(0, this.#clock.now() - started) });
    } finally {
      await cleanUp();
    }
  }

  /** A box's snapshot comes from the registry, by digest: this runner keeps none. */
  override hasSnapshot(snapshotId: SnapshotId): Promise<AdapterResult<KeptSnapshot | null>> {
    this.plumbing.logger.debug("a kubernetes runner keeps no snapshot: the registry does", { snapshotId });
    return Promise.resolve(ok(null));
  }

  /** Ends the task's processes and deletes the pod: a stopped pod is never kept (ADR 0039). */
  async stop(input: StopInput): Promise<AdapterResult<void>> {
    const record = this.#boxes.get(keyOf(input.box));
    if (record === undefined) {
      return adapterError("not-found", "no such box");
    }
    if (record.inner !== null) {
      await record.inner.stop(input);
    }
    record.phase = "stopped";
    const deleted = await this.#kube.deletePod(this.#namespace, record.objects.names.pod, Math.ceil(input.graceMs / 1000));
    if (!deleted.ok) {
      return adapterError("unavailable", `deleting the box's pod failed: ${deleted.message}`);
    }
    for (const name of [record.objects.names.secret, record.objects.names.pullSecret]) {
      await this.#kube.deleteSecret(this.#namespace, name);
    }
    return ok(undefined);
  }

  /** Deletes the pod and every object with the box's label. A box is never reused. */
  async release(box: BoxRef, reason: BoxReleaseReason): Promise<AdapterResult<void>> {
    const key = keyOf(box);
    const record = this.#boxes.get(key);
    if (record?.inner !== null && record?.inner !== undefined) {
      await record.inner.release(box, reason);
    }
    record?.closeBridge?.();
    const removed = await this.#removeObjects(box);
    this.#boxes.delete(key);
    this.#released.add(key);
    void this.refreshCapacity();
    if (!removed.ok) {
      return adapterError("unavailable", removed.message);
    }
    this.plumbing.logger.info("box released", { taskId: box.taskId, boxId: box.boxId, reason, objects: removed.value });
    return ok(undefined);
  }

  /** The pod by its name, then everything left with the box's label. Answers how many objects went. */
  async #removeObjects(box: BoxRef): Promise<KubeResult<number>> {
    const names = boxNames(box);
    let count = 0;
    const pod = await this.#kube.deletePod(this.#namespace, names.pod, 0);
    if (!pod.ok) return pod;
    const pods = await this.#kube.listPods(this.#namespace, boxSelector(box));
    if (!pods.ok) return pods;
    for (const each of pods.value) {
      const deleted = await this.#kube.deletePod(this.#namespace, each.name, 0);
      if (!deleted.ok) return deleted;
      count += 1;
    }
    const secrets = await this.#kube.listSecretNames(this.#namespace, boxSelector(box));
    if (!secrets.ok) return secrets;
    for (const name of secrets.value) {
      const deleted = await this.#kube.deleteSecret(this.#namespace, name);
      if (!deleted.ok) return deleted;
      count += 1;
    }
    // A pod's deletion is graceful: release answers once nothing of the box is left.
    const deadline = this.#clock.now() + RELEASE_WAIT_MS;
    for (;;) {
      const left = await this.#kube.listPods(this.#namespace, boxSelector(box));
      if (!left.ok) return left;
      if (left.value.length === 0) return { ok: true, value: count };
      if (this.#clock.now() >= deadline) return { ok: false, status: 0, message: `the box's pod was still there ${String(RELEASE_WAIT_MS / 1000)} s after its deletion` };
      await this.#clock.sleep(this.#pollMs);
    }
  }

  async state(box: BoxRef): Promise<AdapterResult<BoxState>> {
    const key = keyOf(box);
    const record = this.#boxes.get(key);
    if (record === undefined) {
      return this.#released.has(key) ? ok("released") : adapterError("not-found", "no such box");
    }
    if (record.phase === "stopped") return ok("stopped");
    if (record.phase === "failed") return ok("failed");
    const read = await this.#kube.readPod(this.#namespace, record.objects.names.pod);
    if (!read.ok) {
      return adapterError("unavailable", `reading the box's pod failed: ${read.message}`);
    }
    const pod = read.value;
    if (pod === null || pod.deleting) return ok("failed");
    switch (pod.phase) {
      case "Pending":
        return ok(record.phase === "running" ? "preparing" : "creating");
      case "Running":
        return ok(pod.ready ? "ready" : record.phase === "running" ? "preparing" : "creating");
      case "Succeeded":
        return ok("stopped");
      case "Failed":
      case "Unknown":
        return ok("failed");
      default:
        pod.phase satisfies never;
        return ok("failed");
    }
  }
}
