import type { RunOptions, RunResult, TaskProcesses } from "@ostra/adapter-executor-host";
import type { Bridge } from "./bridge/bridge-server.ts";

// The host executor's processes seam over a box's bridge (spike 3's `AgentHost`): the agent and the
// setup script run in the agent's container, as the agent's user, started by the box's init. Git
// and the task's files stay with the sidecar, on the box's shared task volume.

export const bridgeProcesses = (bridge: Bridge): TaskProcesses => ({
  startAgent: async (launch) => {
    try {
      const process = await bridge.spawn({ command: launch.command, args: launch.args, cwd: launch.cwd, env: launch.env });
      return {
        ok: true,
        value: {
          process: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, pid: process.pid, exited: process.exited },
          // The agent's container is the unit: the init kills every process of the agent's user.
          unit: {
            kind: "container",
            adopt: () => Promise.resolve(),
            killAll: async () => {
              await bridge.reapAll();
            },
            dispose: () => Promise.resolve(),
          },
          stdinEnd: () => {
            process.stdin.end();
          },
        },
      };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" };
    }
  },
  run: async (command: string, args: readonly string[], options: RunOptions): Promise<RunResult> => {
    let started;
    try {
      started = await bridge.spawn({ command, args, cwd: options.cwd, env: options.env });
    } catch (error) {
      return { code: null, stdout: "", stderr: error instanceof Error ? error.message.slice(0, 200) : "spawn failed" };
    }
    const max = options.maxBuffer ?? 4 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    started.stdin.end();
    started.stdout.setEncoding("utf8");
    started.stderr.setEncoding("utf8");
    started.stdout.on("data", (chunk: string) => {
      if (stdout.length < max) {
        stdout += chunk;
      }
      options.onOutput?.("stdout", chunk);
    });
    started.stderr.on("data", (chunk: string) => {
      if (stderr.length < max) {
        stderr += chunk;
      }
      options.onOutput?.("stderr", chunk);
    });
    const onAbort = (): void => {
      void bridge.killTree(started.pid).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const exit = await started.exited;
    options.signal?.removeEventListener("abort", onAbort);
    return { code: exit.code, stdout, stderr };
  },
});
