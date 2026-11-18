import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const spikeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Where this harness keeps what it starts: embedded-postgres data directories (`run-<pid>-<ts>`) and the
// browser's profile (`edge-<pid>`). The pid in the name is the harness's, so a leftover can be told from a live run.
export const scratchRoot = path.join(spikeRoot, ".pgdata");

// Every process this harness starts is registered here, and killed as a whole tree on the way out.
// On Windows that means taskkill /T /F, since a plain kill leaves the children (postgres) running.
const children = new Set<number>();
// Every pid ever registered, so the end-of-run check can ask whether any of them is still alive.
const everStarted = new Set<number>();

export const registerPid = (pid: number): void => {
  if (pid <= 0) return;
  children.add(pid);
  everStarted.add(pid);
};

export const killTree = async (pid: number): Promise<void> => {
  children.delete(pid);
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
};

export const killAll = async (): Promise<void> => {
  await Promise.all([...children].map((pid) => killTree(pid)));
};

export const installExitHandlers = (): void => {
  const bail = (): void => {
    void killAll().finally(() => process.exit(130));
  };
  process.on("SIGINT", bail);
  process.on("SIGTERM", bail);
};

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and is not ours; ESRCH means it is gone
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

// A harness that was killed hard (SIGKILL, a power cut) cannot clean up after itself. At the start of the
// next run, remove what earlier runs left in the scratch directory, unless the harness that made it is alive.
export const cleanStaleRuns = async (): Promise<number> => {
  let names: string[];
  try {
    names = await readdir(scratchRoot);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = /^(?:run|edge)-(\d+)(?:-|$)/.exec(name);
    const owner = Number(match?.[1]);
    if (match === null || !Number.isInteger(owner) || owner === process.pid || isAlive(owner)) continue;
    await rm(path.join(scratchRoot, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    removed += 1;
  }
  return removed;
};

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") reject(new Error("no port"));
        else resolve(address.port);
      });
    });
  });

// A child gets only what it needs from the environment, not every variable the harness's shell had
// (an exported model key, a GitHub or Linear token). These are the names Node, Postgres and the OS need.
const ENV_ALLOWED = new Set(
  [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "USER",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "ALLUSERSPROFILE",
    "COMPUTERNAME",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "LANG",
    "LC_ALL",
    "TZ",
  ].map((name) => name.toUpperCase()),
);

export const childEnv = (extra: Readonly<Record<string, string>>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && ENV_ALLOWED.has(name.toUpperCase())) out[name] = value;
  }
  return { ...out, ...extra };
};

export type Spawned = {
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly pid: number;
  readonly firstLine: Promise<string>;
  readonly stop: () => Promise<void>;
};

export const spawnNode = (args: readonly string[], env: Record<string, string>, cwd = spikeRoot): Spawned => {
  // Absolute script paths, so every process this harness starts has the spike's folder in its command
  // line, and a leftover can be found by it.
  const [script, ...rest] = args;
  const absolute = script === undefined ? [] : [path.isAbsolute(script) ? script : path.join(spikeRoot, script), ...rest];
  const child = spawn(process.execPath, absolute, {
    cwd,
    // OSTRA_SPIKE_EXIT_ON_STDIN_CLOSE: stdin is a pipe the harness holds open. If the harness dies (even by
    // SIGKILL), the pipe closes and the child ends itself, so nothing is orphaned.
    env: childEnv({ OSTRA_SPIKE_EXIT_ON_STDIN_CLOSE: "1", ...env }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const pid = child.pid ?? 0;
  registerPid(pid);
  child.stdin.on("error", () => undefined);
  let buffered = "";
  const firstLine = new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        child.stdout.off("data", onData);
        resolve(buffered.slice(0, newline));
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      reject(new Error(`process exited with ${String(code)} before it printed a line`));
    });
    child.once("error", reject);
  });
  firstLine.catch(() => undefined);
  child.stderr.on("data", () => undefined);
  return { child, pid, firstLine, stop: () => killTree(pid) };
};

const dbLine = z.object({ databaseUrl: z.string(), postmasterPid: z.number(), port: z.number() });

export type DevDb = {
  readonly url: string;
  readonly postmasterPid: number;
  readonly stop: () => Promise<void>;
};

export const startDevDb = async (): Promise<DevDb> => {
  await mkdir(scratchRoot, { recursive: true });
  const dir = path.join(scratchRoot, `run-${String(process.pid)}-${String(Date.now())}`);
  const proc = spawnNode(["src/server/dev-db.ts", dir], {});
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error("embedded-postgres did not start in 90 s"));
    }, 90_000);
  });
  try {
    const line = dbLine.parse(JSON.parse(await Promise.race([proc.firstLine, timeout])));
    return {
      url: line.databaseUrl,
      postmasterPid: line.postmasterPid,
      stop: async () => {
        await proc.stop();
        if (line.postmasterPid > 0) await killTree(line.postmasterPid);
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
      },
    };
  } catch (error) {
    await proc.stop();
    throw error;
  }
};

const serverLine = z.object({ listening: z.number() });

export type ServerProc = { readonly port: number; readonly baseUrl: string; readonly stop: () => Promise<void> };

// One replica as a process of its own, started with the run's runner token (there is no default one).
export const startServerProc = async (
  databaseUrl: string,
  replica: string,
  runnerToken: string,
  extra: Record<string, string> = {},
): Promise<ServerProc> => {
  const proc = spawnNode(["src/server/main.ts"], {
    DATABASE_URL: databaseUrl,
    PORT: "0",
    OSTRA_SPIKE_REPLICA_ID: replica,
    OSTRA_SPIKE_QUIET: "1",
    OSTRA_SPIKE_RUNNER_TOKEN: runnerToken,
    OSTRA_SPIKE_DEV_LOGIN: "1",
    OSTRA_SPIKE_PG_IDLE_MS: "0",
    ...extra,
  });
  const first = serverLine.parse(JSON.parse(await proc.firstLine));
  return { port: first.listening, baseUrl: `http://127.0.0.1:${String(first.listening)}`, stop: proc.stop };
};

// CPU seconds used so far by the database: the postmaster and every process under it.
export const databaseCpuSeconds = async (postmasterPid: number): Promise<number | null> => {
  if (!Number.isInteger(postmasterPid) || postmasterPid <= 0) return null;
  if (process.platform === "win32") {
    const script = [
      "param([int]$root)",
      "$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId",
      "$ids = New-Object System.Collections.Generic.HashSet[int]",
      "[void]$ids.Add($root)",
      "$grew = $true",
      "while ($grew) { $grew = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId); $grew = $true } } }",
      "$sum = 0.0",
      "foreach ($id in $ids) { $proc = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($proc) { $sum += $proc.TotalProcessorTime.TotalSeconds } }",
      "[Console]::Out.Write($sum.ToString([System.Globalization.CultureInfo]::InvariantCulture))",
    ].join("; ");
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `& { ${script} } ${String(postmasterPid)}`,
      ]);
      const value = Number(stdout.trim());
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }
  try {
    // Linux: the CPU seconds of the postmaster and its children, from ps.
    const { stdout } = await execFileAsync("ps", ["-o", "pid=,ppid=,cputimes=", "-A"]);
    const rowsOut = stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((cols) => cols.length === 3 && cols.every(Number.isFinite));
    const ids = new Set<number>([postmasterPid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [pid, ppid] of rowsOut) {
        if (pid !== undefined && ppid !== undefined && ids.has(ppid) && !ids.has(pid)) {
          ids.add(pid);
          grew = true;
        }
      }
    }
    let sum = 0;
    for (const [pid, , cpu] of rowsOut) if (pid !== undefined && cpu !== undefined && ids.has(pid)) sum += cpu;
    return sum;
  } catch {
    return null;
  }
};

export const readText = (file: string): Promise<string> => readFile(file, "utf8");

// Resolves to the value, or to `fallback` after `ms`, and leaves no timer behind.
export const withTimeout = async <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

// What is still running after the run: any process whose command line holds the spike's folder (not this
// process), and any process this harness started, whose pid is still alive. The second part is what can see
// the browser: Edge runs from its own install directory, and its profile directory is in %TEMP%.
export const leftoverProcesses = async (): Promise<string[]> => {
  const found: string[] = [];
  for (const pid of everStarted) if (pid !== process.pid && isAlive(pid)) found.push(`started by this run, pid ${String(pid)} still alive`);
  try {
    if (process.platform === "win32") {
      const script = [
        "param([string]$root, [int]$self)",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) -and $_.ProcessId -ne $self -and -not $_.CommandLine.Contains('Get-CimInstance') } | ForEach-Object { $_.Name + ' ' + $_.ProcessId }",
      ].join("; ");
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& { ${script} } -root '${spikeRoot.replace(/'/g, "''")}' -self ${String(process.pid)}`]);
      found.push(...stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
    } else {
      const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]);
      found.push(
        ...stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.includes(spikeRoot) && !l.startsWith(`${String(process.pid)} `) && !l.includes("ps -eo")),
      );
    }
  } catch {
    // the listing itself failed: the pid check above still stands
  }
  return found;
};
