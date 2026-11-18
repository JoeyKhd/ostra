import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isAlive } from "@ostra/adapter-sdk";
import type { AgentLaunch, BoxRef, TaskProxies } from "@ostra/adapter-sdk";
import { startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { RepoSecret, TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostExecutor } from "./host-executor.ts";

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
    expect(executor.capabilities).toEqual({ isolation: "none", services: false, boxSizes: false, snapshots: false, processContainment: "process-tree" });
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

  it("writes repo A's secret into repo A only, and never commits it", async () => {
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

  it("puts the trailer on the agent's own commits too", async () => {
    const box = newBox();
    const spec = twoRepoSpec(box, null);
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) {
      throw new Error("create failed");
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
      throw new Error("create failed");
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
    const extra = names.filter((name) => name !== "OSTRA_ONLY" && name !== "SystemRoot");
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
    expect(await executor.stop({ box, graceMs: 200 })).toEqual({ ok: true, value: undefined });
    const agentPid = agent.value.pid ?? 0;
    for (let attempt = 0; attempt < 50 && (isAlive(agentPid) || isAlive(childPid)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(isAlive(agentPid)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
    await executor.release(box);
  });
});
