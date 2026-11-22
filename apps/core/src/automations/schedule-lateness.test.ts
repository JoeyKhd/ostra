import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { postgresAuditLog, postgresChangeNotices, saveAutomation, systemClock } from "@ostra/domain";
import type { AutomationSettings } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { automationJobDeps, scopeOf } from "../testing/automations.ts";
import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { seedWorld } from "../testing/world.ts";
import { startAutomationWorkers } from "./automations.ts";

// F-106/c6 (ADR 0037, ticket 37's finding): a tick's resolution is one minute, and a start comes a
// few seconds late. Core's automation workers and the scheduler tick's pg-boss schedule, as core
// starts them, on a database of their own and the real clock, with the queue's polling as shipped.
//
// The case starts the queue at the moment that is worst for a slow cron pass: pg-boss's pass runs
// once at the start and then every interval, so a queue started 7 to 18 s before a minute (or
// 37 to 48 s before it) has its pass before the minute and the next one after it. At pg-boss's
// defaults (a pass every 30 s, the forwarding poll every 5 s) that next pass came 12 s or more
// after the minute; ticket 37's hunt measured 8 to 21 s at p50. The case waits for that moment
// rather than hoping for it, so it holds the bound, not a lucky phase.

const MINUTE = 60_000;
/** "A few seconds": the start of a minute's occurrence, at most this long after its minute. */
const FEW_SECONDS_MS = 10_000;

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs | null = null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const everyMinute: AutomationSettings = {
  name: "Every minute",
  taskKind: "code",
  agentProfileId: null,
  poolLabels: [],
  requireApproval: false,
  kind: "schedule",
  schedule: "* * * * *",
  timeZone: "UTC",
  skipWhileOpen: false,
  does: { kind: "prompt", title: "Tidy the README", prompt: "A prompt this case never reads back; $(rm -rf ~) is data" },
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() }, fixture.a.organization.id, fixture.a.openProject.id);
}, 120_000);

afterAll(async () => {
  await jobs?.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("the scheduler tick's lateness (F-106)", () => {
  it(
    "F-106/c6: a minute's occurrence is a whole minute, and its task starts a few seconds after it, even when the cron pass last ran just before the minute",
    async () => {
      // Wait until the next minute is 14 to 18 s away (or 44 to 48 s): the queue's first pass, at the
      // end of its install, then lands 7 to 18 s (or 37 to 48 s) before that minute.
      const untilMinute = (): number => MINUTE - (Date.now() % MINUTE);
      while (!(untilMinute() % 30_000 >= 14_000 && untilMinute() % 30_000 <= 18_000)) {
        await sleep(250);
      }
      // Core's queue, as `startCore` makes it: the polling and the cron pass as shipped.
      const queue = createJobs({ databaseUrl: test.url, role: "worker" });
      jobs = queue;
      await queue.start();
      await startAutomationWorkers(queue, automationJobDeps(test.db, queue, systemClock, { scheduleMinIntervalMinutes: 1 }));
      const saved = await saveAutomation(
        { db: test.db, jobs: queue, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, scheduleMinIntervalMinutes: 1 },
        scopeOf(fixture.a.admin, "admin"),
        { projectId: fixture.a.openProject.id, automationId: null, settings: everyMinute },
      );
      if (!saved.ok) throw new Error(`the save was refused: ${saved.error}`);
      // The automation's first occurrence: the first whole minute after its save.
      const minute = Math.ceil(Date.now() / MINUTE) * MINUTE;

      // The occurrence of that minute starts its task; wait well past the bound, so a late one shows as late.
      let started: { readonly occurrenceAt: number; readonly insertedAt: number; readonly taskAt: number } | null = null;
      while (started === null && Date.now() < minute + 3 * FEW_SECONDS_MS) {
        const run = await test.db.automationRun.findFirst({
          where: { automationId: saved.automationId, kind: "occurrence", state: "started", taskId: { not: null } },
          orderBy: { occurrenceAt: "asc" },
          select: { occurrenceAt: true, createdAt: true, task: { select: { createdAt: true } } },
        });
        if (run?.occurrenceAt !== null && run?.occurrenceAt !== undefined && run.task !== null) {
          started = { occurrenceAt: run.occurrenceAt.getTime(), insertedAt: run.createdAt.getTime(), taskAt: run.task.createdAt.getTime() };
        } else {
          await sleep(200);
        }
      }
      if (started === null) throw new Error(`no task started within ${String((3 * FEW_SECONDS_MS) / 1000)} s of its minute`);
      // The resolution is a minute: the occurrence is the minute itself.
      expect(started.occurrenceAt).toBe(minute);
      expect(started.occurrenceAt % MINUTE).toBe(0);
      // Its row went in once the minute came, and its task started a few seconds after it.
      expect(started.insertedAt).toBeGreaterThanOrEqual(minute);
      expect(started.taskAt - minute, `the task started ${String((started.taskAt - minute) / 1000)} s after its minute`).toBeLessThan(FEW_SECONDS_MS);
      // One occurrence, one task.
      expect(await test.db.task.count({ where: { automationId: saved.automationId } })).toBe(1);
    },
    150_000,
  );
});
