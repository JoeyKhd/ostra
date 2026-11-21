import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { killTree } from "@ostra/adapter-sdk";
import type { AgentLaunch, CreatedBox } from "@ostra/adapter-sdk";
import { defineExecutorContractSuite, fakeBrowserProgram, localWorkspaceFiles, startGitUpstream, trackedPids } from "@ostra/adapter-sdk/testing";
import type { HelperCase } from "@ostra/adapter-sdk/testing";
import { projectIdSchema } from "@ostra/protocol";
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

/** Node, as a check's command line names it: the setup shell reads forward slashes on every OS. */
const node = `'${process.execPath.replaceAll("\\", "/")}'`;

/** Milestone 3 (F-054): the suite's checks, as command lines the setup shell runs. */
const hostCheckCommands = {
  passing: "exit 0",
  failing: "exit 3",
  slow: `${node} -e 'setTimeout(() => {}, 60000)'`,
  printsEnv: `${node} -e 'process.stdout.write(JSON.stringify(process.env))'`,
  noisy: `${node} -e 'console.log("first line"); console.log("x".repeat(20 * 1024)); console.log("the last line")'`,
} as const;

// By birth as well as PID: a stop that takes seconds leaves a killed helper's PID to another process.
const helpers = trackedPids();

/**
 * Milestone 8 (ticket 03): the machine's own browser, live: `OSTRA_RUNNER_BROWSER` when it's set,
 * else Edge on Windows (every Windows machine has it) or Chrome on a Mac. Elsewhere, a Linux CI
 * machine whose browser's sandbox may need what its user lacks, the fake browser over the same pipe.
 * Ticket 11 finds the browser for the runner itself.
 */
const machineBrowser = async (): Promise<{ readonly command: string; readonly args?: readonly string[] }> => {
  const named = process.env["OSTRA_RUNNER_BROWSER"];
  const candidates =
    named !== undefined && named !== ""
      ? [named]
      : process.platform === "win32"
        ? [process.env["ProgramFiles(x86)"], process.env["ProgramFiles"]].flatMap((root) => (root === undefined ? [] : [path.join(root, "Microsoft", "Edge", "Application", "msedge.exe")]))
        : process.platform === "darwin"
          ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
          : [];
  for (const candidate of candidates) {
    const there = await access(candidate).then(
      () => true,
      () => false,
    );
    if (there) return { command: candidate };
  }
  return fakeBrowserProgram();
};

const helperCase = (clearEnv: boolean): HelperCase => ({
  // The agent detaches a helper through go-betweens that all exit, and the helper writes its PID
  // only once its parent is gone, so the box stops only after the helper has fully detached. A stop
  // while a go-between still lived could reach the helper by its parent link, through a snapshot
  // that saw that go-between in the agent's tree, and close the gap on one run in many.
  launch: (box) => nodeLaunch(detachedHelperScript(pidFile(box), { clearEnv }), box),
  readPid: async (box) => {
    try {
      const pid = Number((await readFile(pidFile(box), "utf8")).trim());
      return await helpers.track(pid > 0 ? pid : null);
    } catch {
      return null;
    }
  },
  isAlive: helpers.isAlive,
  kill: async (pid) => {
    if (await helpers.isAlive(pid)) {
      await killTree(pid);
    }
  },
});

defineExecutorContractSuite({
  name: "host, against the git upstream stub",
  create: async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ostra-host-contract-"));
    const upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
    await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n", "notes.txt": "notes\n" });
    const spec = { ...taskSpecFixture, environment: { ...taskSpecFixture.environment, setupScript: "echo ready\n" } };
    const adapter = await HostExecutor.start({ dataDir: path.join(root, "runner"), browser: await machineBrowser() });
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
        // Milestone 3: checks run by the setup shell, and the host cache per project (tickets 15 and 05).
        checks: hostCheckCommands,
        cache: (projectId) => ({
          projectId: projectIdSchema.parse(projectId),
          cacheKey: projectId,
          repos: spec.repos.map((repo) => ({ repoId: repo.repoId, cloneUrl: repo.cloneUrl })),
          proxies: { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" },
        }),
        detachedHelper: helperCase(false),
        cleanEnvHelper: helperCase(true),
        // Milestone 8 (ticket 03): the app's processes, the machine's browser and the loopback, live.
        app: { node: (script) => ({ command: process.execPath, args: ["-e", script], env: windowsEnv() }) },
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
