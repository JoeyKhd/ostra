import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";

import { issueTestCert, makeTestCa } from "@ostra/adapter-sdk/testing/net";
import { z } from "zod";

import {
  accessReviewSchema,
  dockerConfigSchema,
  metadataInSchema,
  objectInSchema,
  podSpecSchema,
  quotaSpecSchema,
  secretInSchema,
} from "./kube-schemas.ts";
import type { FakeContainerSpec, FakePodSpec, OwnerReference } from "./kube-schemas.ts";
import { runPodProcesses } from "./process-mode.ts";
import type { ContainerRun, PodProcesses, ProcessModeOptions } from "./process-mode.ts";
import { cpuText, isDnsLabel, isDnsSubdomain, labelKeyProblem, labelValueProblem, memoryText, parseQuantity, parseSelector } from "./selectors.ts";

// The fake Kubernetes API (ticket 06, spec section 8): an in-process HTTPS server, with a per-run CA, that
// `@kubernetes/client-node` talks to unmodified, through a kubeconfig. It keeps namespaces, pods,
// secrets, service accounts, roles and role bindings, network policies, resource quotas, config
// maps and events in memory, answers lists, gets, creates, deletes, patches and watches, and checks
// what an executor sets: native sidecars (`restartPolicy: Always` on an init container, refused
// under 1.29), owner references (a dependent of a missing owner is collected, a deleted owner's
// dependents with it), labels, names, volumes and quotas. A pod is scheduled, pulls its images and
// runs: simulated by default, or as local processes in the process mode (`process-mode.ts`).
// Switches hold pods unschedulable with the autoscaler's `TriggeredScaleUp` event, fail an image's
// pull, and report a version under 1.29. Test and dev only.

export type KubeObject = Readonly<Record<string, unknown>>;

type ResourceInfo = {
  readonly group: string;
  readonly version: string;
  readonly kind: string;
  readonly plural: string;
  readonly namespaced: boolean;
};

const RESOURCES: readonly ResourceInfo[] = [
  { group: "", version: "v1", kind: "Namespace", plural: "namespaces", namespaced: false },
  { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true },
  { group: "", version: "v1", kind: "Secret", plural: "secrets", namespaced: true },
  { group: "", version: "v1", kind: "ConfigMap", plural: "configmaps", namespaced: true },
  { group: "", version: "v1", kind: "ServiceAccount", plural: "serviceaccounts", namespaced: true },
  { group: "", version: "v1", kind: "Event", plural: "events", namespaced: true },
  { group: "", version: "v1", kind: "ResourceQuota", plural: "resourcequotas", namespaced: true },
  { group: "rbac.authorization.k8s.io", version: "v1", kind: "Role", plural: "roles", namespaced: true },
  { group: "rbac.authorization.k8s.io", version: "v1", kind: "RoleBinding", plural: "rolebindings", namespaced: true },
  { group: "networking.k8s.io", version: "v1", kind: "NetworkPolicy", plural: "networkpolicies", namespaced: true },
];

export type FakeKubeResource = "namespaces" | "pods" | "secrets" | "configmaps" | "serviceaccounts" | "events" | "resourcequotas" | "roles" | "rolebindings" | "networkpolicies";

const apiVersionOf = (info: ResourceInfo): string => (info.group === "" ? info.version : `${info.group}/${info.version}`);

type Metadata = {
  name: string;
  namespace?: string;
  uid: string;
  resourceVersion: string;
  creationTimestamp: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: OwnerReference[];
  deletionTimestamp?: string;
  generateName?: string;
};

type Stored = {
  readonly info: ResourceInfo;
  metadata: Metadata;
  /** Everything but `apiVersion`, `kind` and `metadata`. */
  body: Record<string, unknown>;
};

type Condition = { readonly type: string; readonly status: "True" | "False"; readonly reason?: string; readonly message?: string; readonly lastTransitionTime: string };

type ContainerState =
  | { readonly waiting: { readonly reason: string; readonly message?: string } }
  | { readonly running: { readonly startedAt: string } }
  | { readonly terminated: { readonly exitCode: number; readonly reason: string; readonly startedAt?: string; readonly finishedAt: string } };

type ContainerStatus = {
  readonly name: string;
  readonly image: string;
  readonly imageID: string;
  readonly ready: boolean;
  readonly started: boolean;
  readonly restartCount: number;
  readonly state: ContainerState;
};

export type FakePodPhase = "Pending" | "Running" | "Succeeded" | "Failed";

type PodRuntime = {
  readonly stored: Stored;
  readonly spec: FakePodSpec;
  phase: FakePodPhase;
  conditions: Condition[];
  /** Simulated containers' states, by name; the process mode's come from its runs. */
  readonly simulated: Map<string, ContainerState>;
  /** Containers whose image's pull failed, by name, with the image. */
  readonly pullFailed: Map<string, string>;
  scheduled: boolean;
  processes: PodProcesses | null;
  readonly timers: NodeJS.Timeout[];
  deleting: boolean;
};

/** A pull a kubelet made: the image as the pod names it, and the pull secret and user it used, if any (never the password). */
export type FakeKubePull = {
  readonly namespace: string;
  readonly pod: string;
  readonly container: string;
  readonly image: string;
  readonly pullSecret: string | null;
  readonly username: string | null;
};

export type FakeKubeRequest = { readonly method: string; readonly path: string; readonly namespace: string | null; readonly status: number };

export type FakeKubeOptions = {
  /** Runs each pod's containers as local processes (`process-mode.ts`). Absent: containers are simulated, and run until a test ends them. */
  readonly processMode?: ProcessModeOptions;
  /** The bearer token every request must carry. Default: a random one, which `kubeconfig()` names. */
  readonly token?: string;
  /** The minor version `/version` reports at first. Default: 31. */
  readonly minor?: number;
  /** The port to listen on, on loopback. Default: any free one. */
  readonly port?: number;
};

export type FakeKubeApi = {
  readonly url: string;
  /** The CA of the server's per-run certificate, PEM: the kubeconfig carries it. */
  readonly ca: string;
  readonly port: number;
  /** A kubeconfig (JSON, which YAML readers take) for this server, its token and a default namespace. */
  readonly kubeconfig: (namespace?: string) => string;
  /** Every object of a kind, in one namespace or all, as the API would serve it. */
  readonly list: (resource: FakeKubeResource, namespace?: string) => readonly KubeObject[];
  readonly get: (resource: FakeKubeResource, namespace: string | null, name: string) => KubeObject | undefined;
  /** Holds every pod scheduled in the next `ms` unschedulable, with `FailedScheduling` and the autoscaler's `TriggeredScaleUp`, then schedules it. */
  readonly holdUnschedulable: (ms: number) => void;
  /** Fails the pull of every image that starts with `image`, until `clearPullFailures`. */
  readonly failImagePull: (image: string) => void;
  readonly clearPullFailures: () => void;
  /** Reports `1.<minor>` from now on: under 29, an init container's `restartPolicy` is refused, as a 1.28 server refuses it. */
  readonly reportMinor: (minor: number) => void;
  /** Refuses the access reviews this says no to (a service account's missing permission). */
  readonly denyAccess: (deny: (attributes: { readonly namespace: string | null; readonly verb: string; readonly group: string; readonly resource: string }) => boolean) => void;
  /** Ends a simulated container with an exit code, as if its process ended. */
  readonly exitContainer: (namespace: string, pod: string, container: string, exitCode: number) => void;
  /** The process mode's view of a pod: its folder, its containers and their output. */
  readonly processesOf: (namespace: string, pod: string) => { readonly dir: string; readonly containers: readonly ContainerRun[]; readonly logs: (container: string) => string } | undefined;
  readonly pulls: () => readonly FakeKubePull[];
  readonly requests: () => readonly FakeKubeRequest[];
  readonly close: () => Promise<void>;
};

type ApiError = { readonly code: number; readonly reason: string; readonly message: string };

const statusBody = (error: ApiError): KubeObject => ({
  kind: "Status",
  apiVersion: "v1",
  metadata: {},
  status: "Failure",
  message: error.message,
  reason: error.reason,
  code: error.code,
});

const notFound = (info: ResourceInfo, name: string): ApiError => ({ code: 404, reason: "NotFound", message: `${info.plural} "${name}" not found` });
const invalid = (info: ResourceInfo, name: string, problems: readonly string[]): ApiError => ({
  code: 422,
  reason: "Invalid",
  message: `${info.kind} "${name}" is invalid: ${problems.join("; ")}`,
});

const now = (): string => new Date().toISOString();

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  const value: unknown = JSON.parse(text);
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** An object without `apiVersion`, `kind` and `metadata`: what the store keeps beside its metadata. */
const bodyOf = (object: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(object).filter(([key]) => key !== "apiVersion" && key !== "kind" && key !== "metadata"));

/** RFC 7386: what a merge patch (and, here, a strategic merge patch) does. */
const mergePatch = (target: unknown, patch: unknown): unknown => {
  if (!isRecord(patch)) return patch;
  const out: Record<string, unknown> = isRecord(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) Reflect.deleteProperty(out, key);
    else out[key] = mergePatch(out[key], value);
  }
  return out;
};

const jsonPatchOpSchema = z.looseObject({ op: z.enum(["add", "replace", "remove", "test"]), path: z.string(), value: z.unknown().optional() });

/** RFC 6902, the operations an executor sends: add, replace, remove and test. */
const jsonPatch = (target: unknown, ops: unknown): unknown => {
  const parsed = z.array(jsonPatchOpSchema).parse(ops);
  const root = structuredClone(target);
  for (const op of parsed) {
    const parts = op.path.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    const last = parts.pop();
    if (last === undefined) throw new Error("a JSON patch can't replace the whole object");
    let at: unknown = root;
    for (const part of parts) {
      at = Array.isArray(at) ? at[Number(part)] : isRecord(at) ? at[part] : undefined;
    }
    if (Array.isArray(at)) {
      const index = last === "-" ? at.length : Number(last);
      if (op.op === "remove") at.splice(index, 1);
      else if (op.op === "add") at.splice(index, 0, op.value);
      else if (op.op === "replace") at[index] = op.value;
    } else if (isRecord(at)) {
      if (op.op === "remove") Reflect.deleteProperty(at, last);
      else if (op.op === "test") {
        if (JSON.stringify(at[last]) !== JSON.stringify(op.value)) throw new Error(`test failed at ${op.path}`);
      } else at[last] = op.value;
    } else throw new Error(`no such path: ${op.path}`);
  }
  return root;
};

const quantityOf = (container: FakeContainerSpec, key: "requests" | "limits", resource: "cpu" | "memory"): number | null => {
  const text = container.resources?.[key]?.[resource] ?? (key === "requests" ? container.resources?.limits?.[resource] : undefined);
  return text === undefined ? null : parseQuantity(text);
};

/** A pod's effective resource, as the scheduler and the quota count it: its containers and native sidecars, or its largest plain init container. */
const podQuantity = (spec: FakePodSpec, key: "requests" | "limits", resource: "cpu" | "memory"): { readonly total: number; readonly missing: boolean } => {
  let missing = false;
  const sum = (containers: readonly FakeContainerSpec[]): number =>
    containers.reduce((total, container) => {
      const value = quantityOf(container, key, resource);
      if (value === null) missing = true;
      return total + (value ?? 0);
    }, 0);
  const init = spec.initContainers ?? [];
  const running = sum([...spec.containers, ...init.filter((container) => container.restartPolicy === "Always")]);
  const plainInit = Math.max(0, ...init.filter((container) => container.restartPolicy !== "Always").map((container) => quantityOf(container, key, resource) ?? 0));
  return { total: Math.max(running, plainInit), missing };
};

const QUOTA_KEYS: Readonly<Record<string, readonly ["requests" | "limits", "cpu" | "memory"]>> = {
  cpu: ["requests", "cpu"],
  memory: ["requests", "memory"],
  "requests.cpu": ["requests", "cpu"],
  "requests.memory": ["requests", "memory"],
  "limits.cpu": ["limits", "cpu"],
  "limits.memory": ["limits", "memory"],
};

export const startFakeKubeApi = async (options: FakeKubeOptions = {}): Promise<FakeKubeApi> => {
  const token = options.token ?? randomBytes(16).toString("hex");
  let minor = options.minor ?? 31;
  let resourceVersion = 1;
  let holdUntil = 0;
  const pullFailures = new Set<string>();
  let deny: Parameters<FakeKubeApi["denyAccess"]>[0] = () => false;
  const pulls: FakeKubePull[] = [];
  const requests: FakeKubeRequest[] = [];

  /** Objects by plural, then by `namespace/name` (`/name` for a cluster-scoped one). */
  const store = new Map<string, Map<string, Stored>>(RESOURCES.map((info) => [info.plural, new Map()]));
  const pods = new Map<string, PodRuntime>();
  type HistoryEntry = { readonly rv: number; readonly type: "ADDED" | "MODIFIED" | "DELETED"; readonly plural: string; readonly object: KubeObject; readonly stored: Stored };
  const history: HistoryEntry[] = [];
  type Watcher = { readonly plural: string; readonly namespace: string | null; readonly matches: (stored: Stored) => boolean; readonly response: ServerResponse };
  const watchers = new Set<Watcher>();

  const keyOf = (namespace: string | undefined, name: string): string => `${namespace ?? ""}/${name}`;
  const tableOf = (info: ResourceInfo): Map<string, Stored> => {
    const table = store.get(info.plural);
    if (table === undefined) throw new Error(`no table for ${info.plural}`);
    return table;
  };
  const infoOf = (plural: string): ResourceInfo | undefined => RESOURCES.find((info) => info.plural === plural);

  const serialize = (stored: Stored): KubeObject => {
    const body = stored.info.plural === "resourcequotas" ? { ...stored.body, status: quotaStatus(stored) } : stored.body;
    return { apiVersion: apiVersionOf(stored.info), kind: stored.info.kind, metadata: structuredClone(stored.metadata), ...structuredClone(body) };
  };

  const notify = (type: HistoryEntry["type"], stored: Stored): void => {
    const object = serialize(stored);
    history.push({ rv: Number(stored.metadata.resourceVersion), type, plural: stored.info.plural, object, stored });
    if (history.length > 5000) history.splice(0, history.length - 5000);
    for (const watcher of watchers) {
      if (watcher.plural !== stored.info.plural) continue;
      if (watcher.namespace !== null && watcher.namespace !== stored.metadata.namespace) continue;
      if (!watcher.matches(stored)) continue;
      watcher.response.write(`${JSON.stringify({ type, object })}\n`);
    }
  };

  const bump = (stored: Stored): void => {
    resourceVersion += 1;
    stored.metadata.resourceVersion = String(resourceVersion);
  };

  const insert = (info: ResourceInfo, metadata: Omit<Metadata, "uid" | "resourceVersion" | "creationTimestamp">, body: Record<string, unknown>): Stored => {
    resourceVersion += 1;
    const stored: Stored = {
      info,
      metadata: { ...metadata, uid: randomUUID(), resourceVersion: String(resourceVersion), creationTimestamp: now() },
      body,
    };
    tableOf(info).set(keyOf(metadata.namespace, metadata.name), stored);
    notify("ADDED", stored);
    return stored;
  };

  const namespacesInfo = infoOf("namespaces");
  const eventsInfo = infoOf("events");
  const quotasInfo = infoOf("resourcequotas");
  if (namespacesInfo === undefined || eventsInfo === undefined || quotasInfo === undefined) throw new Error("the fake's resource table is missing a kind");
  for (const name of ["default", "kube-system"]) insert(namespacesInfo, { name }, { spec: {}, status: { phase: "Active" } });

  const findByUid = (uid: string): Stored | undefined => {
    for (const table of store.values()) {
      for (const stored of table.values()) if (stored.metadata.uid === uid) return stored;
    }
    return undefined;
  };

  const emit = (pod: Stored, type: "Normal" | "Warning", reason: string, message: string, component: string): void => {
    const time = now();
    insert(
      eventsInfo,
      { name: `${pod.metadata.name}.${randomBytes(8).toString("hex")}`, namespace: pod.metadata.namespace ?? "default" },
      {
        involvedObject: { kind: "Pod", namespace: pod.metadata.namespace, name: pod.metadata.name, uid: pod.metadata.uid, apiVersion: "v1" },
        reason,
        message,
        type,
        source: { component },
        count: 1,
        firstTimestamp: time,
        lastTimestamp: time,
      },
    );
  };

  // ---------- pods: scheduling, pulls, containers and status ----------

  const containerStatuses = (runtime: PodRuntime, containers: readonly FakeContainerSpec[], sidecars: boolean): ContainerStatus[] =>
    containers.map((container) => {
      const image = container.image ?? "";
      const failed = runtime.pullFailed.get(container.name);
      const run = runtime.processes?.containers().find((item) => item.name === container.name);
      let state: ContainerState;
      if (failed !== undefined) {
        state = { waiting: { reason: "ImagePullBackOff", message: `Back-off pulling image "${failed}"` } };
      } else if (run !== undefined) {
        state =
          run.state === "running"
            ? { running: { startedAt: (run.startedAt ?? new Date()).toISOString() } }
            : run.state === "exited"
              ? {
                  terminated: {
                    exitCode: run.exitCode ?? 0,
                    reason: run.exitCode === 0 ? "Completed" : "Error",
                    ...(run.startedAt === null ? {} : { startedAt: run.startedAt.toISOString() }),
                    finishedAt: (run.finishedAt ?? new Date()).toISOString(),
                  },
                }
              : { waiting: { reason: "PodInitializing" } };
      } else {
        state = runtime.simulated.get(container.name) ?? { waiting: { reason: runtime.scheduled ? "ContainerCreating" : "PodInitializing" } };
      }
      const running = "running" in state;
      return {
        name: container.name,
        image,
        imageID: running || "terminated" in state ? `${image.split("@")[0] ?? image}@sha256:${"0".repeat(64)}` : "",
        ready: running,
        started: running || (sidecars && running),
        restartCount: 0,
        state,
      };
    });

  /** The pod's phase and conditions, from its containers, as the kubelet reports them. */
  const refreshPod = (runtime: PodRuntime): void => {
    if (!tableOf(runtime.stored.info).has(keyOf(runtime.stored.metadata.namespace, runtime.stored.metadata.name))) return;
    const init = runtime.spec.initContainers ?? [];
    const initStatuses = containerStatuses(runtime, init, true);
    const mainStatuses = containerStatuses(runtime, runtime.spec.containers, false);
    if (runtime.scheduled && runtime.pullFailed.size === 0) {
      const plainInitFailed = initStatuses.some((status, index) => init[index]?.restartPolicy !== "Always" && "terminated" in status.state && status.state.terminated.exitCode !== 0);
      const mainEnded = mainStatuses.length > 0 && mainStatuses.every((status) => "terminated" in status.state);
      const mainStarted = mainStatuses.some((status) => !("waiting" in status.state));
      if (plainInitFailed) runtime.phase = "Failed";
      else if (mainEnded) runtime.phase = mainStatuses.every((status) => "terminated" in status.state && status.state.terminated.exitCode === 0) ? "Succeeded" : "Failed";
      else if (mainStarted) runtime.phase = "Running";
    }
    const time = now();
    const ready = runtime.phase === "Running" && mainStatuses.every((status) => status.ready) && initStatuses.every((status, index) => init[index]?.restartPolicy !== "Always" || status.ready);
    const initialized = runtime.scheduled && initStatuses.every((status, index) => (init[index]?.restartPolicy === "Always" ? status.started : "terminated" in status.state && status.state.terminated.exitCode === 0));
    const scheduledCondition = runtime.conditions.find((condition) => condition.type === "PodScheduled");
    runtime.conditions = [
      ...(scheduledCondition === undefined ? [] : [scheduledCondition]),
      ...(runtime.scheduled
        ? [
            { type: "Initialized", status: initialized ? "True" : "False", lastTransitionTime: time } as const,
            { type: "ContainersReady", status: ready ? "True" : "False", lastTransitionTime: time } as const,
            { type: "Ready", status: ready ? "True" : "False", lastTransitionTime: time } as const,
          ]
        : []),
    ];
    runtime.stored.body["status"] = {
      phase: runtime.phase,
      conditions: runtime.conditions,
      ...(runtime.scheduled ? { hostIP: "127.0.0.1", podIP: "127.0.0.1", startTime: runtime.stored.metadata.creationTimestamp } : {}),
      ...(init.length > 0 ? { initContainerStatuses: initStatuses } : {}),
      containerStatuses: mainStatuses,
    };
    bump(runtime.stored);
    notify("MODIFIED", runtime.stored);
  };

  const pullSecretFor = (runtime: PodRuntime, image: string): { readonly secret: string | null; readonly username: string | null } => {
    const host = image.includes("/") && /[.:]/.test(image.split("/")[0] ?? "") ? (image.split("/")[0] ?? "") : "docker.io";
    for (const reference of runtime.spec.imagePullSecrets ?? []) {
      const secret = tableOf(secretInfo()).get(keyOf(runtime.stored.metadata.namespace, reference.name));
      const data = secret === undefined ? undefined : secretData(secret)[".dockerconfigjson"];
      if (data === undefined) continue;
      const config = dockerConfigSchema.safeParse(JSON.parse(data.toString("utf8")));
      const entry = config.success ? config.data.auths[host] : undefined;
      if (entry === undefined) continue;
      const username = entry.username ?? (entry.auth === undefined ? null : (Buffer.from(entry.auth, "base64").toString("utf8").split(":")[0] ?? null));
      return { secret: reference.name, username };
    }
    return { secret: null, username: null };
  };

  const startContainers = async (runtime: PodRuntime): Promise<void> => {
    const namespace = runtime.stored.metadata.namespace ?? "default";
    const containers = [...(runtime.spec.initContainers ?? []), ...runtime.spec.containers];
    for (const container of containers) {
      const image = container.image ?? "";
      const failing = [...pullFailures].some((prefix) => image.startsWith(prefix));
      if (failing) {
        runtime.pullFailed.set(container.name, image);
        emit(runtime.stored, "Warning", "Failed", `Failed to pull image "${image}": rpc error: code = NotFound desc = failed to pull and unpack image`, "kubelet");
        emit(runtime.stored, "Warning", "Failed", "Error: ErrImagePull", "kubelet");
        continue;
      }
      const { secret, username } = pullSecretFor(runtime, image);
      pulls.push({ namespace, pod: runtime.stored.metadata.name, container: container.name, image, pullSecret: secret, username });
      emit(runtime.stored, "Normal", "Pulled", `Successfully pulled image "${image}"`, "kubelet");
    }
    if (runtime.pullFailed.size > 0) {
      refreshPod(runtime);
      return;
    }
    if (options.processMode === undefined) {
      const time = now();
      for (const container of runtime.spec.initContainers ?? []) {
        runtime.simulated.set(container.name, container.restartPolicy === "Always" ? { running: { startedAt: time } } : { terminated: { exitCode: 0, reason: "Completed", startedAt: time, finishedAt: time } });
      }
      for (const container of runtime.spec.containers) runtime.simulated.set(container.name, { running: { startedAt: time } });
      refreshPod(runtime);
      return;
    }
    runtime.processes = await runPodProcesses(
      {
        namespace,
        name: runtime.stored.metadata.name,
        uid: runtime.stored.metadata.uid,
        spec: runtime.spec,
        secret: (name) => {
          const secret = tableOf(secretInfo()).get(keyOf(namespace, name));
          return secret === undefined ? undefined : secretData(secret);
        },
        onChange: () => {
          if (!runtime.deleting) refreshPod(runtime);
        },
      },
      options.processMode,
    );
    if (runtime.deleting) {
      await runtime.processes.stop();
      return;
    }
    refreshPod(runtime);
  };

  const schedule = (runtime: PodRuntime): void => {
    const go = (): void => {
      if (runtime.deleting) return;
      runtime.scheduled = true;
      runtime.stored.body["spec"] = { ...(isRecord(runtime.stored.body["spec"]) ? runtime.stored.body["spec"] : {}), nodeName: "fake-node-1" };
      runtime.conditions = [{ type: "PodScheduled", status: "True", lastTransitionTime: now() }];
      emit(runtime.stored, "Normal", "Scheduled", `Successfully assigned ${runtime.stored.metadata.namespace ?? ""}/${runtime.stored.metadata.name} to fake-node-1`, "default-scheduler");
      refreshPod(runtime);
      void startContainers(runtime);
    };
    const wait = holdUntil - Date.now();
    if (wait <= 0) {
      runtime.timers.push(setTimeout(go, 0));
      return;
    }
    runtime.conditions = [
      { type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/1 nodes are available: 1 Insufficient cpu, 1 Insufficient memory.", lastTransitionTime: now() },
    ];
    refreshPod(runtime);
    emit(runtime.stored, "Warning", "FailedScheduling", "0/1 nodes are available: 1 Insufficient cpu, 1 Insufficient memory.", "default-scheduler");
    emit(runtime.stored, "Normal", "TriggeredScaleUp", "pod triggered scale-up: [{fake-node-group 1->2 (max: 10)}]", "cluster-autoscaler");
    runtime.timers.push(setTimeout(go, wait));
  };

  // ---------- secrets and quotas ----------

  const secretInfo = (): ResourceInfo => {
    const info = infoOf("secrets");
    if (info === undefined) throw new Error("no secrets");
    return info;
  };

  const secretData = (stored: Stored): Record<string, Buffer> => {
    const data = stored.body["data"];
    const out: Record<string, Buffer> = {};
    if (isRecord(data)) {
      for (const [key, value] of Object.entries(data)) if (typeof value === "string") out[key] = Buffer.from(value, "base64");
    }
    return out;
  };

  const livePodsIn = (namespace: string): FakePodSpec[] =>
    [...pods.values()].filter((runtime) => runtime.stored.metadata.namespace === namespace && runtime.phase !== "Succeeded" && runtime.phase !== "Failed").map((runtime) => runtime.spec);

  const quotaHard = (stored: Stored): Record<string, string> => {
    const spec = quotaSpecSchema.safeParse(stored.body["spec"] ?? {});
    return spec.success ? (spec.data.hard ?? {}) : {};
  };

  const usedIn = (namespace: string, extra: FakePodSpec | null): Record<string, number> => {
    const specs = [...livePodsIn(namespace), ...(extra === null ? [] : [extra])];
    const used: Record<string, number> = { pods: specs.length };
    for (const [key, [kind, resource]] of Object.entries(QUOTA_KEYS)) {
      used[key] = specs.reduce((total, spec) => total + podQuantity(spec, kind, resource).total, 0);
    }
    return used;
  };

  const quotaStatus = (stored: Stored): KubeObject => {
    const hard = quotaHard(stored);
    const used = usedIn(stored.metadata.namespace ?? "default", null);
    const usedText: Record<string, string> = {};
    for (const key of Object.keys(hard)) {
      const value = used[key] ?? 0;
      usedText[key] = key === "pods" ? String(value) : key.endsWith("cpu") ? cpuText(value) : memoryText(value);
    }
    return { hard, used: usedText };
  };

  /** A pod over a quota of its namespace is refused, as the quota admission refuses it. */
  const quotaProblem = (namespace: string, spec: FakePodSpec): ApiError | null => {
    for (const quota of tableOf(quotasInfo).values()) {
      if (quota.metadata.namespace !== namespace) continue;
      const hard = quotaHard(quota);
      const used = usedIn(namespace, spec);
      for (const [key, limitText] of Object.entries(hard)) {
        const limit = parseQuantity(limitText);
        const pair = QUOTA_KEYS[key];
        if (pair !== undefined && podQuantity(spec, pair[0], pair[1]).missing) {
          return { code: 403, reason: "Forbidden", message: `pods is forbidden: failed quota: ${quota.metadata.name}: must specify ${key}` };
        }
        if (limit !== null && (used[key] ?? 0) > limit + 1e-9) {
          return { code: 403, reason: "Forbidden", message: `pods is forbidden: exceeded quota: ${quota.metadata.name}, requested: ${key}, limited: ${key}=${limitText}` };
        }
      }
    }
    return null;
  };

  // ---------- validation ----------

  const validate = (info: ResourceInfo, metadata: Metadata, body: Record<string, unknown>): { readonly problems: string[]; readonly pod: FakePodSpec | null } => {
    const problems: string[] = [];
    if (!(info.plural === "namespaces" || info.plural === "serviceaccounts" ? isDnsLabel(metadata.name) : isDnsSubdomain(metadata.name)) && info.plural !== "events") {
      problems.push(`metadata.name: Invalid value: "${metadata.name}": a lowercase RFC 1123 name`);
    }
    for (const [key, value] of Object.entries(metadata.labels ?? {})) {
      const keyProblem = labelKeyProblem(key);
      if (keyProblem !== null) problems.push(`metadata.labels: Invalid value: ${keyProblem}`);
      const valueProblem = labelValueProblem(value);
      if (valueProblem !== null) problems.push(`metadata.labels: Invalid value: ${valueProblem}`);
    }
    for (const [index, owner] of (metadata.ownerReferences ?? []).entries()) {
      if (!info.namespaced) problems.push(`metadata.ownerReferences[${String(index)}]: a cluster-scoped object can't have a namespaced owner`);
      if (owner.uid.trim() === "") problems.push(`metadata.ownerReferences[${String(index)}].uid: Required value`);
    }
    let pod: FakePodSpec | null = null;
    if (info.plural === "pods") {
      const parsed = podSpecSchema.safeParse(body["spec"]);
      if (!parsed.success) {
        problems.push(`spec: Invalid value: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join(", ")}`);
        return { problems, pod };
      }
      pod = parsed.data;
      if (pod.containers.length === 0) problems.push("spec.containers: Required value");
      const names = new Set<string>();
      const volumes = new Set((pod.volumes ?? []).map((volume) => volume.name));
      const check = (container: FakeContainerSpec, where: string): void => {
        if (!isDnsLabel(container.name)) problems.push(`${where}.name: Invalid value: "${container.name}"`);
        if (names.has(container.name)) problems.push(`${where}.name: Duplicate value: "${container.name}"`);
        names.add(container.name);
        if ((container.image ?? "").trim() === "") problems.push(`${where}.image: Required value`);
        for (const [mountIndex, mount] of (container.volumeMounts ?? []).entries()) {
          if (!volumes.has(mount.name)) problems.push(`${where}.volumeMounts[${String(mountIndex)}].name: Not found: "${mount.name}"`);
          if (!mount.mountPath.startsWith("/")) problems.push(`${where}.volumeMounts[${String(mountIndex)}].mountPath: must be an absolute path`);
        }
      };
      for (const [index, container] of (pod.initContainers ?? []).entries()) {
        const where = `spec.initContainers[${String(index)}]`;
        check(container, where);
        if (container.restartPolicy !== undefined) {
          if (minor < 29) problems.push(`${where}.restartPolicy: Forbidden: may not be set for init containers`);
          else if (container.restartPolicy !== "Always") problems.push(`${where}.restartPolicy: Unsupported value: "${container.restartPolicy}": supported values: "Always"`);
        }
      }
      for (const [index, container] of pod.containers.entries()) {
        const where = `spec.containers[${String(index)}]`;
        check(container, where);
        if (container.restartPolicy !== undefined) problems.push(`${where}.restartPolicy: Forbidden: may not be set for non-init containers`);
      }
      if (pod.restartPolicy !== undefined && !["Always", "OnFailure", "Never"].includes(pod.restartPolicy)) {
        problems.push(`spec.restartPolicy: Unsupported value: "${pod.restartPolicy}"`);
      }
      for (const [index, volume] of (pod.volumes ?? []).entries()) {
        if (!isDnsLabel(volume.name)) problems.push(`spec.volumes[${String(index)}].name: Invalid value: "${volume.name}"`);
      }
    }
    if (info.plural === "secrets") {
      const parsed = secretInSchema.safeParse(body);
      if (!parsed.success) problems.push("data: Invalid value");
      else {
        for (const [key, value] of Object.entries(parsed.data.data ?? {})) {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) problems.push(`data[${key}]: Invalid value: not base64`);
        }
        if (parsed.data.type === "kubernetes.io/dockerconfigjson" && parsed.data.data?.[".dockerconfigjson"] === undefined) {
          problems.push('data[.dockerconfigjson]: Required value: a "kubernetes.io/dockerconfigjson" secret needs it');
        }
      }
    }
    return { problems, pod };
  };

  // ---------- deletion and the garbage collector ----------

  const remove = async (stored: Stored): Promise<void> => {
    const table = tableOf(stored.info);
    const key = keyOf(stored.metadata.namespace, stored.metadata.name);
    if (table.get(key) !== stored) return;
    if (stored.info.plural === "pods") {
      const runtime = pods.get(stored.metadata.uid);
      if (runtime !== undefined) {
        runtime.deleting = true;
        for (const timer of runtime.timers) clearTimeout(timer);
        await runtime.processes?.stop();
        pods.delete(stored.metadata.uid);
      }
    }
    if (table.get(key) !== stored) return;
    table.delete(key);
    bump(stored);
    notify("DELETED", stored);
    if (stored.info.plural === "namespaces") {
      for (const table of store.values()) {
        for (const item of [...table.values()]) if (item.metadata.namespace === stored.metadata.name) await remove(item);
      }
    }
    // The garbage collector: every dependent of the deleted object goes with it.
    for (const table of store.values()) {
      for (const item of [...table.values()]) {
        if ((item.metadata.ownerReferences ?? []).some((owner) => owner.uid === stored.metadata.uid)) await remove(item);
      }
    }
  };

  /** A dependent whose owners are all missing from its namespace is collected, as the garbage collector would. */
  const collectOrphan = (stored: Stored): void => {
    const owners = stored.metadata.ownerReferences ?? [];
    if (owners.length === 0) return;
    const present = owners.some((owner) => {
      const found = findByUid(owner.uid);
      return found !== undefined && found.metadata.namespace === stored.metadata.namespace && found.metadata.name === owner.name;
    });
    if (!present) setTimeout(() => void remove(stored), 0);
  };

  // ---------- HTTP ----------

  type Route =
    | { readonly kind: "version" }
    | { readonly kind: "discovery"; readonly group: string | null; readonly version: string | null }
    | { readonly kind: "access-review" }
    | { readonly kind: "collection"; readonly info: ResourceInfo; readonly namespace: string | null }
    | { readonly kind: "item"; readonly info: ResourceInfo; readonly namespace: string | null; readonly name: string; readonly sub: string | null };

  const route = (pathname: string): Route | null => {
    const parts = pathname.split("/").filter((part) => part !== "").map(decodeURIComponent);
    if (parts.length === 1 && parts[0] === "version") return { kind: "version" };
    let group: string;
    let version: string;
    let rest: string[];
    if (parts[0] === "api") {
      group = "";
      version = parts[1] ?? "";
      rest = parts.slice(2);
      if (parts.length === 1) return { kind: "discovery", group: null, version: null };
    } else if (parts[0] === "apis") {
      if (parts.length === 1) return { kind: "discovery", group: null, version: null };
      group = parts[1] ?? "";
      version = parts[2] ?? "";
      rest = parts.slice(3);
      if (group === "authorization.k8s.io" && rest[0] === "selfsubjectaccessreviews") return { kind: "access-review" };
    } else return null;
    if (version === "" || rest.length === 0) return { kind: "discovery", group, version: version === "" ? null : version };
    const lookup = (plural: string | undefined): ResourceInfo | undefined => RESOURCES.find((info) => info.plural === plural && info.group === group && info.version === version);
    if (rest[0] === "namespaces" && rest.length >= 3) {
      const info = lookup(rest[2]);
      if (info === undefined) return null;
      const namespace = rest[1] ?? null;
      return rest.length === 3 ? { kind: "collection", info, namespace } : { kind: "item", info, namespace, name: rest[3] ?? "", sub: rest[4] ?? null };
    }
    const info = lookup(rest[0]);
    if (info === undefined) return null;
    return rest.length === 1 ? { kind: "collection", info, namespace: null } : { kind: "item", info, namespace: null, name: rest[1] ?? "", sub: rest[2] ?? null };
  };

  const send = (response: ServerResponse, status: number, body: KubeObject): void => {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const fail = (response: ServerResponse, error: ApiError): void => {
    send(response, error.code, statusBody(error));
  };

  const fieldOf = (stored: Stored, key: string): string | undefined => {
    if (key === "metadata.name") return stored.metadata.name;
    if (key === "metadata.namespace") return stored.metadata.namespace;
    if (key === "status.phase") return pods.get(stored.metadata.uid)?.phase;
    if (key === "spec.nodeName") {
      const spec = stored.body["spec"];
      return isRecord(spec) && typeof spec["nodeName"] === "string" ? spec["nodeName"] : undefined;
    }
    if (key.startsWith("involvedObject.")) {
      const involved = stored.body["involvedObject"];
      const field = involved === undefined || !isRecord(involved) ? undefined : involved[key.slice("involvedObject.".length)];
      return typeof field === "string" ? field : undefined;
    }
    const value = stored.body[key];
    return typeof value === "string" ? value : undefined;
  };

  const matcher = (url: URL): ((stored: Stored) => boolean) | null => {
    const labels = parseSelector(url.searchParams.get("labelSelector"));
    const fields = parseSelector(url.searchParams.get("fieldSelector"));
    if (labels === null || fields === null) return null;
    return (stored) => labels((key) => stored.metadata.labels?.[key]) && fields((key) => fieldOf(stored, key));
  };

  const inScope = (stored: Stored, namespace: string | null): boolean => namespace === null || stored.metadata.namespace === namespace;

  const listOf = (info: ResourceInfo, items: readonly Stored[]): KubeObject => ({
    apiVersion: apiVersionOf(info),
    kind: `${info.kind}List`,
    metadata: { resourceVersion: String(resourceVersion) },
    items: items.map(serialize),
  });

  const namespaceExists = (namespace: string): boolean => tableOf(namespacesInfo).has(keyOf(undefined, namespace));

  const create = (info: ResourceInfo, namespace: string | null, input: unknown): { readonly stored: Stored } | { readonly error: ApiError } => {
    const parsed = objectInSchema.safeParse(input);
    if (!parsed.success) return { error: { code: 400, reason: "BadRequest", message: "the body isn't a Kubernetes object" } };
    const metaIn = parsed.data.metadata ?? {};
    const name = metaIn.name ?? (metaIn.generateName === undefined ? "" : `${metaIn.generateName}${randomBytes(3).toString("hex").slice(0, 5)}`);
    if (name === "") return { error: invalid(info, "", ["metadata.name: Required value: name or generateName is required"]) };
    if (info.namespaced) {
      if (namespace === null) return { error: { code: 400, reason: "BadRequest", message: `a ${info.kind} is created in a namespace` } };
      if (metaIn.namespace !== undefined && metaIn.namespace !== namespace) {
        return { error: { code: 400, reason: "BadRequest", message: "the namespace of the provided object does not match the namespace sent on the request" } };
      }
      if (!namespaceExists(namespace)) return { error: { code: 404, reason: "NotFound", message: `namespaces "${namespace}" not found` } };
    }
    const metadata: Metadata = {
      name,
      uid: "",
      resourceVersion: "",
      creationTimestamp: "",
      ...(info.namespaced && namespace !== null ? { namespace } : {}),
      ...(metaIn.labels === undefined ? {} : { labels: metaIn.labels }),
      ...(metaIn.annotations === undefined ? {} : { annotations: metaIn.annotations }),
      ...(metaIn.ownerReferences === undefined ? {} : { ownerReferences: metaIn.ownerReferences }),
      ...(metaIn.generateName === undefined ? {} : { generateName: metaIn.generateName }),
    };
    const body = bodyOf(parsed.data);
    const { problems, pod } = validate(info, metadata, body);
    if (problems.length > 0) return { error: invalid(info, name, problems) };
    if (tableOf(info).has(keyOf(metadata.namespace, name))) return { error: { code: 409, reason: "AlreadyExists", message: `${info.plural} "${name}" already exists` } };
    if (info.plural === "secrets") {
      // As the API server does: `stringData` is written into `data`, base64, and never served.
      const secret = secretInSchema.parse(body);
      const data: Record<string, string> = { ...(secret.data ?? {}) };
      for (const [key, value] of Object.entries(secret.stringData ?? {})) data[key] = Buffer.from(value, "utf8").toString("base64");
      delete body["stringData"];
      body["data"] = data;
      body["type"] = secret.type ?? "Opaque";
    }
    if (pod !== null && namespace !== null) {
      const over = quotaProblem(namespace, pod);
      if (over !== null) return { error: over };
    }
    if (info.plural === "namespaces") body["status"] = { phase: "Active" };
    if (pod !== null) body["status"] = { phase: "Pending" };
    const stored = insert(info, metadata, body);
    if (pod !== null) {
      const runtime: PodRuntime = { stored, spec: pod, phase: "Pending", conditions: [], simulated: new Map(), pullFailed: new Map(), scheduled: false, processes: null, timers: [], deleting: false };
      pods.set(stored.metadata.uid, runtime);
      refreshPod(runtime);
      schedule(runtime);
    }
    collectOrphan(stored);
    return { stored };
  };

  const watch = (url: URL, info: ResourceInfo, namespace: string | null, matches: (stored: Stored) => boolean, response: ServerResponse): void => {
    response.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
    // The headers go at once: a watcher waits for them before it hears any event.
    response.flushHeaders();
    const since = url.searchParams.get("resourceVersion");
    if (since === null || since === "" || since === "0") {
      for (const stored of tableOf(info).values()) {
        if (inScope(stored, namespace) && matches(stored)) response.write(`${JSON.stringify({ type: "ADDED", object: serialize(stored) })}\n`);
      }
    } else {
      for (const entry of history) {
        if (entry.rv > Number(since) && entry.plural === info.plural && inScope(entry.stored, namespace) && matches(entry.stored)) {
          response.write(`${JSON.stringify({ type: entry.type, object: entry.object })}\n`);
        }
      }
    }
    const watcher: Watcher = { plural: info.plural, namespace, matches, response };
    watchers.add(watcher);
    const timeout = Number(url.searchParams.get("timeoutSeconds") ?? "0");
    const timer = timeout > 0 ? setTimeout(() => response.end(), timeout * 1000) : undefined;
    response.on("close", () => {
      watchers.delete(watcher);
      if (timer !== undefined) clearTimeout(timer);
    });
  };

  const discovery = (group: string | null, version: string | null): KubeObject => {
    if (group === null) {
      const groups = [...new Set(RESOURCES.filter((info) => info.group !== "").map((info) => info.group))];
      return {
        kind: "APIGroupList",
        apiVersion: "v1",
        groups: groups.map((name) => ({ name, versions: [{ groupVersion: `${name}/v1`, version: "v1" }], preferredVersion: { groupVersion: `${name}/v1`, version: "v1" } })),
      };
    }
    if (version === null && group === "") return { kind: "APIVersions", versions: ["v1"] };
    return {
      kind: "APIResourceList",
      apiVersion: "v1",
      groupVersion: group === "" ? (version ?? "v1") : `${group}/${version ?? "v1"}`,
      resources: RESOURCES.filter((info) => info.group === group).map((info) => ({
        name: info.plural,
        singularName: info.kind.toLowerCase(),
        namespaced: info.namespaced,
        kind: info.kind,
        verbs: ["create", "delete", "deletecollection", "get", "list", "patch", "update", "watch"],
      })),
    };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://kube.invalid");
    const method = request.method ?? "GET";
    const record = (status: number, namespace: string | null): void => {
      requests.push({ method, path: url.pathname, namespace, status });
    };
    if (request.headers.authorization !== `Bearer ${token}`) {
      record(401, null);
      fail(response, { code: 401, reason: "Unauthorized", message: "Unauthorized" });
      return;
    }
    const target = route(url.pathname);
    const namespace = target !== null && (target.kind === "collection" || target.kind === "item") ? target.namespace : null;
    const reply = (status: number, body: KubeObject): void => {
      record(status, namespace);
      send(response, status, body);
    };
    const refuse = (error: ApiError): void => {
      record(error.code, namespace);
      fail(response, error);
    };
    if (target === null) {
      refuse({ code: 404, reason: "NotFound", message: "the server could not find the requested resource" });
      return;
    }
    switch (target.kind) {
      case "version":
        reply(200, { major: "1", minor: String(minor), gitVersion: `v1.${String(minor)}.0`, platform: "linux/amd64", goVersion: "go1.22.0" });
        return;
      case "discovery":
        reply(200, discovery(target.group, target.version));
        return;
      case "access-review": {
        const review = accessReviewSchema.safeParse(await readBody(request));
        if (!review.success) {
          refuse({ code: 400, reason: "BadRequest", message: "not a SelfSubjectAccessReview" });
          return;
        }
        const attributes = review.data.spec.resourceAttributes ?? {};
        const allowed = !deny({ namespace: attributes.namespace ?? null, verb: attributes.verb ?? "", group: attributes.group ?? "", resource: attributes.resource ?? "" });
        reply(201, { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview", spec: review.data.spec, status: { allowed } });
        return;
      }
      case "collection": {
        const matches = matcher(url);
        if (matches === null) {
          refuse({ code: 400, reason: "BadRequest", message: "unable to parse the selector" });
          return;
        }
        if (method === "GET") {
          if (url.searchParams.get("watch") === "true" || url.searchParams.get("watch") === "1") {
            record(200, target.namespace);
            watch(url, target.info, target.namespace, matches, response);
            return;
          }
          reply(200, listOf(target.info, [...tableOf(target.info).values()].filter((stored) => inScope(stored, target.namespace) && matches(stored))));
          return;
        }
        if (method === "POST") {
          const made = create(target.info, target.namespace, await readBody(request));
          if ("error" in made) refuse(made.error);
          else reply(201, serialize(made.stored));
          return;
        }
        if (method === "DELETE") {
          const doomed = [...tableOf(target.info).values()].filter((stored) => inScope(stored, target.namespace) && matches(stored));
          for (const stored of doomed) await remove(stored);
          reply(200, listOf(target.info, doomed));
          return;
        }
        refuse({ code: 405, reason: "MethodNotAllowed", message: `${method} isn't allowed here` });
        return;
      }
      case "item": {
        const stored = tableOf(target.info).get(keyOf(target.info.namespaced ? (target.namespace ?? undefined) : undefined, target.name));
        if (stored === undefined) {
          refuse(notFound(target.info, target.name));
          return;
        }
        if (target.sub === "log" && target.info.plural === "pods") {
          const container = url.searchParams.get("container") ?? pods.get(stored.metadata.uid)?.spec.containers[0]?.name ?? "";
          const text = pods.get(stored.metadata.uid)?.processes?.logs(container) ?? "";
          record(200, namespace);
          response.writeHead(200, { "content-type": "text/plain" }).end(text);
          return;
        }
        if (method === "GET") {
          reply(200, serialize(stored));
          return;
        }
        if (method === "DELETE") {
          if (target.info.plural === "pods") {
            stored.metadata.deletionTimestamp = now();
            bump(stored);
            notify("MODIFIED", stored);
            const answer = serialize(stored);
            setTimeout(() => void remove(stored), 0);
            reply(200, answer);
            return;
          }
          await remove(stored);
          reply(200, { kind: "Status", apiVersion: "v1", metadata: {}, status: "Success", details: { name: target.name, kind: target.info.plural, uid: stored.metadata.uid } });
          return;
        }
        if (method === "PATCH" || method === "PUT") {
          const input = await readBody(request);
          let next: unknown;
          try {
            const type = request.headers["content-type"] ?? "";
            next = method === "PUT" ? input : type.includes("json-patch") ? jsonPatch(serialize(stored), input) : mergePatch(serialize(stored), input);
          } catch (error) {
            refuse({ code: 422, reason: "Invalid", message: error instanceof Error ? error.message : "the patch doesn't apply" });
            return;
          }
          const parsed = objectInSchema.safeParse(next);
          const meta = metadataInSchema.safeParse(parsed.success ? (parsed.data.metadata ?? {}) : {});
          if (!parsed.success || !meta.success) {
            refuse({ code: 422, reason: "Invalid", message: "the result isn't a Kubernetes object" });
            return;
          }
          const body = bodyOf(parsed.data);
          if (target.info.plural === "pods" && JSON.stringify(body["spec"]) !== JSON.stringify(stored.body["spec"])) {
            refuse(invalid(target.info, target.name, ["spec: Forbidden: pod updates may not change fields other than the image, the active deadline, tolerations and the grace period"]));
            return;
          }
          const metadata: Metadata = {
            ...stored.metadata,
            ...(meta.data.labels === undefined ? {} : { labels: meta.data.labels }),
            ...(meta.data.annotations === undefined ? {} : { annotations: meta.data.annotations }),
            ...(meta.data.ownerReferences === undefined ? {} : { ownerReferences: meta.data.ownerReferences }),
          };
          const { problems } = validate(target.info, metadata, body);
          if (problems.length > 0) {
            refuse(invalid(target.info, target.name, problems));
            return;
          }
          stored.metadata = metadata;
          if (target.info.plural !== "pods") stored.body = body;
          bump(stored);
          notify("MODIFIED", stored);
          reply(200, serialize(stored));
          return;
        }
        refuse({ code: 405, reason: "MethodNotAllowed", message: `${method} isn't allowed here` });
        return;
      }
      default:
        target satisfies never;
    }
  };

  const ca = await makeTestCa("fake-kube-ca");
  const leaf = await issueTestCert(ca, ["localhost", "127.0.0.1"]);
  const server = createServer({ cert: leaf.cert, key: leaf.key }, (request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) fail(response, { code: 500, reason: "InternalError", message: error instanceof Error ? error.message : "the fake failed" });
      else response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `https://127.0.0.1:${String(port)}`;

  const findStored = (resource: FakeKubeResource, namespace: string | null, name: string): Stored | undefined => {
    const info = infoOf(resource);
    return info === undefined ? undefined : tableOf(info).get(keyOf(info.namespaced ? (namespace ?? undefined) : undefined, name));
  };

  return {
    url,
    ca: ca.cert,
    port,
    kubeconfig: (namespace = "default") =>
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{ name: "fake-kube", cluster: { server: url, "certificate-authority-data": Buffer.from(ca.cert).toString("base64") } }],
        users: [{ name: "fake-kube", user: { token } }],
        contexts: [{ name: "fake-kube", context: { cluster: "fake-kube", user: "fake-kube", namespace } }],
        "current-context": "fake-kube",
      }),
    list: (resource, namespace) => {
      const info = infoOf(resource);
      return info === undefined ? [] : [...tableOf(info).values()].filter((stored) => inScope(stored, namespace ?? null)).map(serialize);
    },
    get: (resource, namespace, name) => {
      const stored = findStored(resource, namespace, name);
      return stored === undefined ? undefined : serialize(stored);
    },
    holdUnschedulable: (ms) => {
      holdUntil = Date.now() + ms;
    },
    failImagePull: (image) => {
      pullFailures.add(image);
    },
    clearPullFailures: () => {
      pullFailures.clear();
    },
    reportMinor: (next) => {
      minor = next;
    },
    denyAccess: (next) => {
      deny = next;
    },
    exitContainer: (namespace, pod, container, exitCode) => {
      const stored = findStored("pods", namespace, pod);
      const runtime = stored === undefined ? undefined : pods.get(stored.metadata.uid);
      if (runtime === undefined) throw new Error(`no pod ${namespace}/${pod}`);
      const time = now();
      runtime.simulated.set(container, { terminated: { exitCode, reason: exitCode === 0 ? "Completed" : "Error", finishedAt: time } });
      refreshPod(runtime);
    },
    processesOf: (namespace, pod) => {
      const stored = findStored("pods", namespace, pod);
      const processes = stored === undefined ? null : (pods.get(stored.metadata.uid)?.processes ?? null);
      return processes === null ? undefined : { dir: processes.dir, containers: processes.containers(), logs: processes.logs };
    },
    pulls: () => [...pulls],
    requests: () => [...requests],
    close: async () => {
      for (const runtime of [...pods.values()]) {
        runtime.deleting = true;
        for (const timer of runtime.timers) clearTimeout(timer);
        await runtime.processes?.stop();
      }
      for (const watcher of watchers) watcher.response.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};

export type { ContainerRun } from "./process-mode.ts";
