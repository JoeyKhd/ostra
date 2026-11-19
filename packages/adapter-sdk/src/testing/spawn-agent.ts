import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentCommand, AgentLaunch } from "../agent/base.ts";
import { killTree } from "../agent/acp/process-tree.ts";
import type { StartedAgent } from "./agent-suite.ts";

/**
 * Starts an agent's process from its launch, as an executor would: the launch's files written
 * first, then an argument array, the launch's own environment and nothing inherited, a process
 * group of its own on POSIX. For contract suites;
 * the real executors are the runner's.
 */
export const spawnAgentProcess = async (launch: AgentLaunch): Promise<StartedAgent> => {
  for (const file of launch.files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, "utf8");
  }
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

/**
 * Runs an agent's export or import command as an executor would: an argument array, the command's
 * own environment and nothing inherited, its standard output written to `stdoutTo` when it names a
 * file. For contract suites.
 */
export const runAgentCommand = async (command: AgentCommand): Promise<{ readonly code: number | null }> => {
  const sink = command.stdoutTo === undefined ? undefined : createWriteStream(command.stdoutTo);
  if (sink !== undefined) {
    await new Promise<void>((resolve, reject) => {
      sink.once("open", () => {
        resolve();
      });
      sink.once("error", reject);
    });
  }
  const child = spawn(command.command, [...command.args], {
    cwd: command.cwd,
    env: { ...command.env },
    stdio: ["ignore", sink ?? "ignore", "ignore"],
    windowsHide: true,
  });
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", () => {
      resolve(null);
    });
    child.on("close", (exit) => {
      resolve(exit);
    });
  });
  if (sink !== undefined) {
    await new Promise<void>((resolve) => {
      sink.end(resolve);
    });
  }
  return { code };
};
