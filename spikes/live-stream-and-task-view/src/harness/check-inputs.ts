import { access } from "node:fs/promises";
import { findCaptures } from "../producer/replay.ts";
import { findBrowser } from "./browser.ts";
import { loadHarnessSettings, capturesDir, recordingsDir } from "./settings.ts";

// Reports which inputs are present. It never prints a value.
type Row = { name: string; needed: string; present: boolean };

const env = (name: string): boolean => (process.env[name] ?? "").length > 0;
const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const settings = loadHarnessSettings();

const rows: Row[] = [
  { name: "OSTRA_SPIKE_DATABASE_URL", needed: "optional: a Postgres to use instead of embedded-postgres (the harness makes a schema of its own, and drops it)", present: settings.OSTRA_SPIKE_DATABASE_URL !== undefined },
  { name: "OSTRA_SPIKE_POSTMASTER_PID", needed: "optional: lets the load test read the CPU time of a Postgres started elsewhere", present: settings.OSTRA_SPIKE_POSTMASTER_PID > 0 },
  { name: "browser (Edge or Chrome)", needed: "the browser checks: UI, reload, network drops, render time, browser latency, network log", present: (await findBrowser(settings)) !== null },
  {
    name: "spike 1's captures (.runs/*/events.json)",
    needed: "the real-OpenCode-capture check (OSTRA_SPIKE_CAPTURES_DIR to point elsewhere)",
    present: (await findCaptures(capturesDir(settings))).length > 0,
  },
  {
    name: "recorded sessions (spike 1)",
    needed: "the recorded-session coverage check (*.jsonl or *.json in OSTRA_SPIKE_RECORDINGS_DIR or spikes/how-should-the-runner-drive-opencode/recordings)",
    present: await exists(recordingsDir(settings)),
  },
  { name: "OSTRA_DEV_MODEL_BASE_URL / _API_KEY / _ID", needed: "not used: the spike runs on synthetic and recorded events and calls no model", present: env("OSTRA_DEV_MODEL_BASE_URL") && env("OSTRA_DEV_MODEL_API_KEY") && env("OSTRA_DEV_MODEL_ID") },
  { name: "LINEAR_* / GITHUB_*", needed: "not used by this spike", present: Object.keys(process.env).some((k) => k.startsWith("LINEAR_") || k.startsWith("GITHUB_")) },
  { name: "a Linux host with 4 vCPU for Postgres", needed: "the load bar's own reference shape (`pnpm load --full` there)", present: process.platform === "linux" },
];

for (const row of rows) {
  process.stdout.write(`${row.present ? "present" : "missing"}  ${row.name}\n         ${row.needed}\n`);
}
