import { defaultAdapterContext } from "@ostra/adapter-sdk";
import type { BoxRef, TaskProxies } from "@ostra/adapter-sdk";
import { boxIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterEach, describe, expect, it } from "vitest";

import { baselineEgressPolicy, BOX_BLOCKED_V4, BOX_BLOCKED_V6 } from "./egress.ts";
import { KubernetesExecutor } from "./kubernetes-executor.ts";
import type { KubernetesExecutorOptions } from "./kubernetes-executor.ts";
import { boxNames } from "./pod.ts";
import { startFakeCluster } from "./testing/cluster.ts";
import type { FakeCluster } from "./testing/cluster.ts";
import { arrayOf, recordOf } from "./testing/surface.ts";

// Ticket 08: a box's services as native sidecars (F-094's `kubernetes` half, F-093) and the egress
// baseline the executor insists on (F-116), against ticket 06's fake Kubernetes API.

const NS = "ostra-boxes";
const proxies: TaskProxies = { gitBaseUrl: "http://127.0.0.1:9/git", modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };

const clusters: FakeCluster[] = [];
afterEach(async () => {
  await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
});

const start = async (egressBaseline = true): Promise<FakeCluster> => {
  const cluster = await startFakeCluster({ namespaces: [NS], egressBaseline });
  clusters.push(cluster);
  return cluster;
};

const executorOn = (cluster: FakeCluster, options: Partial<KubernetesExecutorOptions> = {}): KubernetesExecutor =>
  new KubernetesExecutor(
    { kube: cluster.kube, namespace: NS, images: { runner: "ghcr.io/ostra/runner:1.0.0", base: "ghcr.io/ostra/base:1.0.0" }, serverUrl: "https://ostra.example", pollMs: 20, ...options },
    defaultAdapterContext,
  );

const box: BoxRef = { taskId: taskIdSchema.parse("task-svc"), boxId: boxIdSchema.parse("box-svc") };

const withServices: TaskSpec = {
  ...taskSpecFixture,
  services: [
    { name: "postgres", image: "postgres:18.6-bookworm", port: 5432, variables: [{ name: "POSTGRES_DB", value: "app" }], healthCheck: "pg_isready -U postgres" },
    { name: "redis", image: "redis:8.2", port: 6379, variables: [], healthCheck: null },
  ],
};

describe("services and the egress baseline on kubernetes (ticket 08)", () => {
  it("F-093/c1, F-094/c2,c4: a box with two services has them as native sidecars after the sidecar, in order, each with its health check, its port and its own limits, reachable by name", async () => {
    const cluster = await start();
    const executor = executorOn(cluster, { serviceLimits: { cpuMillis: 750, memoryMiB: 512 } });
    const created = await executor.create({ ...box, spec: withServices, proxies });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const pod = cluster.fake.get("pods", NS, boxNames(box).pod);
    const spec = recordOf(pod?.["spec"]);
    const init = arrayOf(spec["initContainers"]);
    expect(init.map((container) => container["name"])).toEqual(["sidecar", "svc-postgres", "svc-redis"]);
    expect(init.map((container) => container["restartPolicy"])).toEqual(["Always", "Always", "Always"]);
    const [, postgres, redis] = init;
    expect(postgres?.["image"]).toBe("postgres:18.6-bookworm");
    expect(postgres?.["env"]).toEqual([{ name: "POSTGRES_DB", value: "app" }]);
    expect(postgres?.["ports"]).toEqual([{ containerPort: 5432, protocol: "TCP" }]);
    expect(recordOf(postgres?.["readinessProbe"])["exec"]).toEqual({ command: ["sh", "-c", "pg_isready -U postgres"] });
    expect(recordOf(redis?.["readinessProbe"])["tcpSocket"]).toEqual({ host: "127.0.0.1", port: 6379 });
    for (const service of [postgres, redis]) {
      expect(service?.["resources"]).toEqual({ requests: { cpu: "750m", memory: "512Mi" }, limits: { cpu: "750m", memory: "512Mi" } });
      expect(recordOf(service?.["securityContext"])["allowPrivilegeEscalation"]).toBe(false);
    }
    // The services' names resolve to the pod's loopback, as on docker's box network.
    expect(spec["hostAliases"]).toEqual([{ ip: "127.0.0.1", hostnames: ["postgres", "redis"] }]);
    // The agent stays the pod's one container.
    expect(arrayOf(spec["containers"]).map((container) => container["name"])).toEqual(["agent"]);
    const prepared = await executor.prepare({ box, spec: withServices, secrets: [], onSetupOutput: () => undefined });
    expect(prepared.ok && prepared.value.services?.map((service) => [service.name, service.outcome])).toEqual([
      ["postgres", "healthy"],
      ["redis", "healthy"],
    ]);
    await executor.release(box, "requested");
  });

  it("F-094/c4: a service whose container ends before it's healthy is reported failed, by name, and the box goes on", async () => {
    const cluster = await start();
    const executor = executorOn(cluster);
    await executor.create({ ...box, spec: withServices, proxies });
    const name = boxNames(box).pod;
    await expect.poll(() => recordOf(recordOf(cluster.fake.get("pods", NS, name)?.["status"]))["phase"]).toBe("Running");
    cluster.fake.exitContainer(NS, name, "svc-redis", 1);
    const answer = await executor.prepare({ box, spec: withServices, secrets: [], onSetupOutput: () => undefined });
    expect(answer.ok && answer.value.services).toEqual([
      expect.objectContaining({ name: "postgres", outcome: "healthy" }),
      { name: "redis", outcome: "failed", reason: "The service's container exited (exit 1) before it was healthy." },
    ]);
    expect(await executor.state(box)).toEqual({ ok: true, value: "preparing" });
    await executor.release(box, "requested");
  });

  it("F-116/c1,c2: health() refuses a namespace without the egress baseline, or with a policy that lets boxes reach private ranges, and names the fix", async () => {
    const bare = await start(false);
    const missing = await executorOn(bare).health();
    expect(missing).toEqual({
      status: "down",
      reason: "The namespace ostra-boxes has no NetworkPolicy restricting the egress of its boxes, so ostra won't start them there. Install the runner chart's egress baseline (deploy/helm/ostra-runner), which applies it once per namespace.",
    });
    // A policy that selects the boxes but allows everything out is no baseline.
    await bare.applyPolicy(NS, { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "open" }, spec: { podSelector: {}, policyTypes: ["Egress"], egress: [{}] } });
    const open = await executorOn(bare).health();
    expect(open.status === "ok" ? "" : open.reason).toContain("lets them reach private ranges or the metadata address");
    const guarded = await start(true);
    expect(await executorOn(guarded).health()).toEqual({ status: "ok" });
  });

  it("F-116/c1,c2: the baseline allows DNS at the cluster's resolver, the server's address on its port, the admin's allowed addresses, and the internet without its private ranges; no ingress", () => {
    const policy = baselineEgressPolicy({ namespace: NS, server: { kind: "cidr", cidr: "10.20.0.5", port: 443 }, allow: ["10.30.0.0/24"] });
    expect(policy.metadata?.name).toBe("ostra-egress-baseline");
    expect(policy.spec?.podSelector).toEqual({ matchLabels: { "ostra.dev/role": "box" } });
    expect(policy.spec?.policyTypes).toEqual(["Egress", "Ingress"]);
    expect(policy.spec?.ingress).toEqual([]);
    const [dns, server, allowed, internet] = policy.spec?.egress ?? [];
    expect(dns).toEqual({
      to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
      ports: [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
    });
    expect(server).toEqual({ to: [{ ipBlock: { cidr: "10.20.0.5/32" } }], ports: [{ protocol: "TCP", port: 443 }] });
    expect(allowed).toEqual({ to: [{ ipBlock: { cidr: "10.30.0.0/24" } }] });
    expect(internet).toEqual({
      to: [
        { ipBlock: { cidr: "0.0.0.0/0", except: [...BOX_BLOCKED_V4] } },
        { ipBlock: { cidr: "::/0", except: [...BOX_BLOCKED_V6] } },
      ],
    });
    for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "127.0.0.0/8"]) expect(BOX_BLOCKED_V4).toContain(range);
    // In the cluster: the server's pods by their labels, on their port.
    const inCluster = baselineEgressPolicy({ namespace: NS, server: { kind: "in-cluster", namespaceLabels: { "kubernetes.io/metadata.name": "ostra" }, podLabels: { app: "ostra-core" }, port: 9000 }, allow: [] });
    expect(inCluster.spec?.egress?.[1]).toEqual({
      to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ostra" } }, podSelector: { matchLabels: { app: "ostra-core" } } }],
      ports: [{ protocol: "TCP", port: 9000 }],
    });
    expect(inCluster.spec?.egress).toHaveLength(3);
  });
});
