import { spawn } from "node:child_process";

// Child processes for the host executor: argument arrays only, never a shell line, and an
// environment built from an allowlist, never the runner's own (which may hold the member's tokens).

/** The variables a tool needs to run at all on this OS. Nothing else of the runner's passes. */
const BASE_ENV_NAMES = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "TERM",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
] as const;

export const baseEnv = (source: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of BASE_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) {
      out[name] = value;
    }
  }
  return out;
};

export type RunResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

export type RunOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Called with each chunk as it comes, besides collecting it. */
  readonly onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  /** The most output kept per stream, so a chatty tool can't fill memory. */
  readonly maxBuffer?: number;
};

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

/** Runs a program with an argument array and waits for it. Never throws for a non-zero exit. */
export const runProgram = (command: string, args: readonly string[], options: RunOptions): Promise<RunResult> =>
  new Promise((resolve) => {
    const max = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < max) {
        stdout += chunk;
      }
      options.onOutput?.("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < max) {
        stderr += chunk;
      }
      options.onOutput?.("stderr", chunk);
    });
    let settled = false;
    const finish = (code: number | null): void => {
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    };
    child.on("error", (error) => {
      stderr += `\n${error.name}: ${"code" in error && typeof error.code === "string" ? error.code : "spawn failed"}`;
      finish(null);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });

/** The lines of git's output that are ostra's own words (the git proxy's refusals), for messages. */
export const ostraLines = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter((line) => line.includes("ostra:"))
    .slice(0, 5)
    .map((line) => line.replace(/^remote:\s*/, "").trim())
    .join("; ");

/** What a task says when GitHub refuses a push that changes a workflow file (ADR 0040, Q122). */
export const WORKFLOWS_PERMISSION_REASON =
  "ostra: GitHub refused the push because it changes a file in .github/workflows/, and ostra's GitHub App doesn't have the workflows permission. Leave workflow files out of the change, or change them by hand";

const WORKFLOWS_REFUSAL = /refusing to allow a GitHub App to create or update workflow/i;
const REMOTE_REJECTED = /\[remote rejected\][^(\n]*\(([^)\n]{1,200})\)/;

/**
 * Why the code host itself refused a push, when the git proxy didn't: a workflow change in words
 * a member can act on, or git's own `[remote rejected]` reason, cut short. `null` when git's output
 * names none.
 */
export const codeHostRefusal = (text: string): string | null => {
  if (WORKFLOWS_REFUSAL.test(text)) {
    return WORKFLOWS_PERMISSION_REASON;
  }
  const reason = REMOTE_REJECTED.exec(text)?.[1];
  return reason === undefined ? null : `the code host refused the push (${reason.trim()})`;
};
