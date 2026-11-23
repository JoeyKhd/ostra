import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { TrackerCapabilities, TrackerWorkflow } from "@ostra/adapter-sdk";
import { createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import type { JiraSite } from "@ostra/adapter-sdk/testing";
import type { DbEnum } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { automationIdSchema, boardIdSchema, connectionIdSchema, externalTicketIdSchema, organizationIdSchema, projectIdSchema, taskIdSchema, ticketIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, OrganizationId, ProjectId, TaskId, TicketId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemberScope } from "./access.ts";
import { dryRunAutomation, matchIntakeRules, openAttachedTicketsInTx } from "./automations/intake.ts";
import { intakeFilterSchema } from "./automations/intake-filter.ts";
import { attachedBoardWhere, boardStateOf, trackerConnectionLifecycleOf, transitionTrackerConnection } from "./lifecycles/m11-trackers.ts";
import type { BoardState, TrackerConnectionInput, TrackerConnectionLifecycle } from "./lifecycles/m11-trackers.ts";
import type { JobQueue } from "./ports.ts";
import { postgresAuditLog, postgresChangeNotices, systemClock } from "./postgres-ports.ts";
import { setupTimeline } from "./setup/timeline.ts";
import { skipSetupStep, trackerSetupStepInTx, trackerSetupStepOf } from "./setup/tracker-step.ts";
import { startTask } from "./starts/start-task-body.ts";
import { draftBoardMapping, mappingReachability, movedNot } from "./tickets/board-mapping.ts";
import type { BoardMapping } from "./tickets/board-mapping.ts";
import { boardsOnSameTeam } from "./tickets/ticket-cache.ts";
import { isPendingAppId } from "./tickets/contracts.ts";
import { writeTicketStepsInTx } from "./tickets/ticket-writes.ts";
import { attachBoard, saveBoardMapping } from "./use-cases/boards.ts";
import type { LinearAppKit } from "./use-cases/linear-connection.ts";
import { startLinearConnection } from "./use-cases/linear-connection.ts";
import { promptTicketBoardViewInTx, setPromptTickets } from "./use-cases/prompt-tickets.ts";
import { ingestTicketHint } from "./use-cases/tickets.ts";
import {
  connectionNameSchema,
  defaultConnectionName,
  nameTakenBy,
  pausedBoardLine,
  resumeBoardsInTx,
  siteTakenBy,
  trackerConnectionOf,
  trackerConnectionsOf,
} from "./use-cases/tracker-connections.ts";
import type { ConnectionTracker, TrackerKind, TrackerKindCapabilities } from "./use-cases/tracker-connections.ts";

// Milestone 11, ticket 05 (F-152, F-008; ADR 0071; spec section 5.4): tracker connections of any
// kind, boards per connection, paused boards and their resume, the setup step and Jira's mapping,
// on Postgres. Every multi-connection case holds two connections of one kind in one organization,
// so anything that finds "the organization's" tracker by its kind gives the wrong one and fails,
// and organization B's rows stay out of A's answers.

let test: TestDatabase;
let fixture: IsolationFixture;
let organizationA: OrganizationId;
let organizationB: OrganizationId;
let openProject: ProjectId;
let admin: MemberScope;

const sent: string[] = [];
const jobs: JobQueue = {
  enqueueInTx: (_tx, job) => {
    sent.push(job);
    return Promise.resolve();
  },
};
const ports = { audit: postgresAuditLog, notices: postgresChangeNotices, clock: systemClock, jobs };

/** What Linear's adapter declares, as `LINEAR_CAPABILITIES` (the domain builds no adapter). */
const linearCapabilities: TrackerCapabilities = {
  agentSessions: true,
  agentScopes: ["app:assignable", "app:mentionable"],
  agentSessionLink: true,
  subIssues: true,
  statusGraph: false,
  webhooks: true,
  webhookRegistration: false,
  commentEdit: true,
  attachments: true,
  transitions: false,
  mentions: true,
  ticketFields: { acceptanceCriteria: false },
  ticketFiles: "all",
  magicWords: true,
  richText: "markdown",
  jqlFilter: false,
};
const capabilities: TrackerKindCapabilities = { linear: linearCapabilities, jira: new JiraFakeAdapter({ site: createJiraSite() }).capabilities };

/** A fake Linear app kit: the manifest link names the webhook URL; nothing else is called here. */
const linearKit: LinearAppKit = {
  scopes: ["read", "write"],
  webhookEvents: ["Issue", "Comment"],
  checkPublicUrl: () => ({ public: true }),
  manifestUrl: ({ webhookUrl }) => `https://linear.invalid/manifest?webhook=${encodeURIComponent(webhookUrl ?? "")}`,
  authorizeUrl: () => "https://linear.invalid/authorize",
  exchangeCode: () => Promise.resolve({ ok: false, error: { code: "refused", message: "not in this test" } }),
  checkAppToken: () => Promise.resolve({ ok: false, error: { code: "refused", message: "not in this test" } }),
  revokeToken: () => Promise.resolve({ ok: true, value: null }),
  capabilities: { agentSessions: true, agentScopes: ["app:assignable"] },
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  organizationA = fixture.a.organization.id;
  organizationB = fixture.b.organization.id;
  openProject = fixture.a.openProject.id;
  admin = { organizationId: organizationA, memberId: fixture.a.admin.id, role: "admin", projectRoles: new Map() };
});

afterAll(async () => {
  await test.dispose();
});

// ---------- seeds ----------

type Seeded = { readonly connectionId: ConnectionId; readonly site: JiraSite; readonly tracker: ConnectionTracker };

/** A tracker connection row, as a finished connect leaves it, with a fake site behind it. */
const seedConnection = async (input: {
  readonly organizationId?: OrganizationId;
  readonly kind: TrackerKind;
  readonly name: string;
  readonly state?: DbEnum.ConnectionState;
  readonly workspaceId?: string;
  readonly site?: JiraSite;
}): Promise<Seeded> => {
  const site = input.site ?? createJiraSite({ projectKey: input.name.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, "X") });
  const workspaceId = input.workspaceId ?? `cloud-${randomUUID()}`;
  const row = await test.db.connection.create({
    data: {
      organizationId: input.organizationId ?? organizationA,
      kind: input.kind,
      name: input.name,
      appId: `${input.kind}-${randomUUID()}`,
      state: input.state ?? "active",
      credentialKind: input.kind === "jira" ? "service_account_token" : "app_oauth",
      externalWorkspaceId: workspaceId,
      externalWorkspaceKey: input.kind === "jira" ? `${input.name.split(" ")[0]?.toLowerCase() ?? "site"}.atlassian.net` : input.name.split(" ")[0]?.toLowerCase() ?? "workspace",
      externalWorkspaceName: input.name.split(" ")[0] ?? null,
      appUserId: site.appAccountId,
      appUserName: "ostra",
      ...(input.kind === "jira"
        ? {
            accountEmail: "ostra-bot@serviceaccount.atlassian.com",
            tokenExpiresOn: new Date("2027-03-01T00:00:00Z"),
            accessCheck: { projects: [{ id: "10000", key: "PROJ", name: "Project", permissions: ["BROWSE_PROJECTS", "TRANSITION_ISSUES"] }], workflowsReadable: true },
          }
        : {}),
    },
    select: { id: true },
  });
  const connectionId = connectionIdSchema.parse(row.id);
  return { connectionId, site, tracker: { connectionId, kind: input.kind, name: input.name, tracker: new JiraFakeAdapter({ site }), ownUserId: site.appAccountId } };
};

const projectOf = (site: JiraSite): string => {
  const project = site.projects[0];
  if (project === undefined) throw new Error("the fake site has no project");
  return project.id;
};

const attach = async (projectId: ProjectId, seeded: Pick<Seeded, "connectionId" | "tracker">, externalId: string) => {
  const result = await test.db.$transaction((tx) => attachBoard({ tx, scope: admin, tracker: seeded.tracker, ...ports }, { projectId, connectionId: seeded.connectionId, externalId }));
  if (!result.ok) throw new Error(`attach: ${result.message}`);
  return result;
};

/** A board row as an attach makes it, for an external ID no fake site serves (two connections' boards with one ID). */
const seedBoard = async (projectId: ProjectId, connectionId: ConnectionId, externalId: string): Promise<BoardId> =>
  boardIdSchema.parse((await test.db.board.create({ data: { organizationId: organizationA, projectId, connectionId, externalId, name: "Board", key: "SAME", statusMap: {} }, select: { id: true } })).id);

const seedTicket = async (input: { readonly projectId: ProjectId; readonly boardId: BoardId; readonly connectionId: ConnectionId; readonly assigneeId?: string | null; readonly organizationId?: OrganizationId }): Promise<TicketId> => {
  const n = randomUUID().slice(0, 6);
  const row = await test.db.ticket.create({
    data: {
      organizationId: input.organizationId ?? organizationA,
      projectId: input.projectId,
      boardId: input.boardId,
      connectionId: input.connectionId,
      externalId: `ext-${n}`,
      key: `T-${String(parseInt(n, 16) % 100_000)}`,
      title: "Fix the cart total",
      statusId: "10000",
      statusName: "To Do",
      statusCategory: "open",
      url: `https://tracker.invalid/${n}`,
      assigneeId: input.assigneeId ?? null,
      trackerUpdatedAt: new Date(),
    },
    select: { id: true },
  });
  return ticketIdSchema.parse(row.id);
};

const seedTicketTask = async (input: { readonly projectId: ProjectId; readonly boardId: BoardId; readonly ticketId: TicketId }): Promise<TaskId> =>
  taskIdSchema.parse(
    (
      await test.db.task.create({
        data: {
          organizationId: organizationA,
          projectId: input.projectId,
          kind: "code",
          source: "ticket",
          title: "Fix the cart total",
          ticketId: input.ticketId,
          ticketKey: "T-1",
          boardId: input.boardId,
          branchName: `ostra/${randomUUID().slice(0, 8)}-fix-the-cart-total`,
          state: "running",
        },
        select: { id: true },
      })
    ).id,
  );

const setState = (connectionId: ConnectionId, state: DbEnum.ConnectionState) => test.db.connection.update({ where: { id: connectionId }, data: { state } });

const newProject = async (name: string): Promise<ProjectId> =>
  projectIdSchema.parse((await test.db.project.create({ data: { organizationId: organizationA, name, slug: `${name}-${randomUUID().slice(0, 8)}` }, select: { id: true } })).id);

// ---------- the lifecycles ----------

describe("milestone 11's lifecycles (domain-model.md)", () => {
  const at = Date.UTC(2026, 10, 23, 12);
  const into = connectionIdSchema.parse(randomUUID());
  const states: Readonly<Record<TrackerConnectionLifecycle["state"], TrackerConnectionLifecycle>> = {
    pending: { state: "pending" },
    active: { state: "active", activatedAt: at - 1000 },
    failed: { state: "failed", reason: "token-refused" },
    revoked: { state: "revoked", resumedInto: null },
  };
  const inputs: Readonly<Record<TrackerConnectionInput["type"], TrackerConnectionInput>> = {
    activate: { type: "activate", at },
    fail: { type: "fail", reason: "token-expired" },
    revoke: { type: "revoke" },
    resume: { type: "resume", into },
  };

  it("F-152/c5: a connection is pending, then active ⇄ failed, then revoked, and a revoked one resumes into one successor", () => {
    // Every state against every input: the moves the lifecycle draws, and a refusal for the rest.
    const expected: Readonly<Record<TrackerConnectionLifecycle["state"], Readonly<Record<TrackerConnectionInput["type"], TrackerConnectionLifecycle | null>>>> = {
      pending: { activate: { state: "active", activatedAt: at }, fail: null, revoke: { state: "revoked", resumedInto: null }, resume: null },
      active: { activate: null, fail: { state: "failed", reason: "token-expired" }, revoke: { state: "revoked", resumedInto: null }, resume: null },
      failed: { activate: { state: "active", activatedAt: at }, fail: null, revoke: { state: "revoked", resumedInto: null }, resume: null },
      revoked: { activate: null, fail: null, revoke: null, resume: { state: "revoked", resumedInto: into } },
    };
    for (const [state, row] of Object.entries(expected)) {
      for (const [type, next] of Object.entries(row)) {
        const from = Object.values(states).find((candidate) => candidate.state === state);
        const input = Object.values(inputs).find((candidate) => candidate.type === type);
        if (from === undefined || input === undefined) throw new Error("no such state or input");
        expect(transitionTrackerConnection(from, input), `${state} + ${type}`).toEqual(next === null ? { ok: false, reason: `${type} is not allowed in ${state}` } : { ok: true, state: next });
      }
    }
    // Resumed once: a second successor is refused.
    expect(transitionTrackerConnection({ state: "revoked", resumedInto: into }, { type: "resume", into: connectionIdSchema.parse(randomUUID()) }).ok).toBe(false);
  });

  it("F-152/c5: a connection row reads as its lifecycle, state by state", () => {
    const row = { activatedAt: new Date(at), failedReason: "token-refused", resumedIntoId: into };
    expect(trackerConnectionLifecycleOf({ ...row, state: "pending" })).toEqual({ state: "pending" });
    expect(trackerConnectionLifecycleOf({ ...row, state: "active" })).toEqual({ state: "active", activatedAt: at });
    expect(trackerConnectionLifecycleOf({ ...row, state: "failed" })).toEqual({ state: "failed", reason: "token-refused" });
    expect(trackerConnectionLifecycleOf({ ...row, state: "revoked" })).toEqual({ state: "revoked", resumedInto: into });
    expect(trackerConnectionLifecycleOf({ ...row, state: "revoked", resumedIntoId: null })).toEqual({ state: "revoked", resumedInto: null });
  });

  it("F-152/c5: a board is attached while its connection is active, paused while it's pending, failed or revoked, and detached once detached", () => {
    const expected: readonly (readonly [DbEnum.ConnectionState, BoardState])[] = [
      ["active", { state: "attached" }],
      ["failed", { state: "paused", pausedBy: "failed" }],
      ["pending", { state: "paused", pausedBy: "disconnected" }],
      ["revoked", { state: "paused", pausedBy: "disconnected" }],
    ];
    for (const [state, board] of expected) {
      expect(boardStateOf({ detachedAt: null }, { state }), state).toEqual(board);
      // Detached wins over every connection state.
      expect(boardStateOf({ detachedAt: new Date(at) }, { state }), state).toEqual({ state: "detached", detachedAt: at });
    }
    expect(pausedBoardLine({ connectionName: "Globex Jira", kind: "jira", key: "PROJ", pausedBy: "disconnected" })).toBe(
      "Globex Jira was disconnected, so PROJ's tickets stay as they were and nothing moves on Jira.",
    );
  });

  it("F-152/c5: attachedBoardWhere is boardStateOf's attached, as a query, for every connection state", async () => {
    const project = await newProject("where-check");
    const made: { readonly id: BoardId; readonly state: DbEnum.ConnectionState; readonly detached: boolean }[] = [];
    for (const state of ["pending", "active", "failed", "revoked"] as const) {
      const seeded = await seedConnection({ kind: "jira", name: `Where ${state} Jira`, state });
      for (const detached of [false, true]) {
        const id = await seedBoard(project, seeded.connectionId, `where-${state}-${String(detached)}`);
        if (detached) await test.db.board.update({ where: { id }, data: { detachedAt: new Date() } });
        made.push({ id, state, detached });
      }
    }
    const queried = await test.db.board.findMany({ where: { projectId: project, ...attachedBoardWhere }, select: { id: true } });
    const derived = made.filter((board) => boardStateOf({ detachedAt: board.detached ? new Date() : null }, { state: board.state }).state === "attached");
    expect(queried.map((board) => board.id).sort()).toEqual(derived.map((board) => board.id).sort());
    expect(derived).toHaveLength(1);
  });
});

// ---------- F-152/c1: connections of any kind ----------

describe("tracker connections of any kind (F-152/c1)", () => {
  it("F-152/c1: two Linear and two Jira connections in one organization, each named, are listed with their kinds and capabilities; another organization's aren't", async () => {
    const acme = await seedConnection({ kind: "linear", name: "Acme Linear" });
    const northwind = await seedConnection({ kind: "linear", name: "Northwind Linear", state: "failed" });
    const globex = await seedConnection({ kind: "jira", name: "Globex Jira" });
    const initech = await seedConnection({ kind: "jira", name: "Initech Jira", state: "pending" });
    const elsewhere = await seedConnection({ organizationId: organizationB, kind: "linear", name: "Hooli Linear" });
    const gone = await seedConnection({ kind: "jira", name: "Gone Jira", state: "revoked" });
    const board = await attach(openProject, globex, projectOf(globex.site));
    // A GitHub App is a connection too, and no tracker.
    const github = await test.db.connection.create({ data: { organizationId: organizationA, kind: "github", appId: `app-${randomUUID()}` }, select: { id: true } });

    const listed = await trackerConnectionsOf(test.db, organizationA, capabilities);
    const mine = listed.filter((connection) => [acme, northwind, globex, initech].some((seeded) => seeded.connectionId === connection.id));
    expect(mine.map((connection) => [connection.kind, connection.name, connection.state])).toEqual([
      ["linear", "Acme Linear", "active"],
      ["linear", "Northwind Linear", "failed"],
      ["jira", "Globex Jira", "active"],
      ["jira", "Initech Jira", "pending"],
    ]);
    // Each with its kind's capabilities: agent sessions are Linear's, transitions Jira's.
    for (const connection of mine) {
      expect(connection.capabilities).toEqual(connection.kind === "linear" ? linearCapabilities : capabilities.jira);
    }
    expect(mine.find((connection) => connection.kind === "linear")?.capabilities.agentSessions).toBe(true);
    expect(mine.find((connection) => connection.kind === "jira")?.capabilities).toMatchObject({ agentSessions: false, transitions: true });
    // Jira's view: the site, the cloud ID, the service account, the token's date, the read-back.
    const jira = mine.find((connection) => connection.id === globex.connectionId);
    expect(jira).toMatchObject({
      kind: "jira",
      site: "globex.atlassian.net",
      accountEmail: "ostra-bot@serviceaccount.atlassian.com",
      tokenExpiresOn: "2027-03-01",
      workflowsReadable: true,
      boards: [{ id: board.boardId, project: { id: openProject } }],
    });
    expect(jira?.kind === "jira" ? jira.accessCheck?.projects.map((project) => project.key) : null).toEqual(["PROJ"]);
    // Another organization's, a revoked one and the GitHub App are none of them.
    expect(listed.some((connection) => [elsewhere.connectionId, gone.connectionId, github.id].includes(connection.id))).toBe(false);
    expect(await trackerConnectionOf(test.db, organizationA, elsewhere.connectionId, capabilities)).toBeNull();
    expect(await trackerConnectionOf(test.db, organizationA, gone.connectionId, capabilities)).toBeNull();
    expect(await trackerConnectionOf(test.db, organizationA, northwind.connectionId, capabilities)).toMatchObject({ kind: "linear", name: "Northwind Linear", state: "failed" });
  });

  it("F-152/c1: every Linear start makes a new named pending connection, so a second pending one is allowed", async () => {
    const deps = (tx: Parameters<Parameters<typeof test.db.$transaction>[0]>[0]) => ({ tx, scope: admin, corePublicUrl: "https://core.example.com", publicUrl: "https://ostra.example.com", linear: linearKit, ...ports });
    const first = await test.db.$transaction((tx) => startLinearConnection(deps(tx), { name: "Contoso Linear" }));
    const second = await test.db.$transaction((tx) => startLinearConnection(deps(tx), { name: "Fabrikam Linear" }));
    if (!first.ok || !second.ok) throw new Error("a start was refused");
    expect(second.connectionId).not.toBe(first.connectionId);
    const rows = await test.db.connection.findMany({ where: { id: { in: [first.connectionId, second.connectionId] } }, orderBy: { createdAt: "asc" } });
    expect(rows.map((row) => [row.name, row.state, row.appId])).toEqual([
      ["Contoso Linear", "pending", `pending:${first.connectionId}`],
      ["Fabrikam Linear", "pending", `pending:${second.connectionId}`],
    ]);
    expect(rows.every((row) => isPendingAppId(row.appId))).toBe(true);
    // Each its own webhook URL; audited as a connection made.
    expect(first.webhookUrl).toBe(`https://core.example.com/webhooks/linear/${first.connectionId}`);
    expect(await test.db.auditEntry.count({ where: { action: "tracker.connection-created", entityId: { in: [first.connectionId, second.connectionId] } } })).toBe(2);
    // Without a name, the kind's word, numbered past the names already held.
    const unnamed = await test.db.$transaction((tx) => startLinearConnection(deps(tx)));
    const again = await test.db.$transaction((tx) => startLinearConnection(deps(tx)));
    expect([unnamed.ok && unnamed.name, again.ok && again.name]).toEqual(["Linear", "Linear 2"]);
    // Picking up a pending one answers the same connection, not a new one.
    const pickedUp = await test.db.$transaction((tx) => startLinearConnection(deps(tx), { connectionId: first.connectionId }));
    expect(pickedUp.ok && pickedUp.connectionId).toBe(first.connectionId);
  });
});

// ---------- F-152/c2: one per site, one name each ----------

describe("one connection per site, and names (F-152/c2)", () => {
  it("F-152/c2: siteTakenBy finds the holder; a name already used is name-taken; a revoked holder blocks neither", async () => {
    const holder = await seedConnection({ kind: "jira", name: "Umbrella Jira", workspaceId: "cloud-umbrella" });
    expect(await siteTakenBy(test.db, organizationA, "jira", "cloud-umbrella")).toEqual({ id: holder.connectionId, name: "Umbrella Jira" });
    // Another kind, another organization, and the holder itself asking: nobody holds it for them.
    expect(await siteTakenBy(test.db, organizationA, "linear", "cloud-umbrella")).toBeNull();
    expect(await siteTakenBy(test.db, organizationB, "jira", "cloud-umbrella")).toBeNull();
    expect(await siteTakenBy(test.db, organizationA, "jira", "cloud-umbrella", holder.connectionId)).toBeNull();

    // The name, without case: a Linear start under it is refused, naming the holder.
    expect(await nameTakenBy(test.db, organizationA, "  umbrella JIRA ")).toEqual({ id: holder.connectionId, name: "Umbrella Jira" });
    const deps = (tx: Parameters<Parameters<typeof test.db.$transaction>[0]>[0]) => ({ tx, scope: admin, corePublicUrl: null, publicUrl: "https://ostra.example.com", linear: linearKit, ...ports });
    const refused = await test.db.$transaction((tx) => startLinearConnection(deps(tx), { name: "umbrella jira" }));
    expect(refused).toMatchObject({ ok: false, error: "name-taken" });
    expect(refused.ok ? "" : refused.message).toContain("Umbrella Jira");
    expect(await test.db.$transaction((tx) => startLinearConnection(deps(tx), { name: "   " }))).toMatchObject({ ok: false, error: "invalid-name" });

    // Disconnected, it holds neither its site nor its name.
    await setState(holder.connectionId, "revoked");
    expect(await siteTakenBy(test.db, organizationA, "jira", "cloud-umbrella")).toBeNull();
    expect(await nameTakenBy(test.db, organizationA, "Umbrella Jira")).toBeNull();
    const named = await test.db.$transaction((tx) => startLinearConnection(deps(tx), { name: "Umbrella Jira" }));
    expect(named).toMatchObject({ ok: true, name: "Umbrella Jira", mode: "polling", webhookUrl: null });
  });

  it("F-152/c2: a connection's name is prefilled from its site, and is 1 to 60 characters, trimmed", () => {
    expect(defaultConnectionName("jira", "Globex")).toBe("Globex Jira");
    expect(defaultConnectionName("linear", "  Acme  Corp ")).toBe("Acme Corp Linear");
    expect(defaultConnectionName("linear", null)).toBe("Linear");
    expect(defaultConnectionName("jira", "Globex Jira")).toBe("Globex Jira");
    expect(defaultConnectionName("jira", "x".repeat(80))).toHaveLength(60);
    expect(connectionNameSchema.parse("  Globex Jira  ")).toBe("Globex Jira");
    expect(connectionNameSchema.safeParse("   ").success).toBe(false);
    expect(connectionNameSchema.safeParse("x".repeat(61)).success).toBe(false);
  });
});

// ---------- F-152/c3: a board's own connection ----------

describe("each board through its own connection (F-152/c3)", () => {
  it("F-152/c3: with two Jira connections, attach, ingest, ticket sync and rules each use the board's own connection, and one's tracker never serves the other's board", async () => {
    const project = await newProject("isolation");
    const first = await seedConnection({ kind: "jira", name: "Stark Jira" });
    const second = await seedConnection({ kind: "jira", name: "Wayne Jira" });

    // Attach: the board takes the connection it names, through that connection's tracker only.
    const firstBoard = await attach(project, first, projectOf(first.site));
    const secondBoard = await attach(project, second, projectOf(second.site));
    expect((await test.db.board.findUniqueOrThrow({ where: { id: secondBoard.boardId } })).connectionId).toBe(second.connectionId);
    const crossedProject = await newProject("crossed");
    const crossed = await test.db.$transaction((tx) =>
      attachBoard({ tx, scope: admin, tracker: first.tracker, ...ports }, { projectId: crossedProject, connectionId: second.connectionId, externalId: projectOf(second.site) }),
    );
    expect(crossed).toMatchObject({ ok: false, error: "no-connection" });
    // The second site's board ID, under the first connection, is a team the first can't see.
    expect(await test.db.$transaction((tx) => attachBoard({ tx, scope: admin, tracker: first.tracker, ...ports }, { projectId: project, connectionId: first.connectionId, externalId: projectOf(second.site) }))).toMatchObject({
      ok: false,
      error: "not-found",
    });

    // The same external ID under the second connection: a board of its own, which the first's poll and ingest never touch.
    const twinProject = await newProject("twin");
    const twin = await seedBoard(twinProject, second.connectionId, projectOf(first.site));
    expect((await boardsOnSameTeam(test.db, firstBoard.boardId)).map((board) => board.id)).toEqual([firstBoard.boardId]);
    const issue = first.site.createIssue(projectOf(first.site), { summary: "Total is off by one" });
    const ingested = await ingestTicketHint(
      { db: test.db, tracker: first.tracker, notices: postgresChangeNotices, clock: systemClock },
      { source: "webhook", hint: { event: "jira:issue_created", subject: "ticket", action: "create", ticketExternalId: issue.externalId, ticketKey: issue.key, boardExternalId: projectOf(first.site), byOwnUser: false } },
    );
    expect(ingested).toMatchObject({ ok: true, outcome: "upserted" });
    const copies = await test.db.ticket.findMany({ where: { externalId: externalTicketIdSchema.parse(issue.externalId) }, select: { boardId: true, connectionId: true } });
    expect(copies).toEqual([{ boardId: firstBoard.boardId, connectionId: first.connectionId }]);
    expect(await test.db.ticket.count({ where: { boardId: twin } })).toBe(0);
    // The second connection's tracker can't read the first site's ticket at all.
    expect(await ingestTicketHint(
      { db: test.db, tracker: second.tracker, notices: postgresChangeNotices, clock: systemClock },
      { source: "webhook", hint: { event: "jira:issue_updated", subject: "ticket", action: "update", ticketExternalId: issue.externalId, ticketKey: issue.key, boardExternalId: null, byOwnUser: false } },
    )).toMatchObject({ ok: true, outcome: "not-on-a-board" });

    // Ticket sync: a task on the second board writes to the second board, whose connection the writer uses.
    const onSecond = await seedTicket({ projectId: project, boardId: secondBoard.boardId, connectionId: second.connectionId });
    const task = await seedTicketTask({ projectId: project, boardId: secondBoard.boardId, ticketId: onSecond });
    const written = await test.db.$transaction((tx) => writeTicketStepsInTx({ tx }, { taskId: task, trigger: { kind: "task-started", taskUrl: "https://ostra.example.com/tasks/1", taskTitle: "x" } }));
    expect(written.length).toBeGreaterThan(0);
    const writes = await test.db.ticketWrite.findMany({ where: { taskId: task }, select: { board: { select: { connectionId: true } } } });
    expect(writes.every((row) => row.board.connectionId === second.connectionId)).toBe(true);
    // Its mapping is saved through its own connection's tracker, never the other's.
    const mapping = secondBoard.mapping;
    expect(await test.db.$transaction((tx) => saveBoardMapping({ tx, scope: admin, tracker: first.tracker, ...ports }, { boardId: secondBoard.boardId, mapping }))).toMatchObject({ ok: false, error: "tracker-failed" });
    expect(await test.db.$transaction((tx) => saveBoardMapping({ tx, scope: admin, tracker: second.tracker, ...ports }, { boardId: secondBoard.boardId, mapping }))).toMatchObject({ ok: true });

    // Rules: "assigned to ostra" is each board's own connection's service account.
    const filter = intakeFilterSchema.parse({ assignees: [{ kind: "app" }] });
    const mineOnFirst = await seedTicket({ projectId: project, boardId: firstBoard.boardId, connectionId: first.connectionId, assigneeId: first.site.appAccountId });
    const firstsOnSecond = await seedTicket({ projectId: project, boardId: secondBoard.boardId, connectionId: second.connectionId, assigneeId: first.site.appAccountId });
    const mineOnSecond = await seedTicket({ projectId: project, boardId: secondBoard.boardId, connectionId: second.connectionId, assigneeId: second.site.appAccountId });
    const dry = await dryRunAutomation({ db: test.db }, admin, { projectId: project, filter, automationId: null });
    expect(dry.ok && dry.rows.map((row) => row.ticketId).sort()).toEqual([mineOnFirst, mineOnSecond].sort());
    expect(dry.ok && dry.rows.some((row) => row.ticketId === firstsOnSecond)).toBe(false);
    // An intake rule's match runs the start for the matching ticket only (the ticket's active task skips it, as has_task).
    const rule = automationIdSchema.parse(
      (await test.db.automation.create({ data: { organizationId: organizationA, projectId: project, kind: "intake_rule", name: "Delegated", taskKind: "code", poolLabels: [], filter: { assignees: [{ kind: "app" }] } }, select: { id: true } })).id,
    );
    await seedTicketTask({ projectId: project, boardId: firstBoard.boardId, ticketId: mineOnFirst });
    await seedTicketTask({ projectId: project, boardId: secondBoard.boardId, ticketId: firstsOnSecond });
    const matched = await test.db.$transaction((tx) => matchIntakeRules({ tx, ...ports }, { organizationId: organizationA, ticketId: mineOnFirst, trackerUpdatedAt: Date.now() }));
    expect(matched).toEqual({ started: [], skipped: [{ automationId: rule, reason: "has_task" }] });
    const notMatched = await test.db.$transaction((tx) => matchIntakeRules({ tx, ...ports }, { organizationId: organizationA, ticketId: firstsOnSecond, trackerUpdatedAt: Date.now() }));
    expect(notMatched).toEqual({ started: [], skipped: [] });
    await test.db.automation.update({ where: { id: rule }, data: { deletedAt: new Date() } });
  });

  it("F-152/c3: the domain looks no connection up by its kind outside Linear's own files", async () => {
    const root = import.meta.dirname;
    const sources = async (dir: string): Promise<readonly string[]> => {
      const found: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...(await sources(full)));
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(full);
      }
      return found;
    };
    // A query's `where` that names the kind `linear` (one level of nested braces deep).
    const byKind = /where:\s*\{(?:[^{}]|\{[^{}]*\})*kind:\s*"linear"/;
    const withKind: string[] = [];
    for (const file of await sources(root)) {
      if (byKind.test(await readFile(file, "utf8"))) withKind.push(path.relative(root, file).split(path.sep).join("/"));
    }
    // Linear's own flows only: its connection's steps and agent mode, each a lookup by the
    // connection's ID with the kind as its guard. Nothing finds "the organization's Linear".
    expect(withKind.sort()).toEqual(["use-cases/agent-mode.ts", "use-cases/linear-connection.ts"]);
  });
});

// ---------- F-152/c4: boards from any connection ----------

describe("boards from any active connection (F-152/c4)", () => {
  it("F-152/c4: one project attaches boards of two connections of two kinds; a connection that isn't active can't attach one", async () => {
    const project = await newProject("mixed");
    const linear = await seedConnection({ kind: "linear", name: "Oscorp Linear" });
    const jira = await seedConnection({ kind: "jira", name: "Cyberdyne Jira" });
    const fromLinear = await attach(project, linear, projectOf(linear.site));
    const fromJira = await attach(project, jira, projectOf(jira.site));
    const boards = await test.db.board.findMany({ where: { projectId: project }, orderBy: { createdAt: "asc" }, select: { id: true, connection: { select: { kind: true, name: true } } } });
    expect(boards).toEqual([
      { id: fromLinear.boardId, connection: { kind: "linear", name: "Oscorp Linear" } },
      { id: fromJira.boardId, connection: { kind: "jira", name: "Cyberdyne Jira" } },
    ]);
    expect(await test.db.auditEntry.findFirst({ where: { action: "board.attached", projectId: project, data: { path: ["boardId"], equals: fromJira.boardId } }, select: { data: true } })).toMatchObject({
      data: { connectionId: jira.connectionId, kind: "jira" },
    });

    // Pending, failed or revoked: its board can't be attached.
    for (const state of ["pending", "failed", "revoked"] as const) {
      const other = await seedConnection({ kind: "jira", name: `Tyrell ${state} Jira`, state });
      const refused = await test.db.$transaction((tx) => attachBoard({ tx, scope: admin, tracker: other.tracker, ...ports }, { projectId: project, connectionId: other.connectionId, externalId: projectOf(other.site) }));
      expect(refused, state).toMatchObject({ ok: false, error: "no-connection" });
    }
    // Another organization's connection isn't one of this organization's.
    const theirs = await seedConnection({ organizationId: organizationB, kind: "jira", name: "Soylent Jira" });
    expect(await test.db.$transaction((tx) => attachBoard({ tx, scope: admin, tracker: theirs.tracker, ...ports }, { projectId: project, connectionId: theirs.connectionId, externalId: projectOf(theirs.site) }))).toMatchObject({
      ok: false,
      error: "no-connection",
    });
  });
});

// ---------- F-152/c5: paused boards, and resume ----------

describe("paused boards, and resume (F-152/c5)", () => {
  it("F-152/c5: a disconnected or failed connection's boards are paused, and rules, schedules, prompt tickets, starts and ticket sync skip them", async () => {
    const project = await newProject("paused");
    const live = await seedConnection({ kind: "jira", name: "Massive Jira" });
    const failing = await seedConnection({ kind: "jira", name: "Aperture Jira" });
    const liveBoard = await attach(project, live, projectOf(live.site));
    const pausedBoard = await attach(project, failing, projectOf(failing.site));
    const onLive = await seedTicket({ projectId: project, boardId: liveBoard.boardId, connectionId: live.connectionId, assigneeId: live.site.appAccountId });
    const onPaused = await seedTicket({ projectId: project, boardId: pausedBoard.boardId, connectionId: failing.connectionId, assigneeId: failing.site.appAccountId });
    const pausedTask = await seedTicketTask({ projectId: project, boardId: pausedBoard.boardId, ticketId: onPaused });
    expect(await setPromptTickets({ db: test.db, ...ports }, admin, { projectId: project, boardId: pausedBoard.boardId })).toMatchObject({ ok: true });
    expect(await promptTicketBoardViewInTx(test.db, organizationA, project)).toMatchObject({ id: pausedBoard.boardId });

    await setState(failing.connectionId, "failed");
    const board = await test.db.board.findUniqueOrThrow({ where: { id: pausedBoard.boardId }, include: { connection: { select: { state: true } } } });
    expect(boardStateOf(board, board.connection)).toEqual({ state: "paused", pausedBy: "failed" });

    // Schedules and dry runs: only the attached board's tickets.
    const open = await openAttachedTicketsInTx(test.db, { organizationId: organizationA, projectId: project, order: "asc" });
    expect(open.map((ticket) => ticket.id)).toEqual([onLive]);
    const filter = intakeFilterSchema.parse({ assignees: [{ kind: "app" }] });
    const dry = await dryRunAutomation({ db: test.db }, admin, { projectId: project, filter, automationId: null });
    expect(dry.ok && dry.rows.map((row) => row.ticketId)).toEqual([onLive]);
    // An intake rule's match: nothing for the paused board's ticket, not even a run.
    const rule = (await test.db.automation.create({ data: { organizationId: organizationA, projectId: project, kind: "intake_rule", name: "Delegated", taskKind: "code", poolLabels: [], filter: { assignees: [{ kind: "app" }] } }, select: { id: true } })).id;
    expect(await test.db.$transaction((tx) => matchIntakeRules({ tx, ...ports }, { organizationId: organizationA, ticketId: onPaused, trackerUpdatedAt: Date.now() }))).toEqual({ started: [], skipped: [] });
    expect(await test.db.automationRun.count({ where: { automationId: rule } })).toBe(0);
    await test.db.automation.update({ where: { id: rule }, data: { deletedAt: new Date() } });
    // Prompt tickets: the board keeps the setting, and New task gets none while it's paused.
    expect(await promptTicketBoardViewInTx(test.db, organizationA, project)).toBeNull();
    expect((await test.db.board.findUniqueOrThrow({ where: { id: pausedBoard.boardId } })).ticketsForPromptTasks).toBe(true);
    expect(await setPromptTickets({ db: test.db, ...ports }, admin, { projectId: project, boardId: pausedBoard.boardId })).toMatchObject({ ok: false, error: "no-such-board" });
    expect(await setPromptTickets({ db: test.db, ...ports }, admin, { projectId: project, boardId: liveBoard.boardId })).toMatchObject({ ok: true, boardId: liveBoard.boardId });
    // The Inbox's start (and every start): the paused board's ticket starts nothing; the live one's gets past its board.
    const start = (ticketId: TicketId) =>
      test.db.$transaction((tx) =>
        startTask({ tx, ...ports }, { organizationId: organizationA, projectId: project, origin: { kind: "member", memberId: admin.memberId }, kind: "code", ticketId, prompt: null, title: null, agentProfileId: null, poolLabels: [] }),
      );
    const paused = await start(onPaused);
    expect(paused).toMatchObject({ ok: false, error: "not-found" });
    expect(paused.ok ? "" : paused.message).toContain("paused");
    expect(await start(onLive)).not.toMatchObject({ ok: false, error: "not-found" });
    // Ticket sync: nothing is written to a paused board's ticket; its mapping reads only.
    expect(await test.db.$transaction((tx) => writeTicketStepsInTx({ tx }, { taskId: pausedTask, trigger: { kind: "progress", reason: "state", revision: "running:1" } }))).toEqual([]);
    expect(await test.db.$transaction((tx) => saveBoardMapping({ tx, scope: admin, tracker: failing.tracker, ...ports }, { boardId: pausedBoard.boardId, mapping: pausedBoard.mapping }))).toMatchObject({
      ok: false,
      error: "board-paused",
    });

    // Disconnected is paused too; fixed, it's attached again.
    await setState(failing.connectionId, "revoked");
    expect(boardStateOf({ detachedAt: null }, (await test.db.connection.findUniqueOrThrow({ where: { id: failing.connectionId } })))).toEqual({ state: "paused", pausedBy: "disconnected" });
    await setState(failing.connectionId, "active");
    expect((await openAttachedTicketsInTx(test.db, { organizationId: organizationA, projectId: project, order: "asc" })).map((ticket) => ticket.id).sort()).toEqual([onLive, onPaused].sort());
  });

  it("F-152/c5: resumeBoardsInTx moves a revoked connection's paused boards and their tickets to the new connection of its site, and no other's", async () => {
    const project = await newProject("resume");
    const site = createJiraSite({ projectKey: "RES" });
    const old = await seedConnection({ kind: "jira", name: "Old Jira", workspaceId: "cloud-resume", site });
    const otherSite = await seedConnection({ kind: "jira", name: "Other Jira", workspaceId: "cloud-other" });
    const theirs = await seedConnection({ organizationId: organizationB, kind: "jira", name: "Their Jira", workspaceId: "cloud-resume" });
    const oldBoard = await attach(project, old, projectOf(site));
    const detached = await seedBoard(project, old.connectionId, "detached-team");
    await test.db.board.update({ where: { id: detached }, data: { detachedAt: new Date() } });
    const otherBoard = await attach(project, otherSite, projectOf(otherSite.site));
    const theirBoard = boardIdSchema.parse(
      (await test.db.board.create({ data: { organizationId: organizationB, projectId: fixture.b.project.id, connectionId: theirs.connectionId, externalId: projectOf(site), name: "Board", statusMap: {} }, select: { id: true } })).id,
    );
    await test.db.board.update({ where: { id: oldBoard.boardId }, data: { pollCursor: new Date("2026-11-20T10:00:00Z") } });
    const ticket = await seedTicket({ projectId: project, boardId: oldBoard.boardId, connectionId: old.connectionId });
    for (const seeded of [old, otherSite, theirs]) await setState(seeded.connectionId, "revoked");

    // The same site connected again: active, and the transaction that made it so resumes its boards.
    const next = await seedConnection({ kind: "jira", name: "New Jira", workspaceId: "cloud-resume", site });
    const resumed = await test.db.$transaction((tx) => resumeBoardsInTx({ tx, ...ports }, { organizationId: organizationA, connectionId: next.connectionId, actor: { kind: "member", id: admin.memberId } }));
    expect(resumed).toEqual({ boards: 1, from: [old.connectionId] });
    const moved = await test.db.board.findUniqueOrThrow({ where: { id: oldBoard.boardId }, include: { connection: { select: { state: true } } } });
    // Its mapping and its cursor kept, attached again.
    expect(moved).toMatchObject({ connectionId: next.connectionId, pollCursor: new Date("2026-11-20T10:00:00Z") });
    expect(boardStateOf(moved, moved.connection)).toEqual({ state: "attached" });
    expect((await test.db.ticket.findUniqueOrThrow({ where: { id: ticket } })).connectionId).toBe(next.connectionId);
    // The old row keeps its history, naming its successor.
    expect((await test.db.connection.findUniqueOrThrow({ where: { id: old.connectionId } })).resumedIntoId).toBe(next.connectionId);
    // Another site's board, a detached board, and another organization's board of the same site stay.
    expect((await test.db.board.findUniqueOrThrow({ where: { id: otherBoard.boardId } })).connectionId).toBe(otherSite.connectionId);
    expect((await test.db.board.findUniqueOrThrow({ where: { id: detached } })).connectionId).toBe(old.connectionId);
    expect((await test.db.board.findUniqueOrThrow({ where: { id: theirBoard } })).connectionId).toBe(theirs.connectionId);
    expect((await test.db.connection.findUniqueOrThrow({ where: { id: theirs.connectionId } })).resumedIntoId).toBeNull();
    // Audited with IDs and the count only.
    expect(await test.db.auditEntry.findFirst({ where: { action: "tracker.resumed", entityId: next.connectionId }, select: { data: true, organizationId: true } })).toEqual({
      organizationId: organizationA,
      data: { boards: 1, from: 1 },
    });
    // Nothing more to resume: a second call moves nothing, and audits nothing.
    expect(await test.db.$transaction((tx) => resumeBoardsInTx({ tx, ...ports }, { organizationId: organizationA, connectionId: next.connectionId, actor: { kind: "system", id: null } }))).toEqual({
      boards: 0,
      from: [],
    });
    expect(await test.db.auditEntry.count({ where: { action: "tracker.resumed", entityId: next.connectionId } })).toBe(1);
  });
});

// ---------- F-152/c7: the setup step ----------

describe("Home's tracker step (F-152/c7)", () => {
  it("F-152/c7: the tracker step is done with any active connection of either kind, pending or failed by the newest, open or skipped otherwise", () => {
    const step = (connections: readonly { readonly state: DbEnum.ConnectionState; readonly createdAt: number }[], skipped: { readonly tracker?: number; readonly linear?: number } = {}) =>
      trackerSetupStepOf({ connections, trackerSkippedAt: skipped.tracker ?? null, linearSkippedAt: skipped.linear ?? null });
    expect(step([])).toBe("open");
    expect(step([], { tracker: 1 })).toBe("skipped");
    // Skipped before milestone 11: only Linear's column, still skipped.
    expect(step([], { linear: 1 })).toBe("skipped");
    expect(step([{ state: "pending", createdAt: 1 }], { tracker: 1 })).toBe("pending");
    expect(step([{ state: "pending", createdAt: 1 }, { state: "failed", createdAt: 2 }])).toBe("failed");
    expect(step([{ state: "failed", createdAt: 1 }, { state: "pending", createdAt: 2 }])).toBe("pending");
    expect(step([{ state: "failed", createdAt: 1 }, { state: "active", createdAt: 0 }], { tracker: 1, linear: 1 })).toBe("done");
    expect(step([{ state: "revoked", createdAt: 5 }], { tracker: 1 })).toBe("skipped");
    // The timeline counts either kind's connection, and Linear's old entry.
    const entries = (action: string) => [{ organizationId: organizationA, action, createdAt: 7 }];
    for (const action of ["tracker.connected", "linear.connected"]) {
      expect(setupTimeline(organizationA, { start: 0, entries: entries(action), firstPullRequestOpenedAt: null }).steps.find((row) => row.step === "tracker")).toMatchObject({ state: "done", at: 7, optional: true });
    }
  });

  it("F-152/c7: skipping writes both columns, an organization that skipped Linear reads skipped, and an active connection of either kind makes it done", async () => {
    const organizationId = organizationIdSchema.parse(randomUUID());
    await test.db.organization.create({ data: { id: organizationId, name: "Setup", slug: `setup-${organizationId.slice(0, 8)}`, createdAt: new Date() } });
    const scope: MemberScope = { ...admin, organizationId };
    // Open, while organizations A and B hold active connections: theirs count for nothing here.
    expect(await trackerSetupStepInTx(test.db, organizationId)).toBe("open");
    // The panel's word until its checklist changes (`linear`) and the new one both skip the one step.
    const skipped = await test.db.$transaction((tx) => skipSetupStep({ tx, scope, ...ports }, { step: "linear" }));
    expect(skipped.ok).toBe(true);
    const setting = await test.db.organizationSetting.findUniqueOrThrow({ where: { organizationId } });
    expect([setting.trackerSkippedAt?.getTime(), setting.linearSkippedAt?.getTime()]).toEqual([skipped.ok && skipped.skippedAt, skipped.ok && skipped.skippedAt]);
    expect(await trackerSetupStepInTx(test.db, organizationId)).toBe("skipped");
    // An organization that skipped Linear's step before milestone 11 (only its column) reads skipped.
    await test.db.organizationSetting.update({ where: { organizationId }, data: { trackerSkippedAt: null } });
    expect(await trackerSetupStepInTx(test.db, organizationId)).toBe("skipped");
    expect((await test.db.$transaction((tx) => skipSetupStep({ tx, scope: { ...scope, role: "member" }, ...ports }, { step: "tracker" }))).ok).toBe(false);
    // A pending Jira connection, then an active one: done, whatever was skipped.
    const jira = await seedConnection({ organizationId, kind: "jira", name: "Setup Jira", state: "pending" });
    expect(await trackerSetupStepInTx(test.db, organizationId)).toBe("pending");
    await setState(jira.connectionId, "active");
    expect(await trackerSetupStepInTx(test.db, organizationId)).toBe("done");
  });
});

// ---------- F-008/c7, F-008/c5: Jira's mapping ----------

describe("Jira's mapping (F-008/c7)", () => {
  it("F-008/c7: a Jira board's drafted mapping moves Done by ostra, even with its GitHub integration installed", async () => {
    const jira = await seedConnection({ kind: "jira", name: "Gringotts Jira" });
    jira.site.devPanelInstalled = true;
    const attached = await attach(await newProject("jira-draft"), jira, projectOf(jira.site));
    expect(attached).toMatchObject({ integrationInstalled: true, mapping: { started: "10001", inReview: "10002", done: "10003", doneBy: "ostra" } });
    // A tracker that sets statuses (Linear) leaves Done to its installed integration, as before.
    const statuses = await jira.tracker.tracker.listStatuses({ externalId: projectOf(jira.site) });
    if (!statuses.ok) throw new Error("no statuses");
    expect(draftBoardMapping(statuses.value, { installed: true })).toMatchObject({ ok: true, mapping: { doneBy: "integration" } });
    expect(draftBoardMapping(statuses.value, { installed: true, transitions: true })).toMatchObject({ ok: true, mapping: { doneBy: "ostra" } });
  });

  it("F-008/c7: mappingReachability gives each step's transition lines and its unreachable statuses, from the board's own workflow", async () => {
    const jira = await seedConnection({ kind: "jira", name: "Hogwarts Jira" });
    const attached = await attach(await newProject("jira-reach"), jira, projectOf(jira.site));
    const workflow = await jira.tracker.tracker.readWorkflow({ externalId: projectOf(jira.site) });
    if (!workflow.ok) throw new Error("no workflow");
    // To Do → Start → In Progress → Review → In Review → Done; Back to work; Won't do from anywhere; Reopen.
    expect(mappingReachability(workflow.value, attached.mapping)).toEqual({
      readable: true,
      steps: [
        {
          step: "started",
          target: "10001",
          by: [
            { transition: { id: "11", name: "Start" }, from: ["10000"] },
            { transition: { id: "31", name: "Back to work" }, from: ["10002"] },
            { transition: { id: "61", name: "Reopen" }, from: ["10003", "10004"] },
          ],
          unreachable: [],
        },
        {
          step: "inReview",
          target: "10002",
          by: [
            { transition: { id: "11", name: "Start" }, from: ["10000"] },
            { transition: { id: "21", name: "Review" }, from: ["10001"] },
            { transition: { id: "61", name: "Reopen" }, from: ["10003", "10004"] },
          ],
          unreachable: [],
        },
        {
          step: "done",
          target: "10003",
          by: [
            { transition: { id: "11", name: "Start" }, from: ["10000"] },
            { transition: { id: "21", name: "Review" }, from: ["10001"] },
            { transition: { id: "41", name: "Done" }, from: ["10002"] },
          ],
          // Won't Do is four transitions from Done: past the three a move takes.
          unreachable: ["10004"],
        },
      ],
    });
    // A token that can't read workflows: no lines, no warnings.
    const blind = await new JiraFakeAdapter({ site: jira.site, workflowAccess: false }).readWorkflow({ externalId: projectOf(jira.site) });
    if (!blind.ok) throw new Error("no statuses");
    expect(mappingReachability(blind.value, attached.mapping)).toEqual({ readable: false });
  });

  it("F-008/c7: a global transition reads `from any status`, and a status no transition leaves toward a step is its warning", () => {
    const status = (id: string, category: "open" | "started" | "done") => ({ id, name: id, category, vendorType: category, position: 0 });
    const workflow: TrackerWorkflow = {
      readable: true,
      statuses: [status("todo", "open"), status("doing", "started"), status("blocked", "started"), status("review", "started"), status("done", "done")],
      transitions: [
        { id: "1", name: "Start", from: ["todo"], to: "doing" },
        { id: "2", name: "Ready for review", from: ["doing"], to: "review" },
        { id: "3", name: "Block", from: ["doing"], to: "blocked" },
        { id: "4", name: "Finish", from: "any", to: "done" },
      ],
    };
    const mapping: BoardMapping = { open: ["todo"], started: "doing", inReview: "review", done: "done", ready: "todo", doneBy: "ostra", magicWord: "Closes" };
    const reach = mappingReachability(workflow, mapping);
    if (!reach.readable) throw new Error("readable");
    expect(reach.steps.find((step) => step.step === "inReview")).toEqual({
      step: "inReview",
      target: "review",
      by: [
        { transition: { id: "1", name: "Start" }, from: ["todo"] },
        { transition: { id: "2", name: "Ready for review" }, from: ["doing"] },
      ],
      // Blocked's only way out is to Done, past which no route goes on.
      unreachable: ["blocked", "done"],
    });
    expect(reach.steps.find((step) => step.step === "done")).toEqual({ step: "done", target: "done", by: [{ transition: { id: "4", name: "Finish" }, from: "any" }], unreachable: [] });
    // A step a project admin set (`ready`) is read too; one left unset isn't.
    expect(reach.steps.map((step) => step.step)).toEqual(["started", "inReview", "done", "ready"]);
  });

  it("F-008/c5: a move no route reaches says so in the progress comment's words", () => {
    expect(movedNot({ key: "PROJ-12", from: "Blocked", to: "In Review" })).toBe("PROJ-12 stays in Blocked: no transition in its workflow reaches In Review.");
  });
});
