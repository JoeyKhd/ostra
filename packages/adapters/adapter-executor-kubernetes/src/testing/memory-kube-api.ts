import type { V1Pod, V1Secret } from "@kubernetes/client-node";

import { kubeOk } from "../kube-api.ts";
import type { ContainerView, EventView, KubeApi, NetworkPolicyView, PodView } from "../kube-api.ts";

// A small in-memory double of the `KubeApi` port (ticket 07), for the executor's unit tests that
// script a pod's life step by step against a clock they move: a pull that takes minutes, a node
// that never comes. The integration tests use ticket 06's fake API over HTTPS instead. Test only.

export type MemoryKube = KubeApi & {
  /** The pods made, as the executor sent them. */
  readonly made: V1Pod[];
  readonly secrets: Map<string, V1Secret>;
  /** Changes a pod's status, as the scheduler and the kubelet would. */
  readonly setPod: (name: string, change: Partial<Omit<PodView, "name" | "uid">>) => void;
  /** Adds an event about a pod. */
  readonly addEvent: (pod: string, reason: string) => void;
  readonly policies: NetworkPolicyView[];
  readonly deleted: string[];
};

/** A container's status, for `setPod`. */
export const containerStatus = (name: string, state: ContainerView["state"], reason: string | null = null, ready = state === "running"): ContainerView => ({
  name,
  image: "",
  ready,
  state,
  reason,
  exitCode: state === "terminated" ? 0 : null,
  restarts: 0,
  lastExitCode: null,
});

/** A native sidecar in a crash loop: it exited with `exitCode`, and the kubelet backs off before its next start. */
export const crashLooping = (name: string, exitCode: number, restarts = 3): ContainerView => ({
  ...containerStatus(name, "waiting", "CrashLoopBackOff", false),
  restarts,
  lastExitCode: exitCode,
});

export const memoryKubeApi = (): MemoryKube => {
  const pods = new Map<string, PodView>();
  const events = new Map<string, EventView[]>();
  const secrets = new Map<string, V1Secret>();
  const made: V1Pod[] = [];
  const policies: NetworkPolicyView[] = [];
  const deleted: string[] = [];
  return {
    made,
    secrets,
    policies,
    deleted,
    setPod: (name, change) => {
      const pod = pods.get(name);
      if (pod === undefined) throw new Error(`no pod ${name}`);
      pods.set(name, { ...pod, ...change });
    },
    addEvent: (pod, reason) => {
      events.set(pod, [...(events.get(pod) ?? []), { reason, message: reason, type: "Normal" }]);
    },
    version: () => Promise.resolve(kubeOk({ major: 1, minor: 31 })),
    namespace: () => Promise.resolve(kubeOk("exists")),
    canI: () => Promise.resolve(kubeOk(true)),
    createSecret: (_namespace, secret) => {
      const name = secret.metadata?.name ?? "";
      secrets.set(name, secret);
      return Promise.resolve(kubeOk({ name, uid: `uid-${name}` }));
    },
    ownSecret: () => Promise.resolve(kubeOk(undefined)),
    deleteSecret: (_namespace, name) => {
      secrets.delete(name);
      return Promise.resolve(kubeOk(undefined));
    },
    listSecretNames: () => Promise.resolve(kubeOk([...secrets.keys()])),
    createPod: (_namespace, pod) => {
      made.push(pod);
      const name = pod.metadata?.name ?? "";
      const view: PodView = {
        name,
        uid: `uid-${name}`,
        labels: pod.metadata?.labels ?? {},
        phase: "Pending",
        deleting: false,
        scheduled: null,
        ready: false,
        initContainers: [],
        containers: [],
        requests: { cpuMillis: 0, memoryMiB: 0 },
      };
      pods.set(name, view);
      return Promise.resolve(kubeOk(view));
    },
    readPod: (_namespace, name) => Promise.resolve(kubeOk(pods.get(name) ?? null)),
    deletePod: (_namespace, name) => {
      if (pods.delete(name)) deleted.push(name);
      return Promise.resolve(kubeOk(undefined));
    },
    listPods: () => Promise.resolve(kubeOk([...pods.values()])),
    podEvents: (_namespace, pod) => Promise.resolve(kubeOk(events.get(pod) ?? [])),
    quotas: () => Promise.resolve(kubeOk([])),
    networkPolicies: () => Promise.resolve(kubeOk(policies)),
    podLog: () => Promise.resolve(kubeOk("")),
  };
};

/** A clock the test moves: `sleep` advances it and runs the script for the new time. */
export const steppedClock = (script: (now: number) => void, start = 0): { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> } => {
  let now = start;
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      script(now);
      return Promise.resolve();
    },
  };
};
