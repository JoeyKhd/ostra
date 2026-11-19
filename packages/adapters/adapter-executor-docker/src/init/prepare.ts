import { mkdir, writeFile } from "node:fs/promises";
import type { z } from "zod";
import { prepareJobSchema } from "../bridge/protocol.ts";
import type { PrepareJob } from "../bridge/protocol.ts";

// The box's prepare step: make the task's folders and write its files. The init runs it as a child
// (`prepare-main.ts`) as the agent's user, so the init's root powers never touch a path the agent
// controls (no symlink tricks). The job comes over the child's stdin as JSON and is checked with
// the same strict schema the bridge uses before the first write, so a malformed job writes nothing.

/** The prefix of the one stderr line that says why a prepare failed, which the init relays. */
export const PREPARE_FAILURE_PREFIX = "prepare failed: ";

/** Parse a job; throws a `PrepareJobError` that names the bad fields and never their values. */
export const parsePrepareJob = (text: string): PrepareJob => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PrepareJobError("the job is not JSON");
  }
  const parsed = prepareJobSchema.safeParse(json);
  if (!parsed.success) {
    throw new PrepareJobError(`the job is invalid at ${describeIssues(parsed.error.issues)}`);
  }
  return parsed.data;
};

const describeIssues = (issues: readonly z.core.$ZodIssue[]): string =>
  issues
    .slice(0, 3)
    .map((issue) => (issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".")))
    .join(", ");

export class PrepareJobError extends Error {
  override readonly name = "PrepareJobError";
}

/** Do the job: every folder first, then every file. Content is base64 of the file's bytes. */
export const applyPrepareJob = async (job: PrepareJob): Promise<void> => {
  for (const dir of job.dirs) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  for (const file of job.files) {
    await writeFile(file.path, Buffer.from(file.content, "base64"), { mode: file.mode, flag: "w" });
  }
};

/** Parse the job and apply it. The text is parsed whole before anything is written. */
export const runPrepareJob = async (text: string): Promise<void> => {
  await applyPrepareJob(parsePrepareJob(text));
};
