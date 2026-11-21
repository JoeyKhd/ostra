import { createHash } from "node:crypto";

import type { V1Container, V1EnvVar, V1Pod, V1Probe, V1Secret, V1Volume } from "@kubernetes/client-node";
import { BRIDGE_FEATURES } from "@ostra/adapter-executor-docker";
import type { BoxImage, BoxRef, BoxSize } from "@ostra/adapter-sdk";
import type { TaskSpec, TaskSpecService } from "@ostra/protocol";

import { cpuQuantity, memoryQuantity } from "./quantity.ts";

// A box as one pod (ticket 07, ADR 0060, Q237), ported from spike 3's `deploy/k8s/box-pod.yaml` and
// built as a typed value, never from a template of strings:
//
//   sidecar (init, restartPolicy: Always)   the runner image's `ostra sidecar`: a native sidecar, so it
//                                           starts before the agent and stops after it. Its own fixed
//                                           limits. The task token's secret is its only secret volume,
//                                           a file at /run/ostra/token (ADR 0034), never a variable.
//   svc-<name> (init, restartPolicy: Always)  ticket 08: each of the environment's services, after the
//                                           sidecar and in the environment's order, with its image,
//                                           variables and port, its health check as a readiness probe,
//                                           and its own limits (`OSTRA_SERVICE_*`). The pod's `hostAliases`
//                                           map each service's name to loopback, so an environment
//                                           written for `docker` reaches `postgres:5432` unchanged.
//   agent (the pod's container)              the environment's base image, or the registry snapshot by
//                                           digest; the box's init as root, which starts every process
//                                           as the agent's user. The box size as its requests and
//                                           limits (requests equal limits, Q236). No credential.
//
// Both share the pod's loopback: the init connects to the sidecar's bridge at 127.0.0.1 with the
// box's nonce, which is in the box's secret beside the token, and reaches the agent's container as a
// variable from that one key. No service account token, no service links, no host namespaces,
// `RuntimeDefault` seccomp, every capability dropped (the init keeps SETUID, SETGID and KILL, as
// on `docker`), and the optional RuntimeClass (gVisor). Everything is labelled with the box, the
// task and the organization, so release finds and deletes it by label.

export const TASK_ROOT = "/task";
export const SIDECAR_DATA_DIR = "/var/lib/ostra-sidecar";
export const TOKEN_DIR = "/run/ostra";
export const TOKEN_FILE = `${TOKEN_DIR}/token`;
export const BRIDGE_PORT = 7101;
export const AGENT_UID = 1000;
/** The sidecar shares the agent's uid: they write the same checkouts on the task volume (as on `docker`). */
export const SIDECAR_UID = AGENT_UID;
/** Holds the spool's whole quota (1 GiB) and the state file, as on `docker`. */
const SIDECAR_DATA_SIZE = "1280Mi";

/** The secret's keys: the task token and the bridge's nonce. */
export const TOKEN_KEY = "token";
export const NONCE_KEY = "bridge-nonce";

export const LABELS = {
  role: "ostra.dev/role",
  box: "ostra.dev/box",
  task: "ostra.dev/task",
  organization: "ostra.dev/organization",
  partOf: "app.kubernetes.io/part-of",
} as const;

/** The value every box object's `ostra.dev/role` has. */
export const BOX_ROLE = "box";

export type PodImages = {
  /** The runner image: the `ostra` CLI, which is also the sidecar. */
  readonly runner: string;
  /** ostra's base image, for an environment that names none. */
  readonly base: string;
};

export type PodSettings = {
  readonly images: PodImages;
  /** The server as the sidecar reaches it. */
  readonly serverUrl: string;
  readonly runtimeClassName: string | null;
  /** The sidecar's limits (`OSTRA_SIDECAR_CPU_MILLIS`, `OSTRA_SIDECAR_MEMORY_MIB`). */
  readonly sidecarLimits: BoxSize;
  /** A service's limits (`OSTRA_SERVICE_CPU_MILLIS`, `OSTRA_SERVICE_MEMORY_MIB`): a service names none. */
  readonly serviceLimits: BoxSize;
  /** The runner's `OSTRA_RUNNER_SUBAGENT_WAIT_MINUTES`, for the sidecar, which runs the task; `null`: the sidecar's default. Absent: `null`. */
  readonly subagentWaitMinutes?: number | null;
  /** Where the sidecar's bridge listens on the pod's loopback. */
  readonly bridgePort: number;
  /** The box's init in the base image. */
  readonly initCommand: readonly string[];
  /** The sidecar in the runner image. */
  readonly sidecarCommand: readonly string[];
};

export type BoxPodInput = {
  readonly box: BoxRef;
  readonly spec: TaskSpec;
  readonly size: BoxSize | null;
  readonly image: BoxImage | null;
  /** The bridge's nonce: one per box. */
  readonly nonce: string;
  /** The lease's task token; `null` makes a box whose sidecar has none (tests only). Never logged. */
  readonly taskToken: string | null;
};

export type BoxObjects = {
  readonly names: { readonly pod: string; readonly secret: string; readonly pullSecret: string };
  /** The labels every object of the box carries. */
  readonly labels: Readonly<Record<string, string>>;
  /** The selector that finds every object of the box. */
  readonly selector: string;
  readonly secret: V1Secret;
  /** A `kubernetes.io/dockerconfigjson` secret, when the image has a pull credential. */
  readonly pullSecret: V1Secret | null;
  readonly pod: V1Pod;
};

const hash = (text: string, length: number): string => createHash("sha256").update(text).digest("hex").slice(0, length);

/**
 * An ID as a label value: itself when it's one (63 characters at most, alphanumerics and `-_.`
 * between alphanumerics), or a hash of it. The same ID always gives the same value.
 */
export const labelValue = (id: string): string => (/^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/.test(id) ? id : `h-${hash(id, 40)}`);

/** An ID in a DNS label (a pod's or a secret's name): lowercased, other characters dashed, short, with a hash when it changed. */
export const dnsPart = (id: string, max = 40): string => {
  const cleaned = id.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-").replaceAll(/-+/g, "-").replaceAll(/^-|-$/g, "");
  if (cleaned === id && cleaned.length <= max && cleaned !== "") return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 9)).replaceAll(/-$/g, "")}-${hash(id, 8)}`.replace(/^-/, "");
};

export const boxNames = (box: BoxRef): BoxObjects["names"] => {
  const base = `ostra-box-${dnsPart(box.boxId)}`;
  return { pod: base, secret: base, pullSecret: `${base}-pull` };
};

export const boxLabels = (box: BoxRef, organizationId: string): Readonly<Record<string, string>> => ({
  [LABELS.partOf]: "ostra",
  [LABELS.role]: BOX_ROLE,
  [LABELS.box]: labelValue(box.boxId),
  [LABELS.task]: labelValue(box.taskId),
  [LABELS.organization]: labelValue(organizationId),
});

/** Every object of a box, by its label: what release deletes. */
export const boxSelector = (box: BoxRef): string => `${LABELS.role}=${BOX_ROLE},${LABELS.box}=${labelValue(box.boxId)}`;

/** The registry host an image reference names, as a dockerconfigjson's `auths` key. */
export const registryHostOf = (ref: string): string => {
  const first = ref.split("/")[0] ?? "";
  return ref.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost") ? first : "docker.io";
};

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** A box size as a container's resources: requests equal limits (Q236). */
export const resourcesOf = (size: BoxSize): NonNullable<V1Container["resources"]> => {
  const values = { cpu: cpuQuantity(size.cpuMillis), memory: memoryQuantity(size.memoryMiB) };
  return { requests: { ...values }, limits: { ...values } };
};

const nonceVar = (secret: string, name: string): V1EnvVar => ({ name, valueFrom: { secretKeyRef: { name: secret, key: NONCE_KEY } } });

/** A service's container name: `svc-` and its name, which the spec keeps a DNS label. */
export const serviceContainerName = (name: string): string => `svc-${dnsPart(name, 55)}`;

/** A service's readiness: its health check run in its container, or its port reached on loopback, or none. */
const serviceProbe = (service: TaskSpecService): V1Probe | null => {
  const timing = { periodSeconds: 2, timeoutSeconds: 5, failureThreshold: 60 };
  if (service.healthCheck !== null) {
    // The environment's command line, written by an admin, as Docker's `CMD-SHELL` runs it: an argument, never built from task text.
    return { exec: { command: ["sh", "-c", service.healthCheck] }, ...timing };
  }
  return service.port === null ? null : { tcpSocket: { host: "127.0.0.1", port: service.port }, ...timing };
};

/** A service as a native sidecar (ticket 08, F-094). */
export const serviceContainer = (service: TaskSpecService, limits: BoxSize): V1Container => {
  const probe = serviceProbe(service);
  return {
    name: serviceContainerName(service.name),
    image: service.image,
    // The image's own command and user: a database's entrypoint drops to its own user.
    restartPolicy: "Always",
    env: service.variables.map((variable) => ({ name: variable.name, value: variable.value })),
    ...(service.port === null ? {} : { ports: [{ containerPort: service.port, protocol: "TCP" }] }),
    securityContext: {
      allowPrivilegeEscalation: false,
      // What a database's entrypoint needs to take its data folder and drop to its user (spike 3).
      capabilities: { drop: ["ALL"], add: ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"] },
    },
    resources: resourcesOf(limits),
    ...(probe === null ? {} : { readinessProbe: probe }),
  };
};

/** The image the agent's container runs: the registry snapshot by digest, the environment's base image, or ostra's. */
export const agentImageOf = (input: Pick<BoxPodInput, "image" | "spec">, images: PodImages): string =>
  input.image === null ? (input.spec.environment.baseImage ?? images.base) : `${input.image.ref}@${input.image.digest}`;

/** Everything a box gets, as typed values. Pure: the unit tests read it field by field. */
export const boxObjects = (input: BoxPodInput, settings: PodSettings): BoxObjects => {
  const names = boxNames(input.box);
  const labels = boxLabels(input.box, input.spec.organizationId);
  const pull = input.image?.pull ?? null;

  const secret: V1Secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: names.secret, labels: { ...labels } },
    type: "Opaque",
    data: {
      [NONCE_KEY]: base64(input.nonce),
      ...(input.taskToken === null ? {} : { [TOKEN_KEY]: base64(input.taskToken) }),
    },
  };

  const pullSecret: V1Secret | null =
    pull === null || input.image === null
      ? null
      : {
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: names.pullSecret, labels: { ...labels } },
          type: "kubernetes.io/dockerconfigjson",
          data: {
            ".dockerconfigjson": base64(
              JSON.stringify({
                auths: { [registryHostOf(input.image.ref)]: { username: pull.username, password: pull.token, auth: base64(`${pull.username}:${pull.token}`) } },
              }),
            ),
          },
        };

  const dropAll = { drop: ["ALL"] };
  const sidecar: V1Container = {
    name: "sidecar",
    image: settings.images.runner,
    command: [...settings.sidecarCommand],
    // A native sidecar (Kubernetes 1.29): first of the init containers, so it starts before
    // everything else and stops after the agent.
    restartPolicy: "Always",
    workingDir: TASK_ROOT,
    env: [
      { name: "OSTRA_SERVER_URL", value: settings.serverUrl },
      { name: "OSTRA_SIDECAR_TOKEN_FILE", value: TOKEN_FILE },
      { name: "OSTRA_TASK_ID", value: input.box.taskId },
      { name: "OSTRA_SESSION_ID", value: input.spec.sessionId },
      { name: "OSTRA_BOX_ID", value: input.box.boxId },
      { name: "OSTRA_LEASE_EPOCH", value: String(input.spec.leaseEpoch) },
      nonceVar(names.secret, "OSTRA_BRIDGE_NONCE"),
      { name: "OSTRA_BRIDGE_PORT", value: String(settings.bridgePort) },
      // One pod, one network namespace: the agent reaches the sidecar's proxies on loopback.
      { name: "OSTRA_SIDECAR_HOST", value: "127.0.0.1" },
      { name: "OSTRA_TASK_ROOT", value: TASK_ROOT },
      { name: "OSTRA_SIDECAR_DATA_DIR", value: SIDECAR_DATA_DIR },
      ...(settings.subagentWaitMinutes === undefined || settings.subagentWaitMinutes === null ? [] : [{ name: "OSTRA_RUNNER_SUBAGENT_WAIT_MINUTES", value: String(settings.subagentWaitMinutes) }]),
    ],
    securityContext: {
      runAsUser: SIDECAR_UID,
      runAsGroup: SIDECAR_UID,
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: dropAll,
    },
    resources: resourcesOf(settings.sidecarLimits),
    // Ready once its bridge listens: the agent's init connects to it.
    readinessProbe: { tcpSocket: { host: "127.0.0.1", port: settings.bridgePort }, periodSeconds: 2, failureThreshold: 60 },
    volumeMounts: [
      { name: "task", mountPath: TASK_ROOT },
      { name: "sidecar-data", mountPath: SIDECAR_DATA_DIR },
      { name: "tmp-sidecar", mountPath: "/tmp" },
      ...(input.taskToken === null ? [] : [{ name: "token", mountPath: TOKEN_DIR, readOnly: true }]),
    ],
  };

  const agent: V1Container = {
    name: "agent",
    image: agentImageOf(input, settings.images),
    command: [...settings.initCommand],
    workingDir: TASK_ROOT,
    // The init's own: the box, the nonce and where the bridge is. Never a credential.
    env: [
      { name: "OSTRA_BOX_ID", value: input.box.boxId },
      nonceVar(names.secret, "OSTRA_BRIDGE_NONCE"),
      { name: "OSTRA_BRIDGE_ADDR", value: `127.0.0.1:${String(settings.bridgePort)}` },
      { name: "OSTRA_AGENT_UID", value: String(AGENT_UID) },
      { name: "OSTRA_AGENT_GID", value: String(AGENT_UID) },
      // Milestone 8: the bridge features the sidecar reads, which the init announces back.
      { name: "OSTRA_BRIDGE_FEATURES", value: BRIDGE_FEATURES.join(",") },
    ],
    securityContext: {
      // The init is root to start processes as the agent's user; those are never root.
      runAsUser: 0,
      runAsNonRoot: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"], add: ["SETUID", "SETGID", "KILL"] },
    },
    ...(input.size === null ? {} : { resources: resourcesOf(input.size) }),
    volumeMounts: [
      { name: "task", mountPath: TASK_ROOT },
      { name: "tmp-agent", mountPath: "/tmp" },
    ],
  };

  const services = input.spec.services ?? [];
  const memory = { medium: "Memory" };
  const volumes: V1Volume[] = [
    { name: "task", emptyDir: {} },
    { name: "sidecar-data", emptyDir: { ...memory, sizeLimit: SIDECAR_DATA_SIZE } },
    { name: "tmp-agent", emptyDir: { ...memory } },
    { name: "tmp-sidecar", emptyDir: { ...memory } },
    // The token alone: the nonce's key stays out of every file.
    ...(input.taskToken === null ? [] : [{ name: "token", secret: { secretName: names.secret, items: [{ key: TOKEN_KEY, path: "token", mode: 0o400 }], defaultMode: 0o400 } }]),
  ];

  const pod: V1Pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: names.pod, labels: { ...labels } },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      shareProcessNamespace: false,
      terminationGracePeriodSeconds: 10,
      ...(settings.runtimeClassName === null ? {} : { runtimeClassName: settings.runtimeClassName }),
      securityContext: { seccompProfile: { type: "RuntimeDefault" }, fsGroup: AGENT_UID },
      ...(pullSecret === null ? {} : { imagePullSecrets: [{ name: names.pullSecret }] }),
      initContainers: [sidecar, ...services.map((service) => serviceContainer(service, settings.serviceLimits))],
      ...(services.length === 0 ? {} : { hostAliases: [{ ip: "127.0.0.1", hostnames: services.map((service) => service.name) }] }),
      containers: [agent],
      volumes,
    },
  };

  return { names, labels, selector: boxSelector(input.box), secret, pullSecret, pod };
};
