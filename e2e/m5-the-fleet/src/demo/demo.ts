// `pnpm e2e:m5` (ticket 37): milestone 5's demo, spec section 3, on this machine. It starts a stack
// of its own from an empty data folder (the dev database, three core replicas and the panel, on the
// demo's ports), the failure suite's stub model, and ticket 36's dev tools (the fake cluster in
// process mode, the registry, the npm registry and the proxies); packs the CLI and installs it from
// its tarball; sets the stack up with milestones 1 to 4's helpers; and runs every step it can here,
// driving Demo's and Sam's browsers with Playwright, then the checks after the run. Screenshots go to
// the spec's `demo/` folder, the result to `.ostra-dev/e2e-m5/result.json` (and `demo/checks.json`).
// `--steps 1,2,3` runs only those steps after the setup; `--keep` leaves the run's tickets, PRs and
// branches for a look.
//
// Secrets come from the environment (github.env, github-test.env, linear.env) and are typed into
// forms or kept in the stack's secret store only: never printed.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { say } from "@ostra/e2e-m1/setup";
import { killAll } from "@ostra/e2e-m2-failures/procs";

import type { Demo } from "./context.ts";
import { afterRun, cleanUp } from "./checks-after.ts";
import { openDemo } from "./setup.ts";
import { m5Settings } from "./settings.ts";
import { step1, step2, step3, step4, step5 } from "./steps-pools.ts";
import { step6, step7, step8 } from "./steps-tasks.ts";
import { step9, step10, step11 } from "./steps-runners.ts";
import { step12, step13, step14, step15 } from "./steps-cluster.ts";

const steps: readonly { readonly number: number; readonly name: string; readonly run: (d: Demo) => Promise<void> }[] = [
  { number: 1, name: "a pool that requires approval", run: step1 },
  { number: 2, name: "a runner joins and waits", run: step2 },
  { number: 3, name: "rotation", run: step3 },
  { number: 4, name: "the fleet view", run: step4 },
  { number: 5, name: "box sizes", run: step5 },
  { number: 6, name: "capacity and the queue", run: step6 },
  { number: 7, name: "choosing a runner", run: step7 },
  { number: 8, name: "personal and pool runners side by side", run: step8 },
  { number: 9, name: "drain, resume, revoke", run: step9 },
  { number: 10, name: "runner versions", run: step10 },
  { number: 11, name: "the HTTP fallback", run: step11 },
  { number: 12, name: "the kubernetes executor, on the fake cluster", run: step12 },
  { number: 13, name: "the registry", run: step13 },
  { number: 14, name: "the images, the charts and the egress baseline, here", run: step14 },
  { number: 15, name: "the load test, here", run: step15 },
];

const main = async (): Promise<void> => {
  const started = Date.now();
  const settings = m5Settings(process.env, process.argv);
  const opened = await openDemo(settings);
  const d = opened.demo;
  const failed: string[] = [];
  try {
    for (const step of steps) {
      if (settings.steps.length > 0 && !settings.steps.includes(step.number)) continue;
      say(`---- step ${String(step.number)}: ${step.name}`);
      const at = Date.now();
      try {
        await step.run(d);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        d.check(step.number, `step ${String(step.number)} ran to its end`, false, message.split("\n")[0] ?? message);
        failed.push(String(step.number));
        // Where it stopped, for whoever reads the log: kept in the state folder, outside the repo.
        await d.demo.screenshot({ path: path.join(settings.stateDir, `fail-${String(step.number)}-demo.png`) }).catch(() => undefined);
        await d.sam.screenshot({ path: path.join(settings.stateDir, `fail-${String(step.number)}-sam.png`) }).catch(() => undefined);
      }
      d.timings[`step${String(step.number)}`] = Math.round((Date.now() - at) / 1000);
    }
    if (settings.steps.length === 0) await afterRun(d);
  } finally {
    const minutes = Math.round((Date.now() - started) / 6000) / 10;
    const ok = d.checks.length > 0 && d.checks.every((check) => check.ok);
    const result = { ok, minutes, steps: settings.steps.length === 0 ? "all" : settings.steps, timings: d.timings, checks: d.checks, notes: d.notes };
    await writeFile(path.join(settings.stateDir, "result.json"), JSON.stringify(result, null, 2)).catch(() => undefined);
    if (settings.steps.length === 0) await writeFile(path.join(settings.screenshotDir, "checks.json"), `${JSON.stringify(result, null, 2)}\n`).catch(() => undefined);
    say(`demo: ${String(d.checks.filter((check) => check.ok).length)} of ${String(d.checks.length)} checks passed in ${String(minutes)} min${failed.length === 0 ? "" : `; steps that stopped: ${failed.join(", ")}`}`);
    for (const check of d.checks.filter((one) => !one.ok)) say(`  FAIL ${String(check.step)}. ${check.name}: ${check.detail}`);
    if (!ok) process.exitCode = 1;
    if (!settings.keep) await cleanUp(d).catch((error: unknown) => {
      say(`clean-up: ${error instanceof Error ? error.message : String(error)}`);
    });
    await opened.close();
    await killAll();
  }
};

await main();
