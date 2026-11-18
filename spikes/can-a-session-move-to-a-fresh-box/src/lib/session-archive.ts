// The agent's own session archive (ADR 0039, step 3 after every turn): for
// OpenCode, `opencode session export` and `opencode session import`.
//
// Both run with the task's own environment (its HOME and XDG dirs, the fake
// key only) and `--standalone`, so they use a private server for the one
// command and never start OpenCode's background service (spike 1, finding 5).
// The archive holds the session's content: it's never logged, only counted.
//
// A target is the host (the pinned binary, run directly) or a container (the
// image's `opencode`, through `docker exec`, with the agent's variables passed
// by name so no value is ever an argument). Every child's PID goes to
// `onSpawn`, so a sweep can find a CLI call that outlived its run.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { sessionId as toSessionId, type SessionId } from "./ids.ts";
import type { OpenCodeBinary } from "./opencode.ts";

const execFileAsync = promisify(execFile);

/** OpenCode's export format, as far as the spike reads it. A vendor format: unknown fields are kept. */
const archiveSchema = z.looseObject({
  info: z.looseObject({
    id: z.string().min(1),
    projectID: z.string().optional(),
    location: z.looseObject({ directory: z.string() }).optional(),
  }),
  messages: z.array(z.looseObject({ id: z.string(), type: z.string() })),
});

export type ArchiveSummary = {
  readonly sessionId: SessionId;
  readonly projectId: string | undefined;
  readonly bytes: number;
  readonly messages: number;
  /** Message count per `type` (user, assistant, idle, …). */
  readonly types: Readonly<Record<string, number>>;
};

export const summarizeArchive = (text: string): ArchiveSummary => {
  const parsed = archiveSchema.parse(JSON.parse(text));
  const types: Record<string, number> = {};
  for (const message of parsed.messages) types[message.type] = (types[message.type] ?? 0) + 1;
  return {
    sessionId: toSessionId(parsed.info.id),
    projectId: parsed.info.projectID,
    bytes: Buffer.byteLength(text, "utf8"),
    messages: parsed.messages.length,
    types,
  };
};

type PidHooks = {
  /** Called with each CLI child's PID right after the spawn. */
  readonly onSpawn?: (pid: number) => void;
  /** Called with that PID once the child is gone. */
  readonly onExit?: (pid: number) => void;
};

export type CliTarget =
  | (PidHooks & {
      readonly kind: "host";
      readonly binary: OpenCodeBinary;
      readonly cwd: string;
      /** The task's own environment (buildAgentEnv). */
      readonly env: Readonly<Record<string, string>>;
    })
  | (PidHooks & {
      readonly kind: "container";
      readonly container: string;
      /** The working directory inside the container. */
      readonly workdir: string;
      /** The agent's variables, passed into the container by name (`-e NAME`). */
      readonly env: Readonly<Record<string, string>>;
      /** What the docker CLI itself needs on the host. */
      readonly dockerEnv: Readonly<Record<string, string>>;
      readonly hostCwd: string;
    });

const TIMEOUT_MS = 120_000;

/** The command line for one OpenCode CLI call on the target. */
export const cliCommand = (target: CliTarget, args: readonly string[]): { file: string; args: string[]; cwd: string; env: Record<string, string> } => {
  switch (target.kind) {
    case "host":
      return { file: target.binary.path, args: [...args], cwd: target.cwd, env: { ...target.env } };
    case "container":
      return {
        file: "docker",
        args: ["exec", "-w", target.workdir, ...Object.keys(target.env).flatMap((name) => ["-e", name]), target.container, "opencode", ...args],
        cwd: target.hostCwd,
        env: { ...target.dockerEnv, ...target.env },
      };
    default:
      return target satisfies never;
  }
};

const run = async (target: CliTarget, args: readonly string[], maxBuffer: number): Promise<{ stdout: string; stderr: string }> => {
  const command = cliCommand(target, args);
  const child = execFileAsync(command.file, command.args, { cwd: command.cwd, env: command.env, maxBuffer, timeout: TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true });
  const pid = child.child.pid;
  if (pid !== undefined) target.onSpawn?.(pid);
  try {
    return await child;
  } finally {
    if (pid !== undefined) target.onExit?.(pid);
  }
};

export type ExportResult = { readonly text: string; readonly ms: number; readonly summary: ArchiveSummary };

export const exportSession = async (target: CliTarget, sessionId: SessionId): Promise<ExportResult> => {
  const started = Date.now();
  const { stdout } = await run(target, ["session", "export", sessionId, "--standalone"], 1024 * 1024 * 1024);
  const ms = Date.now() - started;
  const summary = summarizeArchive(stdout);
  if (summary.sessionId !== sessionId) throw new Error("the export holds another session");
  return { text: stdout, ms, summary };
};

export type ImportResult = { readonly sessionId: SessionId; readonly ms: number };

const IMPORTED = /Imported session:\s*(\S+)/;

/**
 * Imports an archive file into the task's OpenCode data dir, bound to
 * `directory` (default: the cwd). Both paths are as the target sees them.
 */
export const importSession = async (target: CliTarget, file: string, directory?: string): Promise<ImportResult> => {
  const started = Date.now();
  const args = ["session", "import", file, "--standalone", ...(directory === undefined ? [] : ["--directory", directory])];
  const { stdout } = await run(target, args, 16 * 1024 * 1024);
  const match = IMPORTED.exec(stdout);
  if (match?.[1] === undefined) throw new Error("session import printed no session ID");
  return { sessionId: toSessionId(match[1]), ms: Date.now() - started };
};

const listedSession = z.array(z.looseObject({ id: z.string(), directory: z.string().optional() }));

/** `opencode session list` in the task's data dir: IDs and directories only. */
export const listSessions = async (target: CliTarget): Promise<z.infer<typeof listedSession>> => {
  const { stdout } = await run(target, ["session", "list", "--format", "json", "--standalone"], 64 * 1024 * 1024);
  const text = stdout.trim();
  return text === "" ? [] : listedSession.parse(JSON.parse(text));
};
