import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { agentLaunches, descendantsOf, listProcesses, namesOutside, parseEnvironmentEntries, readEnvironments } from "./agent-process.ts";
import type { ProcessEnvironment, ProcessInfo } from "./agent-process.ts";

const proc = (pid: number, ppid: number, name = "p"): ProcessInfo => ({ pid, ppid, name });

describe("descendantsOf", () => {
  it("finds children at any depth, and not the root, its parent or its siblings", () => {
    const all = [proc(1, 0), proc(2, 1), proc(3, 2), proc(4, 3), proc(5, 1), proc(9, 8), proc(10, 0)];
    expect(
      descendantsOf(all, 2)
        .map((item) => item.pid)
        .sort(),
    ).toEqual([3, 4]);
  });

  it("stops on a cycle", () => {
    expect(descendantsOf([proc(1, 2), proc(2, 1)], 1).map((item) => item.pid)).toEqual([2]);
  });
});

describe("parseEnvironmentEntries", () => {
  it("splits at the first equals sign, and leaves out a drive's working directory", () => {
    const parsed = parseEnvironmentEntries(["A=1", "B=x=y", "=C:=C:\\", "EMPTY="]);
    expect([...parsed.entries()]).toEqual([
      ["A", "1"],
      ["B", "x=y"],
      ["EMPTY", ""],
    ]);
  });
});

const env = (...names: string[]): ProcessEnvironment => new Map(names.map((name) => [name, "v"]));

describe("agentLaunches", () => {
  it("is the topmost process with the adapter's marker: its shells inherit the marker and are not launches", () => {
    const processes = [proc(10, 1, "opencode"), proc(11, 10, "bash"), proc(12, 11, "node"), proc(20, 1, "other")];
    const environments = new Map<number, ProcessEnvironment>([
      [10, env("OPENCODE_MODELS_PATH")],
      [11, env("OPENCODE_MODELS_PATH", "SHLVL")],
      [12, env("OPENCODE_MODELS_PATH")],
      [20, env("PATH")],
    ]);
    expect(agentLaunches(processes, environments).map((item) => item.pid)).toEqual([10]);
  });

  it("is empty when no environment could be read", () => {
    expect(agentLaunches([proc(10, 1)], new Map())).toEqual([]);
  });
});

describe("namesOutside", () => {
  it("lists the names not allowed, sorted", () => {
    expect(namesOutside(env("PATH", "ZED", "AWS_KEY"), ["PATH"])).toEqual(["AWS_KEY", "ZED"]);
  });
});

describe("the live environment of a process", () => {
  it("reads the variables a child was launched with", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      env: { OSTRA_E2E_PROBE: "probe-value", PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "" },
      stdio: "ignore",
    });
    try {
      const pid = child.pid;
      if (pid === undefined) throw new Error("no pid");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const environments = await readEnvironments([pid]);
      if (process.platform === "win32" || process.platform === "linux") {
        expect(environments.get(pid)?.get("OSTRA_E2E_PROBE")).toBe("probe-value");
      } else {
        expect(environments.size).toBe(0);
      }
      const below = descendantsOf(await listProcesses(), process.pid);
      expect(below.map((item) => item.pid)).toContain(pid);
    } finally {
      child.kill();
    }
  }, 60_000);
});
