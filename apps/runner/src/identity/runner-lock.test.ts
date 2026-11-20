import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLockHolder } from "../testing/lock-holder.ts";
import type { LockHolder } from "../testing/lock-holder.ts";
import { linuxProgramName, lockHeldMessage, systemLockProbe, takeRunnerLock } from "./runner-lock.ts";
import type { LockProbe, LockRecord, ProcReader } from "./runner-lock.ts";
import { dataPaths } from "./store.ts";

// One `ostra runner` per data folder on a machine (ADR 0034, amended 2026-11-20): the lock, with
// real processes holding it.

let dataDir = "";
const holders: LockHolder[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "ostra-runner-lock-"));
});

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    await holder.crash();
  }
  await rm(dataDir, { recursive: true, force: true });
});

const hold = async (): Promise<LockHolder> => {
  const holder = await startLockHolder(dataDir);
  holders.push(holder);
  return holder;
};

/** The pid of a process that ran and ended. */
const endedPid = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", () => {
      if (child.pid === undefined) {
        reject(new Error("no pid"));
      } else {
        resolve(child.pid);
      }
    });
  });

const writeLock = async (record: LockRecord): Promise<void> => {
  await writeFile(dataPaths(dataDir).lock, `${JSON.stringify(record)}\n`);
};

const record = (pid: number, hostname = os.hostname()): LockRecord => ({ pid, hostname, startedAt: Date.now(), nonce: `nonce-${String(pid)}` });

describe("one runner per data folder", () => {
  it("F-013: a second runner on a data folder another runner holds is refused, with the holder's pid, and its lock is untouched", async () => {
    const first = await hold();
    expect(first.taken).toBe("taken");
    const before = await readFile(dataPaths(dataDir).lock, "utf8");

    const second = await takeRunnerLock(dataDir);
    expect(second.kind).toBe("held");
    if (second.kind !== "held") {
      return;
    }
    expect(second.holder.pid).toBe(first.pid);
    expect(second.holder.hostname).toBe(os.hostname());
    const message = lockHeldMessage(dataDir, second);
    expect(message).toContain(`Another ostra runner (pid ${String(first.pid)}) is running with this data folder, ${dataDir}`);
    expect(message).toContain(`delete ${dataPaths(dataDir).lock}`);
    expect(await readFile(dataPaths(dataDir).lock, "utf8")).toBe(before);
  });

  it("F-013: the lock a crashed runner left is taken over, and the next runner after that is refused", async () => {
    const crashed = await hold();
    await crashed.crash();
    // Its lock is still there, naming a pid that no longer runs.
    expect(JSON.parse(await readFile(dataPaths(dataDir).lock, "utf8"))).toMatchObject({ pid: crashed.pid });

    const next = await takeRunnerLock(dataDir);
    expect(next.kind).toBe("taken");
    if (next.kind !== "taken") {
      return;
    }
    expect(next.tookOver).toMatchObject({ reason: "not-running", holder: { pid: crashed.pid } });
    expect(JSON.parse(await readFile(dataPaths(dataDir).lock, "utf8"))).toMatchObject({ pid: process.pid, hostname: os.hostname() });

    const another = await startLockHolder(dataDir);
    holders.push(another);
    expect(another.taken).toBe("held");

    await next.lock.release();
    await expect(readFile(dataPaths(dataDir).lock, "utf8")).rejects.toThrow();
    // Nothing moved aside is left behind.
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("F-013: a lock is stale when its pid ended, is this process's own (a restarted container), or another machine wrote it", async () => {
    const cases: readonly { readonly lock: LockRecord; readonly reason: string }[] = [
      { lock: record(await endedPid()), reason: "not-running" },
      { lock: record(process.pid), reason: "own-pid" },
      // A live pid, but another machine's name: a recreated container or a rescheduled pod.
      { lock: record(process.ppid, "another-machine"), reason: "another-host" },
    ];
    for (const { lock, reason } of cases) {
      await writeLock(lock);
      const taken = await takeRunnerLock(dataDir);
      expect(taken.kind).toBe("taken");
      if (taken.kind === "taken") {
        expect(taken.tookOver).toEqual({ reason, holder: lock });
        await taken.lock.release();
      }
    }
  });

  it("F-013: a pid the system gave to another program, and a lock file that isn't one, are stale", async () => {
    const reused: LockProbe = { ...systemLockProbe, running: () => true, nodeProgram: () => Promise.resolve(false) };
    await writeLock(record(424242));
    const taken = await takeRunnerLock(dataDir, reused);
    expect(taken.kind === "taken" ? taken.tookOver?.reason : taken.kind).toBe("not-a-runner");
    if (taken.kind === "taken") {
      await taken.lock.release();
    }

    // A program it can't name is a runner: refused, not taken.
    const unknown: LockProbe = { ...systemLockProbe, running: () => true, nodeProgram: () => Promise.resolve(null) };
    await writeLock(record(424242));
    expect((await takeRunnerLock(dataDir, unknown)).kind).toBe("held");

    await writeFile(dataPaths(dataDir).lock, "not a lock");
    const broken = await takeRunnerLock(dataDir);
    expect(broken.kind === "taken" ? broken.tookOver?.reason : broken.kind).toBe("unreadable");
  });

  it("F-013: two runners starting at once on a crashed runner's lock: one takes it, the other is refused", async () => {
    // The crashed runner's pid runs another program now. Two runners start: each sees the other as
    // a runner. On odd rounds the second takes 100 ms to look at the crashed pid, so it judges the
    // lock stale after the first already replaced it, and must not take the first one's lock.
    const crashed = 900_000;
    for (let round = 0; round < 10; round += 1) {
      await writeLock(record(crashed));
      const probe = (pid: number, lookMs: number): LockProbe => ({
        pid,
        hostname: () => os.hostname(),
        running: () => true,
        nodeProgram: async (other) => {
          if (other !== crashed) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, lookMs));
          return false;
        },
      });
      const results = await Promise.all([takeRunnerLock(dataDir, probe(900_001, 0)), takeRunnerLock(dataDir, probe(900_002, round % 2 === 0 ? 0 : 100))]);
      expect(results.map((result) => result.kind).sort()).toEqual(["held", "taken"]);
      const winner = results.find((result) => result.kind === "taken");
      const holder: unknown = JSON.parse(await readFile(dataPaths(dataDir).lock, "utf8"));
      expect(results.find((result) => result.kind === "held")).toMatchObject({ holder });
      if (winner?.kind === "taken") {
        await winner.lock.release();
      }
      expect(await readdir(dataDir)).toEqual([]);
    }
  });

  it("F-013: releasing leaves a lock another runner took after it alone", async () => {
    const taken = await takeRunnerLock(dataDir);
    expect(taken.kind).toBe("taken");
    const other = record(process.ppid);
    await writeLock(other);
    if (taken.kind === "taken") {
      await taken.lock.release();
    }
    expect(JSON.parse(await readFile(dataPaths(dataDir).lock, "utf8"))).toEqual(other);
  });
});

describe("a Linux pid's program", () => {
  const procOf = (files: Readonly<Record<string, string>>, links: Readonly<Record<string, string>>): ProcReader => ({
    readlink: (file) => (file in links ? Promise.resolve(links[file] ?? "") : Promise.reject(new Error(`EACCES ${file}`))),
    readFile: (file) => (file in files ? Promise.resolve(files[file] ?? "") : Promise.reject(new Error(`ENOENT ${file}`))),
  });

  it("F-013: is the executable, not the main thread's name (Node 24 calls it MainThread)", async () => {
    const proc = procOf({ "/proc/42/comm": "MainThread\n", "/proc/42/cmdline": "node\0main.ts\0runner\0" }, { "/proc/42/exe": "/opt/hostedtoolcache/node/24.11.0/x64/bin/node" });
    expect(await linuxProgramName(42, proc)).toBe("node");
  });

  it("F-013: falls back to cmdline's first word, then comm, and says nothing when it can't be read", async () => {
    expect(await linuxProgramName(7, procOf({ "/proc/7/cmdline": "/usr/bin/node\0main.ts\0", "/proc/7/comm": "MainThread\n" }, {}))).toBe("node");
    expect(await linuxProgramName(7, procOf({ "/proc/7/cmdline": "node (vitest 1)\0" }, {}))).toBe("node");
    expect(await linuxProgramName(7, procOf({ "/proc/7/comm": "ostra\n" }, {}))).toBe("ostra");
    expect(await linuxProgramName(7, procOf({}, {}))).toBeNull();
    expect(await linuxProgramName(7, procOf({}, { "/proc/7/exe": "/usr/bin/python3 (deleted)" }))).toBe("python3");
  });
});
