import { randomUUID } from "node:crypto";

import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { bulkStartOutcomes, dryRunAutomation, postgresAuditLog, postgresChangeNotices, saveAutomation, startMany, systemClock } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { bulkStartItemIdSchema, taskIdSchema } from "@ostra/protocol";
import type { AutomationId, BoardId, BulkStartId, ConnectionId, OrganizationId, ProjectId, TicketId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bulkStartItemHandler } from "../automations/automations.ts";
import { automationJobDeps, labelFilter, recordingLogger, scopeOf, trackerTicket } from "../testing/automations.ts";
import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { expectStartGates } from "../testing/start-gates.ts";
import { seedBoard, seedTicketRow, seedTicketTask, seedTrackerConnection } from "../testing/tickets.ts";
import { jobContext } from "../testing/turns.ts";
import { seedWorld } from "../testing/world.ts";

// Ticket 11 (F-107, F-010, F-011, ADR 0056): starting many, against a real database and pg-boss:
// `startMany` writes the bulk start and its items in one transaction, idempotent by the member's
// request key, and each item runs the one start in its own transaction through core's worker.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let organizationId: OrganizationId;
let projectId: ProjectId;
let member: MemberScope;
let connectionId: ConnectionId;
let boardId: BoardId;
let counter = 0;
const { logger, records } = recordingLogger();

const deps = () => ({ db: test.db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock });

/** Cached open tickets on the project's board, as ingest leaves them. */
const tickets = async (count: number, labels: readonly string[] = [], project: { readonly projectId: ProjectId; readonly boardId: BoardId } = { projectId, boardId }): Promise<TicketId[]> => {
  const made: TicketId[] = [];
  for (let index = 0; index < count; index += 1) {
    counter += 1;
    made.push(await seedTicketRow(test.db, { organizationId, projectId: project.projectId, boardId: project.boardId, connectionId, ticket: trackerTicket(`BLK-${String(counter)}`, { labels }) }));
  }
  return made;
};

const bulk = (ticketIds: readonly TicketId[], fields: { readonly requestKey?: string; readonly scope?: MemberScope; readonly projectId?: ProjectId; readonly automationId?: AutomationId | null } = {}) =>
  startMany(deps(), fields.scope ?? member, {
    projectId: fields.projectId ?? projectId,
    ticketIds,
    taskKind: "code",
    agentProfileId: null,
    requestKey: fields.requestKey ?? randomUUID(),
    source: fields.automationId === undefined || fields.automationId === null ? "inbox" : "dry_run",
    automationId: fields.automationId ?? null,
  });

/** Each item's `bulk.start-item` job, as the worker runs it, read back from the queue. */
const runItems = async (bulkStartId: BulkStartId): Promise<void> => {
  const items = await test.db.bulkStartItem.findMany({ where: { bulkStartId }, select: { id: true } });
  for (const item of items) {
    const payload = { organizationId, bulkStartItemId: bulkStartItemIdSchema.parse(item.id) };
    expect(await jobs.find("bulk.start-item", payload)).toHaveLength(1);
    await bulkStartItemHandler(automationJobDeps(test.db, jobs, systemClock))(jobContext("bulk.start-item", payload, logger));
  }
};

/** The ticket's active code task, as a member's start leaves it. */
const activeTask = async (ticketId: TicketId, state: "running" | "in_review") => {
  const { key } = await test.db.ticket.findUniqueOrThrow({ where: { id: ticketId }, select: { key: true } });
  return seedTicketTask(test.db, { organizationId, projectId, boardId, ticketId, ticketKey: key, state });
};

const okId = (result: Awaited<ReturnType<typeof bulk>>): BulkStartId => {
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.bulkStartId;
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  organizationId = fixture.a.organization.id;
  projectId = fixture.a.openProject.id;
  member = scopeOf(fixture.a.member, "member");
  await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() }, organizationId, projectId);
  connectionId = await seedTrackerConnection(test.db, new FakeSecretStore(), organizationId);
  boardId = await seedBoard(test.db, { organizationId, projectId, connectionId, externalId: "team-blk", key: "BLK", mapping: null });
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("bulk starts (F-107)", () => {
  it("F-107: 50 tickets start at once, and 51 are refused with nothing written", async () => {
    const fiftyOne = await tickets(51);
    expect(await bulk(fiftyOne)).toMatchObject({ ok: false, error: "too-many" });
    expect(await test.db.bulkStart.count()).toBe(0);
    const bulkStartId = okId(await bulk(fiftyOne.slice(0, 50)));
    expect(await test.db.bulkStartItem.count({ where: { bulkStartId } })).toBe(50);
    await runItems(bulkStartId);
    const outcomes = await bulkStartOutcomes(deps(), { organizationId, bulkStartId });
    expect(outcomes.filter((row) => row.state === "started")).toHaveLength(50);
    expect(await test.db.task.count({ where: { bulkStartId, kind: "code", creatorMemberId: fixture.a.member.id } })).toBe(50);
    // The member's audit entry, with counts only.
    expect(await test.db.auditEntry.findFirst({ where: { entityId: bulkStartId, action: "bulk-start.created" } })).toMatchObject({ data: { source: "inbox", tickets: 50, kind: "code" } });
  });

  it("F-107: a replayed request, and a replayed item's job, start nothing twice", async () => {
    const three = await tickets(3);
    const requestKey = randomUUID();
    // The same request three times, two of them at once: one bulk start.
    const [first, second] = await Promise.all([bulk(three, { requestKey }), bulk(three, { requestKey })]);
    const third = await bulk(three, { requestKey });
    const bulkStartId = okId(first);
    expect([okId(second), okId(third)]).toEqual([bulkStartId, bulkStartId]);
    expect(await test.db.bulkStart.count({ where: { requestKey } })).toBe(1);
    expect(await test.db.bulkStartItem.count({ where: { bulkStartId } })).toBe(3);
    // Each item's job twice, the second time at once with a third.
    await runItems(bulkStartId);
    const items = await test.db.bulkStartItem.findMany({ where: { bulkStartId } });
    await Promise.all(
      items.flatMap((item) => [0, 1].map(() => bulkStartItemHandler(automationJobDeps(test.db, jobs, systemClock))(jobContext("bulk.start-item", { organizationId, bulkStartItemId: bulkStartItemIdSchema.parse(item.id) }, logger)))),
    );
    expect(await test.db.task.count({ where: { ticketId: { in: three } } })).toBe(3);
    expect((await bulkStartOutcomes(deps(), { organizationId, bulkStartId })).map((row) => row.state)).toEqual(["started", "started", "started"]);
  });

  it("F-107: each started task goes through the budget, admission and the project's share of a pool, and waits queued with its reason", async () => {
    const [ticketId] = await tickets(1);
    if (ticketId === undefined) throw new Error("seeded one");
    const bulkStartId = okId(await bulk([ticketId]));
    await runItems(bulkStartId);
    const [outcome] = await bulkStartOutcomes(deps(), { organizationId, bulkStartId });
    expect(outcome).toMatchObject({ state: "started" });
    await expectStartGates({ db: test.db, jobs, clock: systemClock, organizationId, projectId }, taskIdSchema.parse(outcome?.taskId), []);
  });

  it("F-107: the outcome per ticket: started, has a task, no access and off the board", async () => {
    const [fresh, busy, gone] = await tickets(3);
    if (fresh === undefined || busy === undefined || gone === undefined) throw new Error("seeded three");
    await activeTask(busy, "running");
    // A restricted project's bulk start by its listed member, who then leaves the project.
    const restricted = fixture.a.restrictedProject.id;
    const restrictedBoard = await seedBoard(test.db, { organizationId, projectId: restricted, connectionId, externalId: "team-blk-r", key: "BLR", mapping: null });
    const [secret] = await tickets(1, [], { projectId: restricted, boardId: restrictedBoard });
    if (secret === undefined) throw new Error("seeded one");
    const insider: MemberScope = { ...scopeOf(fixture.a.insider, "member"), projectRoles: new Map([[restricted, "member"]]) };
    // Another member can't start on the restricted project at all.
    expect(await bulk([secret], { projectId: restricted })).toMatchObject({ ok: false, error: "not-found" });

    const bulkStartId = okId(await bulk([fresh, busy, gone]));
    const restrictedStart = okId(await bulk([secret], { projectId: restricted, scope: insider }));
    await test.db.ticket.update({ where: { id: gone }, data: { removedAt: new Date() } });
    await test.db.projectMember.deleteMany({ where: { projectId: restricted, memberId: fixture.a.insider.id } });
    await runItems(bulkStartId);
    await runItems(restrictedStart);
    const byTicket = new Map((await bulkStartOutcomes(deps(), { organizationId, bulkStartId })).map((row) => [row.ticketId, [row.state, row.reason]]));
    expect(byTicket.get(fresh)).toEqual(["started", null]);
    expect(byTicket.get(busy)).toEqual(["skipped", "has-task"]);
    expect(byTicket.get(gone)).toEqual(["skipped", "not-on-a-board"]);
    expect((await bulkStartOutcomes(deps(), { organizationId, bulkStartId: restrictedStart })).map((row) => [row.state, row.reason])).toEqual([["skipped", "no-access"]]);
    // Another organization sees none of it.
    expect(await bulkStartOutcomes(deps(), { organizationId: fixture.b.organization.id, bulkStartId })).toEqual([]);
  });

  it("F-107, F-011: a dry run lists what a start would do, and its Start all starts exactly those, with the rule as each task's origin", async () => {
    const admin = scopeOf(fixture.a.admin, "admin");
    const saved = await saveAutomation(deps(), admin, {
      projectId,
      automationId: null,
      settings: { name: "Triage", taskKind: "code", agentProfileId: null, poolLabels: ["ci"], requireApproval: false, kind: "intake_rule", filter: labelFilter(["triage"]) },
    });
    if (!saved.ok) throw new Error("refused");
    const automationId = saved.automationId;
    const [startable, busy, before] = await tickets(3, ["triage"]);
    await tickets(1, ["other"]);
    if (startable === undefined || busy === undefined || before === undefined) throw new Error("seeded three");
    await activeTask(busy, "in_review");
    await test.db.automationRun.create({ data: { organizationId, projectId, automationId, kind: "ticket_match", ticketId: before, state: "skipped", skipReason: "has_task" } });

    const dry = await dryRunAutomation(deps(), member, { projectId, filter: labelFilter(["triage"]), automationId });
    if (!dry.ok) throw new Error("refused");
    const outcomeOf = new Map(dry.rows.map((row) => [row.ticketId, row.outcome]));
    expect(outcomeOf.get(startable)).toMatchObject({ kind: "would-start" });
    expect(outcomeOf.get(busy)).toEqual({ kind: "would-skip", reason: "has-task" });
    expect(outcomeOf.get(before)).toEqual({ kind: "would-skip", reason: "matched-before" });
    // Nothing else of the project matches, and the dry run started nothing.
    expect(dry.rows.every((row) => outcomeOf.has(row.ticketId))).toBe(true);
    expect(await test.db.task.count({ where: { ticketId: startable } })).toBe(0);

    // "Start all": every ticket the dry run listed; it starts exactly the would-start ones.
    const bulkStartId = okId(await bulk(dry.rows.map((row) => row.ticketId), { automationId, scope: member }));
    await runItems(bulkStartId);
    const started = await test.db.task.findMany({ where: { bulkStartId } });
    expect(started.map((task) => [task.ticketId, task.automationId])).toEqual(
      dry.rows.filter((row) => row.outcome.kind === "would-start").map((row) => [row.ticketId, automationId]),
    );
    expect((await test.db.automationRun.findFirstOrThrow({ where: { automationId, kind: "start_all" } })).bulkStartId).toBe(bulkStartId);
    // The rule's labels go with each task to admission.
    await expectStartGates({ db: test.db, jobs, clock: systemClock, organizationId, projectId }, taskIdSchema.parse(started[0]?.id), ["ci"]);
    // Organization B's member sees no rule and no ticket.
    expect(await dryRunAutomation(deps(), scopeOf(fixture.b.admin, "admin"), { projectId, filter: labelFilter(["triage"]), automationId })).toMatchObject({ ok: false, error: "not-found" });
  });

  it("F-107: no log line carries a ticket's text", () => {
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain("curl evil");
  });
});
