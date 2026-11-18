import { spawn } from "node:child_process";

import type { AgentLaunch } from "../agent/base.ts";
import { killTree } from "../agent/acp/process-tree.ts";
import type { StartedAgent } from "./agent-suite.ts";

/**
 * Starts an agent's process from its launch, as an executor would: an argument array, the launch's
 * own environment and nothing inherited, a process group of its own on POSIX. For contract suites;
 * the real executors are the runner's.
 */
export const spawnAgentProcess = async (launch: AgentLaunch): Promise<StartedAgent> => {
  const child = spawn(launch.command, [...launch.args], {
    cwd: launch.cwd,
    env: { ...launch.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  if (child.pid === undefined) {
    const error = await new Promise<Error>((resolve) => child.once("error", resolve));
    throw new Error(`could not spawn the agent: ${error.message}`);
  }
  const { pid } = child;
  return {
    io: { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, pid },
    stop: async () => {
      await killTree(pid);
    },
  };
};
