import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAlive, killTree } from "@ostra/adapter-sdk";
import type { AgentLaunch, CreatedBox } from "@ostra/adapter-sdk";
import { defineExecutorContractSuite, localWorkspaceFiles, startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { HelperCase } from "@ostra/adapter-sdk/testing";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { HostExecutor } from "./host-executor.ts";
import { detachedHelperScript } from "./testing/helpers.ts";

// The executor contract suite (ADR 0025, ADR 0029) against the host executor and the git upstream
// stub, with the containment this machine gives (`HostExecutor.start`): a job object on Windows,
// a cgroup on a Linux runner that has one, the process tree and the task's marker elsewhere. A
// helper that clears its environment is the recorded gap of the process tree (ticket 42).

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

const helperCase = (clearEnv: boolean): HelperCase => ({
  // The agent detaches a helper through a go-between, and both exit at once: no parent is left.
  launch: (box) => nodeLaunch(detachedHelperScript(pidFile(box), { exitAtOnce: true, clearEnv }), box),
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
});

defineExecutorContractSuite({
  name: "host, against the git upstream stub",
  create: async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ostra-host-contract-"));
    const upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
    await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n", "notes.txt": "notes\n" });
    const spec = { ...taskSpecFixture, environment: { ...taskSpecFixture.environment, setupScript: "echo ready\n" } };
    const adapter = await HostExecutor.start({ dataDir: path.join(root, "runner") });
    const treeOnly = adapter.capabilities.processContainment === "process-tree";
    return {
      adapter,
      fixture: {
        spec,
        proxies: { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" },
        failingSetupSpec: { ...spec, environment: { ...spec.environment, setupScript: "exit 3\n" } },
        echoLaunch: (box) => nodeLaunch("process.stdin.pipe(process.stdout)", box),
        // Milestone 2 (ticket 22): the hidden ref is saved and restored in the box's first checkout.
        workInProgress: { checkout: (box) => localWorkspaceFiles(path.join(box.workspaceDir, "test1")), trackedFiles: ["README.md", "notes.txt"] },
        detachedHelper: helperCase(false),
        cleanEnvHelper: helperCase(true),
        ...(treeOnly
          ? { knownGaps: { cleanEnvHelper: "the process tree ends a helper that left its group by its marker, and this one cleared its environment" } }
          : {}),
      },
      dispose: async () => {
        await upstream.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      },
    };
  },
});
