import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "@ostra/e2e-m1/settings";

import { runCase } from "./case.ts";
import type { CaseResult } from "./case.ts";

// The schedule hunt (milestone 6's ticket 37, F-106, F-048): spike 8's C4 hunt against ostra's
// scheduler tick, with its control on pg-boss's own cron. It needs no live service, so it runs as
// core's own test file, `apps/core/src/schedule-hunt.test.ts` with OSTRA_SCHEDULE_HUNT=1: three core
// processes on an embedded Postgres, killed at the work by the replica holding it, then 7 hours down.
// Its log (IDs, counts and times only) is the run's record. About 25 minutes, most of it the
// control waiting for pg-boss to free a stranded batch (its 15-minute expiry).

export const SCHEDULE_HUNT_ROW = "Kill every replica but one at the scheduler's work, 200 automations: each occurrence starts once; pg-boss's own cron, hunted the same way, doesn't";

export type HuntRun = { readonly code: number | null; readonly lines: readonly string[]; readonly passed: boolean };

/** Runs the hunt once, its log in `logFile` (replaced). `env` goes on top of this process's environment. */
export const runScheduleHuntOnce = async (logFile: string, env: Readonly<Record<string, string>> = {}): Promise<HuntRun> => {
  await mkdir(path.dirname(logFile), { recursive: true });
  await rm(logFile, { force: true });
  const coreDir = path.join(repoRoot, "apps", "core");
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [path.join(coreDir, "node_modules", "vitest", "vitest.mjs"), "run", "src/schedule-hunt.test.ts"], {
      cwd: coreDir,
      env: { ...process.env, ...env, OSTRA_SCHEDULE_HUNT: "1", OSTRA_SCHEDULE_HUNT_LOG: logFile },
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("exit", resolve);
    child.once("error", () => {
      resolve(null);
    });
  });
  const lines = (await readFile(logFile, "utf8").catch(() => "")).split("\n").filter((line) => line.trim() !== "");
  const passed = code === 0 && lines.some((line) => line.endsWith(" schedule hunt: PASS"));
  return { code, lines, passed };
};

/** The hunt as a case of the failure suite: each of its checks, and the control's verdict. */
export const scheduleHuntCase = (logDir: string): Promise<CaseResult> =>
  runCase("schedule-hunt", SCHEDULE_HUNT_ROW, async (c) => {
    const run = await runScheduleHuntOnce(path.join(logDir, "schedule-hunt.log"));
    for (const line of run.lines) {
      const check = / hunt: (PASS|FAIL) ([^:]+): (.*)$/.exec(line);
      if (check !== null) c.check(check[2] ?? "a check", check[1] === "PASS", check[3] ?? "");
    }
    const control = run.lines.find((line) => line.includes(" control: FAILED, as spike 8 found") || line.includes(" control: passed, which the control must not"));
    c.check("the control on pg-boss's own cron failed as spike 8 found", control?.includes("FAILED, as spike 8 found") === true, control?.replace(/^.* control: /, "") ?? "no control verdict in the log");
    c.check("the hunt passed", run.passed, `vitest exited ${String(run.code)}`);
  });
