import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentLaunch, BoxRef, TaskProxies } from "@ostra/adapter-sdk";
import { startGitUpstream, trackedPids } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { RepoSecret, TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processTreeContainment } from "./containment.ts";
import { HostExecutor } from "./host-executor.ts";
import { localProcesses } from "./task-processes.ts";
import { codeHostRefusal, WORKFLOWS_PERMISSION_REASON } from "./process.ts";

// Ticket 19's "done when", against the git proxy's upstream stub (here without the proxy: the
// executor's job is the checkout, the environment, the commits and the processes).

const run = promisify(execFile);
const repoA = repoIdSchema.parse("repo-a");
const repoB = repoIdSchema.parse("repo-b");
const SECRET_A = "secret-value-for-repo-a-only";

let root = "";
let upstream: GitUpstream;
let executor: HostExecutor;
let proxies: TaskProxies;
let counter = 0;

const newBox = (): BoxRef => {
  counter += 1;
  return { taskId: taskIdSchema.parse(`task-host-${String(counter)}`), boxId: boxIdSchema.parse(`box-${String(counter)}`) };
};

const [baseRepo] = taskSpecFixture.repos;
if (baseRepo === undefined) {
  throw new Error("the task spec fixture has a repo");
}

// libuv copies these from the runner into every child's environment on Windows, whatever the
// launch says (its `required_vars`). None holds a credential.
const WINDOWS_REQUIRED_ENV = ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"];

const twoRepoSpec = (box: BoxRef, setupScript: string | null): TaskSpec => ({
  ...taskSpecFixture,
  taskId: box.taskId,
  branchName: `ostra/${box.taskId}-add-a-file`,
  repos: [
    { ...baseRepo, repoId: repoA, fullName: "ostra-test/test1", cloneUrl: "https://github.com/ostra-test/test1.git", checkoutDir: "test1" },
    { ...baseRepo, repoId: repoB, fullName: "ostra-test/test2", cloneUrl: "https://github.com/ostra-test/test2.git", checkoutDir: "test2" },
  ],
  environment: {
    setupScript,
    baseImage: null,
    repos: [
      { repoId: repoA, variables: [{ name: "NODE_ENV", value: "test", availableDuringSetup: true }], files: [{ path: "config/app.json", content: "{}\n" }], envFile: ".env" },
      { repoId: repoB, variables: [{ name: "B_ONLY", value: "plain value", availableDuringSetup: false }], files: [], envFile: "local.env" },
    ],
  },
});

const secretsFor: readonly { readonly repoId: typeof repoA; readonly entries: readonly RepoSecret[] }[] = [
  {
    repoId: repoA,
    entries: [
      { kind: "variable", name: "API_KEY", value: SECRET_A, availableDuringSetup: true },
      { kind: "file", path: "config/secret.json", content: `{"key":"${SECRET_A}"}\n`, availableDuringSetup: false },
    ],
  },
];

const filesUnder = async (dir: string): Promise<readonly string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await filesUnder(full)));
    } else {
      out.push(full);
    }
  }
  return out;
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

const node = (script: string, cwd: string): AgentLaunch => ({
  command: process.execPath,
  args: ["-e", script],
  env: process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {},
  cwd,
  files: [],
});

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-host-executor-"));
  upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n", ".gitignore": "node_modules/\n" });
  await upstream.createRepo("ostra-test/test2", { "README.md": "# test2\n" });
  executor = new HostExecutor({ dataDir: path.join(root, "runner") });
  proxies = { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };
}, 60_000);

afterAll(async () => {
  await upstream.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("the host executor", () => {
  it("declares ADR 0029's allowed differences", () => {
    expect(executor.capabilities).toEqual({
      isolation: "none",
      services: false,
      boxSizes: false,
      snapshots: "host-cache",
      processContainment: "process-tree",
      registry: "none",
      nodeWait: false,
    });
  });

  it("F-095/c4: the host executor counts slots only: it offers no CPU or memory, refuses a box size, and makes no box for it", async () => {
    expect(executor.capacity()).toBeNull();
    const box = newBox();
    const refused = await executor.create({ ...box, spec: twoRepoSpec(box, null), proxies, size: { cpuMillis: 2000, memoryMiB: 4096 } });
    expect(refused).toMatchObject({ ok: false, error: { code: "unsupported" } });
    // The host executor knows a box it never made only as released.
    expect(await executor.state(box)).toEqual({ ok: true, value: "released" });
    expect(await exists(path.join(root, "runner", "tasks", String(box.taskId)))).toBe(false);
  });

  it("checks out two repos side by side, streams setup, commits with the trailer, pushes, keeps unfinished work, and releases", async () => {
    const box = newBox();
    const spec = twoRepoSpec(box, 'echo "setup in $OSTRA_REPO"\necho "to stderr" >&2\nif [ -n "$NODE_ENV" ]; then echo "NODE_ENV=$NODE_ENV"; fi\n');
    const created = await executor.create({ ...box, spec, proxies });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const output: { readonly stream: string; readonly text: string }[] = [];
    const prepared = await executor.prepare({
      box,
      spec,
      secrets: secretsFor,
      onSetupOutput: (stream, text) => output.push({ stream, text }),
    });
    expect(prepared).toMatchObject({ ok: true, value: { setup: { exitCode: 0 } } });
    const stdout = output.filter((item) => item.stream === "stdout").map((item) => item.text).join("");
    expect(stdout).toContain("setup in ostra-test/test1");
    expect(stdout).toContain("setup in ostra-test/test2");
    expect(stdout).toContain("NODE_ENV=test");
    expect(output.some((item) => item.stream === "stderr" && item.text.includes("to stderr"))).toBe(true);
    expect(await executor.state(box)).toEqual({ ok: true, value: "ready" });

    const dirA = path.join(created.value.workspaceDir, "test1");
    const dirB = path.join(created.value.workspaceDir, "test2");
    const branchOf = async (dir: string): Promise<string> => (await run("git", ["branch", "--show-current"], { cwd: dir })).stdout.trim();
    expect(await branchOf(dirA)).toBe(spec.branchName);
    expect(await branchOf(dirB)).toBe(spec.branchName);
    expect(await readFile(path.join(dirA, ".env"), "utf8")).toBe(`NODE_ENV=test\nAPI_KEY=${SECRET_A}\n`);
    expect(await readFile(path.join(dirB, "local.env"), "utf8")).toBe('B_ONLY="plain value"\n');

    // The agent's change, in repo A only.
    await writeFile(path.join(dirA, "CONTRIBUTING.md"), "# Contributing\n");
    const pushed = await executor.commitAndPush({
      box,
      message: "Add a short CONTRIBUTING.md",
      author: spec.gitIdentity,
      coAuthors: spec.coAuthors,
      branchName: spec.branchName,
      hiddenRef: `refs/ostra/wip/${box.taskId}`,
    });
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) {
      return;
    }
    const [resultA, resultB] = pushed.value;
    expect(resultA).toMatchObject({ repoId: repoA, ahead: true });
    expect(resultB).toEqual({ repoId: repoB, headSha: null, ahead: false });
    expect(await upstream.refSha("ostra-test/test1", `refs/heads/${spec.branchName}`)).toBe(resultA?.headSha);
    expect(await upstream.refSha("ostra-test/test1", `refs/ostra/wip/${box.taskId}`)).toBe(resultA?.headSha);
    expect(await upstream.refSha("ostra-test/test2", `refs/heads/${spec.branchName}`)).toBeNull();
    const message = await upstream.commitMessage("ostra-test/test1", `refs/heads/${spec.branchName}`);
    expect(message).toContain("Add a short CONTRIBUTING.md");
    expect(message).toContain("Co-authored-by: Admin <admin@example.com>");
    const files = await upstream.treeFiles("ostra-test/test1", `refs/heads/${spec.branchName}`);
    expect(files).toContain("CONTRIBUTING.md");
    expect(files).not.toContain(".env");
    expect(files).not.toContain("config/secret.json");
    expect(files).not.toContain("config/app.json");

    // A stop: an untracked file in repo B is unfinished work, kept in the hidden ref.
    await writeFile(path.join(dirB, "wip-notes.txt"), "half done\n");
    expect(await executor.stop({ box, graceMs: 100 })).toEqual({ ok: true, value: undefined });
    const stopped = await executor.commitAndPush({
      box,
      message: "ostra: unfinished work (stopped)",
      author: spec.gitIdentity,
      coAuthors: spec.coAuthors,
      branchName: spec.branchName,
      hiddenRef: `refs/ostra/wip/${box.taskId}`,
    });
    expect(stopped.ok && stopped.value[1]?.ahead).toBe(true);
    expect(await upstream.treeFiles("ostra-test/test2", `refs/ostra/wip/${box.taskId}`)).toContain("wip-notes.txt");
    expect(await upstream.treeFiles("ostra-test/test2", `refs/ostra/wip/${box.taskId}`)).not.toContain("local.env");

    expect(await executor.release(box)).toEqual({ ok: true, value: undefined });
    expect(await exists(path.dirname(created.value.workspaceDir))).toBe(false);
    expect(await executor.state(box)).toEqual({ ok: true, value: "released" });
  });

  it("F-050/c5: writes repo A's secret into repo A only, and never commits it", async () => {
    const box = newBox();
    const spec = twoRepoSpec(box, null);
    const created = await executor.create({ ...box, spec, proxies });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await executor.prepare({ box, spec, secrets: secretsFor, onSetupOutput: () => undefined });
    const dirB = path.join(created.value.workspaceDir, "test2");
    for (const file of await filesUnder(dirB)) {
      expect((await readFile(file)).includes(SECRET_A), file).toBe(false);
    }
    const dirA = path.join(created.value.workspaceDir, "test1");
    expect(await readFile(path.join(dirA, "config", "secret.json"), "utf8")).toContain(SECRET_A);
    const status = (await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dirA })).stdout;
    expect(status).toBe("");
    await executor.release(box);
  });

  it("F-050/c5,c6: a key both repos need reaches each checkout with its own repo's value, and no other", async () => {
    const box = newBox();
    const spec = twoRepoSpec(box, null);
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) throw new Error(created.error.message);
    const valueA = "shared-key-value-of-repo-a-only";
    const valueB = "shared-key-value-of-repo-b-only";
    const secrets = [
      { repoId: repoA, entries: [{ kind: "variable" as const, name: "SHARED_KEY", value: valueA, availableDuringSetup: false }] },
      { repoId: repoB, entries: [{ kind: "variable" as const, name: "SHARED_KEY", value: valueB, availableDuringSetup: false }] },
    ];
    expect((await executor.prepare({ box, spec, secrets, onSetupOutput: () => undefined })).ok).toBe(true);
    const dirA = path.join(created.value.workspaceDir, "test1");
    const dirB = path.join(created.value.workspaceDir, "test2");
    expect(await readFile(path.join(dirA, ".env"), "utf8")).toContain(`SHARED_KEY=${valueA}`);
    expect(await readFile(path.join(dirB, "local.env"), "utf8")).toContain(`SHARED_KEY=${valueB}`);
    for (const file of await filesUnder(dirA)) expect((await readFile(file)).includes(valueB), file).toBe(false);
    for (const file of await filesUnder(dirB)) expect((await readFile(file)).includes(valueA), file).toBe(false);
    await executor.release(box);
  });

  it("F-078/c2: puts the trailer on the agent's own commits too, and the bot authors them", async () => {
    const box = newBox();
    const spec = twoRepoSpec(box, null);
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) {
      throw new Error(`create failed: ${created.error.message}`);
    }
    await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    const dirA = path.join(created.value.workspaceDir, "test1");
    await writeFile(path.join(dirA, "agent.txt"), "by the agent\n");
    await run("git", ["add", "agent.txt"], { cwd: dirA });
    await run("git", ["commit", "--quiet", "-m", "the agent's own commit"], { cwd: dirA });
    const message = (await run("git", ["log", "-1", "--format=%B"], { cwd: dirA })).stdout;
    expect(message).toContain("Co-authored-by: Admin <admin@example.com>");
    const author = (await run("git", ["log", "-1", "--format=%an <%ae>"], { cwd: dirA })).stdout.trim();
    expect(author).toBe(`${spec.gitIdentity.name} <${spec.gitIdentity.email}>`);
    await executor.release(box);
  });

  it("reports a failing setup by its exit code", async () => {
    const box = newBox();
    const spec = twoRepoSpec(box, "echo failing\nexit 7\n");
    await executor.create({ ...box, spec, proxies });
    const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    expect(prepared).toMatchObject({ ok: true, value: { setup: { exitCode: 7 } } });
    await executor.release(box);
  });

  it("refuses an environment file that would write into .git", async () => {
    const box = newBox();
    const base = twoRepoSpec(box, null);
    const spec: TaskSpec = {
      ...base,
      environment: {
        ...base.environment,
        repos: [{ repoId: repoA, variables: [], files: [{ path: ".git/hooks/post-checkout", content: "#!/bin/sh\n" }], envFile: ".env" }],
      },
    };
    await executor.create({ ...box, spec, proxies });
    const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    expect(prepared).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    await executor.release(box);
  });

  it("gives the agent exactly its launch's environment, and ends its whole tree on stop", async () => {
    const box = newBox();
    const spec = twoRepoSpec(box, null);
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) {
      throw new Error(`create failed: ${created.error.message}`);
    }
    await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    const pidFile = path.join(created.value.agentDir, "child.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "process.stdout.write(JSON.stringify(Object.keys(process.env)) + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const launch: AgentLaunch = { ...node(script, created.value.workspaceDir), env: { ...node("", "").env, OSTRA_ONLY: "1" } };
    const agent = await executor.startAgent(box, launch);
    expect(agent.ok).toBe(true);
    if (!agent.ok) {
      return;
    }
    const keys = await new Promise<string>((resolve) => {
      agent.value.stdout.once("data", (chunk: Buffer) => {
        resolve(chunk.toString("utf8"));
      });
    });
    const parsed: unknown = JSON.parse(keys);
    const names = Array.isArray(parsed) ? parsed.map(String) : [];
    expect(names).toContain("OSTRA_ONLY");
    // The task's containment marker is the one variable the executor adds (ticket 42).
    expect(names).toContain("OSTRA_TASK_UNIT");
    const extra = names.filter((name) => name !== "OSTRA_ONLY" && name !== "SystemRoot" && name !== "OSTRA_TASK_UNIT");
    if (process.platform === "win32") {
      expect(extra.filter((name) => !WINDOWS_REQUIRED_ENV.includes(name.toUpperCase()))).toEqual([]);
    } else {
      expect(extra).toEqual([]);
    }
    let childPid = 0;
    for (let attempt = 0; attempt < 100 && childPid === 0; attempt += 1) {
      childPid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (childPid === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(childPid).toBeGreaterThan(0);
    // By birth as well as PID: the stop takes seconds under load, and Windows may hand a PID on.
    const tracked = trackedPids();
    const agentPid = (await tracked.track(agent.value.pid ?? null)) ?? 0;
    await tracked.track(childPid);
    expect(await executor.stop({ box, graceMs: 200 })).toEqual({ ok: true, value: undefined });
    const deadline = Date.now() + 15_000;
    while (((await tracked.isAlive(agentPid)) || (await tracked.isAlive(childPid))) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await tracked.isAlive(agentPid)).toBe(false);
    expect(await tracked.isAlive(childPid)).toBe(false);
    await executor.release(box);
  });
});

describe("git on Windows, where a path over 260 characters needs core.longpaths", () => {
  const SEGMENT = "a-deep-folder-".padEnd(40, "x");
  const deepFolder = [SEGMENT, SEGMENT, SEGMENT].join("/");

  it("F-014/c9: gives the task's config and every checkout's config core.longpaths, on any system", async () => {
    const box = newBox();
    const spec = twoRepoSpec(box, null);
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) {
      throw new Error("create failed");
    }
    expect((await run("git", ["config", "--file", created.value.gitConfig, "--get", "core.longpaths"])).stdout.trim()).toBe("true");
    const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    expect(prepared.ok).toBe(true);
    for (const checkout of ["test1", "test2"]) {
      const local = await run("git", ["config", "--local", "--get", "core.longpaths"], { cwd: path.join(created.value.workspaceDir, checkout) });
      expect(local.stdout.trim(), checkout).toBe("true");
    }
    await executor.release(box);
  });

  // Windows' limit is Windows' alone (MAX_PATH, 260 characters): on Linux and macOS this is a
  // plain checkout that always worked, so the case is skipped there. The unconditional test above
  // and the recorded-command test below hold the setting on every system.
  it.skipIf(process.platform !== "win32")(
    "F-014: clones, branches, commits and pushes a checkout whose paths pass 260 characters (Windows only)",
    async () => {
      await upstream.createRepo("ostra-test/deep", { "README.md": "# deep\n", [`${deepFolder}/file.txt`]: "deep\n" });
      const longDataDir = path.join(root, "a-long-runner-data-folder-".padEnd(110, "x"));
      const long = new HostExecutor({ dataDir: longDataDir });
      const box = newBox();
      const spec: TaskSpec = {
        ...twoRepoSpec(box, null),
        // A branch named for a ticket, as the real ones are.
        branchName: `ostra/${box.taskId}-add-a-health-check-endpoint-that-reports-the-queue-depth-and-the-last-job`,
        repos: [{ ...baseRepo, repoId: repoA, fullName: "ostra-test/deep", cloneUrl: "https://github.com/ostra-test/deep.git", checkoutDir: "deep" }],
        environment: { setupScript: null, baseImage: null, repos: [] },
      };
      const created = await long.create({ ...box, spec, proxies });
      if (!created.ok) {
        throw new Error("create failed");
      }
      const checkout = path.join(created.value.workspaceDir, "deep");
      const deepFile = path.join(checkout, ...deepFolder.split("/"), "file.txt");
      const lockPath = path.join(checkout, ".git", "refs", "heads", `${spec.branchName}.lock`);
      // The test only means something if the paths are over the limit.
      expect(deepFile.length).toBeGreaterThan(260);
      expect(lockPath.length).toBeGreaterThan(260);
      const prepared = await long.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
      expect(await readFile(deepFile, "utf8")).toBe("deep\n");
      await writeFile(path.join(checkout, ...deepFolder.split("/"), "second.txt"), "second\n");
      const pushed = await long.commitAndPush({
        box,
        message: "Add second.txt",
        author: spec.gitIdentity,
        coAuthors: [],
        branchName: spec.branchName,
        hiddenRef: `refs/ostra/wip/${box.taskId}`,
      });
      expect(pushed, JSON.stringify(pushed)).toMatchObject({ ok: true });
      expect(await upstream.treeFiles("ostra-test/deep", `refs/heads/${spec.branchName}`)).toContain(`${deepFolder}/second.txt`);
      await long.release(box);
    },
    60_000,
  );
});

describe("the executor's git, where the agent controls the checkout", () => {
  type GitRun = { readonly command: string; readonly args: readonly string[] };

  /** The host's own processes, recording every program the executor runs through the seam. */
  const recordingExecutor = (calls: GitRun[]): HostExecutor => {
    const local = localProcesses(() => processTreeContainment());
    return new HostExecutor({
      dataDir: path.join(root, "runner-recorded"),
      processes: {
        createUnit: local.createUnit,
        startAgent: local.startAgent,
        run: (command, args, options) => {
          calls.push({ command, args });
          return local.run(command, args, options);
        },
      },
    });
  };

  const gitRuns = (calls: readonly GitRun[]): readonly GitRun[] => calls.filter((call) => call.command === "git");
  const HARDENING = ["-c", "core.fsmonitor=false", "-c", "core.sshCommand=", "-c", "protocol.ext.allow=never", "-c", "core.longpaths=true"];
  const subcommand = (call: GitRun): string | undefined => call.args.slice(HARDENING.length)[0];

  it("F-014/c9: runs every git command, the sidecar's included, through the processes seam, each with the hardening and core.longpaths on", async () => {
    const calls: GitRun[] = [];
    const recorded = recordingExecutor(calls);
    const box = newBox();
    const spec = twoRepoSpec(box, null);
    const created = await recorded.create({ ...box, spec, proxies });
    if (!created.ok) {
      throw new Error(`create failed: ${created.error.message}`);
    }
    await recorded.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    await writeFile(path.join(created.value.workspaceDir, "test1", "seam.txt"), "x\n");
    const pushed = await recorded.commitAndPush({
      box,
      message: "Add seam.txt",
      author: spec.gitIdentity,
      coAuthors: [],
      branchName: spec.branchName,
      hiddenRef: `refs/ostra/wip/${box.taskId}`,
    });
    expect(pushed.ok).toBe(true);
    // The checkout's git: all of it through the seam, and all of it with the hardening that beats
    // the checkout's own config. (The task's own config file is written before any agent exists.)
    const checkoutGit = gitRuns(calls).filter((call) => call.args[0] === "-c");
    const seen = new Set(checkoutGit.map(subcommand));
    for (const expected of ["clone", "config", "checkout", "status", "add", "commit", "rev-list", "rev-parse", "push", "check-ignore"]) {
      expect(seen, expected).toContain(expected);
    }
    for (const call of checkoutGit) {
      expect(call.args.slice(0, HARDENING.length), call.args.join(" ")).toEqual(HARDENING);
    }
    expect(gitRuns(calls).filter((call) => call.args[0] !== "-c").every((call) => call.args[0] === "lfs")).toBe(true);
    await recorded.release(box);
  });

  it("doesn't run a program the agent set in the checkout's config when it commits", async () => {
    const box = newBox();
    const spec = twoRepoSpec(box, null);
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) {
      throw new Error(`create failed: ${created.error.message}`);
    }
    await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    const dirA = path.join(created.value.workspaceDir, "test1");
    const marker = path.join(created.value.agentDir, "fsmonitor-ran");
    await run("git", ["config", "--local", "core.fsmonitor", `touch '${marker.split(path.sep).join("/")}'`], { cwd: dirA });
    await writeFile(path.join(dirA, "change.txt"), "x\n");
    const pushed = await executor.commitAndPush({
      box,
      message: "Add change.txt",
      author: spec.gitIdentity,
      coAuthors: [],
      branchName: spec.branchName,
      hiddenRef: `refs/ostra/wip/${box.taskId}`,
    });
    expect(pushed.ok).toBe(true);
    expect(await exists(marker)).toBe(false);
    await executor.release(box);
  });
});

describe("a workspace per task (F-016)", () => {
  const prepared = async (box: BoxRef): Promise<{ readonly spec: TaskSpec; readonly workspaceDir: string }> => {
    const spec = twoRepoSpec(box, null);
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) throw new Error(created.error.message);
    const ready = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    if (!ready.ok) throw new Error(ready.error.message);
    return { spec, workspaceDir: created.value.workspaceDir };
  };

  it("F-016/c1: every repo of the task is checked out side by side in its workspace, all on the task's one branch", async () => {
    const box = newBox();
    const { spec, workspaceDir } = await prepared(box);
    expect((await readdir(workspaceDir)).sort()).toEqual(["test1", "test2"]);
    for (const repo of spec.repos) {
      const checkout = path.join(workspaceDir, repo.checkoutDir);
      const top = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: checkout })).stdout.trim();
      expect(path.resolve(top)).toBe(path.resolve(checkout));
      expect((await run("git", ["branch", "--show-current"], { cwd: checkout })).stdout.trim()).toBe(spec.branchName);
    }
    await executor.release(box);
  });


  it("F-016/c2: the task's branch is made in each repo it changes, and in no other", async () => {
    const box = newBox();
    const { spec, workspaceDir } = await prepared(box);
    const [one, two] = spec.repos;
    if (one === undefined || two === undefined) throw new Error("two repos");
    const push = () =>
      executor.commitAndPush({ box, message: "Change", author: spec.gitIdentity, coAuthors: spec.coAuthors, branchName: spec.branchName, hiddenRef: `refs/ostra/wip/${box.taskId}` });

    // A change in the second repo only: the branch is made there, not in the first.
    await writeFile(path.join(workspaceDir, two.checkoutDir, "TWO.md"), "two\n");
    expect((await push()).ok).toBe(true);
    expect(await upstream.refSha(two.fullName, `refs/heads/${spec.branchName}`)).not.toBeNull();
    expect(await upstream.refSha(one.fullName, `refs/heads/${spec.branchName}`)).toBeNull();

    // Then a change in the first: the same name is made there too.
    await writeFile(path.join(workspaceDir, one.checkoutDir, "ONE.md"), "one\n");
    expect((await push()).ok).toBe(true);
    expect(await upstream.treeFiles(one.fullName, `refs/heads/${spec.branchName}`)).toContain("ONE.md");
    expect(await upstream.treeFiles(two.fullName, `refs/heads/${spec.branchName}`)).toContain("TWO.md");
    await executor.release(box);
  });
  it("F-016/c3: two tasks never share a workspace, a working tree or a branch, and one's release leaves the other whole", async () => {
    const one = newBox();
    const two = newBox();
    const first = await prepared(one);
    const second = await prepared(two);

    expect(first.spec.branchName).not.toBe(second.spec.branchName);
    const relative = path.relative(first.workspaceDir, second.workspaceDir);
    expect(relative.startsWith("..")).toBe(true);
    expect(path.relative(second.workspaceDir, first.workspaceDir).startsWith("..")).toBe(true);

    for (const repo of first.spec.repos) {
      const a = path.join(first.workspaceDir, repo.checkoutDir);
      const b = path.join(second.workspaceDir, repo.checkoutDir);
      const gitDir = async (dir: string): Promise<string> => path.resolve(dir, (await run("git", ["rev-parse", "--git-dir"], { cwd: dir })).stdout.trim());
      expect(await gitDir(a)).not.toBe(await gitDir(b));
      expect((await run("git", ["branch", "--show-current"], { cwd: a })).stdout.trim()).toBe(first.spec.branchName);
      expect((await run("git", ["branch", "--show-current"], { cwd: b })).stdout.trim()).toBe(second.spec.branchName);
    }

    // The first task's change is in its tree only, and goes out on its branch only.
    const [repo] = first.spec.repos;
    if (repo === undefined) throw new Error("no repo");
    await writeFile(path.join(first.workspaceDir, repo.checkoutDir, "ONE.md"), "one\n");
    expect((await run("git", ["status", "--porcelain"], { cwd: path.join(second.workspaceDir, repo.checkoutDir) })).stdout.trim()).toBe("");
    const pushed = await executor.commitAndPush({
      box: one,
      message: "Add ONE.md",
      author: first.spec.gitIdentity,
      coAuthors: first.spec.coAuthors,
      branchName: first.spec.branchName,
      hiddenRef: `refs/ostra/wip/${one.taskId}`,
    });
    expect(pushed.ok).toBe(true);
    expect(await upstream.treeFiles(repo.fullName, `refs/heads/${first.spec.branchName}`)).toContain("ONE.md");
    expect(await upstream.refSha(repo.fullName, `refs/heads/${second.spec.branchName}`)).toBeNull();

    // Releasing the first task's box leaves the second's as it was.
    expect(await executor.release(one)).toEqual({ ok: true, value: undefined });
    expect(await exists(first.workspaceDir)).toBe(false);
    expect(await exists(path.join(second.workspaceDir, repo.checkoutDir, "README.md"))).toBe(true);
    expect(await executor.state(two)).toEqual({ ok: true, value: "ready" });
    await executor.release(two);
  });

  it("F-016/c3: a box serves one task: its ID can't be created twice, and a released box isn't prepared again", async () => {
    const box = newBox();
    const spec = twoRepoSpec(box, null);
    expect((await executor.create({ ...box, spec, proxies })).ok).toBe(true);
    expect(await executor.create({ ...box, spec, proxies })).toMatchObject({ ok: false, error: { code: "conflict" } });
    await executor.release(box);
    expect(await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("a push the code host refuses", () => {
  it("F-006/c5: names GitHub's refusal of a workflow change in words a member can act on, and keeps another refusal's reason", () => {
    // `git push --porcelain` as GitHub answers an App without the `workflows` permission.
    const workflows = [
      "To https://github.com/ostra-test/test1.git",
      "!\t+HEAD:refs/heads/ostra/abcd1234-add-ci\t[remote rejected] (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)",
      "Done",
    ].join("\n");
    expect(codeHostRefusal(workflows)).toBe(WORKFLOWS_PERMISSION_REASON);
    expect(WORKFLOWS_PERMISSION_REASON).toContain(".github/workflows/");
    expect(codeHostRefusal("!\t+HEAD:refs/heads/x\t[remote rejected] (protected branch hook declined)")).toBe(
      "the code host refused the push (protected branch hook declined)",
    );
    expect(codeHostRefusal("fatal: unable to access the proxy")).toBeNull();
  });
});
