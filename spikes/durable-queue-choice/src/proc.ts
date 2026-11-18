// Child-process helpers for the harness: spawn Node children with a validated IPC channel,
// kill them with the equivalent of `kill -9`, and make sure nothing outlives the run.
//
// On Windows, `child.kill("SIGKILL")` calls TerminateProcess: the process gets no chance to run
// a handler, flush or close a socket. That is the same abruptness as `kill -9` on POSIX.
// The children here spawn no grandchildren, so killing the PID kills the tree; `killTree` is used
// for cleanup anyway (taskkill /T /F on Windows).

import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { promisify } from "node:util";
import type { z } from "zod";
import { baseChildEnv } from "./child-env.ts";

const execFileAsync = promisify(execFile);

export type ExitInfo = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

export type ManagedChild<Out> = {
  readonly name: string;
  readonly pid: number;
  readonly logPath: string;
  /** Every message received so far, already validated against the child's message schema. */
  readonly messages: readonly Out[];
  send: (message: object) => void;
  waitForMessage: (predicate: (message: Out) => boolean, timeoutMs: number, what: string) => Promise<Out>;
  /** SIGKILL on POSIX, TerminateProcess on Windows. Resolves once the process is gone. */
  kill9: () => Promise<ExitInfo>;
  /** Sends the child's own "stop" message and waits for it to exit by itself. */
  exited: Promise<ExitInfo>;
  isAlive: () => boolean;
};

type Waiter<Out> = {
  readonly predicate: (message: Out) => boolean;
  readonly resolve: (message: Out) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
};

const tracked = new Set<ChildProcess>();

/**
 * Last-resort cleanup, safe to call from a synchronous `exit` handler, where an async API cannot
 * finish. It only signals children. The repo's async-only lint rule matches its `Sync` suffix, so
 * its call sites carry a one-line disable with this reason.
 */
export const killTrackedSync = (): void => {
  for (const child of tracked) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
};

export const killTree = async (pid: number): Promise<void> => {
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

export const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export type SpawnOptions<S extends z.ZodType> = {
  readonly name: string;
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logPath: string;
  readonly messageSchema: S;
};

export const spawnNode = <S extends z.ZodType>(options: SpawnOptions<S>): ManagedChild<z.output<S>> => {
  type Out = z.output<S>;
  const log: WriteStream = createWriteStream(options.logPath, { flags: "a" });
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", options.entry],
    {
      // An allowlist, never the developer's whole shell: a replica or a panel needs none of its keys.
      env: { ...baseChildEnv(), ...options.env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  tracked.add(child);
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`failed to spawn ${options.name}`);
  }

  child.stdout?.on("data", (chunk: Buffer) => log.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => log.write(chunk));

  const messages: Out[] = [];
  const waiters = new Set<Waiter<Out>>();

  child.on("message", (raw: unknown) => {
    const parsed = options.messageSchema.safeParse(raw);
    if (!parsed.success) {
      log.write(`[harness] ${options.name} sent an invalid message\n`);
      return;
    }
    const message: Out = parsed.data;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  });

  const exited = new Promise<ExitInfo>((resolve) => {
    child.on("exit", (code, signal) => {
      tracked.delete(child);
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.reject(new Error(`${options.name} exited (code ${String(code)}, signal ${String(signal)}) while waited on`));
      }
      log.end();
      resolve({ code, signal });
    });
  });

  const waitForMessage = (predicate: (message: Out) => boolean, timeoutMs: number, what: string): Promise<Out> => {
    const existing = messages.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise<Out>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`${options.name}: timed out after ${String(timeoutMs)} ms waiting for ${what}`));
      }, timeoutMs);
      const waiter: Waiter<Out> = { predicate, resolve, reject, timer };
      waiters.add(waiter);
    });
  };

  const isAlive = (): boolean => child.exitCode === null && child.signalCode === null;

  const kill9 = async (): Promise<ExitInfo> => {
    if (isAlive()) {
      child.kill("SIGKILL");
    }
    return exited;
  };

  return {
    name: options.name,
    pid,
    logPath: options.logPath,
    messages,
    send: (message) => {
      if (isAlive() && child.connected) {
        child.send(message);
      }
    },
    waitForMessage,
    kill9,
    exited,
    isAlive,
  };
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const waitUntil = async (
  check: () => Promise<boolean> | boolean,
  options: { readonly timeoutMs: number; readonly intervalMs: number; readonly what: string },
): Promise<void> => {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(options.timeoutMs)} ms waiting for ${options.what}`);
    }
    await sleep(options.intervalMs);
  }
};
