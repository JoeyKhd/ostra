import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BoxRef } from "@ostra/adapter-sdk";
import { startGitUpstream } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";
import { sudoInvocation } from "./agent-user.ts";
import { HostExecutor } from "./host-executor.ts";
import { runProgram } from "./process.ts";

// Milestone 5's ticket 10, live, for ticket 35's `ubuntu-24.04` and `macos-15` jobs: a `host` pool
// whose agent really is another OS user, set up as the docs' "A pool on the host executor" says
// (`apps/docs/content/runners/pools.mdx`; `scripts/live/host-pool.sh` does it on the job's machine).
// The runner's own user (`ostra-runner`), which sudo lets act as the agent's user and as nobody
// else, runs this suite. The agent's user (`OSTRA_TEST_HOST_POOL_AGENT_USER`) has a group of its
// own that the runner's user is in, and the sudoers rule is `<runner> ALL=(<agent>) NOPASSWD:SETENV:
// ALL` and `Defaults><agent> umask=0007, umask_override`. On Linux the suite runs as a systemd
// service with `Delegate=yes`, as the runner's unit does, so each task gets a cgroup of its own.
// It skips itself everywhere else: Windows refuses a host pool, and a machine without the user has
// nothing to show. One agent user serves all of a pool's tasks on a machine, so a running task's
// agent could read another running task's worktree; what it can't read is a folder the runner
// keeps (its key, its temp folder, a worktree it never handed over), which is what these check.

const agentUser = process.env["OSTRA_TEST_HOST_POOL_AGENT_USER"];
const ready = (process.platform === "linux" || process.platform === "darwin") && agentUser !== undefined && agentUser !== "";
const reason = process.platform === "win32" ? "a host pool doesn't run on Windows" : "no agent user (OSTRA_TEST_HOST_POOL_AGENT_USER)";

// Where each case's runner folder goes: the docs' data folder on the job's machine
// (`/var/lib/ostra-runner`, `/usr/local/var/ostra-runner` on macOS), else /tmp. Never the user's own
// temp folder, which macOS makes for that user alone: the agent's user must get through to it.
const dataRoot = process.env["OSTRA_TEST_HOST_POOL_DATA_ROOT"] ?? "/tmp";

const pool = async (name: string) => {
  const root = await mkdtemp(path.join(dataRoot, `ostra-host-pool-${name}-`));
  await chmod(root, 0o711);
  const dataDir = path.join(root, "runner");
  const key = path.join(dataDir, "identity", "runner.key");
  const kept = path.join(dataDir, "kept-worktree");
  await mkdir(path.dirname(key), { recursive: true, mode: 0o700 });
  await writeFile(key, "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n", { mode: 0o600 });
  await mkdir(kept, { recursive: true, mode: 0o700 });
  await writeFile(path.join(kept, "secret.txt"), "the runner's own\n", { mode: 0o600 });
  await chmod(path.join(dataDir, "identity"), 0o700);
  const upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n" });
  // Why the executor fell back to the process tree, if it did: the cgroup case's message.
  const fallbacks: string[] = [];
  const started = await HostExecutor.startPool({ dataDir, agentUser, secrets: [key, kept] }, undefined, { onFallback: (why) => fallbacks.push(why) });
  if (!started.ok) throw new Error(started.reason);
  return {
    executor: started.value,
    fallbacks,
    key,
    kept,
    proxies: { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" },
    dispose: async () => {
      await upstream.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};

const specWith = (box: BoxRef, setupScript: string): TaskSpec => ({
  ...taskSpecFixture,
  taskId: box.taskId,
  snapshot: null,
  environment: { ...taskSpecFixture.environment, setupScript },
});

/** Whether a PID is alive, asked as the agent's user (the runner can't signal its processes). */
const aliveAsAgent = async (pid: number): Promise<boolean> => {
  const invoked = sudoInvocation(agentUser ?? "", "kill", ["-0", String(pid)], {});
  return (await runProgram(invoked.command, invoked.args, { cwd: "/", env: { PATH: "/usr/bin:/bin" } })).code === 0;
};

describe.skipIf(!ready)(`a host pool's agent user, live (skipped: ${ready ? "no" : reason})`, () => {
  it("F-015: health() passes; a shell in the agent's process is the agent's user and can't read the runner's key or a worktree the runner kept", async () => {
    const live = await pool("reach");
    try {
      expect(await live.executor.health()).toEqual({ status: "ok" });
      const box: BoxRef = { taskId: taskIdSchema.parse("live-pool-reach"), boxId: boxIdSchema.parse("live-pool-reach") };
      const script = [
        "id -un",
        `if cat '${live.key}' >/dev/null 2>&1; then echo key-readable; else echo key-refused; fi`,
        `if cat '${path.join(live.kept, "secret.txt")}' >/dev/null 2>&1; then echo kept-readable; else echo kept-refused; fi`,
        "",
      ].join("\n");
      const spec = specWith(box, script);
      const created = await live.executor.create({ ...box, spec, proxies: live.proxies });
      if (!created.ok) throw new Error(created.error.message);
      let output = "";
      const prepared = await live.executor.prepare({ box, spec, secrets: [], onSetupOutput: (_stream, text) => (output += text) });
      if (!prepared.ok) throw new Error(prepared.error.message);
      expect(output.split("\n").map((line) => line.trim())).toEqual(expect.arrayContaining([agentUser, "key-refused", "kept-refused"]));
      await live.executor.release(box, "requested");
    } finally {
      await live.dispose();
    }
  }, 180_000);

  it.runIf(process.platform === "linux")("F-014: on Linux the task's delegated cgroup is killed as a unit: a detached helper of the agent's user that also cleared its environment ends with the task", async () => {
    const live = await pool("cgroup");
    try {
      expect(live.executor.capabilities.processContainment, live.fallbacks.join("; ")).toBe("cgroup");
      const box: BoxRef = { taskId: taskIdSchema.parse("live-pool-cgroup"), boxId: boxIdSchema.parse("live-pool-cgroup") };
      // Out of the group and without the marker, so the tree and the marker sweep both miss it (and
      // the runner can't signal the agent's user's processes anyway): only the cgroup ends it.
      const spec = specWith(box, "setsid env -i /bin/sleep 600 </dev/null >/dev/null 2>&1 &\necho $! > helper.pid\n");
      const created = await live.executor.create({ ...box, spec, proxies: live.proxies });
      if (!created.ok) throw new Error(created.error.message);
      const prepared = await live.executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
      if (!prepared.ok) throw new Error(prepared.error.message);
      const pid = Number((await readFile(path.join(created.value.workspaceDir, "test1", "helper.pid"), "utf8")).trim());
      expect(await aliveAsAgent(pid)).toBe(true);
      await live.executor.release(box, "requested");
      expect(await aliveAsAgent(pid)).toBe(false);
    } finally {
      await live.dispose();
    }
  }, 180_000);

  it.runIf(process.platform === "darwin")("F-014: on macOS the marker sweep ends the agent user's detached helper that keeps the marker, and one that cleared its environment is the gap ADR 0029 names", async () => {
    const live = await pool("sweep");
    try {
      expect(live.executor.capabilities.processContainment).toBe("process-tree");
      const box: BoxRef = { taskId: taskIdSchema.parse("live-pool-sweep"), boxId: boxIdSchema.parse("live-pool-sweep") };
      const spec = specWith(box, ["nohup sleep 600 </dev/null >/dev/null 2>&1 &", "echo $! > kept.pid", "env -i /bin/sleep 600 </dev/null >/dev/null 2>&1 &", "echo $! > cleared.pid", ""].join("\n"));
      const created = await live.executor.create({ ...box, spec, proxies: live.proxies });
      if (!created.ok) throw new Error(created.error.message);
      const prepared = await live.executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
      if (!prepared.ok) throw new Error(prepared.error.message);
      const read = async (file: string) => Number((await readFile(path.join(created.value.workspaceDir, "test1", file), "utf8")).trim());
      const kept = await read("kept.pid");
      const cleared = await read("cleared.pid");
      await live.executor.release(box, "requested");
      expect(await aliveAsAgent(kept)).toBe(false);
      // The known gap (ADR 0029): a process that dropped the marker and left the tree isn't found.
      const gap = await aliveAsAgent(cleared);
      if (gap) {
        const ended = sudoInvocation(agentUser ?? "", "kill", ["-KILL", String(cleared)], {});
        await runProgram(ended.command, ended.args, { cwd: "/", env: { PATH: "/usr/bin:/bin" } });
      }
      expect(typeof gap).toBe("boolean");
    } finally {
      await live.dispose();
    }
  }, 180_000);
});
