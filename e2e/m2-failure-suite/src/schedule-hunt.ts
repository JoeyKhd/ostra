// `pnpm e2e:schedule-hunt` (milestone 6's ticket 37, F-106, F-048): the failure suite's schedule
// hunt on its own, `--runs N` times in a row (1 by default), each run's log in
// `.ostra-dev/e2e-schedule-hunt/run-<n>.log`. With `--record`, the last run's log is copied to
// `context/specs/m6-whole-team/demo/schedule-hunt.log` when every run passed. It needs no live
// service and no secret: the hunt runs on an embedded Postgres, and its log holds IDs, counts and
// times only. Every process it starts ends with it.

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "@ostra/e2e-m1/settings";
import { say } from "@ostra/e2e-m1/setup";

import { runScheduleHuntOnce } from "./cases/schedule-hunt-case.ts";

const argAfter = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
};

const main = async (): Promise<void> => {
  const runs = Math.max(1, Number.parseInt(argAfter("--runs") ?? "1", 10) || 1);
  const record = process.argv.includes("--record");
  const dir = path.join(repoRoot, ".ostra-dev", "e2e-schedule-hunt");
  await mkdir(dir, { recursive: true });
  const results: boolean[] = [];
  let last = "";
  for (let run = 1; run <= runs; run += 1) {
    const started = Date.now();
    last = path.join(dir, `run-${String(run)}.log`);
    say(`schedule hunt: run ${String(run)} of ${String(runs)}, its log in ${path.relative(repoRoot, last)}`);
    const result = await runScheduleHuntOnce(last);
    results.push(result.passed);
    for (const line of result.lines.filter((one) => / (PASS|FAIL) | control: (FAILED|passed)| schedule hunt: /.test(one))) say(`  ${line.replace(/^\S+ /, "")}`);
    say(`schedule hunt: run ${String(run)} ${result.passed ? "PASSED" : "FAILED"} in ${String(Math.round((Date.now() - started) / 6000) / 10)} min`);
    if (!result.passed) break;
  }
  const allPassed = results.length === runs && results.every(Boolean);
  say(`schedule hunt: ${String(results.filter(Boolean).length)} of ${String(runs)} runs passed${allPassed ? ", in a row" : ""}`);
  if (allPassed && record) {
    const kept = path.join(repoRoot, "context", "specs", "m6-whole-team", "demo", "schedule-hunt.log");
    await mkdir(path.dirname(kept), { recursive: true });
    await copyFile(last, kept);
    say(`schedule hunt: the last run's log kept in ${path.relative(repoRoot, kept)}`);
  }
  if (!allPassed) process.exitCode = 1;
};

await main();
