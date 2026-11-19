import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runnerLimits } from "@ostra/protocol";
import type { CheckId, CheckStatus, RepoId, TaskSpec, TaskSpecCheck } from "@ostra/protocol";

// Running an environment's checks after a turn (F-054, ADR 0052, Q188), the part every executor
// shares: which checks run, in what order, where, with what environment and time, and what's kept
// of their output. An executor brings only how one command runs in its box (`RunOneCheck`): a
// child process on `host`, an exec in the agent's container on `docker`.

/** One check's result, as `runChecks` answers it and `check.finished` carries it. */
export type CheckRunResult = {
  readonly checkId: CheckId;
  readonly name: string;
  readonly repoId: RepoId | null;
  readonly status: CheckStatus;
  /** `null` when it was killed (a timeout) or never started (an error). */
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** The output's end, at most 16 KiB, cut at a character. Never logged. */
  readonly outputTail: string;
  /** The full output's file, at most 4 MiB, for the upload; `null` when it couldn't be written. */
  readonly outputPath: string | null;
};

/** How one command runs in a box: an executor's own part. */
export type RunOneCheck = (input: {
  /** The environment's command line, as the admin wrote it: run as a command line, never built from task text. */
  readonly command: string;
  readonly cwd: string;
  /** The whole environment of the check's process: nothing inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Every piece of stdout and stderr, as it comes. */
  readonly onOutput: (text: string) => void;
  readonly signal?: AbortSignal;
}) => Promise<{ readonly exitCode: number | null; readonly timedOut: boolean; readonly error: string | null }>;

export type RunChecksInput = {
  /** The task's spec: its `checks`, in order, and its repos' folders. */
  readonly spec: TaskSpec;
  /** The box's workspace: the repos side by side. */
  readonly workspaceDir: string;
  /** The repos the turn changed: a check that names another repo doesn't run (Q188). */
  readonly changedRepoIds: readonly RepoId[];
  /** The environment's variables for the checks: the repos' variables and secrets, never a model key or a code host token. */
  readonly env: Readonly<Record<string, string>>;
  /** Where each check's full output is written, as `<checkId>.log`. */
  readonly outputDir: string;
  /** All of the turn's checks together; past it, the rest are `timed-out`. Default: 30 minutes. */
  readonly totalTimeoutMs?: number;
  readonly signal?: AbortSignal;
};

/** The checks a turn runs, in order (Q188): one with no repo always, one with a repo only when the turn changed it. */
export const checksToRun = (checks: readonly TaskSpecCheck[], changedRepoIds: readonly RepoId[]): readonly TaskSpecCheck[] => {
  const changed = new Set<string>(changedRepoIds);
  return checks.filter((check) => check.repoId === null || changed.has(check.repoId));
};

/** The variable names a check's environment never holds, whoever set them: credentials, and the runner's own. */
const NEVER_IN_A_CHECK = /^(OSTRA_|GITHUB_TOKEN$|GH_TOKEN$|GH_ENTERPRISE_TOKEN$|GITHUB_APP_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$|OPENROUTER_API_KEY$|DEEPSEEK_API_KEY$|GIT_ASKPASS$|SSH_AUTH_SOCK$)/;

/** The few variables a command needs to run at all, taken from the executor's own environment. */
const PASSTHROUGH = process.platform === "win32" ? ["PATH", "Path", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"] : ["PATH", "LANG", "TMPDIR"];

/**
 * A check's whole environment: what a command needs to run, then the environment's variables,
 * minus any credential or runner variable by name. Nothing else of the runner's environment.
 */
export const checkEnvironment = (env: Readonly<Record<string, string>>, home: string): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const value = process.env[name];
    if (value !== undefined) {
      out[name] = value;
    }
  }
  out["HOME"] = home;
  out["USERPROFILE"] = home;
  out["CI"] = "true";
  for (const [name, value] of Object.entries(env)) {
    if (!NEVER_IN_A_CHECK.test(name)) {
      out[name] = value;
    }
  }
  return out;
};

/** The end of a text, at most `maxBytes` of UTF-8, never starting inside a character. */
export const tailBytes = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  let start = bytes.length - maxBytes;
  // Skip continuation bytes, so the tail starts on a character.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
};

/** A check's folder: its repo's checkout, or the workspace root for a check with no repo. */
const cwdOf = (spec: TaskSpec, workspaceDir: string, check: TaskSpecCheck): string | null => {
  if (check.repoId === null) {
    return workspaceDir;
  }
  const repo = spec.repos.find((candidate) => candidate.repoId === check.repoId);
  return repo === undefined ? null : path.join(workspaceDir, repo.checkoutDir);
};

/**
 * Runs the turn's checks in order, each with its own timeout and the total's, and keeps each one's
 * output: the tail in the result, the whole (to 4 MiB) in its file. A failing check doesn't stop
 * the next: every check that applies runs (ADR 0052).
 */
export const runChecksWith = async (input: RunChecksInput, runOne: RunOneCheck): Promise<readonly CheckRunResult[]> => {
  const totalMs = input.totalTimeoutMs ?? runnerLimits.checksTotalMinutes * 60_000;
  const deadline = Date.now() + totalMs;
  await mkdir(input.outputDir, { recursive: true });
  const env = checkEnvironment(input.env, path.join(input.outputDir, "home"));
  await mkdir(path.join(input.outputDir, "home"), { recursive: true });
  const results: CheckRunResult[] = [];
  for (const check of checksToRun(input.spec.checks ?? [], input.changedRepoIds)) {
    const base = { checkId: check.checkId, name: check.name, repoId: check.repoId };
    const remaining = deadline - Date.now();
    const cwd = cwdOf(input.spec, input.workspaceDir, check);
    if (remaining <= 0 || input.signal?.aborted === true) {
      results.push({ ...base, status: "timed-out", exitCode: null, durationMs: 0, outputTail: "The checks' total time ran out before this one.", outputPath: null });
      continue;
    }
    if (cwd === null) {
      results.push({ ...base, status: "error", exitCode: null, durationMs: 0, outputTail: "The check names a repo the task doesn't have.", outputPath: null });
      continue;
    }
    const outputPath = path.join(input.outputDir, `${String(check.checkId).replaceAll(/[^A-Za-z0-9._-]/g, "_")}.log`);
    const kept: Buffer[] = [];
    // Set from the output callback, so kept in an object the type checker doesn't narrow.
    const output = { written: 0, cut: false, tail: "" };
    const started = Date.now();
    const ran = await runOne({
      command: check.command,
      cwd,
      env,
      timeoutMs: Math.min(check.timeoutSeconds * 1000, remaining),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onOutput: (text) => {
        output.tail = tailBytes(output.tail + text, runnerLimits.checkOutputTailMaxBytes);
        const bytes = Buffer.from(text, "utf8");
        const room = runnerLimits.checkOutputBlobMaxBytes - output.written;
        if (room > 0) {
          const part = bytes.subarray(0, room);
          output.written += part.length;
          kept.push(part);
        }
        if (bytes.length > room) {
          output.cut = true;
        }
      },
    });
    let savedPath: string | null = outputPath;
    try {
      await writeFile(outputPath, Buffer.concat([...kept, ...(output.cut ? [Buffer.from("\n[the output was cut at 4 MiB]\n")] : [])]));
    } catch {
      savedPath = null;
    }
    const status: CheckStatus = ran.error !== null ? "error" : ran.timedOut ? "timed-out" : ran.exitCode === 0 ? "passed" : "failed";
    results.push({
      ...base,
      status,
      exitCode: ran.timedOut ? null : ran.exitCode,
      durationMs: Date.now() - started,
      outputTail: ran.error !== null && output.tail === "" ? ran.error : output.tail,
      outputPath: savedPath,
    });
  }
  return results;
};
