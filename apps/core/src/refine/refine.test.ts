import { randomBytes, randomUUID } from "node:crypto";

import { silentLogger } from "@ostra/adapter-sdk";
import type { TrackerAdapter } from "@ostra/adapter-sdk";
import { LinearAdapter } from "@ostra/adapter-linear";
import { createFakeLinear, createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import type { FakeLinear, JiraSite } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  addDraftImage,
  applyDraft,
  archiveAgentProfile,
  editDraft,
  markTicketReady,
  parseBoardMapping,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  recordWorkSaved,
  startTicketTask,
  systemClock,
} from "@ostra/domain";
import type { MemberScope, Ports } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  agentProfileIdSchema,
  boxIdSchema,
  draftIdSchema,
  ticketIdSchema,
  connectionIdSchema,
  externalTicketIdSchema,
  leaseEpochSchema,
  memberIdSchema,
  runnerIdSchema,
  sessionIdSchema,
  ticketKeySchema,
  ticketWriteIdSchema,
} from "@ostra/protocol";
import type {
  BoardId,
  ConnectionId,
  OrganizationId,
  ProjectId,
  RefineDraft,
  TaskEventOf,
  TaskId,
} from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAccessTokens } from "../gateway/access-token.ts";
import { createTaskTokens } from "../gateway/task-token.ts";
import { handleDraftEndpoint } from "../runner-http/draft.ts";
import { createCoreServer } from "../server.ts";
import type { CoreServer } from "../server.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { mappingFor, seedBoard } from "../testing/tickets.ts";
import { jobContext } from "../testing/turns.ts";
import { seedOnlineRunner, seedWorld } from "../testing/world.ts";
import { createConnectionTrackers } from "../tracker/connections.ts";
import { ticketSyncHandler } from "../tracker/writer.ts";
import { draftApplyHandler, enqueueBuiltInProfileSeeds, seedProfilesHandler } from "./apply.ts";

// Milestone 6's ticket 15 (F-099, F-036): refine drafts, end to end on core's real code against
// Postgres. A refine task starts from a ticket on the project's built-in Refine profile; its
// sidecar's `submit_draft` reaches `POST /runner/v1/tasks/:taskId/draft` with the task token; the
// turn's end puts it in front of its owner; a member's "Update ticket" goes out through
// `draft.apply` (the shipped Linear adapter against the fake Linear, and the Jira fake), and "Mark
// ready" through milestone 2's ticket outbox.

const PUBLIC_URL = "https://ostra.example";

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let fake: FakeLinear;
let site: JiraSite;
let organizationId: OrganizationId;
let projectId: ProjectId;
let linearConnection: ConnectionId;
let jiraConnection: ConnectionId;
let linearBoard: BoardId;
let jiraBoard: BoardId;
let readyStatusId: string;
let endpointUrl: string;
let server: CoreServer;
const secretStore = new FakeSecretStore();
const codeHost = new FakeCodeHost();
const taskTokens = createTaskTokens(randomBytes(32));
const blobBytes = new Map<string, Uint8Array>();
let jiraAdapter: JiraFakeAdapter;
let useJira = false;

const trackers = () =>
  createConnectionTrackers({
    db: test.db,
    secretStore,
    clock: systemClock,
    logger: silentLogger,
    build: (input): TrackerAdapter | null => {
      // One tracker connection per organization: the Jira cases switch what it is.
      if (useJira) return jiraAdapter;
      return new LinearAdapter(
        { apiUrl: fake.apiUrl, auth: { kind: "oauth", token: input.token } },
        input.context,
      );
    },
  });

const ports = (): Ports => ({
  jobs,
  outbox: postgresCommandOutbox,
  notices: postgresChangeNotices,
  audit: postgresAuditLog,
  clock: systemClock,
  adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
});

const scopeOf = (member: SeededMember, role: "admin" | "member" = "member"): MemberScope => ({
  organizationId: member.organizationId,
  memberId: memberIdSchema.parse(member.id),
  role,
  projectRoles: new Map(),
});

const draft = (overrides: Partial<RefineDraft> = {}): RefineDraft => ({
  description: "Make the footer load in under a second. `rm -rf /` is not the fix.",
  acceptanceCriteria: ["The footer renders in under 1 s", "No layout shift"],
  edgeCases: ["An empty footer"],
  openQuestions: ["Should the old footer stay behind a flag?"],
  subTickets: [
    { title: "Measure the footer", description: "Add a timing mark." },
    { title: "Lazy-load the footer's images", description: "Use loading=lazy." },
  ],
  ...overrides,
});

/** A ticket in the tracker, cached on the board as milestone 2's ingest caches it. */
const ticketOn = async (
  board: "linear" | "jira",
): Promise<{
  readonly ticketId: ReturnType<typeof ticketIdSchema.parse>;
  readonly externalId: string;
}> => {
  const made =
    board === "linear"
      ? await fake
          .createIssue({ title: "Speed up the footer", description: "It's slow." })
          .then((issue) => ({ externalId: issue.id, key: issue.identifier }))
      : site.createIssue(site.projects[0]?.id ?? "", {
          summary: "Speed up the footer",
          description: "It's slow.",
        });
  const row = await test.db.ticket.create({
    data: {
      organizationId,
      projectId,
      boardId: board === "linear" ? linearBoard : jiraBoard,
      connectionId: board === "linear" ? linearConnection : jiraConnection,
      externalId: made.externalId,
      key: made.key,
      title: "Speed up the footer",
      description: "It's slow.",
      statusId: "st",
      statusName: "Todo",
      statusCategory: "open",
      open: true,
      labels: [],
      url: `https://tracker.example/${made.key}`,
      trackerUpdatedAt: new Date(),
    },
    select: { id: true },
  });
  return { ticketId: ticketIdSchema.parse(row.id), externalId: made.externalId };
};

/** A member's refine task on a ticket, leased to a docker box with a task token for its sidecar. */
const refineTask = async (
  board: "linear" | "jira" = "linear",
  kind: "refine" | "code" = "refine",
) => {
  const ticket = await ticketOn(board);
  const started = await test.db.$transaction((tx) =>
    startTicketTask(
      { tx, scope: scopeOf(fixture.a.member), publicUrl: PUBLIC_URL, ...ports() },
      { projectId, ticketId: ticket.ticketId, kind },
    ),
  );
  if (!started.ok) throw new Error(`start: ${started.message}`);
  const taskId = started.taskId;
  const runner = await seedOnlineRunner(test.db, organizationId, {
    kind: "personal",
    memberId: fixture.a.member.id,
  });
  const box = await test.db.box.create({
    data: {
      organizationId,
      projectId,
      taskId,
      runnerId: runner.runnerId,
      executor: "docker",
      state: "preparing",
    },
  });
  await test.db.lease.create({
    data: {
      organizationId,
      projectId,
      taskId,
      epoch: 1,
      runnerId: runner.runnerId,
      boxId: box.id,
      state: "active",
    },
  });
  await test.db.task.update({
    where: { id: taskId },
    data: { leaseEpoch: 1, state: "running", prompt: "The refine prompt." },
  });
  await test.db.session.update({
    where: { id: started.sessionId },
    data: { boxId: box.id, state: "running" },
  });
  const token = taskTokens.issue({
    organizationId,
    taskId,
    leaseEpoch: leaseEpochSchema.parse(1),
    boxId: boxIdSchema.parse(box.id),
    runnerId: runnerIdSchema.parse(runner.runnerId),
  });
  return { taskId, sessionId: started.sessionId, token, ticket };
};

const submit = async (taskId: TaskId, token: string, sent: unknown) => {
  const response = await fetch(`${endpointUrl}/runner/v1/tasks/${taskId}/draft`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(sent),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
};

/** The runner's `session.saved` after a turn, stored as ingest stores it, then acted on. */
const turnEnds = async (taskId: TaskId, sessionId: string) =>
  test.db.$transaction(async (tx) => {
    const counter = await tx.task.update({
      where: { id: taskId },
      data: { eventSeq: { increment: 1 } },
      select: { eventSeq: true },
    });
    const event: TaskEventOf<"session.saved"> = {
      kind: "session.saved",
      turnOrdinal: 1,
      repos: [],
      archive: null,
    };
    await tx.event.create({
      data: {
        organizationId,
        projectId,
        taskId,
        seq: counter.eventSeq,
        sessionId,
        sessionSeq: 1,
        leaseEpoch: 1,
        kind: "session.saved",
        payload: event,
        occurredAt: new Date(),
      },
    });
    return recordWorkSaved(
      { tx, jobs, notices: postgresChangeNotices, clock: systemClock },
      {
        organizationId,
        taskId,
        sessionId: sessionIdSchema.parse(sessionId),
        event,
        eventSeq: counter.eventSeq,
      },
    );
  });

const runApply = (draftId: string, version: number, retryCount = 0) =>
  draftApplyHandler({
    db: test.db,
    trackers: trackers(),
    notices: postgresChangeNotices,
    clock: systemClock,
    publicUrl: PUBLIC_URL,
    logger: silentLogger,
    readBlob: (_organizationId, blobId) => Promise.resolve(blobBytes.get(blobId) ?? null),
  })({
    ...jobContext(
      "draft.apply",
      { organizationId, draftId: draftIdSchema.parse(draftId), version },
      silentLogger,
    ),
    retryCount,
  });

const linearTicket = async (externalId: string) => {
  const adapter = new LinearAdapter({
    apiUrl: fake.apiUrl,
    auth: { kind: "oauth", token: fake.mintToken("app").accessToken },
  });
  const read = await adapter.getTicketContext(
    { externalId: fake.team.id },
    { externalId: externalTicketIdSchema.parse(externalId) },
  );
  if (!read.ok) throw new Error(read.error.message);
  return read.value;
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  organizationId = fixture.a.organization.id;
  projectId = fixture.a.openProject.id;
  await seedWorld(test.db, { codeHost, secretStore }, organizationId, projectId);
  // The organizations' built-in profiles, as core's start seeds them.
  expect(await enqueueBuiltInProfileSeeds({ db: test.db, jobs })).toBeGreaterThanOrEqual(2);
  for (const org of [fixture.a.organization.id, fixture.b.organization.id]) {
    await seedProfilesHandler({
      db: test.db,
      jobs,
      notices: postgresChangeNotices,
      audit: postgresAuditLog,
      clock: systemClock,
    })(jobContext("profiles.seed-built-in", { organizationId: org }, silentLogger));
  }
  fake = await createFakeLinear();
  fake.createApp({
    name: "ostra",
    redirectUris: [`${PUBLIC_URL}/api/linear/callback`],
    webhookUrl: null,
  });
  const token = fake.mintToken("app");
  const access = await secretStore.put(
    { organizationId, purpose: "linear-access-token" },
    token.accessToken,
  );
  const jiraToken = await secretStore.put(
    { organizationId, purpose: "linear-access-token" },
    "jira-token",
  );
  if (!access.ok || !jiraToken.ok) throw new Error("refused");
  const connection = (ref: string) =>
    test.db.connection.create({
      data: {
        organizationId,
        kind: "linear",
        appId: `client-${randomUUID()}`,
        state: "active",
        webhookMode: "polling",
        credentialKind: "app_oauth",
        accessTokenSecretRef: ref,
        appUserId: fake.appUser()?.id ?? null,
      },
    });
  linearConnection = connectionIdSchema.parse((await connection(access.value)).id);
  jiraConnection = linearConnection;
  const statuses = await new LinearAdapter({
    apiUrl: fake.apiUrl,
    auth: { kind: "oauth", token: token.accessToken },
  }).listStatuses({ externalId: fake.team.id });
  if (!statuses.ok) throw new Error(statuses.error.message);
  readyStatusId =
    statuses.value.find((status) => status.category === "open" && status.name !== "Backlog")?.id ??
    statuses.value[0]?.id ??
    "";
  linearBoard = await seedBoard(test.db, {
    organizationId,
    projectId,
    connectionId: linearConnection,
    externalId: fake.team.id,
    key: "OST",
    mapping: { ...mappingFor(statuses.value, "ostra"), ready: readyStatusId },
  });
  site = createJiraSite();
  jiraAdapter = new JiraFakeAdapter({ site });
  const jiraStatuses = await jiraAdapter.listStatuses({ externalId: site.projects[0]?.id ?? "" });
  if (!jiraStatuses.ok) throw new Error(jiraStatuses.error.message);
  const jiraReady = jiraStatuses.value.find((status) => status.category === "open")?.id ?? "";
  jiraBoard = await seedBoard(test.db, {
    organizationId,
    projectId: fixture.a.restrictedProject.id,
    connectionId: jiraConnection,
    externalId: site.projects[0]?.id ?? "",
    key: "JRA",
    mapping: { ...mappingFor(jiraStatuses.value, "ostra"), ready: jiraReady },
  });
  // The Jira board's project is the open one in these cases.
  await test.db.board.update({ where: { id: jiraBoard }, data: { projectId } });
  server = createCoreServer({
    routes: [
      handleDraftEndpoint({
        db: test.db,
        tokens: createAccessTokens(randomBytes(32)),
        taskTokens,
        jobs,
        notices: postgresChangeNotices,
        audit: postgresAuditLog,
        clock: systemClock,
        logger: silentLogger,
      }),
    ],
    upgrade: () => undefined,
    logger: silentLogger,
  });
  endpointUrl = `http://127.0.0.1:${String(await server.listen(0, "127.0.0.1"))}`;
});

afterAll(async () => {
  await server.close();
  await fake.close();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("refine drafts (F-099)", () => {
  it("F-099: the built-in Refine profile exists in every organization on its default model, can't be archived, and is each project's refine default", async () => {
    for (const org of [fixture.a.organization.id, fixture.b.organization.id]) {
      const opencode = await test.db.agentProfile.findFirstOrThrow({
        where: { organizationId: org, builtIn: true },
      });
      const refine = await test.db.agentProfile.findFirstOrThrow({
        where: { organizationId: org, builtInKind: "refine" },
      });
      expect(refine).toMatchObject({
        name: "Refine",
        adapter: "opencode",
        builtIn: false,
        modelId: opencode.modelId,
        providerId: opencode.providerId,
        archivedAt: null,
      });
      expect(
        await test.db.agentProfile.count({ where: { organizationId: org, builtInKind: "review" } }),
      ).toBe(1);
      for (const project of await test.db.project.findMany({ where: { organizationId: org } })) {
        expect(project.defaultRefineProfileId).toBe(refine.id);
      }
    }
    const refine = await test.db.agentProfile.findFirstOrThrow({
      where: { organizationId, builtInKind: "refine" },
    });
    const archived = await archiveAgentProfile(
      { db: test.db, ...ports() },
      scopeOf(fixture.a.admin, "admin"),
      { profileId: agentProfileIdSchema.parse(refine.id) },
    );
    expect(archived).toMatchObject({ ok: false, error: "built-in" });
    // Seeding again makes nothing new.
    await seedProfilesHandler({
      db: test.db,
      jobs,
      notices: postgresChangeNotices,
      audit: postgresAuditLog,
      clock: systemClock,
    })(jobContext("profiles.seed-built-in", { organizationId }, silentLogger));
    expect(
      await test.db.agentProfile.count({ where: { organizationId, builtInKind: "refine" } }),
    ).toBe(1);
    // A refine task runs it, read-only, and writes nothing to its ticket when it starts.
    const { taskId } = await refineTask();
    const task = await test.db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task).toMatchObject({ kind: "refine", agentProfileId: refine.id });
    expect(await test.db.ticketWrite.count({ where: { taskId } })).toBe(0);
  });

  it("F-099: a code task's token posting a draft is refused; a refine task's drafts are stored with their typed fields, one version each", async () => {
    const code = await refineTask("linear", "code");
    expect(await submit(code.taskId, code.token, draft())).toEqual({
      status: 409,
      body: { code: "wrong-kind" },
    });
    expect(await test.db.refineDraft.count({ where: { taskId: code.taskId } })).toBe(0);
    const { taskId, token } = await refineTask();
    expect(await submit(taskId, token, { description: "no lists" })).toEqual({
      status: 400,
      body: { code: "invalid" },
    });
    const first = await submit(taskId, token, draft());
    const second = await submit(taskId, token, draft({ description: "Better.", subTickets: [] }));
    expect(first).toMatchObject({ status: 200, body: { version: 1 } });
    expect(second).toMatchObject({ status: 200, body: { version: 2 } });
    const rows = await test.db.refineDraft.findMany({
      where: { taskId },
      orderBy: { version: "asc" },
    });
    expect(
      rows.map((row) => [
        row.version,
        row.source,
        row.description,
        row.acceptanceCriteria,
        row.subTickets,
      ]),
    ).toEqual([
      [1, "agent", draft().description, draft().acceptanceCriteria, draft().subTickets],
      [2, "agent", "Better.", draft().acceptanceCriteria, []],
    ]);
    expect(await test.db.event.count({ where: { taskId, kind: "draft.submitted" } })).toBe(2);
    // Another task's token is refused.
    expect((await submit(code.taskId, token, draft())).status).toBe(403);
  });

  it("F-099: a turn that handed in a draft puts the task in front of its owner; a turn without one doesn't", async () => {
    const quiet = await refineTask();
    expect(await turnEnds(quiet.taskId, quiet.sessionId)).toMatchObject({
      ok: true,
      outcome: "unchanged",
    });
    const { taskId, sessionId, token } = await refineTask();
    await submit(taskId, token, draft());
    expect(await turnEnds(taskId, sessionId)).toMatchObject({ ok: true, outcome: "needs-you" });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      state: "needs_you",
      needsYouReason: "draft_ready",
    });
    const item = await test.db.needsYouItem.findFirstOrThrow({
      where: { taskId, reason: "draft_ready", state: "open" },
    });
    expect(item.audience).toBe("driver");
  });

  it("F-099: nothing reaches the tracker before a member acts; Update ticket writes the description, attaches the images and creates the sub-issues once under a replayed job", async () => {
    const { taskId, sessionId, token, ticket } = await refineTask();
    await submit(taskId, token, draft());
    await turnEnds(taskId, sessionId);
    const before = await linearTicket(ticket.externalId);
    const row = await test.db.refineDraft.findFirstOrThrow({ where: { taskId } });
    // Run before any member's action: it writes nothing.
    await runApply(row.id, 1);
    expect((await linearTicket(ticket.externalId)).ticket.description).toBe(
      before.ticket.description,
    );
    expect(await test.db.ticketWrite.count({ where: { taskId } })).toBe(0);

    // A member edits it and adds an image, then sends it.
    const edited = await editDraft({ db: test.db, ...ports() }, scopeOf(fixture.a.member), {
      taskId,
      baseVersion: 1,
      draft: draft({ description: "Edited by a member." }),
    });
    expect(edited).toMatchObject({ ok: true, version: 2 });
    expect(
      await editDraft({ db: test.db, ...ports() }, scopeOf(fixture.a.member), {
        taskId,
        baseVersion: 1,
        draft: draft(),
      }),
    ).toMatchObject({ ok: false, error: "conflict" });
    const blob = await test.db.blob.create({
      data: {
        organizationId,
        projectId,
        taskId,
        store: "postgres",
        key: `k-${randomUUID()}`,
        purpose: "draft-image",
        contentType: "image/png",
        size: 4,
        sha256: "00".repeat(32),
      },
    });
    blobBytes.set(blob.id, new Uint8Array([137, 80, 78, 71]));
    expect(
      await addDraftImage(
        { db: test.db, notices: postgresChangeNotices },
        scopeOf(fixture.a.member),
        { taskId, blobId: blob.id, name: "footer.png", contentType: "image/png", size: 4 },
        { max: 10 },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await applyDraft({ db: test.db, ...ports() }, scopeOf(fixture.a.member), {
        taskId,
        version: 1,
      }),
    ).toMatchObject({ ok: false, error: "stale-version" });
    expect(
      await applyDraft({ db: test.db, ...ports() }, scopeOf(fixture.a.member), {
        taskId,
        version: 2,
      }),
    ).toMatchObject({ ok: true });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      state: "done",
    });
    const v2 = await test.db.refineDraft.findFirstOrThrow({ where: { taskId, version: 2 } });
    await runApply(v2.id, 2);
    await runApply(v2.id, 2, 1);
    await runApply(v2.id, 2, 2);
    const after = await linearTicket(ticket.externalId);
    expect(after.ticket.description).toContain("Edited by a member.");
    expect(after.ticket.description).toContain("## Acceptance criteria");
    expect(after.children.map((child) => child.title).sort()).toEqual([
      "Lazy-load the footer's images",
      "Measure the footer",
    ]);
    expect(
      fake.issueView(externalTicketIdSchema.parse(ticket.externalId)).attachments.length,
    ).toBeGreaterThanOrEqual(1);
    const image = await test.db.refineDraftImage.findFirstOrThrow({ where: { draftId: v2.id } });
    expect(image.attachedAt).not.toBeNull();
    const applied = await test.db.event.findMany({ where: { taskId, kind: "draft.applied" } });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.payload).toMatchObject({
      ticketKey: ticketKeySchema.parse(after.ticket.key),
    });
  });

  it("F-099: Mark ready moves the ticket to the board's ready status through the ticket outbox", async () => {
    const { taskId, sessionId, token, ticket } = await refineTask();
    await submit(taskId, token, draft());
    await turnEnds(taskId, sessionId);
    expect(
      await markTicketReady({ db: test.db, ...ports() }, scopeOf(fixture.a.member), { taskId }),
    ).toMatchObject({ ok: true });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      state: "done",
    });
    const write = await test.db.ticketWrite.findFirstOrThrow({ where: { taskId, kind: "move" } });
    expect(write.payload).toEqual({ kind: "move", target: "ready" });
    await ticketSyncHandler({
      db: test.db,
      trackers: trackers(),
      clock: systemClock,
      publicUrl: PUBLIC_URL,
      logger: silentLogger,
    })(
      jobContext(
        "ticket.sync",
        { organizationId, ticketWriteId: ticketWriteIdSchema.parse(write.id) },
        silentLogger,
      ),
    );
    expect(fake.issueView(externalTicketIdSchema.parse(ticket.externalId)).stateId).toBe(
      readyStatusId,
    );
    // A board without a ready status says so.
    const other = await refineTask();
    await submit(other.taskId, other.token, draft());
    await turnEnds(other.taskId, other.sessionId);
    const mapping = (await test.db.board.findUniqueOrThrow({ where: { id: linearBoard } }))
      .statusMap;
    const parsed = parseBoardMapping(mapping);
    if (parsed === null) throw new Error("no mapping");
    const withoutReady = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "ready"));
    await test.db.board.update({ where: { id: linearBoard }, data: { statusMap: withoutReady } });
    try {
      expect(
        await markTicketReady({ db: test.db, ...ports() }, scopeOf(fixture.a.member), {
          taskId: other.taskId,
        }),
      ).toMatchObject({ ok: false, error: "no-ready-status" });
    } finally {
      await test.db.board.update({
        where: { id: linearBoard },
        data: { statusMap: mapping ?? {} },
      });
    }
  });

  it("F-099: on the Jira fake, the criteria go to their own field, the sub-tickets become sub-tasks, and Mark ready goes through its transitions", async () => {
    useJira = true;
    const { taskId, sessionId, token, ticket } = await refineTask("jira");
    await submit(taskId, token, draft());
    await turnEnds(taskId, sessionId);
    expect(
      await applyDraft({ db: test.db, ...ports() }, scopeOf(fixture.a.member), {
        taskId,
        version: 1,
      }),
    ).toMatchObject({ ok: true });
    const v1 = await test.db.refineDraft.findFirstOrThrow({ where: { taskId } });
    await runApply(v1.id, 1);
    const read = await jiraAdapter.getTicketContext(
      { externalId: site.projects[0]?.id ?? "" },
      { externalId: externalTicketIdSchema.parse(ticket.externalId) },
    );
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.ticket.acceptanceCriteria).toContain("The footer renders in under 1 s");
    expect(read.value.ticket.description).not.toContain("## Acceptance criteria");
    expect(read.value.children).toHaveLength(2);

    const ready = await refineTask("jira");
    await submit(ready.taskId, ready.token, draft());
    await turnEnds(ready.taskId, ready.sessionId);
    expect(
      await markTicketReady({ db: test.db, ...ports() }, scopeOf(fixture.a.member), {
        taskId: ready.taskId,
      }),
    ).toMatchObject({ ok: true });
    const write = await test.db.ticketWrite.findFirstOrThrow({
      where: { taskId: ready.taskId, kind: "move" },
    });
    await ticketSyncHandler({
      db: test.db,
      trackers: trackers(),
      clock: systemClock,
      publicUrl: PUBLIC_URL,
      logger: silentLogger,
    })(
      jobContext(
        "ticket.sync",
        { organizationId, ticketWriteId: ticketWriteIdSchema.parse(write.id) },
        silentLogger,
      ),
    );
    const board = await test.db.board.findUniqueOrThrow({ where: { id: jiraBoard } });
    const readyId = parseBoardMapping(board.statusMap)?.ready;
    expect(site.statusOf(externalTicketIdSchema.parse(ready.ticket.externalId))).toBe(readyId);
  });
});
