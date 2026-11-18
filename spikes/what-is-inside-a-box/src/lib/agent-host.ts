// Where the agent's process lives. Spike 1's driver spawned the agent as its
// own child. In a box, the driver runs in the sidecar and the agent runs in
// the agent's container, so the driver reaches it through an `AgentHost`:
//
//   - `localHost`: a child of this process (spike 1's way; the loopback
//     rehearsal and the `host` executor).
//   - the bridge host (`src/bridge/remote-host.ts`): the box's init program
//     spawns and kills on the sidecar's behalf, over the bridge.
//
// The driver itself doesn't change: it gets the agent's stdio as streams, and
// lists and kills the agent's processes through the host.

import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { killTree, listProcesses, type ProcessInfo } from "./process-tree.ts";

export type AgentLaunch = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The agent's whole environment. Nothing is inherited from the runner or the init. */
  readonly env: Readonly<Record<string, string>>;
};

export type ProcessExit = { readonly code: number | null; readonly signal: string | null };

export type AgentProcess = {
  /** The PID in the host's PID namespace (the agent container's, for the bridge). */
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<ProcessExit>;
  /** Set once the process has exited. */
  readonly exitStatus: () => ProcessExit | undefined;
};

export type HostPlatform = "linux" | "darwin" | "win32";

export type AgentHost = {
  readonly kind: "local" | "bridge";
  readonly platform: HostPlatform;
  readonly spawn: (launch: AgentLaunch) => Promise<AgentProcess>;
  readonly listProcesses: () => Promise<ProcessInfo[]>;
  /** Kills a process and everything below it (its process group on POSIX). */
  readonly killTree: (pid: number) => Promise<void>;
  /** SIGKILL to one process only, as a crash would. */
  readonly killOne: (pid: number) => Promise<void>;
};

const hostPlatform = (): HostPlatform => {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
};

export const localHost = (): AgentHost => ({
  kind: "local",
  platform: hostPlatform(),
  spawn: async (launch) => {
    const child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX: its own process group, so the whole group can be killed.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const pid = child.pid;
    if (pid === undefined) {
      const error = await new Promise<Error>((resolve) => child.once("error", resolve));
      throw new Error(`could not spawn the agent: ${error.message}`);
    }
    let status: ProcessExit | undefined;
    const exited = new Promise<ProcessExit>((resolve) => {
      child.once("exit", (code, signal) => {
        status = { code, signal };
        resolve(status);
      });
    });
    return { pid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, exitStatus: () => status };
  },
  listProcesses,
  killTree,
  killOne: (pid) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    return Promise.resolve();
  },
});
