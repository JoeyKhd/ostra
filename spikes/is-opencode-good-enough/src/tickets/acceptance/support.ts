// Helpers for the hidden acceptance tests. They run inside a verify folder
// that mirrors this layout: the agent's result sits at `sample-repo/`, and
// these files at `src/tickets/acceptance/`, so one relative path works both
// here (against the pristine sample) and there (against a run's result).

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { z } from "zod";
import { CalcError, type CalcErrorCode } from "../../../sample-repo/src/errors.ts";

const execFileAsync = promisify(execFile);

export const SAMPLE_ROOT = fileURLToPath(new URL("../../../sample-repo/", import.meta.url));
export const CLI_PATH = fileURLToPath(new URL("../../../sample-repo/src/cli.ts", import.meta.url));

export type CliRun = { readonly code: number; readonly stdout: string; readonly stderr: string };

const failure = z.looseObject({ code: z.number(), stdout: z.string(), stderr: z.string() });

/** What the command line under test may see of this process's environment: what Node needs to start, and nothing else (no token, no key). */
const CLI_ENV_NAMES = process.platform === "win32" ? ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "USERPROFILE"] : ["PATH", "LANG", "LC_ALL", "HOME", "TMPDIR"];

const cliEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of CLI_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

/** Runs `node src/cli.ts <args>` as a process: the script's own behaviour, whatever its structure. */
export const runCliProcess = async (args: readonly string[]): Promise<CliRun> => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], { timeout: 30_000, windowsHide: true, env: cliEnv() });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const parsed = failure.safeParse(error);
    if (parsed.success) return { code: parsed.data.code, stdout: parsed.data.stdout, stderr: parsed.data.stderr };
    throw error;
  }
};

export const lines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line !== "");

/** Asserts that `work` throws a CalcError with this code, and, when given, a message that matches. */
export const assertCalcError = (work: () => unknown, code: CalcErrorCode, message?: RegExp): void => {
  assert.throws(work, (error: unknown) => {
    if (!(error instanceof CalcError)) return false;
    if (error.code !== code) return false;
    return message === undefined || message.test(error.message);
  });
};
