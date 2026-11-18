// Running a child process the way the runner does: arguments as an array (never
// a shell string), an explicit environment (never this process's), output
// capped, a time limit that kills the whole tree, and the PID tracked for the
// final sweep for as long as the child lives.

import { spawn } from "node:child_process";
import { killTree } from "../lib/process-tree.ts";
import { trackPid, untrackPid } from "./processes.ts";
import { gitInvocation } from "./sandbox.ts";

export type ExecResult = {
  /** Null when the process was killed by the time limit or a signal. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly ms: number;
};

export type ExecOptions = {
  readonly cwd: string;
  readonly timeoutMs: number;
  /** The child's whole environment. Required: there is no default, so the harness's own is never passed on by omission (see `cleanEnv`). */
  readonly env: Readonly<Record<string, string>>;
  /** Called with the child's PID right after the spawn. `exec` already tracks the PID for the sweep. */
  readonly onSpawn?: (pid: number) => void;
  /** Bytes kept per stream. Default 1 MB. */
  readonly maxBytes?: number;
};

const append = (kept: string, chunk: Buffer, max: number): string => (kept.length >= max ? kept : (kept + chunk.toString("utf8")).slice(0, max));

export const exec = async (command: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> => {
  const started = Date.now();
  const max = options.maxBytes ?? 1_000_000;
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid !== undefined) {
    trackPid(pid);
    options.onSpawn?.(pid);
  }
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk, max);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk, max);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (pid !== undefined) void killTree(pid);
  }, options.timeoutMs);
  return new Promise<ExecResult>((resolve) => {
    const finish = (code: number | null): void => {
      clearTimeout(timer);
      if (pid !== undefined) untrackPid(pid);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started });
    };
    child.once("error", (error) => {
      stderr += error.message;
      finish(null);
    });
    child.once("close", (code) => {
      finish(code);
    });
  });
};

/**
 * Runs git, failing loudly: a harness step that cannot run git has nothing to
 * report. Hooks, fsmonitor, signing, the global and system config and prompts
 * are all off, and the environment is an allowlist (see `gitInvocation`).
 */
export const git = async (cwd: string, args: readonly string[], timeoutMs = 60_000): Promise<string> => {
  const { flags, env } = await gitInvocation();
  const result = await exec("git", [...flags, ...args], { cwd, timeoutMs, env });
  if (result.code !== 0) throw new Error(`git ${args[0] ?? ""} failed (exit ${String(result.code)}): ${result.stderr.trim().slice(0, 300)}`);
  return result.stdout;
};
