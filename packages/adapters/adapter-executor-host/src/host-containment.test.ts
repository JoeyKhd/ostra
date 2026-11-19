import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isAlive, killTree, silentLogger, systemClock } from "@ostra/adapter-sdk";
import type { AgentLaunch, BoxRef, TaskProxies } from "@ostra/adapter-sdk";
import { recordingLogger, startGitUpstream, trackedPids } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { markedInProc, markedInPs, TASK_UNIT_ENV } from "./containment.ts";
import { HostExecutor } from "./host-executor.ts";
import { daemonProgram, daemonSetupScript, detachedHelperScript } from "./testing/helpers.ts";

// Ticket 42: every process a task starts ends with it, on this machine's containment as the runner
// detects it (a job object on Windows; a cgroup, or the process tree and the marker, elsewhere).

const here = path.dirname(fileURLToPath(import.meta.url));

let root = "";
let upstream: GitUpstream;
let proxies: TaskProxies;
let counter = 0;
/** PIDs a case started, ended after it whatever its outcome, so no test leaves one running. */
const strays: number[] = [];

const newBox = (): BoxRef => {
  counter += 1;
  return { taskId: taskIdSchema.parse(`task-contain-${String(counter)}`), boxId: boxIdSchema.parse(`box-${String(counter)}`) };
};

const specWith = (setupScript: string | null): TaskSpec => ({ ...taskSpecFixture, environment: { ...taskSpecFixture.environment, setupScript } });

const nodeLaunch = (script: string, cwd: string): AgentLaunch => ({
  command: process.execPath,
  args: ["-e", script],
  env: process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {},
  cwd,
  files: [],
});

// By birth as well as PID: a stop takes seconds under load, and Windows hands a dead process's PID
// on within moments, so "is it alive?" by PID alone can answer for another process.
const tracked = trackedPids();

const readPid = async (file: string, timeoutMs = 15_000): Promise<number> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = Number((await readFile(file, "utf8").catch(() => "0")).trim());
    if (pid > 0 || Date.now() >= deadline) {
      await tracked.track(pid > 0 ? pid : null);
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** Whether the process goes within `timeoutMs`. A check of a PID in use lists every process. */
const goneWithin = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await tracked.isAlive(pid))) {
      forget(pid);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (await tracked.isAlive(pid)) {
    return false;
  }
  forget(pid);
  return true;
};

/** A stray seen gone isn't one any more: its PID may be another process's by the time afterEach runs. */
const forget = (pid: number): void => {
  const at = strays.indexOf(pid);
  if (at >= 0) {
    strays.splice(at, 1);
  }
};

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-contain-"));
  upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n" });
  proxies = { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };
}, 60_000);

afterEach(async () => {
  for (const pid of strays.splice(0)) {
    await killTree(pid);
  }
});

afterAll(async () => {
  await upstream.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A box made and prepared on a host executor as the runner starts it. */
const preparedBox = async (executor: HostExecutor, spec: TaskSpec) => {
  const box = newBox();
  const created = await executor.create({ ...box, spec, proxies });
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  return { box, created: created.value, prepared: prepared.value };
};

describe("a host task's processes (ticket 42)", () => {
  it("F-014: a detached grandchild whose parent exited ends when the task stops", async () => {
    const executor = await HostExecutor.start({ dataDir: path.join(root, "runner-detached") });
    const { box, created } = await preparedBox(executor, specWith(null));
    const pidFile = path.join(created.agentDir, "helper.pid");
    const agent = await executor.startAgent(box, nodeLaunch(detachedHelperScript(pidFile), created.workspaceDir));
    expect(agent.ok).toBe(true);
    const helper = await readPid(pidFile);
    strays.push(helper);
    expect(helper).toBeGreaterThan(0);
    if (agent.ok) {
      await agent.value.exited;
    }
    // The agent is gone; its helper isn't, until the task stops.
    expect(isAlive(helper)).toBe(true);
    await executor.stop({ box, graceMs: 200 });
    expect(await goneWithin(helper, 15_000)).toBe(true);
    await executor.release(box);
  }, 60_000);

  it("F-014: a daemon the setup script leaves behind ends with the task", async () => {
    const executor = await HostExecutor.start({ dataDir: path.join(root, "runner-setup") });
    const scripts = path.join(root, "scripts");
    await mkdir(scripts, { recursive: true });
    const pidFile = path.join(scripts, `daemon-${String(counter + 1)}.pid`);
    const daemonFile = path.join(scripts, `daemon-${String(counter + 1)}.js`);
    await writeFile(daemonFile, daemonProgram(pidFile));
    const { box, prepared } = await preparedBox(executor, specWith(daemonSetupScript(process.execPath, daemonFile)));
    expect(prepared.setup?.exitCode).toBe(0);
    const daemon = await readPid(pidFile);
    strays.push(daemon);
    expect(daemon).toBeGreaterThan(0);
    // The setup script ended long ago; its daemon runs on beside the task.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(daemon)).toBe(true);
    await executor.stop({ box, graceMs: 200 });
    expect(await goneWithin(daemon, 15_000)).toBe(true);
    await executor.release(box);
  }, 60_000);

  it("F-014: a runner killed hard leaves no process of its task", async () => {
    const dataDir = path.join(root, "runner-killed");
    const child = spawn(process.execPath, [path.join(here, "testing", "child-runner.ts")], {
      env: { ...process.env, OSTRA_TEST_DATA_DIR: dataDir, OSTRA_TEST_GIT_ORIGIN: upstream.origin },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const first = await lines.next();
    const report = z.strictObject({ helper: z.number().int().positive(), containment: z.string() }).parse(JSON.parse(String(first.value)));
    strays.push(report.helper);
    await tracked.track(report.helper);
    expect(isAlive(report.helper), stderr).toBe(true);
    // As a crash or `kill -9` would: no chance to clean up (TerminateProcess on Windows).
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    if (report.containment === "job-object") {
      // The kernel closed the dead runner's handle, and the job with it.
      expect(await goneWithin(report.helper, 15_000)).toBe(true);
    }
    // Elsewhere the runner's next start ends what its last run left: its cgroups, its markers.
    await HostExecutor.start({ dataDir }, { logger: silentLogger, clock: systemClock });
    expect(await goneWithin(report.helper, 15_000)).toBe(true);
  }, 90_000);

  it("F-014: with koffi faked to fail, the executor falls back to the tree, says why in its log, and reports process-tree", async () => {
    const logger = recordingLogger();
    const executor = await HostExecutor.start({ dataDir: path.join(root, "runner-fallback") }, { logger, clock: systemClock }, {
      platform: "win32",
      importKoffi: () => Promise.reject(new Error("blocked by an application allowlist")),
    });
    expect(executor.capabilities.processContainment).toBe("process-tree");
    const warning = logger.records.find((record) => record.message === "containment.fallback");
    expect(warning?.level).toBe("warn");
    expect(String(warning?.fields["reason"])).toContain("blocked by an application allowlist");
    // It still runs a task, contained by the tree.
    const { box, created } = await preparedBox(executor, specWith(null));
    const agent = await executor.startAgent(box, nodeLaunch("setInterval(() => {}, 1000)", created.workspaceDir));
    expect(agent.ok).toBe(true);
    const pid = agent.ok ? (agent.value.pid ?? 0) : 0;
    await tracked.track(pid);
    await executor.stop({ box, graceMs: 100 });
    expect(await goneWithin(pid, 15_000)).toBe(true);
    await executor.release(box);
  }, 60_000);

  it("F-014: gives the agent and the setup script the task's marker, the same for both", async () => {
    const executor = await HostExecutor.start({ dataDir: path.join(root, "runner-marker") });
    const scripts = path.join(root, "scripts");
    await mkdir(scripts, { recursive: true });
    const setupSeen = path.join(scripts, `setup-marker-${String(counter + 1)}.txt`);
    const { box, created } = await preparedBox(executor, specWith(`printf '%s' "$${TASK_UNIT_ENV}" > "${setupSeen.split("\\").join("/")}"\n`));
    const agentSeen = path.join(created.agentDir, "agent-marker.txt");
    const agent = await executor.startAgent(
      box,
      nodeLaunch(`require('fs').writeFileSync(${JSON.stringify(agentSeen)}, process.env.${TASK_UNIT_ENV} ?? ''); setInterval(() => {}, 1000);`, created.workspaceDir),
    );
    expect(agent.ok).toBe(true);
    const deadline = Date.now() + 10_000;
    let fromAgent = "";
    while (fromAgent === "" && Date.now() < deadline) {
      fromAgent = await readFile(agentSeen, "utf8").catch(() => "");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(fromAgent).toMatch(/^ostra-unit-[0-9a-f]{24}$/);
    expect(await readFile(setupSeen, "utf8")).toBe(fromAgent);
    await executor.stop({ box, graceMs: 100 });
    await executor.release(box);
  }, 60_000);
});

describe.runIf(process.platform === "linux")("a Linux runner without a cgroup of its own", () => {
  it("F-014: on Linux with no cgroup of its own (the probe faked), a helper that left the agent's group is ended by its marker", async () => {
    const executor = await HostExecutor.start({ dataDir: path.join(root, "runner-linux") }, undefined, {
      readSelfCgroup: () => Promise.reject(new Error("no cgroup of its own")),
    });
    expect(executor.capabilities.processContainment).toBe("process-tree");
    const { box, created } = await preparedBox(executor, specWith(null));
    const pidFile = path.join(created.agentDir, "helper.pid");
    const agent = await executor.startAgent(box, nodeLaunch(detachedHelperScript(pidFile), created.workspaceDir));
    expect(agent.ok).toBe(true);
    const helper = await readPid(pidFile);
    strays.push(helper);
    if (agent.ok) {
      await agent.value.exited;
    }
    expect(isAlive(helper)).toBe(true);
    await executor.stop({ box, graceMs: 200 });
    expect(await goneWithin(helper, 15_000)).toBe(true);
    await executor.release(box);
  }, 60_000);
});

describe("the marker sweep's readers", () => {
  it("F-014: finds the processes whose /proc environ holds the marker, and no other", async () => {
    const proc = path.join(root, "fake-proc");
    const marker = "ostra-unit-0123456789abcdef01234567";
    const write = async (pid: string, environ: readonly string[]): Promise<void> => {
      await mkdir(path.join(proc, pid), { recursive: true });
      await writeFile(path.join(proc, pid, "environ"), `${environ.join("\u0000")}\u0000`);
    };
    await write("101", ["PATH=/usr/bin", `${TASK_UNIT_ENV}=${marker}`]);
    await write("102", ["PATH=/usr/bin", `${TASK_UNIT_ENV}=${marker}0`]);
    await write("103", [`NOT_${TASK_UNIT_ENV}=${marker}`]);
    await write("104", []);
    await mkdir(path.join(proc, "self"), { recursive: true });
    expect([...(await markedInProc(proc, marker, null))].sort()).toEqual([101]);
  });

  it("F-014: finds the processes `ps -E` shows with the marker, and no other", () => {
    const marker = "ostra-unit-0123456789abcdef01234567";
    const output = [
      `  201 node -e x PATH=/usr/bin ${TASK_UNIT_ENV}=${marker} HOME=/Users/a`,
      `  202 node -e x ${TASK_UNIT_ENV}=${marker}0`,
      `  203 bash HOME=/Users/a`,
      `  204 echo ${TASK_UNIT_ENV}=${marker}`,
    ].join("\n");
    // 204 carries it as an argument, not in its environment: `ps -E` can't tell them apart, so a
    // command line with the marker counts as marked. It can only be one of the task's own.
    expect(markedInPs(output, marker)).toEqual([201, 204]);
  });
});
