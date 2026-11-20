import { createDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  deleteAutomation,
  pauseAutomation,
  postgresAuditLog,
  postgresChangeNotices,
  runOccurrence,
  saveAutomation,
  tickAutomationInTx,
  tickScheduler,
} from "@ostra/domain";
import type { AutomationSettings, Clock, MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { leaseEpochSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { AutomationId, OrganizationId, ProjectId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { automationJobDeps, labelFilter, recordingLogger, scopeOf, trackerTicket } from "../testing/automations.ts";
import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { expectStartGates } from "../testing/start-gates.ts";
import { seedBoard, seedTicketRow, seedTrackerConnection } from "../testing/tickets.ts";
import { jobContext } from "../testing/turns.ts";
import { seedWorld } from "../testing/world.ts";
import { ensureSchedulerTick, occurrenceHandler, schedulerTickHandler } from "./automations.ts";

// Ticket 10 (F-106, ADR 0037 amended, ADR 0056): the scheduler's tick and its occurrences, against
// a real database and pg-boss. Time is the `Clock` port, moved by hand; each case reads its rows
// and the queue's jobs back.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let organizationId: OrganizationId;
let projectId: ProjectId;
let admin: MemberScope;
let now = Date.UTC(2026, 2, 2, 8, 0, 0);
const clock: Clock = { now: () => now };
const HOUR = 3_600_000;
const at = (iso: string): number => Date.parse(iso);

const deps = (db: Db = test.db) => ({ db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock });

const prompt = (fields: Partial<Extract<AutomationSettings, { kind: "schedule" }>> = {}): AutomationSettings => ({
  name: `Nightly ${String(Math.random()).slice(2, 10)}`,
  taskKind: "code",
  agentProfileId: null,
  poolLabels: [],
  requireApproval: false,
  kind: "schedule",
  schedule: "0 9 * * *",
  timeZone: "UTC",
  skipWhileOpen: true,
  does: { kind: "prompt", title: "Update the dependencies", prompt: "Run `pnpm up` and fix what breaks; $(rm -rf /) is data" },
  ...fields,
});

const save = async (settings: AutomationSettings): Promise<AutomationId> => {
  const saved = await saveAutomation(deps(), admin, { projectId, automationId: null, settings });
  if (!saved.ok) throw new Error(`save refused: ${saved.error}`);
  return saved.automationId;
};

const runsOf = (automationId: AutomationId) =>
  test.db.automationRun.findMany({ where: { automationId, kind: "occurrence" }, orderBy: { occurrenceAt: "asc" } });

const occurrenceJobs = async (automationId: AutomationId, occurrenceAt: number) =>
  (await jobs.find("automation.occurrence", { organizationId, automationId, occurrenceAt })).length;

const tick = () => tickScheduler(deps());

/** The occurrence's job, as its worker runs it. */
const run = (automationId: AutomationId, occurrenceAt: number) => runOccurrence(deps(), { organizationId, automationId, occurrenceAt });

const taskOf = async (automationId: AutomationId, occurrenceAt: number): Promise<TaskId> => {
  const row = await test.db.automationRun.findFirstOrThrow({ where: { automationId, kind: "occurrence", occurrenceAt: new Date(occurrenceAt) } });
  return taskIdSchema.parse(row.taskId);
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  organizationId = fixture.a.organization.id;
  projectId = fixture.a.openProject.id;
  await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() }, organizationId, projectId);
  admin = scopeOf(fixture.a.admin, "admin");
});

beforeEach(async () => {
  // Each case starts with no live automation and its own clock.
  await test.db.automation.updateMany({ where: { deletedAt: null }, data: { deletedAt: new Date() } });
  await test.db.task.updateMany({ where: { state: { notIn: ["stopped", "merged", "done"] } }, data: { state: "stopped", stoppedReason: "requested" } });
  now = Date.UTC(2026, 2, 2, 8, 0, 0);
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("scheduler.tick (F-106)", () => {
  it("F-106: each occurrence is inserted once with its job in one transaction, and a rolled-back transaction leaves neither", async () => {
    const automationId = await save(prompt());
    const other = await save(prompt());
    const nine = at("2026-03-02T09:00:00Z");
    now = nine + 30_000;
    // One tick at a time here: the other schedule waits for the rolled-back step below.
    await test.db.automation.update({ where: { id: other }, data: { pausedAt: new Date(), pausedReason: "member" } });
    expect(await tick()).toEqual({ occurrences: 1, missed: 0 });
    await test.db.automation.update({ where: { id: other }, data: { pausedAt: null, pausedReason: null } });
    const runs = await runsOf(automationId);
    expect(runs.map((row) => [row.occurrenceAt?.getTime(), row.state, row.taskId])).toEqual([[nine, "started", null]]);
    expect(await occurrenceJobs(automationId, nine)).toBe(1);
    // The next occurrence is tomorrow's, in the schedule's zone.
    expect((await test.db.automation.findUniqueOrThrow({ where: { id: automationId } })).nextOccurrenceAt?.getTime()).toBe(nine + 24 * HOUR);

    // The same step in a transaction that rolls back: no row, no job, the schedule not advanced.
    const before = (await test.db.automation.findUniqueOrThrow({ where: { id: other } })).nextOccurrenceAt;
    await expect(
      test.db.$transaction(async (tx) => {
        expect(await tickAutomationInTx(deps(), tx, other, now)).toMatchObject({ fired: nine });
        throw new Error("the transaction rolls back");
      }),
    ).rejects.toThrow("the transaction rolls back");
    expect(await runsOf(other)).toEqual([]);
    expect(await occurrenceJobs(other, nine)).toBe(0);
    expect((await test.db.automation.findUniqueOrThrow({ where: { id: other } })).nextOccurrenceAt).toEqual(before);
    // The next tick, committed, records it once with its job.
    expect(await tick()).toEqual({ occurrences: 1, missed: 0 });
    expect(await occurrenceJobs(other, nine)).toBe(1);
    // Organization B's rows are untouched by organization A's schedules.
    expect(await test.db.automationRun.count({ where: { organizationId: fixture.b.organization.id } })).toBe(0);
  });

  it("F-106: ticks in parallel on three replicas start each occurrence once, and a tick that finds its occurrence recorded adds nothing", async () => {
    const replicas = [test.db, createDb(test.url), createDb(test.url)];
    const automationId = await save(prompt({ schedule: "0 * * * *" }));
    const fired: number[] = [];
    let reported = 0;
    for (let hour = 9; hour <= 14; hour += 1) {
      now = Date.UTC(2026, 2, 2, hour, 0, 5);
      fired.push(Date.UTC(2026, 2, 2, hour));
      const results = await Promise.all(replicas.flatMap((db) => [tickScheduler(deps(db)), tickScheduler(deps(db))]));
      reported += results.reduce((sum, result) => sum + result.occurrences, 0);
    }
    // The backstop: a tick that finds the last occurrence already recorded (its schedule's row set
    // back, as a restore would) inserts no second row and sends no second job.
    const last = fired.at(-1) ?? 0;
    await test.db.automation.update({ where: { id: automationId }, data: { nextOccurrenceAt: new Date(last) } });
    const again = await Promise.all(replicas.map((db) => tickScheduler(deps(db))));
    expect(again.reduce((sum, result) => sum + result.occurrences, 0)).toBe(0);

    const runs = await runsOf(automationId);
    expect(runs.map((row) => row.occurrenceAt?.getTime())).toEqual(fired);
    expect(reported).toBe(fired.length);
    for (const occurrenceAt of fired) {
      expect(await occurrenceJobs(automationId, occurrenceAt)).toBe(1);
    }
    expect((await test.db.automation.findUniqueOrThrow({ where: { id: automationId } })).nextOccurrenceAt?.getTime()).toBe(last + HOUR);
    await Promise.all(replicas.slice(1).map((db) => db.$disconnect()));
  });

  it("F-106: an occurrence 3 hours late fires; one 7 hours late is recorded missed, with one audit entry per catch-up", async () => {
    const automationId = await save(prompt());
    // 3 hours late: under the 6-hour limit, it fires.
    now = at("2026-03-02T12:00:00Z");
    expect(await tick()).toEqual({ occurrences: 1, missed: 0 });
    expect(await occurrenceJobs(automationId, at("2026-03-02T09:00:00Z"))).toBe(1);
    // 7 hours late: recorded `missed`, and no job.
    now = at("2026-03-03T16:00:00Z");
    expect(await tick()).toEqual({ occurrences: 0, missed: 1 });
    expect(await occurrenceJobs(automationId, at("2026-03-03T09:00:00Z"))).toBe(0);
    // Two days down: of the due ones, only the latest under the limit fires; the older one is missed.
    now = at("2026-03-05T10:00:00Z");
    expect(await tick()).toEqual({ occurrences: 1, missed: 1 });
    const runs = await runsOf(automationId);
    expect(runs.map((row) => [row.occurrenceAt?.toISOString(), row.state])).toEqual([
      ["2026-03-02T09:00:00.000Z", "started"],
      ["2026-03-03T09:00:00.000Z", "missed"],
      ["2026-03-04T09:00:00.000Z", "missed"],
      ["2026-03-05T09:00:00.000Z", "started"],
    ]);
    const audits = await test.db.auditEntry.findMany({ where: { entityId: automationId, action: "automation.occurrences-missed" }, orderBy: { createdAt: "asc" } });
    expect(audits.map((row) => row.data)).toEqual([
      { missed: 1, firstMissedAt: at("2026-03-03T09:00:00Z"), lastMissedAt: at("2026-03-03T09:00:00Z") },
      { missed: 1, firstMissedAt: at("2026-03-04T09:00:00Z"), lastMissedAt: at("2026-03-04T09:00:00Z") },
    ]);
  });

  it("F-106: a pause, an edit and a delete act at the next tick, and an occurrence queued before them is skipped", async () => {
    // A pause: the queued occurrence is skipped, nothing fires while paused, and a resume never fires a past time.
    const paused = await save(prompt({ schedule: "0 * * * *" }));
    now = at("2026-03-02T09:00:10Z");
    expect(await tick()).toMatchObject({ occurrences: 1 });
    expect(await pauseAutomation(deps(), admin, { automationId: paused, paused: true })).toMatchObject({ ok: true });
    expect(await run(paused, at("2026-03-02T09:00:00Z"))).toEqual({ ok: true, state: "skipped", taskId: null });
    expect((await runsOf(paused))[0]).toMatchObject({ state: "skipped", skipReason: "paused" });
    now = at("2026-03-02T10:00:10Z");
    expect(await tick()).toEqual({ occurrences: 0, missed: 0 });
    now = at("2026-03-02T10:30:00Z");
    expect(await pauseAutomation(deps(), admin, { automationId: paused, paused: false })).toMatchObject({ ok: true });
    expect(await tick()).toEqual({ occurrences: 0, missed: 0 });
    now = at("2026-03-02T11:00:05Z");
    expect(await tick()).toMatchObject({ occurrences: 1 });
    expect((await runsOf(paused)).map((row) => row.occurrenceAt?.toISOString())).toEqual(["2026-03-02T09:00:00.000Z", "2026-03-02T11:00:00.000Z"]);

    // An edit: recomputed from now, so a time already past never fires.
    await test.db.automation.update({ where: { id: paused }, data: { deletedAt: new Date() } });
    const edited = await save(prompt());
    now = at("2026-03-02T09:30:00Z");
    const settings = prompt({ name: "Edited", schedule: "0 10 * * *" });
    expect(await saveAutomation(deps(), admin, { projectId, automationId: edited, settings })).toMatchObject({ ok: true, nextOccurrenceAt: at("2026-03-02T10:00:00Z") });
    expect(await tick()).toEqual({ occurrences: 0, missed: 0 });
    now = at("2026-03-02T10:00:05Z");
    expect(await tick()).toMatchObject({ occurrences: 1 });
    expect((await runsOf(edited)).map((row) => row.occurrenceAt?.toISOString())).toEqual(["2026-03-02T10:00:00.000Z"]);

    // A delete: the queued occurrence is skipped, and the next tick fires nothing.
    now = at("2026-03-03T10:00:05Z");
    expect(await tick()).toMatchObject({ occurrences: 1 });
    expect(await deleteAutomation(deps(), admin, { automationId: edited })).toMatchObject({ ok: true });
    expect(await run(edited, at("2026-03-03T10:00:00Z"))).toEqual({ ok: true, state: "skipped", taskId: null });
    now = at("2026-03-04T10:00:05Z");
    expect(await tick()).toEqual({ occurrences: 0, missed: 0 });
    expect(await test.db.task.count({ where: { automationId: edited } })).toBe(0);
  });

  it("F-106: with skip-while-open on, an occurrence starts nothing until the last one's task is merged, done or stopped", async () => {
    const skipping = await save(prompt({ schedule: "0 * * * *" }));
    const always = await save(prompt({ schedule: "0 * * * *", skipWhileOpen: false }));
    const hour = (h: number) => Date.UTC(2026, 2, 2, h);
    const step = async (h: number) => {
      now = hour(h) + 5_000;
      await tick();
      return [await run(skipping, hour(h)), await run(always, hour(h))];
    };
    const [first] = await step(9);
    expect(first).toMatchObject({ ok: true, state: "started" });
    const firstTask = await taskOf(skipping, hour(9));
    // The last one's task is still queued: skipped. The other schedule starts one each time.
    expect(await step(10)).toEqual([{ ok: true, state: "skipped", taskId: null }, expect.objectContaining({ state: "started" })]);
    expect((await runsOf(skipping))[1]).toMatchObject({ state: "skipped", skipReason: "last_open" });
    await test.db.task.update({ where: { id: firstTask }, data: { state: "merged" } });
    const [third] = await step(11);
    expect(third).toMatchObject({ ok: true, state: "started" });
    expect(await test.db.task.count({ where: { automationId: skipping } })).toBe(2);
    expect(await test.db.task.count({ where: { automationId: always } })).toBe(3);
  });

  it("F-106: a prompt schedule starts its task, and a filter schedule starts each match it hasn't started, through the workers", async () => {
    const connectionId = await seedTrackerConnection(test.db, new FakeSecretStore(), organizationId);
    const boardId = await seedBoard(test.db, { organizationId, projectId, connectionId, externalId: "team-sched", key: "SCH", mapping: null });
    const matching = await seedTicketRow(test.db, { organizationId, projectId, boardId, connectionId, ticket: trackerTicket("SCH-1", { labels: ["Deps"] }) });
    // A near miss: another label.
    await seedTicketRow(test.db, { organizationId, projectId, boardId, connectionId, ticket: trackerTicket("SCH-2", { labels: ["docs"] }) });

    const promptId = await save(prompt());
    const filterId = await save(prompt({ does: { kind: "filter", filter: labelFilter(["deps"]) } }));
    const { logger, records } = recordingLogger();
    const workerDeps = automationJobDeps(test.db, jobs, clock);
    const nine = at("2026-03-02T09:00:00Z");
    now = nine + 5_000;
    // The tick's and the occurrence's workers, as core registers them.
    await schedulerTickHandler(workerDeps)(jobContext("scheduler.tick", {}, logger));
    await occurrenceHandler(workerDeps)(jobContext("automation.occurrence", { organizationId, automationId: promptId, occurrenceAt: nine }, logger));
    await occurrenceHandler(workerDeps)(jobContext("automation.occurrence", { organizationId, automationId: filterId, occurrenceAt: nine }, logger));

    const promptTask = await test.db.task.findFirstOrThrow({ where: { automationId: promptId }, include: { sessions: true } });
    expect(promptTask).toMatchObject({ source: "prompt", origin: "automation", kind: "code", state: "queued", title: "Update the dependencies", creatorMemberId: null, ticketId: null });
    expect(await taskOf(promptId, nine)).toBe(promptTask.id);
    // The thread says which automation started it, by ID and time.
    const event = await test.db.event.findFirstOrThrow({ where: { taskId: promptTask.id, kind: "automation.started" } });
    expect(event.payload).toMatchObject({ kind: "automation.started", automationId: promptId, occurrenceAt: nine });
    const session = promptTask.sessions[0];
    expect(promptTask.sessions).toHaveLength(1);
    expect(await jobs.find("task.dispatch", { organizationId, taskId: taskIdSchema.parse(promptTask.id), sessionId: sessionIdSchema.parse(session?.id), leaseEpoch: leaseEpochSchema.parse(1) })).toHaveLength(1);

    // The filter schedule: the matching ticket only, once.
    const filterTasks = await test.db.task.findMany({ where: { automationId: filterId } });
    expect(filterTasks.map((task) => [task.ticketId, task.origin, task.source])).toEqual([[matching, "automation", "ticket"]]);
    expect(await test.db.automationRun.count({ where: { automationId: filterId, kind: "ticket_match", ticketId: matching } })).toBe(1);
    await test.db.task.updateMany({ where: { automationId: filterId }, data: { state: "merged" } });
    now = at("2026-03-03T09:00:05Z");
    await tick();
    expect(await run(filterId, at("2026-03-03T09:00:00Z"))).toMatchObject({ ok: true, state: "started" });
    expect(await test.db.task.count({ where: { automationId: filterId } })).toBe(1);
    // Log lines carry IDs and states, never the prompt or a ticket's text.
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toMatch(/pnpm up|rm -rf|curl evil|Ticket SCH/);
  });

  it("F-106: the tick is one pg-boss schedule a minute, whichever replicas register it, and a tick seconds after a due time fires it", async () => {
    // Two replicas start their workers: one schedule, once a minute.
    const other = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
    await other.start();
    try {
      await ensureSchedulerTick(jobs);
      await ensureSchedulerTick(other);
    } finally {
      await other.stop({ graceful: false, timeoutMs: 2_000 });
    }
    const schedules = z.array(z.looseObject({ cron: z.string() })).parse(await test.db.$queryRaw<readonly unknown[]>`SELECT cron FROM pgboss.schedule WHERE name = 'scheduler.tick'`);
    expect(schedules.map((row) => row.cron)).toEqual(["* * * * *"]);
    // A tick 5 seconds after the due minute fires it; one a second before doesn't.
    const automationId = await save(prompt({ schedule: "30 9 * * *" }));
    now = at("2026-03-02T09:29:59Z");
    expect(await tick()).toEqual({ occurrences: 0, missed: 0 });
    now = at("2026-03-02T09:30:05Z");
    expect(await tick()).toEqual({ occurrences: 1, missed: 0 });
    expect(await occurrenceJobs(automationId, at("2026-03-02T09:30:00Z"))).toBe(1);
  });

  it("F-106: an occurrence's start passes the budget, its pool labels reach admission, and the project's share of a pool holds it queued with each reason", async () => {
    const automationId = await save(prompt({ poolLabels: ["gpu"] }));
    now = at("2026-03-02T09:00:05Z");
    await tick();
    expect(await run(automationId, at("2026-03-02T09:00:00Z"))).toMatchObject({ ok: true, state: "started" });
    const taskId = await taskOf(automationId, at("2026-03-02T09:00:00Z"));
    await expectStartGates({ db: test.db, jobs, clock, organizationId, projectId }, taskId, ["gpu"]);
  });
});
