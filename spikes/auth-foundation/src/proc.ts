import { spawn } from "node:child_process";

export type ProcResult = {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

export type ProcOptions = {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /** Called with the child's PID as soon as it exists, so a caller that is interrupted can kill it. */
  readonly onStart?: (pid: number) => void;
};

/** Kills a process and everything it started. `child.kill()` leaves grandchildren on Windows. */
export const killTree = (pid: number): Promise<void> =>
  new Promise((resolve) => {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("error", () => {
        resolve();
      });
      killer.on("close", () => {
        resolve();
      });
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
    resolve();
  });

/**
 * Runs a program with an argument array. No shell is involved, so nothing in
 * `args` is ever parsed as shell syntax. Output is collected, not printed.
 */
export const runProcess = (
  command: string,
  args: readonly string[],
  options: ProcOptions,
): Promise<ProcResult> =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    if (child.pid !== undefined) {
      options.onStart?.(child.pid);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        void killTree(child.pid);
      }
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr });
    });
  });

/** Whether a process with this ID exists. EPERM (it exists, but is not ours) counts as alive. */
export const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), "code") !== "ESRCH";
  }
};

/**
 * The command line of a running process, `null` if there is no such process, and
 * `undefined` if the platform would not say (a missing or blocked PowerShell, a timeout).
 * `pid` is an integer by its type and is never built from untrusted text.
 */
export const commandLineOf = async (pid: number, cwd: string): Promise<string | null | undefined> => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  const listing =
    process.platform === "win32"
      ? await runProcess(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}" | ForEach-Object { $_.CommandLine }`,
          ],
          { cwd, timeoutMs: 60_000 },
        )
      : await runProcess("ps", ["-p", String(pid), "-o", "args="], { cwd, timeoutMs: 30_000 });
  const failed =
    listing.timedOut ||
    listing.code === null ||
    (process.platform === "win32" ? listing.code !== 0 : listing.code > 1);
  if (failed) {
    return undefined;
  }
  // `ps -p` exits 1 for a process that does not exist; PowerShell prints nothing for one.
  const line = listing.stdout.trim();
  return line === "" ? null : line;
};
