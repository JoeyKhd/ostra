import { createFakeLinear, createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import type { FakeLinear, JiraSite } from "@ostra/adapter-sdk/testing";
import { LinearAdapter } from "@ostra/adapter-linear";
import { connectionIdSchema, projectIdSchema } from "@ostra/protocol";
import type { ConnectionId, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedLinearConnection, seedProject, seedTicket } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 28: a project's boards, against the Jira fake (statuses with categories, an integration
// check, a status graph) and, when the Linear adapter can list teams (ticket 07), against the
// fake Linear server. Project admins change boards; members read; others see nothing.

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;
let projectId: Awaited<ReturnType<typeof seedProject>>["projectId"];
let site: JiraSite;
let linearId: ConnectionId;

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "boards")).projectId;
  site = createJiraSite({ projectKey: "CALC" });
  harness.fakes.tracker.adapter = new JiraFakeAdapter({ site });
  linearId = await seedLinearConnection(harness);
});

afterAll(async () => {
  await harness.dispose();
});

const admin = () => harness.as(harness.fixture.a.admin);
const member = () => harness.as(harness.fixture.a.member);

/** The attach picker's items of the fixture's one tracker connection (milestone 11: grouped by connection). */
const itemsOf = async (of: ProjectId = projectId) => (await (await admin()).boards.attachable({ projectId: of })).connections.find((group) => group.id === linearId)?.items ?? [];

const teamOf = async (key = "CALC") => {
  const teams = await itemsOf();
  const team = teams.find((candidate) => candidate.key === key);
  if (team === undefined) {
    throw new Error(`the tracker has no team ${key}`);
  }
  return team;
};

describe("F-007: the tracker's teams before a project exists", () => {
  it("lists the organization's teams for Create a project, for organization admins only", async () => {
    const teams = await (await admin()).boards.teams();
    expect(teams.connections.find((group) => group.id === linearId)?.items.map((team) => team.key)).toContain("CALC");
    await expect((await member()).boards.teams()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("answers no groups while the organization has no tracker", async () => {
    expect(await (await harness.as(harness.fixture.b.admin)).boards.teams()).toEqual({ connections: [] });
  });
});

describe("F-007: attaching a board", () => {
  it("F-031/c4: drafts the mapping from the team's statuses and the integration check, saves the board and enqueues the first poll", async () => {
    harness.fakes.jobs.clear();
    const team = await teamOf();
    const attached = await (await admin()).boards.attach({ projectId, connectionId: linearId, externalId: team.externalId });

    // The Jira fake's workflow: To Do (open), In Progress, In Review (started), Done and Won't Do (done).
    expect(attached.mapping).toMatchObject({ started: "10001", inReview: "10002", done: "10003", doneBy: "ostra", magicWord: "Closes" });
    expect(attached.mapping.open).toEqual(["10000"]);
    expect(attached.integrationInstalled).toBe(false);

    const row = await harness.test.db.board.findUniqueOrThrow({ where: { id: attached.boardId } });
    expect(row).toMatchObject({ projectId, name: "Jira fake", key: "CALC", externalId: team.externalId, detachedAt: null, integrationDetected: false });
    expect(row.statusMap).toEqual(attached.mapping);

    // The first full poll, in the same transaction, throttled by the connection.
    const polls = harness.fakes.jobs.jobs.filter((job) => job.job === "tracker.poll-board");
    expect(polls).toHaveLength(1);
    expect(polls[0]).toMatchObject({ key: `board:${attached.boardId}:poll`, payload: { boardId: attached.boardId } });
    expect(polls[0]?.options?.group?.id).toBeTruthy();

    const audit = await harness.test.db.auditEntry.findFirst({ where: { action: "board.attached", projectId } });
    expect(audit?.data).toMatchObject({ boardId: attached.boardId, key: "CALC", doneBy: "ostra" });
  });

  // Linear's case (doneBy integration once its GitHub integration is installed) is F-031/c3's test
  // below, on the fake Linear. This fake moves by transitions, as Jira does: milestone 11's choice 8.
  it("F-008/c7: a tracker that moves by transitions drafts Done moved by ostra, even with its GitHub integration installed", async () => {
    const other = createJiraSite({ projectKey: "WEB" });
    other.devPanelInstalled = true;
    harness.fakes.tracker.adapter = new JiraFakeAdapter({ site: other });
    try {
      const second = (await harness.test.db.project.create({ data: { organizationId: harness.fixture.a.organization.id, name: "integrated", slug: "integrated" } })).id;
      const teams = await itemsOf(projectIdOf(second));
      const team = teams.find((candidate) => candidate.key === "WEB");
      expect(team).toBeDefined();
      const attached = await (await admin()).boards.attach({ projectId: projectIdOf(second), connectionId: linearId, externalId: team?.externalId ?? "" });
      expect(attached.integrationInstalled).toBe(true);
      expect(attached.mapping.doneBy).toBe("ostra");
      expect((await harness.test.db.board.findUniqueOrThrow({ where: { id: attached.boardId } })).integrationDetected).toBe(true);
    } finally {
      harness.fakes.tracker.adapter = new JiraFakeAdapter({ site });
    }
  });

  it("refuses the same team twice in one project, and a team the connection can't see", async () => {
    const team = await teamOf();
    await expect((await admin()).boards.attach({ projectId, connectionId: linearId, externalId: team.externalId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect((await admin()).boards.attach({ projectId, connectionId: linearId, externalId: "no-such-team" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-007/c2: marks attached teams, and says which other projects have the team too", async () => {
    const teams = await itemsOf();
    expect(teams.find((team) => team.key === "CALC")).toMatchObject({ attachedHere: true, alsoOn: [] });

    const second = await seedProject(harness, world, "boards-two");
    const fromSecond = await itemsOf(second.projectId);
    expect(fromSecond.find((team) => team.key === "CALC")).toMatchObject({ attachedHere: false, alsoOn: [{ projectId, name: "boards" }] });
    // A team may be a board of several projects, each a board of its own.
    const attached = await (await admin()).boards.attach({ projectId: second.projectId, connectionId: linearId, externalId: (await teamOf()).externalId });
    expect(attached.boardId).toBeTruthy();
    expect(await harness.test.db.board.count({ where: { externalId: (await teamOf()).externalId } })).toBe(2);
  });

  it("is for project admins: a member, another project's admin and another organization are refused", async () => {
    const team = await teamOf();
    await expect((await member()).boards.attach({ projectId, connectionId: linearId, externalId: team.externalId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await member()).boards.attachable({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(harness.fixture.b.admin)).boards.attach({ projectId, connectionId: linearId, externalId: team.externalId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // An admin of the restricted project is not an admin of this one.
    await harness.test.db.projectMember.update({
      where: { projectId_memberId: { projectId: harness.fixture.a.restrictedProject.id, memberId: harness.fixture.a.insider.id } },
      data: { role: "admin" },
    });
    await expect((await harness.as(harness.fixture.a.insider)).boards.attach({ projectId, connectionId: linearId, externalId: team.externalId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(harness.anonymous().boards.attach({ projectId, connectionId: linearId, externalId: team.externalId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("needs a tracker connection first, and says so by listing none", async () => {
    const { b } = harness.fixture;
    expect(await (await harness.as(b.admin)).boards.attachable({ projectId: b.project.id })).toEqual({ connections: [] });
    expect(await (await harness.as(b.admin)).boards.get({ projectId: b.project.id })).toEqual({ connections: [], pollSeconds: 60, canEdit: true, boards: [] });
  });
});

const projectIdOf = (id: string) => projectIdSchema.parse(id);

const connectionIdOfOrg = async () =>
  connectionIdSchema.parse((await harness.test.db.connection.findFirstOrThrow({ where: { organizationId: harness.fixture.a.organization.id, kind: "linear" } })).id);

describe("F-007, F-031: the mapping", () => {
  it("F-031/c4: is saved with the magic word after each status is checked against the team", async () => {
    const board = (await (await member()).boards.get({ projectId })).boards[0];
    if (board === undefined || board.mapping === null) {
      throw new Error("no board");
    }
    const edited = { ...board.mapping, open: ["10000", "10001"], magicWord: "Refs" as const, doneBy: "integration" as const };
    const saved = await (await admin()).boards.saveMapping({ boardId: board.id, mapping: edited });
    expect(saved.mapping).toEqual(edited);
    expect((await harness.test.db.board.findUniqueOrThrow({ where: { id: board.id } })).statusMap).toEqual(edited);
    expect((await harness.test.db.auditEntry.findFirst({ where: { action: "board.mapping-saved", projectId } }))?.data).toMatchObject({ doneBy: "integration", magicWord: "Refs", openStatuses: 2 });
  });

  it("refuses a status the team no longer has, and keeps the saved mapping", async () => {
    const board = (await (await member()).boards.get({ projectId })).boards[0];
    if (board === undefined || board.mapping === null) {
      throw new Error("no board");
    }
    const before = (await harness.test.db.board.findUniqueOrThrow({ where: { id: board.id } })).statusMap;
    await expect((await admin()).boards.saveMapping({ boardId: board.id, mapping: { ...board.mapping, done: "99999" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect((await admin()).boards.saveMapping({ boardId: board.id, mapping: { ...board.mapping, open: ["gone"] } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await harness.test.db.board.findUniqueOrThrow({ where: { id: board.id } })).statusMap).toEqual(before);
    // A strict schema: a field it doesn't know is refused before anything else.
    await expect((await admin()).boards.saveMapping({ boardId: board.id, mapping: Object.assign({}, board.mapping, { extra: 1 }) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("is saved by project admins only", async () => {
    const board = (await (await member()).boards.get({ projectId })).boards[0];
    if (board === undefined || board.mapping === null) {
      throw new Error("no board");
    }
    await expect((await member()).boards.saveMapping({ boardId: board.id, mapping: board.mapping })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(harness.fixture.b.admin)).boards.saveMapping({ boardId: board.id, mapping: board.mapping })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await harness.as(harness.fixture.a.insider)).boards.saveMapping({ boardId: board.id, mapping: board.mapping })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("F-007: what the boards page shows a member", () => {
  it("carries the key, open tickets, last poll and event, the workspace, the mode, the integration and every status", async () => {
    const [board] = (await (await admin()).boards.get({ projectId })).boards;
    if (board === undefined) {
      throw new Error("no board");
    }
    const connectionId = await connectionIdOfOrg();
    await seedTicket(harness, { projectId, boardId: board.id, connectionId, key: "CALC-1" });
    await seedTicket(harness, { projectId, boardId: board.id, connectionId, key: "CALC-2" });
    await seedTicket(harness, { projectId, boardId: board.id, connectionId, key: "CALC-3", open: false });
    await harness.test.db.board.update({ where: { id: board.id }, data: { lastPolledAt: new Date(Date.now() - 40_000) } });
    await harness.test.db.webhookDelivery.create({
      data: { organizationId: harness.fixture.a.organization.id, connectionId, deliveryId: "d-1", event: "Issue", ticketKey: "CALC-2", status: "processed" },
    });

    const view = await (await member()).boards.get({ projectId });
    expect(view.canEdit).toBe(false);
    expect(view.pollSeconds).toBe(60);
    expect(view.connections).toEqual([{ id: linearId, kind: "linear", name: "ostra-test Linear", state: "active" }]);
    const shown = view.boards[0];
    expect(shown?.connection).toEqual({ id: linearId, kind: "linear", name: "ostra-test Linear", state: "active", mode: "webhooks", agentMode: false });
    expect(shown?.state).toEqual({ state: "attached" });
    expect(shown?.capabilities).toMatchObject({ statusGraph: false, magicWords: true, agentSessions: true });
    expect(shown).toMatchObject({ key: "CALC", name: "Jira fake", openTickets: 2, integration: "not_installed", missingStatuses: [] });
    expect(shown?.lastPolledAt).not.toBeNull();
    expect(shown?.lastEvent).toMatchObject({ type: "Issue", ticketKey: "CALC-2" });
    // Every status of the team, grouped by category, in the tracker's order.
    expect(shown?.statusGroups?.map((group) => [group.category, group.statuses.map((status) => status.name)])).toEqual([
      ["open", ["To Do"]],
      ["started", ["In Progress", "In Review"]],
      ["done", ["Done"]],
      ["cancelled", ["Won't Do"]],
    ]);
    await expect((await admin()).boards.get({ projectId })).resolves.toMatchObject({ canEdit: true });
  });

  it("flags a mapped status that is gone from the team", async () => {
    const [saved] = (await (await member()).boards.get({ projectId })).boards;
    if (saved === undefined || saved.mapping === null) {
      throw new Error("no board");
    }
    await harness.test.db.board.update({ where: { id: saved.id }, data: { statusMap: { ...saved.mapping, started: "gone-status" } } });
    try {
      const shown = (await (await member()).boards.get({ projectId })).boards[0];
      expect(shown?.missingStatuses).toEqual(["gone-status"]);
    } finally {
      await harness.test.db.board.update({ where: { id: saved.id }, data: { statusMap: saved.mapping } });
    }
  });

  it("reads a milestone 1 board (an empty mapping) as needing one", async () => {
    const old = await harness.test.db.board.create({
      data: {
        organizationId: harness.fixture.a.organization.id,
        projectId,
        connectionId: await connectionIdOfOrg(),
        externalId: "legacy-team",
        name: "Legacy",
        statusMap: {},
      },
    });
    const shown = (await (await member()).boards.get({ projectId })).boards.find((candidate) => candidate.id === old.id);
    expect(shown).toMatchObject({ mapping: null, integration: "unknown", missingStatuses: [] });
    await harness.test.db.board.delete({ where: { id: old.id } });
  });

  it("says why the statuses are missing when the tracker can't be asked, and still answers", async () => {
    const ref = (await harness.test.db.connection.findUniqueOrThrow({ where: { id: linearId } })).accessTokenSecretRef;
    await harness.test.db.connection.update({ where: { id: linearId }, data: { accessTokenSecretRef: null } });
    try {
      const view = await (await member()).boards.get({ projectId });
      expect(view.boards[0]).toMatchObject({ statusGroups: null, state: { state: "attached" } });
      expect(view.boards[0]?.statusesError).toContain("has no token");
    } finally {
      await harness.test.db.connection.update({ where: { id: linearId }, data: { accessTokenSecretRef: ref } });
    }
    // A failed connection pauses the board instead: it isn't asked at all (F-152/c5's own tests are in boards-trackers.test.ts).
    await harness.test.db.connection.updateMany({ where: { kind: "linear", organizationId: harness.fixture.a.organization.id }, data: { state: "failed" } });
    try {
      const view = await (await member()).boards.get({ projectId });
      expect(view.boards[0]).toMatchObject({ statusGroups: null, statusesError: null, connection: { state: "failed" }, state: { state: "paused", pausedBy: "failed" } });
    } finally {
      await harness.test.db.connection.updateMany({ where: { kind: "linear", organizationId: harness.fixture.a.organization.id }, data: { state: "active" } });
    }
  });

  it("is invisible to another organization and to a restricted project's outsiders", async () => {
    await expect((await harness.as(harness.fixture.b.admin)).boards.get({ projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await member()).boards.get({ projectId: harness.fixture.a.restrictedProject.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("never returns a token, and logs none", async () => {
    const view = JSON.stringify(await (await admin()).boards.get({ projectId }));
    for (const token of harness.fakes.trackerTokens) {
      expect(view).not.toContain(token);
      expect(JSON.stringify(harness.logs)).not.toContain(token);
    }
    expect(harness.fakes.trackerTokens.length).toBeGreaterThan(0);
  });
});

describe("F-007: detaching a board", () => {
  it("stops it for new tasks, keeps its cached tickets and its tasks' links, and allows attaching it again", async () => {
    const fresh = await seedProject(harness, world, "boards-detach");
    const team = await teamOf();
    const attached = await (await admin()).boards.attach({ projectId: fresh.projectId, connectionId: linearId, externalId: team.externalId });
    const connectionId = await connectionIdOfOrg();
    const ticketId = await seedTicket(harness, { projectId: fresh.projectId, boardId: attached.boardId, connectionId, key: "CALC-9" });
    const task = await harness.test.db.task.create({
      data: {
        organizationId: harness.fixture.a.organization.id,
        projectId: fresh.projectId,
        kind: "code",
        source: "ticket",
        title: "t",
        branchName: "ostra/calc-9-xxxxxxxx-t",
        ticketId,
        boardId: attached.boardId,
        ticketKey: "CALC-9",
      },
    });

    await expect((await member()).boards.detach({ boardId: attached.boardId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(harness.fixture.b.admin)).boards.detach({ boardId: attached.boardId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await (await admin()).boards.detach({ boardId: attached.boardId });

    expect((await harness.test.db.board.findUniqueOrThrow({ where: { id: attached.boardId } })).detachedAt).not.toBeNull();
    expect((await (await member()).boards.get({ projectId: fresh.projectId })).boards).toEqual([]);
    expect(await harness.test.db.ticket.count({ where: { boardId: attached.boardId } })).toBe(1);
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ boardId: attached.boardId, ticketId });
    await expect((await admin()).boards.detach({ boardId: attached.boardId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await itemsOf(fresh.projectId)).find((candidate) => candidate.key === "CALC")?.attachedHere).toBe(false);

    // Attaching the team again brings the same board back, with the mapping it had.
    const again = await (await admin()).boards.attach({ projectId: fresh.projectId, connectionId: linearId, externalId: team.externalId });
    expect(again.boardId).toBe(attached.boardId);
    expect((await harness.test.db.board.findUniqueOrThrow({ where: { id: attached.boardId } })).detachedAt).toBeNull();
  });

});

describe("F-007 on Linear: the same flow on the fake Linear server", () => {
  let fake: FakeLinear;
  let linear: LinearAdapter;

  beforeAll(async () => {
    fake = await createFakeLinear();
    linear = new LinearAdapter({ auth: { kind: "api-key", token: fake.adminApiKey }, apiUrl: fake.apiUrl });
  });

  afterAll(async () => {
    await fake.close();
  });

  it("F-031/c3,c4: drafts Linear's mapping from its status types, and doneBy integration once Linear's GitHub integration is installed", async () => {
    // The Linear adapter lists teams (ticket 07): this case runs, never skips.
    expect((await linear.listBoards()).ok).toBe(true);
    harness.fakes.tracker.adapter = linear;
    try {
      const fresh = await seedProject(harness, world, "boards-linear");
      const teams = await itemsOf(fresh.projectId);
      const team = teams.find((candidate) => candidate.key === fake.team.key);
      expect(team).toBeDefined();
      const attached = await (await admin()).boards.attach({ projectId: fresh.projectId, connectionId: linearId, externalId: team?.externalId ?? "" });
      const states = fake.states(fake.team.id);
      const idOf = (type: string, predicate: (name: string) => boolean = () => true) => states.find((state) => state.type === type && predicate(state.name))?.id;
      expect(attached.mapping.started).toBe(idOf("started"));
      expect(attached.mapping.done).toBe(idOf("completed"));
      expect(attached.mapping.open).toEqual(states.filter((state) => ["triage", "backlog", "unstarted"].includes(state.type)).map((state) => state.id));
      expect(attached.mapping.doneBy).toBe("ostra");

      fake.setGithubIntegration(true);
      const other = await seedProject(harness, world, "boards-linear-two");
      const integrated = await (await admin()).boards.attach({ projectId: other.projectId, connectionId: linearId, externalId: team?.externalId ?? "" });
      expect(integrated.mapping.doneBy).toBe("integration");
    } finally {
      harness.fakes.tracker.adapter = new JiraFakeAdapter({ site });
    }
  });
});
