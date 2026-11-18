import { readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, gitOut, statusEntries } from "../src/lib/git.ts";
import { hiddenRef, restoreWorkInProgress, saveWorkInProgress } from "../src/lib/hidden-ref.ts";
import { taskId } from "../src/lib/ids.ts";
import { spikeTempDir } from "./temp-dir.ts";

let root = "";
let bare = "";

const clone = async (name: string): Promise<string> => {
  const dir = path.join(root, name);
  await git(["clone", "-q", "-c", "core.autocrlf=false", "--branch", "task", bare, dir], { cwd: root });
  return dir;
};

beforeAll(async () => {
  root = await spikeTempDir("test-hidden-ref-");
  bare = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  await mkdir(seed);
  await git(["init", "-q", "--bare", "-b", "main", bare], { cwd: root });
  await git(["init", "-q", "-b", "main"], { cwd: seed });
  await git(["config", "core.autocrlf", "false"], { cwd: seed });
  await writeFile(path.join(seed, "a.txt"), "a\n");
  await writeFile(path.join(seed, "b.txt"), "b\n");
  await writeFile(path.join(seed, ".gitignore"), "*.log\n");
  await git(["add", "-A"], { cwd: seed });
  await git(["commit", "-q", "-m", "initial"], { cwd: seed });
  await git(["push", "-q", bare, "main:task"], { cwd: seed });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the hidden ref", () => {
  it("rejects task IDs that aren't safe ref names", () => {
    expect(hiddenRef(taskId("task-1"))).toBe("refs/ostra/wip/task-1");
    for (const bad of ["", "../x", "a..b", "a/b", "x.lock", "-x", "a b"]) expect(() => hiddenRef(taskId(bad))).toThrow();
  });

  it("brings back staged, unstaged, deleted and untracked work, and leaves ignored files and the branch alone", async () => {
    const a = await clone("a");
    await writeFile(path.join(a, "a.txt"), "a, edited\n");
    await writeFile(path.join(a, "new.txt"), "new\n");
    await git(["add", "new.txt"], { cwd: a });
    await git(["rm", "-q", "b.txt"], { cwd: a });
    await mkdir(path.join(a, "dir"));
    await writeFile(path.join(a, "dir", "untracked.txt"), "untracked\n");
    await writeFile(path.join(a, "debug.log"), "ignored\n");
    const headBefore = await gitOut(["rev-parse", "HEAD"], { cwd: a });
    const indexBefore = await gitOut(["write-tree"], { cwd: a });

    const saved = await saveWorkInProgress({ workspace: a, remote: "origin", task: taskId("t1"), turn: 1 });
    expect(saved.clean).toBe(false);
    expect(await gitOut(["rev-parse", "HEAD"], { cwd: a })).toBe(headBefore);
    expect(await gitOut(["write-tree"], { cwd: a })).toBe(indexBefore);
    expect(await gitOut(["ls-remote", bare, "refs/heads/task"], { cwd: root })).toContain(headBefore);

    const b = await clone("b");
    expect(await gitOut(["for-each-ref", "refs/ostra"], { cwd: b })).toBe("");
    const restored = await restoreWorkInProgress({ workspace: b, remote: "origin", task: taskId("t1") });
    expect(restored?.commit).toBe(saved.commit);
    expect([...(restored?.status ?? [])].sort()).toEqual([...saved.status].sort());
    expect(await readFile(path.join(b, "a.txt"), "utf8")).toBe("a, edited\n");
    expect(await readFile(path.join(b, "dir", "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(await stat(path.join(b, "b.txt")).catch(() => undefined)).toBeUndefined();
    expect(await stat(path.join(b, "debug.log")).catch(() => undefined)).toBeUndefined();
  });

  it("returns undefined when there is no hidden ref, and refuses one saved on another commit", async () => {
    const c = await clone("c");
    expect(await restoreWorkInProgress({ workspace: c, remote: "origin", task: taskId("none") })).toBeUndefined();
    await writeFile(path.join(c, "a.txt"), "moved\n");
    await git(["commit", "-q", "-am", "move the branch"], { cwd: c });
    await expect(restoreWorkInProgress({ workspace: c, remote: "origin", task: taskId("t1") })).rejects.toThrow(/another commit/);
    expect(await statusEntries(c)).toEqual([]);
  });
});
