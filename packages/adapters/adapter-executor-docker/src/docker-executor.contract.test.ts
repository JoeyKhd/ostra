import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAlive, killTree, silentLogger } from "@ostra/adapter-sdk";
import type { AgentLaunch, CreatedBox } from "@ostra/adapter-sdk";
import { defineExecutorContractSuite, startGitUpstream } from "@ostra/adapter-sdk/testing";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { listenForInit } from "./bridge/bridge-server.ts";
import { DockerExecutor } from "./docker-executor.ts";

// The executor contract suite against `DockerExecutor`, as a box's sidecar drives it: the real
// bridge, and the box's init as a child of this test instead of a container's PID 1 (spike 3's
// loopback rehearsal). The init runs as the developer here, so the agent's user separation isn't
// shown; the live suite on Linux shows it (docker.live.test.ts).

const INIT = fileURLToPath(new URL("./init/main.ts", import.meta.url));

const nodeLaunch = (script: string, box: CreatedBox): AgentLaunch => ({
  command: process.execPath,
  args: ["-e", script],
  env: process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {},
  cwd: box.workspaceDir,
  files: [],
});

const pidFile = (box: CreatedBox): string => path.join(box.agentDir, "helper.pid");

defineExecutorContractSuite({
  name: "docker, through the bridge to a local init",
  create: async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ostra-docker-contract-"));
    const upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
    await upstream.createRepo("ostra-test/test1");
    const boxId = "contract-box";
    const nonce = randomBytes(32).toString("base64url");
    const listener = await listenForInit({ boxId, nonce, host: "127.0.0.1", port: 0, logger: silentLogger });
    const init: ChildProcess = spawn(process.execPath, [INIT], {
      env: { ...process.env, OSTRA_BOX_ID: boxId, OSTRA_BRIDGE_NONCE: nonce, OSTRA_BRIDGE_ADDR: `127.0.0.1:${String(listener.port)}` },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    const bridge = await listener.connected;
    const spec = { ...taskSpecFixture, environment: { ...taskSpecFixture.environment, setupScript: "echo ready\n" } };
    return {
      adapter: new DockerExecutor({ taskRoot: path.join(root, "task"), bridge }),
      fixture: {
        spec,
        proxies: { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" },
        failingSetupSpec: { ...spec, environment: { ...spec.environment, setupScript: "exit 3\n" } },
        echoLaunch: (box) => nodeLaunch("process.stdin.pipe(process.stdout)", box),
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
          readPid: async (box) => {
            try {
              const pid = Number((await readFile(pidFile(box), "utf8")).trim());
              return pid > 0 ? pid : null;
            } catch {
              return null;
            }
          },
          isAlive: (pid) => Promise.resolve(isAlive(pid)),
          kill: (pid) => killTree(pid),
        },
      },
      dispose: async () => {
        bridge.close();
        if (init.pid !== undefined) {
          await killTree(init.pid);
        }
        await upstream.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      },
    };
  },
});
