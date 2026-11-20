// `pnpm e2e:m4` (ticket 41): milestone 4's demo (spec section 3) on this machine, against a running
// dev stack (`pnpm dev` with OSTRA_ALLOW_DEFAULT_PASSWORD=true and OSTRA_INSIGHTS_INTERVAL_MINUTES=1),
// ticket 40's mail sink (`pnpm dev:mail-sink`), the test org and the test Linear workspace, on the
// `host` executor. The two personal runners (`src/runner-process.ts`, Demo's, and Sam's with
// `--second`) run in processes of their own, so each step can run by itself: `node src/demo.ts
// <step> …`, or every step in order with no argument. A step that happened is skipped; a step that
// fails is recorded with a screenshot, and the run goes on to the next. It drives three people's
// browsers (Demo, Sam, Rae) with Playwright and keeps screenshots under the spec's `demo/` folder.
//
// Secrets come from the environment (model.env, github.env, github-test.env, linear.env, the
// tunnel's address): typed into forms or sent to the stack only, never printed.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { say } from "@ostra/e2e-m1/setup";

import { nothingLeaked, sweepFor } from "./checks.ts";
import { openDemo } from "./context.ts";
import type { Demo } from "./context.ts";
import { removalAndResets, third } from "./steps-accounts.ts";
import { audit, search } from "./steps-audit.ts";
import { noKey, twoKeys } from "./steps-keys.ts";
import { notes, proposal, reachesNextTask } from "./steps-memory.ts";
import { budget, insights } from "./steps-money.ts";
import { invitation, roles } from "./steps-people.ts";
import { acrossRepos, mergeBoth, reopenCheck, reviewCheck, secondRepo } from "./steps-repos.ts";
import { setup } from "./steps-setup.ts";

type Step = { readonly name: string; readonly run: (d: Demo) => Promise<void>; readonly once: boolean };

const steps: readonly Step[] = [
  { name: "setup", run: setup, once: false },
  { name: "invitation", run: invitation, once: true },
  { name: "roles", run: roles, once: true },
  { name: "second-repo", run: secondRepo, once: true },
  { name: "across-repos", run: acrossRepos, once: true },
  { name: "review-check", run: reviewCheck, once: true },
  { name: "merge", run: mergeBoth, once: true },
  { name: "notes", run: notes, once: true },
  { name: "proposal", run: proposal, once: true },
  { name: "reopen-check", run: reopenCheck, once: true },
  { name: "next-task", run: reachesNextTask, once: true },
  { name: "budget", run: budget, once: true },
  { name: "audit", run: audit, once: true },
  { name: "search", run: search, once: true },
  {
    name: "third",
    run: async (d) => {
      await third(d);
      await sweepFor(d, await d.page("rae"), "Rae");
    },
    once: true,
  },
  { name: "insights", run: insights, once: true },
  { name: "removal", run: removalAndResets, once: true },
  { name: "two-keys", run: twoKeys, once: true },
  { name: "no-key", run: noKey, once: true },
  {
    name: "after",
    run: async (d) => {
      await sweepFor(d, await d.page("sam"), "Sam");
      await nothingLeaked(d);
    },
    once: false,
  },
];

const main = async (): Promise<void> => {
  const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const unknown = wanted.filter((name) => !steps.some((step) => step.name === name));
  if (unknown.length > 0) throw new Error(`no such step: ${unknown.join(", ")}. Steps: ${steps.map((step) => step.name).join(", ")}`);
  const stopOnFailure = process.argv.includes("--stop");
  const d = await openDemo();
  await mkdir(d.settings.screenshotDir, { recursive: true });
  try {
    for (const step of steps) {
      if (wanted.length > 0 && !wanted.includes(step.name)) continue;
      if (step.once && d.run.done.includes(step.name) && wanted.length === 0) {
        say(`${step.name}: done in an earlier run`);
        continue;
      }
      say(`---- ${step.name}`);
      d.step = step.name;
      const started = Date.now();
      try {
        await step.run(d);
      } catch (error) {
        // Where it stopped, for whoever reads the log: kept in the state folder, outside the repo.
        await d.demo.screenshot({ path: path.join(d.settings.m4StateDir, `fail-${step.name}-demo.png`) }).catch(() => undefined);
        d.check(`${step.name}: the step ran to its end`, false, error instanceof Error ? error.message.split("\n")[0]?.slice(0, 240) ?? "error" : "error");
        await d.save();
        if (stopOnFailure || step.name === "setup") throw error;
        continue;
      }
      d.check(`${step.name}: the step ran to its end`, true, `${String(Math.round((Date.now() - started) / 1000))} s`);
      d.run.timings[step.name] = Math.round((Date.now() - started) / 1000);
      if (!d.run.done.includes(step.name)) d.run.done.push(step.name);
      await d.save();
    }
  } finally {
    await writeFile(path.join(d.settings.m4StateDir, `checks-${String(Date.now())}.json`), JSON.stringify(d.checks, null, 2)).catch(() => undefined);
    await d.close();
  }
  const failed = d.checks.filter((check) => !check.ok);
  say(`${String(d.checks.length - failed.length)} of ${String(d.checks.length)} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
};

await main();
