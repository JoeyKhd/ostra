import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { z } from "zod";

import { sharedListing } from "./shared-listing.ts";
import type { Freshness, SharedListing } from "./shared-listing.ts";
import { loadWindowsProcessLister } from "./windows-processes.ts";
import type { WindowsProcessListerLoad } from "./windows-processes.ts";

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
//
// Every caller in this process shares one listing of the machine at a time (`shared-listing.ts`).
// On Windows it's one call to ntdll through koffi (`windows-processes.ts`), and a PowerShell only
// when koffi can't load. A listing command that hangs is killed at its time limit.

const run = promisify(execFile);
const isWindows = process.platform === "win32";

export type ProcessInfo = {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  /**
   * Creation time, ms since the epoch; 0 when the OS gave none. Second precision on macOS and the
   * BSDs. On Linux it is counted from the kernel's boot time, which /proc/stat gives in whole seconds:
   * stable for one process, so it identifies it, but up to a second early (`bootSkewMs` corrects it).
   */
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

/**
 * How long one command of these helpers may run: a listing, or `taskkill`. An overloaded WMI never
 * answers PowerShell, and `taskkill` slows down with the machine too: a stalled one is killed then.
 */
export const COMMAND_TIMEOUT_MS = 15_000;

export type BoundedCommand = {
  readonly file: string;
  readonly args: readonly string[];
  /** Past this, the command is killed and the call fails. */
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
};

/** Runs a command, with no shell, and gives its output. Rejects when it fails or runs past its time limit. */
export const runBoundedCommand = async (command: BoundedCommand): Promise<string> => {
  const { stdout } = await run(command.file, [...command.args], {
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: command.timeoutMs,
    killSignal: "SIGKILL",
    ...(command.env === undefined ? {} : { env: command.env }),
  });
  return stdout;
};

/** Windows' fallback when koffi can't load: WMI through PowerShell, a second or more and about 100 MB each. */
export const listWindowsPowerShell = async (timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<ProcessInfo[]> => {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name," +
    "@{n='StartedAt';e={if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{0}}} | ConvertTo-Json -Compress";
  const stdout = await runBoundedCommand({ file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script], timeoutMs });
  const parsed = z.union([z.array(windowsProcess), windowsProcess]).parse(JSON.parse(stdout));
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    name: p.Name ?? "",
    startedAt: p.StartedAt ?? 0,
  }));
};

let windowsNative: Promise<WindowsProcessListerLoad> | undefined;

/** ntdll's process list through koffi, loaded once; PowerShell when it can't load, or for a call that failed. */
const listWindows = async (): Promise<readonly ProcessInfo[]> => {
  windowsNative ??= loadWindowsProcessLister();
  const native = await windowsNative;
  if (native.ok) {
    try {
      return await native.value();
    } catch {
      // This listing goes through PowerShell; the next one tries ntdll again.
    }
  }
  return listWindowsPowerShell();
};

// `lstart` is fixed-format with LC_ALL=C: "Wed Nov 18 17:03:58 2026".
const POSIX_LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(\S+)/;

const listPosix = async (): Promise<ProcessInfo[]> => {
  const stdout = await runBoundedCommand({
    file: "ps",
    args: ["-A", "-o", "pid=,ppid=,lstart=,comm="],
    timeoutMs: COMMAND_TIMEOUT_MS,
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

// Linux: /proc itself. `ps` reads the same start time, in clock ticks since boot, but adds it to the
// boot time in whole seconds and rounds the sum down to a second again: up to two seconds early. A
// child born just after a turn started then reads as older than the turn, and a cancel spares it.
const isLinux = process.platform === "linux";

let clockTicks: Promise<number> | undefined;
/** Clock ticks per second (USER_HZ), the unit of /proc's start times. 100 on every common build. */
const ticksPerSecond = async (): Promise<number> => {
  clockTicks ??= run("getconf", ["CLK_TCK"], { env: { PATH: process.env["PATH"] ?? "", LC_ALL: "C" } })
    .then(({ stdout }) => {
      const ticks = Number(stdout.trim());
      return Number.isInteger(ticks) && ticks > 0 ? ticks : 100;
    })
    .catch(() => 100);
  return clockTicks;
};

/** The boot time /proc/stat gives, in whole seconds since the epoch. */
const bootSeconds = async (): Promise<number> => {
  const match = /^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"));
  if (match?.[1] === undefined) {
    throw new Error("/proc/stat has no btime");
  }
  return Number(match[1]);
};

const readStat = async (pid: string): Promise<string | undefined> => {
  try {
    return await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined; // It exited since the listing.
  }
};

const listLinux = async (): Promise<ProcessInfo[]> => {
  const [entries, boot, hz] = await Promise.all([readdir("/proc"), bootSeconds(), ticksPerSecond()]);
  const stats = await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(readStat));
  const out: ProcessInfo[] = [];
  for (const stat of stats) {
    // "pid (comm) state ppid ... starttime ...": comm may itself hold spaces and ")".
    const open = stat?.indexOf(" (") ?? -1;
    const close = stat?.lastIndexOf(")") ?? -1;
    if (stat === undefined || open < 0 || close < open) {
      continue;
    }
    const fields = stat.slice(close + 2).split(" ");
    // After the name: state is field 3 of proc(5), ppid field 4, starttime field 22.
    const ppid = Number(fields[1]);
    const ticks = Number(fields[19]);
    out.push({
      pid: Number(stat.slice(0, open)),
      ppid: Number.isInteger(ppid) ? ppid : 0,
      name: stat.slice(open + 2, close),
      startedAt: Number.isInteger(ticks) ? boot * 1000 + Math.floor((ticks * 1000) / hz) : 0,
    });
  }
  return out;
};

/**
 * How far Linux's `startedAt` runs early: the fraction of a second the boot time in /proc/stat drops.
 * The precise boot time is now minus /proc/uptime, both on the same clock as the start times.
 */
const bootSkewMs = async (): Promise<number> => {
  const [boot, uptime] = await Promise.all([bootSeconds(), readFile("/proc/uptime", "utf8")]);
  const up = Number(uptime.split(" ")[0]);
  return Number.isFinite(up) ? Math.max(0, Date.now() - up * 1000 - boot * 1000) : 0;
};

export type ProcessListing = SharedListing<readonly ProcessInfo[]>;

/** This process's one listing of the machine, shared by every caller (`shared-listing.ts`). */
export const machineProcesses: ProcessListing = sharedListing(async () => (isWindows ? listWindows() : isLinux ? listLinux() : listPosix()));

/**
 * Every process on the machine, from a listing that starts after this call (`fresh`, the default),
 * or, for a snapshot that only remembers, the one in flight or one a moment old (`recent`). Callers
 * share what it returns, so none changes it. Throws when the platform's tool can't run.
 */
export const listProcesses = async (freshness: Freshness = "fresh"): Promise<readonly ProcessInfo[]> => machineProcesses.list(freshness);

/**
 * Every process below `rootPid`, by the parent links. A link counts only when the child was born
 * after its parent: a process keeps its parent's PID after the parent exits, and once Windows hands
 * that PID on, the link points at a stranger, whose "children" would be another program's.
 */
export const descendantsOf = (rootPid: number, processes: readonly ProcessInfo[]): ProcessInfo[] => {
  const byParent = new Map<number, ProcessInfo[]>();
  const byPid = new Map<number, ProcessInfo>();
  for (const p of processes) {
    const siblings = byParent.get(p.ppid) ?? [];
    siblings.push(p);
    byParent.set(p.ppid, siblings);
    byPid.set(p.pid, p);
  }
  const out: ProcessInfo[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const parent = byPid.get(next);
    for (const child of byParent.get(next) ?? []) {
      if (seen.has(child.pid)) {
        continue;
      }
      if (parent !== undefined && parent.startedAt !== 0 && child.startedAt !== 0 && child.startedAt < parent.startedAt) {
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

/**
 * Whether a process is really running. Unlike `isAlive`, a zombie counts as gone: on POSIX a killed
 * child stays in the process table until its parent collects it, and `kill(pid, 0)` still succeeds
 * for it. Linux reads the state from /proc; other POSIX systems ask `ps`; Windows has no zombies.
 */
export const isRunning = async (pid: number): Promise<boolean> => {
  if (!isAlive(pid)) {
    return false;
  }
  if (isWindows) {
    return true;
  }
  const state = await processState(pid);
  return state !== "Z" && state !== "X";
};

const processState = async (pid: number): Promise<string | undefined> => {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
      // The state follows the last ")": the command name may itself contain ")".
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    } catch {
      return "X";
    }
  }
  try {
    const { stdout } = await run("ps", ["-o", "stat=", "-p", String(pid)], { env: { PATH: process.env["PATH"] ?? "", LC_ALL: "C" } });
    return stdout.trim().slice(0, 1) || "X";
  } catch {
    return "X";
  }
};

/** Kills a process and everything below it. Best effort: resolves once the kill was issued. */
export const killTree = async (pid: number): Promise<void> => {
  if (isWindows) {
    try {
      await runBoundedCommand({ file: "taskkill", args: ["/PID", String(pid), "/T", "/F"], timeoutMs: COMMAND_TIMEOUT_MS });
    } catch {
      // Already gone, partly gone, or `taskkill` outlived its time limit: fall through to the direct kill.
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
  /**
   * Kills the descendants born since `since` (ms since the epoch), and up to `until` when it's given:
   * live ones, seen orphans, and the processes of `unitPids` (the task's job or cgroup, which holds
   * the ones that detached themselves). `until` keeps a reap that's still running from reaching
   * the processes of a turn that started after the one it reaps.
   */
  readonly reapBornSince: (since: number, unitPids?: readonly number[], until?: number) => Promise<number>;
  /** Kills the root and every descendant ever seen. */
  readonly killAll: () => Promise<void>;
};

/**
 * Whether a process was born at or after `since`. Windows and Linux (given its skew) know the start
 * to a few ms, so the window opens 50 ms early; macOS and the BSDs round it down to a second, so it
 * opens at the start of that second.
 */
const bornSince = (p: ProcessInfo, since: number, skewMs: number): boolean =>
  p.startedAt !== 0 && (isWindows || isLinux ? p.startedAt + skewMs >= since - 50 : p.startedAt >= Math.floor(since / 1000) * 1000);

/** Whether a process was born by `until`, with the same 50 ms of slack (macOS's whole second rounds down). */
const bornBy = (p: ProcessInfo, until: number, skewMs: number): boolean => (isWindows || isLinux ? p.startedAt + skewMs <= until + 50 : p.startedAt <= until);

/**
 * Watches the tree of `rootPid`, a process alive at `aliveAt` (by default now: its caller has just
 * started it), so born by then. A process at its PID born later is another one that got the PID
 * after the root exited, as Windows hands a PID on within moments: neither it nor what it started is
 * the root's. A snapshot takes the shared listing in flight; a reap or a kill waits for a fresh one.
 */
export const watchProcessTree = (rootPid: number, aliveAt: number = Date.now(), listing: ProcessListing = machineProcesses): TreeWatch => {
  const watchedFrom = aliveAt;
  // A second of slack, for a clock that steps back: a root mistaken for another would outlive us.
  const impostorIn = (list: readonly ProcessInfo[]): ProcessInfo | undefined =>
    list.find((p) => p.pid === rootPid && p.startedAt !== 0 && p.startedAt > watchedFrom + 1000);
  const known = new Map<number, ProcessKey>();
  const remember = (list: readonly ProcessInfo[]): ProcessInfo[] => {
    const impostor = impostorIn(list);
    // The root's orphans keep its PID as their parent's, so they're still found: by their birth,
    // before the process that now has that PID.
    const below = descendantsOf(rootPid, list).filter((p) => impostor === undefined || (p.startedAt !== 0 && p.startedAt < impostor.startedAt));
    for (const p of below) {
      known.set(p.pid, { pid: p.pid, name: p.name, startedAt: p.startedAt });
    }
    return below;
  };
  const list = async (freshness: Freshness = "fresh"): Promise<readonly ProcessInfo[]> => listing.list(freshness).catch((): ProcessInfo[] => []);
  return {
    snapshot: async () => {
      remember(await list("recent"));
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
    reapBornSince: async (since, unitPids = [], until = Number.POSITIVE_INFINITY) => {
      const alive = await list();
      const skew = isLinux ? await bootSkewMs().catch(() => 0) : 0;
      const inWindow = (p: ProcessInfo): boolean => bornSince(p, since, skew) && bornBy(p, until, skew);
      const targets = new Map<number, ProcessInfo>();
      for (const p of remember(alive)) {
        if (inWindow(p)) {
          targets.set(p.pid, p);
        }
      }
      const inUnit = new Set(unitPids);
      for (const p of alive) {
        const seen = known.get(p.pid);
        if (p.pid !== rootPid && ((seen !== undefined && sameProcess(seen, p)) || inUnit.has(p.pid)) && inWindow(p)) {
          targets.set(p.pid, p);
        }
      }
      for (const p of targets.values()) {
        await killTree(p.pid);
      }
      return targets.size;
    },
    killAll: async () => {
      const before = await list();
      remember(before);
      // A tree kill by a PID that's another process's now would end that process and its children.
      // An empty list is a listing that failed: the root is ended by its PID then, as it always was.
      if (before.length === 0 || (before.some((p) => p.pid === rootPid) && impostorIn(before) === undefined)) {
        await killTree(rootPid);
      }
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
