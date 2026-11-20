import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BoxRef, TaskProxies } from "@ostra/adapter-sdk";
import { startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostExecutor } from "./host-executor.ts";

// F-066 (ticket 24): a task of two repos, one merged and one still in review, reopens with the
// merged repo on a fresh `-2` branch and the other on its own. The runner pushes each repo to the
// branch the spec names for it; a kept checkout moves onto the fresh branch from the base's head.

const run = promisify(execFile);
const repoA = repoIdSchema.parse("repo-a");
const repoB = repoIdSchema.parse("repo-b");

let root = "";
let upstream: GitUpstream;
let executor: HostExecutor;
let proxies: TaskProxies;
let counter = 0;

const newBox = (): BoxRef => {
  counter += 1;
  return { taskId: taskIdSchema.parse(`task-f066-${String(counter)}`), boxId: boxIdSchema.parse(`box-f066-${String(counter)}`) };
};

const [baseRepo] = taskSpecFixture.repos;
if (baseRepo === undefined) {
  throw new Error("the task spec fixture has a repo");
}

/** Two repos on the task's branch, or repo A on `own` when given. */
const specFor = (box: BoxRef, own: string | undefined): TaskSpec => ({
  ...taskSpecFixture,
  taskId: box.taskId,
  branchName: `ostra/${box.taskId}-work`,
  repos: [
    { ...baseRepo, repoId: repoA, fullName: "ostra-test/test1", cloneUrl: "https://github.com/ostra-test/test1.git", checkoutDir: "test1", ...(own === undefined ? {} : { branchName: own }) },
    { ...baseRepo, repoId: repoB, fullName: "ostra-test/test2", cloneUrl: "https://github.com/ostra-test/test2.git", checkoutDir: "test2" },
  ],
  environment: {
    setupScript: null,
    baseImage: null,
    repos: [
      { repoId: repoA, variables: [], files: [], envFile: ".env" },
      { repoId: repoB, variables: [], files: [], envFile: ".env" },
    ],
  },
});

const readyBox = async (box: BoxRef, spec: TaskSpec): Promise<string> => {
  const created = await executor.create({ ...box, spec, proxies });
  if (!created.ok) throw new Error(created.error.message);
  const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
  if (!prepared.ok) throw new Error(prepared.error.message);
  return created.value.workspaceDir;
};

const push = (box: BoxRef, spec: TaskSpec, message: string) =>
  executor.commitAndPush({ box, message, author: spec.gitIdentity, coAuthors: spec.coAuthors, branchName: spec.branchName, hiddenRef: `refs/ostra/wip/${box.taskId}` });

const branchOf = async (dir: string): Promise<string> => (await run("git", ["branch", "--show-current"], { cwd: dir })).stdout.trim();

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-host-f066-"));
  upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n" });
  await upstream.createRepo("ostra-test/test2", { "README.md": "# test2\n" });
  executor = new HostExecutor({ dataDir: path.join(root, "runner") });
  proxies = { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };
}, 60_000);

afterAll(async () => {
  await upstream.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("a repo on a branch of its own (F-066)", () => {
  it("F-066/c2: in a two-repo task with one repo merged, the merged repo pushes to its fresh branch and the other keeps the task's", async () => {
    const box = newBox();
    const spec = specFor(box, undefined);
    const fresh = `${spec.branchName}-2`;
    const workspaceDir = await readyBox(box, spec);
    const dirA = path.join(workspaceDir, "test1");
    const dirB = path.join(workspaceDir, "test2");
    const git = (dir: string, ...args: string[]) => run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: dir });

    // The first session: both repos changed and pushed to the task's branch.
    await writeFile(path.join(dirA, "first-a.txt"), "a\n");
    await writeFile(path.join(dirB, "first-b.txt"), "b\n");
    expect((await push(box, spec, "First")).ok).toBe(true);
    const bBefore = await upstream.refSha("ostra-test/test2", `refs/heads/${spec.branchName}`);
    expect(bBefore).not.toBeNull();

    // Repo A's PR is squash-merged: the base gets the same tree on a commit of its own, so the
    // task branch's commits are not in the base's history.
    await git(dirA, "fetch", "--quiet", "origin", "main");
    const squash = (await git(dirA, "commit-tree", "HEAD^{tree}", "-p", "FETCH_HEAD", "-m", "Squash merge")).stdout.trim();
    await git(dirA, "push", "--quiet", "origin", `${squash}:refs/heads/main`);
    expect(await upstream.refSha("ostra-test/test1", "refs/heads/main")).toBe(squash);

    // The reopen: repo A has the fresh branch, repo B keeps the task's. The box is kept and resumed.
    await executor.stop({ box, graceMs: 100 });
    await writeFile(path.join(dirA, "uncommitted.txt"), "carried over\n");
    const next = specFor(box, fresh);
    const resumed = await executor.resumeBox({ ...box, spec: { ...next, leaseEpoch: next.leaseEpoch + 1 }, proxies });
    expect(resumed.ok).toBe(true);
    expect(await branchOf(dirA)).toBe(fresh);
    expect(await branchOf(dirB)).toBe(spec.branchName);
    // Repo A starts from the base's current head, with the unfinished work still in the tree.
    expect((await git(dirA, "rev-parse", "HEAD")).stdout.trim()).toBe(squash);
    expect(await readFile(path.join(dirA, "uncommitted.txt"), "utf8")).toBe("carried over\n");

    // The new session's work in both repos.
    await writeFile(path.join(dirA, "second-a.txt"), "a2\n");
    await writeFile(path.join(dirB, "second-b.txt"), "b2\n");
    const pushed = await push(box, next, "Second");
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.map((repo) => [repo.repoId, repo.ahead])).toEqual([[repoA, true], [repoB, true]]);

    // A went to its fresh branch, from the base, and left the merged branch as it was; B kept its own.
    expect(await upstream.refSha("ostra-test/test1", `refs/heads/${fresh}`)).toBe(pushed.value[0]?.headSha);
    expect(await upstream.treeFiles("ostra-test/test1", `refs/heads/${fresh}`)).toEqual(expect.arrayContaining(["second-a.txt", "uncommitted.txt"]));
    expect(await upstream.treeFiles("ostra-test/test1", `refs/heads/${spec.branchName}`)).not.toContain("second-a.txt");
    expect(await upstream.refSha("ostra-test/test2", `refs/heads/${fresh}`)).toBeNull();
    expect(await upstream.refSha("ostra-test/test2", `refs/heads/${spec.branchName}`)).toBe(pushed.value[1]?.headSha);
    expect(await upstream.refSha("ostra-test/test2", `refs/heads/${spec.branchName}`)).not.toBe(bBefore);
    expect(await upstream.treeFiles("ostra-test/test2", `refs/heads/${spec.branchName}`)).toEqual(expect.arrayContaining(["first-b.txt", "second-b.txt"]));
    await executor.release(box, "requested");
  }, 300_000);

  it("F-066/c1: a fresh box checks the repo out on its own branch from the base, and the others on the task's", async () => {
    const box = newBox();
    const base = specFor(box, undefined);
    const fresh = `${base.branchName}-2`;
    const spec = specFor(box, fresh);
    const workspaceDir = await readyBox(box, spec);
    expect(await branchOf(path.join(workspaceDir, "test1"))).toBe(fresh);
    expect(await branchOf(path.join(workspaceDir, "test2"))).toBe(spec.branchName);
    await writeFile(path.join(workspaceDir, "test1", "only-a.txt"), "a\n");
    expect((await push(box, spec, "Only A")).ok).toBe(true);
    expect(await upstream.refSha("ostra-test/test1", `refs/heads/${fresh}`)).not.toBeNull();
    expect(await upstream.refSha("ostra-test/test1", `refs/heads/${spec.branchName}`)).toBeNull();
    await executor.release(box, "requested");
  }, 300_000);
});
