import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { repoFullNameSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitProxy } from "./git-proxy.ts";
import type { GitProxy } from "./git-proxy.ts";

// F-113 (ADR 0038 as amended 2026-11-21): with the task's `commitPaths`, the git proxy refuses a
// push one of whose commits changes another path, in git's own words, and sends nothing of it
// upstream. Stock git through the real proxy, against the upstream stub, with the checkout's own
// objects as the check's alternate, as the task host gives it.

const repo = repoFullNameSchema.parse("ostra-test/onboard");
const ALLOWED = "ostra: this task may commit only AGENTS.md; a commit in this push changes another path";
const UNCHECKED = "ostra: not pushed, the proxy couldn't read which paths this push changes; push from the task's own checkout";

let root = "";
let upstream: GitUpstream;
let token = "";
let gitEnv: NodeJS.ProcessEnv = {};
const logs: LogRecord[] = [];
const proxies: GitProxy[] = [];
let tasks = 0;

type GitRun = { readonly code: number; readonly stdout: string; readonly stderr: string };

const runGit = (args: readonly string[], cwd: string): Promise<GitRun> =>
  new Promise((resolve) => {
    execFile("git", [...args], { cwd, env: gitEnv, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr });
    });
  });

const git = async (cwd: string, ...args: readonly string[]): Promise<string> => {
  const result = await runGit(args, cwd);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
};

type Task = { readonly proxy: GitProxy; readonly dir: string; readonly branch: string; readonly hiddenRef: string };

/** A task with its own branch, its proxy (checked unless `commitPaths` is `null`) and its checkout. */
const startTask = async (options: { readonly commitPaths?: readonly string[] | null; readonly objects?: boolean; readonly maxCheckedPushBytes?: number } = {}): Promise<Task> => {
  tasks += 1;
  const taskId = taskIdSchema.parse(`0196f1a0-onboard-${String(tasks)}`);
  const branch = `ostra/onboard-${String(tasks)}`;
  const dir = path.join(root, `task-${String(tasks)}`);
  const proxy = await startGitProxy({
    taskId,
    branch,
    mode: "read-write",
    commitPaths: options.commitPaths === undefined ? ["AGENTS.md"] : options.commitPaths,
    scratchDir: path.join(root, "scratch"),
    ...(options.maxCheckedPushBytes === undefined ? {} : { maxCheckedPushBytes: options.maxCheckedPushBytes }),
    repos: [
      {
        repoId: repoIdSchema.parse("repo-onboard"),
        fullName: repo,
        cloneUrl: upstream.cloneUrl(repo),
        lfsActionHosts: [],
        token: () => Promise.resolve(token),
        objectsDir: () => (options.objects === false ? null : path.join(dir, ".git", "objects")),
      },
    ],
    logger: createLogger((record) => logs.push(record)),
    listenHost: "127.0.0.1",
  });
  proxies.push(proxy);
  await git(root, "clone", "--quiet", proxy.urlFor(repo), dir);
  await git(dir, "checkout", "--quiet", "-b", branch);
  return { proxy, dir, branch, hiddenRef: `refs/ostra/wip/${taskId}` };
};

/** Writes the files given (`null` removes one) and commits them as the agent would. */
const commit = async (dir: string, files: Readonly<Record<string, string | null>>): Promise<string> => {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    if (content === null) {
      await rm(target, { force: true });
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
  await git(dir, "add", "--all");
  await git(dir, "commit", "--quiet", "-m", `change ${Object.keys(files).join(" ")}`);
  return git(dir, "rev-parse", "HEAD");
};

const receivePacks = (): number => upstream.requests.filter((request) => request.repo === repo && request.endpoint === "git-receive-pack").length;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-path-check-"));
  await mkdir(path.join(root, "scratch"));
  const globalConfig = path.join(root, "gitconfig");
  await writeFile(globalConfig, ["[user]", "\tname = Test", "\temail = test@example.test", "[init]", "\tdefaultBranch = main", "[credential]", "\thelper ="].join("\n"));
  gitEnv = { ...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  upstream = await startGitUpstream(path.join(root, "upstream"));
  // Files long enough that git sends a change to them as a delta on the upstream's copy (a thin pack).
  const long = Array.from({ length: 200 }, (_, index) => `line ${String(index)} of a file the agent edits`).join("\n");
  await upstream.createRepo(repo, { "README.md": "# onboard\n", "package.json": `${long}\n`, "AGENTS.md": `${long}\n` });
  token = `ghs_${randomBytes(30).toString("base64url")}`;
  upstream.tokens.set(token, Date.now() + 3_600_000);
}, 60_000);

afterAll(async () => {
  for (const proxy of proxies) {
    await proxy.close();
  }
  await upstream.close();
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe("an onboarding task's pushes through the git proxy (F-113, ADR 0038 as amended 2026-11-21)", () => {
  it("F-113/c4: a push whose commit changes another path is refused in git's words, and nothing of it reaches the code host", async () => {
    const task = await startTask();
    await commit(task.dir, { "AGENTS.md": "# How to work here\n", "package.json": '{ "name": "changed" }\n' });
    const before = receivePacks();
    const pushed = await runGit(["push", "origin", `HEAD:refs/heads/${task.branch}`, `HEAD:${task.hiddenRef}`], task.dir);
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain(`! [remote rejected] HEAD -> ${task.branch} (${ALLOWED})`);
    expect(pushed.stderr).toContain(`(${ALLOWED})`);
    expect(receivePacks()).toBe(before);
    expect(await upstream.refSha(repo, `refs/heads/${task.branch}`)).toBeNull();
    expect(await upstream.refSha(repo, task.hiddenRef)).toBeNull();
    // Logged by its code and counts, never a path.
    expect(logs.some((record) => record.message === "git proxy checked a push's paths" && record.fields["verdict"] === "refused")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("package.json");
  }, 60_000);

  it("F-113/c4: a push whose commits change only AGENTS.md goes through, to the branch and the hidden ref, as a thin pack", async () => {
    const task = await startTask();
    const head = await commit(task.dir, { "AGENTS.md": `${(await git(task.dir, "show", "HEAD:AGENTS.md")).replace("line 7 ", "line seven ")}\n` });
    await commit(task.dir, { "AGENTS.md": "# How to work here\n\nRun `pnpm test`.\n" });
    const tip = await git(task.dir, "rev-parse", "HEAD");
    const pushed = await runGit(["push", "origin", `HEAD:refs/heads/${task.branch}`, `HEAD:${task.hiddenRef}`], task.dir);
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(await upstream.refSha(repo, `refs/heads/${task.branch}`)).toBe(tip);
    expect(await upstream.refSha(repo, task.hiddenRef)).toBe(tip);
    expect(await upstream.fileAt(repo, `refs/heads/${task.branch}`, "AGENTS.md")).toBe("# How to work here\n\nRun `pnpm test`.\n");
    expect(logs.some((record) => record.message === "git proxy checked a push's paths" && record.fields["verdict"] === "allowed" && record.fields["commits"] === 2)).toBe(true);
    expect(head).not.toBe(tip);
    // A ref moved to a commit the code host has now, that changes only AGENTS.md: checked, and taken.
    const again = await runGit(["push", "origin", `${head}:${task.hiddenRef}`, "--force"], task.dir);
    expect(again.code, again.stderr).toBe(0);
    expect(await upstream.refSha(repo, task.hiddenRef)).toBe(head);
  }, 60_000);

  it("F-113/c4: a commit that adds another path is refused even when a later commit of the push takes it out again", async () => {
    const task = await startTask();
    await commit(task.dir, { "scripts/setup.sh": "pnpm install\n" });
    await commit(task.dir, { "scripts/setup.sh": null, "AGENTS.md": "# Notes\n" });
    // The branch's tip changes only AGENTS.md against the base, but its history doesn't.
    expect(await git(task.dir, "diff", "--name-only", "origin/main", "HEAD")).toBe("AGENTS.md");
    const before = receivePacks();
    const pushed = await runGit(["push", "origin", `HEAD:refs/heads/${task.branch}`], task.dir);
    expect(pushed.stderr).toContain(`(${ALLOWED})`);
    expect(receivePacks()).toBe(before);
    expect(await upstream.refSha(repo, `refs/heads/${task.branch}`)).toBeNull();
  }, 60_000);

  it("F-113/c4: the task's branch moved to a commit the code host already has is checked too, so another path can't come in that way", async () => {
    // A commit with another path that's on the code host already: pushed through an unchecked proxy.
    const elsewhere = await startTask({ commitPaths: null });
    const dirty = await commit(elsewhere.dir, { "package.json": '{ "name": "elsewhere" }\n' });
    expect((await runGit(["push", "origin", `HEAD:${elsewhere.hiddenRef}`], elsewhere.dir)).code).toBe(0);
    const task = await startTask();
    await git(task.dir, "fetch", "--quiet", "origin", elsewhere.hiddenRef);
    const before = receivePacks();
    const pushed = await runGit(["push", "origin", `${dirty}:refs/heads/${task.branch}`], task.dir);
    expect(pushed.stderr).toContain(`(${ALLOWED})`);
    expect(receivePacks()).toBe(before);
    expect(await upstream.refSha(repo, `refs/heads/${task.branch}`)).toBeNull();
  }, 60_000);

  it("F-113/c4: a push the proxy can't read is refused, never let through: without the checkout's objects, and past its size", async () => {
    // A change sent as a delta on the upstream's copy needs the checkout's objects to be read.
    const blind = await startTask({ objects: false });
    await commit(blind.dir, { "AGENTS.md": `${(await git(blind.dir, "show", "HEAD:AGENTS.md")).replace("line 9 ", "line nine ")}\n` });
    const before = receivePacks();
    const unread = await runGit(["push", "origin", `HEAD:refs/heads/${blind.branch}`], blind.dir);
    expect(unread.stderr).toContain(`(${UNCHECKED})`);
    // Past the size the proxy holds.
    const big = await startTask({ maxCheckedPushBytes: 64 });
    await commit(big.dir, { "AGENTS.md": "# A longer AGENTS.md than the proxy holds here\n".repeat(20) });
    const tooBig = await runGit(["push", "origin", `HEAD:refs/heads/${big.branch}`], big.dir);
    expect(tooBig.stderr).toContain(`(${UNCHECKED})`);
    expect(receivePacks()).toBe(before);
    expect(await upstream.refSha(repo, `refs/heads/${blind.branch}`)).toBeNull();
    expect(await upstream.refSha(repo, `refs/heads/${big.branch}`)).toBeNull();
  }, 60_000);

  it("F-090: without commitPaths a push streams through unchecked, as for every other task", async () => {
    const task = await startTask({ commitPaths: null });
    const head = await commit(task.dir, { "package.json": '{ "name": "a code task" }\n' });
    const pushed = await runGit(["push", "origin", `HEAD:refs/heads/${task.branch}`], task.dir);
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(await upstream.refSha(repo, `refs/heads/${task.branch}`)).toBe(head);
  }, 60_000);
});
