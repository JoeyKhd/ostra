import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { taskIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hiddenRefFor, localWipFiles, localWipGit, pushRefusalReason, restoreWorkInProgressIn, saveWorkInProgressIn } from "./work-in-progress.ts";
import type { WipDeps } from "./work-in-progress.ts";

// The hidden ref against real git (ADR 0039, Q150), on a local bare remote: what comes back on a
// fresh clone, a branch that moved since the save, and one whose new commits conflict.

let root = "";
let remote = "";
const BRANCH = "ostra/ost-12-task";

const env = (): Record<string, string> => {
  const keep: Record<string, string> = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    const value = process.env[name];
    if (value !== undefined) keep[name] = value;
  }
  return {
    ...keep,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: root,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.test",
  };
};

const run = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await localWipGit(cwd, env())(args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

let clones = 0;
/** A fresh clone of the task's branch, as a fresh box makes. */
const freshBox = async (): Promise<{ readonly dir: string; readonly deps: WipDeps }> => {
  clones += 1;
  const dir = path.join(root, `box-${String(clones)}`);
  await run(root, "clone", "--quiet", "--branch", BRANCH, remote, dir);
  return { dir, deps: { git: localWipGit(dir, env()), files: localWipFiles } };
};

const read = async (dir: string, file: string): Promise<string | null> => {
  try {
    return (await readFile(path.join(dir, file), "utf8")).replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
};

let taskCounter = 0;
const newTask = () => {
  taskCounter += 1;
  return taskIdSchema.parse(`wip-task-${String(taskCounter)}`);
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ostra-wip-"));
  remote = path.join(root, "remote.git");
  await run(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  const seed = path.join(root, "seed");
  await run(root, "clone", "--quiet", remote, seed);
  await run(seed, "checkout", "--quiet", "-b", "main");
  await writeFile(path.join(seed, "a.txt"), "a\n");
  await writeFile(path.join(seed, "b.txt"), "b\n");
  await mkdir(path.join(seed, "src"));
  await writeFile(path.join(seed, "src", "c.txt"), "c\n");
  await run(seed, "add", "-A");
  await run(seed, "commit", "--quiet", "-m", "seed");
  await run(seed, "push", "--quiet", "origin", "main");
  await run(seed, "push", "--quiet", "origin", `main:refs/heads/${BRANCH}`);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Makes every kind of work in progress in a box, and saves it. */
const workAndSave = async (taskId: ReturnType<typeof newTask>) => {
  const box = await freshBox();
  await writeFile(path.join(box.dir, ".gitignore"), "ignored.log\n");
  await writeFile(path.join(box.dir, "ignored.log"), "never saved");
  await writeFile(path.join(box.dir, "untracked.txt"), "untracked\n");
  await writeFile(path.join(box.dir, "staged.txt"), "staged\n");
  await run(box.dir, "add", "staged.txt");
  await writeFile(path.join(box.dir, "a.txt"), "a, changed\n");
  await unlink(path.join(box.dir, "b.txt"));
  const saved = await saveWorkInProgressIn(box.deps, { taskId, turnOrdinal: 1, remote: "origin" });
  if (!saved.ok || saved.value === null) throw new Error("the save failed");
  return { box, saved: saved.value };
};

describe("the hidden ref", () => {
  it("names a ref under refs/ostra/wip, and refuses a task ID that can't", () => {
    expect(hiddenRefFor(taskIdSchema.parse("0196f1a0-0000-7000-8000-000000000004"))).toBe("refs/ostra/wip/0196f1a0-0000-7000-8000-000000000004");
    expect(() => hiddenRefFor(taskIdSchema.parse("a..b"))).toThrow();
  });

  it("saves untracked, staged, unstaged and deleted work, never touching the branch, and a fresh box gets it back as it was", async () => {
    const taskId = newTask();
    const { box, saved } = await workAndSave(taskId);
    expect(saved.clean).toBe(false);
    // The branch and the real index are untouched.
    expect(await run(box.dir, "rev-parse", "HEAD")).toBe(saved.baseSha);
    expect(await run(remote, "rev-parse", `refs/heads/${BRANCH}`)).toBe(saved.baseSha);
    expect(await run(remote, "rev-parse", hiddenRefFor(taskId))).toBe(saved.sha);

    const fresh = await freshBox();
    const restored = await restoreWorkInProgressIn(fresh.deps, { taskId, remote: "origin", branch: BRANCH });
    expect(restored).toEqual({ ok: true, value: { outcome: "applied", sha: saved.sha, baseSha: saved.baseSha, merged: false } });
    expect(await read(fresh.dir, "untracked.txt")).toBe("untracked\n");
    expect(await read(fresh.dir, "staged.txt")).toBe("staged\n");
    expect(await read(fresh.dir, "a.txt")).toBe("a, changed\n");
    expect(await read(fresh.dir, "b.txt")).toBeNull();
    expect(await read(fresh.dir, "ignored.log")).toBeNull();
    // Untrimmed: a status line can start with a space.
    const status = (await localWipGit(fresh.dir, env())(["status", "--porcelain=v1", "--untracked-files=all"])).stdout.split("\n");
    expect(status).toEqual(expect.arrayContaining(["A  staged.txt", "?? untracked.txt", " M a.txt", " D b.txt"]));
  }, 60_000);

  it("replaces the ref with each save", async () => {
    const taskId = newTask();
    const box = await freshBox();
    await writeFile(path.join(box.dir, "turn.txt"), "1");
    const one = await saveWorkInProgressIn(box.deps, { taskId, turnOrdinal: 1, remote: "origin" });
    await writeFile(path.join(box.dir, "turn.txt"), "2");
    const two = await saveWorkInProgressIn(box.deps, { taskId, turnOrdinal: 2, remote: "origin" });
    expect(one.ok && two.ok && one.value?.sha !== two.value?.sha).toBe(true);
    const fresh = await freshBox();
    await restoreWorkInProgressIn(fresh.deps, { taskId, remote: "origin", branch: BRANCH });
    expect(await read(fresh.dir, "turn.txt")).toBe("2");
  }, 60_000);

  it("answers none when the task has no hidden ref", async () => {
    const fresh = await freshBox();
    expect(await restoreWorkInProgressIn(fresh.deps, { taskId: newTask(), remote: "origin", branch: BRANCH })).toEqual({ ok: true, value: { outcome: "none" } });
  }, 60_000);

  it("restores onto the saved commit and merges a branch that moved since (Q150)", async () => {
    const taskId = newTask();
    const { saved } = await workAndSave(taskId);
    // A reviewer's suggestion lands on the branch, touching another file.
    const reviewer = await freshBox();
    await writeFile(path.join(reviewer.dir, "src", "c.txt"), "c, from review\n");
    await run(reviewer.dir, "commit", "--quiet", "-am", "review suggestion");
    await run(reviewer.dir, "push", "--quiet", "origin", BRANCH);
    const moved = await run(reviewer.dir, "rev-parse", "HEAD");

    const fresh = await freshBox();
    const restored = await restoreWorkInProgressIn(fresh.deps, { taskId, remote: "origin", branch: BRANCH });
    expect(restored).toEqual({ ok: true, value: { outcome: "applied", sha: saved.sha, baseSha: saved.baseSha, merged: true } });
    // On the branch, at its head, with the work and the review both there.
    expect(await run(fresh.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(await run(fresh.dir, "rev-parse", "HEAD")).toBe(moved);
    expect(await read(fresh.dir, "src/c.txt")).toBe("c, from review\n");
    expect(await read(fresh.dir, "a.txt")).toBe("a, changed\n");
    expect(await read(fresh.dir, "untracked.txt")).toBe("untracked\n");
    expect(await read(fresh.dir, "b.txt")).toBeNull();
  }, 60_000);

  it("on a conflict restores nothing and leaves the branch's head checked out", async () => {
    const taskId = newTask();
    await workAndSave(taskId);
    const reviewer = await freshBox();
    await writeFile(path.join(reviewer.dir, "a.txt"), "a, from review\n");
    await run(reviewer.dir, "commit", "--quiet", "-am", "a conflicting change");
    await run(reviewer.dir, "push", "--quiet", "origin", BRANCH);
    const head = await run(reviewer.dir, "rev-parse", "HEAD");

    const fresh = await freshBox();
    const restored = await restoreWorkInProgressIn(fresh.deps, { taskId, remote: "origin", branch: BRANCH });
    expect(restored.ok && restored.value.outcome).toBe("conflict");
    expect(await run(fresh.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(await run(fresh.dir, "rev-parse", "HEAD")).toBe(head);
    expect(await run(fresh.dir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    expect(await read(fresh.dir, "a.txt")).toBe("a, from review\n");
  }, 60_000);

  it("F-033/c7: reads a hidden ref that's a branch head, as a box lost before its save leaves it, as nothing unsaved: none while the branch holds it, a conflict once it doesn't", async () => {
    // The after-turn push points the ref at the branch's head (a merge the agent made, here), and the box is lost before its save.
    const taskId = newTask();
    const box = await freshBox();
    await run(box.dir, "checkout", "--quiet", "-b", "side");
    await writeFile(path.join(box.dir, "side.txt"), "side\n");
    await run(box.dir, "add", "-A");
    await run(box.dir, "commit", "--quiet", "-m", "a side commit");
    await run(box.dir, "checkout", "--quiet", BRANCH);
    await writeFile(path.join(box.dir, "turn.txt"), "the turn\n");
    await run(box.dir, "add", "-A");
    await run(box.dir, "commit", "--quiet", "-m", "the turn");
    await run(box.dir, "merge", "--quiet", "--no-edit", "--no-ff", "side");
    const head = await run(box.dir, "rev-parse", "HEAD");
    await run(box.dir, "push", "--quiet", "origin", `+HEAD:refs/heads/${BRANCH}`, `+HEAD:${hiddenRefFor(taskId)}`);

    const fresh = await freshBox();
    expect(await restoreWorkInProgressIn(fresh.deps, { taskId, remote: "origin", branch: BRANCH })).toEqual({ ok: true, value: { outcome: "none" } });
    expect(await run(fresh.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(await run(fresh.dir, "rev-parse", "HEAD")).toBe(head);
    expect(await run(fresh.dir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");

    // A reviewer's commit on top: still held, still nothing to restore.
    await writeFile(path.join(fresh.dir, "review.txt"), "review\n");
    await run(fresh.dir, "add", "-A");
    await run(fresh.dir, "commit", "--quiet", "-m", "review");
    await run(fresh.dir, "push", "--quiet", "origin", BRANCH);
    const onTop = await freshBox();
    expect(await restoreWorkInProgressIn(onTop.deps, { taskId, remote: "origin", branch: BRANCH })).toEqual({ ok: true, value: { outcome: "none" } });
    expect(await read(onTop.dir, "turn.txt")).toBe("the turn\n");

    // A branch rewritten without it has lost that work: a conflict, the branch's head left checked out.
    await run(onTop.dir, "reset", "--quiet", "--hard", `${head}~1`);
    await run(onTop.dir, "push", "--quiet", "--force", "origin", BRANCH);
    const rewritten = await freshBox();
    expect(await restoreWorkInProgressIn(rewritten.deps, { taskId, remote: "origin", branch: BRANCH })).toEqual({ ok: true, value: { outcome: "conflict", sha: head, baseSha: head } });
    expect(await read(rewritten.dir, "side.txt")).toBeNull();
    expect(await run(rewritten.dir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  }, 60_000);
});

describe("a refused save", () => {
  it("names git's own reason for a refused push, and nothing else of its output", () => {
    const output = [
      "To http://127.0.0.1:52001/s3cr3t-proxy-path/ostra-test/test1.git",
      " ! [remote rejected] 0de3db5 -> refs/ostra/wip/task-1 (stale info)",
      "error: failed to push some refs to 'http://127.0.0.1:52001/s3cr3t-proxy-path/ostra-test/test1.git'",
    ].join("\n");
    expect(pushRefusalReason(output)).toBe("stale info");
    expect(pushRefusalReason(" ! [rejected]        abc -> refs/ostra/wip/task-1 (fetch first)")).toBe("fetch first");
    // Only the reason in brackets, never a line that holds the proxy's address.
    expect(pushRefusalReason("fatal: unable to access 'http://127.0.0.1:52001/s3cr3t-proxy-path/': Failed to connect")).toBeNull();
    expect(pushRefusalReason(" ! [remote rejected] a -> b (see http://x.invalid/y)")).toBeNull();
  });
});
