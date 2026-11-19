import { randomUUID } from "node:crypto";

import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord, TrackerAdapter } from "@ostra/adapter-sdk";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import { LinearAdapter } from "@ostra/adapter-linear";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { keepWorking, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import type { M3Deps, MemberScope, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { connectionIdSchema, memberIdSchema, taskEventSchema, turnIdSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, ExternalTicketId, TicketKey } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { fanoutChangesOf } from "../testing/notify.ts";
import { mappingFor, seedBoard } from "../testing/tickets.ts";
import { acceptedTask } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { seedOnlineRunner, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import type { WebhookDeliveryContext } from "../webhooks/process.ts";
import { createConnectionTrackers } from "./connections.ts";
import type { TrackerBuildInput } from "./connections.ts";
import { trackerWebhookHandler } from "./ingest.ts";
import type { TrackerIngestDeps } from "./ingest.ts";

// Ticket 24 (F-066, Q181): a ticket closed while its task runs, through the real Linear adapter
// against the fake Linear server. Someone cancels the ticket mid-turn: the turn is interrupted once
// and one `ticket_closed` item is raised for the driver. "Keep working" sends "Carry on where you
// stopped.". A ticket closed after the task's PR merged does nothing.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let fake: FakeLinear;
let world: World;
let ingest: Ingest;
let liveText: LiveTextWriter;
let runner: RunnerRef;
let connectionId: ConnectionId;
let boardId: BoardId;
let person: LinearAdapter;
let deps: M3Deps;
let timers: SessionTimers;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));

const build = (input: TrackerBuildInput): TrackerAdapter =>
  new LinearAdapter({ auth: input.credentialKind === "api_key" ? { kind: "api-key", token: input.token } : { kind: "oauth", token: input.token }, apiUrl: fake.apiUrl }, input.context);

const ingestDeps = (): TrackerIngestDeps => ({
  db: test.db,
  trackers: createConnectionTrackers({ db: test.db, secretStore, clock: systemClock, logger, build }),
  notices: postgresChangeNotices,
  clock: systemClock,
  logger,
  closed: { jobs, outbox: postgresCommandOutbox, audit: postgresAuditLog },
});

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  fake = await createFakeLinear({ retryDelaysMs: [10, 10, 10] });
  const app = fake.createApp({ name: "ostra", redirectUris: ["https://ostra.example/api/linear/callback"], webhookUrl: null });
  const token = fake.mintToken("app");
  const organizationId = fixture.a.organization.id;
  const access = await secretStore.put({ organizationId, purpose: "linear-access-token" }, token.accessToken);
  if (!access.ok) throw new Error("the fake secret store refused");
  const row = await test.db.connection.create({
    data: {
      organizationId,
      kind: "linear",
      appId: app.clientId,
      state: "active",
      webhookMode: "webhooks",
      credentialKind: "app_oauth",
      accessTokenSecretRef: access.value,
      accessTokenExpiresAt: new Date(Date.now() + 24 * 3_600_000),
      appUserId: fake.appUser()?.id ?? null,
    },
  });
  connectionId = connectionIdSchema.parse(row.id);
  const reader = build({ kind: "linear", credentialKind: "app_oauth", token: token.accessToken, context: { logger: silentLogger, clock: systemClock } });
  const statuses = await reader.listStatuses({ externalId: fake.team.id });
  if (!statuses.ok) throw new Error(statuses.error.message);
  boardId = await seedBoard(test.db, { organizationId, projectId: fixture.a.openProject.id, connectionId, externalId: fake.team.id, key: "OST", mapping: mappingFor(statuses.value, "ostra") });
  // A person on the team: their change isn't ostra's own write.
  person = new LinearAdapter({ auth: { kind: "oauth", token: fake.mintToken("person").accessToken }, apiUrl: fake.apiUrl }, { logger: silentLogger, clock: systemClock });
  world = await seedWorld(test.db, { codeHost, secretStore }, organizationId, fixture.a.openProject.id);
  timers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox });
  deps = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() } };
  runner = await seedOnlineRunner(test.db, organizationId, { kind: "personal", memberId: fixture.a.member.id }, 20);
  await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { minor: 2 } });
});

afterAll(async () => {
  await liveText.stop();
  await fake.close();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const driver = (): MemberScope => ({ organizationId: fixture.a.organization.id, memberId: memberIdSchema.parse(fixture.a.member.id), role: "member", projectRoles: new Map() });

/** A webhook from Linear about the ticket, sent by `byUserId`, through the real handler. */
const hint = async (issueId: ExternalTicketId, byUserId: string) => {
  const body = fake.signedDelivery({ issueId, byUserId, sentAt: Date.now() }).rawBody;
  const context: WebhookDeliveryContext = {
    organizationId: fixture.a.organization.id,
    connectionId,
    deliveryId: webhookDeliveryIdSchema.parse(randomUUID()),
    event: "Issue.update",
    payload: JSON.parse(new TextDecoder().decode(body)),
    receivedAt: Date.now(),
    logger,
  };
  return trackerWebhookHandler(ingestDeps())(context);
};

const stateOf = (type: "canceled" | "completed"): string => {
  const state = fake.states(fake.team.id).find((candidate) => candidate.type === type);
  if (state === undefined) throw new Error(`no ${type} state`);
  return state.id;
};

/** A ticket on the board, cached, and a running code task on it whose first turn started. */
const runningTicketTask = async (title: string): Promise<{ readonly task: DrivenTask; readonly issue: { readonly id: ExternalTicketId; readonly identifier: TicketKey } }> => {
  const issue = await fake.createIssue({ title });
  await hint(issue.id, fake.admin.id);
  const ticket = await test.db.ticket.findFirstOrThrow({ where: { boardId, externalId: issue.id } });
  const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner);
  await test.db.task.update({ where: { id: task.taskId }, data: { source: "ticket", ticketId: ticket.id, ticketKey: issue.identifier, boardId } });
  await task.send({ kind: "turn.started", turnId: turnIdSchema.parse("turn-1") });
  return { task, issue };
};

describe("a ticket closed while its task runs (F-066)", () => {
  it("F-066: a ticket cancelled mid-turn interrupts once and raises one item; Keep working carries on", async () => {
    const { task, issue } = await runningTicketTask("Cancelled while running");
    const moved = await person.updateStatus({ externalId: fake.team.id }, issue.identifier, stateOf("canceled"));
    expect(moved.ok).toBe(true);
    expect(await hint(issue.id, fake.admin.id)).toMatchObject({ outcome: "processed" });
    // The same change delivered again: nothing more.
    await hint(issue.id, fake.admin.id);
    const interrupts = await test.db.command.findMany({ where: { taskId: task.taskId, kind: "interrupt" } });
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]?.body).toMatchObject({ sessionId: task.sessionId });
    const items = await test.db.needsYouItem.findMany({ where: { taskId: task.taskId, reason: "ticket_closed" } });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: "open", audience: "driver" });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "needs_you", needsYouReason: "ticket_closed" });
    const closed = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "ticket.closed" } });
    expect(closed.payload).toMatchObject({ category: "cancelled" });
    // The item fans out (F-036).
    expect(await fanoutChangesOf(test.db, items[0]?.id ?? "")).toEqual(["created"]);

    // The turn ends (the runner saved its work); "Keep working" sends the carry-on line.
    await task.send({ kind: "turn.ended", turnId: turnIdSchema.parse("turn-1"), stopReason: "cancelled" });
    const kept = await keepWorking(deps, {}, driver(), { taskId: task.taskId });
    expect(kept).toMatchObject({ ok: true, delivery: "steer" });
    const messages = (await test.db.event.findMany({ where: { taskId: task.taskId, kind: "user.message" } })).flatMap((row) => {
      const parsed = taskEventSchema.safeParse(row.payload);
      return parsed.success && parsed.data.kind === "user.message" ? [parsed.data] : [];
    });
    expect(messages.map((message) => [message.intent, message.text])).toEqual([["keep-working", "Carry on where you stopped."]]);
    expect(await test.db.needsYouItem.findFirstOrThrow({ where: { id: items[0]?.id ?? "" } })).toMatchObject({ state: "dismissed" });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("running");
    // Pressed again: the task isn't waiting on its ticket any more.
    expect(await keepWorking(deps, {}, driver(), { taskId: task.taskId })).toMatchObject({ ok: false, error: "not-waiting" });
  });

  it("F-066: a ticket closed after the task's PR merged does nothing", async () => {
    const { task, issue } = await runningTicketTask("Closed after the merge");
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "merged", subState: null } });
    await person.updateStatus({ externalId: fake.team.id }, issue.identifier, stateOf("completed"));
    await hint(issue.id, fake.admin.id);
    expect(await test.db.command.count({ where: { taskId: task.taskId, kind: "interrupt" } })).toBe(0);
    expect(await test.db.needsYouItem.count({ where: { taskId: task.taskId, reason: "ticket_closed" } })).toBe(0);
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "ticket.closed" } })).toBe(0);
  });

  it("F-066: ostra's own move of the ticket to done is never a close while running", async () => {
    const { task, issue } = await runningTicketTask("Moved by ostra itself");
    await person.updateStatus({ externalId: fake.team.id }, issue.identifier, stateOf("completed"));
    // The app's own user sent it: an echo of ostra's write.
    expect(await hint(issue.id, fake.appUser()?.id ?? "")).toMatchObject({ outcome: "ignored" });
    expect(await test.db.command.count({ where: { taskId: task.taskId, kind: "interrupt" } })).toBe(0);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("running");
  });
});
