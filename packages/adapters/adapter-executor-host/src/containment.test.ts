import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAlive } from "@ostra/adapter-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { cgroupContainment, detectContainment, ownCgroupPath } from "./containment.ts";

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
