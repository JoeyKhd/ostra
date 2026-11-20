import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runnerLimits } from "@ostra/protocol";
import { afterAll, describe, expect, it } from "vitest";

import { splitByCommitPaths, stageCommitPaths } from "./commit-paths.ts";

const run = promisify(execFile);
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const git = async (cwd: string, ...args: string[]): Promise<string> => (await run("git", args, { cwd, windowsHide: true })).stdout;

const repoWith = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "ostra-commit-paths-"));
  roots.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "ostra@example.test");
  await git(root, "config", "user.name", "ostra");
  await writeFile(path.join(root, "README.md"), "# repo\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "first");
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
};

describe("a commit's paths", () => {
  it("F-113/c3: keeps exact paths and globs, everything when the list is null", () => {
    const changed = ["AGENTS.md", "docs/AGENTS.md", "src/index.ts", "src/deep/x.ts", "package.json"];
    expect(splitByCommitPaths(changed, null)).toEqual({ kept: changed, dropped: [] });
    expect(splitByCommitPaths(changed, ["AGENTS.md"])).toEqual({ kept: ["AGENTS.md"], dropped: ["docs/AGENTS.md", "src/index.ts", "src/deep/x.ts", "package.json"] });
    expect(splitByCommitPaths(changed, ["**/AGENTS.md", "src/*.ts"]).kept).toEqual(["AGENTS.md", "docs/AGENTS.md", "src/index.ts"]);
  });

  it("F-113/c3: a turn's commit with commitPaths stages only those; the other changes stay in the workspace, uncommitted and counted", async () => {
    const repo = await repoWith({ "AGENTS.md": "# Agents\n", "src/setup.ts": "export {};\n", "notes.txt": "scratch\n" });
    await writeFile(path.join(repo, "README.md"), "# repo, edited\n");
    const staged = await stageCommitPaths(repo, ["AGENTS.md"]);
    expect(staged.kept).toEqual(["AGENTS.md"]);
    expect([...staged.dropped].sort()).toEqual(["README.md", "notes.txt", "src/setup.ts"]);
    expect(staged.droppedCount).toBe(3);
    await git(repo, "commit", "-q", "-m", "Add AGENTS.md");
    expect((await git(repo, "show", "--name-only", "--format=", "HEAD")).trim().split("\n")).toEqual(["AGENTS.md"]);
    // The rest is still there, as the agent left it.
    const left = (await git(repo, "status", "--porcelain", "--untracked-files=all")).trimEnd().split("\n").map((line) => line.slice(3)).sort();
    expect(left).toEqual(["README.md", "notes.txt", "src/setup.ts"]);
  });

  it("F-113/c3: the dropped paths are cut to the protocol's limit, with their full count", async () => {
    const many = Object.fromEntries(Array.from({ length: runnerLimits.commitFilteredPathsMax + 7 }, (_, index) => [`gen/file-${String(index)}.txt`, "x\n"]));
    const repo = await repoWith({ ...many, "AGENTS.md": "# Agents\n" });
    const staged = await stageCommitPaths(repo, ["AGENTS.md"]);
    expect(staged.kept).toEqual(["AGENTS.md"]);
    expect(staged.dropped).toHaveLength(runnerLimits.commitFilteredPathsMax);
    expect(staged.droppedCount).toBe(runnerLimits.commitFilteredPathsMax + 7);
  });
});
