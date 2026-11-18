import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

// Process-tree helpers for ending an agent's whole tree. Ported from
// spikes/how-should-the-runner-drive-opencode/src/lib/process-tree.ts, without the measuring.
//
// POSIX: an agent is started as a process-group leader, so one signal reaches the group, orphans
// included. Windows has no process groups: `taskkill /T /F` walks the parent links, so a
// grandchild whose parent already exited escapes it. The driver keeps tree snapshots for those.
// No shell is involved: `execFile` with an argument array, and nothing from an agent in them.
//
// A PID alone never identifies a process, because PIDs are reused. Every record carries the
// process's creation time, and `sameProcess` compares PID, name and creation time.

const run = promisify(execFile);
const isWindows = process.platform === "win32";

export type ProcessInfo = {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  /** Creation time, ms since the epoch (second precision on POSIX); 0 when the OS gave none. */
  readonly startedAt: number;
};

/** The identity of one process: PID reuse can't fake all three. */
export type ProcessKey = Pick<ProcessInfo, "pid" | "name" | "startedAt">;

export const sameProcess = (a: ProcessKey, b: ProcessKey): boolean =>
  a.pid === b.pid && a.name === b.name && a.startedAt === b.startedAt && a.startedAt !== 0;

const windowsProcess = z.looseObject({
  ProcessId: z.number(),
  ParentProcessId: z.number(),
  Name: z.string().nullish(),
  StartedAt: z.number().nullish(),
});

const listWindows = async (): Promise<ProcessInfo[]> => {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name," +
    "@{n='StartedAt';e={if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{0}}} | ConvertTo-Json -Compress";
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = z.union([z.array(windowsProcess), windowsProcess]).parse(JSON.parse(stdout));
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    name: p.Name ?? "",
    startedAt: p.StartedAt ?? 0,
  }));
};

// `lstart` is fixed-format with LC_ALL=C: "Wed Nov 18 17:03:58 2026".
const POSIX_LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(\S+)/;

const listPosix = async (): Promise<ProcessInfo[]> => {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,lstart=,comm="], {
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env["PATH"] ?? "", LC_ALL: "C" },
  });
  const out: ProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const match = POSIX_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const [, pid, ppid, lstart, name] = match;
    const started = Date.parse(lstart ?? "");
    out.push({ pid: Number(pid), ppid: Number(ppid), name: name ?? "", startedAt: Number.isNaN(started) ? 0 : started });
  }
  return out;
};

/** Every process on the machine. Throws when the platform's tool can't run. */
export const listProcesses = async (): Promise<ProcessInfo[]> => (isWindows ? listWindows() : listPosix());

export const descendantsOf = (rootPid: number, processes: readonly ProcessInfo[]): ProcessInfo[] => {
  const byParent = new Map<number, ProcessInfo[]>();
  for (const p of processes) {
    const siblings = byParent.get(p.ppid) ?? [];
    siblings.push(p);
    byParent.set(p.ppid, siblings);
  }
  const out: ProcessInfo[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of byParent.get(next) ?? []) {
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
};

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** Kills a process and everything below it. Best effort: resolves once the kill was issued. */
export const killTree = async (pid: number): Promise<void> => {
  if (isWindows) {
    try {
      await run("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      // Already gone, or partly gone: fall through to the direct kill.
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone.
    }
    return;
  }
  const below = descendantsOf(pid, await listProcesses().catch((): ProcessInfo[] => []));
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Not a group leader, or already gone.
  }
  for (const target of [{ pid }, ...below]) {
    try {
      process.kill(target.pid, "SIGKILL");
    } catch {
      // Gone.
    }
  }
};

/**
 * Follows one agent's process tree: it remembers every descendant it has seen, so it can end them
 * after the agent dies, and the ones born during one turn when that turn is cancelled.
 */
export type TreeWatch = {
  /** Records the root's current descendants. */
  readonly snapshot: () => Promise<void>;
  /** Kills every descendant ever seen that's still the same process. Returns how many. */
  readonly reap: () => Promise<number>;
  /** Kills the descendants born since `since` (ms since the epoch): live ones, and seen orphans. */
  readonly reapBornSince: (since: number) => Promise<number>;
  /** Kills the root and every descendant ever seen. */
  readonly killAll: () => Promise<void>;
};

/** Creation times on POSIX have second precision: compare from the start of that second. */
const bornSince = (p: ProcessInfo, since: number): boolean =>
  p.startedAt !== 0 && p.startedAt >= (isWindows ? since - 50 : Math.floor(since / 1000) * 1000);

export const watchProcessTree = (rootPid: number): TreeWatch => {
  const known = new Map<number, ProcessKey>();
  const remember = (list: readonly ProcessInfo[]): ProcessInfo[] => {
    const below = descendantsOf(rootPid, list);
    for (const p of below) {
      known.set(p.pid, { pid: p.pid, name: p.name, startedAt: p.startedAt });
    }
    return below;
  };
  const list = async (): Promise<ProcessInfo[]> => listProcesses().catch((): ProcessInfo[] => []);
  return {
    snapshot: async () => {
      remember(await list());
    },
    reap: async () => {
      if (known.size === 0) {
        return 0;
      }
      let killed = 0;
      for (const p of await list()) {
        const seen = known.get(p.pid);
        if (seen !== undefined && sameProcess(seen, p)) {
          await killTree(p.pid);
          killed += 1;
        }
      }
      return killed;
    },
    reapBornSince: async (since) => {
      const alive = await list();
      const targets = new Map<number, ProcessInfo>();
      for (const p of remember(alive)) {
        if (bornSince(p, since)) {
          targets.set(p.pid, p);
        }
      }
      for (const p of alive) {
        const seen = known.get(p.pid);
        if (seen !== undefined && sameProcess(seen, p) && bornSince(p, since)) {
          targets.set(p.pid, p);
        }
      }
      for (const p of targets.values()) {
        await killTree(p.pid);
      }
      return targets.size;
    },
    killAll: async () => {
      remember(await list());
      await killTree(rootPid);
      for (const p of await list()) {
        const seen = known.get(p.pid);
        if (seen !== undefined && sameProcess(seen, p)) {
          await killTree(p.pid);
        }
      }
      if (!isWindows) {
        try {
          process.kill(-rootPid, "SIGKILL");
        } catch {
          // The group is gone.
        }
      }
    },
  };
};
