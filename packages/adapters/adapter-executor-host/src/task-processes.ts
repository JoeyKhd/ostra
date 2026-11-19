import { spawn } from "node:child_process";
import type { AgentLaunch, AgentProcess, ProcessExit } from "@ostra/adapter-sdk";
import type { Containment, ContainmentUnit } from "./containment.ts";
import { runProgram } from "./process.ts";
import type { RunOptions, RunResult } from "./process.ts";

// Where a task's agent and its setup script run: spike 3's `AgentHost` seam. On `host` they're
// children of the runner on this machine, in the task's containment unit. In a `docker` box they
// run in the agent's container, started by the box's init over the bridge, while git and the files
// stay with the sidecar on the box's shared task volume (ticket 22). The executor's logic is the
// same either way.

export type StartedAgent = {
  readonly process: AgentProcess;
  /** Closes the agent's stdin: its chance to exit on its own. */
  readonly stdinEnd: () => void;
};

export type StartAgentResult = { readonly ok: true; readonly value: StartedAgent } | { readonly ok: false; readonly reason: string };

export type TaskProcesses = {
  /** The task's unit (ticket 42): made with its workspace, and every process of the task joins it. */
  readonly createUnit: (name: string, marker?: string) => Promise<ContainmentUnit>;
  /** Starts the agent from its launch, with exactly the launch's environment, in `unit`. */
  readonly startAgent: (launch: AgentLaunch, unit: ContainmentUnit) => Promise<StartAgentResult>;
  /** Runs a program to its end, streaming its output: the setup script, in `options.unit`. */
  readonly run: (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;
};

/** This machine: the runner's own children, ended together through `containment`. */
export const localProcesses = (containment: () => Containment): TaskProcesses => ({
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
    const started = await new Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>((resolve) => {
      child.once("spawn", () => {
        resolve({ ok: true });
      });
      child.once("error", (error) => {
        resolve({ ok: false, code: "code" in error && typeof error.code === "string" ? error.code : error.name });
      });
    });
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
});
