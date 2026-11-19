import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BoxRef, TaskProxies } from "@ostra/adapter-sdk";
import { startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostExecutor } from "./host-executor.ts";

// Milestone 2's operations on `host` (tickets 22 to 24): a command run beside the agent, and a kept
// box that takes the next session's proxies.

const run = promisify(execFile);

let root = "";
let upstream: GitUpstream;
let executor: HostExecutor;
let proxies: TaskProxies;
let counter = 0;

const newBox = (): BoxRef => {
  counter += 1;
  return { taskId: taskIdSchema.parse(`task-m2-${String(counter)}`), boxId: boxIdSchema.parse(`box-m2-${String(counter)}`) };
};

const specFor = (box: BoxRef): TaskSpec => ({ ...taskSpecFixture, taskId: box.taskId, branchName: `ostra/${box.taskId}-work` });

const ready = async (box: BoxRef, spec: TaskSpec = specFor(box)): Promise<{ readonly workspaceDir: string; readonly agentDir: string }> => {
  const created = await executor.create({ ...box, spec, proxies });
  if (!created.ok) throw new Error(created.error.message);
  const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
  if (!prepared.ok) throw new Error(prepared.error.message);
  return created.value;
};

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-host-m2-"));
  upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n" });
  executor = new HostExecutor({ dataDir: path.join(root, "runner") });
  proxies = { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };
}, 60_000);

afterAll(async () => {
  await upstream.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("an agent command beside the agent", () => {
  it("runs the command with exactly its environment, in its folder, and answers its exit code and output", async () => {
    const box = newBox();
    const dirs = await ready(box);
    const result = await executor.runAgentCommand({
      box,
      command: {
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({ cwd: process.cwd(), marker: process.env.MARKER ?? null, home: process.env.ONLY_MINE ?? null }))"],
        env: { MARKER: "set", ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {}) },
        cwd: dirs.agentDir,
      },
      timeoutMs: 30_000,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.exitCode).toBe(0);
    const seen: unknown = JSON.parse(result.value.stdout);
    expect(seen).toEqual({ cwd: path.resolve(dirs.agentDir), marker: "set", home: null });
    await executor.release(box, "requested");
  }, 60_000);

  it("writes the command's standard output to its stdoutTo file, never through a shell", async () => {
    const box = newBox();
    const dirs = await ready(box);
    const file = path.join(dirs.agentDir, "archive", "export.json");
    const big = "x".repeat(200_000);
    const result = await executor.runAgentCommand({
      box,
      command: { command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({ big: \"x\".repeat(200000) }))"], env: {}, cwd: dirs.agentDir, stdoutTo: file },
      timeoutMs: 30_000,
    });
    expect(result).toEqual({ ok: true, value: { exitCode: 0, stdout: "" } });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ big });
    await executor.release(box, "requested");
  }, 60_000);

  it("ends a command past its time, and answers no-box after a release", async () => {
    const box = newBox();
    const dirs = await ready(box);
    const slow = await executor.runAgentCommand({
      box,
      command: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"], env: {}, cwd: dirs.agentDir },
      timeoutMs: 300,
    });
    if (!slow.ok) throw new Error(slow.error.message);
    expect(slow.value.exitCode).not.toBe(0);
    await executor.release(box, "requested");
    const gone = await executor.runAgentCommand({ box, command: { command: process.execPath, args: ["-e", ""], env: {}, cwd: root }, timeoutMs: 1000 });
    expect(gone.ok ? "ok" : gone.error.code).toBe("not-found");
  }, 60_000);
});

describe("a kept box resumed (ADR 0039, resumed)", () => {
  it("points the checkout's git at the next session's proxy and keeps the workspace", async () => {
    const box = newBox();
    const spec = specFor(box);
    const dirs = await ready(box, spec);
    const checkout = path.join(dirs.workspaceDir, "test1");
    await writeFile(path.join(checkout, "kept.txt"), "still here\n");
    await executor.stop({ box, graceMs: 100 });
    expect(await executor.state(box)).toEqual({ ok: true, value: "stopped" });

    // A second upstream stands for the next session's git proxy, at another address.
    const next = await startGitUpstream(path.join(root, `upstream-next-${String(counter)}`), { requireToken: false });
    try {
      await next.createRepo("ostra-test/test1", { "README.md": "# test1 via the next proxy\n" });
      const resumed = await executor.resumeBox({
        ...box,
        spec: { ...spec, leaseEpoch: spec.leaseEpoch + 1 },
        proxies: { ...proxies, gitBaseUrl: next.origin },
      });
      expect(resumed).toMatchObject({ ok: true, value: { workspaceDir: dirs.workspaceDir, agentDir: dirs.agentDir } });
      expect(await executor.state(box)).toEqual({ ok: true, value: "ready" });
      expect(await readFile(path.join(checkout, "kept.txt"), "utf8")).toBe("still here\n");
      const rules = await run("git", ["config", "--local", "--get-regexp", "^url\\..*\\.insteadof$"], { cwd: checkout });
      expect(rules.stdout).toContain(next.origin);
      expect(rules.stdout).not.toContain(`${upstream.origin}/`);
      // Its git reaches the next proxy: a fetch of the default branch reads the next upstream's README.
      await run("git", ["fetch", "--quiet", "origin", "main"], { cwd: checkout });
      expect((await run("git", ["show", "FETCH_HEAD:README.md"], { cwd: checkout })).stdout).toBe("# test1 via the next proxy\n");
    } finally {
      await next.close();
      await executor.release(box, "requested");
    }
  }, 60_000);

  it("answers not-found for a box it doesn't keep, and conflict while its agent runs", async () => {
    const missing = newBox();
    const answer = await executor.resumeBox({ ...missing, spec: specFor(missing), proxies });
    expect(answer.ok ? "ok" : answer.error.code).toBe("not-found");

    const box = newBox();
    const dirs = await ready(box);
    const started = await executor.startAgent(box, { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: {}, cwd: dirs.workspaceDir, files: [] });
    if (!started.ok) throw new Error(started.error.message);
    const busy = await executor.resumeBox({ ...box, spec: specFor(box), proxies });
    expect(busy.ok ? "ok" : busy.error.code).toBe("conflict");
    await executor.release(box, "requested");
  }, 60_000);
});
