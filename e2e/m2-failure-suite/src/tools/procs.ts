import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

// The suite's processes and its kill helpers (ticket 38). Ported from
// spikes/runner-transport/src/harness/procs.ts: every child is registered, and `killTree` ends a
// whole process tree at once, as `kill -9` does (`taskkill /T /F` on Windows, SIGKILL to the
// process group elsewhere), so a killed runner or core gets no chance to clean up. Each child's
// output goes to its own log file: ostra logs IDs and fields, never secrets.

const windows = process.platform === "win32";

export type Child = {
  readonly name: string;
  readonly pid: number;
  readonly exited: Promise<number | null>;
  readonly alive: () => boolean;
  /** Every line it printed, newest last (the last 2,000). */
  readonly lines: readonly string[];
  /** Resolves with the first line that `match` accepts, from now on. */
  readonly waitForLine: (match: (line: string) => boolean, timeoutMs: number) => Promise<string>;
  /** `kill -9` of its whole tree, then waits for it to be gone. */
  readonly kill9: () => Promise<void>;
};

const children = new Set<Child>();

/** Ends a process and everything under it, at once. */
export const killTree = (pid: number): Promise<void> =>
  new Promise((resolve) => {
    if (windows) {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
        resolve();
      });
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    resolve();
  });

export type SpawnInput = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logFile: string;
  /** Also print lines that aren't JSON, prefixed with the name. */
  readonly echo?: boolean;
};

/** Starts a registered child with its output in `logFile`. The arguments are fixed by the suite, never untrusted text. */
export const spawnChild = async (input: SpawnInput): Promise<Child> => {
  await mkdir(path.dirname(input.logFile), { recursive: true });
  const log = createWriteStream(input.logFile, { flags: "a" });
  const proc: ChildProcess = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // Off Windows each child leads its own process group, so the whole tree can be signalled.
    detached: !windows,
  });
  const pid = proc.pid;
  if (pid === undefined) {
    throw new Error(`${input.name} did not start`);
  }
  const lines: string[] = [];
  const waiters = new Set<(line: string) => void>();
  for (const stream of [proc.stdout, proc.stderr]) {
    if (stream === null) continue;
    createInterface({ input: stream }).on("line", (line) => {
      log.write(`${line}\n`);
      lines.push(line);
      if (lines.length > 2000) lines.shift();
      if (input.echo === true && !line.startsWith("{")) process.stdout.write(`[${input.name}] ${line}\n`);
      for (const waiter of [...waiters]) waiter(line);
    });
  }
  const exited = new Promise<number | null>((resolve) => {
    proc.once("exit", (code) => {
      children.delete(child);
      log.end();
      resolve(code);
    });
  });
  const child: Child = {
    name: input.name,
    pid,
    exited,
    lines,
    alive: () => proc.exitCode === null && proc.signalCode === null,
    waitForLine: (match, timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`${input.name}: no matching line in ${String(timeoutMs)} ms`));
        }, timeoutMs);
        const waiter = (line: string): void => {
          if (!match(line)) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(line);
        };
        waiters.add(waiter);
        void exited.then(() => {
          if (!waiters.has(waiter)) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          reject(new Error(`${input.name} exited before the line came`));
        });
      }),
    kill9: async () => {
      if (proc.exitCode === null && proc.signalCode === null) await killTree(pid);
      await exited;
    },
  };
  children.add(child);
  return child;
};

/** Kills every child still running: the end of a run, or an interrupted one. */
export const killAll = async (): Promise<void> => {
  await Promise.all([...children].map((child) => child.kill9()));
};

export type ProcessRow = { readonly pid: number; readonly parentPid: number; readonly name: string };

const runFile = (command: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) {
        reject(new Error(`${command} failed: ${error.message}`));
        return;
      }
      resolve(stdout);
    });
  });

/** Every process on the machine: its ID, its parent's and its image name. */
export const processTable = async (): Promise<readonly ProcessRow[]> => {
  const text = windows
    ? await runFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.Name)\" }"])
    : await runFile("ps", ["-A", "-o", "pid=,ppid=,comm="]);
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return [];
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), name: match[3] }];
  });
};

/** The processes under `rootPid`, at any depth. */
export const descendantsOf = (table: readonly ProcessRow[], rootPid: number): readonly ProcessRow[] => {
  const found: ProcessRow[] = [];
  const frontier = [rootPid];
  for (let next = frontier.pop(); next !== undefined; next = frontier.pop()) {
    for (const row of table) {
      if (row.parentPid === next && row.pid !== next && !found.includes(row)) {
        found.push(row);
        frontier.push(row.pid);
      }
    }
  }
  return found;
};
