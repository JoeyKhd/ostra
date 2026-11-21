import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DockerExecutor, listenForInit } from "@ostra/adapter-executor-docker";
import { defaultAdapterContext, killTree, silentLogger } from "@ostra/adapter-sdk";
import type { AgentLaunch, BoxImage, BoxSize, CreatedBox } from "@ostra/adapter-sdk";
import { defineExecutorContractSuite, FAKE_BROWSER_MAIN, localWorkspaceFiles, startGitUpstream, trackedPids } from "@ostra/adapter-sdk/testing";
import { taskSpecFixture } from "@ostra/protocol/testing";

import { KubernetesExecutor } from "./kubernetes-executor.ts";
import { boxNames, LABELS } from "./pod.ts";
import { cpuMillisOf, memoryMiBOf } from "./quantity.ts";
import { startFakeCluster } from "./testing/cluster.ts";
import { arrayOf, namesWithLabel, podSurface, recordOf, SIDECAR_TOKEN_MOUNT } from "./testing/surface.ts";

// The executor contract suite against `KubernetesExecutor` (ticket 07), on ticket 06's fake cluster
// in its process mode: each box is a pod whose containers run as local processes. The executor makes
// and deletes the pod and its secrets through `@kubernetes/client-node`, as a pool runner does; the
// test plays the pod's sidecar (`inBox`): it listens for the box's init on the pod's loopback with
// the nonce from the box's secret, and drives the agent's container through that bridge with the
// executor logic a `docker` box's sidecar runs. The pod's init is the real one (the base image's
// `/opt/ostra/init/main.ts`), started by the fake kubelet from the pod's own spec and secret.
//
// The process mode isolates nothing and limits nothing: the limits are read back from the pod's
// spec, as the kubelet would apply them, and the cgroups that hold them are ticket 35's live run.

const NS = "ostra-boxes";
// Milestone 8: the real init, with the fake box browser in place of the image's Chromium.
const INIT = fileURLToPath(new URL("../../adapter-executor-docker/src/testing/init-with-fake-browser.ts", import.meta.url));

const nodeLaunch = (script: string, box: CreatedBox): AgentLaunch => ({
  command: process.execPath,
  args: ["-e", script],
  env: process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {},
  cwd: box.workspaceDir,
  files: [],
});

const pidFile = (box: CreatedBox): string => path.join(box.agentDir, "helper.pid");
const helperPid = async (box: CreatedBox): Promise<number | null> => {
  try {
    const pid = Number((await readFile(pidFile(box), "utf8")).trim());
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
};
const node = `'${process.execPath.replaceAll("\\", "/")}'`;
const helpers = trackedPids();

const helperScript = (box: CreatedBox, cleanEnv: boolean): string =>
  [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    cleanEnv ? "const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};" : "const env = process.env;",
    "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env });",
    "helper.unref();",
    `fs.writeFileSync(${JSON.stringify(pidFile(box))}, String(helper.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");

defineExecutorContractSuite({
  name: "kubernetes, a pod on the fake cluster's process mode, with the test as its sidecar",
  create: async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ostra-k8s-contract-"));
    const upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
    await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n", "notes.txt": "notes\n" });
    const cluster = await startFakeCluster({
      namespaces: [NS],
      processMode: {
        root: path.join(root, "pods"),
        // The runner image's sidecar is this test, so its container only idles.
        commands: { ostra: [process.execPath, "-e", "setInterval(() => {}, 1000)"] },
        log: () => undefined,
      },
    });
    const bridges = new Set<() => void>();
    const executor = new KubernetesExecutor(
      {
        kube: cluster.kube,
        namespace: NS,
        images: { runner: "ghcr.io/ostra/runner:test", base: "ghcr.io/ostra/base:test" },
        serverUrl: "https://ostra.example",
        pollMs: 20,
        initCommand: [process.execPath, INIT, FAKE_BROWSER_MAIN],
        inBox: {
          listen: async (box, nonce) => {
            const listener = await listenForInit({ boxId: box.boxId, nonce, host: "127.0.0.1", port: 0, logger: silentLogger });
            const executorFor = listener.connected.then((bridge) => {
              bridges.add(() => {
                bridge.close();
              });
              // Milestone 8: in a pod the sidecar reaches the app at the shared localhost, with no forwarder.
              return new DockerExecutor({ taskRoot: path.join(root, "sidecars", box.boxId), bridge, appReach: "loopback" }, defaultAdapterContext);
            });
            return {
              port: listener.port,
              executor: executorFor,
              close: () => {
                void listener.close();
              },
            };
          },
        },
      },
      defaultAdapterContext,
    );
    const spec = { ...taskSpecFixture, environment: { ...taskSpecFixture.environment, setupScript: "echo ready\n" } };
    const image: BoxImage = { ref: "127.0.0.1:5000/ostra/snapshots/contract", digest: `sha256:${"b".repeat(64)}`, pull: { username: "contract-puller", token: "contract-pull-token-5a8e" } };
    return {
      adapter: executor,
      fixture: {
        spec,
        proxies: { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" },
        failingSetupSpec: { ...spec, environment: { ...spec.environment, setupScript: "exit 3\n" } },
        echoLaunch: (box) => nodeLaunch("process.stdin.pipe(process.stdout)", box),
        workInProgress: { checkout: (box) => localWorkspaceFiles(path.join(box.workspaceDir, "test1")), trackedFiles: ["README.md", "notes.txt"] },
        // Milestone 8 (ticket 03): the app's processes and the browser through the pod's init, the app at the pod's localhost.
        app: { node: (script) => ({ command: process.execPath, args: ["-e", script], env: process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {} }) },
        checks: {
          passing: "exit 0",
          failing: "exit 3",
          slow: `${node} -e 'setTimeout(() => {}, 60000)'`,
          printsEnv: `${node} -e 'process.stdout.write(JSON.stringify(process.env))'`,
          noisy: `${node} -e 'console.log("first line"); console.log("x".repeat(20 * 1024)); console.log("the last line")'`,
        },
        detachedHelper: {
          launch: (box) => nodeLaunch(helperScript(box, false), box),
          readPid: async (box) => helpers.track(await helperPid(box)),
          isAlive: helpers.isAlive,
          kill: async (pid) => {
            if (await helpers.isAlive(pid)) await killTree(pid);
          },
        },
        cleanEnvHelper: {
          launch: (box) => nodeLaunch(helperScript(box, true), box),
          readPid: async (box) => helpers.track(await helperPid(box)),
          isAlive: helpers.isAlive,
          kill: async (pid) => {
            if (await helpers.isAlive(pid)) await killTree(pid);
          },
        },
        fleet: {
          limitsOf: (box) => {
            const pod = cluster.fake.get("pods", NS, boxNames(box).pod);
            const agent = arrayOf(recordOf(pod?.["spec"])["containers"]).find((container) => container["name"] === "agent");
            const limits = recordOf(recordOf(agent?.["resources"])["limits"]);
            const cpu = typeof limits["cpu"] === "string" ? cpuMillisOf(limits["cpu"]) : null;
            const memory = typeof limits["memory"] === "string" ? memoryMiBOf(limits["memory"]) : null;
            const size: BoxSize | null = cpu === null || memory === null ? null : { cpuMillis: cpu, memoryMiB: memory };
            return Promise.resolve(size);
          },
          image,
          pulls: () =>
            Promise.resolve(
              cluster.fake.pulls().map((pull) => ({ ref: pull.image, digest: pull.image.includes("@") ? (pull.image.split("@")[1] ?? "") : "", username: pull.username })),
            ),
          surface: (box) => {
            const pod = cluster.fake.get("pods", NS, boxNames(box).pod);
            return Promise.resolve(pod === undefined ? [] : podSurface(cluster.fake, NS, pod).filter((place) => place.where !== SIDECAR_TOKEN_MOUNT));
          },
          tokenAtSidecar: async (box) => {
            const pod = cluster.fake.processesOf(NS, boxNames(box).pod);
            if (pod === undefined) return null;
            try {
              return await readFile(path.join(pod.dir, "volumes", "token", "token"), "utf8");
            } catch {
              return null;
            }
          },
          holdNextBox: (ms) => {
            cluster.fake.holdUnschedulable(ms);
          },
          objectsOf: (box) =>
            Promise.resolve([
              ...namesWithLabel(cluster.fake, "pods", NS, LABELS.box, box.boxId),
              ...namesWithLabel(cluster.fake, "secrets", NS, LABELS.box, box.boxId),
            ]),
        },
      },
      dispose: async () => {
        for (const close of bridges) close();
        await cluster.close();
        await upstream.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      },
    };
  },
});
