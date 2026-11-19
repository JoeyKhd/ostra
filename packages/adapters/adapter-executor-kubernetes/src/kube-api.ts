import { AuthorizationV1Api, CoreV1Api, KubeConfig, NetworkingV1Api, setHeaderOptions, VersionApi } from "@kubernetes/client-node";
import type { V1Pod, V1Secret } from "@kubernetes/client-node";
import { z } from "zod";

import { cpuMillisOf, memoryMiBOf } from "./quantity.ts";

// The port the `kubernetes` executor talks to the cluster through (ticket 07): only the calls it
// makes, over `@kubernetes/client-node`, so its unit tests can also use a small in-memory double
// (`testing/memory-kube-api.ts`) and its integration tests ticket 06's fake API over HTTPS.
//
// What it reads back is narrowed here, through Zod, to the few fields the executor uses: the
// cluster's objects are a format Kubernetes owns, so the schemas tolerate every other field.

export type KubeResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly status: number; readonly message: string };

export const kubeOk = <T,>(value: T): KubeResult<T> => ({ ok: true, value });
export const kubeErr = <T,>(status: number, message: string): KubeResult<T> => ({ ok: false, status, message });

export type ContainerView = {
  readonly name: string;
  readonly image: string;
  readonly ready: boolean;
  readonly state: "waiting" | "running" | "terminated";
  /** The waiting or terminated state's reason (`ImagePullBackOff`, `ContainerCreating`, `Completed`), or `null`. */
  readonly reason: string | null;
  readonly exitCode: number | null;
};

export type PodPhase = "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";

export type PodView = {
  readonly name: string;
  readonly uid: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly phase: PodPhase;
  /** Its deletion has started. */
  readonly deleting: boolean;
  /** The `PodScheduled` condition, or `null` before the scheduler has looked. */
  readonly scheduled: { readonly status: "True" | "False" | "Unknown"; readonly reason: string | null } | null;
  /** The `Ready` condition is true. */
  readonly ready: boolean;
  readonly initContainers: readonly ContainerView[];
  readonly containers: readonly ContainerView[];
  /** What the pod requests, as the scheduler and a quota count it: its containers and native sidecars. */
  readonly requests: { readonly cpuMillis: number; readonly memoryMiB: number };
};

export type EventView = { readonly reason: string; readonly message: string; readonly type: string };

export type QuotaView = { readonly name: string; readonly hard: Readonly<Record<string, string>> };

export type NetworkPolicyView = {
  readonly name: string;
  /** `matchLabels` of its pod selector: `{}` selects every pod of the namespace. */
  readonly matchLabels: Readonly<Record<string, string>>;
  /** It also has `matchExpressions`, which the executor doesn't evaluate. */
  readonly hasExpressions: boolean;
  readonly policyTypes: readonly string[];
  /** Every CIDR its egress rules carve out with `except`. */
  readonly egressExcepts: readonly string[];
  /** Its egress rules: each allows everything (no peers), or its peers' IP blocks (a selector peer is left out). */
  readonly egress: readonly { readonly allowsAll: boolean; readonly blocks: readonly { readonly cidr: string; readonly except: readonly string[] }[] }[];
};

export type AccessAttributes = { readonly namespace: string; readonly verb: string; readonly group: string; readonly resource: string };

export type KubeApi = {
  /** `/version`: the server's major and minor. */
  readonly version: () => Promise<KubeResult<{ readonly major: number; readonly minor: number }>>;
  /** Whether a namespace exists; `forbidden` when the service account may not read it (a namespaced role can't). */
  readonly namespace: (name: string) => Promise<KubeResult<"exists" | "missing" | "forbidden">>;
  /** A `SelfSubjectAccessReview`: may this service account do it? */
  readonly canI: (attributes: AccessAttributes) => Promise<KubeResult<boolean>>;
  readonly createSecret: (namespace: string, secret: V1Secret) => Promise<KubeResult<{ readonly name: string; readonly uid: string }>>;
  /** Makes a secret a dependent of a pod, so the garbage collector deletes it with the pod. */
  readonly ownSecret: (namespace: string, name: string, owner: { readonly name: string; readonly uid: string }) => Promise<KubeResult<void>>;
  /** Deletes a secret; one already gone is fine. */
  readonly deleteSecret: (namespace: string, name: string) => Promise<KubeResult<void>>;
  readonly listSecretNames: (namespace: string, labelSelector: string) => Promise<KubeResult<readonly string[]>>;
  readonly createPod: (namespace: string, pod: V1Pod) => Promise<KubeResult<PodView>>;
  /** `null` when there's no such pod. */
  readonly readPod: (namespace: string, name: string) => Promise<KubeResult<PodView | null>>;
  /** Deletes a pod; one already gone is fine. */
  readonly deletePod: (namespace: string, name: string, graceSeconds?: number) => Promise<KubeResult<void>>;
  readonly listPods: (namespace: string, labelSelector?: string) => Promise<KubeResult<readonly PodView[]>>;
  /** The events about one pod, oldest first. */
  readonly podEvents: (namespace: string, pod: string) => Promise<KubeResult<readonly EventView[]>>;
  readonly quotas: (namespace: string) => Promise<KubeResult<readonly QuotaView[]>>;
  readonly networkPolicies: (namespace: string) => Promise<KubeResult<readonly NetworkPolicyView[]>>;
  /** One container's log. */
  readonly podLog: (namespace: string, pod: string, container: string) => Promise<KubeResult<string>>;
};

// ---------- what the executor reads of the API's answers ----------

const stateSchema = z
  .looseObject({
    waiting: z.looseObject({ reason: z.string().nullish() }).nullish(),
    running: z.looseObject({}).nullish(),
    terminated: z.looseObject({ reason: z.string().nullish(), exitCode: z.number().nullish() }).nullish(),
  })
  .nullish();

const containerStatusSchema = z.looseObject({ name: z.string(), image: z.string().nullish(), ready: z.boolean().nullish(), state: stateSchema });
const resourcesSchema = z
  .looseObject({
    requests: z.record(z.string(), z.unknown()).nullish(),
    limits: z.record(z.string(), z.unknown()).nullish(),
  })
  .nullish();
const containerSpecSchema = z.looseObject({ name: z.string(), image: z.string().nullish(), restartPolicy: z.string().nullish(), resources: resourcesSchema });

const podSchema = z.looseObject({
  metadata: z.looseObject({
    name: z.string(),
    uid: z.string().nullish(),
    labels: z.record(z.string(), z.string()).nullish(),
    deletionTimestamp: z.unknown().optional(),
  }),
  spec: z.looseObject({ containers: z.array(containerSpecSchema).nullish(), initContainers: z.array(containerSpecSchema).nullish() }).nullish(),
  status: z
    .looseObject({
      phase: z.string().nullish(),
      conditions: z.array(z.looseObject({ type: z.string(), status: z.string(), reason: z.string().nullish() })).nullish(),
      initContainerStatuses: z.array(containerStatusSchema).nullish(),
      containerStatuses: z.array(containerStatusSchema).nullish(),
    })
    .nullish(),
});

const quantityText = (value: unknown): string | null => (typeof value === "string" ? value : typeof value === "number" ? String(value) : null);

const containerView = (status: z.infer<typeof containerStatusSchema>): ContainerView => {
  const state = status.state;
  const terminated = state?.terminated ?? null;
  const waiting = state?.waiting ?? null;
  return {
    name: status.name,
    image: status.image ?? "",
    ready: status.ready ?? false,
    state: terminated !== null ? "terminated" : state?.running !== null && state?.running !== undefined ? "running" : "waiting",
    reason: terminated?.reason ?? waiting?.reason ?? null,
    exitCode: terminated?.exitCode ?? null,
  };
};

const PHASES: readonly PodPhase[] = ["Pending", "Running", "Succeeded", "Failed", "Unknown"];

/** A pod's requests: its main containers and native sidecars (a plain init container ends before them). Requests default to limits. */
const requestsOf = (spec: z.infer<typeof podSchema>["spec"]): PodView["requests"] => {
  const running = [...(spec?.containers ?? []), ...(spec?.initContainers ?? []).filter((container) => container.restartPolicy === "Always")];
  let cpuMillis = 0;
  let memoryMiB = 0;
  for (const container of running) {
    const read = (resource: "cpu" | "memory"): string | null => quantityText(container.resources?.requests?.[resource]) ?? quantityText(container.resources?.limits?.[resource]);
    const cpu = read("cpu");
    const memory = read("memory");
    cpuMillis += cpu === null ? 0 : (cpuMillisOf(cpu) ?? 0);
    memoryMiB += memory === null ? 0 : (memoryMiBOf(memory) ?? 0);
  }
  return { cpuMillis, memoryMiB };
};

export const podView = (raw: unknown): PodView | null => {
  const parsed = podSchema.safeParse(raw);
  if (!parsed.success) return null;
  const pod = parsed.data;
  const conditions = pod.status?.conditions ?? [];
  const scheduled = conditions.find((condition) => condition.type === "PodScheduled");
  const phase = PHASES.find((each) => each === pod.status?.phase) ?? "Pending";
  return {
    name: pod.metadata.name,
    uid: pod.metadata.uid ?? "",
    labels: pod.metadata.labels ?? {},
    phase,
    deleting: pod.metadata.deletionTimestamp !== undefined && pod.metadata.deletionTimestamp !== null,
    scheduled:
      scheduled === undefined
        ? null
        : { status: scheduled.status === "True" ? "True" : scheduled.status === "False" ? "False" : "Unknown", reason: scheduled.reason ?? null },
    ready: conditions.some((condition) => condition.type === "Ready" && condition.status === "True"),
    initContainers: (pod.status?.initContainerStatuses ?? []).map(containerView),
    containers: (pod.status?.containerStatuses ?? []).map(containerView),
    requests: requestsOf(pod.spec),
  };
};

const eventSchema = z.looseObject({ reason: z.string().nullish(), message: z.string().nullish(), type: z.string().nullish() });
const quotaSchema = z.looseObject({ metadata: z.looseObject({ name: z.string() }), spec: z.looseObject({ hard: z.record(z.string(), z.unknown()).nullish() }).nullish() });
const ipBlockSchema = z.looseObject({ cidr: z.string(), except: z.array(z.string()).nullish() });
const policySchema = z.looseObject({
  metadata: z.looseObject({ name: z.string() }),
  spec: z
    .looseObject({
      podSelector: z.looseObject({ matchLabels: z.record(z.string(), z.string()).nullish(), matchExpressions: z.array(z.unknown()).nullish() }).nullish(),
      policyTypes: z.array(z.string()).nullish(),
      egress: z.array(z.looseObject({ to: z.array(z.looseObject({ ipBlock: ipBlockSchema.nullish() })).nullish() })).nullish(),
    })
    .nullish(),
});

export const policyView = (raw: unknown): NetworkPolicyView | null => {
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) return null;
  const spec = parsed.data.spec;
  const egress = spec?.egress ?? [];
  return {
    name: parsed.data.metadata.name,
    matchLabels: spec?.podSelector?.matchLabels ?? {},
    hasExpressions: (spec?.podSelector?.matchExpressions ?? []).length > 0,
    policyTypes: spec?.policyTypes ?? [],
    egressExcepts: egress.flatMap((rule) => (rule.to ?? []).flatMap((peer) => peer.ipBlock?.except ?? [])),
    egress: egress.map((rule) => ({
      allowsAll: (rule.to ?? []).length === 0,
      blocks: (rule.to ?? []).flatMap((peer) => (peer.ipBlock === null || peer.ipBlock === undefined ? [] : [{ cidr: peer.ipBlock.cidr, except: peer.ipBlock.except ?? [] }])),
    })),
  };
};

// ---------- over `@kubernetes/client-node` ----------

const errorStatusSchema = z.looseObject({ code: z.number().int() });

/** An `ApiException`'s status, or 0 for a call that never got an answer. Its body is never kept: it can echo what was sent. */
const failure = <T,>(error: unknown, what: string): KubeResult<T> => {
  const parsed = errorStatusSchema.safeParse(error);
  const status = parsed.success ? parsed.data.code : 0;
  return kubeErr(status, status === 0 ? `${what}: the cluster didn't answer` : `${what}: the cluster answered ${String(status)}`);
};

const attempt = async <T,>(what: string, run: () => Promise<T>): Promise<KubeResult<T>> => {
  try {
    return kubeOk(await run());
  } catch (error) {
    return failure(error, what);
  }
};

const gone = (result: KubeResult<unknown>): boolean => !result.ok && result.status === 404;

/** The port over a kubeconfig: the in-cluster one on a pool runner, a file in development. */
export const createKubeApi = (config: KubeConfig): KubeApi => {
  const core = config.makeApiClient(CoreV1Api);
  const auth = config.makeApiClient(AuthorizationV1Api);
  const networking = config.makeApiClient(NetworkingV1Api);
  const versions = config.makeApiClient(VersionApi);

  return {
    version: async () => {
      const answered = await attempt("reading the version", () => versions.getCode());
      if (!answered.ok) return answered;
      const major = Number.parseInt(answered.value.major, 10);
      // A managed cluster's minor can carry a `+`: `29+`.
      const minor = Number.parseInt(answered.value.minor, 10);
      return Number.isFinite(major) && Number.isFinite(minor) ? kubeOk({ major, minor }) : kubeErr(0, "the cluster's version doesn't parse");
    },
    namespace: async (name) => {
      const read = await attempt("reading the namespace", () => core.readNamespace({ name }));
      if (read.ok) return kubeOk("exists");
      if (read.status === 404) return kubeOk("missing");
      if (read.status === 403) return kubeOk("forbidden");
      return read;
    },
    canI: async (attributes) => {
      const review = await attempt("asking what the service account may do", () =>
        auth.createSelfSubjectAccessReview({
          body: { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview", spec: { resourceAttributes: { ...attributes } } },
        }),
      );
      return review.ok ? kubeOk(review.value.status?.allowed ?? false) : review;
    },
    createSecret: async (namespace, secret) => {
      const made = await attempt("creating a secret", () => core.createNamespacedSecret({ namespace, body: secret }));
      return made.ok ? kubeOk({ name: made.value.metadata?.name ?? "", uid: made.value.metadata?.uid ?? "" }) : made;
    },
    ownSecret: async (namespace, name, owner) => {
      const patched = await attempt("owning a secret by its pod", () =>
        core.patchNamespacedSecret(
          {
            name,
            namespace,
            body: [{ op: "add", path: "/metadata/ownerReferences", value: [{ apiVersion: "v1", kind: "Pod", name: owner.name, uid: owner.uid, blockOwnerDeletion: false }] }],
          },
          setHeaderOptions("Content-Type", "application/json-patch+json"),
        ),
      );
      return patched.ok ? kubeOk(undefined) : patched;
    },
    deleteSecret: async (namespace, name) => {
      const deleted = await attempt("deleting a secret", () => core.deleteNamespacedSecret({ name, namespace }));
      return deleted.ok || gone(deleted) ? kubeOk(undefined) : deleted;
    },
    listSecretNames: async (namespace, labelSelector) => {
      const listed = await attempt("listing secrets", () => core.listNamespacedSecret({ namespace, labelSelector }));
      return listed.ok ? kubeOk(listed.value.items.map((item) => item.metadata?.name ?? "").filter((name) => name !== "")) : listed;
    },
    createPod: async (namespace, pod) => {
      const made = await attempt("creating the pod", () => core.createNamespacedPod({ namespace, body: pod }));
      if (!made.ok) return made;
      const view = podView(made.value);
      return view === null ? kubeErr(0, "the created pod doesn't parse") : kubeOk(view);
    },
    readPod: async (namespace, name) => {
      const read = await attempt("reading the pod", () => core.readNamespacedPod({ name, namespace }));
      if (!read.ok) return gone(read) ? kubeOk(null) : read;
      return kubeOk(podView(read.value));
    },
    deletePod: async (namespace, name, graceSeconds) => {
      const deleted = await attempt("deleting the pod", () =>
        core.deleteNamespacedPod({ name, namespace, ...(graceSeconds === undefined ? {} : { gracePeriodSeconds: graceSeconds }) }),
      );
      return deleted.ok || gone(deleted) ? kubeOk(undefined) : deleted;
    },
    listPods: async (namespace, labelSelector) => {
      const listed = await attempt("listing pods", () => core.listNamespacedPod({ namespace, ...(labelSelector === undefined ? {} : { labelSelector }) }));
      return listed.ok ? kubeOk(listed.value.items.flatMap((item) => podView(item) ?? [])) : listed;
    },
    podEvents: async (namespace, pod) => {
      const listed = await attempt("listing the pod's events", () => core.listNamespacedEvent({ namespace, fieldSelector: `involvedObject.name=${pod}` }));
      if (!listed.ok) return listed;
      return kubeOk(
        listed.value.items.flatMap((item) => {
          const parsed = eventSchema.safeParse(item);
          return parsed.success ? [{ reason: parsed.data.reason ?? "", message: parsed.data.message ?? "", type: parsed.data.type ?? "" }] : [];
        }),
      );
    },
    quotas: async (namespace) => {
      const listed = await attempt("listing the namespace's quotas", () => core.listNamespacedResourceQuota({ namespace }));
      if (!listed.ok) return listed;
      return kubeOk(
        listed.value.items.flatMap((item) => {
          const parsed = quotaSchema.safeParse(item);
          if (!parsed.success) return [];
          const hard: Record<string, string> = {};
          for (const [key, value] of Object.entries(parsed.data.spec?.hard ?? {})) {
            const text = quantityText(value);
            if (text !== null) hard[key] = text;
          }
          return [{ name: parsed.data.metadata.name, hard }];
        }),
      );
    },
    networkPolicies: async (namespace) => {
      const listed = await attempt("listing the namespace's network policies", () => networking.listNamespacedNetworkPolicy({ namespace }));
      return listed.ok ? kubeOk(listed.value.items.flatMap((item) => policyView(item) ?? [])) : listed;
    },
    podLog: (namespace, pod, container) => attempt("reading a container's log", () => core.readNamespacedPodLog({ name: pod, namespace, container })),
  };
};

/** A kubeconfig from its text (a file's, or the fake API's), for `createKubeApi`. */
export const kubeConfigFromString = (text: string): KubeConfig => {
  const config = new KubeConfig();
  config.loadFromString(text);
  return config;
};

/** The cluster's own kubeconfig, inside a pod: its service account's token and CA. */
export const inClusterKubeConfig = (): KubeConfig => {
  const config = new KubeConfig();
  config.loadFromCluster();
  return config;
};
