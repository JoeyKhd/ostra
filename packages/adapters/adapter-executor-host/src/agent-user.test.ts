import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BoxRef, TaskProxies } from "@ostra/adapter-sdk";
import { startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, checkIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentUserMarkerSweep,
  checkAgentUser,
  HOST_POOL_NO_USER_REASON,
  HOST_POOL_SAME_USER_PRODUCTION_REASON,
  HOST_POOL_WINDOWS_REASON,
  hostPoolAgentUser,
  SAME_USER_DEVELOPMENT,
  sudoInvocation,
} from "./agent-user.ts";
import type { RunCommand, SudoProgram } from "./agent-user.ts";
import { TASK_UNIT_ENV } from "./containment.ts";
import { HostExecutor } from "./host-executor.ts";

// Milestone 5's ticket 10 (F-015, F-014): a `host` pool runs its agent as a separate OS user. The
// real executor, on this machine, with `sudo` replaced by a stand-in that checks and logs each call
// and runs the command as this user (`testing/fake-sudo.ts`): this machine has no second user, and
// Windows no sudo. The user really being another one (a shell that can't read the runner's key or
// another task's worktree, the cgroup killed as a unit) is `host-executor.live.test.ts`, run by
// ticket 35's Linux and macOS jobs.

const FAKE_SUDO = fileURLToPath(new URL("./testing/fake-sudo.ts", import.meta.url));
const AGENT = "ostra-agent";

type Logged = { readonly user: string; readonly preserve: readonly string[]; readonly command: string; readonly args: readonly string[] };

let root = "";
let upstream: GitUpstream;
let proxies: TaskProxies;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-agent-user-"));
  upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n" });
  proxies = { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };
}, 60_000);

afterAll(async () => {
  await upstream.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 60_000);

const readLog = async (file: string): Promise<readonly Logged[]> =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): Logged => {
      const value: unknown = JSON.parse(line);
      const field = (name: string): unknown => Reflect.get(Object(value), name);
      const list = (name: string): readonly string[] => {
        const found = field(name);
        return Array.isArray(found) ? found.map(String) : [];
      };
      return { user: String(field("user")), preserve: list("preserve"), command: String(field("command")), args: list("args") };
    });

describe("a host pool's agent user (F-015)", () => {
  it("F-015: every process of a pool's task runs through sudo -n -u <agent user> --, as an argument array: the git of its worktree, its setup script, its checks and the agent", async () => {
    const log = path.join(root, "sudo-calls.log");
    const sudo: SudoProgram = { command: process.execPath, args: [FAKE_SUDO, log] };
    const handedOver: string[] = [];
    const executor = await HostExecutor.start({
      dataDir: path.join(root, "pool-runner"),
      agentUser: {
        user: { kind: "separate", user: AGENT },
        sudo,
        handOver: (dir) => {
          handedOver.push(dir);
          return Promise.resolve();
        },
      },
    });
    const box: BoxRef = { taskId: taskIdSchema.parse("task-pool-1"), boxId: boxIdSchema.parse("box-pool-1") };
    const spec: TaskSpec = {
      ...taskSpecFixture,
      taskId: box.taskId,
      snapshot: null,
      environment: { ...taskSpecFixture.environment, setupScript: "echo setup-ran > setup-marker.txt\n" },
      checks: [{ checkId: checkIdSchema.parse("lint"), name: "lint", command: "echo check-ran", repoId: null, timeoutSeconds: 30 }],
    };
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) throw new Error(created.error.message);
    // The task's folder, made by the runner, handed over before anything of the task runs.
    expect(handedOver).toEqual([path.join(root, "pool-runner", "tasks", box.taskId)]);
    const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.setup?.exitCode).toBe(0);
    const checked = await executor.runChecks(box, { spec, changedRepoIds: [], env: { CHECK_VAR: "set" }, outputDir: path.join(root, "checks") });
    if (!checked.ok) throw new Error(checked.error.message);
    expect(checked.value.map((result) => result.status)).toEqual(["passed"]);
    const agent = await executor.startAgent(box, {
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      env: { OSTRA_FAKE_KEY: "ostra-fake-key-value", ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {}) },
      cwd: created.value.workspaceDir,
      files: [],
    });
    if (!agent.ok) throw new Error(agent.error.message);
    await executor.stop({ box, graceMs: 2_000 });
    await executor.release(box, "requested");

    const calls = await readLog(log);
    // Every call is as the agent's user, and nothing ran outside sudo that the log would miss: the
    // setup's marker and the check's output came through these calls.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.user === AGENT)).toBe(true);
    const git = calls.filter((call) => path.basename(call.command).replace(/\.exe$/i, "") === "git");
    expect(git.some((call) => call.args.includes("clone"))).toBe(true);
    const setup = calls.filter((call) => call.args.some((arg) => arg.endsWith("setup/setup.sh")));
    expect(setup).toHaveLength(1);
    expect(calls.some((call) => call.args.join(" ") === "-c echo check-ran")).toBe(true);
    const agentCall = calls.find((call) => call.command === process.execPath && call.args[1] === "process.stdin.pipe(process.stdout)");
    expect(agentCall?.args).toEqual(["-e", "process.stdin.pipe(process.stdout)"]);
    // The agent's variables are passed by name only: their values are in no argument.
    expect(agentCall?.preserve).toContain("OSTRA_FAKE_KEY");
    expect(calls.some((call) => call.args.some((arg) => arg.includes("ostra-fake-key-value")))).toBe(false);
    // What the agent's user made is removed as that user at release.
    expect(calls.some((call) => call.command === "rm" && call.args[0] === "-rf" && call.args[1] === "--")).toBe(true);
  }, 120_000);

  it("F-015: the sudo call is the command and its arguments as they are, each one argument, and the environment by name only", () => {
    const invoked = sudoInvocation(AGENT, "/usr/bin/git", ["commit", "-m", "a message; rm -rf /"], { PATH: "/usr/bin", OSTRA_TASK_UNIT: "ostra-unit-1", "BAD NAME": "x" });
    expect(invoked).toEqual({
      command: "/usr/bin/sudo",
      args: ["-n", "-u", AGENT, "--preserve-env=OSTRA_TASK_UNIT,PATH", "--", "/usr/bin/git", "commit", "-m", "a message; rm -rf /"],
    });
    expect(sudoInvocation(AGENT, "true", [], {})).toEqual({ command: "/usr/bin/sudo", args: ["-n", "-u", AGENT, "--", "true"] });
  });

  it("F-015: health() checks sudo works for the agent's user and no other, and that the user can't read the runner's key", async () => {
    const answers = (codes: (command: string, user: string, args: readonly string[]) => number): RunCommand => (command, args) => {
      const user = args[2] ?? "";
      const at = args.indexOf("--");
      return Promise.resolve({ code: codes(args[at + 1] ?? command, user, args.slice(at + 2)), stdout: "", stderr: "" });
    };
    const key = "/var/lib/ostra-runner/identity/runner.key";
    const good = answers((command, user) => (command === "true" && user === AGENT ? 0 : 1));
    expect(await checkAgentUser(AGENT, [key], { run: good, cwd: "/" })).toEqual({ ok: true });
    const noRule = answers(() => 1);
    const reasonOf = (checked: Awaited<ReturnType<typeof checkAgentUser>>): string => (checked.ok ? "" : checked.reason);
    expect(reasonOf(await checkAgentUser(AGENT, [key], { run: noRule, cwd: "/" }))).toContain("sudoers rule");
    const anyone = answers((command) => (command === "true" ? 0 : 1));
    expect(reasonOf(await checkAgentUser(AGENT, [key], { run: anyone, cwd: "/" }))).toContain("root");
    const readsKey = answers((command, user) => (user === AGENT ? 0 : 1));
    expect(reasonOf(await checkAgentUser(AGENT, [key], { run: readsKey, cwd: "/" }))).toContain("runner.key");
  });
});

describe("where a host pool starts (F-014, F-015)", () => {
  const settings = { agentUser: AGENT, env: {}, platform: "linux" as const, runnerUser: "ostra-runner" };

  it("F-015, F-014: a host pool runner on Windows refuses to start, with the reason", async () => {
    expect(hostPoolAgentUser({ ...settings, platform: "win32" })).toEqual({ ok: false, reason: HOST_POOL_WINDOWS_REASON });
    expect(HOST_POOL_WINDOWS_REASON).toBe("A host pool runs the agent as a separate OS user, which this release supports on Linux and macOS");
    const started = await HostExecutor.startPool({ dataDir: path.join(root, "windows-pool"), agentUser: AGENT, platform: "win32", env: { PATH: process.env["PATH"] ?? "" } });
    expect(started).toEqual({ ok: false, reason: HOST_POOL_WINDOWS_REASON });
  });

  it("F-015: a host pool runner without its agent user refuses to start, with the fix", async () => {
    expect(hostPoolAgentUser({ ...settings, agentUser: undefined })).toEqual({ ok: false, reason: HOST_POOL_NO_USER_REASON });
    expect(HOST_POOL_NO_USER_REASON).toContain("OSTRA_HOST_POOL_AGENT_USER");
    const started = await HostExecutor.startPool({ dataDir: path.join(root, "no-user-pool"), agentUser: undefined, platform: "linux", env: { PATH: process.env["PATH"] ?? "" } });
    expect(started).toEqual({ ok: false, reason: HOST_POOL_NO_USER_REASON });
    // Nor a name sudo could read as a flag, nor the runner's own user.
    expect(hostPoolAgentUser({ ...settings, agentUser: "-u" })).toMatchObject({ ok: false });
    expect(hostPoolAgentUser({ ...settings, agentUser: "ostra-runner" })).toMatchObject({ ok: false });
    expect(hostPoolAgentUser(settings)).toEqual({ ok: true, value: { kind: "separate", user: AGENT } });
  });

  it("F-015, F-014: the development switch is refused when NODE_ENV is production, and otherwise runs the pool as the runner's own user, which health() reports", async () => {
    expect(hostPoolAgentUser({ ...settings, env: { OSTRA_DEV_HOST_POOL_SAME_USER: "true", NODE_ENV: "production" } })).toEqual({ ok: false, reason: HOST_POOL_SAME_USER_PRODUCTION_REASON });
    const refused = await HostExecutor.startPool({
      dataDir: path.join(root, "production-pool"),
      agentUser: undefined,
      env: { ...process.env, OSTRA_DEV_HOST_POOL_SAME_USER: "true", NODE_ENV: "production" },
    });
    expect(refused).toEqual({ ok: false, reason: HOST_POOL_SAME_USER_PRODUCTION_REASON });
    // In development or a test, on any system: the runner's own user, said so.
    expect(hostPoolAgentUser({ ...settings, platform: "win32", env: { OSTRA_DEV_HOST_POOL_SAME_USER: "true", NODE_ENV: "development" } })).toEqual({
      ok: true,
      value: { kind: "same-user-development" },
    });
    const started = await HostExecutor.startPool({
      dataDir: path.join(root, "dev-pool"),
      agentUser: undefined,
      env: { ...process.env, OSTRA_DEV_HOST_POOL_SAME_USER: "true", NODE_ENV: "test" },
    });
    if (!started.ok) throw new Error(started.reason);
    expect(started.value.agentUser).toEqual({ kind: "same-user-development" });
    expect(await started.value.health()).toEqual({ status: "degraded", reason: SAME_USER_DEVELOPMENT });
  }, 60_000);
});

describe("containment with the agent's user (F-014)", () => {
  const marker = "ostra-unit-0123456789abcdef01234567";
  const recording = (listing: (round: number) => string) => {
    const calls: { command: string; args: readonly string[] }[] = [];
    let lists = 0;
    const run: RunCommand = (command, args) => {
      calls.push({ command, args });
      const at = args.indexOf("--");
      const program = args[at + 1];
      if (program === "kill") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      lists += 1;
      return Promise.resolve({ code: 0, stdout: listing(lists), stderr: "" });
    };
    return { calls, run };
  };

  it("F-014: on macOS the marker sweep lists the agent user's processes and ends them, both as that user", async () => {
    const { calls, run } = recording((round) =>
      round === 1 ? `  101 /usr/bin/node agent.js ${TASK_UNIT_ENV}=${marker} HOME=/x\n  102 /bin/sh other ${TASK_UNIT_ENV}=ostra-unit-other\n` : "",
    );
    const ended = await agentUserMarkerSweep(AGENT, { platform: "darwin", run })(marker);
    expect(ended).toBe(1);
    expect(calls.map((call) => call.args)).toEqual([
      ["-n", "-u", AGENT, "--", "ps", "-wwE", "-U", AGENT, "-o", "pid=,command="],
      ["-n", "-u", AGENT, "--", "kill", "-KILL", "101"],
      ["-n", "-u", AGENT, "--", "ps", "-wwE", "-U", AGENT, "-o", "pid=,command="],
    ]);
    expect(calls.every((call) => call.command === "/usr/bin/sudo")).toBe(true);
  });

  it("F-014: on Linux without a cgroup the sweep reads the agent user's /proc as that user, and ends what carries the marker", async () => {
    const { calls, run } = recording((round) => (round === 1 ? "201\n202\n" : ""));
    const ended = await agentUserMarkerSweep(AGENT, { platform: "linux", run, node: "/usr/bin/node" })(marker);
    expect(ended).toBe(2);
    expect(calls[0]?.args.slice(0, 6)).toEqual(["-n", "-u", AGENT, "--", "/usr/bin/node", "-e"]);
    expect(calls[0]?.args.at(-1)).toBe(`${TASK_UNIT_ENV}=${marker}`);
    expect(calls[1]?.args).toEqual(["-n", "-u", AGENT, "--", "kill", "-KILL", "201", "202"]);
  });
});
