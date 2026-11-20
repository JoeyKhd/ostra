import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

// The demo's own state (ticket 41), so a later run picks up where the last one stopped: each step
// that happened is skipped. IDs, numbers and timings in `run.json`; the people's passwords, which
// the demo chose, in `people.json` (mode 600, never printed).

export const runStateSchema = z.object({
  /** Project, task, PR and ticket IDs by the demo's own names (`project:test1`, `task:step4`, …). */
  ids: z.record(z.string(), z.string()).default({}),
  done: z.array(z.string()).default([]),
  timings: z.record(z.string(), z.number()).default({}),
  notes: z.record(z.string(), z.string()).default({}),
});

export type RunState = z.infer<typeof runStateSchema>;

export const loadRunState = async (file: string): Promise<RunState> => {
  try {
    return runStateSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return runStateSchema.parse({});
  }
};

export const saveRunState = async (file: string, state: RunState): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2));
};

const peopleSchema = z.object({ admin: z.string(), sam: z.string(), rae: z.string(), samReset: z.string(), samFinal: z.string() });
export type Passwords = z.infer<typeof peopleSchema>;

const pick = (): string => randomBytes(18).toString("base64url");

/** The passwords the demo chose for each person, made once per data folder. */
export const loadPasswords = async (stateDir: string): Promise<Passwords> => {
  const file = path.join(stateDir, "people.json");
  try {
    return peopleSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    const made = { admin: pick(), sam: pick(), rae: pick(), samReset: pick(), samFinal: pick() };
    await mkdir(stateDir, { recursive: true });
    await writeFile(file, JSON.stringify(made), { mode: 0o600 });
    return made;
  }
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `read` until it answers non-null, or throws `what` after `timeoutMs`. */
export const waitFor = async <T,>(what: string, timeoutMs: number, read: () => Promise<T | null>, everyMs = 1000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
};
