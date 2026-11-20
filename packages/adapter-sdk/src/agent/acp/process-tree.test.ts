import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { descendantsOf, isAlive, watchProcessTree } from "./process-tree.ts";

// A cancelled turn's reap (ticket 42): the processes born during the turn end, and with a unit
// that can list its processes (a Windows job, a cgroup), the ones that left the agent's tree too.

const started: ChildProcess[] = [];

const idle = (): ChildProcess => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  started.push(child);
  return child;
};

const pidOf = (child: ChildProcess): number => {
  if (child.pid === undefined) {
    throw new Error("no pid");
  }
  return child.pid;
};

const goneWithin = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
};

afterEach(() => {
  // Through each child's own handle: a reaped child's PID may already be another process's.
  for (const child of started.splice(0)) {
    child.kill("SIGKILL");
  }
});

describe("a cancelled turn's reap", () => {
  it("F-014/c6: ends the unit's processes born during the turn, outside the agent's tree too, and spares the older ones", async () => {
    const agent = idle();
    const older = idle();
    // Start times are kept to the second on some systems: the turn starts clearly after `older`.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const watch = watchProcessTree(pidOf(agent));
    const turnStartedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Born during the turn, and not the agent's child: a process that left the tree.
    const detached = idle();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Without the unit's list, the reap can't see it.
    await watch.reapBornSince(turnStartedAt);
    expect(isAlive(pidOf(detached))).toBe(true);

    await watch.reapBornSince(turnStartedAt, [pidOf(detached), pidOf(older), pidOf(agent)]);
    expect(await goneWithin(pidOf(detached), 5_000)).toBe(true);
    expect(isAlive(pidOf(older))).toBe(true);
    expect(isAlive(pidOf(agent))).toBe(true);
  }, 30_000);

  it("F-023: a reap that ends at the turn's end spares the processes born after it", async () => {
    const agent = idle();
    // Start times are kept to the second on some systems: each step is clearly in its own second.
    const since = Date.now();
    const inTurn = idle();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const until = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    // The next turn's: a late reap of the turn before must not reach it.
    const later = idle();

    await watchProcessTree(pidOf(agent)).reapBornSince(since, [pidOf(inTurn), pidOf(later)], until);
    expect(await goneWithin(pidOf(inTurn), 5_000)).toBe(true);
    expect(isAlive(pidOf(later))).toBe(true);
    expect(isAlive(pidOf(agent))).toBe(true);
  }, 30_000);
});

describe("a watched root whose PID another process took", () => {
  it("F-014: ends neither the process that has the root's PID now nor its children", async () => {
    // A process born well after the watch's root was last alive is another one at that PID, as
    // Windows hands a PID on within moments. Its child stands for what it started.
    const impostor = spawn(
      process.execPath,
      ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);"],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    started.push(impostor);
    const child = await new Promise<number>((resolve) => {
      impostor.stdout.once("data", (chunk: Buffer) => {
        resolve(Number(chunk.toString("utf8").trim()));
      });
    });
    const watch = watchProcessTree(pidOf(impostor), Date.now() - 60_000);
    await watch.snapshot();
    await watch.killAll();
    expect(isAlive(pidOf(impostor)), "the process that has the root's PID").toBe(true);
    expect(isAlive(child), "its child").toBe(true);
    process.kill(child, "SIGKILL");
  }, 30_000);
});

describe("a process's descendants", () => {
  it("F-014: follow a parent link only to a child born after its parent, not to an older process that kept a dead parent's PID", () => {
    const proc = (pid: number, ppid: number, startedAt: number) => ({ pid, ppid, name: "node.exe", startedAt });
    const list = [proc(1, 0, 100), proc(2, 1, 150), proc(3, 2, 160), proc(4, 1, 50), proc(5, 4, 60)];
    // 4 names PID 1 as its parent but is older than it: its parent was an earlier process with that PID.
    expect(descendantsOf(1, list).map((p) => p.pid)).toEqual([2, 3]);
    // With the root gone, its orphans are still found: there's no birth to compare with.
    expect(descendantsOf(1, list.slice(1)).map((p) => p.pid)).toEqual([2, 4, 3, 5]);
  });
});
