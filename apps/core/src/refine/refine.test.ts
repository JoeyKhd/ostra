import { randomBytes, randomUUID } from "node:crypto";

import { adapterError, silentLogger } from "@ostra/adapter-sdk";
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
  recordSessionEnd,
  recordWorkSaved,
  reopenTask,
  retryDraftApply,
  sendMemberMessageInTx,
  startTicketTask,
  systemClock,
} from "@ostra/domain";
import type { MemberScope, Ports } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  agentProfileIdSchema,
  boxIdSchema,
  clientMessageIdSchema,
  draftIdSchema,
  ticketIdSchema,
  connectionIdSchema,
  externalTicketIdSchema,
  leaseEpochSchema,
  memberIdSchema,
  runnerIdSchema,
  sessionIdSchema,
  taskEventSchema,
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
/** The Jira fake as a tracker without sub-issues, whose next `linkFailures` links fail. */
let flatTracker: JiraFakeAdapter | null = null;
let linkFailures = 0;
/** The next Linear attaches that go through, then die before the job writes `attachedAt`. */
let crashesAfterAttach = 0;
/** Fails Linear's second `createTicket` of a job while set: a write that stops partway. */
let failSecondSubTicket = false;
let subTicketsMade = 0;

const trackers = () =>
  createConnectionTrackers({
    db: test.db,
    secretStore,
    clock: systemClock,
    logger: silentLogger,
    build: (input): TrackerAdapter | null => {
      // One tracker connection per organization: the Jira cases switch what it is.
      if (useJira) return flatTracker ?? jiraAdapter;
      const linear = new LinearAdapter(
        { apiUrl: fake.apiUrl, auth: { kind: "oauth", token: input.token } },
        input.context,
      );
      const attach = linear.attachFile.bind(linear);
      const create = linear.createTicket.bind(linear);
      linear.createTicket = (...args) => {
        subTicketsMade += 1;
        if (failSecondSubTicket && subTicketsMade === 2) {
          return Promise.resolve(adapterError("unavailable", "the tracker is down"));
        }
        return create(...args);
      };
      linear.attachFile = async (...args) => {
        const attached = await attach(...args);
        if (crashesAfterAttach > 0) {
          crashesAfterAttach -= 1;
          throw new Error("the process died after the tracker's attach");
        }
        return attached;
      };
      return linear;
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
        sessionSeq: counter.eventSeq,
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
  it("F-099/c1,c3,c8: the built-in Refine profile exists in every organization on its default model, can't be archived, and is each project's refine default", async () => {
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

  it("F-099/c1,c4: a code task's token posting a draft is refused; a refine task's drafts are stored with their typed fields, one version each", async () => {
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

  it("F-151/c7: a submitted draft's draft.submitted carries its counts, never its text", async () => {
    const { taskId, token } = await refineTask();
    expect(await submit(taskId, token, draft())).toMatchObject({ status: 200, body: { version: 1 } });
    expect(
      await submit(taskId, token, draft({ acceptanceCriteria: ["One", "Two", "Three", "Four"], subTickets: [] })),
    ).toMatchObject({ status: 200, body: { version: 2 } });
    const rows = await test.db.event.findMany({
      where: { taskId, kind: "draft.submitted" },
      orderBy: { seq: "asc" },
    });
    const drafts = await test.db.refineDraft.findMany({ where: { taskId }, orderBy: { version: "asc" } });
    expect(rows.map((row) => taskEventSchema.parse(row.payload))).toEqual([
      { kind: "draft.submitted", draftId: drafts[0]?.id, version: 1, acceptanceCriteria: 2, subTickets: 2 },
      { kind: "draft.submitted", draftId: drafts[1]?.id, version: 2, acceptanceCriteria: 4, subTickets: 0 },
    ]);
    expect(JSON.stringify(rows.map((row) => row.payload))).not.toContain("footer");
  });

  it("F-036/c1, F-099/c5: a turn that handed in a draft puts the task in front of its owner; a turn without one doesn't", async () => {
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

  it("F-099/c6,c7,c8: nothing reaches the tracker before a member acts; Update ticket writes the description, attaches the images and creates the sub-issues once under a replayed job", async () => {
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

  it("F-099/c6,c7: a retry after a crash between the tracker's attach and attachedAt attaches the image once", async () => {
    const { taskId, sessionId, token, ticket } = await refineTask();
    await submit(taskId, token, draft());
    await turnEnds(taskId, sessionId);
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
        { taskId, blobId: blob.id, name: "crash-once.png", contentType: "image/png", size: 4 },
        { max: 10 },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await applyDraft({ db: test.db, ...ports() }, scopeOf(fixture.a.member), {
        taskId,
        version: 1,
      }),
    ).toMatchObject({ ok: true });
    const v1 = await test.db.refineDraft.findFirstOrThrow({ where: { taskId, version: 1 } });
    const attachedHere = () =>
      fake
        .issueView(externalTicketIdSchema.parse(ticket.externalId))
        .attachments.filter((attachment) => attachment.url.endsWith("/crash-once.png"));
    crashesAfterAttach = 1;
    try {
      await expect(runApply(v1.id, 1)).rejects.toThrow("the process died");
    } finally {
      crashesAfterAttach = 0;
    }
    const image = await test.db.refineDraftImage.findFirstOrThrow({ where: { draftId: v1.id } });
    expect(image.attachedAt).toBeNull();
    expect(attachedHere()).toHaveLength(1);
    await runApply(v1.id, 1, 1);
    expect(attachedHere()).toHaveLength(1);
    expect(
      (await test.db.refineDraftImage.findUniqueOrThrow({ where: { id: image.id } })).attachedAt,
    ).not.toBeNull();
    expect(await test.db.event.count({ where: { taskId, kind: "draft.applied" } })).toBe(1);
  });

  it("F-099/c6: a write that stops partway records the part it stopped at, and Retry sync finishes it without making a sub-issue twice", async () => {
    const { taskId, sessionId, token, ticket } = await refineTask();
    await submit(taskId, token, draft());
    await turnEnds(taskId, sessionId);
    // Applied on the fake Linear's clock, as a real tracker's: a retry looks back from the apply.
    expect(
      await applyDraft({ db: test.db, ...ports(), clock: fake.clock }, scopeOf(fixture.a.member), {
        taskId,
        version: 1,
      }),
    ).toMatchObject({ ok: true });
    const v1 = await test.db.refineDraft.findFirstOrThrow({ where: { taskId, version: 1 } });
    // Nothing failed yet: there's nothing to retry.
    expect(
      await retryDraftApply({ db: test.db, ...ports() }, scopeOf(fixture.a.member), { taskId }),
    ).toMatchObject({ ok: false, error: "nothing-failed" });
    subTicketsMade = 0;
    failSecondSubTicket = true;
    try {
      await expect(runApply(v1.id, 1)).rejects.toThrow("creating a sub-ticket");
    } finally {
      failSecondSubTicket = false;
    }
    expect(await test.db.refineDraft.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({
      applyFailedPart: "sub_tickets",
    });
    expect(await test.db.event.count({ where: { taskId, kind: "draft.applied" } })).toBe(0);

    // A member's Retry sync: a new job, not a queue retry, and it still finds the sub-issue made.
    expect(
      await retryDraftApply({ db: test.db, ...ports() }, scopeOf(fixture.a.member), { taskId }),
    ).toMatchObject({ ok: true, version: 1 });
    await runApply(v1.id, 1, 0);
    const after = await linearTicket(ticket.externalId);
    expect(after.children.map((child) => child.title).sort()).toEqual([
      "Lazy-load the footer's images",
      "Measure the footer",
    ]);
    expect(await test.db.refineDraft.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({
      applyFailedAt: null,
      applyFailedPart: null,
    });
    expect(await test.db.event.count({ where: { taskId, kind: "draft.applied" } })).toBe(1);
  });

  it("F-099/c6: Mark ready moves the ticket to the board's ready status through the ticket outbox", async () => {
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
    const withoutReady = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key !== "ready"),
    );
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

  it("F-099/c6: on a tracker without sub-issues, each sub-ticket is linked from the ticket, also when a retry finds one an earlier try made but couldn't link", async () => {
    useJira = true;
    flatTracker = new Proxy(jiraAdapter, {
      get: (target, key, receiver): unknown => {
        if (key === "capabilities") return { ...target.capabilities, subIssues: false };
        if (key === "linkTask") {
          return (...args: Parameters<JiraFakeAdapter["linkTask"]>) => {
            if (linkFailures > 0) {
              linkFailures -= 1;
              return Promise.resolve(adapterError("unavailable", "the tracker is down"));
            }
            return target.linkTask(...args);
          };
        }
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
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
      // The fake site's clock at the real one, as a real tracker's is: the retry looks back from now.
      site.clock.set(Date.now());
      const measured = () =>
        [...site.issues.values()].filter((issue) => issue.summary === "Measure the footer").length;
      const before = measured();
      // The first sub-ticket is made, and its link fails: the job fails, to run again.
      linkFailures = 1;
      await expect(runApply(v1.id, 1)).rejects.toThrow("linking a sub-ticket");
      await runApply(v1.id, 1, 1);
      const read = await jiraAdapter.getTicketContext(
        { externalId: site.projects[0]?.id ?? "" },
        { externalId: externalTicketIdSchema.parse(ticket.externalId) },
      );
      if (!read.ok) throw new Error(read.error.message);
      // No sub-tasks; two sub-tickets, each made once and linked once from the ticket.
      expect(read.value.children).toHaveLength(0);
      const links = read.value.attachments.filter((link) => link.url.includes("/browse/"));
      expect(links).toHaveLength(2);
      expect(new Set(links.map((link) => link.url)).size).toBe(2);
      expect(measured() - before).toBe(1);
    } finally {
      flatTracker = null;
      linkFailures = 0;
    }
  });

  it("F-099/c6: on the Jira fake, the criteria go to their own field, the sub-tickets become sub-tasks, and Mark ready goes through its transitions", async () => {
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

// The stuck refine (2026-11-23, found with the stuck review, b8beac70): a refine task left
// `running` only by a draft handed in during the turn, so a turn that handed in none kept it
// running for good, a member's message to a refine task that's done among them: its session idled
// out and its lease ended with the task still running. Each turn's save and its session's end now
// settle it (hand-in-rests.ts): a draft no member took yet is in front of its owner, a draft
// already taken rests it as done, and a session that ends before the first draft needs its driver.

/** The runner's `session.ended` when the idle timer stops the box, stored as ingest stores it, then core's `task.session-ended` job. */
const sessionEnds = async (taskId: TaskId, sessionId: string) =>
  test.db.$transaction(async (tx) => {
    const counter = await tx.task.update({ where: { id: taskId }, data: { eventSeq: { increment: 1 } }, select: { eventSeq: true } });
    const event: TaskEventOf<"session.ended"> = { kind: "session.ended", outcome: "without-changes", repos: [] };
    await tx.event.create({
      data: { organizationId, projectId, taskId, seq: counter.eventSeq, sessionId, sessionSeq: counter.eventSeq, leaseEpoch: 1, kind: "session.ended", payload: event, occurredAt: new Date() },
    });
    return recordSessionEnd(
      { tx, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock },
      { organizationId, taskId, sessionId: sessionIdSchema.parse(sessionId), eventSeq: counter.eventSeq },
    );
  });

/** A member's message to the task, as the composer sends it. */
const message = (taskId: TaskId, text: string) =>
  test.db.$transaction((tx) =>
    sendMemberMessageInTx({ ...ports() }, tx, scopeOf(fixture.a.member), {
      taskId,
      clientMessageId: clientMessageIdSchema.parse(`refine-message-${randomUUID()}`),
      text,
      intent: "message",
      sender: "driver",
    }),
  );

/** A reopened session's dispatch, taken as `refineTask`'s was: a docker box on the task's next lease, the session running. */
const takenOnABox = async (taskId: TaskId, sessionId: string): Promise<void> => {
  const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { leaseEpoch: true } });
  const runner = await seedOnlineRunner(test.db, organizationId, { kind: "personal", memberId: fixture.a.member.id });
  const box = await test.db.box.create({ data: { organizationId, projectId, taskId, runnerId: runner.runnerId, executor: "docker", state: "ready" } });
  await test.db.lease.create({ data: { organizationId, projectId, taskId, epoch: leaseEpoch + 1, runnerId: runner.runnerId, boxId: box.id, state: "active" } });
  await test.db.task.update({ where: { id: taskId }, data: { leaseEpoch: leaseEpoch + 1, state: "running" } });
  await test.db.session.update({ where: { id: sessionId }, data: { boxId: box.id, state: "running" } });
};

const stateOf = async (taskId: TaskId): Promise<string> => {
  const row = await test.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { state: true, needsYouReason: true } });
  return row.needsYouReason === null ? row.state : `${row.state}/${row.needsYouReason}`;
};

const openItemsOf = async (taskId: TaskId) =>
  (await test.db.needsYouItem.findMany({ where: { taskId, state: "open" }, select: { reason: true, audience: true } })).map((item) => `${item.reason}/${item.audience}`);

describe("the stuck refine: a refine task never stays running with nothing to hand in", () => {
  it("F-099/c6: a member's message to a refine task that's done is answered in a turn of its own, then the task rests as done", async () => {
    const { taskId, sessionId, token } = await refineTask();
    await submit(taskId, token, draft());
    await turnEnds(taskId, sessionId);
    expect(await applyDraft({ db: test.db, ...ports() }, scopeOf(fixture.a.member), { taskId, version: 1 })).toMatchObject({ ok: true });
    expect(await stateOf(taskId)).toBe("done");

    // The member asks the refine agent something: the task reopens on a session of its own.
    const sent = await message(taskId, "Why two sub-tickets and not one?");
    if (!sent.ok) throw new Error(sent.message);
    expect(sent.delivery).toBe("reopen");
    await takenOnABox(taskId, sent.sessionId);
    // Its turn answers, and hands in no new draft: the draft already went to the ticket.
    expect(await turnEnds(taskId, sent.sessionId)).toMatchObject({ ok: true, outcome: "unchanged" });
    expect(await stateOf(taskId)).toBe("done");
    expect(await openItemsOf(taskId)).toEqual([]);
    expect(await test.db.refineDraft.count({ where: { taskId } })).toBe(1);

    // The idle timer ends the session: the task stays done, nothing waits on it, its lease ends.
    expect(await sessionEnds(taskId, sent.sessionId)).toMatchObject({ ok: true });
    expect(await stateOf(taskId)).toBe("done");
    expect(await openItemsOf(taskId)).toEqual([]);
    expect(await test.db.lease.count({ where: { taskId, state: "active" } })).toBe(0);
  });

  it("F-099/c5: a member's message to a draft no member took yet, answered without a new draft, puts the draft back in front of its owner", async () => {
    const { taskId, sessionId, token } = await refineTask();
    await submit(taskId, token, draft());
    await turnEnds(taskId, sessionId);
    expect(await stateOf(taskId)).toBe("needs_you/draft_ready");

    // The member's message reaches the warm box: the task runs, and the draft's item is answered.
    const sent = await message(taskId, "Is the second criterion measurable?");
    if (!sent.ok) throw new Error(sent.message);
    expect(sent.delivery).toBe("steer");
    expect(await stateOf(taskId)).toBe("running");
    expect(await openItemsOf(taskId)).toEqual([]);
    // Its turn answers in words and hands in no new draft: version 1 still waits for a member.
    expect(await turnEnds(taskId, sessionId)).toMatchObject({ ok: true, outcome: "needs-you" });
    expect(await stateOf(taskId)).toBe("needs_you/draft_ready");
    expect(await openItemsOf(taskId)).toEqual(["draft_ready/driver"]);
    // And a member still takes it from there.
    expect(await applyDraft({ db: test.db, ...ports() }, scopeOf(fixture.a.member), { taskId, version: 1 })).toMatchObject({ ok: true });
    expect(await stateOf(taskId)).toBe("done");
  });

  it("F-099/c4: a refine task whose session ends before it hands in a draft needs its driver, and one click carries it on", async () => {
    const { taskId, sessionId } = await refineTask();
    // A turn without a draft: the box stays warm, so a message can still reach the agent.
    expect(await turnEnds(taskId, sessionId)).toMatchObject({ ok: true, outcome: "unchanged" });
    expect(await stateOf(taskId)).toBe("running");
    // The idle timer ends the session with no draft handed in.
    expect(await sessionEnds(taskId, sessionId)).toMatchObject({ ok: true });
    expect(await stateOf(taskId)).toBe("needs_you/stalled");
    expect(await openItemsOf(taskId)).toEqual(["stalled/driver"]);
    expect(await test.db.lease.count({ where: { taskId, state: "active" } })).toBe(0);

    // One click: the task carries on in a fresh session, with no words of the member's.
    const reopened = await test.db.$transaction((tx) =>
      reopenTask(
        { tx, scope: scopeOf(fixture.a.member), jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock },
        { taskId, clientMessageId: clientMessageIdSchema.parse(`carry-on-${randomUUID()}`) },
      ),
    );
    expect(reopened).toMatchObject({ ok: true });
    expect(await stateOf(taskId)).toBe("queued");
    expect(await openItemsOf(taskId)).toEqual([]);
  });
});
