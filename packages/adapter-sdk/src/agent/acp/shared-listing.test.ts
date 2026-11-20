import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isAlive, listProcesses, runBoundedCommand, watchProcessTree } from "./process-tree.ts";
import type { ProcessInfo } from "./process-tree.ts";
import { sharedListing } from "./shared-listing.ts";

// One listing of the machine at a time, shared (the 2026-11-19 incident: 126 PowerShell listings
// alive at once under parallel tests, and WMI refusing them). The fake listing stands for the
// platform's: it counts how many run at once.

/** A PID no system hands out: past Linux's highest `pid_max` (2^22), and not a multiple of 4 as Windows' are. */
const NO_SUCH_PID = 99_999_997;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const countingListing = (lists: readonly (readonly ProcessInfo[])[], delayMs = 50) => {
  let active = 0;
  let peak = 0;
  const startedAt: number[] = [];
  const listOnce = async (): Promise<readonly ProcessInfo[]> => {
    const index = startedAt.length;
    startedAt.push(performance.now());
    active += 1;
    peak = Math.max(peak, active);
    await wait(delayMs);
    active -= 1;
    return lists[Math.min(index, lists.length - 1)] ?? [];
  };
  return { listOnce, peak: () => peak, calls: () => startedAt.length, startedAt: (index: number) => startedAt[index] ?? Number.NaN };
};

const agent: ProcessInfo = { pid: NO_SUCH_PID - 4, ppid: 1, name: "agent", startedAt: 1_000 };
const child: ProcessInfo = { pid: NO_SUCH_PID, ppid: agent.pid, name: "child", startedAt: 2_000 };
/** Another process that got the child's PID after it exited. */
const stranger: ProcessInfo = { ...child, startedAt: 3_000 };

describe("the machine's process listing, shared", () => {
  it("F-014/c6: a hundred concurrent listings and tree snapshots run one listing at a time", async () => {
    const fake = countingListing([[agent, child]]);
    const listing = sharedListing(fake.listOnce);
    const watches = Array.from({ length: 50 }, () => watchProcessTree(agent.pid, 1_500, listing));
    await Promise.all([...watches.map(async (watch) => watch.snapshot()), ...Array.from({ length: 50 }, async () => listing.list())]);
    expect(fake.peak(), "listings in flight at once").toBe(1);
    expect(fake.calls(), "listings in all").toBeLessThanOrEqual(2);
  });

  it("F-014/c6: a caller that decides what to end waits for a listing that starts after it asks; a snapshot shares the one in flight", async () => {
    const first: readonly ProcessInfo[] = [agent, child];
    const second: readonly ProcessInfo[] = [agent, stranger];
    const fake = countingListing([first, second]);
    const listing = sharedListing(fake.listOnce);
    const inFlight = listing.list();
    await wait(10);
    const askedAt = performance.now();
    const [one, fresh, recent] = await Promise.all([inFlight, listing.list("fresh"), listing.list("recent")]);
    expect(one).toBe(first);
    expect(recent).toBe(first);
    expect(fresh).toBe(second);
    expect(fake.startedAt(1)).toBeGreaterThanOrEqual(askedAt);
    expect(fake.peak()).toBe(1);
  });

  it("F-014/c6: a reap a moment after a snapshot spares the stranger that got a seen child's PID", async () => {
    // The snapshot sees the child; it exits and another process gets its PID. A reap that took the
    // snapshot's listing, a few ms old, would end that process by its PID.
    const fake = countingListing([[agent, child], [agent, stranger]], 5);
    const watch = watchProcessTree(agent.pid, 1_500, sharedListing(fake.listOnce));
    await watch.snapshot();
    expect(await watch.reap(), "processes ended").toBe(0);
    expect(fake.calls()).toBe(2);
  });

  it("F-014: a listing that failed isn't kept, and the next caller starts another", async () => {
    let calls = 0;
    const listing = sharedListing(async (): Promise<readonly ProcessInfo[]> => {
      calls += 1;
      await wait(5);
      if (calls === 1) {
        throw new Error("WMI refused the query");
      }
      return [agent];
    });
    await expect(listing.list("recent")).rejects.toThrow("WMI refused the query");
    expect(await listing.list("recent")).toEqual([agent]);
    expect(calls).toBe(2);
  });

  it("F-014/c6: concurrent listings of this machine share one listing", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, async () => listProcesses()));
    expect(new Set(results).size, "distinct listings").toBeLessThanOrEqual(2);
    expect(results[0]?.some((p) => p.pid === process.pid)).toBe(true);
  }, 60_000);
});

describe("a listing command's time limit", () => {
  it("F-014/c6: a listing command that hangs is killed at its time limit, and the listing fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ostra-listing-"));
    const pidFile = path.join(dir, "pid");
    const hang = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const startedAt = Date.now();
    let outcome: "listed" | "failed" | "still running" = "still running";
    let failure: unknown;
    try {
      outcome = await Promise.race([
        runBoundedCommand({ file: process.execPath, args: ["-e", hang], timeoutMs: 3_000 }).then(
          () => "listed" as const,
          (error: unknown) => {
            failure = error;
            return "failed" as const;
          },
        ),
        wait(20_000).then(() => "still running" as const),
      ]);
      expect(outcome).toBe("failed");
      expect(failure instanceof Error && "killed" in failure ? failure.killed : undefined, "killed by the time limit").toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(isAlive(pid), "the hung command").toBe(false);
    } finally {
      // Only while its listing is unsettled is the PID surely still the hung command's.
      if (outcome === "still running") {
        const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // It wrote no PID, or it's gone.
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
