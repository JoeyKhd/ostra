// Runs an outside tool (docker, kubectl, tar, bash) for the harness. Always
// an argv array, never a shell, so no value is ever parsed as shell syntax.
// Secrets go on stdin (`input`) or in the child's env, never in argv, where
// the process list would show them. A timeout kills the whole tree.

import { spawn } from "node:child_process";
import path from "node:path";
import { killTree } from "../lib/process-tree.ts";

export type CommandResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

export type CommandOptions = {
  /** Written to the child's stdin, then stdin is closed. */
  readonly input?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Cap on captured output, per stream. */
  readonly maxBytes?: number;
};

export const runCommand = async (command: string, args: readonly string[], options: CommandOptions = {}): Promise<CommandResult> =>
  new Promise<CommandResult>((resolve) => {
    const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    const child = spawn(command, [...args], {
      env: options.env ?? process.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString("utf8");
    });
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (child.pid !== undefined) void killTree(child.pid);
      }, options.timeoutMs);
    }
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {
      // The child exited before reading stdin: its exit code says why.
    });
    child.stdin.end(options.input ?? "");
  });

/**
 * The tar to run. On Windows, the system's bsdtar: a GNU tar earlier on PATH
 * (Git Bash's) reads `C:\...` as a remote host.
 */
export const tarCommand = (): string => (process.platform === "win32" ? path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar");

/** True when the command runs and exits 0. */
export const succeeds = async (command: string, args: readonly string[], timeoutMs = 15_000): Promise<boolean> => (await runCommand(command, args, { timeoutMs })).code === 0;

/** Docker is reachable (any host: Linux, Docker Desktop, DOCKER_HOST). */
export const dockerAvailable = async (): Promise<boolean> => succeeds("docker", ["info", "--format", "{{.ServerVersion}}"]);

/** Every named image is present locally. */
export const dockerImagesPresent = async (images: readonly string[]): Promise<boolean> => succeeds("docker", ["image", "inspect", "--format", "{{.Id}}", ...images]);

/** The Docker daemon has the gVisor runtime registered (deploy/gvisor/daemon.json). */
export const dockerHasRuntime = async (name: string): Promise<boolean> => {
  const result = await runCommand("docker", ["info", "--format", "{{json .Runtimes}}"], { timeoutMs: 15_000 });
  return result.code === 0 && result.stdout.includes(`"${name}"`);
};

/** A cluster answers (kubectl, with the current context). */
export const clusterAvailable = async (): Promise<boolean> => succeeds("kubectl", ["get", "--raw", "/readyz", "--request-timeout=5s"]);

export const buildctlAvailable = async (): Promise<boolean> => succeeds("buildctl", ["--version"]);
