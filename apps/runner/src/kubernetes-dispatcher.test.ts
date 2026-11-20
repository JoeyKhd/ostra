import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boxNames, boxSelector, KubernetesExecutor } from "@ostra/adapter-executor-kubernetes";
import type { KubernetesExecutorOptions } from "@ostra/adapter-executor-kubernetes";
import { startFakeCluster } from "@ostra/adapter-executor-kubernetes/testing";
import type { FakeCluster } from "@ostra/adapter-executor-kubernetes/testing";
import { silentLogger } from "@ostra/adapter-sdk";
import { boxIdSchema, runnerIdSchema } from "@ostra/protocol";
import type { CommandKind, CommandOf, TaskEvent } from "@ostra/protocol";
import { taskCredentialsFixture, taskSpecFixture } from "@ostra/protocol/testing";
import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exitCodes, runCli } from "./cli/cli.ts";
import { createCapturingTerminal } from "./cli/terminal.ts";
import { runSignedInRunner } from "./run-runner.ts";
import { createKubernetesDispatcher } from "./kubernetes-dispatcher.ts";
import type { KubernetesDispatcher } from "./kubernetes-dispatcher.ts";
import { makeCommand, startFakeGateway } from "./testing/fake-gateway.ts";
import type { FakeGateway } from "./testing/fake-gateway.ts";
import { startFakeServer } from "./testing/fake-server.ts";
import type { FakeServer } from "./testing/fake-server.ts";

// Milestone 5's ticket 20 (F-093, F-015): the runner's side of the `kubernetes` executor, against
// ticket 06's fake Kubernetes API, which `@kubernetes/client-node` talks to unmodified. The offer
// is accepted before the pod is scheduled; the node wait goes up as runner events; in the fake
// cluster's process mode the box's sidecar is the real `ostra sidecar`, which connects on the task
// token from its mounted file and stays connected while the runner restarts and adopts its pod;
// nothing of a box is left after its release.

const NS = "ostra-boxes";
const TASK_TOKEN = "ostra_tt_kubernetes-dispatcher-task-token-7f3a";
const RUNNER_MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const INIT = fileURLToPath(new URL("../../../packages/adapters/adapter-executor-docker/src/init/main.ts", import.meta.url));

let root = "";
const clusters: FakeCluster[] = [];
const dispatchers: KubernetesDispatcher[] = [];
let server: FakeServer | undefined;
let gateway: FakeGateway | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-k8s-dispatcher-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dispatcher of dispatchers.splice(0)) dispatcher.detach();
  server?.holdSpecs.clear();
  await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
  await gateway?.close();
  await server?.close();
  gateway = undefined;
  server = undefined;
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const until = async (check: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`waited too long for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A command of `kind`, as the gateway sends it. */
const commandOf = <K extends CommandKind>(kind: K, seq: number, body: unknown): CommandOf<K> => {
  const command = makeCommand({ seq, id: `${kind}-${String(seq)}`, notAfter: Date.now() + 120_000, kind, body });
  const isKind = (value: typeof command): value is CommandOf<K> => value.kind === kind;
  if (!isKind(command)) throw new Error(`not a ${kind}`);
  return command;
};

const spec = taskSpecFixture;
const boxId = boxIdSchema.parse("box-k8s-dispatch");
const dispatch = (): CommandOf<"dispatch"> => commandOf("dispatch", 1, { taskId: spec.taskId, sessionId: spec.sessionId, boxId, leaseEpoch: spec.leaseEpoch });
const release = (seq: number): CommandOf<"release"> => commandOf("release", seq, { taskId: spec.taskId, boxId, reason: "prs-closed" });
const box = { taskId: spec.taskId, boxId };

type Setup = { readonly cluster: FakeCluster; readonly events: TaskEvent[]; readonly make: (options?: Partial<KubernetesExecutorOptions>) => KubernetesDispatcher };

const setup = async (processMode: boolean, serverUrl = "https://ostra.example"): Promise<Setup> => {
  const cluster = await startFakeCluster({
    namespaces: [NS],
    ...(processMode
      ? {
          processMode: {
            root: path.join(root, "pods"),
            // The runner image's `ostra` is this checkout's CLI: the box's sidecar is the real one.
            commands: { ostra: [process.execPath, RUNNER_MAIN] },
            log: () => undefined,
          },
        }
      : {}),
  });
  clusters.push(cluster);
  const events: TaskEvent[] = [];
  const make = (options: Partial<KubernetesExecutorOptions> = {}): KubernetesDispatcher => {
    const executor = new KubernetesExecutor(
      { kube: cluster.kube, namespace: NS, images: { runner: "ghcr.io/ostra/runner:test", base: "ghcr.io/ostra/base:test" }, serverUrl, pollMs: 20, initCommand: [process.execPath, INIT], ...options },
      { logger: silentLogger, clock: { now: () => Date.now() } },
    );
    const dispatcher = createKubernetesDispatcher({
      executor,
      kube: cluster.kube,
      namespace: NS,
      link: { fetchSpec: () => Promise.resolve({ ok: true, value: spec }), statusChanged: () => undefined },
      taskToken: () => Promise.resolve({ ok: true, value: TASK_TOKEN }),
      dataDir: path.join(root, "runner"),
      labels: [],
      logger: silentLogger,
      reportRunnerEvent: (event) => events.push(event),
      watchMs: 50,
    });
    dispatchers.push(dispatcher);
    return dispatcher;
  };
  return { cluster, events, make };
};

/** What's left of the box in the namespace, by its label. */
const leftOf = async (cluster: FakeCluster): Promise<number> => {
  const pods = await cluster.kube.listPods(NS, boxSelector(box));
  const secrets = await cluster.kube.listSecretNames(NS, boxSelector(box));
  if (!pods.ok || !secrets.ok) throw new Error("the fake API didn't answer");
  return pods.value.length + secrets.value.length;
};

/** Every file under a folder, as text. */
const filesUnder = async (dir: string): Promise<readonly string[]> => {
  const out: string[] = [];
  for (const name of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (name.isFile()) out.push(await readFile(path.join(name.parentPath, name.name), "utf8"));
  }
  return out;
};

describe("kubernetes boxes from the runner (ticket 20)", () => {
  it("F-093: the runner accepts a dispatch at once, before its pod is scheduled: a pod held unschedulable for three minutes doesn't time the offer out", async () => {
    const { cluster, make } = await setup(false);
    const dispatcher = make();
    cluster.fake.holdUnschedulable(180_000);
    const answer = await Promise.race([
      dispatcher.handlers.dispatch(dispatch()),
      new Promise<"no answer">((resolve) => {
        setTimeout(() => {
          resolve("no answer");
        }, 5_000);
      }),
    ]);
    expect(answer).toEqual({ result: "accepted" });
    // Then the box: its pod made, and not scheduled.
    await until(async () => {
      const pod = await cluster.kube.readPod(NS, boxNames(box).pod);
      return pod.ok && pod.value?.scheduled?.status === "False";
    }, "the unscheduled pod");
    expect(dispatcher.status()).toMatchObject({ executor: "kubernetes", running: [spec.sessionId] });
    // A release while it waits ends the wait: nothing of the box is left.
    expect(await dispatcher.handlers.release(release(2))).toEqual({ result: "done" });
    await Promise.all(dispatcher.boxes());
    expect(await leftOf(cluster)).toBe(0);
  }, 30_000);

  it("F-093, F-015: box.waiting while the pod waits for a node, box.scheduled once it's placed, as runner events; and nothing of the box is left once its task ends", async () => {
    const { cluster, events, make } = await setup(false);
    const dispatcher = make();
    cluster.fake.holdUnschedulable(1_500);
    expect(await dispatcher.handlers.dispatch(dispatch())).toEqual({ result: "accepted" });
    await until(() => events.some((event) => event.kind === "box.scheduled"), "box.scheduled");
    expect(events.map((event) => event.kind)).toEqual(["box.waiting", "box.scheduled"]);
    expect(events[0]).toMatchObject({ kind: "box.waiting", boxId, reason: "node" });
    const scheduled = events[1];
    expect(scheduled?.kind === "box.scheduled" ? scheduled.afterMs : 0).toBeGreaterThanOrEqual(1_400);
    // The record of the box holds its IDs only: never the task token.
    expect((await filesUnder(path.join(root, "runner"))).some((text) => text.includes(TASK_TOKEN))).toBe(false);
    // The sidecar ends: the task is over, and the runner releases the box.
    await until(async () => {
      const pod = await cluster.kube.readPod(NS, boxNames(box).pod);
      return pod.ok && pod.value?.ready === true;
    }, "the ready pod");
    cluster.fake.exitContainer(NS, boxNames(box).pod, "sidecar", 0);
    await Promise.all(dispatcher.boxes());
    expect(await leftOf(cluster)).toBe(0);
    expect(await readdir(path.join(root, "runner", "kubernetes-boxes"))).toEqual([]);
    expect(dispatcher.status().running).toEqual([]);
  }, 30_000);

  it("F-015, F-093: the box's sidecar connects on the task token from its mounted file, and stays connected while the runner restarts and adopts its pod", async () => {
    server = await startFakeServer();
    const fakeGateway = startFakeGateway(server);
    gateway = fakeGateway;
    // Core's half: the task token is the sidecar's access, and the spec waits, so the task stays running.
    server.accessTokens.set(TASK_TOKEN, runnerIdSchema.parse("runner-k8s"));
    server.tasks.set(spec.taskId, { spec, credentials: taskCredentialsFixture });
    server.holdSpecs.add(spec.taskId);
    const { cluster, make } = await setup(true, server.url);
    const first = make();
    expect(await first.handlers.dispatch(dispatch())).toEqual({ result: "accepted" });
    await until(() => fakeGateway.hellos.some((hello) => hello.peer.kind === "sidecar" && hello.peer.boxId === boxId), "the sidecar's hello", 60_000);
    const pod = boxNames(box).pod;
    const processes = cluster.fake.processesOf(NS, pod);
    expect(processes?.containers.find((container) => container.name === "sidecar")?.state).toBe("running");
    // The token reached the sidecar's mount only.
    expect(await readFile(path.join(processes?.dir ?? "", "volumes", "token", "token"), "utf8")).toBe(TASK_TOKEN);
    expect((await filesUnder(path.join(root, "runner"))).some((text) => text.includes(TASK_TOKEN))).toBe(false);
    const connections = fakeGateway.connections();

    // The runner restarts: its pod stays, and the new one adopts it.
    first.detach();
    const second = make();
    expect(await second.adopt()).toBe(1);
    expect(second.status().running).toEqual([spec.sessionId]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fakeGateway.connections()).toBe(connections);
    expect(cluster.fake.processesOf(NS, pod)?.containers.find((container) => container.name === "sidecar")?.state).toBe("running");

    // Released: the pod and its secrets go, and nothing of the box is left.
    expect(await second.handlers.release(release(2))).toEqual({ result: "done" });
    await Promise.all(second.boxes());
    expect(await leftOf(cluster)).toBe(0);
    expect(await readdir(path.join(root, "runner", "kubernetes-boxes"))).toEqual([]);

  }, 120_000);
  it("F-093, F-092: ostra runner --executor kubernetes checks its cluster, joins, and reports a pod per box: 20 slots, the registry required and the node wait", async () => {
    server = await startFakeServer({ joinTokens: ["ostra_jt_kubernetes"] });
    const fakeGateway = startFakeGateway(server);
    gateway = fakeGateway;
    const { cluster } = await setup(false);
    const kubeconfig = path.join(root, "kubeconfig");
    await writeFile(kubeconfig, cluster.kubeconfig);
    vi.stubEnv("KUBECONFIG", kubeconfig);
    const controller = new AbortController();
    const terminal = createCapturingTerminal();
    const running = runCli(["runner", "--server", server.url, "--join-token", "ostra_jt_kubernetes", "--executor", "kubernetes", "--k8s-namespace", NS, "--data-dir", path.join(root, "runner"), "--name", "cluster-1"], {
      env: {},
      terminal,
      signal: controller.signal,
      install: "image",
      runSignedIn: runSignedInRunner,
      runSidecar: () => Promise.resolve(exitCodes.usage),
    });
    await until(() => fakeGateway.connected(), "the runner's connection");
    expect(fakeGateway.hellos[0]).toMatchObject({
      executor: "kubernetes",
      install: "image",
      capabilities: { isolation: "container", services: true, boxSizes: true, snapshots: "image", registry: "required", nodeWait: true },
    });
    expect(fakeGateway.statuses[0]).toMatchObject({ executor: "kubernetes", capacity: 20, freeSlots: 20, processContainment: "container" });
    controller.abort();
    expect(await running).toBe(exitCodes.ok);
  }, 60_000);

  it("F-093: ostra runner --executor kubernetes refuses to start on a cluster older than 1.29", async () => {
    server = await startFakeServer({ joinTokens: ["ostra_jt_kubernetes"] });
    const cluster = await startFakeCluster({ namespaces: [NS], minor: 28 });
    clusters.push(cluster);
    const kubeconfig = path.join(root, "kubeconfig");
    await writeFile(kubeconfig, cluster.kubeconfig);
    vi.stubEnv("KUBECONFIG", kubeconfig);
    const terminal = createCapturingTerminal();
    const code = await runCli(["runner", "--server", server.url, "--join-token", "ostra_jt_kubernetes", "--executor", "kubernetes", "--k8s-namespace", NS, "--data-dir", path.join(root, "runner")], {
      env: {},
      terminal,
      signal: new AbortController().signal,
      install: "image",
      runSignedIn: runSignedInRunner,
      runSidecar: () => Promise.resolve(exitCodes.usage),
    });
    expect(code).toBe(exitCodes.failed);
    expect(terminal.lines().join("")).toContain("1.29 or later");
  }, 60_000);
});
