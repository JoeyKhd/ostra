import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BoxRef, TaskProxies } from "@ostra/adapter-sdk";
import { startGitUpstream, trackedPids } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, checkIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ProjectId, TaskSpec, TaskSpecCheck } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST_SERVICES_REASON, HostExecutor } from "./host-executor.ts";

// Milestone 3's ticket 15 on `host`, on this machine (Windows here, with Git for Windows' bash): the
// project's host cache (the repo mirrors and the dependency cache, F-051, ADR 0038 as amended,
// Q185), the turn's checks with their timeouts and the tree reap (F-054), and the refusal of a spec
// with services (F-094). The executor contract suite runs the shared cases (host-executor.contract.test.ts).

let root = "";
let upstream: GitUpstream;
let executor: HostExecutor;
let proxies: TaskProxies;
let counter = 0;

const projectA = projectIdSchema.parse("project-cache-a");
const projectB = projectIdSchema.parse("project-cache-b");

const newBox = (): BoxRef => {
  counter += 1;
  return { taskId: taskIdSchema.parse(`task-m3-${String(counter)}`), boxId: boxIdSchema.parse(`box-m3-${String(counter)}`) };
};

/** A setup script that says whether the dependency cache was warm, where npm's cache is, and then fills it. */
const CACHE_SETUP = [
  'if [ -f "$OSTRA_DEPENDENCY_CACHE/installed" ]; then echo "cache: warm"; else echo "cache: cold"; fi',
  'echo "npm cache: $npm_config_cache"',
  'echo "pnpm store: $PNPM_STORE_DIR"',
  'echo "$OSTRA_REPO" > "$OSTRA_DEPENDENCY_CACHE/installed"',
  "",
].join("\n");

const specFor = (box: BoxRef, projectId: ProjectId, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  ...taskSpecFixture,
  taskId: box.taskId,
  projectId,
  branchName: `ostra/${box.taskId}-work`,
  environment: { ...taskSpecFixture.environment, setupScript: CACHE_SETUP },
  snapshot: { kind: "host-cache", cacheKey: projectId },
  ...extra,
});

type Ready = { readonly box: BoxRef; readonly workspaceDir: string; readonly output: string; readonly dependencyCache: unknown };

const ready = async (projectId: ProjectId, extra: Partial<TaskSpec> = {}): Promise<Ready> => {
  const box = newBox();
  const spec = specFor(box, projectId, extra);
  const created = await executor.create({ ...box, spec, proxies });
  if (!created.ok) throw new Error(created.error.message);
  let output = "";
  const prepared = await executor.prepare({
    box,
    spec,
    secrets: [],
    onSetupOutput: (_stream, text) => {
      output += text;
    },
  });
  if (!prepared.ok) throw new Error(prepared.error.message);
  expect(prepared.value.setup?.exitCode).toBe(0);
  return { box, workspaceDir: created.value.workspaceDir, output, dependencyCache: prepared.value.dependencyCache };
};

const exists = async (file: string): Promise<boolean> => (await stat(file).catch(() => null)) !== null;

const cacheDir = (projectId: ProjectId): string => path.join(root, "runner", "cache", projectId);

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-host-m3-"));
  upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n", "package.json": '{ "name": "test1" }\n' });
  executor = await HostExecutor.start({ dataDir: path.join(root, "runner") });
  proxies = { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };
}, 60_000);

afterAll(async () => {
  await upstream.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 60_000);

describe("the host cache (F-051)", () => {
  it("F-051/c5: the second task's setup reads a warm cache, and a second project's task doesn't see it", async () => {
    const first = await ready(projectA);
    expect(first.dependencyCache).toEqual({ cacheKey: projectA, reused: false });
    expect(first.output).toContain("cache: cold");

    const second = await ready(projectA);
    expect(second.dependencyCache).toEqual({ cacheKey: projectA, reused: true });
    expect(second.output).toContain("cache: warm");
    // The package managers' caches point into the project's folder.
    const deps = path.join(cacheDir(projectA), "deps");
    expect(second.output).toContain(`npm cache: ${path.join(deps, "npm")}`);
    expect(second.output).toContain(`pnpm store: ${path.join(deps, "pnpm-store")}`);

    const other = await ready(projectB);
    expect(other.dependencyCache).toEqual({ cacheKey: projectB, reused: false });
    expect(other.output).toContain("cache: cold");
    expect(other.output).not.toContain(cacheDir(projectA));
    expect(await readFile(path.join(cacheDir(projectB), "deps", "installed"), "utf8")).toContain("ostra-test/test1");

    // Each repo has its mirror, and each worktree was cloned from it and then let go of it: it
    // holds its own objects, so a mirror removed later breaks no worktree.
    const repoId = taskSpecFixture.repos[0]?.repoId ?? "";
    expect(await exists(path.join(cacheDir(projectA), `${repoId}.git`, "HEAD"))).toBe(true);
    expect(await exists(path.join(second.workspaceDir, "test1", ".git", "objects", "info", "alternates"))).toBe(false);
    expect(await readFile(path.join(second.workspaceDir, "test1", "README.md"), "utf8")).toBe("# test1\n");

    // The release removes the worktree only: the cache stays for the project's next task.
    for (const box of [first.box, second.box, other.box]) {
      await executor.release(box, "requested");
    }
    expect(await exists(first.workspaceDir)).toBe(false);
    expect(await exists(path.join(cacheDir(projectA), "deps", "installed"))).toBe(true);
  }, 180_000);

  it("F-051: a spec without a host cache gets no cache folder, and its setup sees none", async () => {
    const plain = await ready(projectA, { snapshot: null, environment: { ...taskSpecFixture.environment, setupScript: 'echo "cache: ${OSTRA_DEPENDENCY_CACHE:-none}"\n' } });
    expect(plain.dependencyCache).toBeUndefined();
    expect(plain.output).toContain("cache: none");
    await executor.release(plain.box, "requested");
  }, 60_000);

  it("F-051/c5: a new cache key starts the dependency cache again and keeps the mirrors", async () => {
    const project = projectIdSchema.parse("project-cache-key");
    const input = (cacheKey: string) => ({
      projectId: project,
      cacheKey,
      repos: taskSpecFixture.repos.map((repo) => ({ repoId: repo.repoId, cloneUrl: repo.cloneUrl })),
      proxies,
    });
    const one = await executor.prepareCache(input("key-1"));
    if (!one.ok) throw new Error(one.error.message);
    await writeFile(path.join(one.value.dependencyCacheDir, "installed"), "yes");
    expect((await executor.prepareCache(input("key-1"))).ok && (await executor.prepareCache(input("key-1")))).toMatchObject({ ok: true, value: { reused: true } });
    const two = await executor.prepareCache(input("key-2"));
    expect(two).toMatchObject({ ok: true, value: { cacheKey: "key-2", reused: false } });
    expect(await exists(path.join(one.value.dependencyCacheDir, "installed"))).toBe(false);
    const repoId = taskSpecFixture.repos[0]?.repoId ?? "";
    expect(await exists(path.join(cacheDir(project), `${repoId}.git`, "HEAD"))).toBe(true);
  }, 60_000);

  it("F-051/c5: a cache unused for 30 days goes, a removed project's goes at once, and never while its box is live", async () => {
    const idle = projectIdSchema.parse("project-cache-idle");
    const kept = projectIdSchema.parse("project-cache-kept");
    for (const projectId of [idle, kept]) {
      const made = await executor.prepareCache({ projectId, cacheKey: projectId, repos: [], proxies });
      if (!made.ok) throw new Error(made.error.message);
    }
    const day = 24 * 60 * 60_000;
    const old = new Date(Date.now() - 31 * day);
    await utimes(path.join(cacheDir(idle), "last-used"), old, old);
    // A box of a project holds its cache, however old.
    const live = await ready(projectA);
    const aged = new Date(Date.now() - 40 * day);
    await utimes(path.join(cacheDir(projectA), "last-used"), aged, aged);
    expect(await executor.sweepIdleCaches()).toBe(1);
    expect(await exists(cacheDir(idle))).toBe(false);
    expect(await exists(cacheDir(kept))).toBe(true);
    expect(await exists(cacheDir(projectA))).toBe(true);
    expect(await executor.removeProjectCache(projectA)).toMatchObject({ ok: false, error: { code: "conflict" } });
    await executor.release(live.box, "requested");
    expect(await executor.removeProjectCache(projectA)).toEqual({ ok: true, value: undefined });
    expect(await exists(cacheDir(projectA))).toBe(false);
    // 29 days is still inside the window.
    const recent = new Date(Date.now() - 29 * day);
    await utimes(path.join(cacheDir(kept), "last-used"), recent, recent);
    expect(await executor.sweepIdleCaches()).toBe(0);
    expect(await exists(cacheDir(kept))).toBe(true);
  }, 120_000);
});

describe("checks on host (F-054)", () => {
  const node = `'${process.execPath.replaceAll("\\", "/")}'`;
  const check = (id: string, command: string, timeoutSeconds = 30): TaskSpecCheck => ({
    checkId: checkIdSchema.parse(id),
    name: id,
    command,
    repoId: null,
    timeoutSeconds,
  });
  const helpers = trackedPids();

  it("F-054/c2: checks pass, fail and time out in the worktree, and the timeout leaves no process behind", async () => {
    const box = newBox();
    const outputDir = path.join(root, "checks-output", box.taskId);
    const pidFile = path.join(root, `${box.taskId}-helper.pid`).replaceAll("\\", "/");
    // The slow check starts a child of its own, then waits: the timeout must end both.
    const leaving = [
      "const { spawn } = require(\"node:child_process\");",
      "const child = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 1000)\"], { stdio: \"ignore\" });",
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const checks = [
      check("passing", `test -f test1/README.md && echo "in the workspace root"`),
      check("failing", "echo failing; exit 3"),
      check("slow", `${node} -e '${leaving}'`, 2),
    ];
    const spec = { ...specFor(box, projectA), snapshot: null, environment: { ...taskSpecFixture.environment, setupScript: null }, checks };
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) throw new Error(created.error.message);
    const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const ran = await executor.runChecks(box, { spec, changedRepoIds: [], env: { CHECK_VAR: "set" }, outputDir });
    if (!ran.ok) throw new Error(ran.error.message);
    expect(ran.value.map((result) => [result.checkId, result.status, result.exitCode])).toEqual([
      ["passing", "passed", 0],
      ["failing", "failed", 3],
      ["slow", "timed-out", null],
    ]);
    expect(ran.value[0]?.outputTail).toContain("in the workspace root");
    expect(await readFile(ran.value[1]?.outputPath ?? "", "utf8")).toContain("failing");
    const slow = ran.value[2];
    expect(slow?.durationMs).toBeGreaterThanOrEqual(1_900);
    expect(slow?.durationMs).toBeLessThan(20_000);
    // The child the slow check started is gone with it: the tree reap, not only the shell.
    const pid = await helpers.track(Number((await readFile(pidFile, "utf8")).trim()));
    if (pid === null) throw new Error("the slow check's child wasn't seen");
    const deadline = Date.now() + 10_000;
    while ((await helpers.isAlive(pid)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await helpers.isAlive(pid)).toBe(false);
    // The box is as it was: checks end only their own processes, never the task's unit.
    expect(await executor.state(box)).toEqual({ ok: true, value: "ready" });
    await executor.release(box, "requested");
  }, 120_000);

  it("F-054: checks don't run in a box that isn't ready", async () => {
    const box = newBox();
    const ran = await executor.runChecks(box, { spec: specFor(box, projectA), changedRepoIds: [], env: {}, outputDir: path.join(root, "never") });
    expect(ran).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("services on host (F-094)", () => {
  it("F-094/c5: a spec with services is refused with the reason ostra shows, and no box is made", async () => {
    const box = newBox();
    const spec = specFor(box, projectA, { services: [{ name: "db", image: "postgres:17", port: 5432, variables: [], healthCheck: "pg_isready" }] });
    expect(await executor.create({ ...box, spec, proxies })).toEqual({ ok: false, error: { code: "unsupported", message: HOST_SERVICES_REASON } });
    expect(await executor.state(box)).toEqual({ ok: true, value: "released" });
    expect(await exists(path.join(root, "runner", "tasks", box.taskId))).toBe(false);
  });
});
