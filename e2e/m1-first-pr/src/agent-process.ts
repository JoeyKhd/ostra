import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

import { z } from "zod";

// The live agent process's environment (spec section 3): which variables the runner launched it
// with. On Windows there is no /proc, so the environment block is read from the process's memory
// (PEB, 64-bit processes of the same user). The values stay in this process's memory: callers
// compare them and report names and counts only.

export type ProcessInfo = { readonly pid: number; readonly ppid: number; readonly name: string };

/** A process's environment: variable name to value. */
export type ProcessEnvironment = ReadonlyMap<string, string>;

const run = (file: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(error instanceof Error ? error : new Error("the command failed"));
    });
  });

const windowsProcessSchema = z.array(z.looseObject({ ProcessId: z.number(), ParentProcessId: z.number(), Name: z.string().nullable() }));

const powershell = (script: string): Promise<string> =>
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);

/** Every process on the machine, with its parent. */
export const listProcesses = async (): Promise<readonly ProcessInfo[]> => {
  if (process.platform === "win32") {
    const out = await powershell("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress");
    const parsed: unknown = JSON.parse(out);
    return windowsProcessSchema
      .parse(Array.isArray(parsed) ? parsed : [parsed])
      .map((item) => ({ pid: item.ProcessId, ppid: item.ParentProcessId, name: item.Name ?? "" }));
  }
  const out = await run("ps", ["-A", "-o", "pid=,ppid=,comm="]);
  const processes: ProcessInfo[] = [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), name: match[3] ?? "" });
  }
  return processes;
};

/** The processes below `rootPid`, at any depth. */
export const descendantsOf = (processes: readonly ProcessInfo[], rootPid: number): readonly ProcessInfo[] => {
  const found = new Map<number, ProcessInfo>();
  const queue = [rootPid];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const item of processes) {
      if (item.ppid === next && item.pid !== rootPid && !found.has(item.pid)) {
        found.set(item.pid, item);
        queue.push(item.pid);
      }
    }
  }
  return [...found.values()];
};

/** A block of `NAME=value` entries as a map. An entry that starts with `=` is a drive's working directory, not a variable. */
export const parseEnvironmentEntries = (entries: readonly string[]): ProcessEnvironment => {
  const environment = new Map<string, string>();
  for (const entry of entries) {
    const at = entry.indexOf("=");
    if (at > 0) environment.set(entry.slice(0, at), entry.slice(at + 1));
  }
  return environment;
};

const WINDOWS_READER = `
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class OstraEnvReader {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int kind, ref Basic info, int length, out int returned);
  [StructLayout(LayoutKind.Sequential)]
  struct Basic { public IntPtr Exit; public IntPtr Peb; public IntPtr Affinity; public IntPtr Priority; public IntPtr Id; public IntPtr ParentId; }
  static byte[] Read(IntPtr h, long address, int count) {
    byte[] buffer = new byte[count];
    UIntPtr read;
    if (!ReadProcessMemory(h, new IntPtr(address), buffer, new UIntPtr((uint)count), out read)) throw new Exception("read");
    return buffer;
  }
  public static string[] Entries(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) throw new Exception("open");
    try {
      Basic basic = new Basic();
      int returned;
      if (NtQueryInformationProcess(h, 0, ref basic, Marshal.SizeOf(typeof(Basic)), out returned) != 0) throw new Exception("query");
      long parameters = BitConverter.ToInt64(Read(h, basic.Peb.ToInt64() + 0x20, 8), 0);
      long block = BitConverter.ToInt64(Read(h, parameters + 0x80, 8), 0);
      long size = BitConverter.ToInt64(Read(h, parameters + 0x3F0, 8), 0);
      if (size <= 0 || size > 4194304) throw new Exception("size");
      string all = Encoding.Unicode.GetString(Read(h, block, (int)size));
      List<string> entries = new List<string>();
      foreach (string entry in all.Split('\\0')) { if (entry.Length > 0) entries.Add(entry); }
      return entries.ToArray();
    } finally { CloseHandle(h); }
  }
}
"@
`;

const entriesSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

const readWindows = async (pids: readonly number[]): Promise<ReadonlyMap<number, ProcessEnvironment>> => {
  const ids = pids.filter((pid) => Number.isInteger(pid) && pid > 0).join(",");
  if (ids === "") return new Map();
  const script = `${WINDOWS_READER}
$result = @{}
foreach ($id in @(${ids})) { try { $result["$id"] = [string[]][OstraEnvReader]::Entries($id) } catch { } }
$result | ConvertTo-Json -Compress -Depth 3`;
  const parsed = entriesSchema.parse(JSON.parse((await powershell(script)).trim() || "{}"));
  const out = new Map<number, ProcessEnvironment>();
  for (const [pid, entries] of Object.entries(parsed)) out.set(Number(pid), parseEnvironmentEntries(typeof entries === "string" ? [entries] : entries));
  return out;
};

const readProc = async (pids: readonly number[]): Promise<ReadonlyMap<number, ProcessEnvironment>> => {
  const out = new Map<number, ProcessEnvironment>();
  for (const pid of pids) {
    try {
      out.set(pid, parseEnvironmentEntries((await readFile(`/proc/${String(pid)}/environ`, "utf8")).split("\0")));
    } catch {
      // Gone, or not ours: left out, and the caller treats a missing process as unread.
    }
  }
  return out;
};

/**
 * The environments of these processes, for those that can be read. Windows reads the process's
 * memory, Linux `/proc`; macOS has neither, so it reads none.
 */
export const readEnvironments = (pids: readonly number[]): Promise<ReadonlyMap<number, ProcessEnvironment>> => {
  if (process.platform === "win32") return readWindows(pids);
  if (process.platform === "linux") return readProc(pids);
  return Promise.resolve(new Map());
};

/** The marker the OpenCode adapter puts in the agent's launch environment and nobody else does. */
export const AGENT_MARKER = "OPENCODE_MODELS_PATH";

/** The processes the runner launched as the agent: those with the marker whose parent hasn't it (its shells inherit it). */
export const agentLaunches = (processes: readonly ProcessInfo[], environments: ReadonlyMap<number, ProcessEnvironment>): readonly ProcessInfo[] => {
  const marked = new Set(processes.filter((item) => environments.get(item.pid)?.has(AGENT_MARKER) === true).map((item) => item.pid));
  return processes.filter((item) => marked.has(item.pid) && !marked.has(item.ppid));
};

/** Names in `environment` that are not allowed. Windows names are not case-sensitive. */
export const namesOutside = (environment: ProcessEnvironment, allowed: readonly string[]): readonly string[] => {
  const fold = (name: string): string => (process.platform === "win32" ? name.toUpperCase() : name);
  const permitted = new Set(allowed.map(fold));
  return [...environment.keys()].filter((name) => !permitted.has(fold(name))).sort();
};
