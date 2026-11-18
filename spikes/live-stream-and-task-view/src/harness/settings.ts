import path from "node:path";
import { z } from "zod";
import { spikeRoot } from "./infra.ts";

// The harness's own settings, validated once, from the environment. Every one is optional.
const optionalString = z.string().min(1).optional();

const schema = z.strictObject({
  // A Postgres to use instead of embedded-postgres (the harness makes a schema of its own and drops it).
  // Deliberately not DATABASE_URL: that variable is common, and the harness creates and drops a schema in it.
  OSTRA_SPIKE_DATABASE_URL: optionalString,
  // The postmaster's pid, so the load test can read the CPU time of a Postgres started elsewhere.
  OSTRA_SPIKE_POSTMASTER_PID: z.coerce.number().int().nonnegative().default(0),
  OSTRA_SPIKE_BROWSER: optionalString,
  OSTRA_SPIKE_RECORDINGS_DIR: optionalString,
  OSTRA_SPIKE_CAPTURES_DIR: optionalString,
});
export type HarnessSettings = z.infer<typeof schema>;

const KEYS = [
  "OSTRA_SPIKE_DATABASE_URL",
  "OSTRA_SPIKE_POSTMASTER_PID",
  "OSTRA_SPIKE_BROWSER",
  "OSTRA_SPIKE_RECORDINGS_DIR",
  "OSTRA_SPIKE_CAPTURES_DIR",
] as const;

export const loadHarnessSettings = (env: NodeJS.ProcessEnv = process.env): HarnessSettings => {
  const picked: Record<string, string | undefined> = {};
  for (const key of KEYS) {
    const value = env[key];
    picked[key] = value === undefined || value.length === 0 ? undefined : value;
  }
  return schema.parse(picked);
};

// Where spike 1 (how-should-the-runner-drive-opencode) keeps what this spike replays.
const spike1 = path.resolve(spikeRoot, "..", "how-should-the-runner-drive-opencode");

// Recordings: `*.jsonl` (or `*.json`) files in this directory.
export const recordingsDir = (settings: HarnessSettings): string => settings.OSTRA_SPIKE_RECORDINGS_DIR ?? path.join(spike1, "recordings");

// Captures: spike 1's `.runs/<run>/events.json`, one real OpenCode session each, before recordings exist.
export const capturesDir = (settings: HarnessSettings): string => settings.OSTRA_SPIKE_CAPTURES_DIR ?? path.join(spike1, ".runs");
