import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boxNames, boxSelector, buildEgressPolicy, KubernetesExecutor } from "@ostra/adapter-executor-kubernetes";
import type { KubernetesExecutorOptions } from "@ostra/adapter-executor-kubernetes";
import { startFakeCluster } from "@ostra/adapter-executor-kubernetes/testing";
import type { FakeCluster } from "@ostra/adapter-executor-kubernetes/testing";
import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { startFakeOciRegistry } from "@ostra/adapter-sdk/testing/net";
import type { FakeOciRegistry } from "@ostra/adapter-sdk/testing/net";
import { boxIdSchema, imageDigestSchema, projectIdSchema, repoIdSchema, runnerIdSchema, sha256HexSchema, snapshotCredentialsSchema, snapshotIdSchema } from "@ostra/protocol";
import type { CommandKind, CommandOf, TaskEvent } from "@ostra/protocol";
import { taskCredentialsFixture, taskSpecFixture } from "@ostra/protocol/testing";
import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exitCodes, runCli } from "./cli/cli.ts";
import { createCapturingTerminal } from "./cli/terminal.ts";
import { runSignedInRunner } from "./run-runner.ts";
import { createKubernetesDispatcher } from "./kubernetes-dispatcher.ts";
import type { KubernetesDispatcher, KubernetesDispatcherOptions } from "./kubernetes-dispatcher.ts";
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
const BUILD_MAIN = fileURLToPath(new URL("../../../packages/adapters/adapter-executor-kubernetes/src/build-main.ts", import.meta.url));
const FAKE_BUILDKIT = fileURLToPath(new URL("../../../packages/adapters/adapter-executor-kubernetes/src/testing/fake-buildkit.ts", import.meta.url));
const INIT = fileURLToPath(new URL("../../../packages/adapters/adapter-executor-docker/src/init/main.ts", import.meta.url));

let root = "";
const clusters: FakeCluster[] = [];
const dispatchers: KubernetesDispatcher[] = [];
let server: FakeServer | undefined;
let gateway: FakeGateway | undefined;
const upstreams: GitUpstream[] = [];
const registries: FakeOciRegistry[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-k8s-dispatcher-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dispatcher of dispatchers.splice(0)) dispatcher.detach();
  server?.holdSpecs.clear();
  await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
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

const setup = async (processMode: boolean, serverUrl = "https://ostra.example", extra: Partial<KubernetesDispatcherOptions> = {}, commands: Readonly<Record<string, readonly string[]>> = { ostra: [process.execPath, RUNNER_MAIN] }): Promise<Setup> => {
  const cluster = await startFakeCluster({
    namespaces: [NS],
    ...(processMode
      ? {
          processMode: {
            root: path.join(root, "pods"),
            // The runner image's `ostra` is this checkout's CLI: the box's sidecar is the real one.
            commands,
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
      ...extra,
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
  it("F-093/c3: the runner accepts a dispatch at once, before its pod is scheduled: a pod held unschedulable for three minutes doesn't time the offer out", async () => {
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

  it("F-141/c6: a dispatch to start the app hands its purpose to the pod's sidecar, which starts the task itself, and tells it its box is a pod", async () => {
    const { cluster, make } = await setup(false);
    const dispatcher = make();
    const plain = dispatch();
    expect(await dispatcher.handlers.dispatch({ ...plain, body: { ...plain.body, purpose: "app" } })).toEqual({ result: "accepted" });
    await until(async () => {
      const pod = await cluster.kube.readPod(NS, boxNames(box).pod);
      return pod.ok && pod.value !== null;
    }, "the box's pod");
    const pod = JSON.stringify(cluster.fake.get("pods", NS, boxNames(box).pod));
    expect(pod).toContain(`{"name":"OSTRA_DISPATCH_PURPOSE","value":"app"}`);
    expect(pod).toContain(`{"name":"OSTRA_BOX_EXECUTOR","value":"kubernetes"}`);
    expect(await dispatcher.handlers.release(release(2))).toEqual({ result: "done" });
    await Promise.all(dispatcher.boxes());
  }, 30_000);

  it("F-093/c3, F-015/c2: box.waiting while the pod waits for a node, box.scheduled once it's placed, as runner events; and nothing of the box is left once its task ends", async () => {
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

  describe("a pod lost under its task (F-047)", () => {
    /**
     * A dispatcher whose log says when its box runs, and a box of its own: once the dispatcher saw
     * its sidecar ready, as it watches a running task's pod. A pod that ends before then is the
     * dispatch's to fail, not a task's to lose. Answers the pod's name.
     */
    const lostBench = async () => {
      const records: LogRecord[] = [];
      const bench = await setup(false, "https://ostra.example", { logger: createLogger((record) => records.push(record)) });
      const lost = (): TaskEvent[] => bench.events.filter((event) => event.kind === "box.lost");
      const runningBox = async (on: KubernetesDispatcher, id: string): Promise<string> => {
        expect(await on.handlers.dispatch(commandOf("dispatch", 1, { taskId: spec.taskId, sessionId: spec.sessionId, boxId: boxIdSchema.parse(id), leaseEpoch: spec.leaseEpoch }))).toEqual({ result: "accepted" });
        await until(() => records.some((record) => record.message === "the box's sidecar is ready" && record.fields["boxId"] === id), `the running box ${id}`);
        return boxNames({ taskId: spec.taskId, boxId: boxIdSchema.parse(id) }).pod;
      };
      return { ...bench, lost, runningBox };
    };

    it("F-047/c1: a pod whose sidecar is killed mid-task is reported lost with its exit code; one whose sidecar ends its task reports nothing", async () => {
      const { cluster, make, lost, runningBox } = await lostBench();
      const dispatcher = make();
      cluster.fake.exitContainer(NS, await runningBox(dispatcher, "box-k8s-ends"), "sidecar", 0);
      await Promise.all(dispatcher.boxes());
      expect(lost()).toEqual([]);
      cluster.fake.exitContainer(NS, await runningBox(dispatcher, "box-k8s-killed"), "sidecar", 137);
      await Promise.all(dispatcher.boxes());
      expect(lost()).toEqual([{ kind: "box.lost", boxId: "box-k8s-killed", exitCode: 137 }]);
      expect(await readdir(path.join(root, "runner", "kubernetes-boxes"))).toEqual([]);
    }, 60_000);

    it("F-047/c1: a pod deleted under its task by someone else (a drained node, a person's kubectl) is reported lost with no exit code; a release reports nothing", async () => {
      const { cluster, make, lost, runningBox } = await lostBench();
      const dispatcher = make();
      expect((await cluster.kube.deletePod(NS, await runningBox(dispatcher, "box-k8s-deleted"), 0)).ok).toBe(true);
      await Promise.all(dispatcher.boxes());
      expect(lost()).toEqual([{ kind: "box.lost", boxId: "box-k8s-deleted", exitCode: null }]);
      // A release ends a box with nothing lost: core asked for it.
      await runningBox(dispatcher, "box-k8s-released");
      expect(await dispatcher.handlers.release(commandOf("release", 2, { taskId: spec.taskId, boxId: boxIdSchema.parse("box-k8s-released"), reason: "prs-closed" }))).toEqual({ result: "done" });
      await Promise.all(dispatcher.boxes());
      expect(lost()).toHaveLength(1);
    }, 60_000);

    it("F-047/c1: a pod whose sidecar fails while its runner is away is reported lost by the next start, as it adopts its boxes", async () => {
      const { cluster, make, lost, runningBox } = await lostBench();
      const first = make();
      const away = await runningBox(first, "box-k8s-away");
      first.detach();
      cluster.fake.exitContainer(NS, away, "sidecar", 1);
      const next = make();
      expect(await next.adopt()).toBe(0);
      await Promise.all(next.boxes());
      expect(lost()).toEqual([{ kind: "box.lost", boxId: "box-k8s-away", exitCode: 1 }]);
      expect(await readdir(path.join(root, "runner", "kubernetes-boxes"))).toEqual([]);
    }, 60_000);
  });

  it("F-015/c3,c4, F-093: the box's sidecar connects on the task token from its mounted file, and stays connected while the runner restarts and adopts its pod", async () => {
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
  it("F-093/c5, F-092: ostra runner --executor kubernetes checks its cluster, joins, and reports a pod per box: 20 slots, the registry required and the node wait", async () => {
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

  it("F-093/c5: ostra runner --executor kubernetes refuses to start on a cluster older than 1.29", async () => {
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

describe("registry images and snapshot pushes on kubernetes (ticket 21)", () => {
  const PULL = { registry: "registry.ostra-test.invalid", username: "ostra-puller", token: "ostra_pull_cred_k8s_5e4d3c2b1a09", expiresAt: Date.now() + 600_000 };
  const imageRef = "registry.ostra-test.invalid/ostra/snapshots/project-a";
  const digest = imageDigestSchema.parse(`sha256:${"c".repeat(64)}`);
  const dispatchImage = (id: string) =>
    commandOf("dispatch", 1, { taskId: spec.taskId, sessionId: spec.sessionId, boxId: boxIdSchema.parse(id), leaseEpoch: spec.leaseEpoch, box: { size: null, image: { ref: imageRef, digest } } });

  it("F-120/c2: on kubernetes a box's image is pulled by digest with the lease's pull credential, which goes into the box's pull secret only; with the cluster's own identity there is none", async () => {
    const answers: (typeof PULL | null)[] = [PULL, null];
    const asked: string[] = [];
    const { cluster, make } = await setup(false, "https://ostra.example", {
      pullCredential: (taskId, leaseEpoch) => {
        asked.push(`${taskId}@${String(leaseEpoch)}`);
        return Promise.resolve({ ok: true, value: answers.shift() ?? null });
      },
    });
    const dispatcher = make();
    const ids = ["box-pull-secret", "box-node-identity"];
    // One at a time, so the credentials' order is the boxes'.
    expect(await dispatcher.handlers.dispatch(dispatchImage(ids[0] ?? ""))).toEqual({ result: "accepted" });
    const names = ids.map((id) => boxNames({ taskId: spec.taskId, boxId: boxIdSchema.parse(id) }));
    await until(() => cluster.fake.get("pods", NS, names[0]?.pod ?? "") !== undefined, "the first pod");
    expect(await dispatcher.handlers.dispatch(dispatchImage(ids[1] ?? ""))).toEqual({ result: "accepted" });
    await until(() => cluster.fake.get("pods", NS, names[1]?.pod ?? "") !== undefined, "the second pod");
    expect(asked).toEqual([`${spec.taskId}@${String(spec.leaseEpoch)}`, `${spec.taskId}@${String(spec.leaseEpoch)}`]);
    const [withSecret, withNode] = names;
    if (withSecret === undefined || withNode === undefined) throw new Error("no names");
    const podOf = (name: string): string => JSON.stringify(cluster.fake.get("pods", NS, name));
    // The image by digest, the credential in the pull secret alone: not in the pod, not on the runner.
    expect(podOf(withSecret.pod)).toContain(`${imageRef}@${digest}`);
    expect(podOf(withSecret.pod)).toContain(withSecret.pullSecret);
    expect(podOf(withSecret.pod)).not.toContain(PULL.token);
    const secret = JSON.stringify(cluster.fake.get("secrets", NS, withSecret.pullSecret));
    expect(Buffer.from(/"\.dockerconfigjson":"([^"]+)"/.exec(secret)?.[1] ?? "", "base64").toString("utf8")).toContain(PULL.token);
    expect((await filesUnder(path.join(root, "runner"))).some((text) => text.includes(PULL.token))).toBe(false);
    // The cluster's own identity: no pull secret, and the pod names none.
    expect(cluster.fake.get("secrets", NS, withNode.pullSecret)).toBeUndefined();
    expect(podOf(withNode.pod)).not.toContain("imagePullSecrets");
    for (const [index, id] of ids.entries()) {
      await dispatcher.handlers.release(commandOf("release", 10 + index, { taskId: spec.taskId, boxId: boxIdSchema.parse(id), reason: "prs-closed" }));
    }
    await Promise.all(dispatcher.boxes());
    expect(cluster.fake.list("secrets", NS).filter((item) => JSON.stringify(item).includes("ostra-box-"))).toEqual([]);
  }, 60_000);

  it("F-120/c4: a snapshot build on kubernetes fetches its credentials and its push credential, builds with BuildKit, scans, pushes, and reports the registry's digest", async () => {
    const upstream = await startGitUpstream(path.join(root, "upstream"));
    upstreams.push(upstream);
    await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n" });
    const GIT_TOKEN = "ghs_k8sRunnerBuildToken0123456789abcdef";
    upstream.tokens.set(GIT_TOKEN, Date.now() + 3_600_000);
    const registry = await startFakeOciRegistry();
    registries.push(registry);
    const snapshotId = snapshotIdSchema.parse("snap-k8s-runner");
    const projectId = projectIdSchema.parse("project-a");
    const repoId = repoIdSchema.parse("repo-web");
    const pushRef = `${registry.host}/ostra/snapshots/${projectId}:${snapshotId}`;
    const asked: string[] = [];
    const { cluster, events, make } = await setup(
      true,
      "https://ostra.example",
      {
        snapshotCredentials: (id) => {
          asked.push(`credentials:${id}`);
          return Promise.resolve({ ok: true, value: snapshotCredentialsSchema.parse({ snapshotId: id, repos: [{ repoId, gitToken: GIT_TOKEN, expiresAt: Date.now() + 3_600_000 }], secrets: [] }) });
        },
        pushCredential: (id) => {
          asked.push(`push:${id}`);
          return Promise.resolve({ ok: true, value: { registry: registry.host, username: registry.push.username, token: registry.push.password, expiresAt: Date.now() + 600_000 } });
        },
      },
      { ostra: [process.execPath, BUILD_MAIN], "buildctl-daemonless.sh": [process.execPath, FAKE_BUILDKIT] },
    );
    await cluster.createNamespace(`${NS}-builds`);
    await cluster.applyPolicy(`${NS}-builds`, buildEgressPolicy({ namespace: `${NS}-builds`, registry: { addresses: ["127.0.0.1"], port: 443 }, packageHosts: [], codeHosts: ["140.82.112.0/20"] }));
    const dispatcher = make();
    const command = commandOf("snapshot-build", 3, {
      snapshotId,
      projectId,
      environment: {
        baseImage: "node:24-bookworm",
        setupScript: "npm ci\n",
        repos: [{ repoId, fullName: "ostra-test/test1", cloneUrl: "https://github.com/ostra-test/test1.git", defaultBranch: "main", checkoutDir: "test1", variables: [], files: [], envFile: ".env", setupSecrets: { variables: [], files: [] } }],
        inputsHash: sha256HexSchema.parse("b".repeat(64)),
      },
      push: { ref: pushRef },
      builder: "buildkit",
    });
    // The git upstream is local: the build clones it, as a cluster's build clones the code host.
    const local = { ...command, body: { ...command.body, environment: { ...command.body.environment, repos: command.body.environment.repos.map((repo) => ({ ...repo, cloneUrl: upstream.cloneUrl("ostra-test/test1") })) } } };
    expect(await dispatcher.handlers["snapshot-build"](local)).toEqual({ result: "accepted" });
    await dispatcher.builds();
    expect(asked).toEqual([`credentials:${snapshotId}`, `push:${snapshotId}`]);
    const held = registry.manifest(`ostra/snapshots/${projectId}`, snapshotId);
    expect(held).toBeDefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "snapshot.built", snapshotId, imageDigest: held?.digest });
    expect(new Set(registry.requests().filter((request) => request.action === "push").map((request) => request.user))).toEqual(new Set([registry.push.username]));
  }, 120_000);
});
