import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeGitHub } from "@ostra/adapter-github/testing";
import type { FakeGitHub } from "@ostra/adapter-github/testing";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { runCronControl } from "@ostra/jobs/testing";
import type { CronControlResult } from "@ostra/jobs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedRestartWorld } from "./testing/restart-world.ts";
import { runScheduleHunt } from "./testing/schedule-hunt.ts";
import type { HuntResult } from "./testing/schedule-hunt.ts";

// Ticket 37 (F-106, F-048): the schedule hunt, run by `pnpm e2e:schedule-hunt`, the failure suite
// and the Proof workflow's `failure-cases` job at the launch gate (OSTRA_SCHEDULE_HUNT=1), and
// skipped otherwise, so CI stays quick. Two things run side by
// side, each on a database of its own:
//
// - **The hunt** (`testing/schedule-hunt.ts`): 200 automations on ostra's scheduler tick, three core
//   processes, every replica but one killed from inside the tick's or the occurrence's transaction
//   by the replica holding the work; each (automation, occurrence) pair must start exactly once,
//   and after 7 hours down each automation fires once for the latest occurrence.
// - **The control** (`@ostra/jobs/testing`'s `runCronControl`): the same 200 schedules on pg-boss's
//   own cron with its defaults, hunted as spike 8 hunted it. It must fail as spike 8 found: starts
//   late or twice.
//
// The run's log (IDs, counts and times only) goes to OSTRA_SCHEDULE_HUNT_LOG.

const enabled = process.env["OSTRA_SCHEDULE_HUNT"] === "1";
const MINUTE = 60_000;
const number = (name: string, fallback: number): number => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};
const settings = {
  schedules: number("OSTRA_SCHEDULE_HUNT_SCHEDULES", 200),
  strikesPerPoint: number("OSTRA_SCHEDULE_HUNT_STRIKES", 2),
  maxTicks: number("OSTRA_SCHEDULE_HUNT_MAX_TICKS", 12),
  control: process.env["OSTRA_SCHEDULE_HUNT_CONTROL"] !== "0",
  controlTicks: number("OSTRA_SCHEDULE_HUNT_CONTROL_TICKS", 3),
  strandWaitMinutes: number("OSTRA_SCHEDULE_HUNT_STRAND_WAIT_MINUTES", 17),
};
const logFile = process.env["OSTRA_SCHEDULE_HUNT_LOG"] ?? "";

let test: TestDatabase;
let controlDb: TestDatabase | null = null;
let fixture: IsolationFixture;
let github: FakeGitHub;
let linear: FakeLinear;
let env: NodeJS.ProcessEnv;
let dataDir = "";
let logDir = "";
let jobs: Jobs | null = null;

const note = (line: string): void => {
  const stamped = `${new Date().toISOString()} ${line}`;
  process.stdout.write(`${stamped}\n`);
  if (logFile !== "") {
    void appendFile(logFile, `${stamped}\n`).catch(() => undefined);
  }
};

beforeAll(async () => {
  if (!enabled) {
    return;
  }
  if (logFile !== "") {
    await mkdir(path.dirname(logFile), { recursive: true });
  }
  logDir = await mkdtemp(path.join(tmpdir(), "ostra-hunt-"));
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  github = await createFakeGitHub({ repos: [{ id: 101, owner: "fake-org", name: "test1", defaultBranch: "main", files: {}, branches: ["main"] }] });
  linear = await createFakeLinear();
  ({ env, dataDir } = await seedRestartWorld({ test, fixture, github, linear, linearWebhookSecret: "schedule-hunt-linear-webhook-secret" }));
  jobs = createJobs({ databaseUrl: test.url, role: "enqueue-only" });
  if (settings.control) {
    controlDb = await createTestDatabase();
  }
}, 180_000);

afterAll(async () => {
  if (!enabled) {
    return;
  }
  await jobs?.stop({ graceful: false, timeoutMs: 2_000 });
  await github.close();
  await linear.close();
  await test.dispose();
  await controlDb?.dispose();
  await rm(dataDir, { recursive: true, force: true });
}, 60_000);

describe.runIf(enabled)("the schedule hunt (F-106, F-048)", () => {
  it(
    "F-106, F-048/c2: every (automation, occurrence) pair starts exactly once with every replica but one killed at the work, and pg-boss's own cron, hunted the same way, doesn't",
    async () => {
      const queue = jobs;
      if (queue === null) throw new Error("the queue");
      note(
        `schedule hunt: ${String(settings.schedules)} automations, ${String(settings.strikesPerPoint)} strikes at each of three kill points (at most ${String(settings.maxTicks)} ticks), then 7 hours down; the control ${settings.control ? `on pg-boss's own cron, ${String(settings.controlTicks)} ticks` : "off"}`,
      );
      const hunt: Promise<HuntResult> = runScheduleHunt({
        db: test.db,
        jobs: queue,
        fixture,
        env,
        logDir: path.join(logDir, "hunt"),
        note: (line) => {
          note(`hunt: ${line}`);
        },
        scheduleCount: settings.schedules,
        strikesPerPoint: settings.strikesPerPoint,
        maxTicks: settings.maxTicks,
        lateHours: 7,
        missedHours: 6,
      });
      const control: Promise<CronControlResult | null> =
        controlDb === null
          ? Promise.resolve(null)
          : runCronControl({
              databaseUrl: controlDb.url,
              scheduleCount: settings.schedules,
              ticks: settings.controlTicks,
              strandTarget: 3,
              strandWaitMinutes: settings.strandWaitMinutes,
              logDir: path.join(logDir, "control"),
              note,
            });
      const [huntResult, controlResult] = await Promise.all([hunt, control]);
      note(`hunt: ${huntResult.ok ? "PASSED" : "FAILED"}: ${String(huntResult.checks.filter((one) => one.ok).length)} of ${String(huntResult.checks.length)} checks`);
      if (controlResult !== null) {
        for (const line of controlResult.evidence) note(`control: ${line}`);
        note(
          `control: ${controlResult.failed ? "FAILED, as spike 8 found" : "passed, which the control must not"}: ${String(controlResult.missed)} of ${String(controlResult.expectedPairs)} pairs missed their tick, ${String(controlResult.duplicates)} duplicate starts (${String(controlResult.doubled)} pairs twice in their tick, ${String(controlResult.replayedDuplicates)} replayed, ${String(controlResult.warmUpOverFires)} over-fired in the warm-up)`,
        );
      }
      const verdict = huntResult.ok && (controlResult === null || (controlResult.failed && controlResult.duplicates > 0));
      note(`schedule hunt: ${verdict ? "PASS" : "FAIL"}${controlResult === null ? " (no control)" : ""}`);
      expect(huntResult.checks.filter((one) => !one.ok).map((one) => `${one.name}: ${one.detail}`)).toEqual([]);
      if (controlResult !== null) {
        expect(controlResult.failed, "the control on pg-boss's own cron started nothing late or twice").toBe(true);
        expect(controlResult.duplicates, "the control showed no duplicate start").toBeGreaterThan(0);
      }
    },
    60 * MINUTE,
  );
});

describe.skipIf(enabled)("the schedule hunt", () => {
  it("runs only in `pnpm e2e:schedule-hunt` and the failure suite (OSTRA_SCHEDULE_HUNT=1)", () => {
    expect(enabled).toBe(false);
  });
});
