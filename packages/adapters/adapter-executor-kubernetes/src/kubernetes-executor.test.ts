import { defaultAdapterContext } from "@ostra/adapter-sdk";
import type { BoxImage, BoxRef, BoxSize, BoxWaitChange, TaskProxies } from "@ostra/adapter-sdk";
import { boxIdSchema, taskIdSchema } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterEach, describe, expect, it } from "vitest";

import { KubernetesExecutor } from "./kubernetes-executor.ts";
import type { KubernetesExecutorOptions } from "./kubernetes-executor.ts";
import { boxObjects, LABELS, TOKEN_KEY } from "./pod.ts";
import { startFakeCluster } from "./testing/cluster.ts";
import type { FakeCluster } from "./testing/cluster.ts";
import type { KubeObject } from "./testing/fake-api.ts";
import { arrayOf, fakeSecretData, podSurface, recordOf } from "./testing/surface.ts";

// Ticket 07: the `kubernetes` executor's boxes as pods, against ticket 06's fake Kubernetes API,
// which `@kubernetes/client-node` talks to unmodified over HTTPS. The executor's own role here is
// the pool runner's: it makes and deletes pods and secrets; the task inside the box is the
// sidecar's (the contract suite, `kubernetes-executor.contract.test.ts`, plays it).

const NS = "ostra-boxes";
const SIZE: BoxSize = { cpuMillis: 1500, memoryMiB: 3072 };
const TOKEN = "ostra_tt_k8s_4f9a1c7e2b6d8053";
const PULL_TOKEN = "pull-secret-6c1d9e2f7a";
const IMAGE: BoxImage = {
  ref: "registry.example/ostra/snapshots/acme-web",
  digest: `sha256:${"a".repeat(64)}`,
  pull: { username: "puller", token: PULL_TOKEN },
};
const proxies: TaskProxies = { gitBaseUrl: "http://127.0.0.1:9/git", modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };

const clusters: FakeCluster[] = [];
afterEach(async () => {
  await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
});

const startCluster = async (minor?: number): Promise<FakeCluster> => {
  const cluster = await startFakeCluster({ namespaces: [NS], ...(minor === undefined ? {} : { minor }) });
  clusters.push(cluster);
  return cluster;
};

let counter = 0;
const newBox = (): BoxRef => {
  counter += 1;
  return { taskId: taskIdSchema.parse(`task-${String(counter)}`), boxId: boxIdSchema.parse(`box-${String(counter)}`) };
};

const executorOn = (cluster: FakeCluster, options: Partial<KubernetesExecutorOptions> = {}): KubernetesExecutor =>
  new KubernetesExecutor(
    {
      kube: cluster.kube,
      namespace: NS,
      images: { runner: "ghcr.io/ostra/runner:1.0.0", base: "ghcr.io/ostra/base:1.0.0" },
      serverUrl: "https://ostra.example",
      pollMs: 20,
      ...options,
    },
    defaultAdapterContext,
  );

/** The pod as the fake API serves it. */
const podOf = (cluster: FakeCluster, box: BoxRef): KubeObject => {
  const pod = cluster.fake.list("pods", NS).find((item) => recordOf(recordOf(item["metadata"])["labels"])[LABELS.box] === box.boxId);
  if (pod === undefined) throw new Error("no pod for the box");
  return pod;
};
const specOf = (pod: KubeObject): Record<string, unknown> => recordOf(pod["spec"]);
const containerNamed = (pod: KubeObject, name: string): Record<string, unknown> => {
  const spec = specOf(pod);
  const found = [...arrayOf(spec["initContainers"]), ...arrayOf(spec["containers"])].find((container) => container["name"] === name);
  if (found === undefined) throw new Error(`no container ${name}`);
  return found;
};

const secretData = (cluster: FakeCluster, name: string): Record<string, string> => fakeSecretData(cluster.fake, NS, name);
const surfaceOf = (cluster: FakeCluster, pod: KubeObject) => podSurface(cluster.fake, NS, pod);

describe("the kubernetes executor's boxes (ticket 07)", () => {
  it("F-093, F-095: the pod's shape, field by field: a native sidecar first, the size as the agent's requests and limits, the registry image by digest, no token, no host namespaces", async () => {
    const cluster = await startCluster();
    const executor = executorOn(cluster, { runtimeClassName: "gvisor", sidecarLimits: { cpuMillis: 500, memoryMiB: 256 } });
    const box = newBox();
    const created = await executor.create({ ...box, spec: taskSpecFixture, proxies, size: SIZE, image: IMAGE, taskToken: TOKEN });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const pod = podOf(cluster, box);
    const metadata = recordOf(pod["metadata"]);
    expect(metadata["name"]).toBe(`ostra-box-${box.boxId}`);
    expect(metadata["labels"]).toEqual({
      "app.kubernetes.io/part-of": "ostra",
      "ostra.dev/role": "box",
      "ostra.dev/box": box.boxId,
      "ostra.dev/task": box.taskId,
      "ostra.dev/organization": taskSpecFixture.organizationId,
    });
    expect(metadata["ownerReferences"], "a box's pod is owned by nothing").toBeUndefined();
    const spec = specOf(pod);
    expect(spec["automountServiceAccountToken"]).toBe(false);
    expect(spec["enableServiceLinks"]).toBe(false);
    expect(spec["hostNetwork"]).toBe(false);
    expect(spec["hostPID"]).toBe(false);
    expect(spec["hostIPC"]).toBe(false);
    expect(spec["restartPolicy"]).toBe("Never");
    expect(spec["runtimeClassName"]).toBe("gvisor");
    expect(recordOf(spec["securityContext"])["seccompProfile"]).toEqual({ type: "RuntimeDefault" });
    expect(spec["imagePullSecrets"]).toEqual([{ name: `ostra-box-${box.boxId}-pull` }]);

    // The sidecar: the first init container, native, with its own limits.
    const init = arrayOf(spec["initContainers"]);
    expect(init.map((container) => container["name"])).toEqual(["sidecar"]);
    const sidecar = containerNamed(pod, "sidecar");
    expect(sidecar["restartPolicy"]).toBe("Always");
    expect(sidecar["image"]).toBe("ghcr.io/ostra/runner:1.0.0");
    expect(sidecar["command"]).toEqual(["ostra", "sidecar"]);
    expect(sidecar["resources"]).toEqual({ requests: { cpu: "500m", memory: "256Mi" }, limits: { cpu: "500m", memory: "256Mi" } });
    expect(sidecar["securityContext"]).toEqual({
      runAsUser: 1000,
      runAsGroup: 1000,
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(arrayOf(sidecar["volumeMounts"]).map((mount) => [mount["name"], mount["mountPath"], mount["readOnly"] ?? false])).toEqual([
      ["task", "/task", false],
      ["sidecar-data", "/var/lib/ostra-sidecar", false],
      ["tmp-sidecar", "/tmp", false],
      ["token", "/run/ostra", true],
    ]);
    const sidecarEnv = Object.fromEntries(arrayOf(sidecar["env"]).map((variable) => [String(variable["name"]), variable["value"] ?? variable["valueFrom"]] as const));
    expect(sidecarEnv).toMatchObject({
      OSTRA_SERVER_URL: "https://ostra.example",
      OSTRA_SIDECAR_TOKEN_FILE: "/run/ostra/token",
      OSTRA_BOX_ID: box.boxId,
      OSTRA_TASK_ID: box.taskId,
      OSTRA_BRIDGE_PORT: "7101",
      OSTRA_SIDECAR_HOST: "127.0.0.1",
      OSTRA_BRIDGE_NONCE: { secretKeyRef: { name: `ostra-box-${box.boxId}`, key: "bridge-nonce" } },
    });

    // The agent: the size as requests and limits, the image by digest, the init's capabilities only.
    const agent = containerNamed(pod, "agent");
    expect(arrayOf(spec["containers"]).map((container) => container["name"])).toEqual(["agent"]);
    expect(agent["image"]).toBe(`${IMAGE.ref}@${IMAGE.digest}`);
    expect(agent["resources"]).toEqual({ requests: { cpu: "1500m", memory: "3072Mi" }, limits: { cpu: "1500m", memory: "3072Mi" } });
    expect(agent["securityContext"]).toEqual({
      runAsUser: 0,
      runAsNonRoot: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"], add: ["SETUID", "SETGID", "KILL"] },
    });
    expect(arrayOf(agent["volumeMounts"]).map((mount) => mount["name"])).toEqual(["task", "tmp-agent"]);
    const agentEnv = Object.fromEntries(arrayOf(agent["env"]).map((variable) => [String(variable["name"]), variable["value"] ?? variable["valueFrom"]] as const));
    expect(agentEnv).toEqual({
      OSTRA_BOX_ID: box.boxId,
      OSTRA_BRIDGE_NONCE: { secretKeyRef: { name: `ostra-box-${box.boxId}`, key: "bridge-nonce" } },
      OSTRA_BRIDGE_ADDR: "127.0.0.1:7101",
      OSTRA_AGENT_UID: "1000",
      OSTRA_AGENT_GID: "1000",
    });

    // The token volume carries the token's key alone; the pull secret is a dockerconfigjson for the registry's host.
    const tokenVolume = arrayOf(spec["volumes"]).find((volume) => volume["name"] === "token");
    expect(recordOf(tokenVolume?.["secret"])["items"]).toEqual([{ key: TOKEN_KEY, path: "token", mode: 0o400 }]);
    const pull = cluster.fake.get("secrets", NS, `ostra-box-${box.boxId}-pull`);
    expect(pull?.["type"]).toBe("kubernetes.io/dockerconfigjson");
    const config: unknown = JSON.parse(secretData(cluster, `ostra-box-${box.boxId}-pull`)[".dockerconfigjson"] ?? "{}");
    expect(config).toMatchObject({ auths: { "registry.example": { username: "puller", password: PULL_TOKEN } } });
    await executor.release(box, "requested");
  });

  it("F-095: a box without a size has no limits of its own, and the environment's base image when no registry image is given", () => {
    const objects = boxObjects(
      { box: newBox(), spec: { ...taskSpecFixture, environment: { ...taskSpecFixture.environment, baseImage: "node:24" } }, size: null, image: null, nonce: "n".repeat(43), taskToken: null },
      { images: { runner: "r", base: "b" }, serverUrl: "https://ostra.example", runtimeClassName: null, sidecarLimits: { cpuMillis: 1000, memoryMiB: 256 }, serviceLimits: { cpuMillis: 1000, memoryMiB: 1024 }, bridgePort: 7101, initCommand: ["init"], sidecarCommand: ["sidecar"] },
    );
    const agent = objects.pod.spec?.containers[0];
    expect(agent?.resources).toBeUndefined();
    expect(agent?.image).toBe("node:24");
    expect(objects.pod.spec?.runtimeClassName).toBeUndefined();
    expect(objects.pullSecret).toBeNull();
    expect(objects.pod.spec?.imagePullSecrets).toBeUndefined();
  });

  it("F-015: the task token is in the sidecar's token volume and in no other container's environment, volumes or arguments", async () => {
    const cluster = await startCluster();
    const executor = executorOn(cluster);
    const box = newBox();
    const created = await executor.create({ ...box, spec: taskSpecFixture, proxies, size: SIZE, image: IMAGE, taskToken: TOKEN });
    expect(created.ok).toBe(true);
    const places = surfaceOf(cluster, podOf(cluster, box));
    const holding = places.filter((place) => place.text.includes(TOKEN)).map((place) => place.where);
    expect(holding).toEqual(["sidecar:token-mount"]);
    // The pull credential is in no container at all: only the kubelet reads the pull secret.
    expect(places.filter((place) => place.text.includes(PULL_TOKEN)).map((place) => place.where)).toEqual([]);
    // And the token is nowhere in the pod's own object, as the API serves it.
    expect(JSON.stringify(podOf(cluster, box)).includes(TOKEN)).toBe(false);
    await executor.release(box, "requested");
  });

  it("F-093: a cluster under 1.29 is refused, with the reason; 1.29 is accepted", async () => {
    const old = await startCluster(28);
    expect(await executorOn(old).health()).toEqual({
      status: "down",
      reason: "This cluster runs Kubernetes 1.28; ostra's boxes need 1.29 or later for native sidecars.",
    });
    const current = await startCluster(29);
    expect(await executorOn(current).health()).toEqual({ status: "ok" });
  });

  it("F-093: health() refuses a missing namespace and a service account without the rights it needs", async () => {
    const cluster = await startCluster();
    const missing = await executorOn(cluster, { namespace: "nowhere" }).health();
    expect(missing.status).toBe("down");
    expect(missing.status === "ok" ? "" : missing.reason).toContain("nowhere doesn't exist");
    cluster.fake.denyAccess((attributes) => attributes.resource === "secrets" && attributes.verb === "delete");
    expect(await executorOn(cluster).health()).toEqual({ status: "down", reason: "The runner's service account may not delete secrets in ostra-boxes: its role needs it." });
  });

  it("F-093: nothing outside the box namespace is touched: every request and every access review names it", async () => {
    const cluster = await startCluster();
    const reviewed: (string | null)[] = [];
    cluster.fake.denyAccess((attributes) => {
      reviewed.push(attributes.namespace);
      return false;
    });
    // The test made the namespace, as the chart does; the executor's own requests start here.
    const setup = cluster.fake.requests().length;
    const executor = executorOn(cluster);
    expect(await executor.health()).toEqual({ status: "ok" });
    const box = newBox();
    const before = cluster.fake.requests().length;
    expect((await executor.create({ ...box, spec: taskSpecFixture, proxies, size: SIZE, image: IMAGE, taskToken: TOKEN })).ok).toBe(true);
    expect((await executor.prepare({ box, spec: taskSpecFixture, secrets: [], onSetupOutput: () => undefined })).ok).toBe(true);
    expect(await executor.state(box)).toEqual({ ok: true, value: "ready" });
    await executor.stop({ box, graceMs: 1000 });
    await executor.release(box, "requested");
    expect(reviewed.length).toBeGreaterThan(0);
    expect(new Set(reviewed)).toEqual(new Set([NS]));
    const all = cluster.fake.requests().slice(setup);
    // The namespace's own object is read (does it exist?), and /version; every other call is in the namespace.
    const outside = all.filter((request) => request.namespace !== NS && request.path !== "/version" && request.path !== `/api/v1/namespaces/${NS}` && !request.path.endsWith("/selfsubjectaccessreviews"));
    expect(outside).toEqual([]);
    expect(all.slice(before).every((request) => request.namespace === NS)).toBe(true);
  });

  it("F-015: release deletes the pod and both secrets, found by the box's label; nothing of the box is left", async () => {
    const cluster = await startCluster();
    const executor = executorOn(cluster);
    const box = newBox();
    const other = newBox();
    expect((await executor.create({ ...box, spec: taskSpecFixture, proxies, size: SIZE, image: IMAGE, taskToken: TOKEN })).ok).toBe(true);
    expect((await executor.create({ ...other, spec: taskSpecFixture, proxies, size: SIZE, taskToken: TOKEN })).ok).toBe(true);
    const ofBox = (resource: "pods" | "secrets", ref: BoxRef): string[] =>
      cluster.fake
        .list(resource, NS)
        .filter((item) => recordOf(recordOf(item["metadata"])["labels"])[LABELS.box] === ref.boxId)
        .map((item) => String(recordOf(item["metadata"])["name"]));
    expect(ofBox("pods", box)).toEqual([`ostra-box-${box.boxId}`]);
    expect(ofBox("secrets", box).sort()).toEqual([`ostra-box-${box.boxId}`, `ostra-box-${box.boxId}-pull`]);
    // The secrets are the pod's dependents, so the garbage collector deletes them with it.
    const owners = arrayOf(recordOf(cluster.fake.get("secrets", NS, `ostra-box-${box.boxId}`)?.["metadata"])["ownerReferences"]);
    expect(owners.map((owner) => [owner["kind"], owner["name"]])).toEqual([["Pod", `ostra-box-${box.boxId}`]]);
    expect(await executor.release(box, "requested")).toEqual({ ok: true, value: undefined });
    await expect.poll(() => [...ofBox("pods", box), ...ofBox("secrets", box)]).toEqual([]);
    expect(await executor.state(box)).toEqual({ ok: true, value: "released" });
    // Another box's objects stay.
    expect(ofBox("pods", other)).toEqual([`ostra-box-${other.boxId}`]);
    await executor.release(other, "requested");
  });

  it("F-015: on a pool runner the executor only makes and removes the box's pod: the task's own calls are the sidecar's, in the pod", async () => {
    const cluster = await startCluster();
    const executor = executorOn(cluster);
    const box = newBox();
    expect((await executor.create({ ...box, spec: taskSpecFixture, proxies, taskToken: TOKEN })).ok).toBe(true);
    expect(await executor.prepare({ box, spec: taskSpecFixture, secrets: [], onSetupOutput: () => undefined })).toEqual({ ok: true, value: { setup: null } });
    const launch = { command: "opencode", args: [], env: {}, cwd: "/task", files: [] };
    for (const answer of [
      await executor.startAgent(box, launch),
      await executor.listWorkspaceRoot(box),
      await executor.commitWork({ box, message: "m", author: taskSpecFixture.gitIdentity, coAuthors: [] }),
      await executor.saveWorkInProgress({ box, turnOrdinal: 1 }),
    ]) {
      expect(answer).toMatchObject({ ok: false, error: { code: "unsupported" } });
    }
    // Nothing ran on the runner: the pod's containers are the kubelet's.
    expect(cluster.fake.list("pods", NS).length).toBe(1);
    await executor.release(box, "requested");
  });

  it("F-093: stop deletes the pod, so a stopped box is never kept running (ADR 0039)", async () => {
    const cluster = await startCluster();
    const executor = executorOn(cluster);
    const box = newBox();
    await executor.create({ ...box, spec: taskSpecFixture, proxies, taskToken: TOKEN });
    expect((await executor.prepare({ box, spec: taskSpecFixture, secrets: [], onSetupOutput: () => undefined })).ok).toBe(true);
    expect(await executor.stop({ box, graceMs: 1000 })).toEqual({ ok: true, value: undefined });
    expect(await executor.state(box)).toEqual({ ok: true, value: "stopped" });
    await expect.poll(() => cluster.fake.get("pods", NS, `ostra-box-${box.boxId}`)).toBeUndefined();
    await executor.release(box, "requested");
  });

  it("F-093: create returns once the pod exists, before a node is found; prepare then says it waits for a node and when it's scheduled", async () => {
    const cluster = await startCluster();
    const executor = executorOn(cluster);
    const box = newBox();
    const heard: BoxWaitChange[] = [];
    const heardAt: number[] = [];
    cluster.fake.holdUnschedulable(1500);
    const started = Date.now();
    const created = await executor.create({
      ...box,
      spec: taskSpecFixture,
      proxies,
      taskToken: TOKEN,
      onWaiting: (change) => {
        heard.push(change);
        heardAt.push(Date.now());
      },
    });
    expect(created.ok).toBe(true);
    expect(Date.now() - started, "create didn't wait for the node").toBeLessThan(1000);
    expect(await executor.state(box)).toEqual({ ok: true, value: "creating" });
    expect(heard).toEqual([]);
    expect((await executor.prepare({ box, spec: taskSpecFixture, secrets: [], onSetupOutput: () => undefined })).ok).toBe(true);
    expect(heard.map((change) => change.kind)).toEqual(["waiting", "scheduled"]);
    expect(heard[0]).toMatchObject({ kind: "waiting", reason: "node" });
    // Scheduled no sooner than the 1.5 s hold allows, by the test's own clock. The executor's
    // `afterMs` starts when it first sees the wait, late on a busy CI machine (1383 ms in run
    // 44783768396), so it's only checked to be a real wait no longer than the test saw.
    const scheduled = heard[1];
    const scheduledAt = heardAt[1] ?? started;
    expect(scheduledAt - started).toBeGreaterThanOrEqual(1450);
    expect(scheduled?.kind === "scheduled" ? scheduled.afterMs : 0).toBeGreaterThan(0);
    expect(scheduled?.kind === "scheduled" ? scheduled.afterMs : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(scheduledAt - started + 50);
    expect(await executor.state(box)).toEqual({ ok: true, value: "ready" });
    await executor.release(box, "requested");
  });

  it("F-095: capacity offers the quota's CPU and memory less the namespace's other pods, and the settings without a quota", async () => {
    const cluster = await startCluster();
    const executor = executorOn(cluster, { slots: 7, resources: { cpuMillis: 8000, memoryMiB: 16_384 } });
    expect(await executor.refreshCapacity()).toEqual({ slots: 7, cpuMillis: 8000, memoryMiB: 16_384 });
    expect(executor.capacity()).toEqual({ slots: 7, cpuMillis: 8000, memoryMiB: 16_384 });
    const { CoreV1Api } = await import("@kubernetes/client-node");
    const { kubeConfigFromString } = await import("./kube-api.ts");
    const core = kubeConfigFromString(cluster.kubeconfig).makeApiClient(CoreV1Api);
    await core.createNamespacedResourceQuota({ namespace: NS, body: { metadata: { name: "boxes" }, spec: { hard: { "requests.cpu": "20", "requests.memory": "64Gi", "limits.cpu": "24" } } } });
    // The runner's own pod, which isn't a box: its requests come off the offer.
    await core.createNamespacedPod({
      namespace: NS,
      body: { metadata: { name: "ostra-runner" }, spec: { containers: [{ name: "runner", image: "r", resources: { requests: { cpu: "500m", memory: "512Mi" }, limits: { cpu: "500m", memory: "512Mi" } } }] } },
    });
    // A box doesn't: core subtracts the boxes it placed (ADR 0059).
    const box = newBox();
    await executor.create({ ...box, spec: taskSpecFixture, proxies, size: SIZE, taskToken: TOKEN });
    expect(await executor.refreshCapacity()).toEqual({ slots: 7, cpuMillis: 19_500, memoryMiB: 65_536 - 512 });
    await executor.release(box, "requested");
  });
});
