import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAlive } from "@ostra/adapter-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessInfo } from "@ostra/adapter-sdk";
import { cgroupContainment, detectContainment, jobObjectContainment, ownCgroupPath } from "./containment.ts";
import type { JobObjects } from "./job-object.ts";

// The containment seam (ADR 0029, Q126). The cgroup unit runs only on a Linux runner with a
// delegated cgroup; here it's checked against a folder that stands in for one.

let root = "";

afterEach(async () => {
  if (root !== "") {
    await rm(root, { recursive: true, force: true });
    root = "";
  }
});

describe("containment", () => {
  it("reads the runner's own cgroup v2 path", () => {
    expect(ownCgroupPath("12:pids:/x\n0::/user.slice/user-1000.slice/session-2.scope\n")).toBe("/user.slice/user-1000.slice/session-2.scope");
    expect(ownCgroupPath("1:name=systemd:/x\n")).toBeNull();
  });

  it("uses the process tree on macOS, and on Linux without a delegated cgroup", async () => {
    expect((await detectContainment({ platform: "darwin", cgroupRoot: "/nope", readSelfCgroup: () => Promise.resolve("") })).kind).toBe("process-tree");
    const failing = await detectContainment({ platform: "linux", cgroupRoot: "/nope", readSelfCgroup: () => Promise.reject(new Error("no /proc")) });
    expect(failing.kind).toBe("process-tree");
  });

  it("uses a cgroup on Linux when the runner's cgroup lets it make one with cgroup.kill", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ostra-cgroup-"));
    const own = path.join(root, "user.slice", "runner.scope");
    await mkdir(own, { recursive: true });
    // A fake cgroupfs makes `cgroup.kill` in every new child; a plain folder doesn't, so the probe
    // finds it missing and falls back. Both outcomes are checked.
    expect((await detectContainment({ platform: "linux", cgroupRoot: root, readSelfCgroup: () => Promise.resolve("0::/user.slice/runner.scope\n") })).kind).toBe("process-tree");
  });

  it("puts the agent in its own cgroup, and ends it through cgroup.kill and its tree", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ostra-cgroup-"));
    const unit = await cgroupContainment(root).create("task/1-box:1");
    const dir = path.join(root, "ostra-task_1-box_1");
    expect((await stat(dir)).isDirectory()).toBe(true);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    // A stand-in folder: cgroup.procs and cgroup.kill only record what was written to them.
    await unit.adopt(pid);
    expect(await readFile(path.join(dir, "cgroup.procs"), "utf8")).toBe(`${String(pid)}\n`);
    await unit.killAll();
    expect(await readFile(path.join(dir, "cgroup.kill"), "utf8")).toBe("1\n");
    await exited;
    expect(isAlive(pid)).toBe(false);
    await unit.dispose();
  });
});

describe("a Windows job's adoption", () => {
  // A job and a process listing faked: what's checked is which PIDs adoption puts in the job.
  const fakeJobs = (assigned: number[]): JobObjects => ({
    create: () => ({
      assign: (pid) => {
        assigned.push(pid);
        return true;
      },
      pids: () => [],
      terminate: () => true,
      close: () => undefined,
    }),
  });
  const proc = (pid: number, ppid: number, startedAt: number): ProcessInfo => ({ pid, ppid, name: "node.exe", startedAt });
  const adopt = async (listing: (adoptedAt: number) => readonly ProcessInfo[], exited?: Promise<{ readonly code: number | null; readonly signal: null }>): Promise<number[]> => {
    const assigned: number[] = [];
    let adoptedAt = 0;
    const unit = await jobObjectContainment(fakeJobs(assigned), {
      sweep: () => Promise.resolve(0),
      listProcesses: () => Promise.resolve(listing(adoptedAt)),
    }).create("task", "ostra-unit-0123456789abcdef01234567");
    adoptedAt = Date.now();
    await unit.adopt(100, exited === undefined ? {} : { exited });
    return assigned;
  };

  it("F-014: puts in the job what the process started before it was assigned, and no older process that names its PID as a parent", async () => {
    const assigned = await adopt((at) => [proc(100, 1, at - 20), proc(101, 100, at - 10), proc(102, 101, at - 5), proc(103, 100, at - 60_000)]);
    // 103 names 100 as its parent but is older than it: the child of an earlier process with that PID.
    expect(assigned).toEqual([100, 101, 102]);
  });

  it("F-014: assigns nothing more when the PID is another process's by the listing, or the process has exited", async () => {
    // The process at PID 100 was born after the adoption: ours exited, and Windows gave the PID on.
    expect(await adopt((at) => [proc(100, 1, at + 2_000), proc(101, 100, at + 2_100)])).toEqual([100]);
    // Ours exited before the listing came back.
    expect(await adopt((at) => [proc(100, 1, at - 20), proc(101, 100, at - 10)], Promise.resolve({ code: 3, signal: null }))).toEqual([100]);
    // And a listing without it.
    expect(await adopt(() => [proc(101, 100, 1)])).toEqual([100]);
  });
});
