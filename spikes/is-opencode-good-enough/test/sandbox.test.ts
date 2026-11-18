import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { exec, git } from "../src/runner/exec.ts";
import { findLeftovers, findOwned, sweep, type OwnedProcess, type SpawnSpan } from "../src/runner/processes.ts";
import { cleanEnv, cleanWorkRoot } from "../src/runner/sandbox.ts";
import { prepareVerifyDir, runCi } from "../src/runner/checks.ts";
import { collectDiff, initWorkspace, removeDir, SAMPLE_REPO } from "../src/runner/workspace.ts";
import { isAlive, killTree, type ProcessInfo } from "../src/lib/process-tree.ts";

const run = promisify(execFile);

afterAll(async () => {
  await cleanWorkRoot();
});

const exists = async (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

const forward = (file: string): string => file.replaceAll("\\", "/");

describe("the environment of what runs agent code", () => {
  it("is an allowlist: a variable of the harness's own shell does not reach the child", async () => {
    process.env["PROBE_SECRET"] = "not-for-agents";
    const dir = await mkdtemp(path.join(os.tmpdir(), "env-"));
    try {
      const result = await exec(process.execPath, ["-e", "console.log(String(process.env.PROBE_SECRET), process.env.HOME === process.argv[1])", dir], { cwd: dir, timeoutMs: 20_000, env: cleanEnv(dir) });
      expect(result.stdout.trim()).toBe("undefined true");
    } finally {
      delete process.env["PROBE_SECRET"];
      await removeDir(dir);
    }
  });

  it("holds for the agent's own tests run by the CI check", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ci-env-"));
    process.env["PROBE_SECRET"] = "not-for-agents";
    try {
      const verify = await prepareVerifyDir(path.join(dir, "verify"), SAMPLE_REPO, { withAcceptance: false });
      await writeFile(
        path.join(verify.repo, "test", "probe.test.ts"),
        'import { it } from "node:test";\nimport { writeFileSync } from "node:fs";\n\nit("probe", () => {\n  writeFileSync("probe-out.txt", String(process.env["PROBE_SECRET"]));\n});\n',
      );
      await runCi(verify);
      expect(await readFile(path.join(verify.repo, "probe-out.txt"), "utf8")).toBe("undefined");
    } finally {
      delete process.env["PROBE_SECRET"];
      await removeDir(dir);
    }
  });
});

describe("git in the harness", () => {
  it("runs no hook, even one in the repository's own hooks folder", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "git-hook-"));
    try {
      await git(dir, ["init", "-q", "-b", "main"]);
      const marker = path.join(dir, "hook-ran.txt");
      await writeFile(path.join(dir, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho ran > "${forward(marker)}"\nexit 1\n`);
      // The control: plain git runs the hook (and the hook's exit 1 refuses the commit).
      await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: dir }).catch(() => undefined);
      expect(await exists(marker)).toBe(true);
      await rm(marker);
      // The commit has no --no-verify: only the hooks folder the harness points git at keeps the hook from running.
      await git(dir, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "x"]);
      expect(await exists(marker)).toBe(false);
    } finally {
      await removeDir(dir);
    }
  });
});

describe("the diff of what an agent left", () => {
  const prepare = async (): Promise<{ dir: string; workspace: string; marker: string }> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "diff-"));
    const workspace = path.join(dir, "workspace");
    await initWorkspace(workspace, "ostra/calc-1");
    return { dir, workspace, marker: path.join(dir, "ran.txt") };
  };

  it("is taken without opening the agent's repository: a hook and a clean filter left in it never run", async () => {
    const { dir, workspace, marker } = await prepare();
    try {
      const filter = path.join(dir, "filter.sh");
      await writeFile(filter, `#!/bin/sh\necho filter > "${forward(marker)}"\ncat\n`);
      await writeFile(path.join(workspace, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho hook > "${forward(marker)}"\nexit 1\n`);
      await writeFile(path.join(workspace, ".gitattributes"), "src/format.ts filter=evil\n");
      await run("git", ["config", "filter.evil.clean", `sh ${forward(filter)}`], { cwd: workspace });
      await writeFile(path.join(workspace, "src", "format.ts"), `${await readFile(path.join(workspace, "src", "format.ts"), "utf8")}\nexport const added = 1;\n`);

      // The control: plain git, the way a careless harness would call it, does run what the agent left.
      await run("git", ["add", "-A"], { cwd: workspace });
      expect(await exists(marker)).toBe(true);
      await run("git", ["reset", "-q"], { cwd: workspace });
      await rm(marker, { force: true });

      const diff = await collectDiff(workspace, path.join(dir, "verify"));
      expect(await exists(marker)).toBe(false);
      expect(diff.files.map((f) => f.path)).toContain("src/format.ts");
      expect(diff.patch).toContain("export const added = 1;");
      expect(diff.touchedSource).toBe(true);
    } finally {
      await removeDir(dir);
    }
  });

  it("is empty for a workspace that changed nothing, and says so, never because a commit failed", async () => {
    const { dir, workspace } = await prepare();
    try {
      const diff = await collectDiff(workspace, path.join(dir, "verify"));
      expect(diff.patch).toBe("");
      expect(diff.files).toEqual([]);
      expect(diff.touchedSource).toBe(false);
    } finally {
      await removeDir(dir);
    }
  });

  it("sees a file the agent added, one it deleted, and a change under test/ that leaves src/ alone", async () => {
    const { dir, workspace } = await prepare();
    try {
      await mkdir(path.join(workspace, "test"), { recursive: true });
      await writeFile(path.join(workspace, "test", "history.test.ts"), "// new\n");
      await rm(path.join(workspace, "README.md"));
      const diff = await collectDiff(workspace, path.join(dir, "verify"));
      expect(diff.files.map((f) => f.path).sort()).toEqual(["README.md", "test/history.test.ts"]);
      expect(diff.touchedSource).toBe(false);
    } finally {
      await removeDir(dir);
    }
  });
});

const proc = (pid: number, ppid: number, name: string, startedAt: number, commandLine = ""): ProcessInfo => ({ pid, ppid, name, commandLine, rssBytes: 0, startedAt });

describe("whose a process is, at the final sweep", () => {
  const folders: string[] = [];
  const base = { active: new Map<number, number>(), folders, selfPid: 1 };
  const span = (spawnedAt: number, endedAt?: number): SpawnSpan => ({ spawnedAt, endedAt });
  const pids = (owned: readonly OwnedProcess[]): number[] => owned.map((o) => o.process.pid).sort((a, b) => a - b);

  it("includes a program created by one the harness spawned that has since exited (a looping test its runner left behind), and what that created, but never a console host", () => {
    const owned = findOwned({
      ...base,
      ever: new Map([[100, span(1_000_000, 1_004_000)]]),
      processes: [proc(900, 100, "node.exe", 1_001_000, "node loop.js"), proc(901, 900, "node.exe", 1_001_500, "node child.js"), proc(902, 4, "node.exe", 1_001_000, "node unrelated.js"), proc(903, 100, "conhost.exe", 1_001_000, "conhost 0x4")],
    });
    expect(pids(owned)).toEqual([900, 901]);
    expect(owned.every((o) => o.reason === "descendant")).toBe(true);
  });

  it("leaves a process alone when its parent's PID was reused by another program: a child created after the harness's child ended", () => {
    const owned = findOwned({
      ...base,
      ever: new Map([[100, span(1_000_000, 1_004_000)]]),
      processes: [proc(950, 100, "node.exe", 9_001_000, "node somebody-elses.js")],
    });
    expect(owned).toEqual([]);
  });

  it("leaves a process alone when its parent's PID is alive and was created at another time", () => {
    const owned = findOwned({
      ...base,
      ever: new Map([[100, span(1_000_000, undefined)]]),
      processes: [proc(100, 4, "other.exe", 9_000_000), proc(950, 100, "node.exe", 9_001_000)],
    });
    expect(owned).toEqual([]);
  });

  it("leaves a process alone that is older than the parent PID's spawn", () => {
    expect(findOwned({ ...base, ever: new Map([[100, span(5_000_000)]]), processes: [proc(950, 100, "node.exe", 1_000_000)] })).toEqual([]);
  });

  it("includes what is still alive from a tracked child, and what names a harness folder", () => {
    const owned = findOwned({
      ...base,
      active: new Map([[200, 2_000_000]]),
      ever: new Map([[200, span(2_000_000)]]),
      folders: ["C:/temp/ostra-spike-10/p1"],
      processes: [proc(200, 1, "git.exe", 2_000_500), proc(300, 1, "node.exe", 3_000_000, "node C:/temp/ostra-spike-10/p1/run/x.js"), proc(400, 1, "node.exe", 3_000_000, "node elsewhere.js")],
    });
    expect(pids(owned)).toEqual([200, 300]);
    expect(owned.map((o) => o.reason).sort()).toEqual(["folder", "tracked"]);
  });
});

describe("a process an agent's test left behind", () => {
  it("is found by the sweep although its parent has exited and nothing in its command line names a folder", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orphan-"));
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });",
      "console.log(child.pid);",
      "child.unref();",
    ].join("\n");
    let orphan = 0;
    try {
      const result = await exec(process.execPath, ["-e", script], { cwd: dir, timeoutMs: 20_000, env: cleanEnv(dir) });
      orphan = Number(result.stdout.trim());
      expect(Number.isInteger(orphan) && orphan > 0).toBe(true);
      expect(isAlive(orphan)).toBe(true);
      const found = await findLeftovers([]);
      expect(found.map((o) => o.process.pid)).toContain(orphan);
      expect(found.find((o) => o.process.pid === orphan)?.reason).toBe("descendant");
      await sweep([]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(isAlive(orphan)).toBe(false);
    } finally {
      if (orphan > 0 && isAlive(orphan)) await killTree(orphan);
      await removeDir(dir);
    }
  });
});
