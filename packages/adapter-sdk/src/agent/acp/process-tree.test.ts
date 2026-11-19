import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { isAlive, killTree, watchProcessTree } from "./process-tree.ts";

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

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.pid !== undefined) {
      await killTree(child.pid);
    }
  }
});

describe("a cancelled turn's reap", () => {
  it("F-014: ends the unit's processes born during the turn, outside the agent's tree too, and spares the older ones", async () => {
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
});
