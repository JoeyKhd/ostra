import { randomUUID } from "node:crypto";

import { createLogger, silentLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { LogRecord, TrackerAdapter } from "@ostra/adapter-sdk";
import { createFakeLinear, createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import type { FakeLinear, JiraSite } from "@ostra/adapter-sdk/testing";
import { LinearAdapter } from "@ostra/adapter-linear";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  isProgressComment,
  PARENT_COMMENT_MARKER,
  parentCommentKey,
  postgresAuditLog,
  postgresChangeNotices,
  recordTicketProgressInTx,
  startSubIssues,
  startTask,
  startTicketTask,
  systemClock,
} from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { automationIdSchema, connectionIdSchema, externalTicketIdSchema, sessionIdSchema, taskIdSchema, ticketIdSchema, ticketWriteIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, ExternalTicketId, OrganizationId, ProjectId, TicketId, TicketKey } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBlobService } from "../blobs/blob-service.ts";
import { HOSTILE_TEXT, scopeOf } from "../testing/automations.ts";
import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { mappingFor, seedBoard } from "../testing/tickets.ts";
import { jobContext } from "../testing/turns.ts";
import { seedWorld } from "../testing/world.ts";
import { createConnectionTrackers } from "../tracker/connections.ts";
import type { TrackerBuildInput } from "../tracker/connections.ts";
import { fetchContextHandler } from "../tracker/context.ts";
import { pollBoard } from "../tracker/ingest.ts";
import { ticketSyncHandler } from "../tracker/writer.ts";
import { trackerForConnections } from "./sub-issues.ts";

// Ticket 12 (F-077, F-031, ADR 0056): a code start on a parent ticket starts one task per leaf of
// its tree, through Linear's adapter on the fake Linear server and the Jira fake's sub-tasks,
// against a real database. The parent's progress comment goes through milestone 2's tracker writer.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let fake: FakeLinear;
let site: JiraSite;
let organizationId: OrganizationId;
let projectId: ProjectId;
let member: MemberScope;
let linearConnection: ConnectionId;
let jiraConnection: ConnectionId;
let boardId: BoardId;
let jiraBoardId: BoardId;
let otherTeamId: string;
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const PUBLIC_URL = "https://ostra.example";

/** Each connection's adapter: Linear's on the fake server, or the Jira fake. */
const build = (input: TrackerBuildInput): TrackerAdapter =>
  input.token.startsWith("jira:") ? new JiraFakeAdapter({ site }, input.context) : new LinearAdapter({ auth: { kind: "oauth", token: input.token }, apiUrl: fake.apiUrl }, input.context);
const trackers = () => createConnectionTrackers({ db: test.db, secretStore, clock: systemClock, logger, build });
const deps = () => ({ db: test.db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, publicUrl: PUBLIC_URL, trackerFor: trackerForConnections(trackers()) });

const linearIssue = async (title: string, fields: { readonly parentId?: string; readonly teamId?: string } = {}): Promise<{ readonly id: ExternalTicketId; readonly identifier: TicketKey }> =>
  fake.createIssue({ title: `${title}: ${HOSTILE_TEXT}`, description: HOSTILE_TEXT, ...fields });

const cachedId = async (externalId: string, board: BoardId = boardId): Promise<TicketId> =>
  ticketIdSchema.parse((await test.db.ticket.findUniqueOrThrow({ where: { boardId_externalId: { boardId: board, externalId: externalTicketIdSchema.parse(externalId) } } })).id);

const seedConnection = async (token: string, appUserId: string | null, organization: OrganizationId = organizationId): Promise<ConnectionId> => {
  const ref = await secretStore.put({ organizationId: organization, purpose: "linear.access-token" }, token);
  if (!ref.ok) throw new Error("the fake secret store refused");
  const row = await test.db.connection.create({
    data: { organizationId: organization, kind: "linear", appId: `app-${token.slice(0, 8)}`, state: "active", webhookMode: "polling", credentialKind: "app_oauth", accessTokenSecretRef: ref.value, appUserId },
  });
  return connectionIdSchema.parse(row.id);
};

/** Applies every pending write to `ticketId` through `ticket.sync`, as the queue would, oldest first. */
const syncWritesTo = async (ticketId: TicketId): Promise<void> => {
  const handler = ticketSyncHandler({ db: test.db, trackers: trackers(), clock: systemClock, publicUrl: PUBLIC_URL, logger });
  for (let round = 0; round < 3; round += 1) {
    const pending = await test.db.ticketWrite.findMany({ where: { ticketId, state: "pending" }, orderBy: { createdAt: "asc" } });
    for (const row of pending) {
      await handler(jobContext("ticket.sync", { organizationId, ticketWriteId: ticketWriteIdSchema.parse(row.id) }, logger)).catch(() => undefined);
    }
  }
};

/** The parent's comment: ostra's, by its marker (the parent's refine task keeps a progress comment of its own). */
const ostraCommentsOn = (externalId: ExternalTicketId) =>
  fake.issueView(externalId).comments.filter((comment) => isProgressComment(comment.body) && comment.body.includes(PARENT_COMMENT_MARKER));

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  organizationId = fixture.a.organization.id;
  projectId = fixture.a.openProject.id;
  member = scopeOf(fixture.a.member, "member");
  await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore }, organizationId, projectId);
  fake = await createFakeLinear({ retryDelaysMs: [10, 10, 10] });
  fake.createApp({ name: "ostra", redirectUris: ["https://ostra.example/api/linear/callback"], webhookUrl: null });
  const token = fake.mintToken("app");
  linearConnection = await seedConnection(token.accessToken, fake.appUser()?.id ?? null);
  const adapter = new LinearAdapter({ auth: { kind: "oauth", token: token.accessToken }, apiUrl: fake.apiUrl }, { logger: silentLogger, clock: adapterClock });
  const statuses = await adapter.listStatuses({ externalId: fake.team.id });
  if (!statuses.ok) throw new Error(statuses.error.message);
  boardId = await seedBoard(test.db, { organizationId, projectId, connectionId: linearConnection, externalId: fake.team.id, key: "OST", mapping: mappingFor(statuses.value, "ostra") });
  // Another team, which no board of the project holds.
  otherTeamId = fake.addTeam("ELS", "Elsewhere").id;
  // The Jira fake, on organization B (one tracker connection per organization).
  site = createJiraSite({ projectKey: "JIR" });
  const orgB = fixture.b.organization.id;
  await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore }, orgB, fixture.b.project.id, { fullName: "ostra-test/test2" });
  jiraConnection = await seedConnection(`jira:${String(Date.now())}`, null, orgB);
  const jiraStatuses = await new JiraFakeAdapter({ site }).listStatuses({ externalId: site.projects[0]?.id ?? "" });
  if (!jiraStatuses.ok) throw new Error(jiraStatuses.error.message);
  jiraBoardId = await seedBoard(test.db, { organizationId: orgB, projectId: fixture.b.project.id, connectionId: jiraConnection, externalId: site.projects[0]?.id ?? "", key: "JIR", mapping: mappingFor(jiraStatuses.value, "ostra") });
});

afterAll(async () => {
  await fake.close();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("sub-issues (F-077)", () => {
  let parent: { readonly id: ExternalTicketId; readonly identifier: TicketKey };
  let parentTicketId: TicketId;
  const keys: Record<string, string> = {};

  it("F-077: a code start on a three-level tree starts only its leaves; a child elsewhere is listed and skipped", async () => {
    // P ─ A (leaf), B ─ B1 (leaf), B2 ─ B2a (leaf, the third level); C closed; D on another team; E made after the poll.
    parent = await linearIssue("Parent");
    const a = await linearIssue("A", { parentId: parent.id });
    const b = await linearIssue("B", { parentId: parent.id });
    const b1 = await linearIssue("B1", { parentId: b.id });
    const b2 = await linearIssue("B2", { parentId: b.id });
    const b2a = await linearIssue("B2a", { parentId: b2.id });
    const c = await linearIssue("C", { parentId: parent.id });
    const d = await linearIssue("D", { parentId: parent.id, teamId: otherTeamId });
    Object.assign(keys, { a: a.identifier, b: b.identifier, b1: b1.identifier, b2: b2.identifier, b2a: b2a.identifier, c: c.identifier, d: d.identifier });
    const linear = new LinearAdapter({ auth: { kind: "oauth", token: fake.mintToken("app").accessToken }, apiUrl: fake.apiUrl }, { logger: silentLogger, clock: adapterClock });
    const done = fake.states(fake.team.id).find((state) => state.type === "completed");
    if (done === undefined) throw new Error("no done state");
    const closed = await linear.updateStatus({ externalId: fake.team.id }, c.identifier, done.id);
    expect(closed.ok).toBe(true);
    // The board's poll caches the team's tickets; E comes after it, so the start reads it first.
    await pollBoard({ db: test.db, trackers: trackers(), notices: postgresChangeNotices, clock: systemClock, logger }, { organizationId, boardId });
    const e = await linearIssue("E", { parentId: parent.id });
    keys["e"] = e.identifier;
    parentTicketId = await cachedId(parent.id);

    const result = await startSubIssues(deps(), member, { projectId, ticketId: parentTicketId, agentProfileId: null });
    if (!result.ok) throw new Error(result.message);
    expect(result.leaves).toMatchObject({ ok: true, skipped: [{ key: d.identifier, reason: "not-on-a-board" }] });
    expect(result.outcomes.map((outcome) => [outcome.key, outcome.state]).sort()).toEqual(
      [a.identifier, b1.identifier, b2a.identifier, e.identifier].map((key) => [key, "started"]).sort(),
    );
    const tasks = await test.db.task.findMany({ where: { parentTicketId }, select: { ticketKey: true, kind: true, creatorMemberId: true, origin: true } });
    expect(tasks.map((task) => task.ticketKey).sort()).toEqual([a.identifier, b1.identifier, b2a.identifier, e.identifier].sort());
    expect(tasks.every((task) => task.kind === "code" && task.creatorMemberId === fixture.a.member.id && task.origin === "member")).toBe(true);
    // E, not cached before, was read and cached on the board; D, on no board of the project, wasn't started.
    expect(await cachedId(e.id)).toBeTruthy();
    expect(await test.db.task.count({ where: { ticketKey: { in: [parent.identifier, b.identifier, b2.identifier, c.identifier, d.identifier] } } })).toBe(0);
    // Asking again starts nothing twice.
    const again = await startSubIssues(deps(), member, { projectId, ticketId: parentTicketId, agentProfileId: null });
    expect(again.ok && again.outcomes.every((outcome) => outcome.state === "skipped")).toBe(true);
    expect(await test.db.task.count({ where: { parentTicketId } })).toBe(4);
  });

  it("F-077: the parent never gets a code task, by a member's start or a rule's; a refine start refines the parent itself", async () => {
    const refused = await test.db.$transaction((tx) => startTicketTask({ tx, scope: member, publicUrl: PUBLIC_URL, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock }, { projectId, ticketId: parentTicketId }));
    expect(refused).toMatchObject({ ok: false, error: "has-sub-issues" });
    const byRule = await test.db.$transaction((tx) =>
      startTask(
        { tx, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock },
        { organizationId, projectId, origin: { kind: "intake-rule", automationId: automationIdSchema.parse(randomUUID()), requireApproval: false }, kind: "code", ticketId: parentTicketId, prompt: null, title: null, agentProfileId: null, poolLabels: [] },
      ),
    );
    expect(byRule).toMatchObject({ ok: false, error: "has-sub-issues" });
    expect(await test.db.task.count({ where: { ticketId: parentTicketId, kind: "code" } })).toBe(0);
    const refine = await test.db.$transaction((tx) =>
      startTask(
        { tx, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, scope: member, publicUrl: PUBLIC_URL },
        { organizationId, projectId, origin: { kind: "member", memberId: member.memberId }, kind: "refine", ticketId: parentTicketId, prompt: null, title: null, agentProfileId: null, poolLabels: [] },
      ),
    );
    expect(refine).toMatchObject({ ok: true });
    expect(await test.db.task.count({ where: { ticketId: parentTicketId, kind: "refine" } })).toBe(1);
  });

  it("F-077: more than 50 leaves start nothing, and the caller gets the count", async () => {
    const big = await linearIssue("Big parent");
    for (let index = 0; index < 51; index += 1) {
      await linearIssue(`Leaf ${String(index)}`, { parentId: big.id });
    }
    await pollBoard({ db: test.db, trackers: trackers(), notices: postgresChangeNotices, clock: systemClock, logger }, { organizationId, boardId });
    const bigId = await cachedId(big.id);
    const result = await startSubIssues(deps(), member, { projectId, ticketId: bigId, agentProfileId: null });
    expect(result).toMatchObject({ ok: true, bulkStartId: null, leaves: { ok: false, reason: "over-limit", count: 51, max: 50 }, outcomes: [] });
    expect(await test.db.task.count({ where: { parentTicketId: bigId } })).toBe(0);
  });

  it("F-077, F-031: the parent's one progress comment lists each child, and is edited, not posted again, as they move", async () => {
    await syncWritesTo(parentTicketId);
    const [first] = ostraCommentsOn(parent.id);
    expect(ostraCommentsOn(parent.id)).toHaveLength(1);
    for (const key of [keys["a"], keys["b1"], keys["b2a"], keys["e"]]) {
      expect(first?.body).toContain(`${key ?? "?"}: queued`);
    }
    expect(first?.body).not.toContain("curl evil");
    // A child moves: its own progress edit, and its parent's.
    const child = await test.db.task.findFirstOrThrow({ where: { parentTicketId, ticketKey: keys["a"] ?? "" } });
    await test.db.task.update({ where: { id: child.id }, data: { state: "running" } });
    await test.db.$transaction((tx) => recordTicketProgressInTx(tx, taskIdSchema.parse(child.id), "running"));
    await syncWritesTo(parentTicketId);
    const comments = ostraCommentsOn(parent.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe(first?.id);
    expect(comments[0]?.body).toContain(`${keys["a"] ?? "?"}: working`);
    // One comment row for the parent, ever, and the edits keyed per child and change.
    expect(await test.db.ticketWrite.count({ where: { idempotencyKey: parentCommentKey(parentTicketId) } })).toBe(1);
    expect(await test.db.ticketWrite.count({ where: { ticketId: parentTicketId, state: { not: "done" } } })).toBe(0);
  });

  it("F-077: a child's prompt holds its own ticket and its parent's accepted acceptance criteria", async () => {
    const refineTask = await test.db.task.findFirstOrThrow({ where: { ticketId: parentTicketId, kind: "refine" } });
    await test.db.refineDraft.create({
      data: { organizationId, projectId, taskId: refineTask.id, version: 1, description: "The split", acceptanceCriteria: ["The login page loads in 1 s", "Errors show inline"], source: "agent", appliedAt: new Date() },
    });
    const child = await test.db.task.findFirstOrThrow({ where: { parentTicketId, ticketKey: keys["b1"] ?? "" }, include: { sessions: true } });
    const blobs = createBlobService({ db: test.db, settings: { kind: "postgres", maxBytes: 1024 * 1024 }, context: { logger, clock: adapterClock } });
    await fetchContextHandler({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, trackers: trackers(), blobs, logger })(
      jobContext("ticket.fetch-context", { organizationId, taskId: taskIdSchema.parse(child.id), sessionId: sessionIdSchema.parse(child.sessions[0]?.id) }, logger),
    );
    const prompt = (await test.db.task.findUniqueOrThrow({ where: { id: child.id } })).prompt ?? "";
    expect(prompt).toContain(keys["b1"] ?? "?");
    expect(prompt).toContain("The parent ticket's acceptance criteria");
    expect(prompt).toContain("The login page loads in 1 s");
    expect(prompt).toContain("Errors show inline");
  });

  it("F-077: the Jira fake's sub-tasks start the same way", async () => {
    const project = site.projects[0]?.id ?? "";
    const jiraParent = site.createIssue(project, { summary: "A Jira parent" });
    const subtasks = [site.createIssue(project, { summary: "Sub-task one" }), site.createIssue(project, { summary: "Sub-task two" })];
    for (const subtask of subtasks) {
      const row = site.issues.get(subtask.externalId);
      if (row === undefined) throw new Error("no issue");
      row.parentId = jiraParent.externalId;
    }
    const orgB = fixture.b.organization.id;
    const projectB = fixture.b.project.id;
    const jiraTicket = await test.db.ticket.create({
      data: {
        organizationId: orgB,
        projectId: projectB,
        boardId: jiraBoardId,
        connectionId: jiraConnection,
        externalId: jiraParent.externalId,
        key: jiraParent.key,
        title: "A Jira parent",
        url: `https://jira-fake.invalid/browse/${jiraParent.key}`,
        trackerUpdatedAt: new Date(),
      },
    });
    const adminB = scopeOf(fixture.b.admin, "admin");
    const result = await startSubIssues(deps(), adminB, { projectId: projectB, ticketId: ticketIdSchema.parse(jiraTicket.id), agentProfileId: null });
    if (!result.ok) throw new Error(result.message);
    expect(result.outcomes.map((outcome) => [outcome.key, outcome.state]).sort()).toEqual(subtasks.map((subtask) => [subtask.key, "started"]).sort());
    expect(await test.db.task.count({ where: { parentTicketId: jiraTicket.id, boardId: jiraBoardId } })).toBe(2);
    // Organization A's member sees none of organization B's.
    expect(await startSubIssues(deps(), member, { projectId: projectB, ticketId: ticketIdSchema.parse(jiraTicket.id), agentProfileId: null })).toMatchObject({ ok: false, error: "not-found" });
    expect(JSON.stringify(records)).not.toContain("curl evil");
  });
});

