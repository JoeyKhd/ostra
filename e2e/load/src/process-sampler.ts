import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { z } from "zod";

// What the load test reads from the OS about a process and its children (ticket 34, F-117):
// Postgres's CPU (the postmaster and every backend it forked) and each core replica's memory. On
// Linux from `/proc`; on Windows from the process's own counters (`Win32_Process`, through
// PowerShell); elsewhere from `ps`. CPU is cumulative user plus system time, so a reader takes the
// difference of two samples over the wall time between them.

const run = promisify(execFile);

export type ProcessSample = {
  /** When it was read, ms since the epoch. */
  readonly at: number;
  /** User and system CPU of the process and its direct children, in ms, since each started. */
  readonly cpuMs: number;
  /** Resident memory of the process alone, in bytes. */
  readonly rssBytes: number;
  /** How many processes were summed: the process and its live children. */
  readonly processes: number;
};

/** Linux's clock ticks a second (`getconf CLK_TCK`), 100 on every kernel ostra runs on. */
const LINUX_TICKS = 100;
const LINUX_PAGE = 4096;

type ProcStat = { readonly pid: number; readonly ppid: number; readonly cpuMs: number; readonly rssBytes: number };

/** `/proc/<pid>/stat`: the command is in parentheses and may hold spaces, so fields count from its end. */
export const parseProcStat = (text: string): ProcStat | null => {
  const close = text.lastIndexOf(")");
  const pid = Number.parseInt(text, 10);
  if (close === -1 || !Number.isInteger(pid)) return null;
  const fields = text.slice(close + 2).trim().split(/\s+/);
  // After the command: state(3) ppid(4) ... utime(14) stime(15) ... rss(24); index = field - 3.
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const rss = Number(fields[21]);
  if (![ppid, utime, stime, rss].every(Number.isFinite)) return null;
  return { pid, ppid, cpuMs: ((utime + stime) * 1000) / LINUX_TICKS, rssBytes: rss * LINUX_PAGE };
};

const sampleLinux = async (pid: number): Promise<ProcessSample> => {
  const at = Date.now();
  const entries = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  let cpuMs = 0;
  let rssBytes = 0;
  let processes = 0;
  for (const name of entries) {
    const stat = parseProcStat(await readFile(`/proc/${name}/stat`, "utf8").catch(() => ""));
    if (stat === null || (stat.pid !== pid && stat.ppid !== pid)) continue;
    cpuMs += stat.cpuMs;
    processes += 1;
    if (stat.pid === pid) rssBytes = stat.rssBytes;
  }
  if (processes === 0) throw new Error(`no process ${String(pid)}`);
  return { at, cpuMs, rssBytes, processes };
};

const windowsRowSchema = z.object({ ProcessId: z.number(), KernelModeTime: z.coerce.number(), UserModeTime: z.coerce.number(), WorkingSetSize: z.coerce.number() });

const sampleWindows = async (pid: number): Promise<ProcessSample> => {
  const at = Date.now();
  // Times are in 100 ns units. The PID is a number we checked, never text from outside.
  const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)} OR ParentProcessId=${String(pid)}" | Select-Object ProcessId,KernelModeTime,UserModeTime,WorkingSetSize | ConvertTo-Json -Compress`;
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30_000 });
  const text = stdout.trim();
  if (text === "") throw new Error(`no process ${String(pid)}`);
  const parsed: unknown = JSON.parse(text);
  const rows = z.array(windowsRowSchema).parse(Array.isArray(parsed) ? parsed : [parsed]);
  let cpuMs = 0;
  let rssBytes = 0;
  for (const row of rows) {
    cpuMs += (row.KernelModeTime + row.UserModeTime) / 10_000;
    if (row.ProcessId === pid) rssBytes = row.WorkingSetSize;
  }
  return { at, cpuMs, rssBytes, processes: rows.length };
};

/** `ps` time: `[[dd-]hh:]mm:ss[.ff]`. */
export const parsePsTime = (text: string): number => {
  const [dayPart, rest] = text.includes("-") ? text.split("-", 2) : ["0", text];
  const parts = (rest ?? "").split(":").map(Number);
  const seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
  return (Number(dayPart) * 86_400 + seconds) * 1000;
};

const samplePs = async (pid: number): Promise<ProcessSample> => {
  const at = Date.now();
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,rss=,time="], { timeout: 30_000 });
  let cpuMs = 0;
  let rssBytes = 0;
  let processes = 0;
  for (const line of stdout.split("\n")) {
    const [p, pp, rss, time] = line.trim().split(/\s+/);
    if (p === undefined || pp === undefined || rss === undefined || time === undefined) continue;
    if (Number(p) !== pid && Number(pp) !== pid) continue;
    cpuMs += parsePsTime(time);
    processes += 1;
    if (Number(p) === pid) rssBytes = Number(rss) * 1024;
  }
  if (processes === 0) throw new Error(`no process ${String(pid)}`);
  return { at, cpuMs, rssBytes, processes };
};

export const sampleProcess = (pid: number, platform: NodeJS.Platform = process.platform): Promise<ProcessSample> => {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.reject(new Error("a process ID is a positive integer"));
  if (platform === "linux") return sampleLinux(pid);
  if (platform === "win32") return sampleWindows(pid);
  return samplePs(pid);
};

/** CPU used between two samples, as a share of one core (1 = one core busy the whole time). */
export const cpuCores = (from: ProcessSample, to: ProcessSample): number => {
  const wall = to.at - from.at;
  return wall <= 0 ? 0 : Math.max(0, to.cpuMs - from.cpuMs) / wall;
};

/** Samples a process every `intervalMs` until stopped; a failed read is skipped, not fatal. */
export const startSampling = (pid: number, intervalMs: number): { readonly stop: () => Promise<readonly ProcessSample[]> } => {
  const samples: ProcessSample[] = [];
  let pending: Promise<void> = Promise.resolve();
  const take = (): void => {
    pending = pending.then(async () => {
      const sample = await sampleProcess(pid).catch(() => null);
      if (sample !== null) samples.push(sample);
    });
  };
  take();
  const timer = setInterval(take, intervalMs);
  return {
    stop: async () => {
      clearInterval(timer);
      take();
      await pending;
      return samples;
    },
  };
};
