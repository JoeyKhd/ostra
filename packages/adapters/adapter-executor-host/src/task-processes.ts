import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { BOX_BROWSER_PROFILE_PREFIX, boxBrowserFlags, killTree, removeProfileDir } from "@ostra/adapter-sdk";
import type { AgentLaunch, AgentProcess, AppProcessLaunch, BrowserProcessEnds, ProcessExit } from "@ostra/adapter-sdk";
import type { NoBrowserReason } from "@ostra/protocol";
import type { Containment, ContainmentUnit } from "./containment.ts";
import { runProgram } from "./process.ts";
import type { RunOptions, RunResult } from "./process.ts";

// Where a task's agent and its setup script run: spike 3's `AgentHost` seam. On `host` they're
// children of the runner on this machine, in the task's containment unit. In a `docker` box they
// run in the agent's container, started by the box's init over the bridge, while git and the files
// stay with the sidecar on the box's shared task volume (ticket 22). The executor's logic is the
// same either way.
//
// Milestone 8 (ADR 0068): the app's processes and the box's browser go through the same seam, so
// the same executor logic runs them on `host` (here, in the unit) and in a box (through the init).

export type StartedAgent = {
  readonly process: AgentProcess;
  /** Closes the agent's stdin: its chance to exit on its own. */
  readonly stdinEnd: () => void;
};

export type StartAgentResult = { readonly ok: true; readonly value: StartedAgent } | { readonly ok: false; readonly reason: string };

/** Milestone 8 (F-140): one of the app's processes, running: its output as it comes, and its stop. */
export type StartedApp = {
  readonly pid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<ProcessExit>;
  /** A polite signal to its tree, then a kill of the tree after `graceMs`; resolves once it exited. */
  readonly stop: (graceMs: number) => Promise<void>;
};

export type StartAppResult = { readonly ok: true; readonly value: StartedApp } | { readonly ok: false; readonly reason: string };

/** Milestone 8 (F-121): the box's browser, as the processes seam starts it: its program's name, its profile and its pipe's ends. */
export type StartedBrowserProcess = {
  readonly available: true;
  /** The program's file name, which names the browser in the pictures (`browserIdentity`). */
  readonly program: string;
  readonly profileDir: string;
  readonly ends: BrowserProcessEnds;
};

export type BrowserProcessResult = StartedBrowserProcess | { readonly available: false; readonly reason: NoBrowserReason };

/**
 * The browser a `host` runner starts (ADR 0068): a Chromium-family program, and the arguments
 * before ostra's flags (a test's fake browser is `node` and its script). Ticket 11 finds it:
 * `OSTRA_RUNNER_BROWSER`, then Chrome, Chromium and Edge, then the pinned download.
 */
export type BrowserProgram = { readonly command: string; readonly args?: readonly string[] };

export type TaskProcesses = {
  /** The task's unit (ticket 42): made with its workspace, and every process of the task joins it. */
  readonly createUnit: (name: string, marker?: string) => Promise<ContainmentUnit>;
  /** Starts the agent from its launch, with exactly the launch's environment, in `unit`. */
  readonly startAgent: (launch: AgentLaunch, unit: ContainmentUnit) => Promise<StartAgentResult>;
  /** Runs a program to its end, streaming its output: the setup script, in `options.unit`. */
  readonly run: (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;
  /** Milestone 8 (F-140): starts one of the app's processes, with exactly its environment and no stdin, in `unit`. */
  readonly startApp: (launch: AppProcessLaunch, unit: ContainmentUnit) => Promise<StartAppResult>;
  /** Milestone 8 (F-121): starts the box's browser with a fresh profile and its DevTools pipe, in `unit`, with `env` as its whole environment. */
  readonly startBrowser: (unit: ContainmentUnit, env: Readonly<Record<string, string>>) => Promise<BrowserProcessResult>;
};

/** A spawned child's start: its PID, or the error's code. */
const spawned = (child: ChildProcess): Promise<{ readonly ok: true; readonly pid: number } | { readonly ok: false; readonly code: string }> =>
  new Promise((resolve) => {
    child.once("spawn", () => {
      resolve(child.pid === undefined ? { ok: false, code: "no pid" } : { ok: true, pid: child.pid });
    });
    child.once("error", (error) => {
      resolve({ ok: false, code: "code" in error && typeof error.code === "string" ? error.code : error.name });
    });
  });

/** Ends a process's tree politely, then for good after `graceMs`; resolves once it exited. */
export const stopTree = async (pid: number, exited: Promise<unknown>, graceMs: number): Promise<void> => {
  if (process.platform !== "win32") {
    try {
      // Its own process group (`detached`): the signal reaches its children too.
      process.kill(-pid, "SIGTERM");
    } catch {
      // Gone already.
    }
    const ended = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(resolve, graceMs, false).unref();
      }),
    ]);
    if (ended) {
      return;
    }
  }
  // Windows has no polite signal for a console process without a window: its tree goes at once.
  await killTree(pid);
  await exited;
};

/** This machine: the runner's own children, ended together through `containment`. */
export const localProcesses = (containment: () => Containment, browser: () => BrowserProgram | null = () => null): TaskProcesses => ({
  createUnit: (name, marker) => containment().create(name, marker),
  startAgent: async (launch, unit) => {
    // Exactly the launch's environment: nothing of the runner's is inherited (ADR 0030).
    const child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const exited = new Promise<ProcessExit>((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    // Into the unit in the same tick as `spawn`, before the agent can start a child of its own.
    const pid = child.pid;
    const adopted = pid === undefined ? Promise.resolve() : unit.adopt(pid, { exited });
    const started = await spawned(child);
    await adopted.catch(() => undefined);
    if (!started.ok || pid === undefined) {
      return { ok: false, reason: started.ok ? "no pid" : started.code };
    }
    const unitPids = unit.pids;
    return {
      ok: true,
      value: {
        process: { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, pid, exited, ...(unitPids === null ? {} : { unitPids }) },
        stdinEnd: () => {
          child.stdin.end();
        },
      },
    };
  },
  run: runProgram,
  startApp: async (launch, unit) => {
    // Exactly the launch's environment, as the agent's: nothing of the runner's (ADR 0030).
    const child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const exited = new Promise<ProcessExit>((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    const adopted = child.pid === undefined ? Promise.resolve() : unit.adopt(child.pid, { exited });
    const started = await spawned(child);
    await adopted.catch(() => undefined);
    if (!started.ok) {
      return { ok: false, reason: started.code };
    }
    const pid = started.pid;
    return { ok: true, value: { pid, stdout: child.stdout, stderr: child.stderr, exited, stop: (graceMs) => stopTree(pid, exited, graceMs) } };
  },
  startBrowser: async (unit, env) => {
    const program = browser();
    if (program === null) {
      return { available: false, reason: "not-found" };
    }
    // A fresh profile in a temporary folder, for this browser only (ADR 0068).
    const profileDir = await mkdtemp(path.join(tmpdir(), BOX_BROWSER_PROFILE_PREFIX));
    const child = spawn(program.command, [...(program.args ?? []), ...boxBrowserFlags(profileDir)], {
      env: { ...env },
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
    const adopted = child.pid === undefined ? Promise.resolve() : unit.adopt(child.pid, { exited });
    const started = await spawned(child);
    await adopted.catch(() => undefined);
    const toBrowser = child.stdio[3];
    const fromBrowser = child.stdio[4];
    if (!started.ok || !(toBrowser instanceof Writable) || !(fromBrowser instanceof Readable)) {
      if (started.ok) await killTree(started.pid);
      await removeProfileDir(profileDir);
      return { available: false, reason: "failed-to-start" };
    }
    toBrowser.on("error", () => {
      // EPIPE once the browser is gone: its end is reported through `gone`.
    });
    const pid = started.pid;
    // The profile goes with the browser, however it ends (ADR 0068).
    const gone = exited.then(() => removeProfileDir(profileDir));
    return {
      available: true,
      program: path.basename(program.command),
      profileDir,
      ends: {
        write: (bytes) => {
          if (!toBrowser.destroyed) toBrowser.write(bytes);
        },
        onBytes: (listener) => {
          fromBrowser.on("data", listener);
        },
        gone,
        kill: () => killTree(pid),
      },
    };
  },
});
