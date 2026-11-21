import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CoreV1Api, KubeConfig, VersionApi, Watch } from "@kubernetes/client-node";
import type { V1Pod } from "@kubernetes/client-node";
import { isAlive } from "@ostra/adapter-sdk";
import { testPort } from "@ostra/adapter-sdk/testing/net";
import { afterEach, describe, expect, it } from "vitest";

import { startFakeKubeApi } from "./fake-api.ts";
import type { FakeKubeApi, FakeKubeOptions } from "./fake-api.ts";
import { PROCESS_MODE_NOTICE } from "./process-mode.ts";

// Ticket 06: the fake Kubernetes API, driven by `@kubernetes/client-node` unmodified, through a
// kubeconfig, as the `kubernetes` executor (ticket 07) and the runner will drive it.

const NAMESPACE = "ostra-boxes";
const started: FakeKubeApi[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((fake) => fake.close()));
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

const startFake = async (options: FakeKubeOptions = {}): Promise<{ readonly fake: FakeKubeApi; readonly core: CoreV1Api; readonly config: KubeConfig }> => {
  const fake = await startFakeKubeApi(options);
  started.push(fake);
  const config = new KubeConfig();
  config.loadFromString(fake.kubeconfig(NAMESPACE));
  const core = config.makeApiClient(CoreV1Api);
  await core.createNamespace({ body: { metadata: { name: NAMESPACE } } });
  return { fake, core, config };
};

const waitFor = async <T,>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A box's pod as the executor will make it: the sidecar as a native sidecar, the agent as the main container. */
const boxPod = (name: string, extra: Partial<V1Pod["spec"]> = {}): V1Pod => ({
  metadata: { name, labels: { "ostra.dev/role": "box", "ostra.dev/box": name } },
  spec: {
    restartPolicy: "Never",
    automountServiceAccountToken: false,
    initContainers: [{ name: "sidecar", image: "ghcr.io/ostra/runner:1.0.0", restartPolicy: "Always", resources: { limits: { cpu: "500m", memory: "256Mi" } } }],
    containers: [{ name: "agent", image: "ghcr.io/ostra/base:1.0.0", resources: { limits: { cpu: "2", memory: "4Gi" }, requests: { cpu: "2", memory: "4Gi" } } }],
    ...extra,
  },
});

const reasonsOf = async (core: CoreV1Api, pod: string): Promise<string[]> =>
  (await core.listNamespacedEvent({ namespace: NAMESPACE, fieldSelector: `involvedObject.name=${pod}` })).items.map((event) => event.reason ?? "");

describe("the fake Kubernetes API (ticket 06)", () => {
  it("F-093: @kubernetes/client-node creates, watches and deletes a pod and a secret on the fake, and the pod's secret goes with it", async () => {
    const { core, config, fake } = await startFake();
    const seen: string[] = [];
    const controller = await new Watch(config).watch(
      `/api/v1/namespaces/${NAMESPACE}/pods`,
      {},
      (type, object: V1Pod) => {
        seen.push(`${type}:${object.status?.phase ?? "?"}`);
      },
      () => undefined,
    );
    try {
      const pod = await core.createNamespacedPod({ namespace: NAMESPACE, body: boxPod("box-1") });
      expect(pod.metadata?.uid).toMatch(/[0-9a-f-]{36}/);
      // The task token's secret, owned by the pod, as ticket 07 makes it.
      const owned = await core.createNamespacedSecret({
        namespace: NAMESPACE,
        body: {
          metadata: { name: "box-1-token", ownerReferences: [{ apiVersion: "v1", kind: "Pod", name: "box-1", uid: pod.metadata?.uid ?? "" }] },
          stringData: { token: "ostra_tt_fake" },
        },
      });
      // `stringData` is stored as `data`, base64, as the API server does.
      expect(owned.data).toEqual({ token: Buffer.from("ostra_tt_fake").toString("base64") });
      const loose = await core.createNamespacedSecret({ namespace: NAMESPACE, body: { metadata: { name: "loose" }, data: { a: Buffer.from("b").toString("base64") } } });
      expect(loose.type).toBe("Opaque");

      const running = await waitFor(
        () => core.readNamespacedPod({ name: "box-1", namespace: NAMESPACE }),
        (read) => read.status?.phase === "Running",
      );
      expect(running.status?.phase).toBe("Running");
      expect(running.status?.initContainerStatuses?.[0]).toMatchObject({ name: "sidecar", ready: true });
      expect(running.status?.conditions?.find((condition) => condition.type === "Ready")?.status).toBe("True");
      expect(await reasonsOf(core, "box-1")).toEqual(expect.arrayContaining(["Scheduled", "Pulled"]));

      await core.deleteNamespacedPod({ name: "box-1", namespace: NAMESPACE });
      await waitFor(() => seen, (list) => list.some((entry) => entry.startsWith("DELETED")));
      const secrets = await waitFor(
        async () => (await core.listNamespacedSecret({ namespace: NAMESPACE })).items.map((secret) => secret.metadata?.name),
        (names) => !names.includes("box-1-token"),
      );
      expect(secrets).toEqual(["loose"]);
      await core.deleteNamespacedSecret({ name: "loose", namespace: NAMESPACE });
      await expect(core.readNamespacedSecret({ name: "loose", namespace: NAMESPACE })).rejects.toMatchObject({ code: 404 });
      expect(seen[0]).toBe("ADDED:Pending");
      expect(seen).toContain("MODIFIED:Running");
      expect(fake.list("pods", NAMESPACE)).toEqual([]);
    } finally {
      controller.abort();
    }
  });

  it("F-093: the unschedulable switch holds a pod Pending with the autoscaler's TriggeredScaleUp event, then schedules it", async () => {
    const { core, fake } = await startFake();
    fake.holdUnschedulable(600);
    const createdAt = Date.now();
    await core.createNamespacedPod({ namespace: NAMESPACE, body: boxPod("box-2") });
    const pending = await core.readNamespacedPod({ name: "box-2", namespace: NAMESPACE });
    expect(pending.status?.phase).toBe("Pending");
    expect(pending.status?.conditions?.find((condition) => condition.type === "PodScheduled")).toMatchObject({ status: "False", reason: "Unschedulable" });
    const events = (await core.listNamespacedEvent({ namespace: NAMESPACE, fieldSelector: "involvedObject.name=box-2" })).items;
    expect(events.find((event) => event.reason === "TriggeredScaleUp")).toMatchObject({ type: "Normal", source: { component: "cluster-autoscaler" } });
    expect(events.map((event) => event.reason)).toContain("FailedScheduling");
    const running = await waitFor(
      () => core.readNamespacedPod({ name: "box-2", namespace: NAMESPACE }),
      (read) => read.status?.phase === "Running",
    );
    expect(running.status?.phase).toBe("Running");
    expect(Date.now() - createdAt).toBeGreaterThanOrEqual(550);
    expect(await reasonsOf(core, "box-2")).toContain("Scheduled");
  });

  it("F-093: a native sidecar is refused when the fake reports 1.28, with the version it reports", async () => {
    const { core, config, fake } = await startFake();
    fake.reportMinor(28);
    expect(await config.makeApiClient(VersionApi).getCode()).toMatchObject({ major: "1", minor: "28" });
    await expect(core.createNamespacedPod({ namespace: NAMESPACE, body: boxPod("box-3") })).rejects.toMatchObject({ code: 422 });
    fake.reportMinor(29);
    await expect(core.createNamespacedPod({ namespace: NAMESPACE, body: boxPod("box-3") })).resolves.toMatchObject({ metadata: { name: "box-3" } });
  });

  it("F-093: the fake checks what an executor sets: a sidecar's restart policy, labels, volumes, quotas and owners", async () => {
    const { core, fake } = await startFake();
    const refused = async (body: V1Pod): Promise<unknown> => core.createNamespacedPod({ namespace: NAMESPACE, body }).then(() => "made", (error: unknown) => error);
    await expect(refused(boxPod("bad-1", { initContainers: [{ name: "sidecar", image: "x", restartPolicy: "OnFailure" }] }))).resolves.toMatchObject({ code: 422 });
    await expect(refused({ ...boxPod("bad-2"), metadata: { name: "bad-2", labels: { "ostra.dev/box": "not ok!" } } })).resolves.toMatchObject({ code: 422 });
    await expect(refused(boxPod("bad-3", { containers: [{ name: "agent", image: "x", volumeMounts: [{ name: "missing", mountPath: "/run/ostra" }] }] }))).resolves.toMatchObject({ code: 422 });
    await expect(refused(boxPod("bad-4", { containers: [{ name: "agent", image: "" }] }))).resolves.toMatchObject({ code: 422 });
    expect(fake.list("pods", NAMESPACE)).toEqual([]);

    // A quota of 3 CPUs: the first box (2.5 with its sidecar) fits, the second is refused.
    await core.createNamespacedResourceQuota({ namespace: NAMESPACE, body: { metadata: { name: "boxes" }, spec: { hard: { "limits.cpu": "3", "limits.memory": "16Gi" } } } });
    await core.createNamespacedPod({ namespace: NAMESPACE, body: boxPod("fits") });
    await expect(refused(boxPod("over"))).resolves.toMatchObject({ code: 403 });
    const quota = await core.readNamespacedResourceQuota({ name: "boxes", namespace: NAMESPACE });
    // The agent's 2 CPUs and 4 GiB, and the sidecar's half CPU and 256 MiB.
    expect(quota.status?.used).toEqual({ "limits.cpu": "2500m", "limits.memory": "4352Mi" });

    // A secret owned by a uid that isn't in the namespace is collected, as the garbage collector would.
    await core.createNamespacedSecret({
      namespace: NAMESPACE,
      body: { metadata: { name: "orphan", ownerReferences: [{ apiVersion: "v1", kind: "Pod", name: "gone", uid: "00000000-0000-0000-0000-000000000000" }] }, data: {} },
    });
    const names = await waitFor(
      async () => (await core.listNamespacedSecret({ namespace: NAMESPACE })).items.map((secret) => secret.metadata?.name),
      (list) => !list.includes("orphan"),
    );
    expect(names).not.toContain("orphan");
  });

  it("F-120: a failed image pull leaves the pod Pending in ImagePullBackOff with the kubelet's event, and a pull records its secret's user", async () => {
    const { core, fake } = await startFake();
    const auths = { auths: { "registry.example": { username: "ostra-pull", password: "pull-secret-value" } } };
    await core.createNamespacedSecret({
      namespace: NAMESPACE,
      body: { metadata: { name: "pull" }, type: "kubernetes.io/dockerconfigjson", data: { ".dockerconfigjson": Buffer.from(JSON.stringify(auths)).toString("base64") } },
    });
    const digest = `registry.example/ostra/snapshots/p@sha256:${"a".repeat(64)}`;
    await core.createNamespacedPod({ namespace: NAMESPACE, body: boxPod("pulls", { imagePullSecrets: [{ name: "pull" }], containers: [{ name: "agent", image: digest }] }) });
    await waitFor(() => fake.pulls(), (list) => list.some((pull) => pull.pod === "pulls" && pull.container === "agent"));
    expect(fake.pulls().find((pull) => pull.container === "agent")).toEqual({ namespace: NAMESPACE, pod: "pulls", container: "agent", image: digest, pullSecret: "pull", username: "ostra-pull" });

    fake.failImagePull("registry.example/ostra/snapshots/broken");
    await core.createNamespacedPod({ namespace: NAMESPACE, body: boxPod("broken", { containers: [{ name: "agent", image: "registry.example/ostra/snapshots/broken@sha256:00" }] }) });
    const stuck = await waitFor(
      () => core.readNamespacedPod({ name: "broken", namespace: NAMESPACE }),
      (read) => read.status?.containerStatuses?.[0]?.state?.waiting?.reason === "ImagePullBackOff",
    );
    expect(stuck.status?.phase).toBe("Pending");
    expect(stuck.status?.containerStatuses?.[0]?.state?.waiting?.reason).toBe("ImagePullBackOff");
    expect(await reasonsOf(core, "broken")).toContain("Failed");
  });
});

const exists = async (file: string): Promise<boolean> => (await stat(file).catch(() => null)) !== null;

describe("the fake Kubernetes API's process mode (ticket 06)", () => {
  it("F-093: the process mode runs a pod of two containers that talk on loopback, with its secret volume as files, and ends both on delete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ostra-fake-kube-"));
    folders.push(root);
    const lines: string[] = [];
    const { core, fake } = await startFake({ processMode: { root, commands: { node: [process.execPath] }, log: (line) => lines.push(line) } });
    const port = await testPort();
    await core.createNamespacedSecret({ namespace: NAMESPACE, body: { metadata: { name: "box-token" }, stringData: { token: "ostra_tt_process" } } });
    // The sidecar serves the token it reads from its mount; the agent asks it over loopback and writes the answer to the shared folder.
    const sidecar = [
      "const fs = require('node:fs');",
      "const token = fs.readFileSync(process.argv[1] + '/token', 'utf8');",
      "require('node:net').createServer((socket) => socket.end('token=' + token)).listen(Number(process.env.PORT), '127.0.0.1');",
    ].join("\n");
    const agent = [
      "const net = require('node:net');",
      "const ask = () => { const socket = net.connect(Number(process.env.PORT), '127.0.0.1'); let got = '';",
      "  socket.on('data', (d) => { got += d; });",
      "  socket.on('end', () => require('node:fs').writeFileSync(process.env.OUT, got));",
      "  socket.on('error', () => setTimeout(ask, 50)); };",
      "ask(); setInterval(() => {}, 1000);",
    ].join("\n");
    await core.createNamespacedPod({
      namespace: NAMESPACE,
      body: {
        metadata: { name: "talk" },
        spec: {
          restartPolicy: "Never",
          volumes: [
            { name: "token", secret: { secretName: "box-token" } },
            { name: "work", emptyDir: {} },
          ],
          initContainers: [
            {
              name: "sidecar",
              image: "ghcr.io/ostra/runner:1.0.0",
              restartPolicy: "Always",
              command: ["node", "-e", sidecar, "/run/ostra/token"],
              env: [{ name: "PORT", value: String(port) }],
              volumeMounts: [{ name: "token", mountPath: "/run/ostra/token", readOnly: true }],
            },
          ],
          containers: [
            {
              name: "agent",
              image: "ghcr.io/ostra/base:1.0.0",
              command: ["node", "-e", agent],
              env: [
                { name: "PORT", value: String(port) },
                { name: "OUT", value: "/workspace/answer.txt" },
              ],
              volumeMounts: [{ name: "work", mountPath: "/workspace" }],
            },
          ],
        },
      },
    });
    const processes = await waitFor(
      () => fake.processesOf(NAMESPACE, "talk"),
      (value) => value?.containers.every((container) => container.state === "running") ?? false,
    );
    if (processes === undefined) throw new Error("the pod's processes never started");
    const answer = path.join(processes.dir, "volumes", "work", "answer.txt");
    await waitFor(() => exists(answer), Boolean);
    expect(await readFile(answer, "utf8")).toBe("token=ostra_tt_process");
    const running = await core.readNamespacedPod({ name: "talk", namespace: NAMESPACE });
    expect(running.status?.phase).toBe("Running");
    const pids = processes.containers.map((container) => container.pid ?? 0);
    expect(pids.every((pid) => pid > 0)).toBe(true);
    expect(pids.map((pid) => isAlive(pid))).toEqual([true, true]);

    await core.deleteNamespacedPod({ name: "talk", namespace: NAMESPACE });
    await waitFor(() => fake.list("pods", NAMESPACE).length, (count) => count === 0);
    expect(pids.map((pid) => isAlive(pid))).toEqual([false, false]);
    expect(await exists(processes.dir)).toBe(false);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.startsWith(PROCESS_MODE_NOTICE))).toBe(true);
  });
});
