import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAlive, killTree } from "@ostra/adapter-sdk";
import type { AgentLaunch, CreatedBox } from "@ostra/adapter-sdk";
import { defineExecutorContractSuite, startGitUpstream } from "@ostra/adapter-sdk/testing";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { HostExecutor } from "./host-executor.ts";

// The executor contract suite (ADR 0025, ADR 0029) against the host executor and the git upstream
// stub. On Windows the detached-helper case is a known gap: without a job object (Q126), a
// process that detached itself between two tree snapshots outlives the task's stop.

const windowsEnv = (): Record<string, string> =>
  process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {};

const nodeLaunch = (script: string, box: CreatedBox): AgentLaunch => ({
  command: process.execPath,
  args: ["-e", script],
  env: windowsEnv(),
  cwd: box.workspaceDir,
  files: [],
});

const pidFile = (box: CreatedBox): string => path.join(box.agentDir, "helper.pid");

defineExecutorContractSuite({
  name: "host, against the git upstream stub",
  create: async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ostra-host-contract-"));
    const upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
    await upstream.createRepo("ostra-test/test1");
    const spec = { ...taskSpecFixture, environment: { ...taskSpecFixture.environment, setupScript: "echo ready\n" } };
    const adapter = new HostExecutor({ dataDir: path.join(root, "runner") });
    return {
      adapter,
      fixture: {
        spec,
        proxies: { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" },
        failingSetupSpec: { ...spec, environment: { ...spec.environment, setupScript: "exit 3\n" } },
        echoLaunch: (box) => nodeLaunch("process.stdin.pipe(process.stdout)", box),
        detachedHelper: {
          // The agent starts a helper detached from it, writes the helper's PID, and keeps running.
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
        await upstream.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      },
    };
  },
});
