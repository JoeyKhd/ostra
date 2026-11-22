import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { newUnitMarker } from "@ostra/adapter-executor-host";
import type { RunOptions, RunResult, TaskProcesses } from "@ostra/adapter-executor-host";
import type { Bridge } from "./bridge/bridge-server.ts";

// The host executor's processes seam over a box's bridge (spike 3's `AgentHost`): the agent and the
// setup script run in the agent's container, as the agent's user, started by the box's init. Git
// and the task's files stay with the sidecar, on the box's shared task volume.
//
// Milestone 8 (ADR 0068): the app's processes and the image's browser too, through the init's
// `app_spawn` and `browser_start`; an app's output comes over the bridge and the sidecar writes its
// log on the task volume, and the browser's pipe rides the bridge's own channel for it.

/** Resolves once the stream has ended, or closed early (the bridge was lost): it never rejects. */
const drained = (stream: Readable): Promise<void> => finished(stream).catch(() => undefined);

export const bridgeProcesses = (bridge: Bridge): TaskProcesses => ({
  // The agent's container is the unit: the init kills every process of the agent's user.
  createUnit: (_name, marker) =>
    Promise.resolve({
      kind: "container",
      marker: marker ?? newUnitMarker(),
      pids: null,
      adopt: () => Promise.resolve(),
      killAll: async () => {
        // An init that doesn't answer can't fail a stop (ADR 0029, Q154): the reap ends at its
        // deadline, the stop goes on, and the box's removal, once the sidecar exits, ends the rest.
        await bridge.reapAll().catch(() => undefined);
      },
      dispose: () => Promise.resolve(),
    }),
  startAgent: async (launch) => {
    try {
      const process = await bridge.spawn({ command: launch.command, args: launch.args, cwd: launch.cwd, env: launch.env });
      return {
        ok: true,
        value: {
          process: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, pid: process.pid, exited: process.exited },
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
    // The exit and the end of both streams, as the host's `runProgram` waits for a child's `close`.
    // The exit alone answers too soon, with output still to come: the init sends it as its child
    // exits, often before the last output and the eof are on the bridge, and a spawn answer read in
    // one chunk with its output and exit leaves that output buffered here, flowing to the listeners
    // above only on a later tick. Either way git's answer (a SHA, a ref list) came back empty.
    const [exit] = await Promise.all([started.exited, drained(started.stdout), drained(started.stderr)]);
    options.signal?.removeEventListener("abort", onAbort);
    return { code: exit.code, stdout, stderr };
  },
  // Milestone 8 (F-140): in the agent's container, as the agent's user, in a group of its own.
  startApp: async (launch) => {
    try {
      const app = await bridge.spawnApp({ command: launch.command, args: launch.args, cwd: launch.cwd, env: launch.env });
      return { ok: true, value: app };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" };
    }
  },
  // Milestone 8 (F-121): the image's browser, started by the init with a fresh profile.
  startBrowser: async () => {
    try {
      const browser = await bridge.startBrowser();
      return browser.available ? { available: true, program: browser.program, profileDir: browser.profileDir, ends: browser.ends } : browser;
    } catch {
      // An image whose init is older than the browser has none to offer; else the bridge didn't answer.
      return { available: false, reason: bridge.features.includes("browser") ? "failed-to-start" : "not-in-image" };
    }
  },
});
