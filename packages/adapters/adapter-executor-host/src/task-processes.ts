import { spawn } from "node:child_process";
import type { AgentLaunch, AgentProcess, ProcessExit } from "@ostra/adapter-sdk";
import { processTreeContainment } from "./containment.ts";
import type { Containment, ContainmentUnit } from "./containment.ts";
import { runProgram } from "./process.ts";
import type { RunOptions, RunResult } from "./process.ts";

// Where a task's agent and its setup script run: spike 3's `AgentHost` seam. On `host` they're
// children of the runner on this machine. In a `docker` box they run in the agent's container,
// started by the box's init over the bridge, while git and the files stay with the sidecar on the
// box's shared task volume (ticket 22). The executor's logic is the same either way.

export type StartedAgent = {
  readonly process: AgentProcess;
  /** Every process of the agent, as one unit to end together. */
  readonly unit: ContainmentUnit;
  /** Closes the agent's stdin: its chance to exit on its own. */
  readonly stdinEnd: () => void;
};

export type StartAgentResult = { readonly ok: true; readonly value: StartedAgent } | { readonly ok: false; readonly reason: string };

export type TaskProcesses = {
  /** Starts the agent from its launch, with exactly the launch's environment. */
  readonly startAgent: (launch: AgentLaunch, unitName: string) => Promise<StartAgentResult>;
  /** Runs a program to its end, streaming its output: the setup script. */
  readonly run: (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;
};

/** This machine: the runner's own children, ended together through `containment`. */
export const localProcesses = (containment: () => Containment): TaskProcesses => ({
  startAgent: async (launch, unitName) => {
    // Exactly the launch's environment: nothing of the runner's is inherited (ADR 0030).
    const child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const started = await new Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>((resolve) => {
      child.once("spawn", () => {
        resolve({ ok: true });
      });
      child.once("error", (error) => {
        resolve({ ok: false, code: "code" in error && typeof error.code === "string" ? error.code : error.name });
      });
    });
    if (!started.ok || child.pid === undefined) {
      return { ok: false, reason: started.ok ? "no pid" : started.code };
    }
    const pid = child.pid;
    let unit: ContainmentUnit;
    try {
      unit = await containment().create(unitName);
      await unit.adopt(pid);
    } catch {
      // The cgroup refused the process (a controller in the way): the tree still ends it.
      unit = await processTreeContainment().create(unitName);
      await unit.adopt(pid);
    }
    const exited = new Promise<ProcessExit>((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    return {
      ok: true,
      value: {
        process: { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, pid, exited },
        unit,
        stdinEnd: () => {
          child.stdin.end();
        },
      },
    };
  },
  run: runProgram,
});
