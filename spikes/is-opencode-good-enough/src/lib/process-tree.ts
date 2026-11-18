// Process-tree helpers for the runner: list processes, find a process's
// descendants, kill a whole tree, and sample memory, CPU and listening ports.
// POSIX: the agent is spawned as a process-group leader (`detached: true`),
// so the group is killed with one signal, orphans included.
// Windows: there are no process groups to signal; `taskkill /T /F` walks the
// parent links, so a grandchild whose parent already exited escapes it. The
// driver keeps tree snapshots for those, and the harness hunts such orphans by
// a marker in their command line.
//
// A PID alone never identifies a process: PIDs are reused. Every record
// carries the process's creation time, and `sameProcess` compares PID, name
// and creation time.
//
// Measurement functions throw when their tool can't run, so a missing `ps`,
// `lsof` or PowerShell never reads as "nothing found".

import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);

export type ProcessInfo = {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly commandLine: string;
  /** Resident set size in bytes. */
  readonly rssBytes: number;
  /** Creation time, ms since the epoch (second precision on POSIX); 0 when the OS gave none. */
  readonly startedAt: number;
};

/** The identity of one process: PID reuse can't fake all three. */
export type ProcessKey = Pick<ProcessInfo, "pid" | "name" | "startedAt">;

export const sameProcess = (a: ProcessKey, b: ProcessKey): boolean =>
  a.pid === b.pid && a.name === b.name && a.startedAt === b.startedAt && a.startedAt !== 0;

const isWindows = process.platform === "win32";

/** An execFile failure that still produced output (e.g. `ps -p` with one PID gone exits 1). */
const outputOf = (error: unknown): string | undefined => {
  if (!(error instanceof Error)) return undefined;
  if ("code" in error && error.code === "ENOENT") return undefined;
  return "stdout" in error && typeof error.stdout === "string" ? error.stdout : undefined;
};

const winProcess = z.looseObject({
  ProcessId: z.number(),
  ParentProcessId: z.number(),
  Name: z.string().nullish(),
  CommandLine: z.string().nullish(),
  WorkingSetSize: z.union([z.number(), z.string()]).nullish(),
  StartedAt: z.number().nullish(),
});

const listWindows = async (): Promise<ProcessInfo[]> => {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize," +
    "@{n='StartedAt';e={if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{0}}} | ConvertTo-Json -Compress";
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw: unknown = JSON.parse(stdout);
  const parsed = z.union([z.array(winProcess), winProcess]).parse(raw);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    name: p.Name ?? "",
    commandLine: p.CommandLine ?? "",
    rssBytes: Number(p.WorkingSetSize ?? 0),
    startedAt: p.StartedAt ?? 0,
  }));
};

// `lstart` is fixed-format with LC_ALL=C: "Wed Nov 18 17:03:58 2026".
const POSIX_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(\S+)\s*(.*)$/;

const listPosix = async (): Promise<ProcessInfo[]> => {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,rss=,lstart=,comm=,args="], {
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  const out: ProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const match = POSIX_LINE.exec(line);
    if (match === null) continue;
    const [, pid, ppid, rss, lstart, name, args] = match;
    const started = Date.parse(lstart ?? "");
    out.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rssBytes: Number(rss) * 1024,
      name: name ?? "",
      commandLine: args ?? "",
      startedAt: Number.isNaN(started) ? 0 : started,
    });
  }
  return out;
};

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
      if (seen.has(child.pid)) continue;
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
  for (const p of [{ pid }, ...below]) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // Gone.
    }
  }
};

/** Kills every process whose command line contains `marker`. Returns the PIDs it found. */
export const killByMarker = async (marker: string): Promise<number[]> => {
  const found = (await listProcesses()).filter((p) => p.commandLine.includes(marker) && p.pid !== process.pid);
  for (const p of found) await killTree(p.pid);
  return found.map((p) => p.pid);
};

export type ProcessSample = {
  readonly pid: number;
  readonly rssBytes: number;
  /** Total CPU time used so far, in milliseconds. */
  readonly cpuMs: number;
};

const winSample = z.looseObject({ Id: z.number(), WorkingSet64: z.number(), CPU: z.number().nullish() });

// `cputime`: [[DD-]HH:]MM:SS on Linux, M:SS.cc on macOS.
const CPUTIME_LINE = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?/;

/** Samples memory and CPU time of the given processes. PIDs that are gone are left out; a tool that can't run throws. */
export const sampleProcesses = async (pids: readonly number[]): Promise<ProcessSample[]> => {
  if (pids.length === 0) return [];
  if (isWindows) {
    const script = `Get-Process -Id ${pids.map(String).join(",")} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,CPU | ConvertTo-Json -Compress`;
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    if (stdout.trim() === "") return [];
    const raw: unknown = JSON.parse(stdout);
    const parsed = z.union([z.array(winSample), winSample]).parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((p) => ({ pid: p.Id, rssBytes: p.WorkingSet64, cpuMs: Math.round((p.CPU ?? 0) * 1000) }));
  }
  let stdout: string;
  try {
    stdout = (await run("ps", ["-o", "pid=,rss=,cputime=", "-p", pids.join(",")], { env: { ...process.env, LC_ALL: "C" } })).stdout;
  } catch (error) {
    // `ps -p` exits 1 when some PID is gone; it still prints the others.
    const partial = outputOf(error);
    if (partial === undefined) throw error;
    stdout = partial;
  }
  return stdout.split("\n").flatMap((line) => {
    const sample = parsePsSampleLine(line);
    return sample === undefined ? [] : [sample];
  });
};

/** One line of `ps -o pid=,rss=,cputime=`, Linux or macOS format. */
export const parsePsSampleLine = (line: string): ProcessSample | undefined => {
  const match = CPUTIME_LINE.exec(line);
  if (match === null) return undefined;
  const [, pid, rss, days, h, m, s, fraction] = match;
  const seconds = Number(days ?? 0) * 86_400 + Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
  const fractionMs = fraction === undefined ? 0 : Math.round(Number(`0.${fraction}`) * 1000);
  return { pid: Number(pid), rssBytes: Number(rss) * 1024, cpuMs: seconds * 1000 + fractionMs };
};

const winListener = z.looseObject({ LocalPort: z.number(), OwningProcess: z.number(), LocalAddress: z.string().nullish() });

export type Listener = { readonly pid: number; readonly port: number; readonly address: string };

const hexToIpv4 = (hex: string): string => {
  const bytes = hex.match(/../g) ?? [];
  return bytes.map((b) => String(Number.parseInt(b, 16))).reverse().join(".");
};

/** Linux: listening TCP sockets from /proc/net/tcp{,6}, matched to each PID's socket inodes. No external tool. */
const listeningLinux = async (pids: readonly number[]): Promise<Listener[]> => {
  const byInode = new Map<string, { port: number; address: string }>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await readFile(file, "utf8");
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      const [, local, , state, , , , , , inode] = cols;
      if (state !== "0A" || local === undefined || inode === undefined) continue;
      const [addrHex = "", portHex = "0"] = local.split(":");
      byInode.set(inode, { port: Number.parseInt(portHex, 16), address: addrHex.length === 8 ? hexToIpv4(addrHex) : `ipv6:${addrHex}` });
    }
  }
  const out: Listener[] = [];
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = await readdir(`/proc/${String(pid)}/fd`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const fd of fds) {
      const target = await readlink(`/proc/${String(pid)}/fd/${fd}`).catch(() => "");
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      const listener = inode === undefined ? undefined : byInode.get(inode);
      if (listener !== undefined) out.push({ pid, ...listener });
    }
  }
  return out;
};

/** TCP ports in LISTEN state owned by the given processes. Throws when the platform's tool can't run. */
export const listeningPorts = async (pids: readonly number[]): Promise<Listener[]> => {
  if (pids.length === 0) return [];
  if (isWindows) {
    const script = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${pids.map(String).join(",")}) -contains $_.OwningProcess } | Select-Object LocalPort,OwningProcess,LocalAddress | ConvertTo-Json -Compress`;
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    if (stdout.trim() === "") return [];
    const raw: unknown = JSON.parse(stdout);
    const parsed = z.union([z.array(winListener), winListener]).parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((l) => ({ pid: l.OwningProcess, port: l.LocalPort, address: l.LocalAddress ?? "" }));
  }
  if (process.platform === "linux") return listeningLinux(pids);
  const out: Listener[] = [];
  for (const pid of pids) {
    let stdout: string;
    try {
      stdout = (await run("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"])).stdout;
    } catch (error) {
      // lsof exits 1 when it finds nothing; a missing lsof is ENOENT and throws.
      const partial = outputOf(error);
      if (partial === undefined) throw error;
      stdout = partial;
    }
    for (const line of stdout.split("\n")) {
      const match = /^n(.*):(\d+)$/.exec(line);
      if (match !== null) out.push({ pid, port: Number(match[2]), address: match[1] ?? "" });
    }
  }
  return out;
};
