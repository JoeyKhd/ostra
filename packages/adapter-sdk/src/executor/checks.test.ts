import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkIdSchema, repoIdSchema } from "@ostra/protocol";
import type { TaskSpecCheck } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, describe, expect, it } from "vitest";

import { checkEnvironment, checksToRun, runChecksWith, tailBytes } from "./checks.ts";
import type { RunOneCheck } from "./checks.ts";

// The checks' shared part (ticket 05, ADR 0052, Q188), with a scripted `RunOneCheck`.

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const repoA = repoIdSchema.parse("repo-a");
const repoB = repoIdSchema.parse("repo-b");
const check = (id: string, repoId: TaskSpecCheck["repoId"], timeoutSeconds = 60): TaskSpecCheck => ({
  checkId: checkIdSchema.parse(id),
  name: id,
  command: id,
  repoId,
  timeoutSeconds,
});

describe("which checks a turn runs", () => {
  it("F-054: a check with no repo always runs, one with a repo only when the turn changed it, in order (Q188)", () => {
    const checks = [check("root", null), check("a", repoA), check("b", repoB), check("root-2", null)];
    expect(checksToRun(checks, [repoB]).map((one) => one.checkId)).toEqual(["root", "b", "root-2"]);
    expect(checksToRun(checks, []).map((one) => one.checkId)).toEqual(["root", "root-2"]);
  });
});

describe("a check's output and environment", () => {
  it("F-054: the tail is the last bytes, never starting inside a character", () => {
    expect(tailBytes("abcdef", 3)).toBe("def");
    expect(tailBytes("short", 10)).toBe("short");
    const tail = tailBytes("aé€😀", 5);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(5);
    expect(tail).toBe("😀");
  });

  it("F-054: the environment keeps the environment's variables, and drops credentials and the runner's own by name", () => {
    const env = checkEnvironment({ MY_VAR: "kept", OSTRA_SECRETS_KEY: "x", GITHUB_TOKEN: "x", OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "x" }, "/home/check");
    expect(env["MY_VAR"]).toBe("kept");
    expect(env["HOME"]).toBe("/home/check");
    for (const name of ["OSTRA_SECRETS_KEY", "GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
      expect(env).not.toHaveProperty(name);
    }
  });
});

describe("running the checks", () => {
  const outputDir = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), "ostra-checks-unit-"));
    roots.push(dir);
    return dir;
  };

  it("F-054: runs every check that applies, even after one fails, each in its folder, and keeps its output", async () => {
    const seen: { readonly command: string; readonly cwd: string }[] = [];
    const runOne: RunOneCheck = ({ command, cwd, onOutput }) => {
      seen.push({ command, cwd });
      onOutput(`ran ${command}\n`);
      return Promise.resolve({ exitCode: command === "fails" ? 1 : 0, timedOut: false, error: null });
    };
    const spec = { ...taskSpecFixture, checks: [check("fails", null), check("passes", taskSpecFixture.repos[0]?.repoId ?? null)] };
    const dir = await outputDir();
    const results = await runChecksWith(
      { spec, workspaceDir: "/work", changedRepoIds: spec.repos.map((repo) => repo.repoId), env: {}, outputDir: dir },
      runOne,
    );
    expect(results.map((result) => [result.checkId, result.status])).toEqual([
      ["fails", "failed"],
      ["passes", "passed"],
    ]);
    expect(seen.map((one) => one.cwd)).toEqual(["/work", path.join("/work", "test1")]);
    expect(await readFile(results[0]?.outputPath ?? "", "utf8")).toBe("ran fails\n");
  });

  it("F-054: past the total time, the rest are timed out without running, and a check gets no more than what's left", async () => {
    const timeouts: number[] = [];
    const runOne: RunOneCheck = async ({ timeoutMs }) => {
      timeouts.push(timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { exitCode: 0, timedOut: false, error: null };
    };
    const spec = { ...taskSpecFixture, checks: [check("one", null), check("two", null)] };
    const results = await runChecksWith({ spec, workspaceDir: "/work", changedRepoIds: [], env: {}, outputDir: await outputDir(), totalTimeoutMs: 50 }, runOne);
    expect(results.map((result) => result.status)).toEqual(["passed", "timed-out"]);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(50);
  });

  it("F-054: a check that couldn't start is an error, and a timeout has no exit code", async () => {
    const runOne: RunOneCheck = ({ command }) =>
      Promise.resolve(command === "missing" ? { exitCode: null, timedOut: false, error: "ENOENT" } : { exitCode: 137, timedOut: true, error: null });
    const spec = { ...taskSpecFixture, checks: [check("missing", null), check("hangs", null)] };
    const results = await runChecksWith({ spec, workspaceDir: "/work", changedRepoIds: [], env: {}, outputDir: await outputDir() }, runOne);
    expect(results.map((result) => [result.status, result.exitCode, result.outputTail])).toEqual([
      ["error", null, "ENOENT"],
      ["timed-out", null, ""],
    ]);
  });
});
