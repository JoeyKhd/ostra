import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killTree, silentLogger } from "@ostra/adapter-sdk";
import type { AgentLaunch, BoxImage, BoxRef, CreatedBox } from "@ostra/adapter-sdk";
import { defineExecutorContractSuite, FAKE_BROWSER_MAIN, localWorkspaceFiles, startGitUpstream, trackedPids } from "@ostra/adapter-sdk/testing";
import type { FleetFixture } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, leaseEpochSchema, sessionIdSchema } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { listenForInit } from "./bridge/bridge-server.ts";
import { BRIDGE_FEATURES } from "./bridge/protocol.ts";
import { createDockerBoxes } from "./boxes.ts";
import { DockerExecutor } from "./docker-executor.ts";
import { createEngine } from "./engine.ts";
import { startFakeEngine } from "./testing/fake-engine.ts";
import type { FakeEngine } from "./testing/fake-engine.ts";

// The executor contract suite against `DockerExecutor`, as a box's sidecar drives it: the real
// bridge, and the box's init as a child of this test instead of a container's PID 1 (spike 3's
// loopback rehearsal). The init runs as the developer here, so the agent's user separation isn't
// shown; the live suite on Linux shows it (docker.live.test.ts).
//
// Milestone 5 (ticket 09): the pool runner's half too, on the fake Engine API, so every box the
// suite makes also gets its containers, its size as limits, its registry image pulled by digest
// and its token folder; the fleet fixture reads them back through `docker inspect`'s answers.

/** Every file under a folder, as text, leaving out one folder (the sidecar's token mount). */
const filesUnder = async (root: string, leaveOut: string | null): Promise<{ readonly where: string; readonly text: string }[]> => {
  const found: { where: string; text: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (leaveOut !== null && path.resolve(full) === path.resolve(leaveOut)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        found.push({ where: `the file ${path.relative(root, full)}`, text: await readFile(full, "latin1").catch(() => "") });
      }
    }
  };
  await walk(root);
  return found;
};

/** The sidecar's token mount on the Engine: the bind's source folder, or `null`. */
const sidecarTokenDir = (engine: FakeEngine, box: BoxRef): string | null => {
  const sidecar = [...engine.containers.values()].find((container) => container.name === `ostra-box-${box.boxId}-sidecar`);
  const mounts: unknown = Reflect.get(Object(sidecar?.body["HostConfig"]), "Mounts");
  const list: readonly unknown[] = Array.isArray(mounts) ? mounts : [];
  const bind = list.find((mount) => Reflect.get(Object(mount), "Target") === "/run/ostra");
  const source: unknown = Reflect.get(Object(bind), "Source");
  return typeof source === "string" ? source : null;
};

// Milestone 8: the real init, with the fake box browser in place of the image's Chromium.
const INIT = fileURLToPath(new URL("./testing/init-with-fake-browser.ts", import.meta.url));

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

/** Node, as a check's command line names it: the setup shell reads forward slashes on every OS. */
const node = `'${process.execPath.replaceAll("\\", "/")}'`;

// By birth as well as PID: a stop that takes seconds leaves a killed helper's PID to another process.
const helpers = trackedPids();

defineExecutorContractSuite({
  name: "docker, the pool runner's half on the fake Engine and the sidecar's through the bridge to a local init",
  create: async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ostra-docker-contract-"));
    const upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
    await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n", "notes.txt": "notes\n" });
    const boxId = boxIdSchema.parse("contract-box");
    const nonce = randomBytes(32).toString("base64url");
    const listener = await listenForInit({ boxId, nonce, host: "127.0.0.1", port: 0, logger: silentLogger });
    const init: ChildProcess = spawn(process.execPath, [INIT, FAKE_BROWSER_MAIN], {
      env: {
        ...process.env,
        OSTRA_BOX_ID: boxId,
        OSTRA_BRIDGE_NONCE: nonce,
        OSTRA_BRIDGE_ADDR: `127.0.0.1:${String(listener.port)}`,
        // Milestone 8: as the pool runner sets it (`boxes.ts`).
        OSTRA_BRIDGE_FEATURES: BRIDGE_FEATURES.join(","),
      },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    const bridge = await listener.connected;
    const spec = { ...taskSpecFixture, environment: { ...taskSpecFixture.environment, setupScript: "echo ready\n" } };
    const engine = await startFakeEngine();
    const tokenRoot = path.join(root, "runner", "boxes");
    const boxes = createDockerBoxes(createEngine(engine.address), { images: { base: "ghcr.io/ostra/base:0.0.0", runner: "ghcr.io/ostra/runner:0.0.0" } });
    const image: BoxImage = {
      ref: "registry.ostra-test.invalid/ostra/contract-project",
      digest: `sha256:${"c".repeat(64)}`,
      pull: { username: "ostra-pull", token: "ostra_pull_cred_5e1d0c9b7a" },
    };
    const fleet: FleetFixture = {
      limitsOf: async (box) => {
        const agent = (await boxes.limitsOf(box.boxId)).find((each) => each.role === "agent");
        return agent === undefined || agent.cpuMillis === null || agent.memoryMiB === null ? null : { cpuMillis: agent.cpuMillis, memoryMiB: agent.memoryMiB };
      },
      image,
      pulls: () => Promise.resolve(engine.pulls.map((pull) => ({ ref: pull.ref, digest: pull.ref.slice(pull.ref.indexOf("@") + 1), username: pull.username }))),
      surface: async (box) => [
        // Each container as the Engine holds it: its environment, command, labels and host config.
        ...[...engine.containers.values()]
          .filter((container) => container.name.startsWith(`ostra-box-${box.boxId}-`))
          .map((container) => ({ where: `the container ${container.name}`, text: JSON.stringify(container.body) })),
        // The runner's data folder and the box's task volume, the sidecar's token folder left out.
        ...(await filesUnder(root, sidecarTokenDir(engine, box))),
      ],
      tokenAtSidecar: async (box) => {
        const dir = sidecarTokenDir(engine, box);
        return dir === null ? null : await readFile(path.join(dir, "token"), "utf8").catch(() => null);
      },
      objectsOf: async (box) => {
        const prefix = `ostra-box-${box.boxId}`;
        const tokenDir = path.join(tokenRoot, box.boxId);
        return [
          ...[...engine.containers.values()].filter((container) => container.name.startsWith(`${prefix}-`)).map((container) => `container ${container.name}`),
          ...[...engine.networks.keys()].filter((name) => name === prefix).map((name) => `network ${name}`),
          ...[...engine.volumes.keys()].filter((name) => name.startsWith(prefix)).map((name) => `volume ${name}`),
          ...((await stat(tokenDir).then(() => true, () => false)) ? [`folder ${tokenDir}`] : []),
        ];
      },
    };
    return {
      adapter: new DockerExecutor({
        taskRoot: path.join(root, "task"),
        bridge,
        pool: {
          boxes,
          tokenRoot,
          // This machine can't hand a file to another uid: the runner's own group reads the folder.
          tokenOwner: { kind: "group", gid: 0 },
          boxInput: () => ({ sessionId: sessionIdSchema.parse("contract-session"), leaseEpoch: leaseEpochSchema.parse(1), serverUrl: "http://127.0.0.1:9", baseImage: null }),
          capacity: { reserveCpuMillis: 1000, reserveMemoryMiB: 2048 },
        },
      }),
      fixture: {
        fleet,
        spec,
        proxies: { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" },
        failingSetupSpec: { ...spec, environment: { ...spec.environment, setupScript: "exit 3\n" } },
        echoLaunch: (box) => nodeLaunch("process.stdin.pipe(process.stdout)", box),
        // Milestone 2 (ticket 22): the hidden ref is saved and restored in the box's first checkout.
        workInProgress: { checkout: (box) => localWorkspaceFiles(path.join(box.workspaceDir, "test1")), trackedFiles: ["README.md", "notes.txt"] },
        // Milestone 8 (ticket 03): the app's processes, the browser and the forwarder, through the real init.
        app: { node: (script) => ({ command: process.execPath, args: ["-e", script], env: process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {} }) },
        // Milestone 3 (ticket 14): the checks run in the agent's container through the bridge.
        checks: {
          passing: "exit 0",
          failing: "exit 3",
          slow: `${node} -e 'setTimeout(() => {}, 60000)'`,
          printsEnv: `${node} -e 'process.stdout.write(JSON.stringify(process.env))'`,
          noisy: `${node} -e 'console.log("first line"); console.log("x".repeat(20 * 1024)); console.log("the last line")'`,
        },
        detachedHelper: {
          launch: (box) =>
            nodeLaunch(
              [
                "const { spawn } = require('node:child_process');",
                "const fs = require('node:fs');",
                "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
                "helper.unref();",
                `fs.writeFileSync(${JSON.stringify(pidFile(box))}, String(helper.pid));`,
                "setInterval(() => {}, 1000);",
              ].join("\n"),
              box,
            ),
          readPid: async (box) => helpers.track(await helperPid(box)),
          isAlive: helpers.isAlive,
          kill: async (pid) => {
            if (await helpers.isAlive(pid)) {
              await killTree(pid);
            }
          },
        },
        // Ticket 42: a helper with an empty environment. A box's container holds it whatever it
        // carries; here the stand-in init finds it among its descendants, so the agent stays.
        cleanEnvHelper: {
          launch: (box) =>
            nodeLaunch(
              [
                "const { spawn } = require('node:child_process');",
                "const fs = require('node:fs');",
                "const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};",
                "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env });",
                "helper.unref();",
                `fs.writeFileSync(${JSON.stringify(pidFile(box))}, String(helper.pid));`,
                "setInterval(() => {}, 1000);",
              ].join("\n"),
              box,
            ),
          readPid: async (box) => helpers.track(await helperPid(box)),
          isAlive: helpers.isAlive,
          kill: async (pid) => {
            if (await helpers.isAlive(pid)) {
              await killTree(pid);
            }
          },
        },
      },
      dispose: async () => {
        bridge.close();
        await engine.close();
        // Only while it runs: an exited init's PID may be another process's by now.
        if (init.pid !== undefined && init.exitCode === null && init.signalCode === null) {
          await killTree(init.pid);
        }
        await upstream.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      },
    };
  },
});
