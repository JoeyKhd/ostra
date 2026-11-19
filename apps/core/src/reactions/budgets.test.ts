import { randomUUID } from "node:crypto";

import { ResendEmailAdapter } from "@ostra/adapter-email-resend";
import { SmtpEmailAdapter } from "@ostra/adapter-email-smtp";
import { createLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import { startFakeResendApi, startFakeSmtpServer } from "@ostra/adapter-sdk/testing";
import type { FakeResendApi, FakeSmtpServer } from "@ostra/adapter-sdk/testing";
import { Prisma } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  budgetMonthOf,
  dispatchTask,
  dispatchWaitFromDb,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  reopenTask,
  saveEmailSettings,
  sendMemberMessageInTx,
  setBudget,
  stopTask,
  systemClock,
} from "@ostra/domain";
import type { Clock, MemberScope, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { budgetIdSchema, clientMessageIdSchema, leaseEpochSchema, memberIdSchema, modelIdSchema, organizationIdSchema, projectIdSchema, turnIdSchema } from "@ostra/protocol";
import type { BudgetId, ModelId, OrganizationId, ProjectId, TaskEvent, TaskId } from "@ostra/protocol";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { createNotificationChannels } from "../notifications/channels.ts";
import { createConnectionTrackers } from "../tracker/connections.ts";
import { notifyDeliverHandler } from "../notifications/deliver.ts";
import type { NotifyDeps } from "../notifications/deliver.ts";
import { createEmailChannel } from "../notifications/email.ts";
import type { EmailAdapterFactories } from "../notifications/email.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { queuedDeliveries } from "../testing/notify.ts";
import { acceptedTask, jobContext } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { budgetCheckHandler, budgetNewMonthHandler, budgetReleaseHandler, ensureBudgetNewMonthSchedule } from "./budgets.ts";
import type { BudgetJobDeps } from "./budgets.ts";

// Ticket 13 (F-037, F-115, ADR 0055, ADR 0050): budget notices and their release, against a real
// database and queue. `budget.check` writes one notice per budget, month and threshold and fans it
// out to the admins of the budget's scope, in the panel and by mail (the real Resend and SMTP
// adapters on their fakes). Saving a budget checks the month at once; a raise above the spend, or a
// new month, lets the held turns go in the order they were held, each through the gate again.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let ingest: Ingest;
let liveText: LiveTextWriter;
let runner: RunnerRef;
let memberScope: MemberScope;
let adminScope: MemberScope;
let modelId: ModelId;
let projectId: ProjectId;
let organizationId: OrganizationId;
let resend: FakeResendApi;
let smtp: FakeSmtpServer;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const logger = createLogger(() => undefined);
const PUBLIC_URL = "https://ostra.example";
const taken = new Set<string>();

const PRICES = {
  inputPricePerMTok: new Prisma.Decimal(3),
  outputPricePerMTok: new Prisma.Decimal(15),
  cacheReadPricePerMTok: new Prisma.Decimal("0.3"),
  cacheWritePricePerMTok: new Prisma.Decimal("3.75"),
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  organizationId = organizationIdSchema.parse(fixture.a.organization.id);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  resend = await startFakeResendApi();
  smtp = await startFakeSmtpServer({ starttls: "offered", auth: { user: "ostra", pass: "relay-password" } });
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  const timers: SessionTimers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox, budgetWarnPercent: 80 });
  runner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 50);
  memberScope = { organizationId, memberId: memberIdSchema.parse(fixture.a.member.id), role: "member", projectRoles: new Map() };
  adminScope = { organizationId, memberId: memberIdSchema.parse(fixture.a.admin.id), role: "admin", projectRoles: new Map() };
  modelId = modelIdSchema.parse((await test.db.agentProfile.findUniqueOrThrow({ where: { id: world.profileId } })).modelId);
  await test.db.model.update({ where: { id: modelId }, data: PRICES });
  projectId = projectIdSchema.parse(world.projectId);
  // The insider is an admin of the open project: a project budget's notice reaches them too.
  await test.db.projectMember.create({ data: { organizationId, projectId, memberId: fixture.a.insider.id, role: "admin" } });
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await resend.close();
  await smtp.close();
  await test.dispose();
});

beforeEach(async () => {
  await test.db.heldTurn.deleteMany({});
  await test.db.notification.deleteMany({ where: { kind: { in: ["budget_warning", "budget_reached"] } } });
  await test.db.budget.deleteMany({});
  await test.db.spendDaily.deleteMany({});
  await test.db.emailSettings.deleteMany();
  await test.db.notificationPreference.deleteMany({});
  // Every case reads only the deliveries it made.
  await queuedDeliveries(test.db, taken);
});

const clockAt = (ms: number): Clock => ({ now: () => ms });

const budgetDeps = (clock: Clock = systemClock): BudgetJobDeps => ({
  db: test.db,
  jobs,
  outbox: postgresCommandOutbox,
  notices: postgresChangeNotices,
  clock,
  budgetWarnPercent: 80,
  emailDelaySeconds: 0,
});

const m4Deps = (clock: Clock = systemClock) => ({
  db: test.db,
  jobs,
  outbox: postgresCommandOutbox,
  notices: postgresChangeNotices,
  audit: postgresAuditLog,
  clock,
  adapters: { codeHost, modelProvider: new FakeModelProvider(), secretStore },
  budgetWarnPercent: 80,
});

const factories: EmailAdapterFactories = {
  resend: (options, context) => new ResendEmailAdapter({ ...options, baseUrl: resend.url }, context),
  smtp: (options, context) => new SmtpEmailAdapter({ ...options, tlsCa: smtp.cert }, context),
};

const notifyDeps = (): NotifyDeps & { readonly close: () => void } => {
  const email = createEmailChannel({ db: test.db, secretStore, clock: systemClock, logger, publicUrl: PUBLIC_URL, stallMinutes: 30, fromSettings: { source: "panel", fromName: "ostra" }, factories });
  return {
    db: test.db,
    jobs,
    notices: postgresChangeNotices,
    outbox: postgresCommandOutbox,
    audit: postgresAuditLog,
    clock: systemClock,
    adapters: { codeHost, modelProvider: new FakeModelProvider(), secretStore },
    logger,
    trackers: createConnectionTrackers({ db: test.db, secretStore, clock: systemClock, logger }),
    channels: createNotificationChannels(test.db, { logger, clock: adapterClock }),
    email,
    publicUrl: PUBLIC_URL,
    emailDelaySeconds: 0,
    trackerCoalesceMinutes: 10,
    stallMinutes: 30,
    close: email.close,
  };
};

const instanceAdmin = () => ({ userId: fixture.a.admin.userId, memberId: memberIdSchema.parse(fixture.a.admin.id), instanceAdmin: true, organizationId });

const deliverQueued = async (deps: NotifyDeps): Promise<void> => {
  for (const job of await queuedDeliveries(test.db, taken)) {
    await notifyDeliverHandler(deps)(jobContext("notify.deliver", { organizationId: job.organizationId, deliveryId: job.deliveryId }, logger));
  }
};

/** A budget of `usd` dollars written straight to its row: the project's, or the organization's for `null`. */
const seedBudget = async (target: ProjectId | null, usd: number): Promise<BudgetId> =>
  budgetIdSchema.parse((await test.db.budget.create({ data: { organizationId, projectId: target, monthlyMicroUsd: BigInt(Math.round(usd * 1_000_000)) } })).id);

/** This month's spend, written as ingest would have: on the project's row for today (UTC). */
const seedSpend = async (micro: bigint): Promise<void> => {
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  await test.db.spendDaily.upsert({
    where: { projectId_day_modelId: { projectId, day, modelId } },
    create: { organizationId, projectId, day, modelId, spentMicroUsd: micro },
    update: { spentMicroUsd: { increment: micro } },
  });
};

const month = () => budgetMonthOf(Date.now());

const check = (budgetId: BudgetId, threshold: "warn" | "reached") =>
  budgetCheckHandler(budgetDeps())(jobContext("budget.check", { organizationId, budgetId, month: month(), threshold }, logger));

const release = (budgetId: BudgetId, clock: Clock = systemClock) =>
  budgetReleaseHandler(budgetDeps(clock))(jobContext("budget.release", { organizationId, budgetId, raisedAt: clock.now() }, logger));

const jobsNamed = async (name: string, field: string, value: string): Promise<readonly Record<string, unknown>[]> =>
  z
    .array(z.object({ data: z.record(z.string(), z.unknown()) }))
    .parse(await test.db.$queryRaw`SELECT data FROM pgboss.job WHERE name = ${name} AND data->>${field} = ${value} ORDER BY created_on, id`)
    .map((row) => row.data);

const budgetNotifications = (kind: "budget_warning" | "budget_reached") =>
  test.db.notification.findMany({ where: { kind }, include: { deliveries: true }, orderBy: { memberId: "asc" } });

const turnStarted = (n: number): TaskEvent => ({ kind: "turn.started", turnId: turnIdSchema.parse(`turn-${String(n)}`) });
const turnEnded = (n: number): TaskEvent => ({ kind: "turn.ended", turnId: turnIdSchema.parse(`turn-${String(n)}`), stopReason: "end_turn" });

/** A task whose first turn ended: its session is idle, so a message to it starts a turn. */
const idleTask = async (): Promise<DrivenTask> => {
  const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner);
  await task.send(turnStarted(1), turnEnded(1));
  return task;
};

const message = (taskId: TaskId, text: string) =>
  test.db.$transaction((tx) =>
    sendMemberMessageInTx(
      { jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock },
      tx,
      memberScope,
      { taskId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text, intent: "message", sender: "driver" },
    ),
  );

/** The texts of the steers the runner was sent, in the order it was sent them. */
const steersInOrder = async (): Promise<readonly string[]> =>
  (await test.db.command.findMany({ where: { runnerId: runner.runnerId, kind: "steer" }, orderBy: { seq: "asc" }, select: { body: true } })).map((row) =>
    z.object({ text: z.string() }).parse(row.body).text,
  );

describe("budget.check (F-037)", () => {
  it("F-037: one notice per budget, month and threshold, also when budget.check runs twice", async () => {
    const budgetId = await seedBudget(projectId, 1);
    await seedSpend(850_000n);
    await check(budgetId, "warn");
    await check(budgetId, "warn");
    // Not at 100% yet: the reached notice isn't due, and nothing is written for it.
    await check(budgetId, "reached");
    expect(await test.db.budgetNotice.findMany({ where: { budgetId }, select: { month: true, threshold: true } })).toEqual([{ month: month(), threshold: "warn" }]);
    const warnings = await budgetNotifications("budget_warning");
    expect(warnings).toHaveLength(2);
    expect(await budgetNotifications("budget_reached")).toHaveLength(0);

    await seedSpend(200_000n);
    await check(budgetId, "reached");
    await check(budgetId, "reached");
    await check(budgetId, "warn");
    const notices = await test.db.budgetNotice.findMany({ where: { budgetId }, select: { threshold: true }, orderBy: { threshold: "asc" } });
    expect(notices.map((row) => row.threshold).sort()).toEqual(["reached", "warn"]);
    expect(await budgetNotifications("budget_warning")).toHaveLength(2);
    expect(await budgetNotifications("budget_reached")).toHaveLength(2);
  });

  it("F-037: the audiences: an organization budget's admins, and a project budget's also its project's admins; mail on by default, a member's choice wins", async () => {
    const organizationBudget = await seedBudget(null, 1);
    await seedSpend(900_000n);
    await check(organizationBudget, "warn");
    const organizationWide = await budgetNotifications("budget_warning");
    expect(organizationWide.map((row) => row.memberId)).toEqual([fixture.a.admin.id]);
    expect(organizationWide[0]?.deliveries.map((row) => row.channel).sort()).toEqual(["email", "panel"]);
    expect(organizationWide[0]?.projectId).toBeNull();

    // The insider turned budget mail off: they still get the panel's.
    await test.db.notificationPreference.create({ data: { organizationId, memberId: fixture.a.insider.id, kind: "budget_reached", channel: "email", enabled: false } });
    const projectBudget = await seedBudget(projectId, 0.5);
    await check(projectBudget, "reached");
    const projectWide = await budgetNotifications("budget_reached");
    expect(projectWide.map((row) => row.memberId).sort()).toEqual([fixture.a.admin.id, fixture.a.insider.id].sort());
    expect(projectWide.every((row) => row.projectId === projectId)).toBe(true);
    const byMember = new Map(projectWide.map((row) => [row.memberId, row.deliveries.map((delivery) => delivery.channel).sort()]));
    expect(byMember.get(fixture.a.admin.id)).toEqual(["email", "panel"]);
    expect(byMember.get(fixture.a.insider.id)).toEqual(["panel"]);
    // An ordinary member, and the other organization's admin, get nothing.
    expect(await test.db.notification.count({ where: { memberId: { in: [fixture.a.member.id, fixture.b.admin.id] }, kind: { in: ["budget_warning", "budget_reached"] } } })).toBe(0);
  });

  it("F-037: saving a budget below what's spent enqueues its budget.check at once", async () => {
    await seedSpend(3_000_000n);
    const saved = await setBudget(m4Deps(), adminScope, { projectId, monthlyMicroUsd: 2_000_000n });
    if (!saved.ok || saved.budgetId === null) throw new Error("the budget wasn't saved");
    const checks = await jobsNamed("budget.check", "budgetId", saved.budgetId);
    expect(checks.map((row) => `${String(row["month"])}:${String(row["threshold"])}`).sort()).toEqual([`${month()}:reached`, `${month()}:warn`]);
    // A budget well above the spend owes no notice.
    const roomy = await setBudget(m4Deps(), adminScope, { projectId: null, monthlyMicroUsd: 100_000_000n });
    if (!roomy.ok || roomy.budgetId === null) throw new Error("the budget wasn't saved");
    expect(await jobsNamed("budget.check", "budgetId", roomy.budgetId)).toEqual([]);
  });
});

describe("budget.release (F-037)", () => {
  it("F-037: a raise releases held turns in the order they were held", async () => {
    const budgetId = await seedBudget(projectId, 1);
    const first = await idleTask();
    const second = await idleTask();
    const third = await idleTask();
    await seedSpend(2_000_000n);
    const steersBefore = await steersInOrder();
    // Held in the order first, third, second.
    for (const [task, text] of [
      [first, "one"],
      [third, "two"],
      [second, "three"],
    ] as const) {
      expect(await message(task.taskId, text)).toMatchObject({ ok: true, held: true });
    }
    expect(await steersInOrder()).toEqual(steersBefore);

    const raised = await setBudget(m4Deps(), adminScope, { projectId, monthlyMicroUsd: 5_000_000n });
    expect(raised).toMatchObject({ ok: true, budgetId });
    expect(await jobsNamed("budget.release", "budgetId", budgetId)).toHaveLength(1);
    await release(budgetId);

    expect((await steersInOrder()).slice(steersBefore.length)).toEqual(["one", "two", "three"]);
    const held = await test.db.heldTurn.findMany({ where: { budgetId } });
    expect(held.every((row) => row.releasedAt !== null)).toBe(true);
    for (const task of [first, second, third]) {
      expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "turn.released" } })).toBe(1);
    }
    // A replayed release finds nothing more to let go.
    await release(budgetId);
    expect((await steersInOrder()).slice(steersBefore.length)).toHaveLength(3);
  });

  it("F-037: a raise that's still below the spend releases nothing", async () => {
    const budgetId = await seedBudget(projectId, 1);
    const task = await idleTask();
    await seedSpend(3_000_000n);
    expect(await message(task.taskId, "held still")).toMatchObject({ ok: true, held: true });
    const steersBefore = await steersInOrder();
    expect(await setBudget(m4Deps(), adminScope, { projectId, monthlyMicroUsd: 2_000_000n })).toMatchObject({ ok: true });
    expect(await jobsNamed("budget.release", "budgetId", budgetId)).toEqual([]);
    // Even run by hand, the gate still holds it.
    await release(budgetId);
    expect(await steersInOrder()).toEqual(steersBefore);
    expect(await test.db.heldTurn.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ releasedAt: null });
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "turn.released" } })).toBe(0);
  });

  it("F-037: a new month releases them all: a held message, a held reopen and a new task waiting at the gate", async () => {
    const budgetId = await seedBudget(projectId, 1);
    const talking = await idleTask();
    const reopening = await idleTask();
    await seedSpend(2_000_000n);
    expect(await message(talking.taskId, "next month")).toMatchObject({ ok: true, held: true });
    const ports = { jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock };
    expect((await test.db.$transaction((tx) => stopTask({ tx, scope: memberScope, ...ports }, { taskId: reopening.taskId }))).ok).toBe(true);
    const reopened = await test.db.$transaction((tx) =>
      reopenTask({ tx, scope: memberScope, ...ports }, { taskId: reopening.taskId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: "again" }),
    );
    expect(reopened).toMatchObject({ ok: true, held: true });
    const fresh = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    const freshRow = await test.db.task.findUniqueOrThrow({ where: { id: fresh.taskId } });
    const offered = await test.db.$transaction((tx) =>
      dispatchTask(
        { tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock },
        { organizationId, taskId: fresh.taskId, sessionId: fresh.sessionId, leaseEpoch: leaseEpochSchema.parse(freshRow.leaseEpoch + 1) },
      ),
    );
    expect(offered).toMatchObject({ ok: false, message: "budget-reached" });
    const dispatchesBefore = {
      reopening: (await jobsNamed("task.dispatch", "taskId", reopening.taskId)).length,
      fresh: (await jobsNamed("task.dispatch", "taskId", fresh.taskId)).length,
    };
    const steersBefore = await steersInOrder();

    // The 1st of next month, 00:05 UTC: the schedule enqueues a release per budget, which runs then.
    const now = new Date();
    const nextMonth = clockAt(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 5));
    await budgetNewMonthHandler(budgetDeps(nextMonth))(jobContext("budget.new-month", {}, logger));
    expect(await jobsNamed("budget.release", "budgetId", budgetId)).toHaveLength(1);
    await release(budgetId, nextMonth);

    expect(await test.db.heldTurn.count({ where: { budgetId, releasedAt: null } })).toBe(0);
    expect((await steersInOrder()).slice(steersBefore.length)).toEqual(["next month"]);
    expect((await jobsNamed("task.dispatch", "taskId", reopening.taskId)).length).toBe(dispatchesBefore.reopening + 1);
    expect(dispatchWaitFromDb((await test.db.task.findUniqueOrThrow({ where: { id: reopening.taskId } })).dispatchWait)).toBeNull();
    // The new task held no turn: it's offered to the scheduler again.
    expect((await jobsNamed("task.dispatch", "taskId", fresh.taskId)).length).toBe(dispatchesBefore.fresh + 1);
  });
});

describe("the new month's schedule (F-037)", () => {
  it("F-037: core schedules the new month's release for 00:05 UTC on the 1st", async () => {
    await ensureBudgetNewMonthSchedule(jobs);
    const rows = z.array(z.object({ cron: z.string(), timezone: z.string().nullable() })).parse(await test.db.$queryRaw`SELECT cron, timezone FROM pgboss.schedule WHERE name = 'budget.new-month'`);
    expect(rows.map((row) => row.cron)).toEqual(["5 0 1 * *"]);
    expect(rows.every((row) => row.timezone === null || row.timezone === "UTC")).toBe(true);
  });
});

describe("the budget mails (F-115)", () => {
  const projectName = async () => (await test.db.project.findUniqueOrThrow({ where: { id: projectId } })).name;

  it("F-115, F-037: the budget warning renders and goes through Resend's fake, to the admins of the budget, linking to Spend", async () => {
    const deps = notifyDeps();
    expect(await saveEmailSettings(deps, instanceAdmin(), { provider: "resend", fromAddress: "ostra@mail.example", fromName: "ostra", apiKey: resend.apiKey })).toMatchObject({ ok: true });
    const before = resend.received.length;
    const budgetId = await seedBudget(projectId, 100);
    await seedSpend(85_000_000n);
    await check(budgetId, "warn");
    await deliverQueued(deps);
    const mails = resend.received.slice(before);
    const name = await projectName();
    const addresses = await Promise.all([fixture.a.admin, fixture.a.insider].map(async (member) => (await test.db.user.findUniqueOrThrow({ where: { id: member.userId } })).email));
    expect(mails.flatMap((mail) => mail.to).sort()).toEqual([...addresses].sort());
    for (const mail of mails) {
      expect(mail.subject).toBe(`${name} is at 85% of its budget`);
      expect(mail.text).toContain(`$85.00 of its $100.00 budget for`);
      expect(mail.text).toContain(`Open Spend: ${PUBLIC_URL}/organization/spend?project=${projectId}`);
      expect(mail.html).toContain(`${PUBLIC_URL}/organization/spend?project=${projectId}`);
    }
    const deliveries = (await budgetNotifications("budget_warning")).flatMap((row) => row.deliveries);
    expect(deliveries.filter((row) => row.channel === "email").every((row) => row.state === "sent" && row.adapter === "resend")).toBe(true);
    expect(deliveries.filter((row) => row.channel === "panel").every((row) => row.state === "sent")).toBe(true);
    deps.close();
  });

  it("F-115: the budget reached mail renders and goes through SMTP's fake, with its Raise the budget button", async () => {
    const deps = notifyDeps();
    expect(
      await saveEmailSettings(deps, instanceAdmin(), {
        provider: "smtp",
        fromAddress: "ostra@mail.example",
        fromName: "ostra",
        host: "127.0.0.1",
        port: smtp.port,
        secure: "starttls",
        user: "ostra",
        password: "relay-password",
      }),
    ).toMatchObject({ ok: true });
    const before = smtp.received.length;
    const budgetId = await seedBudget(null, 10);
    await seedSpend(12_000_000n);
    await check(budgetId, "reached");
    await deliverQueued(deps);
    const mails = smtp.received.slice(before);
    const organization = await test.db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ tls: true, user: "ostra" });
    expect(mails[0]?.data).toContain(`${organization.name} reached its budget`);
    expect(mails[0]?.data).toContain("Raise the budget");
    expect((await budgetNotifications("budget_reached"))[0]?.deliveries.find((row) => row.channel === "email")).toMatchObject({ state: "sent", adapter: "smtp" });
    deps.close();
  });
});
