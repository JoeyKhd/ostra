// `pnpm e2e:m3` (ticket 50): milestone 3's demo (spec section 3) on this machine, against a running
// dev stack (`pnpm dev`), the test org and the test Linear workspace, on the `host` executor. The
// fixtures (`src/fixtures.ts`: the mail server and the `release-names` MCP server) and the runner
// (`src/runner-process.ts`) run in processes of their own, so each step can run by itself:
// `node src/demo.ts <step> …`, or every step in order with no argument. A step that happened is
// skipped. It drives both members' browsers with Playwright and keeps screenshots under the spec's
// `demo/` folder.
//
// Secrets come from the environment (model.env, github.env, github-test.env, linear.env, the
// tunnel's address) and from the fixtures' file: typed into forms or stored in the secret store
// only, never printed.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { say } from "@ostra/e2e-m1/setup";

import { openDemo } from "./context.ts";
import type { Demo } from "./context.ts";
import { email, environment, profile } from "./steps-config.ts";
import { setup, smoke } from "./steps-setup.ts";
import { cancel, home, mail, merge, secrets, services, usage } from "./steps-after.ts";
import { checks, diff, local, updateBranch } from "./steps-review.ts";
import { approval, plan, steer, ticket } from "./steps-task.ts";

type Step = { readonly name: string; readonly run: (d: Demo) => Promise<void>; readonly once: boolean };

const steps: readonly Step[] = [
  { name: "setup", run: setup, once: false },
  { name: "smoke", run: smoke, once: false },
  { name: "profile", run: profile, once: true },
  { name: "environment", run: environment, once: true },
  { name: "email", run: email, once: true },
  { name: "ticket", run: ticket, once: true },
  { name: "plan", run: plan, once: true },
  { name: "approval", run: approval, once: true },
  { name: "steer", run: steer, once: true },
  { name: "checks", run: checks, once: true },
  { name: "diff", run: diff, once: true },
  { name: "update-branch", run: updateBranch, once: true },
  { name: "local", run: local, once: true },
  { name: "merge", run: merge, once: true },
  { name: "cancel", run: cancel, once: true },
  { name: "usage", run: usage, once: true },
  { name: "home", run: home, once: true },
  { name: "mail", run: mail, once: true },
  { name: "services", run: services, once: true },
  { name: "secrets", run: secrets, once: false },
];

const main = async (): Promise<void> => {
  const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const unknown = wanted.filter((name) => !steps.some((step) => step.name === name));
  if (unknown.length > 0) throw new Error(`no such step: ${unknown.join(", ")}. Steps: ${steps.map((step) => step.name).join(", ")}`);
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
      const started = Date.now();
      try {
        await step.run(d);
      } catch (error) {
        // Where it stopped, for whoever reads the log: kept in the state folder, outside the repo.
        await d.demo.screenshot({ path: path.join(d.settings.m3StateDir, `fail-${step.name}-demo.png`) }).catch(() => undefined);
        await d.sam.screenshot({ path: path.join(d.settings.m3StateDir, `fail-${step.name}-sam.png`) }).catch(() => undefined);
        throw error;
      }
      d.run.timings[step.name] = Math.round((Date.now() - started) / 1000);
      if (!d.run.done.includes(step.name)) d.run.done.push(step.name);
      await d.save();
    }
  } finally {
    await writeFile(path.join(d.settings.m3StateDir, `checks-${String(Date.now())}.json`), JSON.stringify(d.checks, null, 2)).catch(() => undefined);
    await d.close();
  }
  if (d.checks.some((check) => !check.ok)) process.exitCode = 1;
};

await main();
