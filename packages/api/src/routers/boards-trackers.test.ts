import { randomUUID } from "node:crypto";

import type { TrackerAdapter } from "@ostra/adapter-sdk";
import { createFakeLinear, createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import type { FakeLinear, JiraSite } from "@ostra/adapter-sdk/testing";
import { LinearAdapter } from "@ostra/adapter-linear";
import type { BoardMapping } from "@ostra/domain";
import { connectionIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, ProjectId, TicketId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedProject, seedTicket } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 11, ticket 10 (F-152/c4, F-152/c5, F-008/c5, F-008/c7; ADR 0071): a project's boards
// from any of the organization's tracker connections, each through its own connection, and every
// ticket the panel shows naming its tracker. On Postgres, with two workspaces of the fake Linear
// and the Jira fake behind two connections (two sites that both have a project with the same ID,
// one of them without workflow access), beside a pending and a failed connection. Each
// connection gets an adapter of its own, so a call through the wrong one would read the wrong site.

let harness: ApiHarness;
let projectId: ProjectId;
let linearA: FakeLinear;
let linearB: FakeLinear;
let site: JiraSite;
let jiraProject: string;
const ids: Record<"acme" | "initech" | "globex" | "umbrella" | "pending" | "failed", ConnectionId> = {
  acme: connectionIdSchema.parse(randomUUID()),
  initech: connectionIdSchema.parse(randomUUID()),
  globex: connectionIdSchema.parse(randomUUID()),
  umbrella: connectionIdSchema.parse(randomUUID()),
  pending: connectionIdSchema.parse(randomUUID()),
  failed: connectionIdSchema.parse(randomUUID()),
};
const boards: { acme?: BoardId; globex?: BoardId; umbrella?: BoardId } = {};

const admin = () => harness.as(harness.fixture.a.admin);
const member = () => harness.as(harness.fixture.a.member);

/** A tracker connection of organization A with its own token, and its own adapter when it's given one. */
const seedTracker = async (input: {
  readonly kind: "linear" | "jira";
  readonly name: string;
  readonly state?: "active" | "pending" | "failed";
  readonly adapter?: TrackerAdapter;
}): Promise<ConnectionId> => {
  const organizationId = harness.fixture.a.organization.id;
  const token = `token-${randomUUID()}`;
  const ref = await harness.fakes.secretStore.put({ organizationId, purpose: input.kind === "jira" ? "jira-token" : "linear-access-token" }, token);
  if (!ref.ok) throw new Error("the fake secret store refused a token");
  const workspace = randomUUID();
  const host = `${workspace.slice(0, 8)}.atlassian.net`;
  const state = input.state ?? "active";
  const row = await harness.test.db.connection.create({
    data: {
      organizationId,
      kind: input.kind,
      name: input.name,
      state,
      appId: input.kind === "jira" ? workspace : `linear-app-${workspace}`,
      externalWorkspaceId: workspace,
      externalWorkspaceKey: input.kind === "jira" ? host : `ws-${workspace.slice(0, 8)}`,
      externalWorkspaceName: input.name,
      credentialKind: input.kind === "jira" ? "service_account_token" : "app_oauth",
      accessTokenSecretRef: ref.value,
      accountEmail: input.kind === "jira" ? "ostra-bot@serviceaccount.atlassian.com" : null,
      appUserId: "app-user",
      failedReason: state === "failed" ? "token-refused" : null,
      activatedAt: state === "active" ? new Date() : null,
    },
    select: { id: true },
  });
  if (input.adapter !== undefined) harness.fakes.tracker.byConnection.set(input.kind === "jira" ? host : token, input.adapter);
  return connectionIdSchema.parse(row.id);
};

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "mixed")).projectId;
  [linearA, linearB] = await Promise.all([createFakeLinear(), createFakeLinear()]);
  site = createJiraSite({ projectKey: "PROJ" });
  jiraProject = site.projects[0]?.id ?? "";
  ids.acme = await seedTracker({ kind: "linear", name: "Acme Linear", adapter: new LinearAdapter({ auth: { kind: "api-key", token: linearA.adminApiKey }, apiUrl: linearA.apiUrl }) });
  ids.initech = await seedTracker({ kind: "linear", name: "Initech Linear", adapter: new LinearAdapter({ auth: { kind: "api-key", token: linearB.adminApiKey }, apiUrl: linearB.apiUrl }) });
  // Two Jira sites whose projects share an ID (two sites both have a project 10000): one site's data
  // behind two connections of their own. The second token can't read workflows.
  ids.globex = await seedTracker({ kind: "jira", name: "Globex Jira", adapter: new JiraFakeAdapter({ site }) });
  ids.umbrella = await seedTracker({ kind: "jira", name: "Umbrella Jira", adapter: new JiraFakeAdapter({ site, workflowAccess: false }) });
  ids.pending = await seedTracker({ kind: "jira", name: "Pending Jira", state: "pending" });
  ids.failed = await seedTracker({ kind: "linear", name: "Failed Linear", state: "failed" });
}, 120_000);

afterAll(async () => {
  await Promise.all([linearA.close(), linearB.close()]);
  await harness.dispose();
});

const need = <T,>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
};

const boardView = async (boardId: BoardId) => need((await (await member()).boards.get({ projectId })).boards.find((board) => board.id === boardId), "board");

const mappingOf = async (boardId: BoardId): Promise<BoardMapping> => need((await boardView(boardId)).mapping ?? undefined, "mapping");

describe("boards from every connection (F-152/c4)", () => {
  it("F-152/c4: boards.attachable groups two Linear and two Jira connections, marks attached boards, and lists a pending or failed connection with no items", async () => {
    const picker = await (await admin()).boards.attachable({ projectId });
    expect(picker.connections.map((group) => [group.name, group.kind, group.state, group.error])).toEqual([
      ["Acme Linear", "linear", "active", null],
      ["Initech Linear", "linear", "active", null],
      ["Globex Jira", "jira", "active", null],
      ["Umbrella Jira", "jira", "active", null],
      ["Pending Jira", "jira", "pending", null],
      ["Failed Linear", "linear", "failed", null],
    ]);
    const groupOf = (id: ConnectionId) => need(picker.connections.find((group) => group.id === id), "group");
    expect(groupOf(ids.acme).items.map((item) => item.key)).toContain(linearA.team.key);
    expect(groupOf(ids.globex).items).toEqual([{ externalId: jiraProject, key: "PROJ", name: site.projects[0]?.name, attachedHere: false, alsoOn: [] }]);
    expect(groupOf(ids.umbrella).items.map((item) => item.externalId)).toEqual([jiraProject]);
    expect(groupOf(ids.pending).items).toEqual([]);
    expect(groupOf(ids.failed).items).toEqual([]);
    // Each active connection was asked through its own adapter: the Jira ones by their own sites.
    expect(new Set(harness.fakes.jiraTrackers.map((built) => built.host)).size).toBe(2);
  });

  it("F-152/c4: one project attaches a Linear team and two Jira projects with the same external ID from two sites, each its own board", async () => {
    const caller = await admin();
    boards.acme = (await caller.boards.attach({ projectId, connectionId: ids.acme, externalId: linearA.team.id })).boardId;
    const globex = await caller.boards.attach({ projectId, connectionId: ids.globex, externalId: jiraProject });
    boards.globex = globex.boardId;
    boards.umbrella = (await caller.boards.attach({ projectId, connectionId: ids.umbrella, externalId: jiraProject })).boardId;
    // Jira's board is drafted with Done moved by ostra (choice 8); the same project ID again on the same connection is refused.
    expect(globex.mapping.doneBy).toBe("ostra");
    await expect(caller.boards.attach({ projectId, connectionId: ids.globex, externalId: jiraProject })).rejects.toMatchObject({ code: "CONFLICT" });
    // A paused (here pending) connection's board can't be attached, and another organization's connection isn't there.
    await expect(caller.boards.attach({ projectId, connectionId: ids.pending, externalId: jiraProject })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.boards.attach({ projectId, connectionId: connectionIdSchema.parse(randomUUID()), externalId: jiraProject })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const rows = await harness.test.db.board.findMany({ where: { projectId }, select: { id: true, connectionId: true, externalId: true } });
    expect(rows.filter((row) => row.externalId === jiraProject).map((row) => row.connectionId).sort()).toEqual([ids.globex, ids.umbrella].sort());
    // Each board's first poll is throttled by its own connection.
    const polls = harness.fakes.jobs.jobs.filter((job) => job.job === "tracker.poll-board");
    expect(polls.map((job) => job.options?.group?.id).sort()).toEqual([ids.acme, ids.globex, ids.umbrella].sort());

    const view = await (await member()).boards.get({ projectId });
    expect(view.boards.map((board) => [board.key, board.connection.kind, board.connection.name, board.state.state])).toEqual([
      [linearA.team.key, "linear", "Acme Linear", "attached"],
      ["PROJ", "jira", "Globex Jira", "attached"],
      ["PROJ", "jira", "Umbrella Jira", "attached"],
    ]);
    expect(view.boards.map((board) => board.capabilities.statusGraph)).toEqual([false, true, true]);
    expect(view.connections.map((connection) => connection.name)).toEqual(["Acme Linear", "Initech Linear", "Globex Jira", "Umbrella Jira", "Pending Jira", "Failed Linear"]);

    const marked = await (await admin()).boards.attachable({ projectId });
    const itemOf = (id: ConnectionId) => need(marked.connections.find((group) => group.id === id), "group").items;
    expect(itemOf(ids.globex)[0]?.attachedHere).toBe(true);
    expect(itemOf(ids.umbrella)[0]?.attachedHere).toBe(true);
    expect(itemOf(ids.acme).find((item) => item.externalId === linearA.team.id)?.attachedHere).toBe(true);
    // Initech's team is another workspace's, even where its ID matched: not attached here.
    expect(itemOf(ids.initech).every((item) => !item.attachedHere)).toBe(true);
    // Create a project offers the same groups, with their items.
    const teams = await (await admin()).boards.teams();
    expect(teams.connections.map((group) => [group.name, group.items.length > 0])).toEqual(marked.connections.map((group) => [group.name, group.items.length > 0]));
  });

  it("F-152/c4: every ticket payload names its connection's kind and name: the Inbox, a task's ticket, what the agent got, search, the live lists and the dry run", async () => {
    const acme = need(boards.acme, "Acme board");
    const globex = need(boards.globex, "Globex board");
    const openOf = async (boardId: BoardId) => need((await mappingOf(boardId)).open[0], "open status");
    const linearTicket = await seedTicket(harness, { projectId, boardId: acme, connectionId: ids.acme, key: `${linearA.team.key}-170`, statusId: await openOf(acme), labels: ["chip"] });
    const jiraTicket = await seedTicket(harness, { projectId, boardId: globex, connectionId: ids.globex, key: "PROJ-12", statusId: await openOf(globex), labels: ["chip"] });
    const acmeTracker = { id: ids.acme, kind: "linear", name: "Acme Linear" };
    const globexTracker = { id: ids.globex, kind: "jira", name: "Globex Jira" };

    // The Inbox: each row and the preview name the board's connection.
    const inbox = await (await member()).inbox.list({ projectId });
    const rowOf = (id: TicketId) => need(inbox.tickets.find((ticket) => ticket.id === id), "row");
    expect(rowOf(linearTicket).board).toMatchObject({ id: acme, connection: acmeTracker, paused: false });
    expect(rowOf(jiraTicket).board).toMatchObject({ id: globex, connection: globexTracker, paused: false });
    expect(inbox.source.connections.map((connection) => connection.name).sort()).toEqual(["Acme Linear", "Globex Jira", "Umbrella Jira"]);
    expect((await (await member()).inbox.get({ projectId, ticketId: jiraTicket })).board.connection).toEqual(globexTracker);

    // The automations' dry run lists attached boards' tickets with theirs.
    const dry = await (await member()).automations.dryRun({ projectId, filter: { labels: { mode: "any", names: ["chip"] } } });
    expect(dry.rows.map((row) => [row.key, row.connection?.name]).sort()).toEqual([
      [`${linearA.team.key}-170`, "Acme Linear"],
      ["PROJ-12", "Globex Jira"],
    ]);

    // A task on each: its ticket, the ticket's context, the live lists and search.
    const onLinear = await (await member()).tasks.startFromTicket({ projectId, ticketId: linearTicket });
    const onJira = await (await member()).tasks.startFromTicket({ projectId, ticketId: jiraTicket });
    const linearTask = await (await member()).tasks.get({ taskId: onLinear.taskId });
    expect(linearTask.ticket).toMatchObject({ connection: acmeTracker, subIssues: { count: 0, done: 0 } });
    expect((await (await member()).tasks.ticketContext({ taskId: onJira.taskId }))?.connection).toEqual(globexTracker);
    expect((await (await member()).tasks.ticketContext({ taskId: onLinear.taskId }))?.connection).toEqual(acmeTracker);

    const listed = (await (await member()).tasks.list({ projectId })).flatMap((group) => group.tasks);
    expect(listed.find((task) => task.id === onJira.taskId)?.connection).toEqual(globexTracker);
    expect(listed.find((task) => task.id === onLinear.taskId)?.connection).toEqual(acmeTracker);
    const cards = (await (await member()).home.board({ projectId })).columns.flatMap((column) => column.cards);
    expect(cards.find((card) => card.taskId === onJira.taskId)?.connection).toEqual(globexTracker);

    const found = await (await member()).search.tasks({ query: "ticket:PROJ-12" });
    expect(found.results.map((result) => [result.ticketKey, result.connection])).toEqual([["PROJ-12", globexTracker]]);
  });
});

describe("a board's workflow (F-008/c5)", () => {
  it("F-008/c5: boards.workflow answers the statuses, transitions and each step's by line and warnings against the fake Jira, and readable: false without workflow access", async () => {
    const globex = need(boards.globex, "Globex board");
    const workflow = await (await member()).boards.workflow({ boardId: globex });
    if (!workflow.readable) throw new Error("Globex's token reads workflows");
    expect(workflow.statuses.map((status) => [status.name, status.category])).toEqual([
      ["To Do", "open"],
      ["In Progress", "started"],
      ["In Review", "started"],
      ["Done", "done"],
      ["Won't Do", "cancelled"],
    ]);
    expect(workflow.transitions).toContainEqual({ id: "51", name: "Won't do", from: "any", to: "10004" });
    expect(workflow.transitions).toContainEqual({ id: "21", name: "Review", from: ["10001"], to: "10002" });
    const stepOf = (step: string) => need(workflow.steps.find((candidate) => candidate.step === step), step);
    // In review: `by Review, from In Progress`, and from To Do the route starts with Start.
    expect(stepOf("inReview")).toMatchObject({ target: "10002", unreachable: [] });
    expect(stepOf("inReview").by).toContainEqual({ transition: { id: "21", name: "Review" }, from: ["10001"] });
    expect(stepOf("inReview").by).toContainEqual({ transition: { id: "11", name: "Start" }, from: ["10000"] });
    // Done: Won't Do is four transitions away (Reopen, Start, Review, Done): more than three, so a ticket there stays put.
    expect(stepOf("done")).toMatchObject({ target: "10003", unreachable: ["10004"] });
    // The picker's column: Won't Do is reached from any status by a global transition.
    expect(workflow.reach.find((reach) => reach.statusId === "10004")).toMatchObject({ global: true, unreachable: [] });
    expect(workflow.reach.find((reach) => reach.statusId === "10003")).toMatchObject({ global: false, unreachable: ["10004"] });

    // The mapping being edited: a target reached by the global transition reads `from any status`.
    const edited = { ...(await mappingOf(globex)), done: "10004" };
    const editing = await (await member()).boards.workflow({ boardId: globex, mapping: edited });
    expect(editing.readable ? editing.steps.find((step) => step.step === "done") : null).toEqual({ step: "done", target: "10004", by: [{ transition: { id: "51", name: "Won't do" }, from: "any" }], unreachable: [] });

    // Umbrella's token can't read workflows: the statuses alone, no lines or warnings.
    const unreadable = await (await member()).boards.workflow({ boardId: need(boards.umbrella, "Umbrella board") });
    expect(unreadable).toEqual({ readable: false, statuses: workflow.statuses });

    // Linear writes statuses directly: it has no workflow to read.
    await expect((await member()).boards.workflow({ boardId: need(boards.acme, "Acme board") })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    // Another organization's admin can't read it.
    await expect((await harness.as(harness.fixture.b.admin)).boards.workflow({ boardId: globex })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-008/c5: a mapping naming a status the workflow doesn't have is refused, and the saved one stays", async () => {
    const globex = need(boards.globex, "Globex board");
    const before = await mappingOf(globex);
    await expect((await admin()).boards.saveMapping({ boardId: globex, mapping: { ...before, inReview: "99999" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect((await admin()).boards.saveMapping({ boardId: globex, mapping: { ...before, open: ["10000", "no-such-status"] } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await mappingOf(globex)).toEqual(before);
    // A target status of its own workflow is saved.
    expect((await (await admin()).boards.saveMapping({ boardId: globex, mapping: { ...before, done: "10004" } })).mapping.done).toBe("10004");
    await (await admin()).boards.saveMapping({ boardId: globex, mapping: before });
  });
});

describe("Done is moved by, and prompt tickets, on a Jira board (F-008/c7)", () => {
  it("F-008/c7: setDoneBy on a Jira board switches between Jira automation and ostra, audited, for project admins only", async () => {
    const globex = need(boards.globex, "Globex board");
    expect((await (await admin()).boards.setDoneBy({ boardId: globex, by: "tracker" })).mapping.doneBy).toBe("integration");
    expect((await mappingOf(globex)).doneBy).toBe("integration");
    const audit = await harness.test.db.auditEntry.findFirst({ where: { action: "board.mapping-saved", projectId }, orderBy: { createdAt: "desc" } });
    expect(audit?.data).toMatchObject({ boardId: globex, doneBy: "integration" });
    expect((await (await admin()).boards.setDoneBy({ boardId: globex, by: "ostra" })).mapping.doneBy).toBe("ostra");
    await expect((await member()).boards.setDoneBy({ boardId: globex, by: "tracker" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(harness.fixture.b.admin)).boards.setDoneBy({ boardId: globex, by: "tracker" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await mappingOf(globex)).doneBy).toBe("ostra");
  });

  it("F-008/c7: the prompt-ticket board on a Jira board names its tracker for New task", async () => {
    const globex = need(boards.globex, "Globex board");
    await (await admin()).projects.setPromptTickets({ projectId, boardId: globex });
    const project = await (await member()).projects.get({ projectId });
    expect(project.promptTicketBoardId).toBe(globex);
    expect(project.promptTicketBoard).toEqual({ id: globex, name: site.projects[0]?.name, key: "PROJ", connection: { id: ids.globex, kind: "jira", name: "Globex Jira" } });
    await (await admin()).projects.setPromptTickets({ projectId, boardId: null });
  });
});

describe("a disconnected connection's boards (F-152/c5)", () => {
  it("F-152/c5: a disconnected connection's board reads paused, its mapping can't be saved, and its tickets show in the Inbox but can't start a task", async () => {
    const umbrella = need(boards.umbrella, "Umbrella board");
    const ticketId = await seedTicket(harness, { projectId, boardId: umbrella, connectionId: ids.umbrella, key: "PROJ-77", statusId: "10000" });
    const before = Date.now();
    expect(await (await admin()).trackers.disconnect({ id: ids.umbrella })).toMatchObject({ kind: "jira", pausedBoards: 1 });

    // Boards: the row stays, paused by the disconnect, since then; the other boards are untouched.
    const view = await (await member()).boards.get({ projectId });
    const paused = need(view.boards.find((board) => board.id === umbrella), "paused board");
    expect(paused).toMatchObject({ connection: { name: "Umbrella Jira", kind: "jira", state: "revoked" }, statusGroups: null, statusesError: null });
    if (paused.state.state !== "paused") throw new Error("Umbrella's board isn't paused");
    expect(paused.state.pausedBy).toBe("disconnected");
    expect(paused.state.since).toBeGreaterThanOrEqual(before - 1000);
    expect(view.boards.filter((board) => board.id !== umbrella).map((board) => board.state.state)).toEqual(["attached", "attached"]);
    expect(view.connections.map((connection) => connection.name)).not.toContain("Umbrella Jira");

    // Its mapping reads only: saving, Done is moved by and the workflow are refused.
    const mapping = need(paused.mapping ?? undefined, "mapping");
    await expect((await admin()).boards.saveMapping({ boardId: umbrella, mapping })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect((await admin()).boards.setDoneBy({ boardId: umbrella, by: "tracker" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect((await member()).boards.workflow({ boardId: umbrella })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await harness.test.db.board.findUniqueOrThrow({ where: { id: umbrella } })).statusMap).toEqual(mapping);

    // The Inbox still lists its ticket, marked paused, and nothing starts from it.
    const inbox = await (await member()).inbox.list({ projectId, boardId: umbrella });
    expect(inbox.tickets.find((ticket) => ticket.id === ticketId)?.board).toMatchObject({ connection: { id: ids.umbrella, kind: "jira", name: "Umbrella Jira" }, paused: true });
    expect(inbox.source).toMatchObject({ stale: true, boards: [{ id: umbrella, paused: true }] });
    await expect((await member()).tasks.startFromTicket({ projectId, ticketId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await harness.test.db.task.count({ where: { ticketId } })).toBe(0);
  });

  it("F-152/c5: a failed connection's board pauses too, by its failure", async () => {
    const acme = need(boards.acme, "Acme board");
    await harness.test.db.connection.update({ where: { id: ids.acme }, data: { state: "failed", failedReason: "token-refused" } });
    try {
      const board = await boardView(acme);
      expect(board.state).toMatchObject({ state: "paused", pausedBy: "failed" });
      await expect((await admin()).boards.saveMapping({ boardId: acme, mapping: await mappingOf(acme) })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    } finally {
      await harness.test.db.connection.update({ where: { id: ids.acme }, data: { state: "active", failedReason: null } });
    }
    expect((await boardView(acme)).state).toEqual({ state: "attached" });
  });
});
